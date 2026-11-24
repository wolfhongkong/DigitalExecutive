import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { dreamDocuments, dreamedSoul } from '../lib/dreaming.js';
import { createStore } from '../lib/store.js';
import { createApp } from '../server.js';

const context = { executiveId: 'alex-executive', profileId: 'alex', mode: 'public' };
const finding = overrides => ({ kind: 'memory', topic: 'strategy', content: 'Prioritize reliability.',
  category: 'priority', status: 'inference', date: '2026-11-01', dateBasis: 'event',
  evidence: 'Prioritize reliability.', ...overrides });
const completion = findings => Response.json({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ findings }) } }] });
async function waitForDreamIdle(base) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await fetch(`${base}/dreaming`).then(response => response.json());
    if (!result.jobs.length) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Dreaming did not finish in time.');
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-'));
  const store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory, root: join(directory, 'executives', context.executiveId) };
}

test('Dreaming batches all source text, uses event dates and labels upload-date fallback', async () => {
  const requests = [];
  const progress = [];
  const documents = [{ id: 'one', title: 'Strategy', created_at: '2026-11-09T00:00:00Z',
    content: `${'a'.repeat(16_000)}Prioritize reliability.` }];
  const findings = await dreamDocuments({ executive: { name: 'Alex', role: 'CEO' }, documents,
    traitTopics: ['communication style'],
    onProgress: value => progress.push(value),
    apiKey: 'fixture', model: 'fixture', provider: { chatUrl: 'https://example.invalid/chat' },
    fetcher: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return completion(requests.length === 1 ? [] : [finding({ date: null })]);
    } });
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[0].body.messages[1].content).excerpt.length, 16_000);
  assert.equal(findings[0].date, '2026-11-09');
  assert.equal(findings[0].dateBasis, 'upload');
  assert.equal(findings[0].sourceId, 'one');
  assert.equal(requests[0].redirect, 'error');
  assert.match(requests[0].body.messages[0].content, /Later event dates/);
  assert.match(requests[0].body.messages[0].content, /trait:communication style/);
  assert.match(requests[0].body.messages[0].content, /one shared soul used in all persona modes/);
  assert.match(requests[0].body.messages[0].content, /Keep those concrete details in memory findings/);
  assert.deepEqual(progress, [
    { phase: 'organizing', completedBatches: 0, totalBatches: 2 },
    { phase: 'organizing', completedBatches: 1, totalBatches: 2 },
    { phase: 'organizing', completedBatches: 2, totalBatches: 2 },
  ]);
});

test('Dreaming runs batches concurrently up to the limit, merges in source order and aborts on failure', async () => {
  const documents = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ id, title: id,
    created_at: `2026-11-0${index + 1}T00:00:00Z`, content: `Point ${id}.` }));
  const input = { executive: { name: 'Alex', role: 'CEO' }, apiKey: 'fixture', model: 'fixture', documents, concurrency: 2 };
  let active = 0;
  let peak = 0;
  const findings = await dreamDocuments({ ...input, fetcher: async (_url, options) => {
    const { excerpt } = JSON.parse(JSON.parse(options.body).messages[1].content);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, excerpt === 'Point a.' ? 30 : 5));
    active--;
    return completion([finding({ topic: excerpt, content: excerpt, evidence: excerpt })]);
  } });
  assert.equal(peak, 2);
  assert.deepEqual(findings.map(item => item.sourceId), ['a', 'b', 'c', 'd', 'e']);

  const signals = [];
  await assert.rejects(dreamDocuments({ ...input, fetcher: async (_url, options) => {
    signals.push(options.signal);
    if (signals.length === 1) return new Response('', { status: 500 });
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  } }), /HTTP 500/);
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
});

