import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, statSync, statfsSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';
import { providerHeaders } from './provider.js';
import { embedTexts } from './embeddings.js';

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RANK = { ok: 0, warn: 1, error: 2 };
const GB = 1024 ** 3;

const check = (id, title, status, summary, { details = [], action = '' } = {}) => ({ id, title, status, summary, details, action });

// Files whose changes only take effect after a server restart.
function serverFiles() {
  const files = [join(ROOT, 'server.js'), join(ROOT, 'package.json')];
  for (const name of readdirSync(join(ROOT, 'lib'))) if (name.endsWith('.js')) files.push(join(ROOT, 'lib', name));
  const knowledge = join(ROOT, 'knowledge', 'builtin');
  if (existsSync(knowledge)) {
    for (const domain of readdirSync(knowledge, { withFileTypes: true }).filter(item => item.isDirectory())) {
      for (const name of readdirSync(join(knowledge, domain.name))) files.push(join(knowledge, domain.name, name));
    }
  }
  return files;
}

function serverCheck({ startedAt, envPath }) {
  const major = Number(process.versions.node.split('.')[0]);
  const changed = serverFiles().filter(path => statSync(path).mtimeMs > startedAt)
    .map(path => path.slice(ROOT.length));
  const envChanged = existsSync(envPath) && statSync(envPath).mtimeMs > startedAt;
  const details = [`Node.js ${process.versions.node}`, `Running since ${new Date(startedAt).toISOString()}`];
  if (major < 24) {
    return check('server', 'Server', 'error', `Node.js ${process.versions.node} is too old; version 24 or newer is required.`,
      { details, action: 'Install Node.js 24+, then run npm install and npm start.' });
  }
  if (changed.length || envChanged) {
    return check('server', 'Server', 'warn', 'The server is running outdated code or configuration.', {
      details: [...details, ...changed.slice(0, 8).map(path => `Changed since start: ${path}`),
        ...(changed.length > 8 ? [`...and ${changed.length - 8} more files`] : []),
        ...(envChanged ? ['Changed since start: .env'] : [])],
      action: 'Stop the server with Ctrl+C, run npm start again, then refresh this page.',
    });
  }
  return check('server', 'Server', 'ok', 'Up to date with the code and .env on disk.', { details });
}

function keySource(env) {
  if (env.AI_PROVIDER === 'llm-farm') {
    return ['MODEL_FARM_API_KEY', 'BMF_API_KEY', 'LLM_FARM_API_KEY'].find(name => env[name]);
  }
  return env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : undefined;
}

async function liveProviderTest({ provider, apiKey, model, fetcher }) {
  try {
    const response = await fetcher(provider.chatUrl || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { ...providerHeaders(apiKey, provider), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_completion_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
    });
    if (response.ok) return { status: 'ok', text: `Live test: the model answered (HTTP ${response.status}).` };
    const hints = {
      401: provider.name === 'LLM Farm'
        ? 'The gateway rejected the key. Check MODEL_FARM_API_KEY and that LLM_FARM_AUTH matches your Welcome Email.'
        : 'The provider rejected the key. Check OPENAI_API_KEY.',
      403: 'The key has no access to this model or deployment.',
      404: 'The chat URL or deployment was not found. Check AI_CHAT_URL, including api-version, and AI_MODEL.',
      429: 'Rate limit or quota exceeded. Retry later or check your quota.',
    };
    return { status: response.status === 429 ? 'warn' : 'error',
      text: `Live test failed with HTTP ${response.status}. ${hints[response.status] || 'Check the endpoint, model and provider availability.'}` };
  } catch (error) {
    return { status: 'error', text: `Live test could not reach the provider: ${error.message}` };
  }
}

async function providerCheck({ env, provider, apiKey, model, live, fetcher }) {
  const details = [`Provider: ${provider.name}`, `Model: ${model || 'not set'}`,
    ...(provider.name === 'LLM Farm' ? [`Authentication header: ${provider.header}`, `Chat URL: ${provider.chatUrl || 'not set'}`] : [])];
  if (provider.configurationError) {
    return check('ai', 'AI provider', 'error', provider.configurationError, { details, action: 'Set AI_CHAT_URL and AI_MODEL in .env, then restart.' });
  }
  if (!apiKey) {
    return check('ai', 'AI provider', 'warn', 'No API key: source-preview mode. Chat shows retrieved passages only; Dreaming, images and recordings are disabled.', {
      details, action: provider.name === 'LLM Farm' ? 'Set MODEL_FARM_API_KEY in .env and restart.' : 'Set OPENAI_API_KEY in .env (or configure AI_PROVIDER=llm-farm) and restart.',
    });
  }
  details.push(`API key: set via ${keySource(env) || 'createApp option'} (value hidden)`);
  if (!live) {
    return check('ai', 'AI provider', 'ok', 'Configured. Run live checks to verify the key and model with one tiny request.', { details });
  }
  const result = await liveProviderTest({ provider, apiKey, model, fetcher });
  return check('ai', 'AI provider', result.status, result.text, { details });
}

