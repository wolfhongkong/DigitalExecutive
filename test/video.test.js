import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { ingestVideo, timestamp, VIDEO_LIMITS } from '../lib/video.js';
import { createApp } from '../server.js';
import { providerConfig } from '../lib/provider.js';

const execute = promisify(execFile);
const input = {
  executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched',
  title: 'Fictional video briefing', filename: 'briefing.mp4',
};

const geminiProvider = providerConfig({
  AI_PROVIDER: 'llm-farm', AI_MODEL: 'gemini-3.7-flash', AI_TRANSCRIPTION_MODE: 'gemini',
  AI_CHAT_URL: 'https://aoai-farm.bosch-temp.com/api/openai/deployments/gemini-3.7-flash/chat/completions?api-version=2025-04-01-preview',
});

test('Gemini handles every audio chunk, including silence, with global user-labeled timestamps', async t => {
  const { root, bytes } = await mediaFixture(t, { duration: 121 });
  let calls = 0;
  const progress = [];
  const result = await ingestVideo({
    onProgress: event => progress.push(event),
    stream: Readable.from([bytes]), input: { ...input, filename: 'audio.m4a', participants: JSON.stringify([
      { kind: 'speech', name: 'Late speaker', start: 120, end: 121 },
    ]) }, apiKey: 'test-key', model: 'gemini-3.7-flash', provider: geminiProvider, temporaryRoot: root,
    fetcher: async (url, options) => {
      assert.equal(url, geminiProvider.chatUrl);
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gemini-3.7-flash');
      assert.equal(body.temperature, 0);
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.max_completion_tokens, 16_384);
      assert.equal(body.messages[1].content[1].type, 'input_audio');
      assert.equal(body.messages[1].content[1].input_audio.format, 'mp3');
      assert.ok(Buffer.from(body.messages[1].content[1].input_audio.data, 'base64').length);
      calls++;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(
        calls === 1 ? { text: '', segments: [] } :
          { text: 'Final words.', segments: [{ start: 0, end: 1, text: 'Final words.' }] },
      ) } }] });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(progress.filter(event => event.message.startsWith('Transcribed')).map(event => event.percent),
    [5 + 55 * 120 / 121, 60]);
  assert.equal(progress.at(-1).percent, 98);
  assert.equal(result.frames, 0);
  assert.match(result.content, /No speech detected/);
  assert.match(result.content, /\[00:02:00 - 00:02:01\] Speaker: Late speaker \(user-labeled\): Final words/);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('Gemini rejects malformed, truncated and invalid timestamp transcripts with cleanup', async t => {
  t.mock.method(console, 'warn', () => {});
  const { root, bytes } = await mediaFixture(t);
  for (const choice of [
    { message: { content: 'not JSON' } },
    { finish_reason: 'length', message: { content: '{"text":"","segments":[]}' } },
    { message: { content: 'null' } },
    { message: { content: '{"text":"speech","segments":[null]}' } },
    { message: { content: '{"text":"speech","segments":[{"start":0,"end":10,"text":"speech"}]}' } },
    { message: { content: '{"text":"speech","segments":[]}' } },
  ]) {
    await assert.rejects(ingestVideo({
      stream: Readable.from([bytes]), input, apiKey: 'test-key', model: 'gemini-3.7-flash',
      provider: geminiProvider, temporaryRoot: root,
      fetcher: async () => Response.json({ choices: [choice] }),
    }), /Transcription provider/);
    assert.deepEqual(await readdir(root), ['fixture.mp4']);
  }
});

test('Gemini recording capability is enabled without a Whisper endpoint', async t => {
  const base = await appFixture(t, { provider: geminiProvider, apiKey: 'test-key' });
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.video.enabled, true);
  assert.equal(state.model, 'gemini-3.7-flash');
});