test('Dreaming button renders batch percentage and remaining time beside executive memory', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function dreamingProgress(');
  const end = source.indexOf('async function pollDreaming()', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const sandbox = {
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { removeAttribute(name) { delete this[name]; } });
      return elements.get(selector);
    },
    state: { executives: [{ id: 'alex-executive', name: 'Alex Morgan' }] },
    busy: false, executiveId: 'alex-executive', dreamingErrors: [],
    dreamingJobs: [{ executiveId: 'alex-executive', phase: 'organizing', completedBatches: 1, totalBatches: 3 }],
  };
  runInNewContext(source.slice(start, end), sandbox);
  sandbox.renderDreamingIndicator();
  const indicator = elements.get('#dreaming-indicator');
  const label = elements.get('#dreaming-indicator-text');
  const bar = elements.get('#dreaming-progress');
  assert.equal(indicator.hidden, false);
  assert.equal(elements.get('#dreaming-label').textContent, 'Currently Dreaming');
  assert.match(label.textContent, /Alex Morgan: 1\/3 text batches processed/);
  assert.match(label.textContent, /Estimating time/);
  assert.equal(bar.value, 33);
  assert.equal(elements.get('#dreaming-percent').textContent, '33%');
  sandbox.dreamingJobs[0].phase = 'queued';
  sandbox.renderDreamingIndicator();
  assert.match(label.textContent, /pending queued work/);
  assert.equal(bar.value, undefined);
  sandbox.dreamingJobs[0].phase = 'saving';
  sandbox.dreamingJobs[0].completedBatches = 3;
  sandbox.renderDreamingIndicator();
  assert.match(label.textContent, /saving memory and soul/);
  assert.equal(bar.value, 99);
  sandbox.dreamingJobs = [];
  sandbox.state.dreaming = { enabled: true, status: true };
  sandbox.renderDreamingIndicator();
  assert.equal(indicator.hidden, false);
  assert.equal(elements.get('#dreaming-label').textContent, 'Not dreaming');
  assert.equal(indicator.disabled, false);
  assert.equal(bar.value, 0);
  assert.match(label.textContent, /No information is currently being processed/);
  sandbox.state.dreaming.enabled = false;
  sandbox.renderDreamingIndicator();
  assert.equal(indicator.disabled, true);
  assert.match(label.textContent, /Configure an AI provider/);
  sandbox.state.dreaming.status = false;
  sandbox.renderDreamingIndicator();
  assert.match(label.textContent, /Restart this server/);
  sandbox.state.dreaming.status = true;
  sandbox.dreamingErrors = [{ executiveId: 'alex-executive', scope: 'public', error: 'Provider unavailable.' }];
  sandbox.renderDreamingIndicator();
  assert.equal(elements.get('#dreaming-label').textContent, 'Dreaming failed');
  assert.match(label.textContent, /Provider unavailable.*Click to retry/);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="memory-actions">[\s\S]*?id="open-memory"[\s\S]*?id="dreaming-indicator"[\s\S]*?id="dreaming-progress"[\s\S]*?<\/button>/);
});

test('Dreaming time estimates use completed batch durations, account for parallel work and never claim early completion', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function dreamingProgress(');
  const end = source.indexOf('function renderDreamingIndicator()', start);
  const sandbox = {};
  runInNewContext(source.slice(start, end), sandbox);
  const job = { executiveId: 'alex', phase: 'organizing', completedBatches: 2, totalBatches: 10,
    startedAt: 1000, lastBatchAt: 21000 };
  const estimate = sandbox.dreamingProgress([job], 31000);
  assert.equal(estimate.percent, 20);
  assert.equal(estimate.indeterminate, false);
  assert.match(estimate.text, /Estimated 2 min remaining/);
  assert.match(sandbox.dreamingProgress([{ ...job, totalBatches: 4 }], 26000).text, /Estimated 15 sec remaining/);
  assert.match(sandbox.dreamingProgress([job], 111000).text, /Taking longer than estimated; still processing/);
  assert.match(sandbox.dreamingProgress([job, { ...job, executiveId: 'other' }], 31000).text, /Estimated 2 min remaining/);
  assert.match(sandbox.dreamingProgress([job, job], 31000).text, /Estimated 3 min remaining/);
  const saving = sandbox.dreamingProgress([{ ...job, phase: 'saving', completedBatches: 10 }], 31000);
  assert.equal(saving.percent, 99);
  assert.match(saving.text, /Finishing: saving/);
  assert.match(sandbox.dreamingProgress([{ ...job, completedBatches: 0 }], 31000).text, /after the first text batch/);
  assert.equal(sandbox.dreamingProgress([{ ...job, phase: 'queued', totalBatches: 0 }], 31000).indeterminate, true);
});

test('header Dreaming button submits active context, prevents duplicate runs and surfaces failures', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function triggerDreaming(');
  const end = source.indexOf("$('#memory-month').addEventListener", start);
  const elements = new Map();
  const calls = [];
  const active = { ...context, mode: 'twin', profileId: 'jordan' };
  let fail = false;
  const sandbox = {
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, {
        addEventListener(_event, handler) { this.handler = handler; }, removeAttribute() {},
      });
      return elements.get(selector);
    },
    busy: false, state: { dreaming: { enabled: true } }, dreamingJobs: [],
    context: () => active, run: action => action,
    setBusy: value => { sandbox.busy = value; },
    api: async (path, method, body) => {
      calls.push({ path, method, body });
      if (fail) throw new Error('Provider unavailable');
      return { dreaming: [{ status: 'queued', scope: 'public' }] };
    },
      dreamingSummary: () => 'Dreaming started in the background.',
  };
  runInNewContext(source.slice(start, end), sandbox);
  await elements.get('#dreaming-indicator').handler();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'executives/alex-executive/dream');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, active);
  assert.equal(elements.get('#soul-status').textContent, 'Dreaming started in the background.');
  assert.equal(elements.get('#upload-result').textContent, 'Dreaming started in the background.');
  assert.equal(elements.get('#upload-result').hidden, false);
  assert.equal(sandbox.busy, false);
  sandbox.dreamingJobs = [{ executiveId: active.executiveId }];
  await elements.get('#dreaming-indicator').handler();
  assert.equal(calls.length, 1);
  sandbox.dreamingJobs = [];
  fail = true;
  await assert.rejects(elements.get('#dreaming-indicator').handler(), /Provider unavailable/);
  assert.equal(elements.get('#soul-status').textContent, 'Dreaming failed: Provider unavailable');
  assert.equal(elements.get('#upload-result').textContent, 'Dreaming failed: Provider unavailable');
  assert.equal(sandbox.busy, false);
});

