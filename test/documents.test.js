import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { extractDocument, ingestDocument, DOCUMENT_LIMITS } from '../lib/documents.js';
import { createApp } from '../server.js';
import { wordFixture, slidesFixture, workbookFixture, emailFixture, msgFixture, pdfFixture, openDocumentFixture } from './document-fixtures.js';

const imageFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('knowledge titles are automatic and clipboard handling preserves normal text paste and existing text with a picture', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const titleStart = source.indexOf('function knowledgeTitle(content)');
  const titleEnd = source.indexOf('\n}', titleStart) + 2;
  const titleSandbox = {};
  runInNewContext(source.slice(titleStart, titleEnd), titleSandbox);
  assert.equal(titleSandbox.knowledgeTitle('\n  Quarterly   priorities\nMore text'), 'Quarterly priorities');
  assert.equal(titleSandbox.knowledgeTitle('x'.repeat(200)).length, 80);
  assert.equal(titleSandbox.knowledgeTitle('  '), 'Pasted knowledge');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="document-title"/);
  assert.match(html, /<label for="document-content">Paste anything here<\/label>/);
  const pasteStart = source.indexOf('function pasteKnowledge(event)');
  const pasteEnd = source.indexOf('const uploadDialog', pasteStart);
  let handler;
  let attachments;
  let prevented = false;
  const field = { value: 'Existing text', selectionStart: 13, selectionEnd: 13, maxLength: 200_000,
    addEventListener: (event, listener) => { handler = listener; },
    setRangeText(value, start, end) { this.value = this.value.slice(0, start) + value + this.value.slice(end); },
  };
  const sandbox = {
    busy: false, File, selectedFiles: [],
    $: () => field,
    run: action => event => { event.preventDefault(); return action(event); },
    selectFiles: files => { attachments = files; },
  };
  runInNewContext(source.slice(pasteStart, pasteEnd), sandbox);
  handler({ clipboardData: { files: [], getData: () => 'Normal pasted text' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  handler({ clipboardData: { files: [new File([imageFixture], 'image.png', { type: 'image/png' })], getData: () => '' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(attachments.length, 1);
  assert.match(attachments[0].name, /^Pasted picture .*\.png$/);
  assert.equal(attachments[0].type, 'image/png');
  assert.equal(field.value, 'Existing text');
  handler({ clipboardData: { files: [new File([imageFixture], 'image.png', { type: 'image/png' })], getData: () => ' with caption' }, preventDefault() {} });
  assert.equal(field.value, 'Existing text with caption');
});

test('image upload API retains original pictures and indexes their extracted knowledge', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'image-knowledge-test-'));
  const app = createApp({ directory, apiKey: 'synthetic-key', fetcher: async (url, options) => {
    const body = JSON.parse(options.body);
    const instruction = body.messages[0].content;
    const content = instruction.startsWith('Extract knowledge from this image') ? 'Moonstone image budget: 17 credits.'
      : instruction.startsWith('You are a clearly labeled') ? 'The image states 17 credits [S1].'
        : JSON.stringify({ findings: [] });
    return Response.json({ choices: [{ message: { content } }] });
  }, generalizer: async () => '' });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const input = { executiveId: 'alex-executive', profileId: 'alex', scope: 'public', title: 'Pasted picture.png', filename: 'clipboard.png' };
  const response = await fetch(`${base}/api/files?${new URLSearchParams(input)}`, { method: 'POST', body: imageFixture });
  assert.equal(response.status, 200);
  const uploaded = await response.json();
  assert.ok(uploaded.characters > 0);
  const original = await fetch(`${base}/api/documents/${uploaded.id}/original`);
  assert.equal(original.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), imageFixture);
  const chat = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ executiveId: input.executiveId, profileId: input.profileId, mode: 'twin', question: 'Moonstone image budget?' }) });
  assert.equal(chat.status, 200);
  const answer = await chat.json();
  assert.ok(answer.sources.some(source => source.documentId === uploaded.id && source.text.includes('17 credits')));
  const rejected = await fetch(`${base}/api/files?${new URLSearchParams(input)}`, { method: 'POST', body: 'not an image' });
  assert.equal(rejected.status, 400);
  const documents = await (await fetch(`${base}/api/documents?${new URLSearchParams({ executiveId: input.executiveId, profileId: input.profileId, mode: 'twin' })}`)).json();
  assert.equal(documents.filter(source => source.originalFilename === 'clipboard.png').length, 1);
  assert.equal(documents.find(source => source.originalFilename === 'clipboard.png').scope, 'twin');
});