function mediaAiChecks({ env, provider, apiKey, model, videoModel }) {
  const ready = Boolean(apiKey) && !provider.configurationError;
  const gemini = provider.transcriptionMode === 'gemini';
  const transcriptionUrl = gemini ? provider.chatUrl : provider.transcriptionUrl;
  const transcription = !ready
    ? check('transcription', 'Recording transcription', 'warn', 'Unavailable until an AI provider is configured.')
    : !transcriptionUrl
      ? check('transcription', 'Recording transcription', 'warn', 'No transcription endpoint: video and audio uploads are disabled.', {
        details: [`AI_TRANSCRIPTION_MODE=${provider.transcriptionMode}`],
        action: 'Set AI_TRANSCRIPTION_URL for a Whisper deployment, or use AI_TRANSCRIPTION_MODE=gemini with a Gemini chat deployment.' })
      : check('transcription', 'Recording transcription', 'ok', gemini
        ? 'Gemini mode: audio is transcribed through the chat endpoint.'
        : `Whisper mode using ${provider.transcriptionModel}.`, { details: [`AI_TRANSCRIPTION_MODE=${provider.transcriptionMode}`] });
  const speakers = !ready || !transcriptionUrl
    ? check('speakers', 'Automatic speaker detection', 'warn', 'Unavailable until recording transcription is configured.')
    : gemini
      ? check('speakers', 'Automatic speaker detection', 'ok', 'Enabled through Gemini audio and image input.')
      : check('speakers', 'Automatic speaker detection', 'warn', 'Whisper mode cannot group speakers automatically; speakers must be labeled by hand.', {
        action: 'Set AI_TRANSCRIPTION_MODE=gemini with a Gemini chat deployment for automatic speaker cards.' });
  const vision = !ready
    ? check('vision', 'Images and video frames', 'warn', 'Unavailable until an AI provider is configured.')
    : check('vision', 'Images and video frames', 'ok', `Using ${videoModel || model}${env.VIDEO_VISION_MODEL ? ' (VIDEO_VISION_MODEL)' : ' (chat model)'}.`, {
      details: ['The selected model must accept image input; this is not verified without uploading an image.'] });
  return [transcription, speakers, vision];
}

async function binaryCheck(id, title, path, runner) {
  if (!path || !existsSync(path)) {
    return check(id, title, 'error', 'The bundled binary is missing.', { details: [`Expected at ${path || 'unknown path'}`],
      action: 'Run npm install (reinstall dependencies) and restart.' });
  }
  try {
    const { stdout } = await runner(path, ['-version'], { timeout: 10_000 });
    return check(id, title, 'ok', stdout.split('\n')[0].trim().slice(0, 120), { details: [path] });
  } catch (error) {
    return check(id, title, 'error', `The binary does not run: ${error.message.split('\n')[0]}`, { details: [path],
      action: 'Reinstall dependencies with npm install. On macOS, check that the binary is not blocked by Gatekeeper.' });
  }
}

async function voiceCheck({ fingerprints, env, live, runner }) {
  if (!fingerprints.enabled) {
    return check('voices', 'Local voice fingerprints', 'warn', 'Disabled (VOICE_FINGERPRINTS=off). Speaker grouping relies on Gemini alone and saved voices are not recognized.', {
      action: 'Remove VOICE_FINGERPRINTS=off from .env, run npm run voices:setup, and restart.' });
  }
  const modelDirectory = env.VOICE_FINGERPRINT_MODEL_DIR || join(homedir(), '.cache', 'ultimate-executive', 'ecapa');
  const details = [`Python: ${fingerprints.python}`, `Model cache: ${modelDirectory}`,
    `Thresholds: match ${fingerprints.threshold}, new ${fingerprints.newThreshold}, margin ${fingerprints.margin}, identity ${fingerprints.identityThreshold}`];
  if (!existsSync(fingerprints.python)) {
    return check('voices', 'Local voice fingerprints', 'error', 'Enabled, but the Python voice runtime is not installed. Recording analysis will report a tracking error.', {
      details, action: 'Run npm run voices:setup (Python 3.9-3.13), or set VOICE_FINGERPRINT_PYTHON, or set VOICE_FINGERPRINTS=off.' });
  }
  const cached = existsSync(modelDirectory) && readdirSync(modelDirectory).length > 0;
  if (live) {
    try {
      const { stdout } = await runner(fingerprints.python, ['-c',
        'import sys, torch, speechbrain, silero_vad; print(sys.version.split()[0], speechbrain.__version__)'], { timeout: 120_000 });
      details.push(`Live test: Python ${stdout.trim()} with SpeechBrain and Silero VAD imported.`);
    } catch (error) {
      return check('voices', 'Local voice fingerprints', 'error', 'The Python runtime exists but its voice libraries fail to load.', {
        details: [...details, error.message.split('\n').filter(Boolean).slice(-1)[0] || error.message],
        action: 'Rerun npm run voices:setup to reinstall requirements-voices.txt.' });
    }
  }
  if (!cached) {
    return check('voices', 'Local voice fingerprints', 'warn', 'Runtime installed; the ECAPA model is not downloaded yet and will be fetched from Hugging Face on first use.', {
      details, action: 'Allow network access to Hugging Face for the first recording, or pre-populate VOICE_FINGERPRINT_MODEL_DIR.' });
  }
  return check('voices', 'Local voice fingerprints', 'ok', live ? 'Runtime and model are ready.' : 'Runtime and model cache found. Run live checks to verify the Python libraries load.', { details });
}