test('Dreaming status tracks automatic and queued manual runs and clears after success or failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-status-'));
  let notifyStarted;
  let release;
  let started = new Promise(resolve => { notifyStarted = resolve; });
  let blocked = new Promise(resolve => { release = resolve; });
  let fail = false;
  const app = createApp({ directory, apiKey: 'fixture', generalizer: async () => '', fetcher: async () => {
    notifyStarted();
    await blocked;
    if (fail) return new Response('', { status: 429 });
    return completion([]);
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    release();
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const post = (path, input) => fetch(`${base}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const status = () => fetch(`${base}/dreaming`).then(response => response.json());
  assert.deepEqual(await status(), { jobs: [], errors: [] });
  const upload = post('documents', { ...context, scope: 'enriched', title: 'Private confidential title',
    content: 'Private confidential evidence.' });
  await started;
  const running = await status();
  assert.equal(running.jobs.length, 1);
  const { startedAt, lastBatchAt, ...runningJob } = running.jobs[0];
  assert.ok(Number.isFinite(startedAt));
  assert.equal(lastBatchAt, startedAt);
  assert.deepEqual(runningJob, {
    executiveId: 'alex-executive', phase: 'organizing', completedBatches: 0, totalBatches: 1,
  });
  assert.doesNotMatch(JSON.stringify(running), /confidential|enriched|profileId/);
  const manual = post('executives/alex-executive/dream', context);
  let queued;
  for (let attempt = 0; attempt < 20; attempt++) {
    queued = await status();
    if (queued.jobs.length === 2) break;
  }
  assert.equal(queued.jobs.length, 2);
  assert.equal(queued.jobs[1].phase, 'queued');
  const uploaded = await (await upload).json();
  assert.equal(uploaded.dreaming[0].status, 'queued');
  assert.equal((await manual).status, 200);
  release();
  assert.deepEqual(await waitForDreamIdle(base), { jobs: [], errors: [] });
  fail = true;
  started = new Promise(resolve => { notifyStarted = resolve; });
  blocked = new Promise(resolve => { release = resolve; });
  const failure = post('executives/alex-executive/dream', context);
  await started;
  assert.equal((await status()).jobs[0].phase, 'organizing');
  assert.equal((await failure).status, 200);
  release();
  const failedStatus = await waitForDreamIdle(base);
  assert.deepEqual(failedStatus.jobs, []);
  assert.equal(failedStatus.errors[0].executiveId, context.executiveId);
  assert.match(failedStatus.errors[0].error, /HTTP 429/);
});

test('a running Dreaming job does not block work for another executive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-independent-executives-'));
  const store = createStore(directory);
  const other = store.addExecutive({ name: 'Jordan Lee', role: 'CFO', ownerId: 'alex' });
  store.close();
  let notifyStarted;
  let release;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const app = createApp({ directory, apiKey: 'fixture', generalizer: async () => '', fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.startsWith('Organize RAG evidence')) {
      notifyStarted();
      await blocked;
      return completion([]);
    }
    return Response.json({ choices: [{ message: { content: 'Answer.' } }] });
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    release();
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const firstUpload = fetch(`${base}/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, scope: 'public', title: 'Alex source', content: 'Alex evidence.' }) });
  await started;
  const uploadResponse = await firstUpload;
  assert.equal(uploadResponse.status, 200);
  assert.equal((await uploadResponse.json()).dreaming[0].status, 'queued');
  const active = await fetch(`${base}/dreaming`).then(response => response.json());
  assert.deepEqual(active.jobs.map(job => job.executiveId), [context.executiveId]);
  const chat = await fetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, executiveId: other.id, question: 'How are things going?' }) });
  assert.equal(chat.status, 200);
  assert.match((await chat.json()).content, /Answer\./);
  release();
  assert.deepEqual(await waitForDreamIdle(base), { jobs: [], errors: [] });
});

