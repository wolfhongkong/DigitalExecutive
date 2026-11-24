import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import ffmpeg from 'ffmpeg-static';
import { diarizeRecording } from '../lib/diarization.js';
import { providerConfig } from '../lib/provider.js';
import { createStore } from '../lib/store.js';
import { createApp } from '../server.js';
import { recordingFrame, recordingSample } from '../lib/video.js';
import { clusterFingerprintTurns } from '../lib/voice-fingerprints.js';

const execute = promisify(execFile);
const provider = providerConfig({
  AI_PROVIDER: 'llm-farm', AI_MODEL: 'gemini-3.7-flash', AI_TRANSCRIPTION_MODE: 'gemini',
  AI_CHAT_URL: 'https://aoai-farm.bosch-temp.com/api/openai/deployments/gemini-3.7-flash/chat/completions?api-version=2025-04-01-preview',
});
const segments = [
  { start: 0, end: 2, text: 'Do not send this transcript or an executive name.' },
  { start: 121, end: 123, text: 'Second anonymous speaker.' },
  { start: 125, end: 127, text: 'First speaker returns.' },
  { start: 128, end: 130, text: 'Unclear or mixed speech.' },
];
const envelope = turns => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ turns }) } }] });
const turn = (index, speaker, confidence = 'high', visualCue = null, visualFrame = null) => ({ index, speaker, confidence, visualCue, visualFrame });

async function fixture(t, duration = 131) {
  const root = await mkdtemp(join(tmpdir(), 'executive-tracks-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.mp4');
  await execute(ffmpeg, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=64x64:r=1:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='gte(t,120)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path,
  ]);
  return { root, path };
}

