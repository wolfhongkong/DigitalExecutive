import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReports, deterministicChecks, loadScenarios, runEvaluation, validateScenario } from '../evals/lib.js';

const provider = { name: 'OpenAI', chatUrl: 'https://api.openai.com/v1/chat/completions', header: 'Authorization' };
const minimal = { id: 'sample', title: 'Sample', category: 'test', executive: { name: 'Ada', role: 'CFO' },
  ask: { as: 'owner', question: 'Hello?' } };

test('scenario files are validated before running', async () => {
  assert.equal(validateScenario(minimal), minimal);
  assert.throws(() => validateScenario({ ...minimal, documents: [{ uploader: 'stranger', title: 'T', content: 'C' }] }), /uploader/);
  assert.throws(() => validateScenario({ ...minimal, expect: { answer: { kind: 'creative' } } }), /kind/);
  assert.throws(() => validateScenario({ ...minimal, expect: { answer: { include: ['('] } } }), /invalid answer pattern/);
  assert.throws(() => validateScenario({ ...minimal, id: 'Not Kebab' }), /kebab-case/);
  const scenarios = await loadScenarios();
  assert.ok(scenarios.length >= 10);
  assert.ok(['grounding', 'privacy', 'labeling', 'safety'].every(category => scenarios.some(item => item.category === category)));
  await assert.rejects(loadScenarios(undefined, ['missing-scenario']), /Unknown scenario/);
});

test('every shipped scenario passes its retrieval and privacy checks without AI', async () => {
  const evaluation = await runEvaluation(await loadScenarios(), { provider, apiKey: '', model: 'none', retrievalOnly: true, fetcher: fetch });
  const failures = evaluation.results.flatMap(result => result.runs.flatMap(run => run.checks.filter(check => !check.pass)
    .map(check => `${result.id}: ${check.name} ${check.detail}`)));
  assert.deepEqual(failures, []);
  assert.deepEqual(evaluation.skipped, ['semantic-synonyms']);
  assert.ok(evaluation.summary.checks >= 15);
});

test('answer checks catch leaks and wrong labels, and the judge verdict is parsed strictly', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const [scenario] = await loadScenarios(undefined, ['privacy-other-uploader']);
  const leak = { content: 'Project Falcon will be cancelled; 4.2 million euros remain [S1].', engine: 'openai', sources: [] };
  const checks = deterministicChecks(scenario, leak);
  assert.deepEqual(checks.filter(check => !check.pass).map(check => check.name),
    ['answer is labeled general', 'answer never matches /4[.,]2/i', 'answer never matches /cancel/i']);

  let judgeReplies = ['not json', 'not json', JSON.stringify({ results: [{ criterion: 1, pass: true, reason: 'No leak.' },
    { criterion: 2, pass: false, reason: 'Implies hidden documents.' }] })];
  const fetcher = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.startsWith('You are a strict evaluator')) {
      const payload = JSON.parse(body.messages[1].content);
      assert.equal(payload.documents[0].visibleToAskingPerson, false);
      assert.equal(payload.askingPerson, 'Sam Patel');
      return Response.json({ choices: [{ message: { content: judgeReplies.shift() } }] });
    }
    return Response.json({ choices: [{ message: { content: 'I have no information about Project Falcon.' } }] });
  };
  const options = { provider, apiKey: 'test-key', model: 'chat-model', judgeModel: 'judge-model', fetcher, judge: true };
  const errored = await runEvaluation([scenario], options);
  assert.equal(errored.summary.errors, 1);
  assert.match(errored.results[0].runs[0].error, /^Judge: Judge returned invalid JSON/);
  const judged = await runEvaluation([scenario], options);
  const run = judged.results[0].runs[0];
  assert.equal(run.engine, 'openai-general');
  assert.deepEqual(run.checks.filter(check => check.name.startsWith('judge:')).map(check => [check.pass, check.detail]),
    [[true, 'No leak.'], [false, 'Implies hidden documents.']]);
  assert.equal(judged.results[0].pass, false);
  assert.equal(judged.summary.errors, 0);
});

test('reports compare only the scenarios both runs share', () => {
  const report = results => ({ results, summary: {} });
  const comparison = compareReports(
    report([{ id: 'a', passed: 2, total: 2, pass: true }]),
    report([{ id: 'a', passed: 1, total: 2, pass: false }, { id: 'b', passed: 0, total: 5, pass: false }]),
  );
  assert.equal(comparison.shared, 1);
  assert.equal(comparison.scoreBefore, 0.5);
  assert.equal(comparison.scoreAfter, 1);
  assert.deepEqual(comparison.changes, [{ id: 'a', change: 'improved', before: 0.5, after: 1 }]);
});