function storageCheck(directory) {
  const details = [`Data directory: ${resolve(directory)}`];
  try {
    const probe = join(directory, `.setup-${randomUUID()}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch (error) {
    return check('storage', 'Data storage', 'error', `The data directory is not writable: ${error.message}`, { details,
      action: 'Fix the folder permissions or set DATA_DIR to a writable folder, then restart.' });
  }
  const database = join(directory, 'sandbox.sqlite');
  if (existsSync(database)) details.push(`Database: ${(statSync(database).size / 1024 ** 2).toFixed(1)} MB`);
  const stats = statfsSync(directory);
  const free = stats.bavail * stats.bsize;
  details.push(`Free disk space: ${(free / GB).toFixed(1)} GB`);
  if (free < 0.5 * GB) {
    return check('storage', 'Data storage', 'error', 'Less than 0.5 GB free: uploads and recordings will fail.', { details, action: 'Free disk space or move DATA_DIR.' });
  }
  if (free < 7 * GB) {
    return check('storage', 'Data storage', 'warn', 'Less than 7 GB free: a 3 GB recording needs room for the upload, the retained original and temporary audio and frames.', { details });
  }
  return check('storage', 'Data storage', 'ok', 'Writable with enough free space for large recordings.', { details });
}

function featureChecks({ provider, apiKey, chatMemory, dreamConcurrency, builtinDocuments }) {
  const ready = Boolean(apiKey) && !provider.configurationError;
  return [
    ready
      ? check('dreaming', 'Dreaming', 'ok', `Runs automatically after uploads with ${dreamConcurrency} concurrent batch(es).`, {
        details: ['DREAMING_CONCURRENCY=1 is slowest but most consistent; lower it if the provider returns HTTP 429.'] })
      : check('dreaming', 'Dreaming', 'warn', 'Unavailable until an AI provider is configured.'),
    !chatMemory
      ? check('chat-memory', 'Conversation memory', 'warn', 'Disabled (CHAT_MEMORY=off). Executives do not remember earlier chats.')
      : ready
        ? check('chat-memory', 'Conversation memory', 'ok', 'Enabled: one extra AI request after each answer.')
        : check('chat-memory', 'Conversation memory', 'warn', 'Enabled, but inactive until an AI provider is configured.'),
    builtinDocuments
      ? check('knowledge', 'Built-in knowledge', 'ok', `${builtinDocuments} reference documents loaded.`)
      : check('knowledge', 'Built-in knowledge', 'warn', 'No built-in reference documents were found.', {
        action: 'Restore the knowledge/builtin folder from the project files and restart.' }),
    check('access', 'Access control', 'ok', 'Local only: bound to 127.0.0.1.', {
      details: ['Sandbox: logins are simulated, with no authentication or encryption at rest.',
        'Use only non-sensitive test data and do not expose this server publicly.'] }),
  ];
}

function companyCheck(company) {
  if (!company.filled) {
    return check('company', 'Company profile', 'warn', 'No company profile: executives give generic advice unless a document matches the question.', {
      action: 'Open Company profile in the sidebar and run the short interview or fill in the form.' });
  }
  return check('company', 'Company profile', 'ok', `${company.filled} of ${company.total} fields filled; shared by every executive.`, {
    details: [`Last updated ${company.updatedAt?.slice(0, 10)}${company.updatedByName ? ` by ${company.updatedByName}` : ''}.`,
      'Visible to everyone using this sandbox and included in every chat prompt.'] });
}

function promptCacheCheck({ promptCache, provider, apiKey }) {
  const details = ['The chat prompt starts with fixed rules, then the executive profile and soul; questions, sources and memories come last, so providers with prefix caching reuse the start.'];
  if (!apiKey || provider.configurationError) return check('prompt-cache', 'Prompt caching', 'ok', 'Inactive until an AI provider is configured.', { details });
  if (!promptCache.answers) return check('prompt-cache', 'Prompt caching', 'ok', 'No AI answers since the server started.', { details });
  const tokens = `${promptCache.answers} answer(s), ${promptCache.promptTokens.toLocaleString('en-US')} prompt tokens`;
  if (!promptCache.reported) {
    return check('prompt-cache', 'Prompt caching', 'ok', `${provider.name} does not report cached tokens, so the cache hit rate is unknown.`, {
      details: [...details, `Since start: ${tokens}.`] });
  }
  const rate = Math.round(100 * promptCache.cachedTokens / promptCache.promptTokens);
  return check('prompt-cache', 'Prompt caching', 'ok', `${rate}% of prompt tokens were served from the provider's cache since the server started.`, {
    details: [...details, `Since start: ${tokens}, ${promptCache.cachedTokens.toLocaleString('en-US')} cached.`,
      'Caching starts with the second request that shares a prefix of at least 1,024 tokens and expires after a few idle minutes.'] });
}

