import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createStore, InputError, text } from './lib/store.js';
import { answerQuestion } from './lib/chat.js';
import { ingestVideo, recordingFrame, recordingSample, VIDEO_LIMITS, AUDIO_EXTENSIONS } from './lib/video.js';
import { diarizeRecording } from './lib/diarization.js';
import { ingestDocument, DOCUMENT_LIMITS, DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, validateDocumentInput } from './lib/documents.js';
import { providerConfig } from './lib/provider.js';
import { SOUL_LIMIT } from './lib/soul.js';
import { retainUpload, originalType } from './lib/originals.js';
import { recordingSegments } from './lib/recordings.js';
import { fingerprintRecording, voiceFingerprintConfig, expectedSpeakerCount, validateFingerprints, clusterFingerprintTurns } from './lib/voice-fingerprints.js';
import { MEMORY_LIMIT, MEMORY_CATEGORIES } from './lib/executive-memory.js';
import { dreamDocuments, dreamingConcurrency } from './lib/dreaming.js';
import { extractGeneralKnowledge } from './lib/general-knowledge.js';
import { extractChatMemories, chatMemoryEnabled, rememberableEngine, CHAT_MEMORY_KINDS, CHAT_MEMORY_PROMPT_LIMIT } from './lib/chat-memory.js';
import { setupStatus } from './lib/setup-status.js';
import { embedTexts, semanticSearchConfig } from './lib/embeddings.js';
import { COMPANY_FIELDS, INTERVIEW_QUESTION_LIMIT, filledCompanyFields, interviewCompany } from './lib/company-profile.js';

const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));

