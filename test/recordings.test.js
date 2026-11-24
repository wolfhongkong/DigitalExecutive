import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../lib/store.js';
import { createApp } from '../server.js';
import { recordingSegments } from '../lib/recordings.js';

const segments = [
  { start: 0, end: 2, text: 'Amber initiative belongs to first speaker.' },
  { start: 2, end: 4, text: 'Cobalt initiative belongs to second speaker.' },
  { start: 4, end: 6, text: 'Unknown secret not attributed.' },
];
const analysis = 'Video source: fixture.mp4\n\nTIMESTAMPED SPEECH TRANSCRIPT\n' +
  '[00:00:00 - 00:00:02] Speaker: unknown (not identified by user): Amber initiative belongs to first speaker.\n' +
  '[00:00:02 - 00:00:04] Speaker: unknown (not identified by user): Cobalt initiative belongs to second speaker.\n' +
  '[00:00:04 - 00:00:06] Speaker: uncertain (segment crosses a user-label boundary; do not attribute): Unknown secret not attributed.\n' +
  '\nAI-GENERATED SAMPLED VISUAL OBSERVATIONS\nDo not attribute this slide to a speaker.';
const input = { executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched', title: 'Meeting', content: analysis };

test('local fingerprint regrouping combines fragments into four voices without provider calls or changing published assignments', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-local-groups-'));
  let store = createStore(directory);
  const fragments = Array.from({ length: 32 }, (_, index) => {
    const embedding = Array(192).fill(0);
    embedding[index % 4] = 0.6;
    embedding[4 + index] = 0.8;
    return { start: index * 8, end: index * 8 + 6, text: 'Reviewed speech.', speakerId: `fragment-${index + 1}`,
      voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding } };
  });
  const source = store.insertRecording(input, fragments);
  const assignments = fragments.map((segment, index) => index === 0 ? 'alex-executive' : null);
  const published = store.publishRecording(source.id, assignments);
  store.close();
  const app = createApp({ directory, apiKey: '', fingerprints: { enabled: true },
    fetcher: async () => { throw new Error('Local regrouping must not call a provider'); },
    fingerprinter: async () => { throw new Error('Complete fingerprints must be reused'); },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const route = `${base}/api/documents/${source.id}/speaker-groups`;
  const invalid = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"expectedSpeakers":0}' });
  assert.equal(invalid.status, 400);
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"expectedSpeakers":4}' });
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal(new Set(review.segments.map(segment => segment.speakerId).filter(Boolean)).size, 4);
  assert.deepEqual(review.assignments, assignments);
  assert.deepEqual(review.generated, published.generated);
  assert.equal(review.expectedSpeakers, 4);
  assert.doesNotMatch(JSON.stringify(review), /"embedding"/);
  store = createStore(directory);
  try {
    assert.equal(store.recordingReview(source.id).expectedSpeakers, 4);
    assert.match(store.document(published.generated[0].documentId).content, /Reviewed speech/);
  } finally { store.close(); }
});