test('new Gemini uploads automatically separate voices before review; failures retain completed analysis with an explicit persistent error and retry', async t => {
  const { root, path } = await fixture(t);
  const directory = join(root, 'auto-data');
  let transcriptCalls = 0;
  let trackCalls = 0;
  let failTracks = false;
  let silent = false;
  const app = createApp({
    directory, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash',
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      const name = body.response_format?.json_schema.name;
      if (name === 'timestamped_transcript') {
        const second = transcriptCalls++ % 2 === 1;
        const speech = silent ? [] : second
          ? [{ start: 1, end: 3, text: 'First voice returns later.' }]
          : [{ start: 0, end: 2, text: 'First voice.' }, { start: 4, end: 6, text: 'Second voice.' }];
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          text: speech.map(segment => segment.text).join(' '), segments: speech,
        }) } }] });
      }
      if (name === 'anonymous_speaker_turns') {
        trackCalls++;
        if (failTracks) return new Response('', { status: 429 });
        const known = body.messages[1].content[0].text.includes('speaker-1');
        return envelope(known
          ? [turn(2, 'speaker-1', 'high', 'Person in the center against a red background', 1)]
          : [turn(0, 'new-1', 'high', 'Person on the left against a blue background', 1), turn(1, 'new-2')]);
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Blue slide, later a red slide. No speaker identity is inferred.' } }] });
    },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const bytes = await readFile(path);
  const upload = (progress = false) => fetch(`${base}/api/media?${new URLSearchParams({
    executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched', title: 'Automatic voices', filename: 'meeting.mp4',
    ...(progress ? { progress: 'true' } : {}),
  })}`, { method: 'POST', body: bytes });
  const response = await upload(true);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.message?.startsWith('Separating recurring voices:')).map(event => event.percent), [90, 95]);
  assert.equal(events.at(-1).type, 'result');
  const source = events.at(-1).result;
  assert.deepEqual(source.warnings, []);
  assert.equal(source.needsSpeakerReview, true);
  const review = await (await fetch(`${base}/api/documents/${source.id}/speakers`)).json();
  assert.deepEqual(review.segments.map(segment => segment.speakerId), ['speaker-1', 'speaker-2', 'speaker-1']);
  assert.deepEqual(review.segments[0].speakerVisual, { description: 'Person on the left against a blue background', seconds: 1 });
  assert.deepEqual(review.segments[2].speakerVisual, { description: 'Person in the center against a red background', seconds: 122 });
  assert.deepEqual(review.assignments, [null, null, null]);
  assert.equal(transcriptCalls, 2);
  assert.equal(trackCalls, 2);
  const store = createStore(directory);
  assert.deepEqual(store.retrieve({ executiveId: 'alex-executive', profileId: 'alex', mode: 'enriched' }, 'voice'), []);
  store.close();
  failTracks = true;
  t.mock.method(console, 'error', () => {});
  const failed = await upload();
  assert.equal(failed.status, 200, 'Completed transcription is saved even if later voice grouping fails');
  const saved = await failed.json();
  assert.match(saved.warnings[0], /Automatic speaker detection failed:.*No distinct speakers/s);
  assert.match(saved.warnings[0], /HTTP 429/);
  const pending = await (await fetch(`${base}/api/documents/${saved.id}/speakers`)).json();
  assert.equal(pending.segments.length, 3);
  assert.ok(pending.segments.every(segment => !segment.speakerId));
  assert.equal(pending.trackingError, saved.warnings[0]);
  assert.equal((await fetch(`${base}/api/documents/${saved.id}/original`)).status, 200);
  failTracks = false;
  const beforeRetry = transcriptCalls;
  const retry = await fetch(`${base}/api/documents/${saved.id}/speaker-tracks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).trackingError, '');
  assert.equal(transcriptCalls, beforeRetry, 'Retrying voice grouping must not repeat transcription');
  silent = true;
  const beforeSilent = trackCalls;
  const silence = await upload();
  assert.equal(silence.status, 200);
  const silentSource = await silence.json();
  assert.deepEqual((await (await fetch(`${base}/api/documents/${silentSource.id}/speakers`)).json()).segments, []);
  assert.equal(trackCalls, beforeSilent);
});

test('anonymous speaker references track returning voices across clips without sending identities or transcript text', async t => {
  const { root, path } = await fixture(t);
  let calls = 0;
  const result = await diarizeRecording({
    path, segments, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async (url, options) => {
      assert.equal(url, provider.chatUrl);
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gemini-3.7-flash');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.ok(body.messages[0].content.includes('Never identify real people'));
      assert.ok(!options.body.includes(segments[0].text));
      const audio = body.messages[1].content.filter(part => part.type === 'input_audio');
      assert.equal(audio.length, ++calls === 1 ? 1 : 2);
      assert.ok(audio.every(part => Buffer.from(part.input_audio.data, 'base64').length > 100));
      if (calls === 1) return envelope([turn(0, 'new-1')]);
      assert.match(body.messages[1].content[0].text, /speaker-1/);
      return envelope([turn(1, 'new-1'), turn(2, 'speaker-1'), turn(3, 'speaker-1', 'uncertain')]);
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.map(segment => segment.speakerId), ['speaker-1', 'speaker-2', 'speaker-1', null]);
  assert.deepEqual(result.map(({ speakerId, ...segment }) => segment), segments);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('fingerprint overflow retains speaker tracks on upload with a per-turn warning instead of failing all analysis', async t => {
  const { root, path } = await fixture(t);
  let transcriptionCalls = 0;
  const app = createApp({
    directory: join(root, 'overflow-data'), provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash',
    fingerprints: { enabled: true },
    fingerprinter: async options => clusterFingerprintTurns(options.segments, new Map(options.segments.map((segment, index) =>
      [index, Array.from({ length: 192 }, (_, position) => Number(position === index))]))),
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      const name = body.response_format?.json_schema.name;
      if (name === 'timestamped_transcript') {
        const speech = transcriptionCalls++ === 0 ? Array.from({ length: 21 }, (_, index) =>
          ({ start: index * 4, end: index * 4 + 3, text: 'Single speaker turn.' })) : [];
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          text: speech.map(segment => segment.text).join(' '), segments: speech,
        }) } }] });
      }
      if (name === 'anonymous_speaker_turns') {
        const known = body.messages[1].content[0].text.includes('speaker-1');
        return envelope(body.response_format.json_schema.schema.properties.turns.items.properties.index.enum
          .map(index => turn(index, known ? 'speaker-1' : 'new-1')));
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Scene context only.' } }] });
    },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const response = await fetch(`${base}/api/media?${new URLSearchParams({
    executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched', title: 'Overflow review', filename: 'meeting.mp4',
  })}`, { method: 'POST', body: await readFile(path) });
  assert.equal(response.status, 200);
  const source = await response.json();
  assert.match(source.warnings.join('\n'), /reference capacity reached/);
  assert.doesNotMatch(source.warnings.join('\n'), /Automatic speaker detection failed|no fingerprint tracks were saved/);
  const review = await (await fetch(`${base}/api/documents/${source.id}/speakers`)).json();
  assert.equal(review.segments.filter(segment => segment.speakerId).length, 20);
  assert.equal(review.segments[20].speakerId, null);
  assert.match(review.segments[20].speakerIssue, /Established groups are retained/);
  assert.deepEqual(review.assignments, Array(21).fill(null));
  assert.deepEqual(review.generated, []);
});

test('confirmed persistent fingerprints recognize a speaker on subsequent HTTP uploads without exposing vectors or auto-publishing', async t => {
  const { root, path } = await fixture(t);
  let transcription = 0;
  const app = createApp({
    directory: join(root, 'remembered-data'), provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash',
    fingerprints: { enabled: true },
    fingerprinter: async options => clusterFingerprintTurns(options.segments, new Map([
      [0, [1, ...Array(191).fill(0)]], [1, [0, 1, ...Array(190).fill(0)]],
    ])),
    fetcher: async (_url, options) => {
      const name = JSON.parse(options.body).response_format?.json_schema.name;
      if (name === 'timestamped_transcript') {
        const speech = transcription++ % 2 === 0
          ? [{ start: 0, end: 3, text: 'First voice' }, { start: 4, end: 7, text: 'Second voice' }] : [];
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
          text: speech.map(segment => segment.text).join(' '), segments: speech,
        }) } }] });
      }
      if (name === 'anonymous_speaker_turns') return envelope([turn(0, 'new-1'), turn(1, 'new-2')]);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'No identity inferred from video.' } }] });
    },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const bytes = await readFile(path);
  const upload = async () => {
    const response = await fetch(`${base}/api/media?${new URLSearchParams({
      executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched', title: 'Recurring people', filename: 'meeting.mp4',
    })}`, { method: 'POST', body: bytes });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await upload();
  const reviewRoute = `${base}/api/documents/${first.id}/speakers`;
  assert.equal((await (await fetch(reviewRoute)).json()).hasVoiceFingerprints, true);
  const remembered = await fetch(reviewRoute, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: true, assignments: ['alex-executive', null] }) });
  assert.equal(remembered.status, 200);
  const second = await upload();
  const secondReview = await (await fetch(`${base}/api/documents/${second.id}/speakers`)).json();
  assert.deepEqual(secondReview.assignments, ['alex-executive', null]);
  assert.deepEqual(secondReview.voiceSuggestions, ['alex-executive', null]);
  assert.deepEqual(secondReview.generated, []);
  assert.doesNotMatch(JSON.stringify(secondReview), /"embedding"|"voiceFingerprint"/);
  const profiles = await (await fetch(`${base}/api/voice-profiles?profileId=alex`)).json();
  assert.equal(profiles[0].executiveId, 'alex-executive');
  assert.deepEqual(await (await fetch(`${base}/api/voice-profiles?profileId=jordan`)).json(), profiles);
  assert.equal((await fetch(`${base}/api/voice-profiles?profileId=alex`, { method: 'DELETE' })).status, 200);
  const third = await upload();
  assert.deepEqual((await (await fetch(`${base}/api/documents/${third.id}/speakers`)).json()).assignments, [null, null]);
});

test('audiovisual analysis covers early and late speech, reuses references, and excludes legacy zero-duration entries without aborting', async t => {
  const { root, path } = await fixture(t);
  const speech = [
    { start: 0, end: 0, text: 'Invalid legacy timestamp' },
    segments[0], segments[1], segments[2],
  ];
  let calls = 0;
  const result = await diarizeRecording({
    path, segments: speech, hasVideo: true, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      const content = body.messages[1].content;
      const images = content.filter(part => part.type === 'image_url');
      const audio = content.filter(part => part.type === 'input_audio');
      calls++;
      assert.equal(images.length, calls === 1 ? 3 : 7, 'Three frames per turn plus a retained speaker reference for later clips');
      assert.equal(audio.length, calls === 1 ? 1 : 2);
      for (const image of images) {
        assert.equal(Buffer.from(image.image_url.url.split(',')[1], 'base64').readUInt16BE(), 0xffd8);
      }
      assert.ok(!options.body.includes(speech[0].text), 'Untimed speech is not sent for guessing');
      assert.ok(!options.body.includes(speech[1].text), 'Speech text and executive names are not matching evidence');
      assert.match(body.messages[0].content, /audiovisual speaker diarization/);
      if (calls === 1) return envelope([turn(1, 'new-1', 'high', 'Left tile, blue jacket', 1)]);
      assert.match(content[0].text, /speaker-1/);
      assert.notEqual(images[0].image_url.url, images[1].image_url.url, 'Reference blue frame must differ from later red footage');
      return envelope([turn(2, 'new-1'), turn(3, 'speaker-1', 'high', 'Center tile, blue jacket', 1)]);
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.map(segment => segment.speakerId), [null, 'speaker-1', 'speaker-2', 'speaker-1']);
  assert.match(result[0].speakerIssue, /No usable speech duration/);
  assert.deepEqual(result[1].speakerVisual, { description: 'Left tile, blue jacket', seconds: 1 });
  assert.deepEqual(result[3].speakerVisual, { description: 'Center tile, blue jacket', seconds: 126 });
  assert.ok(!result[2].speakerVisual, 'Off-screen speakers must not acquire invented portraits');
  assert.deepEqual(result.map(segment => ({ start: segment.start, end: segment.end, text: segment.text })), speech);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('visual matches must reference supplied frames for that turn; invalid visual output retries and fails explicitly', async t => {
  t.mock.method(console, 'warn', () => {});
  const { root, path } = await fixture(t);
  for (const invalid of [
    turn(0, 'new-1', 'high', 'Invented frame', 50),
    turn(0, 'new-1', 'high', '', 1),
    turn(0, 'new-1', 'high', 'No matching time', null),
    turn(0, 'new-1', 'high', null, 1),
  ]) {
    let calls = 0;
    await assert.rejects(diarizeRecording({
      path, segments: segments.slice(0, 1), hasVideo: true, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
      fetcher: async () => { calls++; return envelope([invalid]); },
    }), /Speaker tracking returned invalid output/);
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(root), ['fixture.mp4']);
  }
  await assert.rejects(diarizeRecording({
    path, segments: [{ start: 0, end: 0, text: 'Untimed' }], provider, apiKey: 'fixture-key', temporaryRoot: root,
  }), /no speech segments with usable duration/);
});

test('fractional timestamps use stable frame numbers and retain exact server-side preview times', async t => {
  const { root, path } = await fixture(t);
  const speech = [{ start: 121.137, end: 123.826, text: 'Fractional timing' }];
  const result = await diarizeRecording({
    path, segments: speech, hasVideo: true, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      const schema = body.response_format.json_schema.schema.properties.turns;
      assert.deepEqual(schema.items.properties.index.enum, [0]);
      assert.deepEqual(schema.items.properties.speaker.enum, [null, 'new-1']);
      assert.deepEqual(schema.items.properties.visualFrame.enum, [0, 1, 2, null]);
      assert.equal(schema.minItems, 1);
      assert.equal(schema.maxItems, 1);
      const labels = body.messages[1].content.filter(part => part.text?.includes('visualFrame'));
      assert.ok(labels.some(part => part.text.includes('visualFrame 2, at clip-relative second 1.944')));
      return envelope([turn(0, 'new-1', 'high', 'Center tile', 2)]);
    },
  });
  assert.equal(result[0].speakerId, 'speaker-1');
  assert.equal(result[0].speakerVisual.seconds, (speech[0].start + speech[0].end) / 2 + 0.6);
});

test('speaker enrollment uses the strongest clean turn regardless of response or transcript order', async t => {
  const { root, path } = await fixture(t);
  const speech = [
    { start: 5, end: 11, text: 'Long reference' },
    { start: 0, end: 0.4, text: 'Brief first turn' },
    { start: 121, end: 123, text: 'Returning voice' },
  ];
  let calls = 0;
  const result = await diarizeRecording({
    path, segments: speech, provider, apiKey: 'fixture-key', temporaryRoot: root,
    fetcher: async (_url, options) => {
      const content = JSON.parse(options.body).messages[1].content;
      if (++calls === 1) return envelope([turn(1, 'new-1'), turn(0, 'new-1')]);
      assert.match(content.find(part => part.text?.startsWith('Reference speaker-1')).text, /6.00 seconds/);
      return envelope([turn(2, 'speaker-1')]);
    },
  });
  assert.deepEqual(result.map(segment => segment.speakerId), ['speaker-1', 'speaker-1', 'speaker-1']);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('enabled voice fingerprints refine accepted turns and worker failures do not silently fall back to AI groups', async t => {
  const { root, path } = await fixture(t);
  let calls = 0;
  const options = {
    path, segments: segments.slice(0, 1), provider, apiKey: 'fixture-key', temporaryRoot: root,
    fingerprints: { enabled: true, python: '/isolated/python' },
    fetcher: async () => envelope([turn(0, 'new-1')]),
  };
  const result = await diarizeRecording({
    ...options,
    fingerprinter: async input => {
      calls++;
      assert.equal(input.path, path);
      assert.equal(input.config.python, '/isolated/python');
      assert.equal(input.segments[0].speakerId, 'speaker-1');
      return input.segments.map(segment => ({ ...segment, speakerId: 'speaker-2' }));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result[0].speakerId, 'speaker-2');
  const ungrouped = await diarizeRecording({ ...options,
    fingerprinter: async input => input.segments.map(segment => ({ ...segment, speakerId: null,
      voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [1, ...Array(191).fill(0)] } })),
  });
  assert.equal(ungrouped[0].speakerId, null);
  assert.ok(ungrouped[0].voiceFingerprint);
  await assert.rejects(diarizeRecording({ ...options, fingerprinter: async () => { throw new Error('Worker unavailable'); } }), /Worker unavailable/);
  await assert.rejects(diarizeRecording({ ...options,
    fingerprinter: async input => input.segments.map(segment => ({ ...segment, speakerId: null })),
  }), /No speakers had usable/);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('returning voices refresh a bounded reference bank and long video turns use nearby synchronized frames', async t => {
  const { root, path } = await fixture(t);
  const audioPath = join(root, 'voices.wav');
  await execute(ffmpeg, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=366',
    '-ar', '16000', '-ac', '1', audioPath,
  ]);
  const speech = [
    { start: 0, end: 2, text: 'Initial sample' },
    { start: 121, end: 127, text: 'Better sample' },
    { start: 242, end: 252, text: 'Strongest sample' },
    { start: 363, end: 365, text: 'Return' },
  ];
  let calls = 0;
  const result = await diarizeRecording({
    path: audioPath, segments: speech, provider, apiKey: 'fixture-key', temporaryRoot: root,
    fetcher: async (_url, options) => {
      const content = JSON.parse(options.body).messages[1].content;
      const referenceLabels = content.filter(part => part.text?.startsWith('Reference speaker-1'));
      const audio = content.filter(part => part.type === 'input_audio');
      assert.equal(audio.length, Math.min(calls, 2) + 1);
      assert.ok(audio.every(part => Buffer.from(part.input_audio.data, 'base64').length > 100));
      if (calls === 3) {
        assert.match(referenceLabels[0].text, /8.00 seconds/);
        assert.match(referenceLabels[1].text, /6.00 seconds/);
      }
      return envelope([turn(calls, calls++ === 0 ? 'new-1' : 'speaker-1')]);
    },
  });
  assert.ok(result.every(segment => segment.speakerId === 'speaker-1'));
  await diarizeRecording({
    path, segments: [{ start: 121, end: 131, text: 'Long video turn' }], hasVideo: true,
    provider, apiKey: 'fixture-key', temporaryRoot: root,
    fetcher: async (_url, options) => {
      const content = JSON.parse(options.body).messages[1].content;
      const labels = content.filter(part => part.text?.startsWith('Turn index'));
      assert.ok(labels[0].text.includes('4.400'));
      assert.ok(labels[1].text.includes('5.000'));
      assert.ok(labels[2].text.includes('5.600'));
      return envelope([turn(0, 'new-1', 'high', 'Center tile', 1)]);
    },
  });
  assert.deepEqual((await readdir(root)).sort(), ['fixture.mp4', 'voices.wav']);
});

test('invalid speaker responses retry the same clip with precise corrective feedback and no speech content in diagnostics', async t => {
  const logger = t.mock.method(console, 'warn', () => {});
  const { root, path } = await fixture(t);
  for (const [invalid, reason] of [
    [[turn(99, 'new-1')], /index must be one of/],
    [[turn(0, 'Named Person')], /supplied anonymous label/],
    [[turn(0, 'new-1', 'very sure')], /confidence must be high or uncertain/],
    [[turn(0, 'new-1', 'high', 'Center', 0.4)], /supplied per-turn frame number/],
    [[], /expected 1 turns, received 0/],
  ]) {
    let calls = 0;
    let originalContent;
    const result = await diarizeRecording({
      path, segments: segments.slice(0, 1), hasVideo: true, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
      fetcher: async (_url, options) => {
        const body = JSON.parse(options.body);
        calls++;
        if (calls === 1) {
          originalContent = body.messages[1].content;
          return envelope(invalid);
        }
        assert.deepEqual(body.messages[1].content, originalContent, 'Retries must preserve audio and frames');
        assert.match(body.messages[2].content, reason);
        assert.ok(!body.messages[2].content.includes('Named Person'));
        return envelope([turn(0, 'new-1', 'high', 'Center', 1)]);
      },
    });
    assert.equal(calls, 2);
    assert.equal(result[0].speakerId, 'speaker-1');
  }
  assert.equal(logger.mock.callCount(), 5);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('a missing late frame never reuses an earlier speaker image and cleans all temporary media', async t => {
  const { root, path } = await fixture(t);
  let calls = 0;
  await assert.rejects(diarizeRecording({
    path, segments: [segments[0], { start: 131.1, end: 132, text: 'Past the end of the video' }],
    hasVideo: true, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async () => { calls++; return envelope([turn(0, 'new-1')]); },
  }), /No video frame could be decoded/);
  assert.equal(calls, 1, 'An out-of-range turn must not send a stale frame to the provider');
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('partial speaker analysis retains completed batches, excludes failed turns, and continues to later speech', async t => {
  t.mock.method(console, 'error', () => {});
  const { root, path } = await fixture(t);
  const speech = [
    { start: 0, end: 2, text: 'First speaker' },
    { start: 121, end: 123, text: 'Failed section' },
    { start: 124, end: 126, text: 'Same failed batch' },
    { start: 250, end: 252, text: 'Returning speaker' },
  ];
  let calls = 0;
  const result = await diarizeRecording({
    path, segments: speech, allowPartial: true, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async () => {
      calls++;
      if (calls === 1) return envelope([turn(0, 'new-1')]);
      if (calls === 2) return new Response('', { status: 429 });
      return envelope([turn(3, 'speaker-1')]);
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.map(segment => segment.speakerId), ['speaker-1', null, null, 'speaker-1']);
  assert.match(result[1].speakerIssue, /seconds 121-126.*HTTP 429/);
  assert.equal(result[1].speakerIssue, result[2].speakerIssue);
  assert.ok(!result[0].speakerIssue);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('invalid tracks retry once then fail without saving partial work; HTTP errors do not retry and temp files are cleaned', async t => {
  t.mock.method(console, 'warn', () => {});
  const { root, path } = await fixture(t);
  for (const invalid of [
    [turn(99, 'new-1')], [turn(0, 'Named Person')], [turn(0, 'speaker-99')],
    [turn(0, 'new-1', 'very sure')], [turn(0, 'new-1'), turn(0, 'new-1')],
  ]) {
    let calls = 0;
    await assert.rejects(diarizeRecording({
      path, segments: segments.slice(0, 1), provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
      fetcher: async () => { calls++; return envelope(invalid); },
    }), /Speaker tracking returned invalid output/);
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(root), ['fixture.mp4']);
  }
  await assert.rejects(diarizeRecording({
    path, segments: segments.slice(0, 1), provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async () => Response.json({ choices: [{ message: { content: 'Private model response is not JSON' } }] }),
  }), error => {
    assert.match(error.message, /invalid JSON/);
    assert.ok(!error.message.includes('Private model response'));
    return true;
  });
  let calls = 0;
  await assert.rejects(diarizeRecording({
    path, segments, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async () => { calls++; return new Response('', { status: 429 }); },
  }), /HTTP 429/);
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(root), ['fixture.mp4']);
});

test('overlapping or short new voices never become track anchors; silence and unavailable audio models fail explicitly', async t => {
  const { root, path } = await fixture(t);
  const overlapping = [{ start: 0, end: 2, text: 'one' }, { start: 1, end: 3, text: 'two' }, { start: 4, end: 4.5, text: 'brief' }];
  await assert.rejects(diarizeRecording({
    path, segments: overlapping, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash', temporaryRoot: root,
    fetcher: async () => envelope([turn(0, 'new-1'), turn(1, 'new-2'), turn(2, 'new-3')]),
  }), /No distinct speakers could be detected confidently/);
  await assert.rejects(diarizeRecording({ path, segments: [], provider, apiKey: 'key' }), /no speech/);
  await assert.rejects(diarizeRecording({ path, segments, provider, apiKey: '' }), /requires a configured Gemini/);
  await assert.rejects(diarizeRecording({ path, segments: [{ start: 2, end: 1 }], provider, apiKey: 'key' }), /valid non-empty/);
});

test('review API persists tracks without altering assignments or published RAG and serves actual frames at requested times', async t => {
  const { root, path } = await fixture(t, 3605);
  const directory = join(root, 'data');
  await mkdir(join(directory, 'originals'), { recursive: true });
  await copyFile(path, join(directory, 'originals', 'recording'));
  const store = createStore(directory);
  const source = store.insertRecording({
    executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched', title: 'Review', content: 'Recording analysis',
    original: { storageName: 'recording', filename: 'fixture.mp4', bytes: (await readFile(path)).length },
  }, segments.slice(0, 1));
  const published = store.publishRecording(source.id, ['alex-executive']);
  const previous = store.document(published.generated[0].documentId).content;
  store.close();
  let calls = 0;
  let fail = false;
  let gate;
  let entered;
  const app = createApp({
    directory, provider, apiKey: 'fixture-key', model: 'gemini-3.7-flash',
    fetcher: async () => {
      calls++;
      entered?.();
      if (gate) await gate;
      return fail ? new Response('', { status: 503 }) : envelope([turn(0, 'new-1')]);
    },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api/documents/${source.id}`;
  const post = body => fetch(`${base}/speaker-tracks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await post({});
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal(review.segments[0].speakerId, 'speaker-1');
  assert.deepEqual(review.assignments, ['alex-executive']);
  assert.equal((await (await fetch(base.replace(source.id, published.generated[0].documentId))).json()).content, previous);
  const frame = await fetch(`${base}/frame?seconds=1.5`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await frame.arrayBuffer()).readUInt16BE(), 0xffd8);
  const sample = await fetch(`${base}/voice-sample?start=121&end=123`);
  assert.equal(sample.status, 200);
  assert.equal(sample.headers.get('content-type'), 'audio/mpeg');
  const sampleBytes = Buffer.from(await sample.arrayBuffer());
  assert.ok(sampleBytes.length > 1000 && sampleBytes.length < 100_000, 'Sample should contain a short MP3, not the full video');
  for (const query of ['', '?start=0', '?start=0&end=', '?start=-1&end=1', '?start=NaN&end=2', '?start=3&end=3', '?start=0&end=13']) {
    assert.equal((await fetch(`${base}/voice-sample${query}`)).status, 400);
  }
  assert.equal((await fetch(`${base}/voice-sample?start=3600&end=3603`)).status, 200);
  assert.equal((await fetch(`${base.replace(source.id, 'missing')}/voice-sample?start=0&end=2`)).status, 404);
  const early = Buffer.from(await (await fetch(`${base}/frame?seconds=1.5`)).arrayBuffer());
  const later = Buffer.from(await (await fetch(`${base}/frame?seconds=125`)).arrayBuffer());
  assert.notDeepEqual(early, later, 'Requested time must select the corresponding video frame, not a fixed thumbnail');
  for (const query of ['', '?seconds=-1', '?seconds=NaN']) {
    assert.equal((await fetch(`${base}/frame${query}`)).status, 400);
  }
  assert.equal((await fetch(`${base}/frame?seconds=3601`)).status, 200);
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const running = post({});
  await started;
  try {
    assert.equal((await post({})).status, 409);
    const saved = await fetch(`${base}/speakers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: true, assignments: [null] }),
    });
    assert.equal(saved.status, 200);
  } finally { release(); }
  assert.equal((await running).status, 200);
  gate = undefined;
  assert.deepEqual((await (await fetch(`${base}/speakers`)).json()).assignments, [null], 'Concurrent draft edits must not be overwritten by completed AI analysis');
  fail = true;
  t.mock.method(console, 'error', () => {});
  assert.equal((await post({})).status, 502);
  assert.deepEqual((await (await fetch(`${base}/speakers`)).json()).segments, review.segments);
  assert.equal((await post({})).status, 502, 'Failure releases the analysis lock');
  const db = createStore(directory);
  assert.equal(db.recordingReview(source.id).segments[0].speakerId, 'speaker-1');
  db.saveRecordingReview(source.id, [null]);
  assert.throws(() => db.saveSpeakerTracks(source.id, segments, segments), /changed during speaker analysis/);
  db.close();
  await assert.rejects(recordingFrame(path, NaN), /Frame time/);
  await assert.rejects(recordingSample(path, 0, 13), /at most 12 seconds/);
});
