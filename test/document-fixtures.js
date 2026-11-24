import { zipSync, strToU8 } from 'fflate';
import * as XLSX from '@e965/xlsx';

const zip = entries => Buffer.from(zipSync(Object.fromEntries(
  Object.entries(entries).map(([name, content]) => [name, strToU8(content)]),
)));
const types = override => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>${override}</Types>`;

export function wordFixture() {
  return zip({
    '[Content_Types].xml': types('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Moonstone Word priority is customer trust.</w:t></w:r></w:p></w:body></w:document>',
  });
}
export function slidesFixture() {
  return zip({
    '[Content_Types].xml': types('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'),
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    ...Object.fromEntries([1, 2].map(number => [`ppt/slides/slide${number}.xml`,
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Moonstone slide ${number}: reliability and onboarding.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`])),
    'ppt/slides/_rels/slide1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdNote" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note: moonstone launches in June.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
  });
}
export function openDocumentFixture(type) {
  const isPresentation = type === 'odp';
  return zip({
    mimetype: `application/vnd.oasis.opendocument.${isPresentation ? 'presentation' : 'text'}`,
    'META-INF/manifest.xml': `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.${isPresentation ? 'presentation' : 'text'}"/></manifest:manifest>`,
    'content.xml': `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${isPresentation ? '<office:presentation><draw:page draw:name="Overview">' : '<office:text>'}<text:p>Moonstone OpenDocument priority is reliability.</text:p>${isPresentation ? '</draw:page></office:presentation>' : '</office:text>'}</office:body></office:document-content>`,
  });
}
export function workbookFixture(bookType = 'xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Initiative', 'Budget'], ['Moonstone', 17]]), 'Budget');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Owner', 'Alex'], ['Launch', 'June']]), 'Plan');
  return XLSX.write(book, { type: 'buffer', bookType });
}
export const emailFixture = Buffer.from([
  'From: Alex <alex@example.test>', 'To: Jordan <jordan@example.test>',
  'Subject: =?UTF-8?B?TW9vbnN0b25lIGJyaWVmaW5n?=',
  'Date: Tue, 03 Nov 2026 10:00:00 +0000', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="test-boundary"', '',
  '--test-boundary', 'Content-Type: text/html; charset=utf-8', '',
  '<html><body><p>The moonstone email budget is <b>17 credits</b>.</p></body></html>',
  '--test-boundary', 'Content-Type: text/plain', 'Content-Disposition: attachment; filename="extra.txt"',
  'Content-Transfer-Encoding: base64', '', Buffer.from('ATTACHMENT_SECRET_NOT_INDEXED').toString('base64'),
  '--test-boundary--', '',
].join('\r\n'));

export function msgFixture() {
  const compound = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(compound, '__properties_version1.0', Buffer.alloc(32));
  for (const [id, value] of [
    ['0037', 'Moonstone Outlook briefing'], ['0C1A', 'Alex'],
    ['0C1F', 'alex@example.test'], ['1000', 'The moonstone Outlook budget is 17 credits.'],
  ]) XLSX.CFB.utils.cfb_add(compound, `__substg1.0_${id}001F`, Buffer.from(`${value}\0`, 'utf16le'));
  return XLSX.CFB.write(compound, { type: 'buffer' });
}
export function pdfFixture() {
  const stream = 'BT /F1 14 Tf 50 700 Td (Moonstone PDF priority is reliability.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(result);
  result += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(result);
}
