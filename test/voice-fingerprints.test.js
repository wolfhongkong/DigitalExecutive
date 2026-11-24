import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { voiceFingerprintConfig, validateFingerprints, clusterFingerprintTurns, fingerprintRecording, expectedSpeakerCount } from '../lib/voice-fingerprints.js';

const vector = (first, second = 0) => [first, second, ...Array(190).fill(0)];
const speech = (start, speakerId = 'speaker-1', duration = 3) => ({ start, end: start + duration, text: 'Speech', speakerId });

test('fingerprint configuration defaults on, supports explicit opt-out, and validates decision thresholds', () => {
  assert.equal(voiceFingerprintConfig({}).enabled, true);
  assert.equal(voiceFingerprintConfig({ VOICE_FINGERPRINTS: 'off' }).enabled, false);
  assert.equal(voiceFingerprintConfig({ VOICE_FINGERPRINTS: 'speechbrain' }).enabled, true);
  assert.equal(voiceFingerprintConfig({}).identityThreshold, 0.8);
  assert.equal(voiceFingerprintConfig({ VOICE_IDENTITY_THRESHOLD: '0.65' }).identityThreshold, 0.65);
  for (const value of ['NaN', '0', '-1', '1.1']) {
    assert.throws(() => voiceFingerprintConfig({ VOICE_IDENTITY_THRESHOLD: value }));
  }
  for (const env of [{ VOICE_FINGERPRINTS: 'unknown' }, { VOICE_FINGERPRINT_THRESHOLD: 'NaN' },
    { VOICE_FINGERPRINT_MARGIN: '-1' }, { VOICE_FINGERPRINT_NEW_THRESHOLD: '0.9' }]) {
    assert.throws(() => voiceFingerprintConfig(env));
  }
});

test('worker output requires complete, finite 192-dimensional normalized vectors', () => {
  assert.deepEqual(validateFingerprints([{ index: 0, embedding: vector(2) }], [0]).get(0), vector(1));
  for (const entries of [[], [{ index: 1, embedding: vector(1) }], [{ index: 0, embedding: [1] }],
    [{ index: 0, embedding: vector(NaN) }], [{ index: 0, embedding: vector(0) }]]) {
    assert.throws(() => validateFingerprints(entries, [0]));
  }
  assert.throws(() => validateFingerprints([{ index: 0, embedding: null }, { index: 0, embedding: null }], [0, 1]));
});

test('embeddings split merged AI labels and reunite split labels across the recording', () => {
  const segments = [speech(0), speech(10), speech(20, 'speaker-2')];
  const result = clusterFingerprintTurns(segments, new Map([[0, vector(1)], [1, vector(0, 1)], [2, vector(1)]]));
  assert.deepEqual(result.map(segment => segment.speakerId), ['speaker-1', 'speaker-2', 'speaker-1']);
  assert.deepEqual(result[0].voiceFingerprint, { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: vector(1) });
  assert.deepEqual(segments.map(segment => segment.speakerId), ['speaker-1', 'speaker-1', 'speaker-2']);
});

test('ambiguous, short and AI-uncertain turns stay unknown and lose visual attribution', () => {
  const segments = [speech(0), speech(10), { ...speech(20), speakerVisual: { description: 'Center', seconds: 21 } },
    speech(30, 'speaker-1', 0.5), speech(40, null)];
  const result = clusterFingerprintTurns(segments, new Map([[0, vector(1)], [1, vector(0, 1)],
    [2, vector(Math.SQRT1_2, Math.SQRT1_2)], [4, vector(1)]]));
  assert.deepEqual(result.map(segment => segment.speakerId), ['speaker-1', 'speaker-2', null, null, null]);
  assert.match(result[2].speakerIssue, /ambiguous/);
  assert.equal(result[2].speakerVisual, undefined);
  assert.deepEqual(result[2].voiceFingerprint.embedding, vector(Math.SQRT1_2, Math.SQRT1_2));
  assert.equal(result[3].voiceFingerprint, undefined);
  assert.equal(result[4].voiceFingerprint, undefined);
});

test('disagreement between reference samples abstains instead of inventing a new speaker', () => {
  const segments = [speech(0), speech(10), speech(20)];
  const result = clusterFingerprintTurns(segments, new Map([
    [0, vector(1)], [1, vector(0.8, 0.6)], [2, vector(0.8, -0.6)],
  ]));
  assert.deepEqual(result.map(segment => segment.speakerId), ['speaker-1', 'speaker-1', null]);
});

