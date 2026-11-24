import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { retainUpload } from '../lib/originals.js';
import { Readable } from 'node:stream';

test('retention enforces streaming limits and cleans originals on downstream failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-original-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(retainUpload(Readable.from([Buffer.from('too large')]), directory, 'test.txt', 2,
    async stream => { for await (const chunk of stream) void chunk; }), /size limit/);
  assert.deepEqual(await readdir(join(directory, 'originals')), []);
  await assert.rejects(retainUpload(Readable.from([Buffer.from('abc')]), directory, 'test.txt', 10,
    async stream => {
      for await (const chunk of stream) void chunk;
      throw new Error('Database write failed');
    }), /Database write failed/);
  assert.deepEqual(await readdir(join(directory, 'originals')), []);
});

test('original uploads persist byte-for-byte, support ranges, appear in citations and are deleted with sources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-originals-test-'));
  let app;
  async function start() {
    app = createApp({ directory, apiKey: 'synthetic-key', generalizer: async () => '', fetcher: async () =>
      Response.json({ choices: [{ message: { content: 'Moonstone priority is reliability [S1].' } }] }) });
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    return `http://127.0.0.1:${app.address().port}`;
  }
  t.after(async () => {
    if (app.listening) await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let base = await start();
  const context = { executiveId: 'alex-executive', profileId: 'alex', scope: 'enriched' };
  const bytes = Buffer.from('Moonstone priority is reliability.\r\nUnicode: caf\u00e9.\r\n');
  const input = { ...context, filename: 'notes.txt', title: 'Original notes' };
  const pasted = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, title: 'Pasted source', content: 'Pasted text',
      original: { storageName: '../../.env', filename: 'fake', bytes: 1 } }),
  });
  const pastedId = (await pasted.json()).id;
  assert.equal((await fetch(`${base}/api/documents/${pastedId}/original`)).status, 404);
  const uploaded = await fetch(`${base}/api/files?${new URLSearchParams(input)}`, { method: 'POST', body: bytes });
  assert.equal(uploaded.status, 200);
  const { id } = await uploaded.json();
  const path = `/api/documents/${id}/original`;
  await new Promise(resolve => app.close(resolve));
  base = await start();
  const original = await fetch(base + path);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(original.headers.get('content-disposition'), /notes.txt/);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
  const range = await fetch(base + path, { headers: { Range: 'bytes=0-8' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 9));
  assert.equal(range.headers.get('content-range'), `bytes 0-8/${bytes.length}`);
  const suffix = await fetch(base + path, { headers: { Range: 'bytes=-4' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-4));
  assert.equal((await fetch(base + path, { headers: { Range: 'bytes=99999-' } })).status, 416);
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...context, mode: 'enriched', question: 'Moonstone priority?' }),
  });
  const answer = await chat.json();
  assert.equal(answer.sources[0].hasOriginal, true);
  assert.equal(answer.sources[0].documentId, id);
  const source = await (await fetch(`${base}/api/documents/${id}`)).json();
  assert.equal(source.hasOriginal, 1);
  const failed = await fetch(`${base}/api/files?${new URLSearchParams({ ...input, filename: 'broken.docx' })}`, { method: 'POST', body: 'not a zip' });
  assert.equal(failed.status, 400);
  assert.equal((await readdir(join(directory, 'originals'))).length, 1);
  assert.equal((await fetch(`${base}/api/documents/${id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await readdir(join(directory, 'originals')), []);
  assert.equal((await fetch(base + path)).status, 404);
});