test('saving assignments automatically enrolls confirmed recordings without changing groups, assignments, or published sources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-recovery-'));
  let store = createStore(directory);
  await mkdir(join(directory, 'originals'));
  await writeFile(join(directory, 'originals', 'recording'), 'fixture');
  const tracked = segments.map(segment => ({ ...segment, speakerId: 'speaker-7' }));
  const source = store.insertRecording({ ...input, original: { filename: 'meeting.mp4', storageName: 'recording', bytes: 7 } }, tracked);
  const assignments = ['alex-executive', null, null];
  const published = store.publishRecording(source.id, assignments);
  const expected = store.recordingReview(source.id);
  assert.deepEqual(store.voiceProfiles('alex'), []);
  const fingerprinted = tracked.map(segment => ({ ...segment, voiceFingerprint: {
    model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [1, ...Array(191).fill(0)],
  } }));
  assert.throws(() => store.rememberRecordingVoices(source.id, fingerprinted, { ...expected, assignments: [null, null, null] }), /changed/);
  assert.throws(() => store.rememberRecordingVoices(source.id, fingerprinted.map(segment => ({ ...segment, speakerId: 'changed' })), expected), /preserve/);
  store.close();
  let calls = 0;
  const app = createApp({ directory, apiKey: '', fingerprints: { enabled: true },
    fetcher: async () => { throw new Error('Voice recovery must not call an AI provider'); },
    fingerprinter: async options => { calls++; assert.equal(options.preserveGroups, true); return fingerprinted; },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const route = `http://127.0.0.1:${app.address().port}/api/documents/${source.id}/speakers`;
  const save = () => fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft: true, assignments }) });
  const response = await save();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).voiceProfileWarning, undefined);
  assert.equal(calls, 1);
  assert.equal((await save()).status, 200);
  assert.equal(calls, 1);
  const review = await (await fetch(route)).json();
  assert.equal(review.hasVoiceFingerprints, true);
  assert.deepEqual(review.segments, tracked);
  assert.deepEqual(review.assignments, assignments);
  assert.deepEqual(review.generated, published.generated);
  assert.doesNotMatch(JSON.stringify(review), /"embedding"/);
  store = createStore(directory);
  try {
    assert.equal(store.voiceProfiles('alex')[0].samples, 1);
    const later = store.insertRecording(input, fingerprinted);
    assert.deepEqual(store.recordingReview(later.id).assignments, tracked.map(() => 'alex-executive'));
  } finally { store.close(); }
});

test('confirmed voice profiles persist across restarts, prefill later uploads, are shared across users, and support corrections and forgetting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-voice-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tracked = segments.map((segment, index) => ({ ...segment, speakerId: 'speaker-1',
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [1, ...Array(191).fill(0)] } }));
  let store = createStore(directory);
  try {
    const first = store.insertRecording(input, tracked);
    assert.equal(JSON.stringify(store.recordingReview(first.id)).includes('embedding'), false);
    store.saveRecordingReview(first.id, ['alex-executive', null, null]);
    assert.equal(store.voiceProfiles('alex')[0].executiveId, 'alex-executive', 'Saving an assigned speaker stores available fingerprints automatically');
    store.close();
    store = createStore(directory);
    assert.equal(store.voiceProfiles('alex')[0].executiveId, 'alex-executive');
    const second = store.insertRecording(input, tracked);
    assert.deepEqual(store.recordingReview(second.id).assignments, tracked.map(() => 'alex-executive'));
    assert.deepEqual(store.recordingReview(second.id).generated, []);
    assert.equal(store.voiceProfiles('alex')[0].samples, 1, 'Automatic matches do not enroll themselves');
    const otherUser = store.insertRecording({ ...input, profileId: 'jordan' }, tracked);
    assert.deepEqual(store.recordingReview(otherUser.id).assignments, tracked.map(() => 'alex-executive'));
    assert.deepEqual(store.voiceProfiles('jordan'), store.voiceProfiles('alex'));
    const other = store.addExecutive({ name: 'Correct speaker', role: 'CFO', ownerId: 'alex' });
    store.saveRecordingReview(first.id, [other.id, null, null]);
    assert.deepEqual(store.voiceProfiles('alex').map(item => item.executiveId), [other.id]);
    const corrected = store.insertRecording(input, tracked);
    assert.deepEqual(store.recordingReview(corrected.id).assignments, tracked.map(() => other.id));
    store.saveRecordingReview(corrected.id, [null, null, null]);
    store.saveSpeakerTracks(corrected.id, tracked, store.recordingReview(corrected.id).segments);
    assert.deepEqual(store.recordingReview(corrected.id).assignments, [null, null, null], 'Reanalysis preserves manually reviewed unknowns');
    store.deleteDocument(first.id);
    assert.equal(store.voiceProfiles('alex')[0].executiveId, other.id, 'Permanent profiles survive removal of the source video');
    const retained = store.insertRecording(input, tracked);
    assert.deepEqual(store.recordingReview(retained.id).assignments, tracked.map(() => other.id));
    store.forgetVoices('alex');
    assert.deepEqual(store.voiceProfiles('alex'), []);
    assert.equal(store.recordingReview(retained.id).hasVoiceFingerprints, false);
    assert.deepEqual(store.recordingReview(retained.id).assignments, [null, null, null]);
    assert.deepEqual(store.recordingReview(corrected.id).assignments, [null, null, null]);
    const forgotten = store.insertRecording(input, tracked);
    assert.deepEqual(store.recordingReview(forgotten.id).assignments, [null, null, null]);
  } finally { store.close(); }
});

