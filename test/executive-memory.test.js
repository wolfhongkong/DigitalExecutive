import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMemory, syncExecutiveMemory, validateMemoryEntry } from '../lib/executive-memory.js';
import { createStore } from '../lib/store.js';
import { createApp } from '../server.js';
import { once } from 'node:events';

const context = { executiveId: 'alex-executive', profileId: 'alex', mode: 'public' };

const entry = overrides => ({ id: 'memory-one', content: 'Prioritize reliability.', category: 'priority', status: 'confirmed',
  date: '2026-11-06', sourceId: 'source-one', sourceTitle: 'Reviewed strategy', scope: 'public', profileId: 'alex', ...overrides });

test('memory indexes link to monthly records and distinguish superseded entries and interpretations', () => {
  const rendered = renderMemory([entry(), entry({ id: 'memory-two', date: '2026-10-01', content: 'Older priority.', supersededBy: 'memory-one' }),
    entry({ id: 'memory-three', status: 'inference', content: 'Possible preference.' })]);
  assert.match(rendered.index, /2026-11.md#memory-memory-one/);
  assert.doesNotMatch(rendered.index, /Older priority/);
  assert.match(rendered.index, /inference/);
  assert.match(rendered.files.find(file => file.month === '2026-10').content, /superseded/);
  assert.match(rendered.files[0].content, /\/api\/documents\/source-one/);
});

test('executive memory files separate private namespaces and remove deleted monthly projections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-memory-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  syncExecutiveMemory(directory, 'alex-executive', [entry(), entry({ id: 'private-one', scope: 'enriched', content: 'Private cobalt.' }),
    entry({ id: 'twin-one', scope: 'twin', content: 'Owner emerald.' })]);
  const root = join(directory, 'executives', 'alex-executive');
  const index = await readFile(join(root, 'memory.md'), 'utf8');
  assert.match(index, /memory\/public\/2026-11.md/);
  assert.doesNotMatch(index, /cobalt|emerald|enriched|twin/);
  assert.match(await readFile(join(root, 'memory', 'enriched', 'alex', 'memory.md'), 'utf8'), /Private cobalt/);
  assert.match(await readFile(join(root, 'memory', 'twin', 'alex', '2026-11.md'), 'utf8'), /Owner emerald/);
  syncExecutiveMemory(directory, 'alex-executive', []);
  await assert.rejects(stat(join(root, 'memory', 'public', '2026-11.md')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, 'memory', 'enriched', 'alex', 'memory.md')), { code: 'ENOENT' });
  assert.throws(() => syncExecutiveMemory(directory, '../escape', []), /Invalid memory namespace/);
});

test('memory entry validation requires real dates, bounded content and explicit review status', () => {
  assert.equal(validateMemoryEntry(entry()).date, '2026-11-06');
  for (const changes of [{ date: '2026-02-30' }, { date: '../escape' }, { content: '' }, { content: 'x'.repeat(2001) },
    { status: 'verified-by-ai' }, { category: 'unknown' }, { content: 'binary\0data' }]) {
    assert.throws(() => validateMemoryEntry(entry(changes)));
  }
});

test('curated memory persists, inherits source scope, and disappears from files and retrieval when sources are deleted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-memory-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = createStore(directory);
  try {
    const publicSource = store.insertDocument({ ...context, scope: 'public', title: 'Public strategy', content: 'Reviewed source.' });
    const privateSource = store.insertDocument({ ...context, scope: 'enriched', title: 'Private priorities', content: 'Reviewed source.' });
    const twinSource = store.insertDocument({ ...context, profileId: 'jordan', scope: 'twin', title: 'Owner strategy', content: 'Reviewed source.' });
    const publicMemory = store.addMemory({ ...context, ...entry(), sourceId: publicSource.id, content: 'Amber enduring priority.' });
    store.addMemory({ ...context, mode: 'enriched', ...entry(), sourceId: privateSource.id, content: 'Cobalt private priority.' });
    assert.throws(() => store.addMemory({ ...context, mode: 'twin', ...entry(), profileId: 'jordan', sourceId: twinSource.id }), /visible/);
    store.addMemory({ ...context, mode: 'twin', ...entry(), sourceId: twinSource.id, content: 'Emerald owner priority.' });
    for (const [mode, profileId, expected] of [['public', 'jordan', ['Amber']], ['enriched', 'alex', ['Amber', 'Cobalt', 'Emerald']],
      ['enriched', 'jordan', ['Amber']], ['twin', 'jordan', ['Amber']], ['twin', 'alex', ['Amber', 'Cobalt', 'Emerald']]]) {
      const view = store.memory({ ...context, mode, profileId });
      assert.deepEqual(view.entries.map(item => item.content.split(' ')[0]).sort(), expected.sort());
    }
    assert.throws(() => store.addMemory({ ...context, ...entry(), sourceId: privateSource.id }), /visible/);
    assert.throws(() => store.deleteMemory({ ...context, profileId: 'jordan', mode: 'enriched' },
      store.memory({ ...context, mode: 'enriched' }).entries.find(item => item.scope === 'enriched').id), /not found/);
    assert.ok(store.retrieve(context, 'Amber').some(source => source.memoryId === publicMemory.id));
    store.close();
    store = createStore(directory);
    assert.equal(store.memory(context).entries[0].id, publicMemory.id);
    store.deleteDocument(publicSource.id);
    assert.deepEqual(store.memory(context).entries, []);
    assert.deepEqual(store.retrieve(context, 'Amber'), []);
    const root = join(directory, 'executives', context.executiveId);
    assert.doesNotMatch(await readFile(join(root, 'memory.md'), 'utf8'), /Amber|Cobalt|Emerald/);
    await assert.rejects(stat(join(root, 'memory', 'public', '2026-11.md')), { code: 'ENOENT' });
  } finally { store.close(); }
});