export function createApp({
  directory = process.env.DATA_DIR || './data',
  provider = providerConfig(),
  apiKey = provider.apiKey,
  model = provider.model,
  videoModel = process.env.VIDEO_VISION_MODEL || model,
  fetcher = fetch,
  fingerprints = voiceFingerprintConfig(),
  fingerprinter = fingerprintRecording,
  generalizer = extractGeneralKnowledge,
  dreamConcurrency = dreamingConcurrency(process.env.DREAMING_CONCURRENCY),
  chatMemory = chatMemoryEnabled(process.env.CHAT_MEMORY),
  chatMemorizer = extractChatMemories,
  semanticSearch = semanticSearchConfig(provider, apiKey),
  setupOptions = {},
} = {}) {
  const startedAt = Date.now();
  const store = createStore(directory, { voiceIdentityThreshold: fingerprints.identityThreshold });
  const embedding = { indexing: false, rerun: false, lastError: '', run: Promise.resolve() };
  // Prompt-cache statistics since server start, as reported by the provider.
  const promptCache = { answers: 0, reported: 0, promptTokens: 0, cachedTokens: 0 };
  const embed = texts => embedTexts(texts, { config: semanticSearch, provider, apiKey, fetcher });
  if (semanticSearch.model) store.pruneEmbeddings(semanticSearch.model);
  // Indexes every retrievable passage in the background and drops vectors of deleted content.
  function refreshEmbeddings() {
    if (!semanticSearch.model || embedding.closed) return embedding.run;
    if (!semanticSearch.enabled) { store.pruneEmbeddings(semanticSearch.model); return embedding.run; }
    if (embedding.indexing) { embedding.rerun = true; return embedding.run; }
    embedding.indexing = true;
    embedding.run = (async () => {
      do {
        embedding.rerun = false;
        try {
          store.pruneEmbeddings(semanticSearch.model);
          const missing = store.missingEmbeddings(semanticSearch.model);
          if (missing.length) {
            const vectors = await embed(missing);
            if (embedding.closed) break;
            store.saveEmbeddings(semanticSearch.model, missing.map((content, index) => ({ content, vector: vectors[index] })));
          }
          embedding.lastError = '';
        } catch (error) {
          console.error('Semantic search indexing failed:', error);
          embedding.lastError = error.message;
        }
      } while (embedding.rerun);
      embedding.indexing = false;
    })();
    return embedding.run;
  }
  // Embeds the question and any not-yet-indexed visible passages; on failure retrieval falls back to keywords.
  async function semanticQuery(input, question) {
    if (!semanticSearch.enabled) return null;
    try {
      const missing = store.missingEmbeddings(semanticSearch.model, input);
      const [vector, ...vectors] = await embed([question, ...missing]);
      store.saveEmbeddings(semanticSearch.model, missing.map((content, index) => ({ content, vector: vectors[index] })));
      embedding.lastError = '';
      return { model: semanticSearch.model, vector, minSimilarity: semanticSearch.minSimilarity };
    } catch (error) {
      console.error('Semantic search failed; using keyword search for this question:', error);
      embedding.lastError = error.message;
      return null;
    }
  }
  let videoBusy = false;
  let documentBusy = false;
  let frameBusy = false;
  let sampleBusy = false;
  async function rememberVoices(id) {
    const review = store.recordingReview(id);
    if (!fingerprints.enabled || !review.hasOriginal || !review.assignments.some(Boolean) ||
        !/\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|flac|aac)$/i.test(review.originalFilename) ||
        !store.missingVoiceFingerprints(id)) return '';
    if (videoBusy) return 'Voice profiles were not updated because another recording is being analyzed. Save again later to update them.';
    videoBusy = true;
    try {
      const segments = await fingerprinter({ path: store.original(id).path, segments: review.segments, config: fingerprints, preserveGroups: true });
      store.rememberRecordingVoices(id, segments, review);
      return '';
    } catch (error) {
      return `Assignments were saved, but voice profiles could not be updated: ${error.message}`;
    } finally { videoBusy = false; }
  }
  const dreamQueues = new Map();
  const dreamJobs = new Set();
  const dreamErrors = new Map();
  function dream(input) {
    const job = { executiveId: input.executiveId, phase: 'queued', completedBatches: 0, totalBatches: 0 };
    dreamJobs.add(job);
    const previous = dreamQueues.get(input.executiveId) || Promise.resolve();
    const task = previous.then(async () => {
      dreamErrors.delete(input.executiveId);
      const snapshot = store.dreamingSnapshot(input);
      if (!snapshot.documents.length) return { status: 'no-sources', executiveId: input.executiveId, scope: input.mode,
        documents: 0, memories: 0, traits: 0, sourceMonths: 0 };
      job.startedAt = Date.now();
      job.lastBatchAt = job.startedAt;
      const findings = await dreamDocuments({ ...snapshot, apiKey, model, provider, fetcher, concurrency: dreamConcurrency,
        onProgress: progress => {
          if (progress.completedBatches > job.completedBatches) job.lastBatchAt = Date.now();
          Object.assign(job, progress);
        } });
      job.phase = 'saving';
      return store.saveDream(snapshot, findings);
    });
    const settled = task.then(() => undefined, error => {
      console.error('Automatic Dreaming failed:', error);
      dreamErrors.set(input.executiveId, { executiveId: input.executiveId, scope: input.mode, error: error.message });
    });
    dreamQueues.set(input.executiveId, settled);
    settled.then(() => {
      dreamJobs.delete(job);
      if (dreamQueues.get(input.executiveId) === settled) dreamQueues.delete(input.executiveId);
      refreshEmbeddings();
    });
    return task;
  }
  function generalize(source) {
    if (!apiKey || provider.configurationError) return;
    const executiveId = source.executive_id;
    const previous = dreamQueues.get(executiveId) || Promise.resolve();
    const task = previous.then(async () => {
      const executive = store.context({ executiveId, profileId: source.profile_id, mode: 'public' });
      const knowledge = await generalizer({ executive, document: source, apiKey, model, provider, fetcher });
      if (knowledge && store.insertGeneralKnowledge(source.id, source.content, knowledge)) {
        queueDream({ executiveId, profileId: source.profile_id, mode: 'public' });
      }
    });
    const settled = task.then(() => undefined, error => {
      console.error('General knowledge extraction failed:', error);
      dreamErrors.set(executiveId, { executiveId, scope: 'public', error: `General knowledge extraction failed: ${error.message}` });
    });
    dreamQueues.set(executiveId, settled);
    settled.then(() => {
      if (dreamQueues.get(executiveId) === settled) dreamQueues.delete(executiveId);
    });
  }
  const chatMemoryQueues = new Map();
  const chatMemoryPending = new Map();
  const chatMemoryErrors = new Map();
  const chatMemoryKey = input => `${input.executiveId}:${input.profileId}:${input.mode}`;
  const chatMemoryActive = () => chatMemory && Boolean(apiKey) && !provider.configurationError;
  function rememberExchange(input, executive, question, answer, messageId) {
    const key = chatMemoryKey(input);
    const scope = { executiveId: input.executiveId, profileId: input.profileId, mode: input.mode };
    chatMemoryPending.set(key, (chatMemoryPending.get(key) || 0) + 1);
    // Serialized per person and executive so later exchanges see topics saved by earlier ones.
    const task = (chatMemoryQueues.get(key) || Promise.resolve()).then(async () => {
      const memories = await chatMemorizer({ executive, question, answer: answer.content,
        topics: store.chatMemoryTopics(scope), apiKey, model, provider, fetcher });
      store.saveChatMemories(scope, messageId, memories);
      chatMemoryErrors.delete(key);
    }).catch(error => {
      console.error('Conversation memory extraction failed:', error);
      chatMemoryErrors.set(key, `Conversation memory extraction failed: ${error.message}`);
    }).finally(() => {
      chatMemoryPending.set(key, chatMemoryPending.get(key) - 1);
      if (!chatMemoryPending.get(key)) { chatMemoryPending.delete(key); chatMemoryQueues.delete(key); }
    });
    chatMemoryQueues.set(key, task);
  }
  function queueDream(input) {
    const snapshot = store.dreamingSnapshot(input);
    if (!snapshot.documents.length) return {
      status: 'no-sources', executiveId: input.executiveId, scope: input.mode,
      documents: 0, memories: 0, traits: 0, sourceMonths: 0,
    };
    dreamErrors.delete(input.executiveId);
    dream(input);
    return { status: 'queued', executiveId: input.executiveId, scope: input.mode };
  }
  const server = createServer(async (request, response) => {
    let progressStream = false;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'");
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const isVideo = request.method === 'POST' && ['/api/videos', '/api/media'].includes(url.pathname);
        const isDocument = request.method === 'POST' && url.pathname === '/api/files';
        const input = ['POST', 'PATCH'].includes(request.method) && !isVideo && !isDocument ? await readJson(request) : Object.fromEntries(url.searchParams);
        if (isVideo && request.headers['x-participants']) {
          try { input.participants = decodeURIComponent(request.headers['x-participants']); }
          catch { throw new InputError('Invalid participant header encoding.'); }
        }
        let result;
        if (isDocument || isVideo || (request.method === 'POST' && url.pathname === '/api/documents')) {
          input.scope = store.uploadScope(input);
        }
        const soulRoute = url.pathname.match(/^\/api\/executives\/([^/]+)\/soul$/);
        const dreamRoute = url.pathname.match(/^\/api\/executives\/([^/]+)\/dream$/);
        const executiveRoute = url.pathname.match(/^\/api\/executives\/([^/]+)$/);
        const memoryRoute = url.pathname.match(/^\/api\/executives\/([^/]+)\/memory(?:\/([^/]+))?$/);
        const chatMemoryRoute = url.pathname.match(/^\/api\/executives\/([^/]+)\/chat-memory(?:\/([^/]+))?$/);
        const originalRoute = url.pathname.match(/^\/api\/documents\/([^/]+)\/original$/);
        const reviewRoute = url.pathname.match(/^\/api\/documents\/([^/]+)\/speakers$/);
        const tracksRoute = url.pathname.match(/^\/api\/documents\/([^/]+)\/speaker-tracks$/);
        const groupsRoute = url.pathname.match(/^\/api\/documents\/([^/]+)\/speaker-groups$/);
        const frameRoute = url.pathname.match(/^\/api\/documents\/([^/]+)\/frame$/);
        const sampleRoute = url.pathname.match(/^\/api\/documents\/([^/]+)\/voice-sample$/);
        const conversationRoute = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
        const projectRoute = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (request.method === 'GET' && url.pathname === '/api/state') {
          result = {
            ...store.state(), aiConfigured: Boolean(apiKey) && !provider.configurationError, model: apiKey ? model : null,
            executiveManagement: true,
            providerName: provider.name, configurationError: provider.configurationError,
            video: { enabled: Boolean(apiKey) && !provider.configurationError && Boolean(provider.transcriptionMode === 'gemini' ? provider.chatUrl : provider.transcriptionUrl), ...VIDEO_LIMITS },
            media: { audioExtensions: AUDIO_EXTENSIONS, participantLabels: true, speakerReview: true,
              voiceFingerprints: { enabled: fingerprints.enabled },
              speakerTracking: Boolean(apiKey) && !provider.configurationError && provider.transcriptionMode === 'gemini' && Boolean(provider.chatUrl) },
            documents: { ...DOCUMENT_LIMITS, extensions: DOCUMENT_EXTENSIONS },
            images: { enabled: Boolean(apiKey) && !provider.configurationError, extensions: IMAGE_EXTENSIONS },
            soul: { maxCharacters: SOUL_LIMIT },
            memory: { maxCharacters: MEMORY_LIMIT, categories: MEMORY_CATEGORIES },
            dreaming: { automatic: true, enabled: Boolean(apiKey) && !provider.configurationError, status: true },
            chatMemory: { enabled: chatMemoryActive(), kinds: CHAT_MEMORY_KINDS },
            semanticSearch: { enabled: semanticSearch.enabled },
            company: { filled: filledCompanyFields(store.companyProfile().profile), total: COMPANY_FIELDS.length },
            builtinKnowledge: { domains: store.builtinCatalog() },
          };
        } else if (request.method === 'GET' && url.pathname === '/api/dreaming') {
          result = { jobs: [...dreamJobs], errors: [...dreamErrors.values()] };
        } else if (url.pathname === '/api/setup' && ['GET', 'POST'].includes(request.method)) {
          // POST runs live checks (one tiny provider request, Python imports), so it is never triggered by a page load.
          result = await setupStatus({ provider, apiKey, model, videoModel, fingerprints, chatMemory, dreamConcurrency,
            directory, startedAt, fetcher, live: request.method === 'POST',
            semanticSearch: { ...semanticSearch, indexing: embedding.indexing, lastError: embedding.lastError,
              indexed: semanticSearch.model ? store.embeddingCount(semanticSearch.model) : 0,
              pending: semanticSearch.enabled ? store.missingEmbeddings(semanticSearch.model).length : 0 },
            promptCache: { ...promptCache },
            company: { ...store.companyProfile(), filled: filledCompanyFields(store.companyProfile().profile), total: COMPANY_FIELDS.length },
            builtinDocuments: store.builtinCatalog().reduce((sum, domain) => sum + domain.documents.length, 0), ...setupOptions });
        } else if (isDocument) {
          store.context({ ...input, mode: 'public' });
          validateDocumentInput(input);
          if (documentBusy) throw new InputError('Another document is being extracted. Please retry after it finishes.', 409);
          documentBusy = true;
          try {
            result = await retainUpload(request, directory, input.filename, DOCUMENT_LIMITS.bytes, async (stream, original) => {
              const extracted = await ingestDocument(stream, input, { apiKey, model: videoModel, provider, fetcher });
              const recording = extracted.content.includes('\nTIMESTAMPED SPEECH TRANSCRIPT\n');
              return {
                ...(recording
                  ? store.insertRecording({ ...input, content: extracted.content, original: original() }, recordingSegments(extracted.content))
                  : store.insertDocument({ ...input, content: extracted.content, original: original() })),
                characters: extracted.content.length, warnings: extracted.warnings,
              };
            });
          } finally { documentBusy = false; }
        } else if (isVideo) {
          input.expectedSpeakers = expectedSpeakerCount(input.expectedSpeakers);
          store.context({ ...input, mode: 'public' });
          if (videoBusy) throw new InputError('Another video/audio recording is being analyzed. Please retry after it finishes.', 409);
          videoBusy = true;
          try {
            result = await retainUpload(request, directory, input.filename, VIDEO_LIMITS.bytes, async (stream, original) => {
              const analysis = await ingestVideo({
                stream, input, apiKey, model: videoModel, provider, fetcher,
                trackSpeakers: input.reviewSpeakers !== 'false' && provider.transcriptionMode === 'gemini',
                allowPartial: input.reviewSpeakers !== 'false',
                fingerprints: { ...fingerprints, expectedSpeakers: input.expectedSpeakers }, fingerprinter,
                onProgress: input.progress === 'true' ? progress => {
                  if (!progressStream) {
                    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
                    progressStream = true;
                  }
                  response.write(`${JSON.stringify({ type: 'progress', ...progress })}\n`);
                } : undefined,
              });
              return {
                ...(input.reviewSpeakers !== 'false'
                  ? store.insertRecording({ ...input, content: analysis.content, original: original() }, analysis.segments, analysis.trackingError,
                    analysis.warnings.filter(warning => warning !== analysis.trackingError))
                  : store.insertDocument({ ...input, content: analysis.content, original: original() })),
                duration: analysis.duration, frames: analysis.frames, hasAudio: analysis.hasAudio,
                warnings: analysis.warnings,
              };
            });
          } finally { videoBusy = false; }
        } else if (sampleRoute && request.method === 'GET') {
          const original = store.original(decodeURIComponent(sampleRoute[1]));
          if (!/\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|flac|aac)$/i.test(original.filename)) {
            throw new InputError('A retained audio/video recording is required for voice samples.');
          }
          if (!input.start?.trim() || !input.end?.trim()) throw new InputError('Voice sample start and end times are required.');
          if (sampleBusy) throw new InputError('Another voice sample is being extracted. Please retry.', 409);
          sampleBusy = true;
          let sample;
          try { sample = await recordingSample(original.path, Number(input.start), Number(input.end)); }
          finally { sampleBusy = false; }
          response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': sample.length });
          response.end(sample);
          return;
        } else if (frameRoute && request.method === 'GET') {
          const original = store.original(decodeURIComponent(frameRoute[1]));
          if (!/\.(mp4|mov|webm|mkv)$/i.test(original.filename)) throw new InputError('A retained video is required to show a frame.');
          if (!url.searchParams.has('seconds') || !input.seconds.trim()) throw new InputError('Frame time is required.');
          if (frameBusy) throw new InputError('Another frame is being extracted. Please retry.', 409);
          frameBusy = true;
          let frame;
          try { frame = await recordingFrame(original.path, Number(input.seconds)); }
          finally { frameBusy = false; }
          response.writeHead(200, { 'Content-Type': 'image/jpeg' });
          response.end(frame);
          return;
        } else if (groupsRoute && request.method === 'POST') {
          if (!fingerprints.enabled) throw new InputError('Enable SpeechBrain voice fingerprinting to regroup locally.', 503);
          if (videoBusy) throw new InputError('Another recording is being analyzed. Retry after it finishes.', 409);
          const id = decodeURIComponent(groupsRoute[1]);
          const review = store.recordingReview(id);
          const expectedSpeakers = expectedSpeakerCount(input.expectedSpeakers);
          const config = { ...fingerprints, expectedSpeakers };
          const evidence = store.fingerprintInputs(id);
          videoBusy = true;
          try {
            const segments = evidence.complete
              ? clusterFingerprintTurns(evidence.segments, validateFingerprints(evidence.entries, evidence.entries.map(entry => entry.index)), config)
              : await fingerprinter({ path: store.original(id).path, segments: evidence.segments, config });
            if (!segments.some(segment => segment.speakerId)) throw new InputError('No usable voice groups were found. Try a different speaker count or review the audio quality.');
            result = store.saveSpeakerTracks(id, segments, review.segments, { expectedSpeakers });
          } finally { videoBusy = false; }
        } else if (tracksRoute && request.method === 'POST') {
          const id = decodeURIComponent(tracksRoute[1]);
          const review = store.recordingReview(id);
          const expectedSpeakers = expectedSpeakerCount(input.expectedSpeakers === undefined ? review.expectedSpeakers : input.expectedSpeakers);
          const original = store.original(id);
          if (!/\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|flac|aac)$/i.test(original.filename)) {
            throw new InputError('Speaker tracking requires the retained original audio/video, not a text export.');
          }
          if (videoBusy) throw new InputError('Another recording is being analyzed. Please retry after it finishes.', 409);
          videoBusy = true;
          try {
            const segments = await diarizeRecording({
              path: original.path, segments: review.segments, provider, apiKey, model, fetcher,
              hasVideo: /\.(mp4|mov|webm|mkv)$/i.test(original.filename),
              allowPartial: true,
              fingerprints: { ...fingerprints, expectedSpeakers }, fingerprinter,
            });
            result = store.saveSpeakerTracks(id, segments, review.segments, { expectedSpeakers });
          } finally { videoBusy = false; }
        } else if (reviewRoute && request.method === 'GET') {
          result = store.recordingReview(decodeURIComponent(reviewRoute[1]));
        } else if (reviewRoute && request.method === 'POST') {
          const id = decodeURIComponent(reviewRoute[1]);
          result = input.draft === true
            ? store.saveRecordingReview(id, input.assignments)
            : store.publishRecording(id, input.assignments);
          const voiceProfileWarning = await rememberVoices(id);
          if (voiceProfileWarning) result = { ...result, voiceProfileWarning };
        } else if (url.pathname === '/api/voice-profiles' && request.method === 'GET') {
          result = store.voiceProfiles(input.profileId);
        } else if (url.pathname === '/api/voice-profiles' && request.method === 'DELETE') {
          result = store.forgetVoices(input.profileId);
        } else if (dreamRoute && request.method === 'POST') {
          const dreamInput = { ...input, executiveId: decodeURIComponent(dreamRoute[1]) };
          store.context(dreamInput);
          const scopes = dreamInput.mode === 'public' ? ['public'] : ['public', dreamInput.mode];
          result = { dreaming: [] };
          for (const scope of scopes) result.dreaming.push(queueDream({ ...dreamInput, mode: scope }));
        } else if (soulRoute && request.method === 'GET') {
          result = store.soul(decodeURIComponent(soulRoute[1]), input.mode ? input : undefined);
        } else if (soulRoute && request.method === 'POST') {
          result = store.saveSoul(decodeURIComponent(soulRoute[1]), input.content);
        } else if (memoryRoute && request.method === 'GET' && !memoryRoute[2]) {
          result = store.memory({ ...input, executiveId: decodeURIComponent(memoryRoute[1]) });
        } else if (memoryRoute && request.method === 'POST' && !memoryRoute[2]) {
          result = store.addMemory({ ...input, executiveId: decodeURIComponent(memoryRoute[1]) });
        } else if (memoryRoute && request.method === 'DELETE' && memoryRoute[2]) {
          result = store.deleteMemory({ ...input, executiveId: decodeURIComponent(memoryRoute[1]) }, decodeURIComponent(memoryRoute[2]));
        } else if (chatMemoryRoute && request.method === 'GET' && !chatMemoryRoute[2]) {
          const scope = { executiveId: decodeURIComponent(chatMemoryRoute[1]), profileId: input.profileId, mode: input.mode };
          result = { enabled: chatMemoryActive(), entries: store.chatMemories(scope), relationship: store.relationship(scope),
            pending: chatMemoryPending.get(chatMemoryKey(scope)) || 0, error: chatMemoryErrors.get(chatMemoryKey(scope)) || null };
        } else if (chatMemoryRoute && request.method === 'DELETE' && chatMemoryRoute[2]) {
          result = store.deleteChatMemory({ executiveId: decodeURIComponent(chatMemoryRoute[1]), profileId: input.profileId, mode: input.mode },
            decodeURIComponent(chatMemoryRoute[2]));
        } else if (request.method === 'POST' && url.pathname === '/api/profiles') {
          result = store.addProfile(input.name);
        } else if (request.method === 'POST' && url.pathname === '/api/executives') {
          result = store.addExecutive(input);
        } else if (executiveRoute && request.method === 'PATCH') {
          result = store.updateExecutive(decodeURIComponent(executiveRoute[1]), input);
        } else if (executiveRoute && request.method === 'DELETE') {
          if (videoBusy || documentBusy || frameBusy || sampleBusy || dreamQueues.has(decodeURIComponent(executiveRoute[1]))) throw new InputError('Wait for the current file, recording or Dreaming operation to finish before deleting this executive.', 409);
          result = store.deleteExecutive(decodeURIComponent(executiveRoute[1]));
        } else if (request.method === 'GET' && url.pathname === '/api/documents') {
          result = store.visibleDocuments(input);
        } else if (request.method === 'POST' && url.pathname === '/api/documents') {
          const content = text(input.content, 'Document text', 200_000);
          result = content.includes('TIMESTAMPED SPEECH TRANSCRIPT\n')
            ? store.insertRecording({ ...input, content, original: undefined }, recordingSegments(content))
            : store.insertDocument({ ...input, content, original: undefined });
        } else if (request.method === 'GET' && originalRoute) {
          const original = store.original(decodeURIComponent(originalRoute[1]));
          const info = await stat(original.path);
          if (info.size !== original.bytes) throw new Error('Retained original file size does not match its metadata.');
          let start = 0;
          let end = original.bytes - 1;
          const range = request.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2])) throw new InputError('Invalid file byte range.', 416);
            start = match[1] ? Number(match[1]) : Math.max(0, original.bytes - Number(match[2]));
            end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= original.bytes) throw new InputError('File byte range is unavailable.', 416);
          }
          const file = createReadStream(original.path, { start, end });
          const type = originalType(original.filename);
          const filename = encodeURIComponent(original.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
          response.writeHead(range ? 206 : 200, {
            'Content-Type': type,
            'Content-Disposition': `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${filename}`,
            'Content-Length': end - start + 1,
            'Accept-Ranges': 'bytes',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${original.bytes}` } : {}),
          });
          await pipeline(file, response);
          return;
        } else if (request.method === 'GET' && url.pathname.startsWith('/api/documents/')) {
          result = store.document(decodeURIComponent(url.pathname.slice('/api/documents/'.length)));
        } else if (request.method === 'DELETE' && url.pathname.startsWith('/api/documents/')) {
          store.deleteDocument(decodeURIComponent(url.pathname.slice('/api/documents/'.length)));
          result = { deleted: true };
        } else if (url.pathname === '/api/projects' && request.method === 'GET') {
          result = store.projects(input.profileId);
        } else if (url.pathname === '/api/projects' && request.method === 'POST') {
          result = store.addProject(input);
        } else if (projectRoute && request.method === 'DELETE') {
          store.deleteProject(decodeURIComponent(projectRoute[1]), input.profileId);
          result = { deleted: true };
        } else if (url.pathname === '/api/conversations' && request.method === 'GET') {
          result = store.conversations(input.profileId);
        } else if (url.pathname === '/api/conversations' && request.method === 'POST') {
          result = store.addConversation(input);
        } else if (conversationRoute && request.method === 'PATCH') {
          result = store.updateConversation(decodeURIComponent(conversationRoute[1]), input);
        } else if (conversationRoute && request.method === 'DELETE') {
          store.deleteConversation(decodeURIComponent(conversationRoute[1]), input.profileId);
          result = { deleted: true };
        } else if (request.method === 'GET' && url.pathname === '/api/messages') {
          result = store.history(input);
        } else if (url.pathname === '/api/company' && request.method === 'GET') {
          result = { ...store.companyProfile(), fields: COMPANY_FIELDS,
            interview: { enabled: Boolean(apiKey) && !provider.configurationError, questionLimit: INTERVIEW_QUESTION_LIMIT } };
        } else if (url.pathname === '/api/company' && request.method === 'PATCH') {
          result = store.saveCompanyProfile(input.profileId, input.profile);
        } else if (url.pathname === '/api/company' && request.method === 'DELETE') {
          result = store.saveCompanyProfile(input.profileId, {});
        } else if (url.pathname === '/api/company/interview' && request.method === 'POST') {
          store.requireProfile(input.profileId);
          result = await interviewCompany({ messages: input.messages, draftNow: input.draftNow === true,
            current: store.companyProfile().profile, apiKey, model, provider, fetcher });
        } else if (request.method === 'POST' && url.pathname === '/api/chat') {
          const executive = store.context(input);
          const question = text(input.question, 'Question', 4000);
          const sources = store.retrieve(input, question, await semanticQuery(input, question));
          // Streaming switches to NDJSON only with the first text, so earlier failures keep their HTTP status.
          const onDelta = input.stream === true ? text => {
            if (!progressStream) {
              response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
              progressStream = true;
            }
            response.write(`${JSON.stringify({ type: 'delta', text })}\n`);
          } : undefined;
          const { usage, ...answer } = await answerQuestion({
            executive, soul: store.soul(executive.id, input).content,
            question, sources, history: store.history(input),
            pastMemories: chatMemoryActive() ? store.chatMemories(input, { activeOnly: true, limit: CHAT_MEMORY_PROMPT_LIMIT }) : [],
            company: store.companyProfile().profile, apiKey, model, provider, fetcher, onDelta,
          });
          if (usage) {
            promptCache.answers++;
            promptCache.promptTokens += usage.promptTokens;
            if (usage.cachedTokens !== null) { promptCache.reported++; promptCache.cachedTokens += usage.cachedTokens; }
          }
          const saved = store.saveExchange(input, question, answer);
          if (chatMemoryActive() && rememberableEngine(answer.engine)) rememberExchange(input, executive, question, answer, saved.answerId);
          result = answer;
        } else {
          throw new InputError('Endpoint not found.', 404);
        }
        if (request.method !== 'GET' && !['/api/chat', '/api/setup'].includes(url.pathname)) refreshEmbeddings();
        const uploaded = request.method === 'POST' &&
          (isDocument || isVideo || url.pathname === '/api/documents');
        const published = reviewRoute && request.method === 'POST' && input.draft !== true;
        if (uploaded || published) {
          const ids = published ? result.generated.map(item => item.documentId)
            : result.needsSpeakerReview ? [] : [result.id];
          result.dreaming = [];
          for (const id of ids) {
            const source = store.document(id);
            result.dreaming.push(queueDream({ executiveId: source.executive_id,
              profileId: source.profile_id, mode: source.scope }));
            if (source.scope !== 'public') generalize(source);
          }
          if (!ids.length) result.dreaming.push({ status: 'pending-speaker-review' });
        }
        if (progressStream) {
          response.end(`${JSON.stringify({ type: 'result', result })}\n`);
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }
      if (request.method !== 'GET') throw new InputError('Method not allowed.', 405);
      const assets = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/icons.js': ['../node_modules/lucide/dist/umd/lucide.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
      };
      const asset = assets[url.pathname];
      if (!asset) throw new InputError('Page not found.', 404);
      const body = await readFile(join(publicDirectory, asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(body);
    } catch (error) {
      if (!(error instanceof InputError)) console.error('Request failed:', error);
      if (progressStream) {
        response.end(`${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Unexpected server error.' })}\n`);
        return;
      }
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(error instanceof InputError ? error.status : 502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unexpected server error.' }));
    }
  });
  server.on('close', () => { embedding.closed = true; store.close(); });
  server.refreshEmbeddings = refreshEmbeddings;
  return server;
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new InputError('Content-Type must be application/json.', 415);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw new InputError('Request is too large (maximum 1 MB).', 413);
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not an object');
    return parsed;
  } catch {
    throw new InputError('Request must contain a JSON object.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Executive sandbox: http://127.0.0.1:${server.address().port}`);
    console.log('No access controls. Use only non-sensitive test data.');
    const provider = providerConfig();
    console.log(provider.configurationError || (provider.apiKey ? `AI provider: ${provider.name}; retrieved text is sent to this provider.` : 'Source preview mode. Configure the AI provider in .env to enable AI answers.'));
    server.refreshEmbeddings();
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