test('image ingestion sends image bytes to the configured vision provider and returns labeled searchable text', async () => {
  const input = { filename: 'clipboard.png', title: 'Pasted picture', scope: 'public' };
  const result = await ingestDocument(Readable.from([imageFixture]), input, {
    apiKey: 'test-key', model: 'test-vision', provider: { chatUrl: 'https://example.test/vision', header: 'genaiplatform-farm-subscription-key' },
    fetcher: async (url, options) => {
      assert.equal(url, 'https://example.test/vision');
      assert.equal(options.headers['genaiplatform-farm-subscription-key'], 'test-key');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test-vision');
      assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${imageFixture.toString('base64')}`);
      return Response.json({ choices: [{ message: { content: 'Quarterly priority: customer trust.' } }] });
    },
  });
  assert.match(result.content, /AI-generated/);
  assert.match(result.content, /Quarterly priority: customer trust/);
  assert.match(result.warnings[0], /Check the original image/);
});

test('image ingestion rejects invalid images, missing providers, failed requests, and empty descriptions', async () => {
  const input = { filename: 'clipboard.png', title: 'Pasted picture', scope: 'public' };
  await assert.rejects(ingestDocument(Readable.from([Buffer.from('not an image')]), input), /do not match/);
  await assert.rejects(ingestDocument(Readable.from([imageFixture]), input), /configured AI provider/);
  await assert.rejects(ingestDocument(Readable.from([imageFixture]), input, { apiKey: 'key', fetcher: async () => new Response('', { status: 429 }) }), /HTTP 429/);
  await assert.rejects(ingestDocument(Readable.from([imageFixture]), input, { apiKey: 'key', fetcher: async () => Response.json({ choices: [] }) }), /no text/);
});

test('file selection accepts 500 email files and preserves other batch and per-file limits', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function selectFiles(files) {');
  const end = app.indexOf('function renderParticipantEditors()', start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const sandbox = {
    state: { documents: { ...DOCUMENT_LIMITS, extensions: ['.eml', '.msg', '.mbox', '.txt'] } },
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { replaceChildren() {} });
      return elements.get(selector);
    },
    isMediaFile: () => false, isImageFile: () => false, renderSelectedFiles() {}, renderParticipantEditors() {}, updateUploadState() {}, node: () => ({}),
  };
  runInNewContext(app.slice(start, end), sandbox);
  const emails = Array.from({ length: 500 }, (_, index) => ({
    name: `email-${index}.${['eml', 'MSG', 'mbox'][index % 3]}`, size: 100,
  }));
  sandbox.selectFiles(emails);
  assert.equal(sandbox.selectedFiles.length, 500);
  assert.throws(() => sandbox.selectFiles([...emails, { name: 'extra.eml', size: 100 }]), /at most 500 email files/);
  assert.equal(sandbox.selectedFiles.length, 500);
  assert.throws(() => sandbox.selectFiles([...emails.slice(0, 20), { name: 'note.txt', size: 100 }]), /at most 20 files/);
  sandbox.selectFiles([...emails.slice(0, 19), { name: 'note.txt', size: 100 }]);
  assert.equal(sandbox.selectedFiles.length, 20);
  assert.throws(() => sandbox.selectFiles([{ name: 'large.eml', size: DOCUMENT_LIMITS.bytes + 1 }]), /25 MB/);
  assert.throws(() => sandbox.selectFiles([{ name: 'empty.eml', size: 0 }]), /must contain data/);
});

for (const [extension, fixture, expected] of [
  ['.docx', wordFixture, /Moonstone Word priority/],
  ['.pptx', slidesFixture, /Moonstone slide 2/],
  ...['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].map(type => [`.${type}`, () => workbookFixture(type), /\[Sheet: Plan\]/]),
  ['.pdf', pdfFixture, /Moonstone PDF priority/],
  ['.msg', msgFixture, /moonstone Outlook budget/],
  ['.odt', () => openDocumentFixture('odt'), /Moonstone OpenDocument/],
  ['.odp', () => openDocumentFixture('odp'), /Moonstone OpenDocument/],
]) {
  test(`extracts actual ${extension} contents locally`, async () => {
    const result = await extractDocument(fixture(), extension);
    assert.match(result.content, expected);
    assert.ok(Array.isArray(result.warnings));
    if (extension === '.pptx') {
      assert.match(result.content, /\[Slide 1\]/);
      assert.match(result.content, /Speaker note/);
    }
    if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'].includes(extension)) {
      assert.match(result.content, /Moonstone,17/);
      assert.match(result.warnings.join(' '), /not executed/);
    }
  });
}

test('EML decoding preserves headers and HTML body, reports but does not index attachment contents', async () => {
  const result = await extractDocument(emailFixture, '.eml');
  assert.match(result.content, /Subject: Moonstone briefing/);
  assert.match(result.content, /alex@example.test/);
  assert.match(result.content, /17 credits/);
  assert.match(result.content, /extra.txt/);
  assert.doesNotMatch(result.content, /ATTACHMENT_SECRET_NOT_INDEXED/);
  assert.match(result.warnings.join(' '), /Upload them separately/);
});

test('MBOX extracts multiple messages with boundaries and unescapes body From lines', async () => {
  const mail = index => `From alex@example.test Tue Nov 3 10:00:00 2026\nFrom: Alex <alex@example.test>\nSubject: Message ${index}\nContent-Type: text/plain\n\nMoonstone message ${index}\n>From someone\n`;
  const result = await extractDocument(Buffer.from(mail(1) + '\n' + mail(2)), '.mbox');
  assert.match(result.content, /\[Message 1\]/);
  assert.match(result.content, /\[Message 2\]/);
  assert.match(result.content, /\nFrom someone/);
  const legacy = Buffer.from('From alex@example.test Tue Nov 3 10:00:00 2026\nFrom: Alex <alex@example.test>\nSubject: Meeting\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: 8bit\n\nUne réunion Moonstone.', 'latin1');
  const decoded = await extractDocument(legacy, '.mbox');
  assert.match(decoded.content, /réunion Moonstone/);
});

test('text, HTML, CSV, TSV and RTF are extracted without executing embedded scripts', async () => {
  const text = await extractDocument(Buffer.from('Moonstone résumé'), '.txt');
  assert.equal(text.content, 'Moonstone résumé');
  const html = await extractDocument(Buffer.from('<html><body><h1>Moonstone</h1><script>alert("UNTRUSTED_SCRIPT")</script><p>Budget 17</p></body></html>'), '.html');
  assert.match(html.content, /Moonstone/i);
  assert.doesNotMatch(html.content, /<script>|UNTRUSTED_SCRIPT/);
  const csv = await extractDocument(Buffer.from('Initiative,Budget\nMoonstone,17'), '.csv');
  assert.match(csv.content, /Moonstone,17/);
  const tsv = await extractDocument(Buffer.from('Initiative\tBudget\nMoonstone\t17'), '.tsv');
  assert.match(tsv.content, /Moonstone,17/);
  const rtf = await extractDocument(Buffer.from('{\\rtf1\\ansi Moonstone RTF briefing.}'), '.rtf');
  assert.match(rtf.content, /Moonstone RTF/);
});

test('invalid, empty, unsupported and oversized documents fail instead of storing garbage', async () => {
  const input = { filename: 'test.docx', title: 'Test', scope: 'public' };
  await assert.rejects(ingestDocument(Readable.from([]), input), /empty/);
  await assert.rejects(ingestDocument(Readable.from([]), { ...input, filename: 'old.doc' }), /DOC\/PPT/);
  await assert.rejects(extractDocument(Buffer.from('not a zip'), '.docx'), /Cannot extract/);
  await assert.rejects(extractDocument(Buffer.from('not a workbook'), '.xlsx'), /Invalid spreadsheet/);
  await assert.rejects(extractDocument(Buffer.from('no headers'), '.eml'), /headers/);
  await assert.rejects(extractDocument(Buffer.from(' '), '.txt'), /No readable text/);
  await assert.rejects(extractDocument(Buffer.from([0xff, 0x00]), '.txt'), /Cannot extract/);
  await assert.rejects(extractDocument(Buffer.from('a'.repeat(200001)), '.txt'), /200,000/);
  const oversize = Readable.from([]);
  oversize.headers = { 'content-length': String(DOCUMENT_LIMITS.bytes + 1) };
  await assert.rejects(ingestDocument(oversize, input), /25 MB/);
  const chunk = Buffer.alloc(1024 * 1024);
  const streamed = Readable.from((async function* () { for (let i = 0; i < 26; i++) yield chunk; })());
  await assert.rejects(ingestDocument(streamed, input), /25 MB/);
});

test('file upload API persists searchable scoped text and rejects invalid uploads without a model key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'executive-documents-'));
  const app = createApp({ directory, apiKey: '' });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.documents.emailFiles, 500);
  assert.equal(state.documents.files, 20);
  const input = { executiveId: 'alex-executive', profileId: 'jordan', filename: 'briefing.pptx', title: 'Presentation' };
  const upload = (values, body) => fetch(`${base}/api/files?${new URLSearchParams(values)}`, { method: 'POST', body });
  const response = await upload(input, slidesFixture());
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.ok(document.characters > 0);
  const source = await (await fetch(`${base}/api/documents/${document.id}`)).json();
  assert.match(source.content, /Moonstone/);
  const question = { executiveId: input.executiveId, profileId: 'jordan', mode: 'enriched', question: 'moonstone?' };
  const chat = await (await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(question),
  })).json();
  assert.equal(chat.sources[0].documentId, document.id);
  for (const overrides of [{ mode: 'public' }, { profileId: 'alex' }, { profileId: 'alex', mode: 'twin' }]) {
    const docs = await (await fetch(`${base}/api/documents?${new URLSearchParams({ ...question, ...overrides })}`)).json();
    assert.ok(!docs.some(item => item.id === document.id));
  }
  assert.equal((await upload({ ...input, executiveId: 'missing' }, slidesFixture())).status, 404);
  const forced = await (await upload({ ...input, scope: 'public', title: 'Forced scope' }, slidesFixture())).json();
  assert.equal((await (await fetch(`${base}/api/documents/${forced.id}`)).json()).scope, 'enriched');
  assert.equal((await upload({ ...input, filename: 'file.exe' }, 'binary')).status, 415);
  assert.equal((await upload(input, 'broken pptx')).status, 400);
  const all = await (await fetch(`${base}/api/documents?${new URLSearchParams(question)}`)).json();
  assert.equal(all.filter(item => item.title === 'Presentation').length, 1);
});