async function semanticCheck({ semanticSearch, provider, apiKey, live, fetcher }) {
  const details = [`Model: ${semanticSearch.model || 'none'}`, `Endpoint: ${semanticSearch.url || 'none'}`,
    `Minimum similarity: ${semanticSearch.minSimilarity}`, `Indexed passages: ${semanticSearch.indexed}`];
  if (!semanticSearch.enabled) {
    return check('semantic', 'Semantic search', 'warn', `${semanticSearch.reason} Retrieval uses keywords only, so synonyms are missed.`, {
      details, action: semanticSearch.url ? '' : 'Set AI_EMBEDDING_URL to your Farm embeddings deployment in .env, then restart.' });
  }
  if (live) {
    try {
      await embedTexts(['setup check'], { config: semanticSearch, provider, apiKey, fetcher });
    } catch (error) {
      return check('semantic', 'Semantic search', 'error', `The embeddings request failed: ${error.message}`, { details,
        action: 'Check AI_EMBEDDING_URL / AI_EMBEDDING_MODEL and that your key may use the embeddings deployment.' });
    }
  }
  if (semanticSearch.lastError) {
    return check('semantic', 'Semantic search', 'warn', `The last embeddings request failed, so keyword search was used: ${semanticSearch.lastError}`, {
      details, action: 'Run live checks to test the embeddings endpoint.' });
  }
  const pending = semanticSearch.pending ? ` ${semanticSearch.pending} passage(s) are ${semanticSearch.indexing ? 'being indexed' : 'indexed on the next question'}.` : '';
  return check('semantic', 'Semantic search', 'ok', `Hybrid keyword and meaning search with ${semanticSearch.model}.${pending}`, {
    details: [...details, 'Passages are sent to the AI provider once to compute their embeddings; vectors are cached locally.'] });
}

export async function setupStatus({ env = process.env, provider, apiKey, model, videoModel, fingerprints, chatMemory,
  dreamConcurrency, directory, startedAt, builtinDocuments, semanticSearch, promptCache, company, live = false, fetcher = fetch, runner = execute,
  envPath = resolve('.env'), ffmpeg = ffmpegPath, ffprobePath = ffprobe.path }) {
  const checks = [
    serverCheck({ startedAt, envPath }),
    await providerCheck({ env, provider, apiKey, model, live, fetcher }),
    ...mediaAiChecks({ env, provider, apiKey, model, videoModel }),
    await binaryCheck('ffmpeg', 'FFmpeg', ffmpeg, runner),
    await binaryCheck('ffprobe', 'FFprobe', ffprobePath, runner),
    await voiceCheck({ fingerprints, env, live, runner }),
    storageCheck(directory),
    ...(semanticSearch ? [await semanticCheck({ semanticSearch, provider, apiKey, live, fetcher })] : []),
    ...(promptCache ? [promptCacheCheck({ promptCache, provider, apiKey })] : []),
    ...(company ? [companyCheck(company)] : []),
    ...featureChecks({ provider, apiKey, chatMemory, dreamConcurrency, builtinDocuments }),
  ];
  const overall = checks.reduce((worst, item) => RANK[item.status] > RANK[worst] ? item.status : worst, 'ok');
  return { checkedAt: new Date().toISOString(), live, overall, checks };
}