test('calibrated cross-recording identity threshold preserves uncertainty, competing margins, and review-only enrollment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-calibration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = createStore(directory);
  const fingerprinted = score => [{ start: 0, end: 4, text: 'Confirmed speech.', speakerId: 'speaker-1',
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb',
      embedding: [score, Math.sqrt(1 - score * score), ...Array(190).fill(0)] } }];
  try {
    const training = store.insertRecording(input, fingerprinted(1));
    store.saveRecordingReview(training.id, ['alex-executive']);
    const conservative = store.insertRecording(input, fingerprinted(0.7));
    assert.deepEqual(store.recordingReview(conservative.id).assignments, [null]);
    store.close();
    store = createStore(directory, { voiceIdentityThreshold: 0.65 });
    const match = store.insertRecording(input, fingerprinted(0.7));
    assert.deepEqual(store.recordingReview(match.id).assignments, ['alex-executive']);
    assert.deepEqual(store.recordingReview(match.id).generated, []);
    assert.equal(store.voiceProfiles('alex')[0].samples, 1);
    const uncertain = store.insertRecording(input, fingerprinted(0.64));
    assert.deepEqual(store.recordingReview(uncertain.id).assignments, [null]);
    const rival = store.addExecutive({ name: 'Competing voice', role: 'CFO', ownerId: 'alex' });
    const competing = store.insertRecording(input, fingerprinted(1));
    store.saveRecordingReview(competing.id, [rival.id]);
    const ambiguous = store.insertRecording(input, fingerprinted(0.7));
    assert.deepEqual(store.recordingReview(ambiguous.id).assignments, [null]);
  } finally { store.close(); }
});

test('voice matching retains confirmed reference pairs from different recording conditions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-reference-conditions-'));
  const store = createStore(directory);
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const fingerprinted = (embedding, duration) => [0, 1].map(index => ({
    start: index * 12, end: index * 12 + duration, text: 'Confirmed speech.', speakerId: 'speaker-1',
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding },
  }));
  const studio = [1, ...Array(191).fill(0)];
  const conference = [0.6, 0.8, ...Array(190).fill(0)];
  for (const [embedding, duration] of [[studio, 8], [conference, 4]]) {
    const training = store.insertRecording(input, fingerprinted(embedding, duration));
    store.saveRecordingReview(training.id, ['alex-executive', 'alex-executive']);
  }
  const later = store.insertRecording(input, fingerprinted(conference, 4));
  assert.deepEqual(store.recordingReview(later.id).assignments, ['alex-executive', 'alex-executive']);
  assert.equal(store.voiceProfiles('alex')[0].samples, 4, 'Suggestions must not enroll themselves');
  const rival = store.addExecutive({ name: 'Competing voice', role: 'CFO', ownerId: 'alex' });
  const competing = store.insertRecording(input, fingerprinted(conference, 4));
  store.saveRecordingReview(competing.id, [rival.id, rival.id]);
  const ambiguous = store.insertRecording(input, fingerprinted(conference, 4));
  assert.deepEqual(store.recordingReview(ambiguous.id).assignments, [null, null]);
});