test('superseded memories stay in monthly history but cannot be retrieved or resurrected when a replacement is deleted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-memory-supersession-'));
  const store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const source = store.insertDocument({ ...context, scope: 'public', title: 'Decisions', content: 'Reviewed source.' });
  const first = store.addMemory({ ...context, ...entry(), sourceId: source.id, content: 'Zephyr old priority.' });
  const replacement = store.addMemory({ ...context, ...entry(), sourceId: source.id, content: 'Saffron current priority.', supersedes: first.id });
  assert.deepEqual(store.retrieve(context, 'Zephyr'), []);
  assert.match(store.memory(context).months[0].content, /Zephyr/);
  assert.doesNotMatch(store.memory(context).index, /Zephyr/);
  store.deleteMemory(context, replacement.id);
  assert.deepEqual(store.retrieve(context, 'Zephyr'), []);
  const staged = store.insertRecording({ ...context, scope: 'public', title: 'Unreviewed recording', content: 'Whole meeting.' }, []);
  assert.throws(() => store.addMemory({ ...context, ...entry(), sourceId: staged.id }), /published, speaker-assigned/);
});

test('memory APIs require active context, validate source-backed entries, and ground chat without private leakage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-memory-api-'));
  const payloads = [];
  const app = createApp({ directory, apiKey: 'fixture-key', generalizer: async () => '', fetcher: async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: 'Source-linked answer [S1].' } }] });
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/api/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const route = `executives/${context.executiveId}/memory`;
  assert.equal((await request(route)).status, 400);
  const source = (await request('documents', 'POST', { ...context, scope: 'enriched', title: 'Personal source', content: 'Reviewed evidence.' })).body;
  const result = await request(route, 'POST', { ...context, mode: 'enriched', ...entry(), sourceId: source.id,
    status: 'inference', content: 'Cobalt may be a preferred initiative.' });
  assert.equal(result.status, 200);
  assert.equal((await request(`${route}?${new URLSearchParams({ ...context, mode: 'enriched' })}`)).body.entries[0].id, result.body.id);
  assert.deepEqual((await request(`${route}?${new URLSearchParams(context)}`)).body.entries, []);
  assert.equal((await request(route, 'POST', { ...context, ...entry(), sourceId: source.id })).status, 404);
  const answer = await request('chat', 'POST', { ...context, mode: 'enriched', question: 'Cobalt initiative?' });
  assert.ok(answer.body.sources.some(item => item.memoryStatus === 'inference'));
  assert.match(payloads.at(-1).messages.at(-2).content, /Curated memory \| 2026-11-06/);
  assert.match(payloads.at(-1).messages[0].content, /interpretation, not a confirmed fact/);
  await request('chat', 'POST', { ...context, profileId: 'jordan', mode: 'enriched', question: 'Cobalt initiative?' });
  assert.doesNotMatch(payloads.at(-1).messages.at(-2).content, /Cobalt may be/);
  assert.equal((await request(`${route}/${result.body.id}?${new URLSearchParams(context)}`, 'DELETE')).status, 404);
  assert.equal((await request(`${route}/${result.body.id}?${new URLSearchParams({ ...context, mode: 'enriched' })}`, 'DELETE')).status, 200);
  assert.equal((await fetch(`${base}/data/executives/alex-executive/memory.md`)).status, 404);
});