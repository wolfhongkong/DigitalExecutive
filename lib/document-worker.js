import { parentPort, workerData } from 'node:worker_threads';

const { extension, maxCharacters } = workerData;
const buffer = Buffer.from(workerData.buffer);
const warnings = [];

function bounded(value) {
  if (value.length > maxCharacters) {
    throw new Error(`Extracted text exceeds ${maxCharacters.toLocaleString('en-US')} characters. Split the document; nothing was saved.`);
  }
  return value;
}
function utf8() {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (value.includes('\0')) throw new Error('This is not a UTF-8 text file. Export it as UTF-8 or use its correct Office/email format.');
  return bounded(value);
}
async function htmlText(html) {
  const { simpleParser } = await import('mailparser');
  return (await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${html}`))).text || '';
}
async function emailText(bytes) {
  const { simpleParser } = await import('mailparser');
  const mail = await simpleParser(bytes, { skipImageLinks: true, skipTextToHtml: true });
  if (![...mail.headers.keys()].some(key => ['from', 'to', 'subject', 'date'].includes(key))) {
    throw new Error('Email has no recognizable message headers. Export a complete EML message.');
  }
  const addresses = value => Array.isArray(value) ? value.map(item => item.text).join('; ') : value?.text || '';
  const body = mail.text?.trim() || (mail.html ? (await htmlText(mail.html)).trim() : '');
  if (!body) throw new Error('Email has no extractable text body. Upload attachments separately.');
  if (mail.attachments.length) warnings.push('Email attachments are listed but not extracted. Upload them separately.');
  return bounded([
    `Subject: ${mail.subject || '(no subject)'}`,
    `From: ${addresses(mail.from)}`, `To: ${addresses(mail.to)}`,
    `Cc: ${addresses(mail.cc)}`, `Date: ${mail.date?.toISOString() || ''}`,
    mail.attachments.length ? `Attachments (not indexed): ${mail.attachments.map(item => item.filename || '(unnamed)').join(', ')}` : '',
    '', body,
  ].join('\n'));
}
async function extract() {
  if (['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods', '.csv', '.tsv'].includes(extension)) {
    const XLSX = await import('@e965/xlsx');
    const binary = ['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods'].includes(extension);
    if (binary && !buffer.subarray(0, 2).equals(Buffer.from('PK')) &&
        !buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
      throw new Error('Invalid spreadsheet signature. Use a valid Excel or OpenDocument workbook.');
    }
    const book = XLSX.read(binary ? buffer : utf8(), {
      type: binary ? 'buffer' : 'string', cellFormula: false, cellHTML: false,
      ...(extension === '.tsv' ? { FS: '\t' } : {}),
    });
    const sheets = [];
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name];
      if (sheet['!ref']) {
        const range = XLSX.utils.decode_range(sheet['!ref']);
        if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 1_000_000) {
          throw new Error('Spreadsheet range is too large. Export a smaller range or split the workbook.');
        }
      }
      const content = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
      if (content.replace(/[,;\s"]/g, '')) sheets.push(bounded(`[Sheet: ${name}]\n${content}`));
      bounded(sheets.join('\n\n'));
    }
    warnings.push('Spreadsheet text includes sheet names and formatted cell values. Formulas/macros are not executed; cached formula results may be stale or missing. Charts and images are not analyzed.');
    return sheets.join('\n\n');
  }
  if (extension === '.eml') return emailText(buffer);
  if (extension === '.mbox') {
    const content = buffer.toString('latin1');
    if (!/^From \S+ .+/m.test(content)) throw new Error('MBOX has no recognizable message envelope lines.');
    const messages = content.split(/^From \S+ .+\r?$/m);
    if (messages.shift().trim()) throw new Error('Invalid MBOX preamble.');
    const result = [];
    for (const [index, message] of messages.entries()) {
      if (!message.trim()) continue;
      const rawMessage = message.replace(/^\r?\n/, '').replace(/^>(>*From )/gm, '$1');
      result.push(`[Message ${index + 1}]\n${await emailText(Buffer.from(rawMessage, 'latin1'))}`);
      bounded(result.join('\n\n'));
    }
    return result.join('\n\n');
  }
  if (extension === '.msg') {
    const imported = await import('@kenjiuno/msgreader');
    const MsgReader = imported.default.default;
    const mail = new MsgReader(buffer).getFileData();
    if (mail.error) throw new Error('Outlook MSG could not be decoded.');
    const body = mail.body?.trim() || (mail.bodyHtml ? await htmlText(mail.bodyHtml) : '');
    if (!body.trim()) throw new Error('Outlook MSG has no extractable text body. RTF-only or encrypted messages must be exported as EML or text.');
    if (mail.attachments?.length) warnings.push('Email attachments are listed but not extracted. Upload them separately.');
    const recipients = mail.recipients?.map(item => item.smtpAddress || item.email || item.name || '').join('; ') || '';
    return bounded([
      `Subject: ${mail.subject || '(no subject)'}`,
      `From: ${mail.senderName || ''} <${mail.senderSmtpAddress || mail.senderEmail || ''}>`,
      `Recipients: ${recipients}`,
      `Date: ${mail.clientSubmitTime || mail.messageDeliveryTime || ''}`,
      mail.headers || '',
      mail.attachments?.length ? `Attachments (not indexed): ${mail.attachments.map(item => item.fileName || item.fileNameLong || item.fileNameShort || '(unnamed)').join(', ')}` : '',
      '', body,
    ].join('\n'));
  }
  if (extension === '.html' || extension === '.htm') return htmlText(utf8());
  if (['.docx', '.pptx', '.odt', '.odp', '.pdf', '.rtf'].includes(extension)) {
    const { parseOffice } = await import('officeparser');
    const ast = await parseOffice(buffer, {
      ocr: false, extractAttachments: false, ignoreNotes: false, outputErrorToConsole: false,
    });
    if (`.${ast.type}` !== extension) throw new Error('File contents do not match the document extension.');
    warnings.push('Embedded attachments and images are not extracted. Scanned pages require a searchable/OCR text export.');
    const nodeText = node => node.text || (node.children || []).map(nodeText).join('\n');
    if (['pptx', 'odp', 'pdf'].includes(ast.type)) {
      return bounded(ast.content.map((node, index) => {
        const body = nodeText(node).trim();
        return body ? `[${ast.type === 'pdf' ? 'Page' : 'Slide'} ${index + 1}]\n${body}` : '';
      }).filter(Boolean).join('\n\n'));
    }
    return bounded(ast.toText());
  }
  return utf8();
}

try {
  const extracted = bounded((await extract()).replace(/\0/g, '').trim());
  if (!extracted) throw new Error('No readable text found. Image-only/scanned documents need OCR; empty or encrypted documents cannot be indexed.');
  parentPort.postMessage({ content: extracted, warnings: [...new Set(warnings)] });
} catch (error) {
  parentPort.postMessage({
    error: `Cannot extract this document: ${error instanceof Error ? error.message : 'Unknown parsing error'}`,
  });
}
