import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeGemini, validateTranscript } from '../lib/transcription.js';

const base = {
  audio: Buffer.from('synthetic-audio'), duration: 120, offset: 240, model: 'gemini-3.7-flash',
  provider: { chatUrl: 'https://aoai-farm.bosch-temp.com/test', header: 'Authorization' },
  apiKey: 'synthetic-key',
};
const transcript = { text: 'A "quoted" sentence.\nSecond line.', segments: [
  { start: 0, end: 5, text: 'A "quoted" sentence.\nSecond line.' },
] };

test('segment diagnostics identify timestamp defects without exposing speech content', () => {
  for (const [segment, reason] of [
    [{ start: '00:01', end: 5, text: 'private speech' }, /timestamps must be numeric/],
    [{ start: 10, end: 5, text: 'private speech' }, /end must be after start/],
    [{ start: 120, end: 120, text: 'private speech' }, /end must be after start/],
    [{ start: 1320, end: 1340, text: 'private speech' }, /timestamp exceeds 120-second clip/],
  ]) {
    assert.throws(() => validateTranscript({ text: 'private speech', segments: [segment] }, 120), error => {
      assert.match(error.message, reason);
      assert.ok(!error.message.includes('private speech'));
      return true;
    });
  }
});
function response(content, finish_reason = 'stop') {
  return Response.json({ choices: [{ finish_reason, message: { content } }] });
}

test('transcription accepts valid raw or fenced JSON without changing speech', async () => {
  for (const content of [JSON.stringify(transcript), `\`\`\`json\n${JSON.stringify(transcript)}\n\`\`\``]) {
    assert.deepEqual(await transcribeGemini({ ...base, fetcher: async () => response(content) }), transcript);
  }
});

test('zero-duration speech is retranscribed with positive timing and separate-speaker instructions', async t => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const result = await transcribeGemini({ ...base, fetcher: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /new segment whenever the speaking voice changes/);
    assert.match(body.messages[1].content[0].text, /end > start/);
    if (calls === 1) return response(JSON.stringify({
      text: 'Speech', segments: [{ start: 120, end: 120, text: 'Speech' }],
    }));
    assert.match(body.messages[1].content[0].text, /end must be after start/);
    return response(JSON.stringify(transcript));
  } });
  assert.equal(calls, 2);
  assert.deepEqual(result, transcript);
});

test('malformed or truncated transcription retries once with original audio and explicit logging', async t => {
  const logger = t.mock.method(console, 'warn', () => {});
  for (const failed of [response('{"text":"unterminated'), response(JSON.stringify(transcript), 'length')]) {
    let calls = 0;
    const result = await transcribeGemini({ ...base, fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.messages[1].content[1].input_audio.data, base.audio.toString('base64'));
      calls++;
      if (calls === 2) assert.match(body.messages[1].content[0].text, /previous attempt/);
      return calls === 1 ? failed : response(JSON.stringify(transcript));
    } });
    assert.deepEqual(result, transcript);
    assert.equal(calls, 2);
  }
  assert.equal(logger.mock.callCount(), 2);
});

test('persistent format failure reports affected time range and does not repair or salvage partial JSON', async t => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  await assert.rejects(transcribeGemini({ ...base, fetcher: async () => {
    calls++;
    return response('Explanation before JSON: ' + JSON.stringify(transcript));
  } }), /invalid JSON.*seconds 240-360.*2 attempts.*No video knowledge/);
  assert.equal(calls, 2);
});

test('HTTP failures are not retried as transcript formatting problems', async () => {
  let calls = 0;
  await assert.rejects(transcribeGemini({ ...base, fetcher: async () => {
    calls++;
    return new Response('', { status: 429 });
  } }), /HTTP 429/);
  assert.equal(calls, 1);
});
