import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';
import { createStore } from '../lib/store.js';
import { answerQuestion, chatMessages, promptUsage } from '../lib/chat.js';
import { providerConfig } from '../lib/provider.js';
import { DEFAULT_SOUL, SOUL_LIMIT } from '../lib/soul.js';
import { PREDEFINED_EXECUTIVES } from '../lib/builtin-knowledge.js';

const predefinedIds = new Set(PREDEFINED_EXECUTIVES.map(item => item.id));
const ownExecutives = executives => executives.filter(item => !predefinedIds.has(item.id));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-executive-test-'));
  const app = createApp({ directory, apiKey: '', chatMemory: false, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${base}/api/${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, base, directory };
}
const context = { executiveId: 'alex-executive', profileId: 'alex', mode: 'public' };

test('knowledge sources are grouped by their original file type rather than their display title', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-types-'));
  const store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const [filename, expected] of [['meeting.EML', 'mails'], ['archive.mbox', 'mails'], ['message.msg', 'mails'], ['meeting.mp4', 'videos'], ['deck.PPTX', 'presentations'], ['report.pdf', 'others'], ['interview.mp3', 'others']]) {
    const source = store.insertDocument({ ...context, scope: 'public', title: 'Renamed source', content: 'Source text',
      original: { filename, storageName: filename, bytes: 1 } });
    const listed = store.visibleDocuments(context).find(document => document.id === source.id);
    assert.equal(listed.originalFilename, filename);
    assert.equal(listed.type, expected);
  }
  const pasted = store.insertDocument({ ...context, scope: 'public', title: 'Pasted notes', content: 'Notes' });
  assert.equal(store.visibleDocuments(context).find(document => document.id === pasted.id).type, 'others');
  assert.equal(store.visibleDocuments(context).find(document => document.id === pasted.id).originalFilename, null);
});

test('projects and conversations persist separate histories and validate their context', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-test-'));
  let store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const project = store.addProject({ profileId: 'alex', name: 'Strategy' });
  const first = store.addConversation({ ...context, projectId: project.id });
  const second = store.addConversation(context);
  const answer = { content: 'Answer', sources: [], engine: 'fixture' };
  store.saveExchange({ ...context, conversationId: first.id }, 'First topic', answer);
  store.saveExchange({ ...context, conversationId: second.id }, 'Second topic', answer);
  assert.deepEqual(store.history({ ...context, conversationId: first.id }).map(message => message.content), ['First topic', 'Answer']);
  assert.equal(store.conversations('alex').find(item => item.id === first.id).title, 'First topic');
  assert.throws(() => store.history({ ...context, profileId: 'jordan', conversationId: first.id }), /not found/);
  assert.throws(() => store.history({ ...context, mode: 'twin', conversationId: first.id }), /not found/);
  assert.throws(() => store.addConversation({ ...context, profileId: 'jordan', projectId: project.id }), /not found/);
  store.updateConversation(second.id, { profileId: 'alex', title: 'Renamed', projectId: project.id });
  store.close();
  store = createStore(directory);
  assert.equal(store.projects('alex')[0].name, 'Strategy');
  assert.equal(store.conversations('alex').find(item => item.id === second.id).project_id, project.id);
  store.deleteProject(project.id, 'alex');
  assert.equal(store.conversations('alex').find(item => item.id === first.id).project_id, null);
  store.deleteConversation(first.id, 'alex');
  assert.equal(store.conversations('alex').length, 1);
  store.deleteExecutive(context.executiveId);
  assert.deepEqual(store.conversations('alex'), []);
});