test('Dreaming rejects invalid dates, malformed and truncated output explicitly', async () => {
  const input = { executive: { name: 'Alex', role: 'CEO' },
    documents: [{ id: 'one', title: 'Note', created_at: '2026-11-09T00:00:00Z', content: 'Prioritize reliability.' }],
    apiKey: 'fixture', model: 'fixture' };
  for (const changes of [{ date: '2026-02-30' }, { category: 'unknown' }, { topic: '\0' }]) {
    await assert.rejects(dreamDocuments({ ...input, fetcher: async () => completion([finding(changes)]) }));
  }
  await assert.rejects(dreamDocuments({ ...input, apiKey: undefined }), /configured AI/);
  await assert.rejects(dreamDocuments({ ...input, fetcher: async () => Response.json({
    choices: [{ finish_reason: 'length', message: { content: '{"findings":[]}' } }],
  }) }), /incomplete/);
  await assert.rejects(dreamDocuments({ ...input, fetcher: async () => Response.json({
    choices: [{ message: { content: 'invalid JSON' } }],
  }) }), /invalid JSON/);
  await assert.rejects(dreamDocuments({ ...input, fetcher: async () => new Response('', { status: 401 }) }), /HTTP 401/);
});

test('Dreaming accepts whitespace-only quote differences and stores the original source quote', async () => {
  const excerpt = 'Prioritize\r\n  reliability.\u00a0Keep [plans] (small) + measurable.';
  const result = await dreamDocuments({
    executive: { name: 'Alex', role: 'CEO' }, apiKey: 'fixture', model: 'fixture',
    documents: [{ id: 'source', title: 'Note', created_at: '2026-11-09T00:00:00Z', content: excerpt }],
    fetcher: async () => completion([finding({ evidence: 'Prioritize reliability. Keep [plans] (small) + measurable.' })]),
  });
  assert.equal(result[0].evidence, excerpt);
});

test('Dreaming retries quote mismatches once, retains valid findings and continues later batches', async () => {
  const documents = [{ id: 'source', title: 'Note', created_at: '2026-11-09T00:00:00Z',
    content: `Prioritize reliability.${'x'.repeat(16000)}Keep plans small.` }];
  const payloads = [];
  const result = await dreamDocuments({
    executive: { name: 'Alex', role: 'CEO' }, apiKey: 'fixture', model: 'fixture', documents,
    fetcher: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return completion(payloads.length === 1 ? [finding()]
        : payloads.length === 2 ? [finding({ content: 'Unsupported', evidence: 'Translated or invented quote' }),
          finding({ content: 'Valid but not committed yet', evidence: 'Keep plans small.' })]
          : [finding({ content: 'Still unsupported', evidence: 'Another invented quotation' }),
            finding({ topic: 'plans', content: 'Keep plans small.', evidence: 'Keep plans small.' })]);
    },
  });
  assert.equal(payloads.length, 3);
  assert.equal(payloads[1].messages[1].content, payloads[2].messages[1].content);
  assert.match(payloads[2].messages[2].content, /previous attempt contained evidence not found/);
  assert.equal(result.length, 2);
  assert.ok(result.some(item => item.content === 'Keep plans small.'));
  assert.ok(result.every(item => !item.content.includes('Unsupported') && !item.content.includes('invented')));
});

test('Dreaming discards translated, paraphrased, stitched or header-only quotes after retry', async () => {
  const documents = [{ id: 'source', title: 'Header quote', created_at: '2026-11-09T00:00:00Z',
    content: 'Prioritize reliability. Keep plans small.' }];
  for (const evidence of ['Prioritise reliability.', 'Prioritize reliability. ... Keep plans small.',
    'Prioritize Keep plans', 'Header quote', 'Prioritize reliability!']) {
    let calls = 0;
    const result = await dreamDocuments({
      executive: { name: 'Alex', role: 'CEO' }, apiKey: 'fixture', model: 'fixture', documents,
      fetcher: async () => { calls++; return completion([finding({ evidence })]); },
    });
    assert.equal(calls, 2);
    assert.deepEqual(result, []);
  }
});

