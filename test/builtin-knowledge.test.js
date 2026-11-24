import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { KNOWLEDGE_DOMAINS, PREDEFINED_EXECUTIVES, inferKnowledgeDomains, loadBuiltinKnowledge,
  validateKnowledgeDomains } from '../lib/builtin-knowledge.js';
import { createStore } from '../lib/store.js';
import { createApp } from '../server.js';

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'builtin-knowledge-'));
  let store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store: () => store, reopen: () => { store.close(); store = createStore(directory); return store; } };
}

test('shipped built-in knowledge covers every domain with titled, sectioned documents', () => {
  const knowledge = loadBuiltinKnowledge();
  for (const domain of knowledge.catalog) assert.ok(domain.documents.length >= 3, domain.id);
  for (const document of knowledge.documents) {
    assert.match(document.id, /^builtin:[a-z]+\/[a-z0-9-]+$/);
    assert.ok(document.chunks.length >= 3, document.id);
    assert.ok(document.chunks.every(chunk => chunk.startsWith(`${document.title}\n## `)), document.id);
  }
  assert.deepEqual(inferKnowledgeDomains('Chief Financial Officer'), ['finance']);
  assert.deepEqual(inferKnowledgeDomains('VP Engineering'), ['product']);
  assert.deepEqual(inferKnowledgeDomains('Chief Executive Officer'), ['leadership', 'strategy', 'board']);
  assert.deepEqual(inferKnowledgeDomains('Astronaut'), ['leadership']);
  assert.deepEqual(validateKnowledgeDomains(['sales', 'finance']), ['finance', 'sales']);
  assert.throws(() => validateKnowledgeDomains(['astrology']), /Knowledge domains/);
  assert.equal(KNOWLEDGE_DOMAINS.length, knowledge.catalog.length);
});

test('predefined specialist executives are seeded once with domains and a role-focused soul', async t => {
  const { directory, store, reopen } = await temporaryStore(t);
  const executives = store().state().executives;
  for (const item of PREDEFINED_EXECUTIVES) {
    const seeded = executives.find(executive => executive.id === item.id);
    assert.equal(seeded.role, item.role);
    assert.equal(seeded.owner_id, item.id);
    assert.deepEqual(seeded.knowledgeDomains, validateKnowledgeDomains(item.domains));
    assert.ok(store().state().profiles.some(profile => profile.id === item.id));
  }
  assert.match(await readFile(join(directory, 'executives', 'chief-financial-officer', 'soul.md'), 'utf8'),
    /## Role focus\nQuantify where possible/);
  assert.deepEqual(executives.find(item => item.id === 'alex-executive').knowledgeDomains, ['leadership', 'strategy', 'board']);
  store().deleteExecutive('chief-financial-officer');
  assert.ok(!reopen().state().executives.some(item => item.id === 'chief-financial-officer'));
});

test('retrieval adds relevant built-in reference for the executive domains below comparable uploads', async t => {
  const { store } = await temporaryStore(t);
  const cfo = { executiveId: 'chief-financial-officer', profileId: 'alex', mode: 'enriched' };
  const question = 'How should we calculate customer acquisition cost and payback period?';
  const sources = store().retrieve(cfo, question);
  assert.ok(sources.length > 0 && sources.length <= 3);
  assert.ok(sources.every(source => source.builtin && source.scope === 'builtin' && source.documentId.startsWith('builtin:finance/')));
  assert.ok(sources.some(source => source.documentId === 'builtin:finance/unit-economics'));
  assert.equal(sources[0].date, undefined);
  assert.deepEqual(store().retrieve(cfo, 'What is 17 times 23?'), []);
  assert.deepEqual(store().retrieve({ ...cfo, executiveId: 'general-counsel' }, question), []);

  store().insertDocument({ ...cfo, scope: 'enriched', title: 'Our CAC policy',
    content: 'We calculate customer acquisition cost and payback period monthly, using fully loaded sales and marketing spend.' });
  const mixed = store().retrieve(cfo, question);
  assert.equal(mixed[0].title, 'Our CAC policy');
  assert.ok(mixed.filter(source => source.builtin).length <= 3);

  store().updateExecutive('chief-financial-officer', { knowledgeDomains: [] });
  assert.ok(store().retrieve(cfo, question).every(source => !source.builtin));
  assert.match(store().document('builtin:finance/unit-economics').content, /^# Unit economics/);
  assert.throws(() => store().document('builtin:finance/missing'), /not found/);
  assert.throws(() => store().deleteDocument('builtin:finance/unit-economics'), /read-only/);
});

test('chat labels built-in citations and executives accept validated domain edits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'builtin-chat-'));
  let prompt;
  const app = createApp({ directory, apiKey: 'test-key', chatMemory: false, generalizer: async () => '',
    fetcher: async (_url, options) => {
      prompt = JSON.parse(options.body).messages.slice(0, -1).map(message => message.content).join('\n');
      return Response.json({ choices: [{ message: { content: 'Use fully loaded CAC [S1].' } }] });
    } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const state = (await call('state')).body;
  assert.equal(state.builtinKnowledge.domains.find(domain => domain.id === 'finance').documents.length, 3);
  const answer = await call('chat', 'POST', { executiveId: 'chief-financial-officer', profileId: 'alex', mode: 'enriched',
    question: 'How should we calculate customer acquisition cost and payback period?' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.engine, 'openai');
  assert.match(prompt, /\[S1\] Built-in: .* \| BUILT-IN REFERENCE: curated general management knowledge/);
  assert.match(prompt, /never present them as this executive's opinions/);
  const document = await call(`documents/${encodeURIComponent(answer.body.sources[0].documentId)}`);
  assert.equal(document.body.scope, 'builtin');
  assert.equal((await call('executives/chief-financial-officer', 'PATCH', { knowledgeDomains: ['astrology'] })).status, 400);
  const edited = await call('executives/chief-financial-officer', 'PATCH', { knowledgeDomains: ['sales', 'finance'] });
  assert.deepEqual(edited.body.knowledgeDomains, ['finance', 'sales']);
  const created = await call('executives', 'POST', { name: 'Taylor', role: 'Head of People' });
  assert.deepEqual(created.body.knowledgeDomains, ['leadership', 'people']);
  assert.equal((await call(`documents/${encodeURIComponent('builtin:finance/unit-economics')}`, 'DELETE')).status, 400);
});
