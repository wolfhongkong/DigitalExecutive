import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { chatMessages } from '../lib/chat.js';
import { INTERVIEW_QUESTION_LIMIT, interviewCompany, normalizeCompanyProfile, renderCompanyProfile } from '../lib/company-profile.js';

const PROFILE = { name: 'Northwind', stage: 'Series A, 45 employees', burn: '400,000 EUR per month', priorities: ['Enter Germany', 'Raise Series B'] };

test('company profiles are validated, trimmed and rendered in a fixed order', () => {
  assert.deepEqual(normalizeCompanyProfile({ priorities: 'One\n\n Two ', name: '  Northwind  ', runway: '' }),
    { name: 'Northwind', priorities: ['One', 'Two'] });
  assert.throws(() => normalizeCompanyProfile({ ceo: 'x' }), /Unknown company profile field/);
  assert.throws(() => normalizeCompanyProfile({ name: 'x'.repeat(121) }), /at most 120/);
  assert.throws(() => normalizeCompanyProfile({ competitors: Array.from({ length: 11 }, (_, index) => `C${index}`) }), /at most 10 items/);
  // AI drafts are shortened instead of rejected; unknown keys are dropped.
  assert.equal(normalizeCompanyProfile({ name: 'x'.repeat(200), ceo: 'x' }, { strict: false }).name.length, 120);
  assert.equal(renderCompanyProfile({ priorities: ['Enter <Germany>'], name: 'Northwind' }),
    'Company name: Northwind\nStrategic priorities:\n- Enter Germany');
});

test('the company profile is part of the shared prompt prefix, before any executive-specific text', () => {
  const ask = executive => chatMessages({ executive, soul: 'Calm.', question: 'Runway?', history: [], sources: [], company: PROFILE });
  const cfo = ask({ name: 'Alex', role: 'CFO', bio: '' })[0].content;
  const cmo = ask({ name: 'Sam', role: 'CMO', bio: '' })[0].content;
  const end = cfo.indexOf('</company-profile>');
  assert.ok(end > 0 && end < cfo.indexOf('\n<executive-profile>\n'));
  assert.equal(cfo.slice(0, end), cmo.slice(0, end));
  assert.match(cfo, /<company-profile>\nCompany name: Northwind\nStage and size: Series A[^]*- Raise Series B\n<\/company-profile>/);
  assert.match(cfo, /attributing them to the company profile/);
  assert.doesNotMatch(ask({ name: 'Alex', role: 'CFO', bio: '' }).at(-2).content, /Northwind/);
  const empty = chatMessages({ executive: { name: 'Alex', role: 'CFO', bio: '' }, question: 'q', history: [], sources: [] })[0].content;
  assert.doesNotMatch(empty, /<company-profile>\n/);
});

test('the interview asks one question at a time, stops at the limit and drafts only stated facts', async () => {
  const requests = [];
  const reply = content => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
  let next = reply({ question: 'What is your monthly burn?' });
  const fetcher = async (_url, options) => { requests.push(JSON.parse(options.body)); return next; };
  const base = { apiKey: 'key', model: 'model', fetcher, current: { name: 'Northwind' } };
  const first = await interviewCompany({ ...base, messages: [{ role: 'user', content: 'We sell planning software.' }] });
  assert.deepEqual(first, { question: 'What is your monthly burn?', questionsAsked: 1, questionsLeft: INTERVIEW_QUESTION_LIMIT - 1 });
  assert.match(requests[0].messages[1].content, /"name":"Northwind"/);
  assert.match(requests[0].messages.at(-1).content, new RegExp(`${INTERVIEW_QUESTION_LIMIT} more question`));

  // At the question limit a draft is forced; a further question is rejected and retried once.
  const full = [{ role: 'user', content: 'Start.' }];
  for (let index = 0; index < INTERVIEW_QUESTION_LIMIT; index++) full.push({ role: 'assistant', content: `Q${index}` }, { role: 'user', content: `A${index}` });
  const replies = [reply({ question: 'One more?' }), reply({ profile: { name: 'Northwind', burn: '400k', ceo: 'Invented' } })];
  next = undefined;
  const draft = await interviewCompany({ ...base, messages: full, fetcher: async (_url, options) => {
    requests.push(JSON.parse(options.body)); return replies.shift();
  } });
  assert.deepEqual(draft, { draft: { name: 'Northwind', burn: '400k' }, questionsAsked: INTERVIEW_QUESTION_LIMIT });
  assert.match(requests.at(-2).messages.at(-1).content, /Draft the profile now/);
  assert.match(requests.at(-1).messages.at(-1).content, /Invalid reply/);

  await assert.rejects(interviewCompany({ ...base, messages: [{ role: 'assistant', content: 'Hi' }] }), /alternate/);
  await assert.rejects(interviewCompany({ ...base, messages: [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'Q' }] }), /Answer the last question/);
  await assert.rejects(interviewCompany({ ...base, apiKey: '', messages: [{ role: 'user', content: 'A' }] }), /configured AI provider/);
});

test('the company API saves, shares, clears and reports the profile, and chat sends it to the model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'company-profile-'));
  const prompts = [];
  const app = createApp({ directory, apiKey: 'key', chatMemory: false, generalizer: async () => '', fetcher: async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return Response.json({ choices: [{ message: { content: 'Answer.' } }] });
  } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const setupCheck = async () => (await call('setup')).body.checks.find(item => item.id === 'company');
  assert.equal((await setupCheck()).status, 'warn');
  assert.equal((await call('company', 'PATCH', { profileId: 'jordan', profile: { ceo: 'x' } })).status, 400);
  assert.equal((await call('company', 'PATCH', { profileId: 'nobody', profile: PROFILE })).status, 404);
  const saved = (await call('company', 'PATCH', { profileId: 'jordan', profile: PROFILE })).body;
  assert.deepEqual(saved.profile, PROFILE);
  assert.equal(saved.updatedByName, 'Jordan Lee');
  assert.equal((await call('state')).body.company.filled, 4);
  assert.match((await setupCheck()).summary, /^4 of 16 fields filled/);
  // Every executive and persona mode receives the same profile.
  for (const scope of [{ executiveId: 'alex-executive', profileId: 'alex', mode: 'public' },
    { executiveId: 'chief-financial-officer', profileId: 'jordan', mode: 'enriched' }]) {
    assert.equal((await call('chat', 'POST', { ...scope, question: 'What should we focus on?' })).status, 200);
    assert.match(prompts.at(-1), /Strategic priorities:\n- Enter Germany/);
  }
  const cleared = (await call(`company?profileId=alex`, 'DELETE')).body;
  assert.deepEqual(cleared.profile, {});
  await call('chat', 'POST', { executiveId: 'alex-executive', profileId: 'alex', mode: 'public', question: 'Focus?' });
  assert.doesNotMatch(prompts.at(-1), /Northwind/);
  assert.equal((await call('company/interview', 'POST', { profileId: 'alex', messages: [] })).status, 400);
});
