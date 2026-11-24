import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { providerConfig } from '../lib/provider.js';
import { semanticSearchConfig } from '../lib/embeddings.js';
import { ROOT, compareReports, loadScenarios, previousReport, runEvaluation, saveReport, versions } from './lib.js';

const HELP = `Usage: npm run eval -- [options]

  --scenario <id>     Run only this scenario (repeatable or comma-separated)
  --repeat <n>        Run each scenario n times to measure answer variance (default 1)
  --retrieval-only    Check retrieval and privacy scoping only; no AI requests
  --no-judge          Skip the LLM judge; keep deterministic answer checks
  --no-compare        Do not compare with the previous report of the same mode
  --strict            Exit with code 1 if any check fails
  --list              List scenarios and exit

Environment: the normal .env provider settings. EVAL_JUDGE_MODEL selects a different
judge model on the same provider (defaults to the chat model).`;

const { values } = parseArgs({ options: {
  scenario: { type: 'string', multiple: true, default: [] }, repeat: { type: 'string', default: '1' },
  'retrieval-only': { type: 'boolean', default: false }, 'no-judge': { type: 'boolean', default: false },
  'no-compare': { type: 'boolean', default: false }, strict: { type: 'boolean', default: false },
  list: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });

if (values.help) { console.log(HELP); process.exit(0); }
const scenarios = await loadScenarios(undefined, values.scenario.flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean));
if (values.list) {
  for (const scenario of scenarios) console.log(`${scenario.id.padEnd(32)} ${scenario.category.padEnd(12)} ${scenario.title}`);
  process.exit(0);
}
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('--repeat must be an integer from 1 to 20.');

const provider = providerConfig();
const retrievalOnly = values['retrieval-only'] || !provider.apiKey;
if (!retrievalOnly && provider.configurationError) throw new Error(provider.configurationError);
if (!values['retrieval-only'] && !provider.apiKey) console.log('No AI provider key configured: running retrieval-only checks.\n');
const judge = !retrievalOnly && !values['no-judge'];
const semanticSearch = semanticSearchConfig(provider, retrievalOnly ? '' : provider.apiKey);
const mode = retrievalOnly ? 'retrieval' : judge ? 'full' : 'answers';
const judgeModel = process.env.EVAL_JUDGE_MODEL || provider.model;
if (judge && judgeModel === provider.model) console.log(`Note: the judge uses the same model as the chat (${judgeModel}); set EVAL_JUDGE_MODEL for an independent judge.\n`);

const startedAt = new Date().toISOString();
const icon = pass => pass ? '✔' : '✖';
const evaluation = await runEvaluation(scenarios, {
  provider, apiKey: provider.apiKey, model: provider.model, judgeModel, fetcher: fetch, retrievalOnly, judge, repeat,
  semanticSearch: semanticSearch.enabled,
  onResult: result => {
    console.log(`${icon(result.pass)} ${result.id} (${result.passed}/${result.total}) ${result.title}`);
    for (const [index, run] of result.runs.entries()) {
      for (const check of run.checks.filter(item => !item.pass)) {
        console.log(`    ${repeat > 1 ? `run ${index + 1}: ` : ''}✖ ${check.name}${check.detail ? `\n        ${check.detail}` : ''}`);
      }
    }
  },
});
const report = { startedAt, mode, repeat, provider: provider.name, model: retrievalOnly ? null : provider.model,
  judgeModel: judge ? judgeModel : null, versions: await versions(), ...evaluation };
const { summary } = report;
console.log(`\n${summary.scenariosPassed}/${summary.scenarios} scenarios passed, ${summary.checksPassed}/${summary.checks} checks (score ${(summary.score * 100).toFixed(1)}%).`);
if (report.skipped.length) console.log(`Skipped without semantic search (${semanticSearch.reason || 'retrieval-only run'}): ${report.skipped.join(', ')}.`);
if (summary.errors) console.log(`${summary.errors} run(s) could not complete because of provider or network errors; they count as failures. Rerun those scenarios with --scenario.`);
console.log(`Versions: prompt ${report.versions.prompt}, retrieval ${report.versions.retrieval}, built-in knowledge ${report.versions.builtinKnowledge}.`);

const previous = values['no-compare'] ? null : await previousReport(mode);
const path = await saveReport(report);
if (previous) {
  const comparison = compareReports(report, previous.report);
  console.log(`\nCompared with ${relative(ROOT, previous.path)} on ${comparison.shared} shared scenario(s): score ${(comparison.scoreBefore * 100).toFixed(1)}% -> ${(comparison.scoreAfter * 100).toFixed(1)}%.`);
  for (const change of comparison.changes) {
    console.log(`  ${change.change.padEnd(9)} ${change.id}${change.before !== undefined ? ` ${(change.before * 100).toFixed(0)}% -> ${(change.after * 100).toFixed(0)}%` : ''}`);
  }
  if (!comparison.changes.length) console.log('  No scenario changed.');
}
console.log(`\nReport saved to ${relative(ROOT, path)}.`);
if (values.strict && summary.checksPassed < summary.checks) process.exitCode = 1;