test('invalid Gemini timestamps trigger bounded shorter-clip recovery with global speaker ranges', async t => {
  const logger = t.mock.method(console, 'warn', () => {});
  const { root, bytes } = await mediaFixture(t, { duration: 121 });
  const durations = [];
  const progress = [];
  const result = await ingestVideo({
    onProgress: event => progress.push(event),
    stream: Readable.from([bytes]), input: { ...input, filename: 'audio.m4a', participants: JSON.stringify([
      { kind: 'speech', name: 'Second half speaker', start: 60, end: 120 },
    ]) }, apiKey: 'test-key', model: 'gemini-3.7-flash', provider: geminiProvider, temporaryRoot: root,
    fetcher: async (_url, options) => {
      const prompt = JSON.parse(options.body).messages[1].content[0].text;
      const duration = Number(/Transcribe this ([\d.]+)-second/.exec(prompt)[1]);
      durations.push(duration);
      if (duration === 120) return Response.json({ choices: [{ message: { content: JSON.stringify({
        text: 'Invalid timestamps', segments: [{ start: 1320, end: 1340, text: 'Invalid timestamps' }],
      }) } }] });
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        text: 'Recovered speech.', segments: [{ start: 0, end: Math.min(1, duration), text: 'Recovered speech.' }],
      }) } }] });
    },
  });
  assert.deepEqual(durations, [120, 120, 60, 60, 1]);
  assert.deepEqual(progress.filter(event => event.message.startsWith('Transcribed')).map(event => event.percent),
    [5 + 55 * 60 / 121, 5 + 55 * 120 / 121, 60]);
  assert.match(result.content, /\[00:01:00 - 00:01:01\] Speaker: Second half speaker \(user-labeled\)/);
  assert.match(result.content, /\[00:02:00 - 00:02:01\]/);
  assert.doesNotMatch(result.content, /Invalid timestamps/);
  assert.equal(logger.mock.callCount(), 2);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('persistent invalid Gemini clips stop subdivision at thirty seconds without saving partial knowledge', async t => {
  t.mock.method(console, 'warn', () => {});
  const { root, bytes } = await mediaFixture(t, { duration: 60 });
  const durations = [];
  await assert.rejects(ingestVideo({
    stream: Readable.from([bytes]), input: { ...input, filename: 'audio.m4a' },
    apiKey: 'test-key', model: 'gemini-3.7-flash', provider: geminiProvider, temporaryRoot: root,
    fetcher: async (_url, options) => {
      durations.push(Number(/Transcribe this ([\d.]+)-second/.exec(JSON.parse(options.body).messages[1].content[0].text)[1]));
      return Response.json({ choices: [{ message: { content: '{"text":"speech","segments":[{"start":0,"end":999,"text":"speech"}]}' } }] });
    },
  }), /timestamp exceeds 30-second clip.*seconds 0-30.*2 attempts/);
  assert.deepEqual(durations, [60, 60, 30, 30]);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

async function mediaFixture(t, { audio = true, duration = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'executive-video-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.mp4');
  await execute(ffmpegPath, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=64x64:r=1:d=${duration}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000:duration=${duration}`] : []),
    '-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    ...(audio ? ['-c:a', 'aac'] : []), path,
  ]);
  return { root, bytes: await readFile(path) };
}

function providerMock({ failVisuals = false } = {}) {
  const calls = [];
  return {
    calls,
    fetcher: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      calls.push({ url, options });
      if (url.endsWith('/audio/transcriptions')) {
        assert.ok(options.body instanceof FormData);
        assert.equal(options.body.get('model'), 'whisper-1');
        assert.equal(options.body.get('response_format'), 'verbose_json');
        const audio = options.body.get('file');
        assert.equal(audio.type, 'audio/mpeg');
        assert.ok(audio.size > 0 && audio.size < 25_000_000);
        return Response.json({
          text: 'The moonstone initiative budget is 17 credits.',
          segments: [{ start: 0, end: 1, text: 'The moonstone initiative budget is 17 credits.' }],
        });
      }
      assert.ok(url.endsWith('/chat/completions'));
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'test-vision');
      if (typeof payload.messages[1].content === 'string') {
        assert.match(payload.messages.at(-2).content, /moonstone/);
        assert.match(payload.messages[0].content, /exact timestamp.*\[S1 @ HH:MM:SS\]/);
        return Response.json({ choices: [{ message: { content: 'The budget is 17 credits [S1 @ 00:00:00].' } }] });
      }
      const images = payload.messages[1].content.filter(part => part.type === 'image_url');
      assert.ok(images.length > 0 && images.length <= VIDEO_LIMITS.frames);
      for (const image of images) {
        const imageBytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
        assert.equal(imageBytes.readUInt16BE(), 0xffd8, 'Real JPEG extraction must be used');
      }
      if (failVisuals) return new Response('', { status: 429 });
      return Response.json({
        choices: [{ finish_reason: 'stop', message: { content: '[00:00:00] A blue screen is visible. These are sampled observations only.' } }],
      });
    },
  };
}

async function appFixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'executive-video-api-'));
  const app = createApp({ directory, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${app.address().port}`;
}

test('real video decoding extracts timestamped audio and JPEG evidence; media is cleaned up', async t => {
  const { root, bytes } = await mediaFixture(t);
  const mock = providerMock();
  const result = await ingestVideo({
    stream: Readable.from([bytes]), input, apiKey: 'test-key', model: 'test-vision',
    fetcher: mock.fetcher, temporaryRoot: root,
  });
  assert.equal(result.duration, 2);
  assert.equal(result.hasAudio, true);
  assert.equal(result.frames, 1);
  assert.match(result.content, /\[00:00:00 - 00:00:01\].*moonstone/);
  assert.match(result.content, /AI-GENERATED SAMPLED VISUAL OBSERVATIONS/);
  assert.match(result.content, /blue screen/);
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('silent video is analyzed visually without inventing a speech transcript', async t => {
  const { root, bytes } = await mediaFixture(t, { audio: false });
  const mock = providerMock();
  const result = await ingestVideo({
    stream: Readable.from([bytes]), input, apiKey: 'test-key', model: 'test-vision',
    fetcher: mock.fetcher, temporaryRoot: root,
  });

  assert.equal(result.hasAudio, false);
  assert.match(result.content, /No audio track/);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('truncated visual responses retry without repeating audio transcription', async t => {
    t.mock.method(console, 'warn', () => {});
    const { root, bytes } = await mediaFixture(t);
    const mock = providerMock();
    let visuals = 0;
    const result = await ingestVideo({
      stream: Readable.from([bytes]), input, apiKey: 'test-key', model: 'test-vision', temporaryRoot: root,
      fetcher: async (url, options) => {
        if (!url.endsWith('/audio/transcriptions')) {
          assert.equal(JSON.parse(options.body).max_completion_tokens, 16_384);
          visuals++;
          if (visuals === 1) return Response.json({ choices: [{ finish_reason: 'length', message: { content: 'Partial observation' } }] });
        }
        return mock.fetcher(url, options);
      },
    });
    assert.equal(visuals, 2);
    assert.equal(mock.calls.filter(call => call.url.endsWith('/audio/transcriptions')).length, 1);
    assert.doesNotMatch(result.content, /Partial observation/);
    assert.match(result.content, /blue screen/);
  });

test('longer videos use bounded frames and chunked audio with global timestamps', async t => {
  const { root, bytes } = await mediaFixture(t, { duration: 301 });
  const mock = providerMock();
  const result = await ingestVideo({
    stream: Readable.from([bytes]), input: { ...input, participants: JSON.stringify([
      { kind: 'speech', name: 'Late speaker', start: 300, end: 301 },
    ]) }, apiKey: 'test-key', model: 'test-vision',
    fetcher: mock.fetcher, temporaryRoot: root,
  });
  assert.equal(mock.calls.filter(call => call.url.endsWith('/audio/transcriptions')).length, 2);
  assert.match(result.content, /\[00:05:00 - 00:05:01\]/);
  assert.match(result.content, /\[00:05:00 - 00:05:01\] Speaker: Late speaker \(user-labeled\)/);
  assert.equal(result.frames, 11);
  assert.match(result.content, /00:05:00/);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('invalid media, missing key, empty uploads and size limits fail explicitly with cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'executive-video-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = {
    input, apiKey: 'test-key', model: 'test-vision', temporaryRoot: root,
    fetcher: async () => { throw new Error('Provider must not be called for invalid media'); },
  };
  await assert.rejects(ingestVideo({ ...base, stream: Readable.from([]), apiKey: '' }), /OPENAI_API_KEY/);
  await assert.rejects(ingestVideo({
    ...base, stream: Readable.from([]), input: { ...input, filename: 'audio.exe' },
  }), /MP4/);
  await assert.rejects(ingestVideo({ ...base, stream: Readable.from([]) }), /empty/);
  await assert.rejects(ingestVideo({ ...base, stream: Readable.from([Buffer.from('not a video')]) }), /decoded/);
  const declaredOversize = Readable.from([]);
  assert.equal(VIDEO_LIMITS.bytes, 3_221_225_472);
  const atLimit = Readable.from([]);
  atLimit.headers = { 'content-length': String(VIDEO_LIMITS.bytes) };
  await assert.rejects(ingestVideo({ ...base, stream: atLimit }), /empty/);
  declaredOversize.headers = { 'content-length': String(VIDEO_LIMITS.bytes + 1) };
  await assert.rejects(ingestVideo({ ...base, stream: declaredOversize }), /3 GB/);
  // Model chunk sizes without allocating or writing a multi-gigabyte fixture.
  const streamedOversize = Readable.from([
    Buffer.from('small first chunk'), { length: VIDEO_LIMITS.bytes },
  ]);
  await assert.rejects(ingestVideo({ ...base, stream: streamedOversize }), /3 GB/);
  assert.deepEqual(await readdir(root), []);
});

test('videos longer than one hour are accepted, including participant ranges and visual samples', async t => {
  const { root, bytes } = await mediaFixture(t, { audio: false, duration: 3601 });
  const mock = providerMock();
  const result = await ingestVideo({
    stream: Readable.from([bytes]), input: { ...input, participants: JSON.stringify([
      { kind: 'screen', name: 'Late speaker', start: 3600, end: 3601, cue: 'right side' },
    ]) }, apiKey: 'test-key', model: 'test-vision',
    fetcher: mock.fetcher, temporaryRoot: root,
  });
  assert.equal(result.duration, 3601);
  assert.equal(result.frames, VIDEO_LIMITS.frames);
  const payload = JSON.parse(mock.calls[0].options.body);
  assert.equal(payload.messages[1].content.filter(part => part.type === 'image_url').length, 12);
  assert.match(result.content, /01:00:01/);
  assert.match(result.content, /\[01:00:00 - 01:00:01\] On-screen: Late speaker/);
  assert.match(payload.messages[1].content.at(-2).text, /01:00:00.*Late speaker/);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('provider and malformed-response failures delete temporary media and do not produce analysis', async t => {
  const { root, bytes } = await mediaFixture(t);
  const mock = providerMock({ failVisuals: true });
  const base = {
    input, apiKey: 'test-key', model: 'test-vision', temporaryRoot: root,
  };
  await assert.rejects(ingestVideo({
    ...base, stream: Readable.from([bytes]), fetcher: mock.fetcher,
  }), /Visual analysis failed \(HTTP 429\)/);
  await assert.rejects(ingestVideo({
    ...base, stream: Readable.from([bytes]), fetcher: async () => Response.json({ text: 'Missing timestamps' }),
  }), /invalid transcript/);
  await assert.rejects(ingestVideo({
    ...base, stream: Readable.from([bytes]), fetcher: async () => { throw new Error('Connection interrupted'); },
  }), /Connection interrupted/);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('explicit whole-recording API import indexes analysis, supports source viewing, respects scopes, and deletes derived knowledge', async t => {
  const { bytes } = await mediaFixture(t);
  const mock = providerMock();
  const base = await appFixture(t, { apiKey: 'test-key', model: 'test-vision', fetcher: mock.fetcher, generalizer: async () => '' });
  const upload = await fetch(`${base}/api/videos?${new URLSearchParams({ ...input, profileId: 'jordan', reviewSpeakers: 'false' })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
  });

  assert.equal(upload.status, 200);
  const result = await upload.json();
  assert.equal(result.frames, 1);
  const source = await (await fetch(`${base}/api/documents/${result.id}`)).json();
  const original = await fetch(`${base}/api/documents/${result.id}/original`);
  assert.equal(original.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  assert.match(source.content, /moonstone/);
  assert.equal(source.scope, 'enriched');
  const context = { executiveId: input.executiveId, profileId: 'jordan', mode: 'enriched' };
  const query = overrides => new URLSearchParams({ ...context, ...overrides });
  for (const [overrides, present] of [[{}, true], [{ mode: 'public' }, false], [{ profileId: 'alex', mode: 'twin' }, false], [{ profileId: 'alex' }, false]]) {
    const docs = await (await fetch(`${base}/api/documents?${query(overrides)}`)).json();
    assert.equal(docs.some(document => document.id === result.id), present);
  }
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, question: 'moonstone?' }),
  });
  // Use source evidence in the normal chat request as well.
  assert.equal(chat.status, 200);
  const answer = await chat.json();
  assert.equal(answer.sources[0].documentId, result.id);
  assert.equal(answer.sources[0].video, true);
  assert.ok(answer.sources[0].videoTimestamps.includes('00:00:00'));
  assert.match(answer.content, /\[S1 @ 00:00:00\]/);
  assert.match(answer.sources[0].text, /00:00:00/);
  assert.equal((await fetch(`${base}/api/documents/${result.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/documents/${result.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/documents/${result.id}/original`)).status, 404);
});

test('default media uploads stage precise speech for speaker review without indexing the meeting', async t => {
  const { bytes } = await mediaFixture(t);
  const mock = providerMock();
  const base = await appFixture(t, {
    apiKey: 'test-key', model: 'test-vision',
    fetcher: async (url, options) => {
      if (typeof options.body === 'string') {
        const payload = JSON.parse(options.body);
        if (typeof payload.messages[1].content === 'string') {
          assert.doesNotMatch(payload.messages.at(-2).content, /moonstone/);
          return Response.json({ choices: [{ message: { content: 'No documented budget available.' } }] });
        }
      }
      return mock.fetcher(url, options);
    },
  });
  const upload = await fetch(`${base}/api/media?${new URLSearchParams(input)}`, { method: 'POST', body: bytes });
  assert.equal(upload.status, 200);
  const source = await upload.json();
  assert.equal(source.needsSpeakerReview, true);
  const review = await (await fetch(`${base}/api/documents/${source.id}/speakers`)).json();
  assert.ok(review.segments.length);
  assert.ok(review.segments[0].text.includes('moonstone'));
  assert.deepEqual(review.assignments, review.segments.map(() => null));
  const context = { executiveId: input.executiveId, profileId: 'alex', mode: 'enriched' };
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, question: 'moonstone?' }),
  });
  assert.equal(chat.status, 200);
  const answer = await chat.json();
  assert.deepEqual(answer.sources, []);
});

test('video endpoint rejects missing configuration and invalid context without saving documents', async t => {
  const base = await appFixture(t, { apiKey: '' });
  const response = await fetch(`${base}/api/videos?${new URLSearchParams(input)}`, {
    method: 'POST', body: 'not a video',
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENAI_API_KEY/);
  const invalid = await fetch(`${base}/api/videos?${new URLSearchParams({ ...input, executiveId: 'missing' })}`, {
    method: 'POST', body: 'not a video',
  });
  assert.equal(invalid.status, 404);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.video.enabled, false);
  assert.equal(state.video.bytes, VIDEO_LIMITS.bytes);
});

test('only one video runs at a time; a failed analysis creates no document and releases the processing slot', async t => {
  const { bytes } = await mediaFixture(t);
  const logger = t.mock.method(console, 'error', () => {});
  let release;
  let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const reachedProvider = new Promise(resolve => { started = resolve; });
  const base = await appFixture(t, {
    apiKey: 'test-key',
    fetcher: async () => {
      started();
      await waiting;
      return new Response('', { status: 401 });
    },
  });
  const upload = () => fetch(`${base}/api/videos?${new URLSearchParams(input)}`, {
    method: 'POST', body: bytes,
  });
  const first = upload();
  await reachedProvider;
  try {
    const second = await upload();
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /Another video/);
  } finally { release(); }
  const failed = await first;
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /HTTP 401/);
  const docs = await (await fetch(`${base}/api/documents?${new URLSearchParams({
    executiveId: input.executiveId, profileId: input.profileId, mode: 'enriched',
  })}`)).json();
  assert.ok(!docs.some(document => document.title === input.title));
  // The slot must be free even after a provider failure.
  const next = await upload();
  assert.equal(next.status, 502);
  assert.equal(logger.mock.callCount(), 4);
});

test('timestamp formatting handles minute and hour boundaries', () => {
  assert.equal(timestamp(0), '00:00:00');
  assert.equal(timestamp(61.8), '00:01:01');
  assert.equal(timestamp(3601), '01:00:01');
});

test('partial transcription retains good clips on both sides of a failed range and warns explicitly', async t => {
  t.mock.method(console, 'error', () => {});
  const { root, bytes } = await mediaFixture(t, { duration: 241 });
  let calls = 0;
  const result = await ingestVideo({
    stream: Readable.from([bytes]), input: { ...input, filename: 'audio.m4a' },
    apiKey: 'test-key', model: 'gemini-3.7-flash', provider: geminiProvider, temporaryRoot: root, allowPartial: true,
    fetcher: async () => {
      calls++;
      if (calls === 2) return new Response('', { status: 429 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        text: 'Good speech', segments: [{ start: 0, end: 1, text: 'Good speech' }],
      }) } }] });
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.segments.map(segment => segment.start), [0, 240]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /seconds 120-240.*HTTP 429/);
  assert.match(result.content, /ANALYSIS WARNINGS/);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('partial upload saves usable transcript when visual analysis fails and persists warnings across reopen', async t => {
  t.mock.method(console, 'error', () => {});
  const { bytes } = await mediaFixture(t);
  const mock = providerMock({ failVisuals: true });
  const base = await appFixture(t, { apiKey: 'test-key', model: 'test-vision', fetcher: mock.fetcher });
  const response = await fetch(`${base}/api/media?${new URLSearchParams(input)}`, { method: 'POST', body: bytes });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.match(saved.warnings[0], /Visual overview analysis failed.*HTTP 429/);
  const review = await (await fetch(`${base}/api/documents/${saved.id}/speakers`)).json();
  assert.deepEqual(review.warnings, saved.warnings);
  assert.equal(review.segments.length, 1);
  const published = await fetch(`${base}/api/documents/${saved.id}/speakers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: ['alex-executive'] }),
  });
  assert.equal(published.status, 200);
  const result = await published.json();
  const knowledge = await (await fetch(`${base}/api/documents/${result.generated[0].documentId}`)).json();
  assert.match(knowledge.content, /moonstone/);
  assert.doesNotMatch(knowledge.content, /Visual overview analysis failed|HTTP 429/);
  assert.deepEqual((await (await fetch(`${base}/api/documents/${saved.id}/speakers`)).json()).warnings, saved.warnings);
});

test('streamed media progress arrives before the provider finishes and ends with a persisted result', async t => {
  const { bytes } = await mediaFixture(t);
  const mock = providerMock();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const base = await appFixture(t, {
    apiKey: 'test-key', model: 'test-vision',
    fetcher: async (...args) => { await waiting; return mock.fetcher(...args); },
  });
  const response = await fetch(`${base}/api/media?${new URLSearchParams({ ...input, progress: 'true' })}`, {
    method: 'POST', body: bytes,
  });
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const first = await reader.read();
  assert.match(first.value, /"type":"progress"/);
  assert.match(first.value, /Upload received/);
  release();
  let output = first.value;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += value;
  }
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  const updates = events.filter(event => event.type === 'progress');
  assert.ok(updates.some(event => event.message.startsWith('Transcribed')));
  assert.ok(updates.some(event => event.message.startsWith('Extracting video frame')));
  assert.ok(updates.some(event => event.message.startsWith('Analyzing sampled')));
  assert.equal(updates.at(-1).percent, 98);
  assert.ok(updates.every((event, index) => event.percent < 100 && (!index || event.percent >= updates[index - 1].percent)));
  assert.equal(events.at(-1).type, 'result');
  const saved = await (await fetch(`${base}/api/documents/${events.at(-1).result.id}`)).json();
  assert.equal(saved.title, input.title);
});

test('streamed provider errors are explicit, never complete, and release the analysis slot', async t => {
  const { bytes } = await mediaFixture(t);
  t.mock.method(console, 'error', () => {});
  const base = await appFixture(t, {
    apiKey: 'test-key', fetcher: async () => new Response('', { status: 429 }),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${base}/api/media?${new URLSearchParams({ ...input, progress: 'true' })}`, {
      method: 'POST', body: bytes,
    });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).error, /HTTP 429/);
    assert.ok(!events.some(event => event.type === 'result' || event.percent === 100));
  }
  const docs = await (await fetch(`${base}/api/documents?${new URLSearchParams({
    executiveId: input.executiveId, profileId: input.profileId, mode: 'enriched',
  })}`)).json();
  assert.ok(!docs.some(document => document.title === input.title));
});
