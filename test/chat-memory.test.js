import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { extractChatMemories } from '../lib/chat-memory.js';
import { createApp } from '../server.js';

const context = { executiveId: 'alex-executive', profileId: 'alex', mode: 'public' };
const completion = memories => Response.json({ choices: [{ finish_reason: 'stop',
  message: { content: JSON.stringify({ memories }) } }] });

test('conversation memories must quote the speaker they are attributed to', async t => {
  t.mock.method(console, 'warn', () => {});
  const input = {
    executive: { name: 'Alex', role: 'CEO' }, apiKey: 'test-key', model: 'test-model',
    question: 'We decided to pause hiring until March.', answer: 'Keep one recruiter on retainer.',
  };
  const memories = await extractChatMemories({ ...input, fetcher: async () => completion([
    { kind: 'decision', topic: 'Hiring Pause', content: 'Hiring paused until March.', evidence: 'decided to pause  hiring' },
    { kind: 'advice', topic: 'recruiting', content: 'Keep a recruiter.', evidence: 'Keep one recruiter on retainer.' },
    { kind: 'decision', topic: 'recruiting', content: 'Attributed AI advice to the user.', evidence: 'Keep one recruiter on retainer.' },
    { kind: 'advice', topic: 'budget', content: 'Invented advice.', evidence: 'Cut the budget by half.' },
  ]) });
  assert.deepEqual(memories, [
    { kind: 'decision', topic: 'hiring pause', content: 'Hiring paused until March.', evidence: 'decided to pause hiring', speaker: 'user' },
    { kind: 'advice', topic: 'recruiting', content: 'Keep a recruiter.', evidence: 'Keep one recruiter on retainer.', speaker: 'executive' },
  ]);
  await assert.rejects(extractChatMemories({ ...input, fetcher: async () => completion([
    { kind: 'trait', topic: 'tone', content: 'Direct.', evidence: 'Keep one recruiter on retainer.' }]) }), /invalid kind/);
  await assert.rejects(extractChatMemories({ ...input, fetcher: async () => Response.json({ choices: [{ message: { content: 'not json' } }] }) }),
    /invalid JSON/);
});