test('Dreaming persists recent memory, historical subfiles, idempotence and manual supersession', async t => {
  const { store, root } = await fixture(t);
  const old = store.insertDocument({ ...context, scope: 'public', title: 'Old', content: 'Old strategy.' });
  const recent = store.insertDocument({ ...context, scope: 'public', title: 'Recent', content: 'Recent strategy.' });
  const findings = [finding({ sourceId: old.id, date: '2024-01-01', content: 'Zephyr legacy strategy.' }),
    finding({ sourceId: recent.id, content: 'Saffron current strategy.' })];
  store.saveDream(store.dreamingSnapshot(context), findings);
  let memories = store.memory(context).entries;
  const newer = memories.find(item => item.sourceId === recent.id);
  assert.equal(memories.find(item => item.sourceId === old.id).supersededBy, newer.id);
  assert.ok(store.retrieve(context, 'Saffron').some(item => item.memoryId === newer.id));
  assert.ok(!store.retrieve(context, 'Zephyr').some(item => item.memoryId));
  assert.match(await readFile(join(root, 'memory', 'public', '2024-01.md'), 'utf8'), /superseded/);
  assert.match(await readFile(join(root, 'memory', 'public', '2026-11.md'), 'utf8'), /Date basis: event date/);
  const manual = store.addMemory({ ...context, sourceId: recent.id, content: 'User revised strategy.',
    category: 'priority', status: 'confirmed', date: '2026-11-09', supersedes: newer.id });
  store.saveDream(store.dreamingSnapshot(context), findings);
  memories = store.memory(context).entries;
  assert.equal(memories.length, 3);
  assert.equal(memories.find(item => item.id === newer.id).supersededBy, manual.id);
  store.deleteMemory(context, manual.id);
  store.saveDream(store.dreamingSnapshot(context), findings);
  assert.ok(store.memory(context).entries.find(item => item.id === newer.id).supersededBy);
});

test('successful Dreaming creates dated source files even when no memories are extracted', async t => {
  const { store, root } = await fixture(t);
  const source = store.insertDocument({ ...context, scope: 'public', title: 'Incoming business context',
    content: 'An incoming message remains available for retrieval.' });
  const snapshot = store.dreamingSnapshot(context);
  const date = snapshot.documents.find(document => document.id === source.id).created_at.slice(0, 10);
  const result = store.saveDream(snapshot, []);
  assert.equal(result.memories, 0);
  assert.equal(result.sourceMonths, 1);
  const index = await readFile(join(root, 'memory.md'), 'utf8');
  assert.match(index, /Processed Sources/);
  assert.ok(index.includes(`memory/public/${date.slice(0, 7)}.md#source-${source.id}`));
  const monthlyPath = join(root, 'memory', 'public', `${date.slice(0, 7)}.md`);
  const monthly = await readFile(monthlyPath, 'utf8');
  assert.match(monthly, /Incoming business context/);
  assert.match(monthly, /upload date, not a known event date/);
  assert.match(monthly, /No durable memories were extracted/);
  assert.ok(monthly.includes(`/api/documents/${source.id}`));
  assert.ok(store.memory(context).sources.some(item => item.id === source.id));
  const manual = store.addMemory({ ...context, sourceId: source.id, content: 'Reviewed context.',
    category: 'context', status: 'confirmed', date });
  store.deleteMemory(context, manual.id);
  assert.match(await readFile(monthlyPath, 'utf8'), /Incoming business context/);
  store.saveDream(store.dreamingSnapshot(context), []);
  assert.equal(store.memory(context).sources.filter(item => item.id === source.id).length, 1);
  store.deleteDocument(source.id);
  assert.doesNotMatch(await readFile(join(root, 'memory.md'), 'utf8'), /Incoming business context/);
});

test('dated source indexes stay scoped and survive startup without exposing private sources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-source-files-'));
  let store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const privateContext = { ...context, mode: 'enriched' };
  const privateSource = store.insertDocument({ ...context, scope: 'enriched', title: 'Private source', content: 'Private text.' });
  store.saveDream(store.dreamingSnapshot(privateContext), []);
  const root = join(directory, 'executives', context.executiveId);
  const privateIndex = join(root, 'memory', 'enriched', 'alex', 'memory.md');
  assert.match(await readFile(privateIndex, 'utf8'), /Private source/);
  assert.doesNotMatch(await readFile(join(root, 'memory.md'), 'utf8'), /Private source/);
  assert.deepEqual(store.memory({ ...privateContext, profileId: 'jordan' }).sources, []);
  store.close();
  store = createStore(directory);
  assert.match(await readFile(privateIndex, 'utf8'), /Private source/);
  assert.ok(store.memory(privateContext).sources.some(item => item.id === privateSource.id));
  store.deleteDocument(privateSource.id);
  await assert.rejects(stat(privateIndex), { code: 'ENOENT' });
});

test('manual Dreaming reports an empty executive explicitly without calling the provider', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-empty-executive-'));
  const store = createStore(directory);
  const empty = store.addExecutive({ name: 'Empty executive', role: 'CEO', ownerId: 'alex' });
  store.close();
  let calls = 0;
  const app = createApp({ directory, apiKey: 'fixture', generalizer: async () => '', fetcher: async () => { calls++; return completion([]); } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/executives/${empty.id}/dream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: 'alex', mode: 'public' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.dreaming[0].status, 'no-sources');
  assert.equal(result.dreaming[0].documents, 0);
  assert.equal(calls, 0);
});