test('existing message histories migrate once into saved conversations without losing messages', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-migration-'));
  const database = new DatabaseSync(join(directory, 'sandbox.sqlite'));
  database.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE executives (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, bio TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES profiles(id));
    CREATE TABLE messages (id TEXT PRIMARY KEY, executive_id TEXT NOT NULL REFERENCES executives(id), profile_id TEXT NOT NULL REFERENCES profiles(id), mode TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL, engine TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO profiles VALUES ('alex', 'Alex');
    INSERT INTO executives VALUES ('alex-executive', 'Alex', 'CEO', '', 'alex');
    INSERT INTO messages VALUES ('old-question', 'alex-executive', 'alex', 'public', 'user', 'Existing topic', '[]', 'fixture', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('old-answer', 'alex-executive', 'alex', 'public', 'assistant', 'Existing answer', '[]', 'fixture', '2026-01-01T00:00:01.000Z');
  `);
  database.close();
  let store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const chat = store.conversations('alex')[0];
  assert.equal(chat.title, 'Existing topic');
  assert.deepEqual(store.history({ ...context, conversationId: chat.id }).map(message => message.content), ['Existing topic', 'Existing answer']);
  store.close();
  store = createStore(directory);
  assert.equal(store.conversations('alex').length, 1);
  assert.equal(store.conversations('alex')[0].id, chat.id);
});

test('conversation and project APIs create, reopen, rename, move, and delete chats', async t => {
  const { request } = await fixture(t);
  const project = (await request('projects', 'POST', { profileId: 'alex', name: 'Planning' })).body;
  const first = (await request('conversations', 'POST', { ...context, projectId: project.id })).body;
  const second = (await request('conversations', 'POST', context)).body;
  assert.equal((await request('chat', 'POST', { ...context, conversationId: first.id, question: 'First topic' })).status, 200);
  assert.equal((await request(`messages?${new URLSearchParams({ ...context, conversationId: first.id })}`)).body.length, 2);
  assert.deepEqual((await request(`messages?${new URLSearchParams({ ...context, conversationId: second.id })}`)).body, []);
  assert.equal((await request('chat', 'POST', { ...context, mode: 'twin', conversationId: first.id, question: 'Wrong mode' })).status, 404);
  assert.equal((await request(`conversations/${second.id}`, 'PATCH', { profileId: 'alex', title: 'Revised', projectId: project.id })).body.title, 'Revised');
  assert.equal((await request(`conversations/${first.id}?profileId=jordan`, 'DELETE')).status, 404);
  assert.equal((await request('projects?profileId=alex')).body.length, 1);
  assert.equal((await request(`projects/${project.id}?profileId=alex`, 'DELETE')).status, 200);
  assert.ok((await request('conversations?profileId=alex')).body.every(item => item.project_id === null));
  assert.equal((await request(`conversations/${first.id}?profileId=alex`, 'DELETE')).status, 200);
  assert.equal((await request('conversations?profileId=alex')).body.length, 1);
});

test('executive edits validate profile fields and preserve owner, sources, soul, and memory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-edit-'));
  const store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const source = store.insertDocument({ ...context, scope: 'public', title: 'Strategy', content: 'Reliability priority.' });
  store.saveSoul(context.executiveId, '# Custom soul\nBe concise.');
  store.addMemory({ ...context, sourceId: source.id, content: 'Prioritize reliability.', category: 'priority', status: 'confirmed', date: '2026-11-06' });
  const edited = store.updateExecutive(context.executiveId, { name: 'Updated executive', role: 'President', bio: 'New background' });
  assert.equal(edited.owner_id, 'alex');
  assert.equal(edited.role, 'President');
  assert.equal(store.document(source.id).title, 'Strategy');
  assert.match(store.soul(context.executiveId).content, /Custom soul/);
  assert.equal(store.memory(context).entries.length, 1);
  for (const changes of [{ name: '' }, { role: 'x'.repeat(121) }, { bio: 123 }, { bio: 'x'.repeat(2001) }, { ownerId: 'jordan' }]) {
    assert.throws(() => store.updateExecutive(context.executiveId, changes));
    assert.equal(store.context(context).name, 'Updated executive');
  }
  assert.throws(() => store.updateExecutive('missing', { name: 'Unknown' }), /not found/);
});

test('executive PATCH and DELETE APIs persist edits, reject invalid fields, and allow recreating after deleting the last executive', async t => {
  const { request } = await fixture(t);
  const route = `executives/${context.executiveId}`;
  assert.equal((await request('state')).body.executiveManagement, true);
  const changed = await request(route, 'PATCH', { name: 'Edited name', role: 'President', bio: 'Revised background' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.owner_id, 'alex');
  assert.equal((await request('state')).body.executives.find(item => item.id === context.executiveId).name, 'Edited name');
  assert.equal((await request(route, 'PATCH', { name: '' })).status, 400);
  assert.equal((await request('executives/missing', 'PATCH', { name: 'Missing' })).status, 404);
  assert.equal((await request(route, 'DELETE')).status, 200);
  for (const item of (await request('state')).body.executives) await request(`executives/${item.id}`, 'DELETE');
  assert.deepEqual((await request('state')).body.executives, []);
  assert.equal((await request(route, 'DELETE')).status, 404);
  const recreated = await request('executives', 'POST', { name: 'New executive', role: 'CEO', ownerId: 'alex' });
  assert.equal(recreated.status, 200);
  assert.equal((await request('state')).body.executives[0].id, recreated.body.id);
});

test('executive deletion cleans identity data, preserves other speakers and shared originals, and supports an empty directory after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-delete-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = createStore(directory);
  try {
    const other = store.addExecutive({ name: 'Other speaker', role: 'CFO', ownerId: 'jordan' });
    await mkdir(join(directory, 'originals'));
    await writeFile(join(directory, 'originals', 'shared'), 'original');
    const segments = [
      { start: 0, end: 3, text: 'First voice.', speakerId: 'speaker-1', voiceFingerprint: {
        model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [1, ...Array(191).fill(0)],
      } },
      { start: 3, end: 6, text: 'Second voice.', speakerId: 'speaker-2' },
    ];
    const source = store.insertRecording({ ...context, executiveId: other.id, scope: 'enriched', title: 'Shared meeting', content: 'Reviewed recording.',
      original: { storageName: 'shared', filename: 'meeting.mp4', bytes: 8 } }, segments);
    const published = store.publishRecording(source.id, [context.executiveId, other.id]);
    const ownDocument = published.generated.find(item => item.executiveId === context.executiveId).documentId;
    const otherDocument = published.generated.find(item => item.executiveId === other.id).documentId;
    const hosted = store.insertRecording({ ...context, scope: 'enriched', title: 'Hosted meeting', content: 'Reviewed recording.',
      original: { storageName: 'shared', filename: 'meeting.mp4', bytes: 8 } }, segments);
    const hostedSpeech = store.publishRecording(hosted.id, [null, other.id]).generated[0].documentId;
    store.addMemory({ ...context, mode: 'enriched', sourceId: ownDocument, content: 'Remember first voice.', category: 'context', status: 'confirmed', date: '2026-11-06' });
    store.saveExchange(context, 'Question', { content: 'Answer', sources: [], engine: 'fixture' });
    const database = new DatabaseSync(join(directory, 'sandbox.sqlite'));
    database.exec("CREATE TRIGGER prevent_executive_delete BEFORE DELETE ON executives BEGIN SELECT RAISE(ABORT, 'simulated executive delete failure'); END");
    assert.throws(() => store.deleteExecutive(context.executiveId), /simulated executive delete failure/);
    assert.equal(ownExecutives(store.state().executives).length, 2);
    assert.deepEqual(store.recordingReview(source.id).assignments, [context.executiveId, other.id]);
    assert.equal(store.voiceProfiles('alex')[0].executiveId, context.executiveId);
    assert.equal(store.memory({ ...context, mode: 'enriched' }).entries.length, 1);
    assert.match(store.soul(context.executiveId).content, /Executive soul/);
    database.exec('DROP TRIGGER prevent_executive_delete');
    database.close();
    store.deleteExecutive(context.executiveId);
    assert.deepEqual(ownExecutives(store.state().executives).map(item => item.id), [other.id]);
    assert.deepEqual(store.voiceProfiles('alex'), []);
    assert.throws(() => store.document(ownDocument), /not found/);
    assert.match(store.document(otherDocument).content, /Second voice/);
    assert.throws(() => store.recordingReview(hosted.id), /not found/);
    assert.match(store.document(hostedSpeech).content, /Second voice/);
    assert.deepEqual(store.recordingReview(source.id).assignments, [null, other.id]);
    assert.deepEqual(store.recordingReview(source.id).generated.map(item => item.executiveId), [other.id]);
    assert.equal(await readFile(join(directory, 'originals', 'shared'), 'utf8'), 'original');
    await assert.rejects(stat(join(directory, 'executives', context.executiveId)), { code: 'ENOENT' });
    store.deleteExecutive(other.id);
    for (const item of PREDEFINED_EXECUTIVES) store.deleteExecutive(item.id);
    assert.deepEqual(store.state().executives, []);
    assert.deepEqual(await readdir(join(directory, 'originals')), []);
    store.close();
    store = createStore(directory);
    assert.deepEqual(store.state().executives, []);
    const fresh = store.addExecutive({ name: 'Fresh executive', role: 'CEO', ownerId: 'alex' });
    assert.equal(store.state().executives[0].id, fresh.id);
  } finally { store.close(); }
});

test('each executive has a persistent soul file; existing databases are backfilled without overwriting edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-executive-souls-'));
  let store;
  try {
    store = createStore(directory);
    const seededPath = join(directory, 'executives', context.executiveId, 'soul.md');
    assert.equal(await readFile(seededPath, 'utf8'), DEFAULT_SOUL);
    const other = store.addExecutive({ name: 'Other', role: 'CFO', ownerId: 'jordan' });
    const otherPath = join(directory, 'executives', other.id, 'soul.md');
    assert.equal(await readFile(otherPath, 'utf8'), DEFAULT_SOUL);
    const custom = '# Other soul\nUse brief, skeptical recommendations.\n';
    store.saveSoul(other.id, custom);
    assert.equal(await readFile(otherPath, 'utf8'), custom);
    assert.equal(store.soul(context.executiveId).content, DEFAULT_SOUL);
    store.close();
    store = undefined;
    await rm(seededPath);
    store = createStore(directory);
    assert.equal(store.soul(context.executiveId).content, DEFAULT_SOUL);
    assert.equal(store.soul(other.id).content, custom);
    assert.equal(ownExecutives(store.state().executives).length, 2);
    await writeFile(otherPath, '# Edited on disk\nBe concise.\n');
    assert.equal(store.soul(other.id).content, '# Edited on disk\nBe concise.\n');
    assert.deepEqual(await readdir(join(directory, 'executives', other.id)), ['memory', 'memory.md', 'soul.md']);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('soul API validates edits and executive IDs and does not expose files as static assets', async t => {
  const { request, base } = await fixture(t);
  const route = `executives/${context.executiveId}/soul`;
  assert.equal((await request('state')).body.soul.maxCharacters, SOUL_LIMIT);
  assert.equal((await request(route)).body.content, DEFAULT_SOUL);
  for (const content of ['', ' ', null, 123, 'x'.repeat(SOUL_LIMIT + 1), 'binary\0text']) {
    assert.equal((await request(route, 'POST', { content })).status, 400);
    assert.equal((await request(route)).body.content, DEFAULT_SOUL);
  }
  const boundary = 'x'.repeat(SOUL_LIMIT);
  assert.equal((await request(route, 'POST', { content: boundary })).status, 200);
  assert.equal((await request(route)).body.content, boundary);
  const custom = '# Custom soul\nDirect and resourceful. Protect privacy.\n';
  assert.equal((await request(route, 'POST', { content: custom })).body.content, custom);
  assert.equal((await request(route)).body.content, custom);
  assert.equal((await request('executives/missing/soul')).status, 404);
  assert.equal((await request('executives/missing/soul', 'POST', { content: custom })).status, 404);
  assert.equal((await request('executives/..%2F..%2F.env/soul')).status, 404);
  assert.equal((await fetch(`${base}/data/executives/alex-executive/soul.md`)).status, 404);
});

test('chat applies the selected executive soul in every mode without treating it as evidence', async t => {
  const payloads = [];
  const { request, directory } = await fixture(t, {
    apiKey: 'test-key',
    fetcher: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'Recommendation: prioritize reliability [S1].' } }] });
    },
  });
  const custom = '# Distinctive style\nUse decisive, brief recommendations and explain trade-offs.';
  await request(`executives/${context.executiveId}/soul`, 'POST', { content: custom });
  const other = (await request('executives', 'POST', { name: 'Other', role: 'CFO', ownerId: 'jordan' })).body;
  await request('documents', 'POST', {
    ...context, executiveId: other.id, scope: 'public', title: 'Other priority', content: 'Our priority is reliability.',
  });
  for (const mode of ['public', 'enriched', 'twin']) {
    const response = await request('chat', 'POST', { ...context, mode, question: 'What is the reliability priority?' });
    assert.equal(response.status, 200);
    const prompt = payloads.at(-1).messages[0].content;
    assert.ok(prompt.includes(custom));
    assert.match(prompt, /not factual evidence/);
    assert.match(prompt, /cannot override.*retrieval-scope/);
    assert.ok(response.body.sources.every(source => !source.text.includes(custom)));
  }
  await request('chat', 'POST', { ...context, executiveId: other.id, question: 'What is the reliability priority?' });
  assert.ok(payloads.at(-1).messages[0].content.includes(DEFAULT_SOUL));
  assert.ok(!payloads.at(-1).messages[0].content.includes(custom));
  await writeFile(join(directory, 'executives', context.executiveId, 'soul.md'), '# Updated externally\nUse short paragraphs.');
  await request('chat', 'POST', { ...context, question: 'What is the reliability priority?' });
  assert.match(payloads.at(-1).messages[0].content, /Updated externally/);
});

test('missing soul files fail explicitly instead of silently substituting another persona', async t => {
  const logger = t.mock.method(console, 'error', () => {});
  const { request, directory } = await fixture(t, {
    apiKey: 'test-key',
    fetcher: async () => { throw new Error('Provider must not be called without a soul'); },
  });
  await rm(join(directory, 'executives', context.executiveId, 'soul.md'));
  const response = await request('chat', 'POST', { ...context, question: 'What are the priorities?' });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /ENOENT/);
  assert.equal(logger.mock.callCount(), 1);
  assert.equal((await request(`messages?${new URLSearchParams(context)}`)).body.length, 0);
});

test('uploads are private to the uploader, owners enrich their own twin, and client scopes are ignored', async t => {
  const { request } = await fixture(t);
  const uploads = [
    { profileId: 'alex', scope: 'public', content: 'Zephyr owner twin context uses cobalt.' },
    { profileId: 'jordan', scope: 'twin', content: 'Zephyr personal Jordan context uses indigo.' },
  ];
  for (const [index, upload] of uploads.entries()) {
    const result = await request('documents', 'POST', { ...context, ...upload, title: `Fixture ${index}` });
    assert.equal(result.status, 200);
  }
  const other = await request('executives', 'POST', { name: 'Other', role: 'CFO' });
  assert.equal(other.body.owner_id, other.body.id);
  assert.ok((await request('state')).body.profiles.some(profile => profile.id === other.body.id && profile.name === 'Other'));
  await request('documents', 'POST', {
    ...context, executiveId: other.body.id, title: 'Other executive', content: 'Zephyr other executive uses scarlet.',
  });
  for (const [mode, profileId, scopes, included] of [
    ['twin', 'alex', ['twin'], 'cobalt'],
    ['enriched', 'jordan', ['enriched'], 'indigo'],
    ['twin', 'jordan', ['enriched'], 'indigo'],
    ['enriched', other.body.id, [], null],
  ]) {
    const result = await request('chat', 'POST', { ...context, mode, profileId, question: 'Zephyr?' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.sources.map(source => source.scope).sort(), scopes);
    const evidence = result.body.sources.map(source => source.text).join(' ');
    for (const word of ['cobalt', 'indigo', 'scarlet']) assert.equal(evidence.includes(word), word === included);
  }
  const publicView = await request('chat', 'POST', { ...context, mode: 'public', question: 'Zephyr?' });
  assert.equal(publicView.body.engine, 'no-evidence');
});

test('AI-extracted general knowledge becomes a public source that follows its private source', async t => {
  const generalized = [];
  const { request } = await fixture(t, {
    apiKey: 'test-key',
    generalizer: async ({ document }) => { generalized.push(document.id); return '- Reliability builds customer trust.'; },
    fetcher: async () => Response.json({ choices: [{ message: { content: '{"findings":[]}' } }] }),
  });
  const upload = await request('documents', 'POST', { ...context, profileId: 'jordan', title: 'Private notes',
    content: 'Project Falcon ships on March 3. Reliability builds customer trust.' });
  assert.equal(upload.status, 200);
  let publicSource;
  for (let attempt = 0; attempt < 50 && !publicSource; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    const documents = (await request(`documents?${new URLSearchParams({ ...context, mode: 'public' })}`)).body;
    publicSource = documents.find(document => document.derivedFrom === upload.body.id);
  }
  assert.deepEqual(generalized, [upload.body.id]);
  assert.equal(publicSource.scope, 'public');
  assert.equal(publicSource.title, 'General knowledge: Private notes');
  const content = (await request(`documents/${publicSource.id}`)).body.content;
  assert.match(content, /Reliability builds customer trust/);
  assert.doesNotMatch(content, /Falcon|March/);
  const alexView = (await request(`documents?${new URLSearchParams({ ...context, mode: 'twin' })}`)).body;
  assert.ok(alexView.some(document => document.id === publicSource.id));
  assert.ok(!alexView.some(document => document.id === upload.body.id));
  assert.equal((await request(`documents/${upload.body.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`documents/${publicSource.id}`)).status, 404);
});