test('identity matching tolerates a weak reference with majority support and rejects enrollment outliers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-robust-reference-'));
  const store = createStore(directory);
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const turn = (score, index) => ({ start: index * 12, end: index * 12 + 6, text: 'Confirmed speech.', speakerId: 'speaker-1',
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb',
      embedding: [score, Math.sqrt(1 - score * score), ...Array(190).fill(0)] } });
  const training = store.insertRecording(input, [turn(0.65, 0), turn(0.95, 1), turn(0.95, 2), turn(-1, 3)]);
  store.saveRecordingReview(training.id, Array(4).fill('alex-executive'));
  assert.equal(store.voiceProfiles('alex')[0].samples, 3);
  const later = store.insertRecording(input, [turn(1, 0)]);
  assert.deepEqual(store.recordingReview(later.id).assignments, ['alex-executive']);
  const rival = store.addExecutive({ name: 'Similar voice', role: 'CTO', ownerId: 'alex' });
  const competing = store.insertRecording(input, [turn(1, 0)]);
  store.saveRecordingReview(competing.id, [rival.id]);
  assert.deepEqual(store.recordingReview(store.insertRecording(input, [turn(1, 0)]).id).assignments, [null]);
});

test('recording-wide support rescues consistent turns without propagating conflicts or missing fingerprints', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-group-support-'));
  const store = createStore(directory);
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const turn = (score, index, speakerId = 'speaker-1') => ({ start: index * 12, end: index * 12 + 6, text: 'Speech.', speakerId,
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb',
      embedding: [score, Math.sqrt(1 - score * score), ...Array(190).fill(0)] } });
  const training = store.insertRecording(input, [turn(1, 0)]);
  store.saveRecordingReview(training.id, ['alex-executive']);
  assert.equal(store.recordingReview(training.id).voiceDiagnostics[0].status, 'no-references');
  const turns = [turn(0.9, 0), turn(0.9, 1), turn(0.7, 2), turn(0.7, 3, 'speaker-2'),
    { start: 50, end: 51, text: 'Short speech.', speakerId: 'speaker-1' }];
  const later = store.recordingReview(store.insertRecording(input, turns).id);
  assert.deepEqual(later.assignments, ['alex-executive', 'alex-executive', 'alex-executive', null, null]);
  assert.deepEqual(later.voiceDiagnostics.map(match => match.status),
    ['matched', 'matched', 'group-supported', 'below-threshold', 'no-fingerprint']);
  assert.equal(later.voiceDiagnostics[3].score, 0.7);
  const rival = store.addExecutive({ name: 'Competing voice', role: 'CTO', ownerId: 'alex' });
  const competing = store.insertRecording(input, [turn(0, 0)]);
  store.saveRecordingReview(competing.id, [rival.id]);
  const conflict = store.recordingReview(store.insertRecording(input, [turn(0.9, 0), turn(0.9, 1), turn(0, 2), turn(0.7, 3)]).id);
  assert.deepEqual(conflict.assignments, ['alex-executive', 'alex-executive', rival.id, null]);
  const ambiguous = store.insertRecording(input, [turn(1, 0)]);
  store.saveRecordingReview(ambiguous.id, [rival.id]);
  assert.equal(store.recordingReview(store.insertRecording(input, [turn(1, 0)]).id).voiceDiagnostics[0].status, 'ambiguous');
});

test('refreshing voice profiles retires old fingerprints rejected by the new extraction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-refresh-rejected-'));
  const store = createStore(directory);
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const tracked = [0, 1].map(index => ({ start: index * 10, end: index * 10 + 4, text: 'Confirmed speech.', speakerId: 'speaker-1',
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [1, ...Array(191).fill(0)] } }));
  const recording = store.insertRecording(input, tracked);
  store.saveRecordingReview(recording.id, ['alex-executive', 'alex-executive']);
  const review = store.recordingReview(recording.id);
  const refreshed = store.rememberRecordingVoices(recording.id, [tracked[0], review.segments[1]], review);
  assert.equal(store.voiceProfiles('alex')[0].samples, 1);
  assert.equal(refreshed.voiceDiagnostics[1].status, 'no-fingerprint');
  assert.deepEqual(refreshed.assignments, review.assignments);
});