test('a known four-speaker conversation groups returning voices despite per-turn recording variation', () => {
  const segments = Array.from({ length: 32 }, (_, index) => speech(index * 8, `fragment-${index + 1}`, 6));
  const vectors = new Map(segments.map((segment, index) => {
    const embedding = Array(192).fill(0);
    embedding[index % 4] = 0.6;
    embedding[4 + index] = 0.8;
    return [index, embedding];
  }));
  const result = clusterFingerprintTurns(segments, vectors, { expectedSpeakers: 4 });
  assert.equal(new Set(result.map(segment => segment.speakerId).filter(Boolean)).size, 4);
  for (let speaker = 0; speaker < 4; speaker++) {
    const turns = result.filter((segment, index) => index % 4 === speaker);
    assert.ok(turns[0].speakerId);
    assert.ok(turns.every(segment => segment.speakerId === turns[0].speakerId));
  }
});

test('automatic grouping tolerates a weaker early reference once several turns support the voice', () => {
  const segments = [speech(0), speech(10), speech(20), speech(30)];
  const vectors = new Map([1, 0.9, 0.9, 0.7].map((score, index) => [index, vector(score, Math.sqrt(1 - score * score))]));
  assert.deepEqual(clusterFingerprintTurns(segments, vectors).map(segment => segment.speakerId), Array(4).fill('speaker-1'));
});

test('speaker-count guidance validates bounds and cannot invent groups without enough voice samples', () => {
  assert.equal(expectedSpeakerCount('4'), 4);
  assert.equal(expectedSpeakerCount(''), null);
  for (const value of [0, 21, 2.5, 'unknown']) assert.throws(() => expectedSpeakerCount(value));
  assert.throws(() => clusterFingerprintTurns([speech(0)], new Map([[0, vector(1)]]), { expectedSpeakers: 4 }), /at least 4 usable/);
});

test('known speaker count leaves a voice between two recording-wide groups ambiguous', () => {
  const segments = Array.from({ length: 13 }, (_, index) => speech(index * 4));
  const vectors = new Map(segments.map((segment, index) => [index,
    Array.from({ length: 192 }, (_, position) => index === 12
      ? (position < 2 ? Math.SQRT1_2 : 0) : Number(position === index % 4)),
  ]));
  const result = clusterFingerprintTurns(segments, vectors, { expectedSpeakers: 4 });
  assert.equal(new Set(result.slice(0, 12).map(segment => segment.speakerId)).size, 4);
  assert.equal(result[12].speakerId, null);
  assert.match(result[12].speakerIssue, /ambiguous/);
  assert.deepEqual(result[12].voiceFingerprint.embedding, vectors.get(12));
});

test('reference capacity retains established groups, leaves overflow unknown, and still recognizes returning voices', () => {
  const segments = Array.from({ length: 22 }, (_, index) => ({ ...speech(index * 4),
    speakerVisual: { description: 'Visible participant', seconds: index * 4 + 1 } }));
  const vectors = new Map(segments.map((segment, index) => [index,
    Array.from({ length: 192 }, (_, position) => Number(position === (index === 21 ? 0 : index))),
  ]));
  const result = clusterFingerprintTurns(segments, vectors);
  assert.deepEqual(result.slice(0, 20).map(segment => segment.speakerId),
    Array.from({ length: 20 }, (_, index) => `speaker-${index + 1}`));
  assert.equal(result[20].speakerId, null);
  assert.match(result[20].speakerIssue, /capacity reached.*Established groups are retained/);
  assert.equal(result[20].speakerVisual, undefined);
  assert.deepEqual(result[20].voiceFingerprint.embedding, vectors.get(20));
  assert.equal(result[21].speakerId, 'speaker-1');
  assert.ok(result[21].voiceFingerprint);
  assert.equal(segments[20].speakerId, 'speaker-1', 'Input assignments are not mutated');
});