test('history is scoped; deleting documents removes future retrieval but preserves labeled historical excerpts', async t => {
  const { request } = await fixture(t);
  const document = await request('documents', 'POST', {
    ...context, scope: 'enriched', title: 'Budget discussion', content: 'The albatross budget is 42 million.',
  });
  const enriched = { ...context, mode: 'enriched' };
  await request('chat', 'POST', { ...enriched, question: 'albatross budget?' });
  const history = await request(`messages?${new URLSearchParams(enriched)}`);
  assert.equal(history.body.length, 2);
  assert.equal(history.body[1].sources[0].title, 'Budget discussion');
  assert.equal((await request(`messages?${new URLSearchParams(context)}`)).body.length, 0);
  assert.equal((await request(`messages?${new URLSearchParams({ ...enriched, profileId: 'jordan' })}`)).body.length, 0);
  assert.equal((await request(`documents/${document.body.id}`, 'DELETE')).status, 200);
  const answer = await request('chat', 'POST', { ...enriched, question: 'albatross budget?' });
  assert.equal(answer.body.engine, 'no-evidence');
  assert.deepEqual(answer.body.sources, []);
});

test('state, uploads, chunks and messages persist when the store is reopened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ultimate-executive-persistence-'));
  let store;
  try {
    store = createStore(directory);
    const profile = store.addProfile('Taylor');
    const executive = store.addExecutive({ name: 'Taylor', role: 'CTO', bio: 'Test' });
    const scope = { executiveId: executive.id, profileId: profile.id, mode: 'enriched' };
    const content = `${'filler '.repeat(400)} rarekeyword persistent evidence`;
    store.insertDocument({ ...scope, scope: 'enriched', title: 'Persistent source', content });
    store.saveExchange(scope, 'rarekeyword?', { content: 'Saved answer', sources: [], engine: 'extractive' });
    store.close();
    store = createStore(directory);
    assert.equal(store.state().profiles.length, 4 + PREDEFINED_EXECUTIVES.length);
    assert.equal(store.visibleDocuments(scope).length, 1);
    assert.ok(store.retrieve(scope, 'rarekeyword')[0].text.includes('persistent evidence'));
    assert.equal(store.history(scope)[1].content, 'Saved answer');
    assert.equal(ownExecutives(store.state().executives).length, 2);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid inputs return explicit errors; static assets load and traversal is not served', async t => {
  const { request, base } = await fixture(t);
  const state = await request('state');
  assert.equal(state.body.aiConfigured, false);
  assert.equal((await request('profiles', 'POST', { name: ' ' })).status, 400);
  assert.equal((await request('chat', 'POST', { ...context, mode: 'bad', question: 'test' })).status, 400);
  assert.equal((await request('chat', 'POST', { ...context, question: '' })).status, 400);
  assert.equal((await request('documents', 'POST', { ...context, profileId: 'missing', title: 'Test', content: 'Test' })).status, 404);
  assert.equal((await request('documents', 'POST', { ...context, scope: 'public', title: 'Test', content: 'a'.repeat(200001) })).status, 400);
  assert.equal((await request('documents', 'POST', { ...context, scope: 'public', title: 'Test', content: 'abc\0' })).status, 400);
  assert.equal((await request('documents/missing', 'DELETE')).status, 404);
  const malformed = await fetch(`${base}/api/profiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  const tooLarge = await fetch(`${base}/api/profiles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1_000_001),
  });
  assert.equal(tooLarge.status, 413);
  for (const asset of ['/', '/app.js', '/style.css']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-security-policy').includes("default-src 'self'"));
  }
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/lib/store.js`)).status, 404);
});

test('AI request uses scoped evidence, citations and intent history without old assistant evidence', async () => {
  let payload;
  const source = { label: 'S1', title: 'Strategy', text: 'Focus on reliability.', scope: 'public' };
  const answer = await answerQuestion({
    executive: { name: 'Alex', role: 'CEO', bio: 'Fictional' },
    question: 'What is the focus?', sources: [source], apiKey: 'test-key', model: 'test-model',
    history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'DELETED_EVIDENCE' }],
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      payload = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: 'Focus on reliability [S1].' } }] });
    },
  });
  assert.equal(answer.engine, 'openai');
  assert.equal(payload.model, 'test-model');
  assert.ok(payload.messages.at(-2).content.includes('[S1] Strategy'));
  assert.ok(!JSON.stringify(payload).includes('DELETED_EVIDENCE'));
  assert.equal(payload.messages.at(-1).content, 'What is the focus?');
  assert.match(payload.messages[0].content, /Answer only the latest user question/);
  assert.match(payload.messages[0].content, /clear, natural language rather than dumping retrieved excerpts/);
  assert.match(payload.messages[0].content, /clickable source-document links below the answer/);
  assert.match(payload.messages[0].content, /only when it adds concrete value/);
  assert.match(payload.messages[0].content, /answer it independently/);
  assert.equal(payload.messages.length, 4);
  assert.match(payload.messages[1].content, /optional context only/);
  assert.match(payload.messages[1].content, /Earlier question/);
  assert.deepEqual(answer.sources, [source]);
});

test('the system prompt is a stable cacheable prefix; per-question content comes after it', async () => {
  const executive = { id: 'cfo', name: 'Alex', role: 'CFO', bio: 'Fictional' };
  const first = chatMessages({ executive, soul: 'Calm.', question: 'Budget?', history: [],
    sources: [{ label: 'S1', title: 'Plan', text: 'SOURCE_TEXT_ONE' }] });
  const second = chatMessages({ executive, soul: 'Calm.', question: 'Hiring?', history: [{ role: 'user', content: 'Earlier' }],
    sources: [], pastMemories: [{ date: '2026-11-01', kind: 'decision', speaker: 'user', topic: 'launch', content: 'MEMORY_TEXT' }] });
  assert.equal(first[0].content, second[0].content);
  assert.ok(!/SOURCE_TEXT_ONE|MEMORY_TEXT/.test(first[0].content));
  assert.match(first.at(-2).content, /^RETRIEVED CONTEXT[^]*Relevant evidence is available[^]*SOURCE_TEXT_ONE/);
  assert.match(second.at(-2).content, /No relevant source evidence[^]*<conversation-memory>[^]*MEMORY_TEXT/);
  // Rules shared by every executive come before anything executive-specific.
  const other = chatMessages({ executive: { ...executive, name: 'Sam' }, soul: 'Calm.', question: 'Budget?', history: [], sources: [] });
  const shared = first[0].content.indexOf('\n<executive-profile>\n');
  // Comfortably above the 1,024-token minimum for automatic prefix caching.
  assert.ok(shared > 5000);
  assert.equal(other[0].content.slice(0, shared), first[0].content.slice(0, shared));

  const bodies = [];
  const fetcher = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: 'Answer.' } }], usage: { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1536 } } });
  };
  const input = { executive, question: 'Budget?', sources: [], history: [], apiKey: 'key', model: 'model', fetcher };
  const answer = await answerQuestion({ ...input, provider: providerConfig({ OPENAI_API_KEY: 'key' }) });
  assert.deepEqual(answer.usage, { promptTokens: 2000, cachedTokens: 1536 });
  await answerQuestion({ ...input, provider: providerConfig({ AI_PROVIDER: 'llm-farm', MODEL_FARM_API_KEY: 'key', AI_MODEL: 'model',
    AI_CHAT_URL: 'https://aoai-farm.bosch-temp.com/api/openai/deployments/model/chat/completions' }) });
  assert.equal(bodies[0].prompt_cache_key, 'executive-cfo');
  assert.equal(bodies[1].prompt_cache_key, undefined);
  assert.equal(promptUsage({ prompt_tokens: 900 }).cachedTokens, null);
});

test('setup status reports the prompt cache hit rate the provider returns', async t => {
  const { request } = await fixture(t, {
    apiKey: 'test-key',
    fetcher: async () => Response.json({ choices: [{ message: { content: 'Answer.' } }],
      usage: { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1000 } } }),
  });
  for (let index = 0; index < 2; index++) {
    const response = await request('chat', 'POST', { ...context, question: 'What is 17 times 23?' });
    assert.equal(response.status, 200);
    assert.equal(response.body.usage, undefined);
  }
  const cache = (await request('setup')).body.checks.find(item => item.id === 'prompt-cache');
  assert.match(cache.summary, /^50% of prompt tokens/);
  assert.ok(cache.details.some(line => line.includes('2 answer(s), 4,000 prompt tokens, 2,000 cached')));
});

test('historical questions are bounded optional context and the current request remains separate', async () => {
  for (const history of [[], Array.from({ length: 8 }, (_, index) => ({ role: 'user', content: `Previous question ${index}` }))]) {
    await answerQuestion({
      executive: { name: 'Fictional', role: 'CEO', bio: '' }, question: 'What is 17 times 23?',
      sources: [], apiKey: 'synthetic-key', model: 'test-model', history,
      fetcher: async (_url, options) => {
        const messages = JSON.parse(options.body).messages;
        assert.equal(messages.at(-1).content, 'What is 17 times 23?');
        assert.equal(messages.length, history.length ? 4 : 3);
        if (history.length) {
          assert.ok(!messages[1].content.includes('Previous question 1'));
          assert.ok(messages[1].content.includes('Previous question 2'));
          assert.ok(messages[1].content.includes('Previous question 7'));
        }
        return Response.json({ choices: [{ message: { content: '391.' } }] });
      },
    });
  }
});

test('AI failures are errors, never success-shaped preview fallbacks', async () => {
  const input = {
    executive: { name: 'Alex', role: 'CEO', bio: '' }, question: 'Priorities?',
    sources: [{ label: 'S1', text: 'Reliability' }], history: [], apiKey: 'test', model: 'test',
  };
  await assert.rejects(answerQuestion({
    ...input, fetcher: async () => new Response('', { status: 401 }),
  }), /HTTP 401/);
  await assert.rejects(answerQuestion({
    ...input, fetcher: async () => Response.json({ choices: [] }),
  }), /empty answer/);
  await assert.rejects(answerQuestion({
    ...input, fetcher: async () => { throw new Error('Network failed'); },
  }), /Network failed/);
  const answer = await answerQuestion({
    ...input, sources: [], apiKey: '', fetcher: async () => { throw new Error('Should not call'); },
  });
  assert.equal(answer.engine, 'no-evidence');
});

test('new executives can chat immediately in every mode from their role, background and soul', async t => {
  const payloads = [];
  const { request } = await fixture(t, {
    apiKey: 'test-key',
    fetcher: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return Response.json({ choices: [{ message: { content: 'My recommendation: review cash flow and risk before making commitments.' } }] });
    },
  });
  const executive = (await request('executives', 'POST', {
    name: 'Fictional Finance Executive', role: 'Chief Financial Officer', ownerId: 'alex',
    bio: 'A pragmatic finance leader focused on sustainable growth.',
  })).body;
  for (const mode of ['public', 'enriched', 'twin']) {
    const scope = { ...context, executiveId: executive.id, mode };
    assert.deepEqual((await request(`documents?${new URLSearchParams(scope)}`)).body, []);
    const response = await request('chat', 'POST', {
      ...scope, question: 'How would you approach your first 90 days?',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.engine, 'openai-general');
    assert.deepEqual(response.body.sources, []);
    assert.match(response.body.content, /^General LLM knowledge - not documented views/);
    assert.match(response.body.content, /cash flow/);
    const prompt = payloads.at(-1).messages[0].content;
    assert.match(prompt, /Chief Financial Officer/);
    assert.match(prompt, /sustainable growth/);
    assert.ok(prompt.includes(DEFAULT_SOUL));
    assert.match(payloads.at(-1).messages.at(-2).content, /No relevant source evidence is available/);
    assert.match(prompt, /Do not include source citations/);
    assert.match(prompt, /Never invent memories/);
    const history = (await request(`messages?${new URLSearchParams(scope)}`)).body;
    assert.equal(history[1].engine, 'openai-general');
    assert.equal(history[1].content, response.body.content);
  }
});

test('general questions use the selected LLM and partial RAG evidence takes priority without blocking gaps', async () => {
  for (const sources of [[], [{ label: 'S1', title: 'Local convention', text: 'For our workshop, the boiling point example uses 95 degrees Celsius at local altitude.' }]]) {
    let prompt;
    const answer = await answerQuestion({
      executive: { name: 'Fictional CFO', role: 'CFO', bio: '' },
      question: 'Explain boiling water and why altitude matters.',
      sources, history: [], apiKey: 'synthetic-key', model: 'selected-model',
      fetcher: async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, 'selected-model');
        prompt = payload.messages[0].content;
        return Response.json({ choices: [{ message: { content: sources.length
          ? 'The workshop uses 95 degrees Celsius [S1]. General knowledge: lower pressure lowers the boiling point.'
          : 'Water boils when its vapor pressure equals external pressure.' } }] });
      },
    });
    assert.match(prompt, /including topics outside the executive's professional role/);
    assert.match(prompt, /Prioritize relevant retrieved RAG evidence over general model knowledge/);
    assert.match(prompt, /even when some sources were retrieved/);
    assert.match(prompt, /explain the discrepancy/);
    assert.match(prompt, /cite only source-backed claims/);
    assert.deepEqual(answer.sources, sources);
    assert.equal(answer.engine, sources.length ? 'openai' : 'openai-general');
    if (sources.length) {
      assert.match(answer.content, /95 degrees Celsius \[S1\]/);
      assert.match(answer.content, /General knowledge/);
    } else {
      assert.match(answer.content, /^General LLM knowledge/);
      assert.ok(!answer.content.includes('[S1]'));
    }
  }
});

test('role-based chat does not resurrect deleted evidence or hide provider errors', async t => {
  let fail = false;
  let payload;
  const logger = t.mock.method(console, 'error', () => {});
  const { request } = await fixture(t, {
    apiKey: 'test-key',
    generalizer: async () => '',
    fetcher: async (_url, options) => {
      payload = JSON.parse(options.body);
      if (payload.messages[0].content.startsWith('Organize RAG evidence')) {
        return Response.json({ choices: [{ message: { content: '{"findings":[]}' } }] });
      }
      if (fail) return new Response('', { status: 429 });
      return Response.json({ choices: [{ message: { content: 'DELETED_PRIVATE_EVIDENCE [S1]' } }] });
    },
  });
  const doc = await request('documents', 'POST', {
    ...context, scope: 'enriched', title: 'Private fixture', content: 'The albatross budget is 42 million.',
  });
  const scope = { ...context, mode: 'enriched' };
  await request('chat', 'POST', { ...scope, question: 'albatross budget?' });
  await request(`documents/${doc.body.id}`, 'DELETE');
  fail = true;
  const response = await request('chat', 'POST', { ...scope, question: 'albatross budget?' });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /429/);
  assert.ok(!JSON.stringify(payload).includes('DELETED_PRIVATE_EVIDENCE'));
  assert.ok(!JSON.stringify(payload).includes('42 million'));
  assert.match(payload.messages.at(-2).content, /No relevant source evidence/);
  assert.equal((await request(`messages?${new URLSearchParams(scope)}`)).body.length, 2);
  assert.equal(logger.mock.callCount(), 1);
});

test('configured AI chat is wired through HTTP and persists the generated answer', async t => {
  let called = false;
  const { request } = await fixture(t, {
    apiKey: 'test-key',
    model: 'test-model',
    fetcher: async (_url, options) => {
      called = true;
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'test-model');
      assert.ok(payload.messages.at(-2).content.includes('customer onboarding'));
      return Response.json({ choices: [{ message: { content: 'Prioritize reliability and onboarding [S1].' } }] });
    },
  });
  assert.equal((await request('state')).body.aiConfigured, true);
  const response = await request('chat', 'POST', { ...context, question: 'What are the priorities this quarter?' });
  assert.equal(response.status, 200);
  assert.equal(called, true);
  assert.equal(response.body.engine, 'openai');
  assert.equal(response.body.sources[0].label, 'S1');
  const history = await request(`messages?${new URLSearchParams(context)}`);
  assert.equal(history.body[1].content, 'Prioritize reliability and onboarding [S1].');
});

test('provider failures surface through HTTP and do not save a successful exchange', async t => {
  const logger = t.mock.method(console, 'error', () => {});
  const { request } = await fixture(t, {
    apiKey: 'test-key',
    fetcher: async () => new Response('', { status: 429 }),
  });
  const response = await request('chat', 'POST', { ...context, question: 'What are the priorities this quarter?' });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /HTTP 429/);
  assert.equal(logger.mock.callCount(), 1);
  const history = await request(`messages?${new URLSearchParams(context)}`);
  assert.equal(history.body.length, 0);
});
