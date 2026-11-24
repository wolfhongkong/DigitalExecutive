import { mkdirSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { InputError, text } from './input.js';

export const MEMORY_LIMIT = 2000;
export const MEMORY_CATEGORIES = ['priority', 'preference', 'decision', 'commitment', 'context'];

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value)) throw new InputError('Invalid memory namespace ID.');
  return value;
}

export function validateMemoryEntry(input) {
  const content = text(input.content, 'Memory text', MEMORY_LIMIT);
  if (content.includes('\0')) throw new InputError('Memory must be text, not binary data.');
  if (!MEMORY_CATEGORIES.includes(input.category)) throw new InputError('Invalid memory category.');
  if (!['confirmed', 'inference'].includes(input.status)) throw new InputError('Memory status must be confirmed or inference.');
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      !Number.isFinite(Date.parse(`${input.date}T00:00:00Z`)) ||
      new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !== input.date) {
    throw new InputError('Memory date must be a valid YYYY-MM-DD date.');
  }
  return { content, category: input.category, status: input.status, date: input.date };
}

const inline = value => value.replace(/[\r\n]+/g, ' ').replace(/[\\[\]<>#*`]/g, '\\$&');

export function renderMemory(entries, sources = []) {
  const ordered = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const sourceRecords = [...sources].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const months = [...new Set([...ordered, ...sourceRecords].map(entry => entry.date.slice(0, 7)))].sort().reverse();
  const active = ordered.filter(entry => !entry.supersededBy);
  const index = [
    '# Executive memory', '', 'Curated, source-linked memory. Confirmed means user-reviewed, not independently verified.',
    'Recent events take precedence over older conflicting events. Same-date conflicts remain uncertain.', '',
    '## Current Index', '',
    ...(active.length ? active.slice(0, 16).map(entry =>
      `- [${entry.date} | ${entry.category} | ${entry.status}] ${inline(entry.content.slice(0, 200))} [Details](${entry.date.slice(0, 7)}.md#memory-${entry.id})`)
      : ['No curated memories yet.']), '',
    ...(sourceRecords.length ? ['## Processed Sources', '',
      ...sourceRecords.map(source => `- [${source.date} | upload date] [${inline(source.title)}](${source.date.slice(0, 7)}.md#source-${source.id})`), ''] : []),
    '## Monthly Records', '', ...months.map(month => `- [${month}](${month}.md)`), '',
  ].join('\n');
  const files = months.map(month => ({ month, content: [
    `# Executive memory: ${month}`, '',
    ...ordered.filter(entry => entry.date.startsWith(month)).flatMap(entry => [
      `<a id="memory-${entry.id}"></a>`, `## ${entry.date} | ${entry.category} | ${entry.supersededBy ? 'superseded' : entry.status}`, '',
      entry.content, '', `Source: [${inline(entry.sourceTitle)}](/api/documents/${encodeURIComponent(entry.sourceId)})`,
      ...(entry.dreamTopic ? [`Dreaming topic: ${inline(entry.dreamTopic)}. Date basis: ${entry.dateBasis === 'event' ? 'event date' : 'upload date fallback'}.`,
        `Evidence: ${entry.evidence}`] : []),
      ...(entry.supersededBy ? [`Superseded by memory ${entry.supersededBy}.`] : []), '',
    ]),
    ...sourceRecords.filter(source => source.date.startsWith(month)).flatMap(source => [
      `<a id="source-${source.id}"></a>`, `## Source: ${inline(source.title)}`, '',
      `Uploaded: ${source.date}. This is an upload date, not a known event date.`,
      `Processed by Dreaming. [Read source](/api/documents/${encodeURIComponent(source.id)})`,
      ...(entries.some(entry => entry.sourceId === source.id) ? []
        : ['No durable memories were extracted from this source. It remains available as RAG evidence.']), '',
    ]),
  ].join('\n') }));
  return { index, files };
}

export function writeAtomic(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function syncExecutiveMemory(directory, executiveId, entries, sources = []) {
  const root = join(directory, 'executives', identifier(executiveId));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const groups = new Map([['public', []]]);
  for (const entry of entries) {
    const key = entry.scope === 'public' ? 'public' : `${entry.scope}/${identifier(entry.profileId)}`;
    if (!['public', 'enriched', 'twin'].includes(entry.scope)) throw new InputError('Invalid memory scope.');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const source of sources) {
    const key = source.scope === 'public' ? 'public' : `${source.scope}/${identifier(source.profileId)}`;
    if (!['public', 'enriched', 'twin'].includes(source.scope)) throw new InputError('Invalid memory scope.');
    if (!groups.has(key)) groups.set(key, []);
  }
  const memoryRoot = join(root, 'memory');
  mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
  for (const scope of ['enriched', 'twin']) {
    const scopeRoot = join(memoryRoot, scope);
    mkdirSync(scopeRoot, { recursive: true, mode: 0o700 });
    for (const item of readdirSync(scopeRoot, { withFileTypes: true })) {
      if (item.isDirectory() && /^[a-zA-Z0-9-]+$/.test(item.name) && !groups.has(`${scope}/${item.name}`)) {
        groups.set(`${scope}/${item.name}`, []);
      }
    }
  }
  for (const [key, memories] of groups) {
    const target = key === 'public' ? join(memoryRoot, 'public') : join(memoryRoot, ...key.split('/'));
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const groupSources = sources.filter(source => (source.scope === 'public' ? 'public' : `${source.scope}/${source.profileId}`) === key);
    const rendered = renderMemory(memories, groupSources);
    const months = new Set(rendered.files.map(file => `${file.month}.md`));
    for (const name of readdirSync(target)) {
      if (/^\d{4}-\d{2}\.md$/.test(name) && !months.has(name)) rmSync(join(target, name));
    }
    for (const file of rendered.files) writeAtomic(join(target, `${file.month}.md`), file.content);
    const indexPath = key === 'public' ? join(root, 'memory.md') : join(target, 'memory.md');
    if (key !== 'public' && !memories.length && !groupSources.length) {
      rmSync(indexPath, { force: true });
      continue;
    }
    const index = key === 'public'
      ? rendered.index.replace(/\]\((\d{4}-\d{2}\.md[^)]*)\)/g, '](memory/public/$1)') : rendered.index;
    writeAtomic(indexPath, index);
  }
  return { path: relative(directory, join(root, 'memory.md')).split('\\').join('/') };
}