test('known voice identity can match a clean fingerprint without an anonymous group', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-ungrouped-'));
  const store = createStore(directory);
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const turn = { start: 0, end: 4, text: 'Confirmed speech.', speakerId: 'speaker-1',
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [1, ...Array(191).fill(0)] } };
  const training = store.insertRecording(input, [turn]);
  store.saveRecordingReview(training.id, ['alex-executive']);
  const later = store.insertRecording(input, [{ ...turn, speakerId: null,
    speakerIssue: 'Voice fingerprint similarity is ambiguous or conflicts with reference samples; this turn remains unassigned.' }]);
  const review = store.recordingReview(later.id);
  assert.equal(review.segments[0].speakerId, null);
  assert.equal(review.hasVoiceFingerprints, true);
  assert.deepEqual(review.assignments, ['alex-executive']);
  assert.deepEqual(review.generated, []);
  assert.equal(store.voiceProfiles('alex')[0].samples, 1);
  const overlap = store.insertRecording(input, [{ ...turn, speakerId: null }, { ...turn, speakerId: null }]);
  assert.deepEqual(store.recordingReview(overlap.id).assignments, [null, null]);
});

test('conflicting saved identities abstain and invalid enrollment is atomic', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-voice-conflict-'));
  const store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const tracked = [{ ...segments[0], speakerId: 'speaker-1',
    voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [1, ...Array(191).fill(0)] } }];
  const first = store.insertRecording(input, tracked);
  store.saveRecordingReview(first.id, ['alex-executive']);
  assert.throws(() => store.saveRecordingReview(first.id, ['missing']), /not found/);
  assert.equal(store.voiceProfiles('alex')[0].samples, 1);
  const other = store.addExecutive({ name: 'Similar voice', role: 'CTO', ownerId: 'alex' });
  const second = store.insertRecording(input, tracked);
  store.publishRecording(second.id, [other.id]);
  const ambiguous = store.insertRecording(input, tracked);
  assert.deepEqual(store.recordingReview(ambiguous.id).assignments, [null]);
  assert.equal(store.voiceProfiles('alex').length, 2);
  assert.throws(() => store.insertRecording(input, [{ ...tracked[0],
    voiceFingerprint: { model: 'different-model', embedding: [1, ...Array(191).fill(0)] } }]), /Unsupported/);
});

test('existing recording review databases migrate without losing assignments or transcript data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-speaker-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = createStore(directory);
  const source = store.insertRecording(input, segments);
  store.saveRecordingReview(source.id, ['alex-executive', null, null]);
  store.close();
  const database = new DatabaseSync(join(directory, 'sandbox.sqlite'));
  database.exec('ALTER TABLE recording_reviews DROP COLUMN tracking_error');
  database.close();
  store = createStore(directory);
  try {
    const review = store.recordingReview(source.id);
    assert.deepEqual(review.segments, segments);
    assert.deepEqual(review.assignments, ['alex-executive', null, null]);
    assert.equal(review.trackingError, '');
    assert.equal(store.publishRecording(source.id, review.assignments).generated.length, 1);
  } finally { store.close(); }
});

