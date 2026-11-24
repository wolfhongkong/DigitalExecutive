import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import ffmpeg from 'ffmpeg-static';
import { parseParticipants, speakerLabel } from '../lib/participants.js';
import { ingestVideo } from '../lib/video.js';
import { createApp } from '../server.js';

const speech = [
  { kind: 'speech', name: 'Alex Morgan', start: 0, end: 1 },
  { kind: 'speech', name: 'Jordán Lee', start: 1, end: 2 },
];
const input = { executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched', filename: 'meeting.wav', title: 'Meeting', participants: JSON.stringify(speech) };

test('participant validation and conservative attribution handle boundaries and unknown speakers', () => {
  const parsed = parseParticipants(JSON.stringify(speech));
  assert.match(speakerLabel(parsed, 0, 1), /Alex Morgan/);
  assert.match(speakerLabel(parsed, 1, 2), /Jordán Lee/);
  assert.match(speakerLabel(parsed, 0.8, 1.2), /uncertain/);
  assert.match(speakerLabel(parsed, 2, 3), /unknown/);
  assert.throws(() => parseParticipants('bad'), /JSON/);
  assert.throws(() => parseParticipants(JSON.stringify([{ ...speech[0], end: 0 }])), /ranges/);
  assert.throws(() => parseParticipants(JSON.stringify([{ ...speech[0], end: 1.5 }, speech[1]])), /overlap/);
  assert.throws(() => parseParticipants(JSON.stringify([{ ...speech[0], kind: 'screen' }])), /description/);
  assert.throws(() => parseParticipants(JSON.stringify(Array(31).fill(speech[0]))), /30/);
  assert.equal(parseParticipants(JSON.stringify([{ ...speech[0], start: 3590, end: 3601 }]))[0].end, 3601);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'executive-participants-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'meeting.wav');
  await promisify(execFile)(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3', path]);
  return { root, bytes: await readFile(path) };
}
const fetcher = async url => {
  assert.ok(url.endsWith('/audio/transcriptions'), 'Audio files must not trigger visual analysis');
  return Response.json({
    text: 'Budget is 17. Launch in June. Shared remark. Unknown remark.',
    segments: [
      { start: 0, end: 0.7, text: 'Budget is 17.' },
      { start: 1.2, end: 1.7, text: 'Launch in June.' },
      { start: 0.8, end: 1.2, text: 'Shared remark.' },
      { start: 2.2, end: 2.8, text: 'Unknown remark.' },
    ],
  });
};
test('real audio upload indexes explicit user speaker labels without visual calls and cleans media', async t => {
  const { root, bytes } = await fixture(t);
  const analysis = await ingestVideo({ stream: Readable.from([bytes]), input, apiKey: 'test-key', model: 'test', fetcher, temporaryRoot: root });
  assert.equal(analysis.frames, 0);
  assert.match(analysis.content, /Alex Morgan \(user-labeled\): Budget is 17/);
  assert.match(analysis.content, /Jordán Lee \(user-labeled\): Launch in June/);
  assert.match(analysis.content, /uncertain.*Shared remark/);
  assert.match(analysis.content, /unknown.*Unknown remark/);
  assert.doesNotMatch(analysis.content, /AI-GENERATED SAMPLED VISUAL/);
  assert.deepEqual(await readdir(root), ['meeting.wav']);
  await assert.rejects(ingestVideo({
    stream: Readable.from([bytes]), input: { ...input, participants: JSON.stringify([{ ...speech[0], end: 4 }]) },
    apiKey: 'test-key', model: 'test', fetcher, temporaryRoot: root,
  }), /beyond/);
  await assert.rejects(ingestVideo({
    stream: Readable.from([bytes]), input: { ...input, participants: JSON.stringify([{ ...speech[0], kind: 'screen', cue: 'left' }]) },
    apiKey: 'test-key', model: 'test', fetcher, temporaryRoot: root,
  }), /only to videos/);
});

test('audio endpoint persists Unicode participant identities in scoped retrieved speech', async t => {
  const { root, bytes } = await fixture(t);
  const app = createApp({ directory: join(root, 'data'), apiKey: 'test-key', generalizer: async () => '', fetcher });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const { participants, ...query } = input;
  const response = await fetch(`${base}/api/media?${new URLSearchParams(query)}`, {
    method: 'POST', headers: { 'X-Participants': encodeURIComponent(participants) }, body: bytes,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  const source = await (await fetch(`${base}/api/documents/${result.id}`)).json();
  assert.match(source.content, /Jordán Lee \(user-labeled\): Launch/);
  const docs = await (await fetch(`${base}/api/documents?${new URLSearchParams({ executiveId: input.executiveId, profileId: 'jordan', mode: 'enriched' })}`)).json();
  assert.ok(!docs.some(document => document.id === result.id));
});

test('video frame labels are restricted to their timestamps and never used as speech identities', async t => {
  const { root } = await fixture(t);
  const path = join(root, 'meeting.mp4');
  await promisify(execFile)(ffmpeg, [
    '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=1:d=31',
    '-c:v', 'libx264', '-preset', 'ultrafast', path,
  ]);
  let observed = false;
  const result = await ingestVideo({
    stream: Readable.from([await readFile(path)]),
    input: { ...input, filename: 'meeting.mp4', participants: JSON.stringify([
      { kind: 'screen', name: 'Alex Morgan', start: 0, end: 5, cue: 'left tile' },
      { kind: 'screen', name: 'Jordan Lee', start: 29, end: 31, cue: 'right tile' },
    ]) },
    apiKey: 'test-key', model: 'test', temporaryRoot: root,
    fetcher: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const frameDescriptions = payload.messages[1].content.filter(part => part.type === 'text' && part.text.startsWith('Frame at'));
      assert.equal(frameDescriptions.length, 2);
      assert.match(frameDescriptions[0].text, /Alex Morgan/);
      assert.doesNotMatch(frameDescriptions[0].text, /Jordan Lee/);
      assert.match(frameDescriptions[1].text, /Jordan Lee/);
      assert.doesNotMatch(frameDescriptions[1].text, /Alex Morgan/);
      assert.match(frameDescriptions[0].text, /Never infer who is speaking/);
      observed = true;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Sampled blue frames; supplied participant locations cannot be confirmed.' } }] });
    },
  });
  assert.equal(observed, true);
  assert.match(result.content, /On-screen: Alex Morgan \(user-labeled\)/);
  assert.match(result.content, /No audio track/);
  await assert.rejects(ingestVideo({
    stream: Readable.from([await readFile(path)]), input: { ...input, filename: 'meeting.mp4' },
    apiKey: 'test-key', model: 'test', temporaryRoot: root,
  }), /without an audio track/);
});

for (const extension of ['mp3', 'm4a', 'ogg', 'flac', 'aac']) {
  test(`decodes .${extension} audio and attributes supplied speaker turns`, async t => {
    const { root } = await fixture(t);
    const path = join(root, `recording.${extension}`);
    await promisify(execFile)(ffmpeg, ['-nostdin', '-v', 'error', '-i', join(root, 'meeting.wav'), path]);
    const result = await ingestVideo({
      stream: Readable.from([await readFile(path)]), input: { ...input, filename: `recording.${extension}` },
      apiKey: 'test-key', model: 'test', fetcher, temporaryRoot: root,
    });
    assert.equal(result.frames, 0);
    assert.match(result.content, /Alex Morgan \(user-labeled\): Budget is 17/);
  });
}