test('Dreaming shares recent traits across every mode while keeping actionable memory scoped', async t => {
  const { store, root } = await fixture(t);
  store.saveSoul(context.executiveId, '# Custom soul\nBe thoughtful.\n');
  const publicSource = store.insertDocument({ ...context, scope: 'public', title: 'Public', content: 'Formal style.' });
  store.saveDream(store.dreamingSnapshot(context), [finding({ sourceId: publicSource.id,
    kind: 'trait', topic: 'tone', content: 'Formal public tone.', date: '2024-01-01' })]);
  const privateSource = store.insertDocument({ ...context, scope: 'enriched', title: 'Private', content: 'Cobalt casual style.' });
  const privateContext = { ...context, mode: 'enriched' };
  store.saveDream(store.dreamingSnapshot(privateContext), [finding({ sourceId: privateSource.id,
    kind: 'trait', topic: 'tone', content: 'Casual tone.', dateBasis: 'upload', evidence: 'Private evidence quote.' }),
  finding({ sourceId: privateSource.id, content: 'Cobalt project deadline is Friday.' })]);
  const shared = await readFile(join(root, 'soul.md'), 'utf8');
  assert.match(shared, /Custom soul/);
  assert.match(shared, /Casual tone/);
  assert.match(shared, /upload date fallback/);
  assert.doesNotMatch(shared, /Formal public tone|Cobalt|Private evidence quote|\/api\/documents/);
  for (const profileId of ['alex', 'jordan']) {
    for (const mode of ['public', 'enriched', 'twin']) {
      assert.equal(store.soul(context.executiveId, { ...context, profileId, mode }).content, shared);
    }
  }
  assert.match(await readFile(join(root, 'memory', 'enriched', 'alex', 'memory.md'), 'utf8'), /Cobalt/);
  assert.doesNotMatch(await readFile(join(root, 'memory.md'), 'utf8'), /Cobalt/);
  assert.ok(store.retrieve(privateContext, 'Cobalt').some(item => item.memoryId));
  assert.deepEqual(store.retrieve(context, 'Cobalt'), []);
  assert.deepEqual(store.retrieve({ ...privateContext, profileId: 'jordan' }, 'Cobalt'), []);
  assert.ok(store.dreamingSnapshot(context).traitTopics.includes('tone'));
  await assert.rejects(stat(join(root, 'memory', 'enriched', 'alex', 'soul.md')), { code: 'ENOENT' });
  const twinSource = store.insertDocument({ ...context, profileId: 'jordan', scope: 'twin', title: 'Twin', content: 'Emerald.' });
  store.saveDream(store.dreamingSnapshot({ ...context, mode: 'twin' }),
    [finding({ sourceId: twinSource.id, kind: 'trait', topic: 'tone', content: 'Direct tone.', date: '2026-11-08' })]);
  assert.match(store.soul(context.executiveId, context).content, /Direct tone/);
  assert.doesNotMatch(store.soul(context.executiveId, privateContext).content, /Casual tone/);
  await assert.rejects(stat(join(root, 'memory', 'twin', 'alex', 'soul.md')), { code: 'ENOENT' });
  store.deleteDocument(twinSource.id);
  assert.match(store.soul(context.executiveId, context).content, /Casual tone/);
  store.deleteDocument(privateSource.id);
  assert.doesNotMatch(store.soul(context.executiveId, context).content, /Casual tone/);
  assert.match(store.soul(context.executiveId, context).content, /Formal public tone/);
  store.deleteDocument(publicSource.id);
  assert.doesNotMatch(await readFile(join(root, 'soul.md'), 'utf8'), /Formal public/);
});