test('one reviewed meeting publishes isolated speech to several executives atomically with shared original and idempotent edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-speaker-test-'));
  let store;
  try {
    store = createStore(directory);
    const other = store.addExecutive({ name: 'Other', role: 'CFO', ownerId: 'jordan' });
    await mkdir(join(directory, 'originals'));
    await writeFile(join(directory, 'originals', 'fixture'), 'original');
    const source = store.insertRecording({
      ...input, original: { storageName: 'fixture', filename: 'fixture.mp4', bytes: 8 },
    }, segments);
    const context = { executiveId: input.executiveId, profileId: 'alex', mode: 'enriched' };
    assert.deepEqual(store.retrieve(context, 'Amber Cobalt'), []);
    assert.equal(store.recordingReview(source.id).segments.length, 3);
    for (const assignments of [[other.id], [null, null, null], [input.executiveId, 'missing', null]]) {
      assert.throws(() => store.publishRecording(source.id, assignments));
      assert.deepEqual(store.retrieve(context, 'Amber Cobalt'), []);
    }
    const assigned = [input.executiveId, other.id, null];
    const published = store.publishRecording(source.id, assigned);
    assert.equal(published.generated.length, 2);
    const own = store.retrieve(context, 'Amber Cobalt unknown slide');
    assert.ok(own.some(item => item.text.includes('Amber')));
    assert.ok(own.every(item => !/Cobalt|Unknown secret|this slide/.test(item.text)));
    const second = store.retrieve({ ...context, executiveId: other.id }, 'Cobalt');
    assert.ok(second[0].text.includes('Cobalt'));
    assert.equal(second[0].hasOriginal, true);
    const database = new DatabaseSync(join(directory, 'sandbox.sqlite'));
    database.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON documents
      WHEN NEW.executive_id = '${other.id}' BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`);
    assert.throws(() => store.publishRecording(source.id, assigned), /simulated insert failure/);
    database.exec('DROP TRIGGER fail_second');
    database.close();
    assert.deepEqual(store.recordingReview(source.id).generated, published.generated);
    assert.ok(store.document(published.generated[0].documentId).content.includes('Amber'));
    assert.ok(store.document(published.generated[1].documentId).content.includes('Cobalt'));
    assert.deepEqual(store.retrieve({ ...context, executiveId: other.id, profileId: 'jordan' }, 'Cobalt'), []);
    assert.deepEqual(store.retrieve({ ...context, mode: 'public' }, 'Amber'), []);
    const republished = store.publishRecording(source.id, assigned);
    assert.deepEqual(republished.generated, published.generated);
    store.close();
    store = createStore(directory);
    assert.deepEqual(store.recordingReview(source.id).assignments, assigned);
    store.saveRecordingReview(source.id, [null, other.id, null]);
    assert.deepEqual(store.recordingReview(source.id).assignments, [null, other.id, null]);
    assert.ok(store.document(published.generated[0].documentId).content.includes('Amber'));
    const fewer = store.publishRecording(source.id, [null, other.id, null]);
    assert.equal(fewer.generated.length, 1);
    assert.throws(() => store.document(published.generated[0].documentId), /not found/);
    const restored = store.publishRecording(source.id, assigned);
    store.deleteDocument(restored.generated[0].documentId);
    assert.equal(await readFile(join(directory, 'originals', 'fixture'), 'utf8'), 'original');
    store.publishRecording(source.id, assigned);
    store.deleteDocument(source.id);
    assert.deepEqual(await readdir(join(directory, 'originals')), []);
    assert.deepEqual(store.retrieve({ ...context, executiveId: other.id }, 'Cobalt'), []);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('partial-analysis warnings and successful groups survive restart, remain reviewable, and stay out of published speech', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-partial-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = createStore(directory);
  const warning = 'Transcription failed at seconds 120-150. Missing speech excluded.';
  const source = store.insertRecording(input, segments, '', [warning]);
  const tracks = segments.map((segment, index) => ({
    ...segment, speakerId: index === 1 ? null : 'speaker-1',
    ...(index === 1 ? { speakerIssue: 'Speaker analysis failed at seconds 2-4.' } : {}),
  }));
  store.saveSpeakerTracks(source.id, tracks, segments);
  store.saveRecordingReview(source.id, ['alex-executive', null, null]);
  store.close();
  store = createStore(directory);
  try {
    let review = store.recordingReview(source.id);
    assert.deepEqual(review.warnings, [warning]);
    assert.match(review.trackingError, /seconds 2-4/);
    assert.deepEqual(review.assignments, ['alex-executive', null, null]);
    const published = store.publishRecording(source.id, review.assignments);
    const content = store.document(published.generated[0].documentId).content;
    assert.match(content, /Amber initiative/);
    assert.doesNotMatch(content, /failed|Cobalt initiative|Unknown secret/);
    const recovered = tracks.map(({ speakerIssue, ...segment }) => ({ ...segment, speakerId: 'speaker-1' }));
    store.saveSpeakerTracks(source.id, recovered, tracks);
    review = store.recordingReview(source.id);
    assert.equal(review.trackingError, '');
    assert.deepEqual(review.warnings, [warning], 'Speaker recovery must not hide missing transcription warnings');
  } finally { store.close(); }
});

test('ambiguous overlaps and malformed exported segments fail explicitly; multiline speech is preserved', async t => {
  assert.throws(() => recordingSegments(analysis.replace('00:00:02', '00:70:02')), /invalid timestamps/);
  assert.throws(() => recordingSegments(analysis.replace('[00:00:00 - 00:00:02] Speaker:', '[invalid] Speaker:')), /unrecognized segment/);
  assert.ok(recordingSegments(analysis.replace('first speaker.', 'first speaker.\nContinued words.'))[0].text.includes('\nContinued words.'));
  const directory = await mkdtemp(join(tmpdir(), 'executive-speaker-overlap-'));
  const store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const other = store.addExecutive({ name: 'Other', role: 'CTO', ownerId: 'alex' });
  const source = store.insertRecording(input, [{ ...segments[0], end: 3 }, segments[1]]);
  assert.throws(() => store.publishRecording(source.id, [input.executiveId, other.id]), /Overlapping speech/);
  assert.throws(() => store.saveRecordingReview(source.id, ['missing', null]), /not found/);
});

test('speaker publishing enriches the uploader\'s own twin and keeps other assigned speech private to the uploader', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-speaker-scopes-'));
  const store = createStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const target = store.addExecutive({ name: 'Other', role: 'CTO' });
  assert.equal(target.owner_id, target.id);
  for (const [uploader, viewer, scope] of [['alex', target.id, 'enriched'], [target.id, 'alex', 'twin']]) {
    const source = store.insertRecording({ ...input, profileId: uploader, scope: 'public' }, segments);
    const { generated } = store.publishRecording(source.id, [target.id, null, null]);
    const published = store.document(generated[0].documentId);
    assert.equal(published.scope, scope);
    assert.equal(published.profile_id, uploader);
    const visible = (profileId, mode) => store.visibleDocuments({ executiveId: target.id, profileId, mode }).some(item => item.id === published.id);
    assert.ok(visible(uploader, scope));
    assert.ok(!visible(viewer, viewer === target.id ? 'twin' : 'enriched'));
    assert.ok(!visible(uploader, 'public'));
  }
});

test('legacy exported transcript parsing excludes visuals and can be reviewed via HTTP', async t => {
  assert.deepEqual(recordingSegments(analysis), segments);
  const directory = await mkdtemp(join(tmpdir(), 'executive-speaker-api-'));
  const app = createApp({ directory, apiKey: '' });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const uploaded = await fetch(`${base}/api/files?${new URLSearchParams({
    executiveId: input.executiveId, profileId: 'alex', scope: 'enriched', title: 'Imported analysis', filename: 'meeting-analysis.txt',
  })}`, { method: 'POST', body: analysis });
  const source = await uploaded.json();
  assert.equal(source.needsSpeakerReview, true);
  const route = `${base}/api/documents/${source.id}/speakers`;
  const review = await (await fetch(route)).json();
  assert.equal(review.segments.length, 3);
  assert.equal(review.originalFilename, 'meeting-analysis.txt');
  const invalid = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"assignments":[]}' });
  assert.equal(invalid.status, 400);
  const draft = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: true, assignments: [input.executiveId, null, null] }) });
  assert.equal(draft.status, 200);
  assert.deepEqual((await (await fetch(route)).json()).assignments, [input.executiveId, null, null]);
  const valid = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignments: [input.executiveId, null, null] }) });
  assert.equal(valid.status, 200);
  const result = await valid.json();
  assert.equal(result.assignedSegments, 1);
  assert.equal((await fetch(`${base}/api/documents/missing/speakers`)).status, 404);
});
