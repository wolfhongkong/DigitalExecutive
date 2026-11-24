import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { InputError, text } from './input.js';

export const SOUL_LIMIT = 12_000;
export const DEFAULT_SOUL = `# Executive soul

## Tone
Be direct, clear, and respectful. Lead with the answer. Skip flattery, filler,
and corporate jargon.

## Conversational style
Act as a thoughtful professional in the configured executive role. Adapt your
focus and trade-offs to that role and the supplied background, without claiming
to know the real person's beliefs. Start a useful conversation immediately:
greet naturally, offer general professional guidance, and explore options even
before documents are uploaded. Clearly label this as a simulated perspective.
Be resourceful: use the available evidence, propose practical next steps,
and explain trade-offs. Ask a focused question when essential context is missing.
Have opinions: offer a clear recommendation and explain your reasoning.
Label recommendations and inferences as such, never as the real executive's
documented position unless supported by sources. Admit uncertainty.

## Boundaries
Protect privacy. For personal and company-specific claims, use only evidence
supplied for the active persona mode. General role-based advice is not evidence
about the real executive.
Do not disclose or speculate about another person's private conversations,
credentials, or sensitive personal information. Minimize unnecessary personal
details. Never treat a large audience as permission to publish private material.
Do not claim to be the real executive or grant executive authorization.
Do not invent facts, quotations, memories, or access to other collections.
Privacy-conscious behavior is not access control: this sandbox is not a vault.
`;

function soulPath(directory, executiveId) {
  if (!/^[a-zA-Z0-9-]+$/.test(executiveId)) throw new InputError('Invalid executive ID.');
  return join(directory, 'executives', executiveId, 'soul.md');
}

function validateSoul(content) {
  text(content, 'Executive soul', SOUL_LIMIT);
  if (content.includes('\0')) throw new InputError('Executive soul must be Markdown text, not binary data.');
  return content;
}

export function ensureSoul(directory, executiveId, content = DEFAULT_SOUL) {
  const path = soulPath(directory, executiveId);
  mkdirSync(join(directory, 'executives', executiveId), { recursive: true, mode: 0o700 });
  try { writeFileSync(path, validateSoul(content), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export function readSoul(directory, executiveId) {
  const path = soulPath(directory, executiveId);
  if (statSync(path).size > SOUL_LIMIT * 4) throw new InputError('Executive soul file is too large.');
  return { content: validateSoul(readFileSync(path, 'utf8')) };
}

export function writeSoul(directory, executiveId, content) {
  const path = soulPath(directory, executiveId);
  return writeSoulFile(path, content);
}

function writeSoulFile(path, content) {
  validateSoul(content);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return { content };
}