test('startup consolidates stored traits and removes only legacy scoped soul projections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-shared-soul-'));
  let store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const privateContext = { ...context, mode: 'enriched' };
  const source = store.insertDocument({ ...context, scope: 'enriched', title: 'Private', content: 'Private strategy.' });
  store.saveDream(store.dreamingSnapshot(privateContext), [
    finding({ sourceId: source.id, kind: 'trait', topic: 'tone', content: 'Measured tone.' }),
    finding({ sourceId: source.id, content: 'Private strategy commitment.' }),
  ]);
  const root = join(directory, 'executives', context.executiveId);
  const memoryPath = join(root, 'memory', 'enriched', 'alex', '2026-11.md');
  const memoryBefore = await readFile(memoryPath, 'utf8');
  store.close();
  await writeFile(join(root, 'soul.md'), '# Custom legacy soul\nBe respectful.\n');
  await writeFile(join(root, 'memory', 'enriched', 'alex', 'soul.md'), 'Legacy private soul.');
  await mkdir(join(root, 'memory', 'twin', 'retired-profile'), { recursive: true });
  await writeFile(join(root, 'memory', 'twin', 'retired-profile', 'soul.md'), 'Legacy twin soul.');
  await writeFile(join(root, 'memory', 'twin', 'retired-profile', 'notes.md'), 'Keep this file.');
  store = createStore(directory);
  const shared = await readFile(join(root, 'soul.md'), 'utf8');
  assert.match(shared, /Custom legacy soul|Be respectful/);
  assert.match(shared, /Measured tone/);
  assert.doesNotMatch(shared, /Private strategy commitment/);
  assert.equal(store.soul(context.executiveId, context).content, shared);
  assert.equal(await readFile(memoryPath, 'utf8'), memoryBefore);
  await assert.rejects(stat(join(root, 'memory', 'enriched', 'alex', 'soul.md')), { code: 'ENOENT' });
  await assert.rejects(stat(join(root, 'memory', 'twin', 'retired-profile', 'soul.md')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'memory', 'twin', 'retired-profile', 'notes.md'), 'utf8'), 'Keep this file.');
});

test('equal-date trait conflicts remain uncertain; stale or oversized runs preserve previous findings', async t => {
  const { store, root } = await fixture(t);
  const source = store.insertDocument({ ...context, scope: 'public', title: 'Style', content: 'Style.' });
  const trait = finding({ kind: 'trait', topic: 'tone', sourceId: source.id, content: 'Concise tone.' });
  const rendered = dreamedSoul('# Custom', [trait, { ...trait, content: 'Expansive tone.' },
    { ...trait, content: 'Old tone.', date: '2020-01-01' }]);
  assert.match(rendered, /Concise tone/);
  assert.match(rendered, /Expansive tone/);
  assert.doesNotMatch(rendered, /Old tone/);
  store.saveDream(store.dreamingSnapshot(context), [trait]);
  const before = await readFile(join(root, 'soul.md'), 'utf8');
  const snapshot = store.dreamingSnapshot(context);
  store.insertDocument({ ...context, scope: 'public', title: 'Changed', content: 'Changed.' });
  assert.throws(() => store.saveDream(snapshot, []), /changed during Dreaming/);
  assert.throws(() => store.saveDream(store.dreamingSnapshot(context), Array.from({ length: 10 }, (_, i) =>
    ({ ...trait, topic: `long-${i}`, content: 'x'.repeat(2000) }))), /Executive soul/);
  assert.equal(await readFile(join(root, 'soul.md'), 'utf8'), before);
  assert.match(store.soul(context.executiveId).content, /Concise tone/);
});