test('speech sampling covers the turn and pooling rejects inconsistent windows', async () => {
  const { stdout } = await promisify(execFile)(process.env.VOICE_FINGERPRINT_PYTHON || 'python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('fingerprints', 'scripts/voice-fingerprints.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
print(json.dumps({
    'short': worker.sample_ranges(4, 7),
    'long': worker.sample_ranges(10, 70),
    'empty': worker.combine_embeddings([]),
    'conflict': worker.combine_embeddings([[1, 0], [0, 1]]),
    'consensus': worker.combine_embeddings([[1, 0], [1, 0], [0, 1]])
}))
`]);
  assert.deepEqual(JSON.parse(stdout), { short: [[4, 3]], long: [[10, 12], [34, 12], [58, 12]],
    empty: null, conflict: null, consensus: [1, 0] });
});

test('real speech detector excludes a loud tone and silence', {
  skip: process.env.VOICE_FINGERPRINT_SMOKE !== 'true',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fingerprint-model-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.wav');
  await promisify(execFile)(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
    '-af', "aeval=exprs='if(gte(t,6),0,val(0))'", '-ar', '16000', '-ac', '1', path]);
  const result = await fingerprintRecording({ path, segments: [speech(0), speech(3), speech(6)], temporaryRoot: root,
    config: voiceFingerprintConfig({ ...process.env, VOICE_FINGERPRINTS: 'speechbrain' }) });
  assert.deepEqual(result.map(segment => segment.speakerId), [null, null, null]);
  assert.deepEqual(await readdir(root), ['fixture.wav']);
});

test('real speech worker recognizes repeated speech with pauses across a long turn', {
  skip: process.env.VOICE_FINGERPRINT_SMOKE !== 'true' || process.platform !== 'darwin',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fingerprint-speech-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spoken = join(root, 'speech.aiff');
  const path = join(root, 'speech.wav');
  await promisify(execFile)('say', ['-r', '150', '-o', spoken,
    'We are reviewing the quarterly results and planning the next steps for our team. The project is on schedule and we will discuss the remaining decisions today.']);
  await promisify(execFile)(ffmpeg, ['-nostdin', '-v', 'error', '-i', spoken, '-filter_complex',
    '[0:a]atrim=duration=8,apad=whole_dur=8,asplit=2[first][second];[first][second]concat=n=2:v=0:a=1[speech];anullsrc=r=16000:cl=mono,atrim=duration=16[silence];[speech][silence]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-ar', '16000', '-ac', '1', path]);
  const result = await fingerprintRecording({ path, segments: [speech(0, 'speaker-1', 8), speech(8, 'speaker-1', 24)], temporaryRoot: root });
  assert.deepEqual(result.map(segment => segment.speakerId), ['speaker-1', 'speaker-1']);
  assert.ok(result.every(segment => segment.voiceFingerprint.embedding.length === 192));
});

test('fingerprint-only extraction preserves reviewed speaker groups and transcript metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fingerprint-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const segments = [{ ...speech(0, 'speaker-7'), text: 'Confirmed speech', speakerVisual: { cue: 'Screen left' } }, speech(10, null), speech(20, 'speaker-9', 1)];
  let calls = 0;
  const result = await fingerprintRecording({ path: '/recording.mp4', segments, temporaryRoot: root, preserveGroups: true,
    run: async (_binary, args) => {
      if (++calls === 1) return {};
      assert.deepEqual(JSON.parse(await readFile(args[2], 'utf8')), [{ index: 0, start: 0, end: 3 }]);
      return { stdout: JSON.stringify([{ index: 0, embedding: vector(1) }]) };
    },
  });
  assert.deepEqual(result.map(({ voiceFingerprint, ...segment }) => segment), segments);
  assert.deepEqual(result[0].voiceFingerprint.embedding, vector(1));
  assert.equal(result[1].voiceFingerprint, undefined);
  assert.equal(result[2].voiceFingerprint, undefined);
  assert.deepEqual(await readdir(root), []);
});

test('fingerprint worker receives only eligible timestamps and temporary audio is cleaned on success and failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fingerprint-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const failure of [false, true]) {
    let calls = 0;
    const task = fingerprintRecording({ path: '/recording.mp4', segments: [speech(0), speech(10, null), speech(20, 'speaker-1', 1)],
      temporaryRoot: root, config: voiceFingerprintConfig({ VOICE_FINGERPRINTS: 'speechbrain' }),
      run: async (_binary, args) => {
        if (++calls === 1) { assert.ok(args.includes('pcm_s16le')); return {}; }
        assert.deepEqual(JSON.parse(await readFile(args[2], 'utf8')), [{ index: 0, start: 0, end: 3 }]);
        if (failure) throw new Error('Missing dependency');
        return { stdout: JSON.stringify([{ index: 0, embedding: vector(1) }]) };
      },
    });
    if (failure) await assert.rejects(task, /SpeechBrain voice fingerprint worker failed/);
    else assert.deepEqual((await task).map(segment => segment.speakerId), ['speaker-1', null, null]);
    assert.deepEqual(await readdir(root), []);
  }
});