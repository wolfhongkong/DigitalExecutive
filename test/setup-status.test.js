import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setupStatus } from '../lib/setup-status.js';
import { providerConfig } from '../lib/provider.js';
import { semanticSearchConfig } from '../lib/embeddings.js';
import { voiceFingerprintConfig } from '../lib/voice-fingerprints.js';
import { createApp } from '../server.js';

const SECRET = 'sk-test-secret-value';
const runner = async (path, args) => ({ stdout: args[0] === '-version' ? `${path.includes('probe') ? 'ffprobe' : 'ffmpeg'} version 7.0 Copyright\n` : '3.12.1 1.0.3\n' });
const byId = result => Object.fromEntries(result.checks.map(item => [item.id, item]));

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'setup-status-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = overrides.env || {};
  const provider = providerConfig(env);
  return setupStatus({ env, provider, apiKey: provider.apiKey, model: provider.model, videoModel: provider.model,
    fingerprints: voiceFingerprintConfig({ VOICE_FINGERPRINTS: 'off' }), chatMemory: true, dreamConcurrency: 4,
    directory, startedAt: Date.now() + 60_000, builtinDocuments: 30, runner, envPath: join(directory, 'missing.env'),
    ffmpeg: process.execPath, ffprobePath: process.execPath, ...overrides });
}

test('setup status reports each part with green, amber or red lights and never exposes secrets', async t => {
  const unconfigured = byId(await setup(t));
  assert.equal(unconfigured.server.status, 'ok');
  assert.equal(unconfigured.ai.status, 'warn');
  assert.match(unconfigured.ai.summary, /source-preview mode/);
  assert.equal(unconfigured.transcription.status, 'warn');
  assert.equal(unconfigured.ffmpeg.status, 'ok');
  assert.match(unconfigured.ffmpeg.summary, /^ffmpeg version 7\.0/);
  assert.equal(unconfigured.voices.status, 'warn');
  assert.equal(unconfigured.storage.status === 'error', false);
  assert.equal(unconfigured.knowledge.status, 'ok');

  const misconfigured = byId(await setup(t, { env: { AI_PROVIDER: 'llm-farm', MODEL_FARM_API_KEY: SECRET } }));
  assert.equal(misconfigured.ai.status, 'error');
  assert.match(misconfigured.ai.action, /AI_CHAT_URL and AI_MODEL/);

  const whisperFarm = await setup(t, { env: { AI_PROVIDER: 'llm-farm', MODEL_FARM_API_KEY: SECRET, AI_MODEL: 'gpt-test',
    AI_CHAT_URL: 'https://aoai-farm.bosch-temp.com/api/openai/deployments/x/chat/completions?api-version=1' } });
  const farm = byId(whisperFarm);
  assert.equal(farm.ai.status, 'ok');
  assert.ok(farm.ai.details.includes('API key: set via MODEL_FARM_API_KEY (value hidden)'));
  assert.equal(farm.transcription.status, 'warn');
  assert.match(farm.transcription.action, /AI_TRANSCRIPTION_MODE=gemini/);
  assert.equal(farm.speakers.status, 'warn');
  assert.ok(!JSON.stringify(whisperFarm).includes(SECRET));

  const broken = await setup(t, {
    fingerprints: voiceFingerprintConfig({ VOICE_FINGERPRINT_PYTHON: '/missing/python' }),
    ffmpeg: '/missing/ffmpeg', startedAt: 0, builtinDocuments: 0,
  });
  const failures = byId(broken);
  assert.equal(broken.overall, 'error');
  assert.equal(failures.voices.status, 'error');
  assert.match(failures.voices.action, /npm run voices:setup/);
  assert.equal(failures.ffmpeg.status, 'error');
  assert.equal(failures.server.status, 'warn');
  assert.ok(failures.server.details.some(line => line === 'Changed since start: server.js'));
  assert.equal(failures.knowledge.status, 'warn');
});

test('live checks verify the provider and the Python voice libraries', async t => {
  const env = { OPENAI_API_KEY: SECRET };
  const python = join(await mkdtemp(join(tmpdir(), 'setup-python-')), 'python');
  t.after(() => rm(python, { force: true }));
  await writeFile(python, '');
  const models = join(tmpdir(), `setup-models-${process.pid}`);
  await mkdir(models, { recursive: true });
  await writeFile(join(models, 'hyperparams.yaml'), 'cached');
  t.after(() => rm(models, { recursive: true, force: true }));
  const fingerprints = voiceFingerprintConfig({ VOICE_FINGERPRINT_PYTHON: python });
  const requests = [];
  const ok = byId(await setup(t, { env: { ...env, VOICE_FINGERPRINT_MODEL_DIR: models }, fingerprints, live: true,
    fetcher: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return Response.json({ choices: [] }); } }));
  assert.equal(ok.ai.status, 'ok');
  assert.match(ok.ai.summary, /answered \(HTTP 200\)/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.max_completion_tokens, 16);
  assert.equal(ok.voices.status, 'ok');
  assert.ok(ok.voices.details.some(line => /Python 3\.12\.1 1\.0\.3/.test(line)));

  const rejected = byId(await setup(t, { env, fingerprints, live: true,
    fetcher: async () => new Response('', { status: 401 }),
    runner: async (path, args) => {
      if (args[0] === '-version') return runner(path, args);
      throw new Error("Command failed\nModuleNotFoundError: No module named 'speechbrain'");
    } }));
  assert.equal(rejected.ai.status, 'error');
  assert.match(rejected.ai.summary, /HTTP 401.*OPENAI_API_KEY/);
  assert.equal(rejected.voices.status, 'error');
  assert.ok(rejected.voices.details.includes("ModuleNotFoundError: No module named 'speechbrain'"));
  assert.equal(byId(await setup(t, { env, live: true, fetcher: async () => new Response('', { status: 429 }) })).ai.status, 'warn');
});

test('setup API runs free checks on GET and live checks only on POST', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'setup-api-'));
  let calls = 0;
  const provider = providerConfig({ OPENAI_API_KEY: SECRET });
  const app = createApp({ directory, provider, apiKey: SECRET, model: 'test-model', chatMemory: false,
    semanticSearch: semanticSearchConfig(provider, SECRET, {}),
    fingerprints: voiceFingerprintConfig({ VOICE_FINGERPRINTS: 'off' }), setupOptions: { runner },
    fetcher: async url => {
      calls++;
      return url === provider.embeddingUrl ? Response.json({ data: [{ index: 0, embedding: [1, 0] }] }) : Response.json({ choices: [] });
    } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}/api/setup`;
  const passive = await (await fetch(base)).json();
  assert.equal(passive.live, false);
  assert.equal(calls, 0);
  assert.ok(['ok', 'warn', 'error'].includes(passive.overall));
  assert.ok(passive.checks.every(item => ['ok', 'warn', 'error'].includes(item.status) && item.title && item.summary));
  const live = await (await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(live.live, true);
  // One tiny chat request and one tiny embeddings request.
  assert.equal(calls, 2);
  assert.equal(live.checks.find(item => item.id === 'semantic').status, 'ok');
  assert.ok(!JSON.stringify([passive, live]).includes(SECRET));
});