test('uploads dream automatically, failures retain sources, and manual retry handles existing data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-api-'));
  let failing = false;
  const chatPayloads = [];
  const app = createApp({ directory, apiKey: 'fixture', generalizer: async () => '', fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.startsWith('Organize RAG evidence')) {
      if (failing) return new Response('', { status: 429 });
      const excerpt = JSON.parse(body.messages[1].content).excerpt;
      return completion(excerpt.includes('Cobalt') ? [finding({ kind: 'trait', topic: 'tone',
        date: null, content: 'Measured tone.', evidence: 'Cobalt measured tone.' }),
      finding({ date: null, content: 'Cobalt project deadline is Friday.', evidence: 'Cobalt project deadline is Friday.' })] : []);
    }
    chatPayloads.push(body);
    return Response.json({ choices: [{ message: { content: 'Answer.' } }] });
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}/api`;
  const post = async (path, input) => {
    const response = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const uploaded = await post('documents', { ...context, scope: 'enriched', title: 'Private',
    content: 'Cobalt measured tone. Cobalt project deadline is Friday.' });
  assert.equal(uploaded.body.dreaming[0].status, 'queued');
  await waitForDreamIdle(base);
  const root = join(directory, 'executives', context.executiveId);
  assert.match(await readFile(join(root, 'memory', 'twin', 'alex', 'memory.md'), 'utf8'), /Processed Sources|Cobalt project deadline/);
  const soul = await fetch(`${base}/executives/alex-executive/soul?${new URLSearchParams({ ...context, mode: 'enriched' })}`).then(r => r.json());
  assert.match(soul.content, /Measured tone/);
  assert.doesNotMatch(soul.content, /Cobalt|Friday|\/api\/documents/);
  const publicSoul = await fetch(`${base}/executives/alex-executive/soul`).then(r => r.json());
  assert.equal(publicSoul.content, soul.content);
  for (const viewer of [{ mode: 'public' }, { mode: 'twin' }, { profileId: 'jordan', mode: 'enriched' }]) {
    assert.equal((await post('chat', { ...context, ...viewer, question: 'Cobalt project deadline?' })).status, 200);
  }
  for (const payload of chatPayloads) assert.ok(payload.messages[0].content.includes(soul.content));
  assert.ok(!chatPayloads[0].messages.at(-2).content.includes('Cobalt project deadline is Friday.'));
  assert.ok(chatPayloads[1].messages.at(-2).content.includes('Cobalt project deadline is Friday.'));
  assert.ok(!chatPayloads[2].messages.at(-2).content.includes('Cobalt project deadline is Friday.'));
  failing = true;
  const failed = await post('documents', { ...context, scope: 'public', title: 'Saved despite failure', content: 'Evidence.' });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.dreaming[0].status, 'queued');
  assert.equal((await fetch(`${base}/documents/${failed.body.id}`)).status, 200);
  const failureStatus = await waitForDreamIdle(base);
  assert.match(failureStatus.errors[0].error, /HTTP 429/);
  failing = false;
  const retried = await post('executives/alex-executive/dream', { ...context, mode: 'twin' });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body.dreaming.map(item => item.status), ['queued', 'queued']);
  await waitForDreamIdle(base);
  const sourceDate = new Date().toISOString().slice(0, 7);
  assert.match(await readFile(join(root, 'memory', 'twin', 'alex', `${sourceDate}.md`), 'utf8'), /Saved despite failure/);
  const fileResponse = await fetch(`${base}/files?${new URLSearchParams({
    ...context, scope: 'public', title: 'Text file', filename: 'note.txt',
  })}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'Cobalt measured tone. Cobalt project deadline is Friday.' });
  assert.equal(fileResponse.status, 200);
  assert.equal((await fileResponse.json()).dreaming[0].status, 'queued');
  await waitForDreamIdle(base);
  const archived = await post('documents', { ...context, scope: 'public', title: 'Transcript',
    content: 'Recording source: fixture\n\nTIMESTAMPED SPEECH TRANSCRIPT\n[00:00:00 - 00:00:03] Speaker: Unknown: Cobalt measured tone.' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.dreaming[0].status, 'pending-speaker-review');
});

test('recording archives wait for review and publishing dreams each assigned executive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dreaming-recording-'));
  const store = createStore(directory);
  const recording = store.insertRecording({ ...context, scope: 'public', title: 'Meeting', content: 'Whole meeting.' },
    [{ start: 0, end: 3, text: 'Direct style.' }]);
  store.close();
  let calls = 0;
  const app = createApp({ directory, apiKey: 'fixture', generalizer: async () => '', fetcher: async (_url, options) => {
    calls++;
    const excerpt = JSON.parse(JSON.parse(options.body).messages[1].content).excerpt;
    assert.doesNotMatch(excerpt, /Whole meeting/);
    return completion(excerpt.includes('Direct style.') ? [finding({ kind: 'trait', topic: 'tone',
      date: null, content: 'Direct tone (user-labeled speaker).', evidence: 'Direct style.' })] : []);
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.address().port}/api/documents/${recording.id}/speakers`;
  const publish = async draft => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: ['alex-executive'], draft }) });
  assert.equal((await publish(true)).status, 200);
  assert.equal(calls, 0);
  const published = await (await publish(false)).json();
  assert.equal(published.dreaming[0].status, 'queued');
  await waitForDreamIdle(`http://127.0.0.1:${app.address().port}/api`);
  assert.match(await readFile(join(directory, 'executives', context.executiveId, 'soul.md'), 'utf8'), /Direct tone/);
  const republished = await (await publish(false)).json();
  assert.equal(republished.dreaming[0].status, 'queued');
  await waitForDreamIdle(`http://127.0.0.1:${app.address().port}/api`);
  const soul = await readFile(join(directory, 'executives', context.executiveId, 'soul.md'), 'utf8');
  assert.equal(soul.match(/Direct tone/g).length, 1);
});

test('recency scoring favors recent equally relevant memories without changing relevance eligibility', async t => {
  const { store } = await fixture(t);
  const source = store.insertDocument({ ...context, scope: 'public', title: 'Neutral', content: 'Nothing relevant.' });
  const add = date => store.addMemory({ ...context, sourceId: source.id, content: 'Albatross focus.',
    category: 'priority', status: 'inference', date });
  const old = add('2020-01-01');
  const current = add(new Date().toISOString().slice(0, 10));
  const sources = store.retrieve(context, 'Albatross');
  assert.deepEqual(sources.map(item => item.memoryId), [current.id, old.id]);
  assert.deepEqual(store.retrieve(context, 'unrelatedtoken'), []);
});