test('chat exchanges become private episodic memory that informs later chats until superseded or forgotten', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-memory-'));
  const prompts = [];
  const extractions = [
    [
      { kind: 'decision', topic: 'Berlin launch timing', content: 'Berlin launch delayed to Q3.', evidence: 'We decided to delay the Berlin launch to Q3.' },
      { kind: 'advice', topic: 'board update', content: 'Share a revised timeline with the board.', evidence: 'Share a revised timeline by Friday.' },
    ],
    [{ kind: 'decision', topic: 'berlin launch timing', content: 'Berlin launch moved back to Q2.', evidence: 'We now launch Berlin in Q2 after all.' }],
    'invalid',
  ];
  const app = createApp({
    directory, apiKey: 'test-key', model: 'test-model', chatMemory: true, generalizer: async () => '',
    fetcher: async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (payload.messages[0].content.startsWith('Maintain episodic conversation memory')) {
        const next = extractions.shift();
        return next === 'invalid' ? Response.json({ choices: [{ message: { content: 'not json' } }] }) : completion(next);
      }
      prompts.push(payload.messages.slice(0, -1).map(message => message.content).join('\n'));
      return Response.json({ choices: [{ message: { content: 'Tell the board the delay protects reliability. Share a revised timeline by Friday.' } }] });
    },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}/api`;
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}/${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const memoryPath = (scope = context) => `executives/${scope.executiveId}/chat-memory?${new URLSearchParams(scope)}`;
  async function settled(scope = context) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = (await call(memoryPath(scope))).body;
      if (!result.pending) return result;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Conversation memory did not finish in time.');
  }
  assert.equal((await call('state')).body.chatMemory.enabled, true);
  const first = (await call('conversations', 'POST', context)).body;
  assert.equal((await call('chat', 'POST', { ...context, conversationId: first.id,
    question: 'We decided to delay the Berlin launch to Q3. What should we tell the board?' })).status, 200);
  assert.doesNotMatch(prompts.at(-1), /<conversation-memory>/);
  let memory = await settled();
  assert.equal(memory.error, null);
  assert.deepEqual(memory.entries.map(entry => [entry.kind, entry.speaker, entry.conversationId]).sort(),
    [['advice', 'executive', first.id], ['decision', 'user', first.id]]);
  assert.equal((await settled({ ...context, profileId: 'jordan' })).entries.length, 0);
  assert.equal((await settled({ ...context, mode: 'twin' })).entries.length, 0);
  const relationshipFile = join(directory, 'executives', context.executiveId, 'relationships', 'alex.md');
  let file = await readFile(relationshipFile, 'utf8');
  assert.equal(memory.relationship.path, 'executives/alex-executive/relationships/alex.md');
  assert.equal(memory.relationship.content, file);
  assert.match(file, /^# Alex Morgan and Alex Morgan: relationship memory/);
  assert.match(file, /## Public persona conversations[^]*### Decisions Alex Morgan stated\n\n- \d{4}-\d{2}-\d{2} \| berlin launch timing: Berlin launch delayed to Q3\.\n  Quote: "We decided to delay the Berlin launch to Q3\."/);
  assert.match(file, /### Advice Alex Morgan \(AI\) gave\n\n- .*board update: Share a revised timeline/);
  assert.deepEqual(await readdir(join(directory, 'executives', context.executiveId, 'relationships')), ['alex.md']);

  const second = (await call('conversations', 'POST', context)).body;
  await call('chat', 'POST', { ...context, conversationId: second.id, question: 'We now launch Berlin in Q2 after all. Does that change the plan?' });
  assert.match(prompts.at(-1), /<conversation-memory>[^]*decision \(stated by the user\) \| berlin launch timing: Berlin launch delayed to Q3\.[^]*<\/conversation-memory>/);
  assert.match(prompts.at(-1), /not source evidence/);
  memory = await settled();
  const decisions = memory.entries.filter(entry => entry.kind === 'decision');
  assert.deepEqual(decisions.map(entry => [entry.content, Boolean(entry.supersededBy)]),
    [['Berlin launch moved back to Q2.', false], ['Berlin launch delayed to Q3.', true]]);
  file = await readFile(relationshipFile, 'utf8');
  assert.match(file, /### Decisions Alex Morgan stated\n\n- .*moved back to Q2\.[^]*### Earlier, superseded\n\n- .*decision \| berlin launch timing: Berlin launch delayed to Q3\./);

  const logger = t.mock.method(console, 'error', () => {});
  assert.equal((await call('chat', 'POST', { ...context, conversationId: second.id, question: 'Anything else?' })).status, 200);
  assert.match(prompts.at(-1), /moved back to Q2/);
  assert.doesNotMatch(prompts.at(-1), /delayed to Q3/);
  memory = await settled();
  assert.match(memory.error, /invalid JSON/);
  assert.equal(memory.entries.length, 3);
  assert.equal(logger.mock.callCount(), 1);

  const advice = memory.entries.find(entry => entry.kind === 'advice');
  assert.equal((await call(`executives/${context.executiveId}/chat-memory/${advice.id}?${new URLSearchParams({ ...context, profileId: 'jordan' })}`, 'DELETE')).status, 404);
  assert.equal((await call(`executives/${context.executiveId}/chat-memory/${advice.id}?${new URLSearchParams(context)}`, 'DELETE')).status, 200);
  assert.equal((await call(`conversations/${first.id}?profileId=alex`, 'DELETE')).status, 200);
  assert.deepEqual((await settled()).entries.map(entry => entry.content), ['Berlin launch moved back to Q2.']);
  file = await readFile(relationshipFile, 'utf8');
  assert.doesNotMatch(file, /delayed to Q3|revised timeline/);
  await call(`executives/${context.executiveId}`, 'PATCH', { name: 'Alexandra Morgan' });
  assert.match(await readFile(relationshipFile, 'utf8'), /^# Alexandra Morgan and Alex Morgan: relationship memory/);
  assert.equal((await call(`conversations/${second.id}?profileId=alex`, 'DELETE')).status, 200);
  await assert.rejects(readFile(relationshipFile, 'utf8'), { code: 'ENOENT' });
  assert.equal((await settled()).relationship.content, '');
});
