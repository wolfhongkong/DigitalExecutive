import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, rmSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DEFAULT_SOUL, ensureSoul, readSoul, writeSoul } from './soul.js';
import { InputError, text } from './input.js';
import { recordingSegments, validateAssignments } from './recordings.js';
import { validateFingerprints, expectedSpeakerCount } from './voice-fingerprints.js';
import { cosine } from './embeddings.js';
import { normalizeCompanyProfile } from './company-profile.js';
import { renderMemory, syncExecutiveMemory, validateMemoryEntry } from './executive-memory.js';
import { currentFindings, dreamedSoul, soulBase } from './dreaming.js';
import { relationshipPath, renderRelationship, syncRelationships } from './chat-memory.js';
import { BUILTIN_PREFIX, PREDEFINED_EXECUTIVES, inferKnowledgeDomains, loadBuiltinKnowledge, predefinedSoul,
  validateKnowledgeDomains } from './builtin-knowledge.js';
export { InputError, text } from './input.js';

export function createStore(directory, { voiceIdentityThreshold = 0.8, builtinKnowledge = loadBuiltinKnowledge() } = {}) {
  if (!Number.isFinite(voiceIdentityThreshold) || voiceIdentityThreshold <= 0 || voiceIdentityThreshold > 1) {
    throw new InputError('Invalid voice identity threshold.');
  }
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'sandbox.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS executives (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
      bio TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES profiles(id)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, executive_id TEXT NOT NULL REFERENCES executives(id),
      profile_id TEXT NOT NULL REFERENCES profiles(id), scope TEXT NOT NULL,
      title TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, executive_id TEXT NOT NULL REFERENCES executives(id),
      profile_id TEXT NOT NULL REFERENCES profiles(id), mode TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL,
      engine TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS originals (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      storage_name TEXT NOT NULL, filename TEXT NOT NULL, bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recording_reviews (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      segments TEXT NOT NULL, assignments TEXT NOT NULL, generated TEXT NOT NULL,
      tracking_error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS voice_samples (
      document_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      executive_id TEXT NOT NULL REFERENCES executives(id),
      model TEXT NOT NULL, embedding TEXT NOT NULL, duration REAL NOT NULL,
      PRIMARY KEY (document_id, segment_index)
    );
    CREATE INDEX IF NOT EXISTS voice_samples_profile ON voice_samples(profile_id, executive_id);
    CREATE TABLE IF NOT EXISTS executive_memories (
      id TEXT PRIMARY KEY,
      executive_id TEXT NOT NULL REFERENCES executives(id),
      source_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES profiles(id), scope TEXT NOT NULL,
      content TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
      date TEXT NOT NULL, created_at TEXT NOT NULL, superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS executive_memories_scope ON executive_memories(executive_id, scope, profile_id);
    CREATE TABLE IF NOT EXISTS dream_findings (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      memory_id TEXT REFERENCES executive_memories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL, date TEXT NOT NULL,
      date_basis TEXT NOT NULL, evidence TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dream_sources (
      source_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      hash TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS company_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
    );
    INSERT OR IGNORE INTO dream_sources SELECT DISTINCT source_id FROM dream_findings;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
      name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, executive_id TEXT NOT NULL REFERENCES executives(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES profiles(id), mode TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'conversation_id')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE');
      for (const group of db.prepare('SELECT executive_id, profile_id, mode, MIN(created_at) AS created_at, MAX(created_at) AS updated_at FROM messages GROUP BY executive_id, profile_id, mode').all()) {
        const id = randomUUID();
        const first = db.prepare("SELECT content FROM messages WHERE executive_id = ? AND profile_id = ? AND mode = ? AND role = 'user' ORDER BY rowid LIMIT 1")
          .get(group.executive_id, group.profile_id, group.mode);
        db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
          .run(id, group.executive_id, group.profile_id, group.mode, first?.content.slice(0, 80) || 'Previous conversation', group.created_at, group.updated_at);
        db.prepare('UPDATE messages SET conversation_id = ? WHERE executive_id = ? AND profile_id = ? AND mode = ?')
          .run(id, group.executive_id, group.profile_id, group.mode);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id)');
  // Episodic memory follows its chat: deleting a message or conversation forgets what was extracted from it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_memories (
      id TEXT PRIMARY KEY, executive_id TEXT NOT NULL REFERENCES executives(id),
      profile_id TEXT NOT NULL REFERENCES profiles(id), mode TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, topic TEXT NOT NULL, content TEXT NOT NULL, evidence TEXT NOT NULL,
      speaker TEXT NOT NULL, date TEXT NOT NULL, created_at TEXT NOT NULL, superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_memories_scope ON chat_memories(executive_id, profile_id, mode);
    CREATE INDEX IF NOT EXISTS chat_memories_message ON chat_memories(message_id);
  `);
  if (!db.prepare('PRAGMA table_info(recording_reviews)').all().some(column => column.name === 'tracking_error')) {
    db.exec("ALTER TABLE recording_reviews ADD COLUMN tracking_error TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare('PRAGMA table_info(recording_reviews)').all().some(column => column.name === 'analysis_warnings')) {
    db.exec("ALTER TABLE recording_reviews ADD COLUMN analysis_warnings TEXT NOT NULL DEFAULT '[]'");
  }
  for (const [name, definition] of Object.entries({
    voice_embeddings: "TEXT NOT NULL DEFAULT '{}'",
    voice_suggestions: "TEXT NOT NULL DEFAULT '[]'",
    remember_voices: 'INTEGER NOT NULL DEFAULT 0',
    assignments_reviewed: 'INTEGER NOT NULL DEFAULT 1',
    expected_speakers: 'INTEGER',
  })) {
    if (!db.prepare('PRAGMA table_info(recording_reviews)').all().some(column => column.name === name)) {
      db.exec(`ALTER TABLE recording_reviews ADD COLUMN ${name} ${definition}`);
    }
  }
  if (!db.prepare('PRAGMA table_info(documents)').all().some(column => column.name === 'derived_from')) {
    db.exec('ALTER TABLE documents ADD COLUMN derived_from TEXT REFERENCES documents(id) ON DELETE CASCADE');
  }
  if (!db.prepare('PRAGMA table_info(executives)').all().some(column => column.name === 'knowledge_domains')) {
    db.exec('BEGIN');
    try {
      db.exec("ALTER TABLE executives ADD COLUMN knowledge_domains TEXT NOT NULL DEFAULT '[]'");
      for (const item of db.prepare('SELECT id, role FROM executives').all()) {
        db.prepare('UPDATE executives SET knowledge_domains = ? WHERE id = ?').run(JSON.stringify(inferKnowledgeDomains(item.role)), item.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const insertExecutive = db.prepare('INSERT INTO executives (id, name, role, bio, owner_id, knowledge_domains) VALUES (?, ?, ?, ?, ?, ?)');
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    // Each executive represents a person who can log in; its twin collection belongs to that person.
    db.exec('BEGIN');
    try {
      for (const item of db.prepare(`SELECT executives.id, executives.name FROM executives
        JOIN profiles ON profiles.id = executives.owner_id WHERE profiles.name != executives.name`).all()) {
        db.prepare('INSERT OR IGNORE INTO profiles VALUES (?, ?)').run(item.id, item.name);
        const twin = "executive_id = ? AND scope = 'twin'";
        db.prepare(`UPDATE voice_samples SET profile_id = ? WHERE document_id IN (SELECT id FROM documents WHERE ${twin})`).run(item.id, item.id);
        db.prepare(`UPDATE documents SET profile_id = ? WHERE ${twin}`).run(item.id, item.id);
        db.prepare(`UPDATE executive_memories SET profile_id = ? WHERE ${twin}`).run(item.id, item.id);
        db.prepare("UPDATE conversations SET profile_id = ?, project_id = NULL WHERE executive_id = ? AND mode = 'twin'").run(item.id, item.id);
        db.prepare("UPDATE messages SET profile_id = ? WHERE executive_id = ? AND mode = 'twin'").run(item.id, item.id);
        db.prepare('UPDATE executives SET owner_id = ? WHERE id = ?').run(item.id, item.id);
      }
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT id FROM profiles LIMIT 1').get()) {
    db.prepare('INSERT INTO profiles VALUES (?, ?)').run('alex', 'Alex Morgan');
    db.prepare('INSERT INTO profiles VALUES (?, ?)').run('jordan', 'Jordan Lee');
    insertExecutive.run(
      'alex-executive', 'Alex Morgan', 'Chief Executive Officer',
      'A fictional executive for experimenting with strategy, priorities, and communication.', 'alex',
      JSON.stringify(inferKnowledgeDomains('Chief Executive Officer')),
    );
    insertDocument({
      executiveId: 'alex-executive', profileId: 'alex', scope: 'public',
      title: 'Sample public strategy note (fictional)',
      content: 'Our strategy is to improve customer trust through reliable products, transparent communication, and measurable outcomes. This quarter we prioritize service reliability and customer onboarding over expanding into new markets. Teams should propose small experiments, define success metrics, and share what they learn.',
    });
  }
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    // Seeded once, so deleted predefined executives are not recreated on restart.
    db.exec('BEGIN');
    try {
      for (const item of PREDEFINED_EXECUTIVES) {
        if (db.prepare('SELECT 1 FROM executives WHERE id = ?').get(item.id)) continue;
        db.prepare('INSERT OR IGNORE INTO profiles VALUES (?, ?)').run(item.id, item.name);
        insertExecutive.run(item.id, item.name, item.role, item.bio, item.id, JSON.stringify(validateKnowledgeDomains(item.domains)));
        ensureSoul(directory, item.id, predefinedSoul(DEFAULT_SOUL, item));
      }
      db.exec('PRAGMA user_version = 2');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  try {
    for (const item of db.prepare('SELECT id FROM executives').all()) {
      ensureSoul(directory, item.id);
      syncMemory(item.id);
      syncDreamSoul(item.id);
      syncRelationshipMemory(item.id);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  function profile(id) {
    if (!db.prepare('SELECT id FROM profiles WHERE id = ?').get(text(id, 'Profile ID'))) {
      throw new InputError('Profile not found.', 404);
    }
  }
  function executive(id) {
    const executive = db.prepare('SELECT * FROM executives WHERE id = ?')
      .get(text(id, 'Executive ID'));
    if (!executive) throw new InputError('Executive not found.', 404);
    return executive;
  }
  function publicExecutive({ knowledge_domains: domains, ...item }) {
    return { ...item, knowledgeDomains: JSON.parse(domains) };
  }
  function context(input) {
    profile(input.profileId);
    const item = executive(input.executiveId);
    if (!['public', 'enriched', 'twin'].includes(input.mode)) throw new InputError('Invalid persona mode.');
    return item;
  }
  function insertDocument(input, id = randomUUID()) {
    const executive = context({ ...input, mode: 'public' });
    if (!['public', 'enriched', 'twin'].includes(input.scope)) throw new InputError('Invalid document scope.');
    const title = text(input.title, 'Document title');
    const content = text(input.content, 'Document text', 200_000);
    if (content.includes('\0')) throw new InputError('Upload a text document, not a binary file.');
    // Twin knowledge belongs to the executive, regardless of the active sandbox profile.
    const owner = input.scope === 'twin' ? executive.owner_id : input.profileId;
    db.exec('SAVEPOINT insert_document');
    try {
      db.prepare('INSERT INTO documents (id, executive_id, profile_id, scope, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.executiveId, owner, input.scope, title, content, new Date().toISOString());
      if (input.original) {
        db.prepare('INSERT INTO originals VALUES (?, ?, ?, ?)')
          .run(id, input.original.storageName, input.original.filename, input.original.bytes);
      }
      const insert = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
      const words = content.split(/\s+/);
      for (let start = 0, index = 0; start < words.length; start += 150, index++) {
        insert.run(randomUUID(), id, index, words.slice(start, start + 190).join(' '));
      }
      db.exec('RELEASE insert_document');
    } catch (error) {
      db.exec('ROLLBACK TO insert_document; RELEASE insert_document');
      throw error;
    }
    return { id };
  }
  function uploadScope(input) {
    const item = context({ ...input, mode: 'public' });
    return item.owner_id === input.profileId ? 'twin' : 'enriched';
  }
  function visibleDocuments(input) {
    context(input);
    // Concrete knowledge is visible only to its uploader; the twin collection belongs to the executive's own person.
    return db.prepare(`
      SELECT id, title, scope, profile_id, created_at, length(content) AS characters, derived_from AS derivedFrom,
        EXISTS(SELECT 1 FROM originals WHERE document_id = documents.id) AS hasOriginal,
        (SELECT filename FROM originals WHERE document_id = documents.id) AS originalFilename,
        COALESCE((SELECT filename FROM originals WHERE document_id = documents.id),
          (SELECT filename FROM originals WHERE document_id = documents.derived_from)) AS sourceFilename,
        (EXISTS(SELECT 1 FROM recording_reviews WHERE document_id = documents.id)
          OR content LIKE '%TIMESTAMPED SPEECH TRANSCRIPT%') AS speakerReview,
        (SELECT CASE WHEN generated = '[]' THEN 'pending' ELSE 'published' END
          FROM recording_reviews WHERE document_id = documents.id) AS reviewStatus
      FROM documents WHERE executive_id = ? AND (
        scope = 'public' OR (? != 'public' AND scope IN ('enriched', 'twin') AND profile_id = ?)
      ) ORDER BY created_at DESC
    `).all(input.executiveId, input.mode, input.profileId)
      .map(document => {
        const extension = extname(document.sourceFilename || document.title).toLowerCase();
        const type = ['.eml', '.msg', '.mbox'].includes(extension) ? 'mails'
          : ['.mp4', '.mov', '.webm', '.mkv'].includes(extension) ? 'videos'
          : ['.ppt', '.pptx', '.pps', '.ppsx', '.odp', '.key'].includes(extension) ? 'presentations' : 'others';
        return { ...document, type };
      });
  }
  function memoryRows(executiveId) {
    return db.prepare(`SELECT executive_memories.id, executive_memories.content, category, status, executive_memories.date,
      executive_memories.scope, executive_memories.profile_id AS profileId, executive_memories.source_id AS sourceId,
      documents.title AS sourceTitle, superseded_by AS supersededBy,
      dream_findings.topic AS dreamTopic, dream_findings.date_basis AS dateBasis, dream_findings.evidence FROM executive_memories
      JOIN documents ON documents.id = executive_memories.source_id
      LEFT JOIN dream_findings ON dream_findings.memory_id = executive_memories.id WHERE executive_memories.executive_id = ?
      ORDER BY executive_memories.date DESC, executive_memories.created_at DESC, executive_memories.id DESC`).all(executiveId);
  }
  function visibleMemories(input) {
    const documents = new Set(visibleDocuments(input).map(document => document.id));
    return memoryRows(input.executiveId).filter(entry => documents.has(entry.sourceId));
  }
  const memoryText = entry => `Curated memory | ${entry.date} | ${entry.category} | ${entry.status}\n${entry.content}`;
  // Everything retrieval can rank: visible chunks, active curated memories and the executive's built-in sections.
  function retrievalCandidates(input) {
    const documents = visibleDocuments(input);
    const domains = JSON.parse(executive(input.executiveId).knowledge_domains);
    const builtin = builtinKnowledge.documents.filter(document => domains.includes(document.domain));
    const ids = documents.map(document => document.id);
    const placeholders = ids.map(() => '?').join(', ');
    const chunks = ids.length ? db.prepare(`SELECT * FROM chunks WHERE document_id IN (${placeholders})`).all(...ids) : [];
    for (const entry of visibleMemories(input).filter(memory => !memory.supersededBy)) {
      chunks.push({ document_id: entry.sourceId, content: memoryText(entry),
        memoryId: entry.id, memoryStatus: entry.status, eventDate: entry.date });
    }
    for (const document of builtin) {
      for (const content of document.chunks) chunks.push({ document_id: document.id, content, builtin: document });
    }
    return { documents, ids, placeholders, chunks };
  }
  // All texts that any person could retrieve; used to index in the background and to drop stale vectors.
  function allRetrievalTexts() {
    const texts = new Set(db.prepare('SELECT content FROM chunks').all().map(row => row.content));
    for (const { id } of db.prepare('SELECT id FROM executives').all()) {
      for (const entry of memoryRows(id)) if (!entry.supersededBy) texts.add(memoryText(entry));
    }
    for (const document of builtinKnowledge.documents) for (const content of document.chunks) texts.add(content);
    return texts;
  }
  const embeddingHash = (model, content) => createHash('sha256').update(`${model}\n${content}`).digest('hex');
  const vectorCache = new Map();
  const selectVector = db.prepare('SELECT vector FROM embeddings WHERE hash = ?');
  function cachedVector(model, content) {
    const hash = embeddingHash(model, content);
    if (vectorCache.has(hash)) return vectorCache.get(hash);
    const row = selectVector.get(hash);
    if (!row) return null;
    const bytes = row.vector;
    const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    vectorCache.set(hash, vector);
    return vector;
  }
  function dreamedSources(executiveId) {
    return db.prepare(`SELECT documents.id, title, substr(created_at, 1, 10) AS date, scope,
      profile_id AS profileId FROM dream_sources JOIN documents ON documents.id = source_id
      WHERE executive_id = ?`).all(executiveId);
  }
  function syncMemory(executiveId) {
    return syncExecutiveMemory(directory, executiveId, memoryRows(executiveId), dreamedSources(executiveId));
  }
  function relationshipRows(executiveId, profileId) {
    return db.prepare(`SELECT chat_memories.id, chat_memories.profile_id AS profileId, chat_memories.mode, kind, topic,
      chat_memories.content, evidence, speaker, date, superseded_by AS supersededBy,
      messages.conversation_id AS conversationId, conversations.title AS conversationTitle
      FROM chat_memories JOIN messages ON messages.id = chat_memories.message_id
      LEFT JOIN conversations ON conversations.id = messages.conversation_id
      WHERE chat_memories.executive_id = ? AND (? IS NULL OR chat_memories.profile_id = ?)
      ORDER BY chat_memories.created_at DESC, chat_memories.rowid DESC`).all(executiveId, profileId ?? null, profileId ?? null);
  }
  function syncRelationshipMemory(executiveId) {
    const item = db.prepare('SELECT * FROM executives WHERE id = ?').get(executiveId);
    if (!item) return;
    const rows = relationshipRows(executiveId);
    const people = db.prepare('SELECT * FROM profiles WHERE id IN (SELECT profile_id FROM chat_memories WHERE executive_id = ?)').all(executiveId);
    syncRelationships(directory, item, people.map(person => ({ person, entries: rows.filter(row => row.profileId === person.id) })));
  }
  function dreamRows(executiveId) {
    return db.prepare(`SELECT dream_findings.id, memory_id AS memoryId, kind, topic,
      dream_findings.content, date, date_basis AS dateBasis, evidence, source_id AS sourceId,
      documents.scope, documents.profile_id AS profileId,
      (SELECT superseded_by FROM executive_memories WHERE executive_memories.id = memory_id) AS supersededBy FROM dream_findings
      JOIN documents ON documents.id = source_id WHERE executive_id = ? ORDER BY dream_findings.rowid`).all(executiveId);
  }
  function syncDreamSoul(executiveId) {
    const rows = dreamRows(executiveId);
    const base = soulBase(readSoul(directory, executiveId).content);
    writeSoul(directory, executiveId, dreamedSoul(base, rows));
    const root = join(directory, 'executives', executiveId, 'memory');
    for (const scope of ['enriched', 'twin']) {
      for (const item of readdirSync(join(root, scope), { withFileTypes: true })) {
        if (item.isDirectory() && /^[a-zA-Z0-9-]+$/.test(item.name)) {
          rmSync(join(root, scope, item.name, 'soul.md'), { force: true });
        }
      }
    }
  }
  function splitVoiceData(segments) {
    const embeddings = {};
    const clean = segments.map(({ voiceFingerprint, ...segment }, index) => {
      if (voiceFingerprint && segment.end - segment.start >= 2 &&
          !segments.some((other, position) => position !== index && other.start < segment.end && segment.start < other.end)) {
        if (voiceFingerprint.model !== 'speechbrain/spkrec-ecapa-voxceleb') throw new InputError('Unsupported voice fingerprint model.');
        const vector = validateFingerprints([{ index, embedding: voiceFingerprint.embedding }], [index]).get(index);
        if (vector) embeddings[index] = { model: voiceFingerprint.model, embedding: vector };
      }
      return segment;
    });
    return { clean, embeddings };
  }
  // Confirmed voice samples are shared by all users, regardless of who uploaded the recording.
  function voiceSuggestions(segments, embeddings, { excludeDocumentId = '', diagnostics = false } = {}) {
    const references = new Map();
    for (const sample of db.prepare('SELECT * FROM voice_samples WHERE document_id != ? ORDER BY duration DESC, document_id, segment_index').all(excludeDocumentId)) {
      const key = `${sample.executive_id}:${sample.model}`;
      if (!references.has(key)) references.set(key, { id: sample.executive_id, model: sample.model, recordings: new Map() });
      const recordings = references.get(key).recordings;
      if (!recordings.has(sample.document_id)) recordings.set(sample.document_id, []);
      if (recordings.get(sample.document_id).length < 5) recordings.get(sample.document_id).push(JSON.parse(sample.embedding));
    }
    const matches = segments.map((segment, index) => {
      const sample = embeddings[index];
      if (!sample) return { status: 'no-fingerprint', executiveId: null };
      const scores = [...references.values()].filter(reference => reference.model === sample.model).map(reference => {
        const recordings = [...reference.recordings.values()].map(vectors => vectors.map(vector =>
          sample.embedding.reduce((sum, value, position) => sum + value * vector[position], 0)));
        return { id: reference.id, score: Math.max(...recordings.map(similarities => {
          const ordered = [...similarities].sort((first, second) => first - second);
          return ordered.length < 3 ? ordered[0] : ordered[Math.floor((ordered.length - 1) / 2)];
        })),
          strongest: Math.max(...recordings.flat()) };
      }).sort((a, b) => b.score - a.score);
      if (!scores.length) return { status: 'no-references', executiveId: null };
      const best = scores[0];
      const competitorScore = scores.length > 1 ? Math.max(...scores.slice(1).map(candidate => candidate.strongest)) : null;
      const status = best.score < voiceIdentityThreshold ? 'below-threshold'
        : competitorScore !== null && best.score - competitorScore < 0.1 ? 'ambiguous' : 'matched';
      return { status, executiveId: status === 'matched' ? best.id : null, candidateId: best.id,
        score: best.score, competitorScore, threshold: voiceIdentityThreshold, requiredMargin: 0.1 };
    });
    const groups = new Map();
    for (const [index, segment] of segments.entries()) {
      if (!segment.speakerId) continue;
      if (!groups.has(segment.speakerId)) groups.set(segment.speakerId, []);
      groups.get(segment.speakerId).push(index);
    }
    for (const indices of groups.values()) {
      const confident = indices.filter(index => matches[index].status === 'matched');
      const identities = new Set(confident.map(index => matches[index].executiveId));
      if (confident.length < 2 || identities.size !== 1) continue;
      const id = matches[confident[0]].executiveId;
      for (const index of indices) {
        const match = matches[index];
        if (match.status !== 'below-threshold' || match.candidateId !== id ||
            (match.competitorScore !== null && match.score - match.competitorScore < match.requiredMargin)) continue;
        const support = confident.map(other => embeddings[index].embedding.reduce((sum, value, position) =>
          sum + value * embeddings[other].embedding[position], 0));
        const groupScore = Math.min(...support);
        if (groupScore < voiceIdentityThreshold) continue;
        matches[index] = { ...match, status: 'group-supported', executiveId: id, groupScore };
      }
    }
    return diagnostics ? matches : matches.map(match => match.executiveId);
  }
  function storeAssignedVoices(review, assignments) {
    db.prepare('DELETE FROM voice_samples WHERE document_id = ?').run(review.id);
    const row = db.prepare('SELECT voice_embeddings FROM recording_reviews WHERE document_id = ?').get(review.id);
    const embeddings = JSON.parse(row?.voice_embeddings || '{}');
    const insert = db.prepare('INSERT INTO voice_samples VALUES (?, ?, ?, ?, ?, ?, ?)');
    const candidates = assignments.map((id, index) => ({ id, index }))
      .filter(item => item.id && embeddings[item.index])
      .sort((a, b) => review.segments[b.index].end - review.segments[b.index].start -
        (review.segments[a.index].end - review.segments[a.index].start));
    for (const id of new Set(candidates.map(candidate => candidate.id))) {
      const group = candidates.filter(candidate => candidate.id === id);
      const ranked = group.map(candidate => {
        const similarities = group.filter(other => other.index !== candidate.index).map(other =>
          embeddings[candidate.index].embedding.reduce((sum, value, position) =>
            sum + value * embeddings[other.index].embedding[position], 0)).sort((first, second) => first - second);
        return { ...candidate, consistency: similarities.length ? similarities[Math.floor((similarities.length - 1) / 2)] : 1 };
      }).filter(candidate => group.length < 3 || candidate.consistency >= 0.45)
        .sort((first, second) => second.consistency - first.consistency).slice(0, 5);
      for (const { index } of ranked) {
        const sample = embeddings[index];
        insert.run(review.id, index, review.profileId, id, sample.model, JSON.stringify(sample.embedding),
          Math.min(8, review.segments[index].end - review.segments[index].start));
      }
    }
  }
  return {
    close: () => db.close(),
    context,
    state: () => ({
      profiles: db.prepare('SELECT * FROM profiles ORDER BY name').all(),
      executives: db.prepare('SELECT * FROM executives ORDER BY name').all().map(publicExecutive),
    }),
    builtinCatalog: () => builtinKnowledge.catalog,
    addProfile(name) {
      const item = { id: randomUUID(), name: text(name, 'Profile name', 80) };
      db.prepare('INSERT INTO profiles VALUES (?, ?)').run(item.id, item.name);
      return item;
    },
    addExecutive(input) {
      const item = {
        id: randomUUID(), name: text(input.name, 'Executive name', 80),
        role: text(input.role, 'Executive role', 120),
        bio: typeof input.bio === 'string' ? input.bio.trim() : '',
      };
      if (item.bio.length > 2000) throw new InputError('Bio must be at most 2000 characters.');
      item.knowledgeDomains = input.knowledgeDomains === undefined
        ? inferKnowledgeDomains(item.role) : validateKnowledgeDomains(input.knowledgeDomains);
      ensureSoul(directory, item.id);
      syncExecutiveMemory(directory, item.id, []);
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO profiles VALUES (?, ?)').run(item.id, item.name);
        insertExecutive.run(item.id, item.name, item.role, item.bio, item.id, JSON.stringify(item.knowledgeDomains));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return publicExecutive(executive(item.id));
    },
    updateExecutive(id, input) {
      const current = executive(id);
      const name = text(input.name === undefined ? current.name : input.name, 'Executive name', 80);
      const role = text(input.role === undefined ? current.role : input.role, 'Executive role', 120);
      const bio = input.bio === undefined ? current.bio : input.bio;
      if (typeof bio !== 'string' || bio.length > 2000 || bio.includes('\0')) throw new InputError('Executive background must be text of at most 2000 characters.');
      if (input.ownerId !== undefined && input.ownerId !== current.owner_id) throw new InputError('Executive ownership cannot be changed by editing its profile.');
      const domains = input.knowledgeDomains === undefined ? current.knowledge_domains : JSON.stringify(validateKnowledgeDomains(input.knowledgeDomains));
      db.prepare('UPDATE executives SET name = ?, role = ?, bio = ?, knowledge_domains = ? WHERE id = ?').run(name, role, bio.trim(), domains, current.id);
      if (current.owner_id === current.id) db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(name, current.id);
      // Names appear in relationship files, including those where this executive is the conversation partner.
      for (const other of db.prepare('SELECT DISTINCT executive_id FROM chat_memories').all()) syncRelationshipMemory(other.executive_id);
      return publicExecutive(executive(current.id));
    },
    deleteExecutive(id) {
      const item = executive(id);
      const documents = db.prepare('SELECT id FROM documents WHERE executive_id = ?').all(item.id).map(document => document.id);
      const removed = new Set(documents);
      const originals = documents.length ? db.prepare(`SELECT DISTINCT storage_name FROM originals WHERE document_id IN
        (${documents.map(() => '?').join(', ')})`).all(...documents).map(original => original.storage_name) : [];
      db.exec('BEGIN');
      try {
        for (const review of db.prepare('SELECT document_id, assignments, voice_suggestions, generated FROM recording_reviews').all()) {
          if (removed.has(review.document_id)) continue;
          const assignments = JSON.parse(review.assignments).map(target => target === item.id ? null : target);
          const suggestions = JSON.parse(review.voice_suggestions).map(target => target === item.id ? null : target);
          const generated = JSON.parse(review.generated).filter(source => source.executiveId !== item.id && !removed.has(source.documentId));
          db.prepare('UPDATE recording_reviews SET assignments = ?, voice_suggestions = ?, generated = ? WHERE document_id = ?').run(
            JSON.stringify(assignments), JSON.stringify(suggestions), JSON.stringify(generated), review.document_id,
          );
        }
        db.prepare('DELETE FROM voice_samples WHERE executive_id = ?').run(item.id);
        db.prepare('DELETE FROM executive_memories WHERE executive_id = ?').run(item.id);
        db.prepare('DELETE FROM messages WHERE executive_id = ?').run(item.id);
        db.prepare('DELETE FROM documents WHERE executive_id = ?').run(item.id);
        db.prepare('DELETE FROM executives WHERE id = ?').run(item.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      for (const name of originals) {
        if (!db.prepare('SELECT 1 FROM originals WHERE storage_name = ?').get(name)) rmSync(join(directory, 'originals', name), { force: true });
      }
      rmSync(join(directory, 'executives', item.id), { recursive: true, force: true });
      return { deleted: true };
    },
    soul(id, input) {
      const item = executive(id);
      if (input) context({ ...input, executiveId: id });
      return readSoul(directory, item.id);
    },
    saveSoul(id, content) {
      const result = writeSoul(directory, executive(id).id, content);
      syncDreamSoul(id);
      return result;
    },
    dreamingSnapshot(input) {
      const item = context(input);
      const owner = input.mode === 'twin' ? item.owner_id : input.profileId;
      const documents = visibleDocuments(input).filter(document => document.scope === input.mode && !document.speakerReview)
        .map(document => ({ ...document, content: this.document(document.id).content }));
      return { executive: item, documents, input: { ...input, profileId: owner },
        traitTopics: [...new Set(dreamRows(item.id).filter(row => row.kind === 'trait').map(row => row.topic))],
        fingerprint: JSON.stringify(documents), soul: readSoul(directory, item.id).content };
    },
    saveDream(snapshot, findings) {
      const { input } = snapshot;
      const current = this.dreamingSnapshot(input);
      if (snapshot.fingerprint !== current.fingerprint || snapshot.soul !== current.soul) {
        throw new InputError('Knowledge or soul changed during Dreaming. Retry Dreaming with the current sources.', 409);
      }
      const sourceIds = new Set(snapshot.documents.map(document => document.id));
      if (findings.some(item => !sourceIds.has(item.sourceId))) throw new InputError('Dreaming source is outside this collection.');
      db.exec('BEGIN');
      try {
        const previous = dreamRows(input.executiveId).filter(row => row.scope === input.mode &&
          (input.mode === 'public' || row.profileId === input.profileId));
        for (const document of snapshot.documents) {
          db.prepare('INSERT OR IGNORE INTO dream_sources VALUES (?)').run(document.id);
        }
        for (const row of previous) {
          if (row.memoryId) db.prepare('DELETE FROM executive_memories WHERE id = ?').run(row.memoryId);
          else db.prepare('DELETE FROM dream_findings WHERE id = ?').run(row.id);
        }
        const reused = new Set();
        const rows = findings.map(finding => {
          const old = previous.find(row => !reused.has(row.id) && row.sourceId === finding.sourceId &&
            row.kind === finding.kind && row.topic === finding.topic && row.date === finding.date);
          if (old) reused.add(old.id);
          const manualReplacement = old?.supersededBy && !previous.some(row => row.memoryId === old.supersededBy)
            ? old.supersededBy : null;
          return { ...finding, id: old?.id || randomUUID(),
            memoryId: finding.kind === 'memory' ? old?.memoryId || randomUUID() : null, manualReplacement };
        });
        const active = new Set(currentFindings(rows).map(row => row.id));
        for (const row of rows) {
          const source = snapshot.documents.find(document => document.id === row.sourceId);
          if (row.memoryId) {
            const replacement = rows.find(other => other.kind === row.kind && other.topic === row.topic && active.has(other.id));
            db.prepare('INSERT INTO executive_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
              row.memoryId, input.executiveId, row.sourceId, source.profile_id, source.scope,
              row.content,
              row.category, 'inference', row.date, new Date().toISOString(),
              row.manualReplacement || (active.has(row.id) ? null : replacement.memoryId),
            );
          }
          db.prepare('INSERT INTO dream_findings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            row.id, row.sourceId, row.memoryId, row.kind, row.topic, row.content, row.date, row.dateBasis, row.evidence,
          );
        }
        syncMemory(input.executiveId);
        syncDreamSoul(input.executiveId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        writeSoul(directory, input.executiveId, snapshot.soul);
        syncMemory(input.executiveId);
        syncDreamSoul(input.executiveId);
        throw error;
      }
      return { status: 'completed', executiveId: input.executiveId, scope: input.mode,
        documents: snapshot.documents.length, memories: findings.filter(item => item.kind === 'memory').length,
        sourceMonths: new Set(snapshot.documents.map(document => document.created_at.slice(0, 7))).size,
        traits: findings.filter(item => item.kind === 'trait').length };
    },
    memory(input) {
      context(input);
      syncMemory(input.executiveId);
      const entries = visibleMemories(input);
      const allowed = new Set(visibleDocuments(input).map(document => document.id));
      const sources = dreamedSources(input.executiveId).filter(source => allowed.has(source.id));
      const rendered = renderMemory(entries, sources);
      return { entries, sources, index: rendered.index, months: rendered.files };
    },
    addMemory(input) {
      context(input);
      const entry = validateMemoryEntry(input);
      const source = visibleDocuments(input).find(document => document.id === input.sourceId);
      if (!source) throw new InputError('Memory source must be visible for this executive and persona mode.', 404);
      if (source.speakerReview) throw new InputError('Use a published, speaker-assigned source, not a recording review, for executive memory.');
      const id = randomUUID();
      const previous = input.supersedes ? visibleMemories(input).find(memory => memory.id === input.supersedes) : undefined;
      if (input.supersedes && (!previous || previous.supersededBy || previous.scope !== source.scope || previous.profileId !== source.profile_id)) {
        throw new InputError('Superseded memory must be active and in the same source visibility namespace.');
      }
      db.exec('BEGIN');
      try {
        db.prepare(`INSERT INTO executive_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
          id, input.executiveId, source.id, source.profile_id, source.scope, entry.content, entry.category, entry.status, entry.date,
          new Date().toISOString(),
        );
        if (previous) db.prepare('UPDATE executive_memories SET superseded_by = ? WHERE id = ?').run(id, previous.id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      syncMemory(input.executiveId);
      return { id };
    },
    deleteMemory(input, id) {
      context(input);
      if (!visibleMemories(input).some(entry => entry.id === id)) throw new InputError('Memory not found in this persona mode.', 404);
      db.prepare('DELETE FROM executive_memories WHERE id = ?').run(id);
      syncMemory(input.executiveId);
      return { deleted: true };
    },
    insertDocument,
    uploadScope,
    insertGeneralKnowledge(sourceId, expectedContent, content) {
      const source = db.prepare('SELECT * FROM documents WHERE id = ?').get(sourceId);
      if (!source || source.scope === 'public' || source.content !== expectedContent) return null;
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM documents WHERE derived_from = ?').run(sourceId);
        const item = insertDocument({ executiveId: source.executive_id, profileId: source.profile_id, scope: 'public',
          title: `General knowledge: ${source.title}`.slice(0, 200), content });
        db.prepare('UPDATE documents SET derived_from = ? WHERE id = ?').run(sourceId, item.id);
        db.exec('COMMIT');
        return item;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    insertRecording(input, segments, trackingError = '', warnings = []) {
      db.exec('BEGIN');
      try {
        const item = insertDocument(input);
        const { clean, embeddings } = splitVoiceData(segments);
        const suggestions = voiceSuggestions(clean, embeddings);
        db.prepare('DELETE FROM chunks WHERE document_id = ?').run(item.id);
        db.prepare(`INSERT INTO recording_reviews (document_id, segments, assignments, generated, tracking_error, analysis_warnings,
          voice_embeddings, voice_suggestions, assignments_reviewed, expected_speakers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(
          item.id, JSON.stringify(clean), JSON.stringify(suggestions), '[]', trackingError, JSON.stringify(warnings),
          JSON.stringify(embeddings), JSON.stringify(suggestions), expectedSpeakerCount(input.expectedSpeakers),
        );
        db.exec('COMMIT');
        return { ...item, needsSpeakerReview: true };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    recordingReview(id) {
      const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(text(id, 'Document ID'));
      if (!document) throw new InputError('Document not found.', 404);
      let review = db.prepare('SELECT * FROM recording_reviews WHERE document_id = ?').get(document.id);
      if (!review) {
        const segments = recordingSegments(document.content);
        review = { segments: JSON.stringify(segments), assignments: JSON.stringify(segments.map(() => null)), generated: '[]' };
      }
      const original = db.prepare('SELECT filename FROM originals WHERE document_id = ?').get(document.id);
      return {
        id: document.id, title: document.title, scope: document.scope, profileId: document.profile_id,
        segments: JSON.parse(review.segments), assignments: JSON.parse(review.assignments),
        generated: JSON.parse(review.generated),
        trackingError: review.tracking_error || '',
        warnings: JSON.parse(review.analysis_warnings || '[]'),
        voiceSuggestions: JSON.parse(review.voice_suggestions || '[]'),
        voiceDiagnostics: voiceSuggestions(JSON.parse(review.segments),
          JSON.parse(review.voice_embeddings || '{}'), { excludeDocumentId: document.id, diagnostics: true }),
        hasVoiceFingerprints: Object.keys(JSON.parse(review.voice_embeddings || '{}')).length > 0,
        assignmentsReviewed: review.assignments_reviewed === 1,
        expectedSpeakers: review.expected_speakers ?? null,
        hasOriginal: Boolean(original), originalFilename: original?.filename,
      };
    },
    publishRecording(id, assignments) {
      const review = this.recordingReview(id);
      validateAssignments(assignments, review.segments);
      const targets = [...new Set(assignments.filter(Boolean))].map(executive);
      const original = db.prepare('SELECT * FROM originals WHERE document_id = ?').get(id);
      const generated = [];
      db.exec('BEGIN');
      try {
        for (const target of targets) {
          const existing = review.generated.find(item => item.executiveId === target.id);
          const content = [
            `Recording source: ${review.title}`,
            `Speech attributed to ${target.name} by the user (unverified). Only user-assigned segments are included.`,
            'Other speakers, unknown speech and visual observations are excluded. Verify machine transcription and speaker assignments against the original.',
            ...(review.segments.some(segment => segment.speakerId)
              ? ['Anonymous speaker groups were suggested by AI and mapped to executives by the user. Repeated-voice matches are unverified, not proof of identity.'] : []),
            ...review.segments.flatMap((segment, index) => assignments[index] === target.id
              ? [`[${segment.start.toFixed(2)}s - ${segment.end.toFixed(2)}s] Speaker: ${target.name} (user-labeled): ${segment.text}`] : []),
          ].join('\n');
          if (existing) db.prepare('DELETE FROM documents WHERE id = ?').run(existing.documentId);
          const item = insertDocument({
            executiveId: target.id, profileId: review.profileId,
            scope: target.owner_id === review.profileId ? 'twin' : 'enriched', title: `${review.title.slice(0, 110)} - ${target.name}`, content,
            ...(original ? { original: { storageName: original.storage_name, filename: original.filename, bytes: original.bytes } } : {}),
          }, existing?.documentId);
          generated.push({ executiveId: target.id, documentId: item.id });
        }
        for (const item of review.generated) {
          if (!targets.some(target => target.id === item.executiveId)) db.prepare('DELETE FROM documents WHERE id = ?').run(item.documentId);
        }
        db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
        db.prepare(`INSERT INTO recording_reviews (document_id, segments, assignments, generated) VALUES (?, ?, ?, ?)
          ON CONFLICT(document_id) DO UPDATE SET assignments = excluded.assignments, generated = excluded.generated`).run(
          id, JSON.stringify(review.segments), JSON.stringify(assignments), JSON.stringify(generated),
        );
        storeAssignedVoices(review, assignments);
        db.prepare('UPDATE recording_reviews SET remember_voices = 1, assignments_reviewed = 1 WHERE document_id = ?').run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      for (const target of new Set([...targets.map(item => item.id), ...review.generated.map(item => item.executiveId)])) {
        syncMemory(target);
        syncDreamSoul(target);
      }
      return { generated, assignedSegments: assignments.filter(Boolean).length };
    },
    saveRecordingReview(id, assignments) {
      const review = this.recordingReview(id);
      validateAssignments(assignments, review.segments, false);
      for (const target of new Set(assignments.filter(Boolean))) executive(target);
      db.exec('BEGIN');
      try {
      db.prepare(`INSERT INTO recording_reviews (document_id, segments, assignments, generated) VALUES (?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET assignments = excluded.assignments`).run(
        id, JSON.stringify(review.segments), JSON.stringify(assignments), JSON.stringify(review.generated),
      );
      storeAssignedVoices(review, assignments);
      db.prepare('UPDATE recording_reviews SET remember_voices = 1, assignments_reviewed = 1 WHERE document_id = ?').run(id);
      db.exec('COMMIT');
      return { saved: true };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    rememberRecordingVoices(id, segments, expectedReview) {
      const review = this.recordingReview(id);
      if (!review.assignmentsReviewed || !review.assignments.some(Boolean)) throw new InputError('Save or publish confirmed speaker assignments before building voice profiles.');
      if (JSON.stringify(review.segments) !== JSON.stringify(expectedReview.segments) ||
          JSON.stringify(review.assignments) !== JSON.stringify(expectedReview.assignments)) {
        throw new InputError('This recording changed during fingerprint extraction. Reopen its review and try again.', 409);
      }
      const { clean, embeddings } = splitVoiceData(segments);
      if (JSON.stringify(clean) !== JSON.stringify(review.segments)) throw new InputError('Fingerprint extraction must preserve the reviewed transcript and speaker groups.');
      if (!Object.keys(embeddings).some(index => review.assignments[index])) throw new InputError('No usable fingerprints were found for confirmed speakers.');
      const previous = JSON.parse(db.prepare('SELECT voice_embeddings FROM recording_reviews WHERE document_id = ?').get(id).voice_embeddings);
      const merged = { ...previous, ...embeddings };
      for (const [index, segment] of clean.entries()) {
        if (segment.speakerId && !embeddings[index]) delete merged[index];
      }
      const suggestions = voiceSuggestions(clean, merged, { excludeDocumentId: id });
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE recording_reviews SET voice_embeddings = ?, voice_suggestions = ?, remember_voices = 1 WHERE document_id = ?')
          .run(JSON.stringify(merged), JSON.stringify(suggestions), id);
        storeAssignedVoices(review, review.assignments);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return this.recordingReview(id);
    },
    missingVoiceFingerprints(id) {
      const review = this.recordingReview(id);
      const row = db.prepare('SELECT voice_embeddings FROM recording_reviews WHERE document_id = ?').get(id);
      const embeddings = JSON.parse(row?.voice_embeddings || '{}');
      return review.segments.some((segment, index) => review.assignments[index] && segment.speakerId && !embeddings[index] &&
        segment.end - segment.start >= 2 &&
        !review.segments.some((other, position) => position !== index && other.start < segment.end && segment.start < other.end));
    },
    fingerprintInputs(id) {
      const review = this.recordingReview(id);
      const row = db.prepare('SELECT voice_embeddings FROM recording_reviews WHERE document_id = ?').get(id);
      const embeddings = JSON.parse(row?.voice_embeddings || '{}');
      const segments = review.segments.map((segment, index) => ({ ...segment,
        speakerId: segment.speakerId || (embeddings[index] || segment.speakerIssue?.startsWith('Voice fingerprint') ? 'voice-candidate' : null),
      }));
      const eligible = segments.map((segment, index) => ({ ...segment, index })).filter(segment => segment.speakerId &&
        segment.end - segment.start >= 2 && !segments.some((other, index) => index !== segment.index && other.start < segment.end && segment.start < other.end));
      const entries = eligible.filter(segment => embeddings[segment.index]).map(segment => ({ index: segment.index,
        embedding: embeddings[segment.index].embedding }));
      return { segments, entries, complete: entries.length === eligible.length };
    },
    saveSpeakerTracks(id, segments, expectedSegments, options = {}) {
      const review = this.recordingReview(id);
      if (JSON.stringify(review.segments) !== JSON.stringify(expectedSegments)) {
        throw new InputError('This recording changed during speaker analysis. Reopen its review and try again.', 409);
      }
      const trackingError = [...new Set(segments.map(segment => segment.speakerIssue).filter(Boolean))].join('\n');
      const { clean, embeddings } = splitVoiceData(segments);
      const suggestions = voiceSuggestions(clean, embeddings, { excludeDocumentId: id });
      const row = db.prepare('SELECT assignments_reviewed FROM recording_reviews WHERE document_id = ?').get(id);
      const assignments = row?.assignments_reviewed === 0 ? suggestions : review.assignments;
      db.exec('BEGIN');
      try {
      db.prepare(`INSERT INTO recording_reviews (document_id, segments, assignments, generated, tracking_error, voice_embeddings, voice_suggestions)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET segments = excluded.segments,
        tracking_error = excluded.tracking_error, assignments = excluded.assignments,
        voice_embeddings = excluded.voice_embeddings, voice_suggestions = excluded.voice_suggestions, remember_voices = 0`).run(
        id, JSON.stringify(clean), JSON.stringify(assignments), JSON.stringify(review.generated), trackingError,
        JSON.stringify(embeddings), JSON.stringify(suggestions),
      );
      db.prepare('DELETE FROM voice_samples WHERE document_id = ?').run(id);
      if (options.expectedSpeakers !== undefined) {
        db.prepare('UPDATE recording_reviews SET expected_speakers = ? WHERE document_id = ?')
          .run(expectedSpeakerCount(options.expectedSpeakers), id);
      }
      db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return this.recordingReview(id);
    },
    voiceProfiles(profileId) {
      profile(profileId);
      return db.prepare(`SELECT executive_id AS executiveId, executives.name, count(*) AS samples FROM voice_samples
        JOIN executives ON executives.id = voice_samples.executive_id
        GROUP BY executive_id ORDER BY executives.name`).all();
    },
    forgetVoices(profileId) {
      profile(profileId);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM voice_samples').run();
        for (const row of db.prepare('SELECT * FROM recording_reviews WHERE assignments_reviewed = 0').all()) {
          const suggestions = JSON.parse(row.voice_suggestions);
          const assignments = JSON.parse(row.assignments).map((id, index) => id === suggestions[index] ? null : id);
          db.prepare('UPDATE recording_reviews SET assignments = ? WHERE document_id = ?').run(JSON.stringify(assignments), row.document_id);
        }
        db.prepare(`UPDATE recording_reviews SET remember_voices = 0, voice_embeddings = '{}', voice_suggestions = '[]'`).run();
        db.exec('COMMIT');
        return { forgotten: true };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    visibleDocuments,
    document(id) {
      if (typeof id === 'string' && id.startsWith(BUILTIN_PREFIX)) {
        const builtin = builtinKnowledge.document(id);
        if (!builtin) throw new InputError('Built-in knowledge document not found.', 404);
        return { id: builtin.id, title: `Built-in: ${builtin.title}`, content: builtin.content, scope: 'builtin',
          domain: builtin.domain, hasOriginal: 0 };
      }
      const document = db.prepare(`SELECT id, title, content, scope, executive_id, profile_id, created_at,
        EXISTS(SELECT 1 FROM originals WHERE document_id = documents.id) AS hasOriginal FROM documents WHERE id = ?`)
        .get(text(id, 'Document ID'));
      if (!document) throw new InputError('Document not found.', 404);
      return document;
    },
    deleteDocument(id) {
      if (typeof id === 'string' && id.startsWith(BUILTIN_PREFIX)) {
        throw new InputError('Built-in knowledge is read-only. Remove its domain from the executive profile instead.');
      }
      const review = db.prepare('SELECT generated FROM recording_reviews WHERE document_id = ?').get(text(id, 'Document ID'));
      const ids = [id, ...(review ? JSON.parse(review.generated).map(item => item.documentId) : [])];
      const affectedMemories = db.prepare(`SELECT DISTINCT executive_id FROM documents WHERE id IN
        (${ids.map(() => '?').join(', ')})`).all(...ids);
      const originals = new Set(ids.flatMap(item => {
        const original = db.prepare('SELECT storage_name FROM originals WHERE document_id = ?').get(item);
        return original ? [original.storage_name] : [];
      }));
      db.exec('BEGIN');
      try {
        const result = db.prepare('DELETE FROM documents WHERE id = ?').run(id);
        if (!result.changes) throw new InputError('Document not found.', 404);
        for (const item of ids.slice(1)) db.prepare('DELETE FROM documents WHERE id = ?').run(item);
        for (const name of originals) {
          if (!db.prepare('SELECT 1 FROM originals WHERE storage_name = ?').get(name)) unlinkSync(join(directory, 'originals', name));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      for (const item of affectedMemories) {
        syncMemory(item.executive_id);
        syncDreamSoul(item.executive_id);
      }
    },
    original(id) {
      const item = db.prepare('SELECT * FROM originals WHERE document_id = ?').get(text(id, 'Document ID'));
      if (!item) throw new InputError('Original file is unavailable. Older uploads and pasted text have no retained original.', 404);
      return { ...item, path: join(directory, 'originals', item.storage_name) };
    },
    missingEmbeddings(model, input = null) {
      const texts = input ? new Set(retrievalCandidates(input).chunks.map(chunk => chunk.content)) : allRetrievalTexts();
      return [...texts].filter(content => !cachedVector(model, content));
    },
    saveEmbeddings(model, entries) {
      const insert = db.prepare('INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?)');
      db.exec('BEGIN');
      try {
        for (const { content, vector } of entries) {
          insert.run(embeddingHash(model, content), model, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    // Removes vectors of deleted or superseded content and of other embedding models.
    pruneEmbeddings(model) {
      const current = new Set([...allRetrievalTexts()].map(content => embeddingHash(model, content)));
      const stale = db.prepare('SELECT hash FROM embeddings').all().map(row => row.hash).filter(hash => !current.has(hash));
      const remove = db.prepare('DELETE FROM embeddings WHERE hash = ?');
      db.exec('BEGIN');
      try {
        for (const hash of stale) { remove.run(hash); vectorCache.delete(hash); }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return stale.length;
    },
    embeddingCount(model) {
      return db.prepare('SELECT COUNT(*) AS count FROM embeddings WHERE model = ?').get(model).count;
    },
    // One profile shared by every executive; visible to everyone using the sandbox.
    requireProfile(id) { profile(id); },
    companyProfile() {
      const row = db.prepare(`SELECT data, updated_at AS updatedAt, profiles.name AS updatedByName, updated_by AS updatedBy
        FROM company_profile LEFT JOIN profiles ON profiles.id = updated_by WHERE company_profile.id = 1`).get();
      return row ? { profile: JSON.parse(row.data), updatedAt: row.updatedAt, updatedBy: row.updatedBy, updatedByName: row.updatedByName }
        : { profile: {}, updatedAt: null, updatedBy: null, updatedByName: null };
    },
    saveCompanyProfile(profileId, input) {
      profile(profileId);
      const data = normalizeCompanyProfile(input);
      if (!Object.keys(data).length) {
        db.prepare('DELETE FROM company_profile WHERE id = 1').run();
      } else {
        db.prepare(`INSERT INTO company_profile VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .run(JSON.stringify(data), new Date().toISOString(), profileId);
      }
      return this.companyProfile();
    },
    retrieve(input, question, semantic = null) {
      const { documents, ids, placeholders, chunks } = retrievalCandidates(input);
      if (!chunks.length) return [];
      const allowed = new Map(documents.map(document => [document.id, document]));
      const videos = new Set(ids.length ? db.prepare(`SELECT document_id FROM originals WHERE document_id IN (${placeholders})
        AND (lower(filename) GLOB '*.mp4' OR lower(filename) GLOB '*.mov' OR
          lower(filename) GLOB '*.webm' OR lower(filename) GLOB '*.mkv')`).all(...ids)
        .map(original => original.document_id) : []);
      const sampledVideoTimestamps = new Map();
      for (const chunk of chunks) {
        if (!videos.has(chunk.document_id)) continue;
        const sampled = chunk.content.match(/Sampled frame timestamps:\s*([^\n]+)/)?.[1];
        if (!sampled) continue;
        const timestamps = Array.from(sampled.matchAll(/\b(\d{2,}:\d{2}:\d{2})\b/g), match => match[1]);
        sampledVideoTimestamps.set(chunk.document_id, [
          ...new Set([...(sampledVideoTimestamps.get(chunk.document_id) || []), ...timestamps]),
        ]);
      }
      const terms = tokenize(question);
      const distinctTerms = new Set(terms);
      // Built-in reference text is broad, so it must share several question terms to count as relevant.
      const builtinMinimum = Math.min(distinctTerms.size, Math.max(2, Math.ceil(distinctTerms.size * 0.4)));
      const frequencies = new Map();
      for (const chunk of chunks) {
        for (const term of new Set(tokenize(chunk.content))) {
          frequencies.set(term, (frequencies.get(term) || 0) + 1);
        }
      }
      const ranked = chunks.map(chunk => {
        const tokens = tokenize(chunk.content);
        const present = new Set(tokens);
        const score = terms.reduce((sum, term) => {
          const count = tokens.filter(token => token === term).length;
          return sum + (count ? (1 + Math.log(count)) * Math.log(1 + chunks.length / (frequencies.get(term) || 1)) : 0);
        }, 0) / Math.sqrt(Math.max(tokens.length, 1));
        const keyword = score > 0 && (!chunk.builtin || [...distinctTerms].filter(term => present.has(term)).length >= builtinMinimum)
          ? score : 0;
        const vector = semantic ? cachedVector(semantic.model, chunk.content) : null;
        const similarity = vector ? cosine(semantic.vector, vector) : null;
        const meaning = similarity !== null &&
          similarity >= semantic.minSimilarity + (chunk.builtin ? BUILTIN_SIMILARITY_MARGIN : 0);
        // A shared word alone is not relevance when the meaning is clearly unrelated.
        const noise = similarity !== null && similarity < KEYWORD_SIMILARITY_FLOOR;
        return { chunk, keyword: noise ? 0 : keyword, similarity, meaning };
      }).filter(item => item.keyword > 0 || item.meaning);
      // Hybrid relevance: keyword and meaning scores, each relative to the best candidate, count equally.
      const bestKeyword = Math.max(0, ...ranked.map(item => item.keyword));
      const bestSimilarity = Math.max(0, ...ranked.map(item => item.similarity ?? 0));
      const scored = ranked.map(({ chunk, keyword, similarity, meaning }) => {
        const relevance = semantic
          ? 0.5 * (bestKeyword ? keyword / bestKeyword : 0) + 0.5 * (bestSimilarity ? Math.max(0, similarity ?? 0) / bestSimilarity : 0)
          : keyword;
        const match = semantic ? { match: keyword > 0 && meaning ? 'hybrid' : meaning ? 'semantic' : 'keyword' } : {};
        if (chunk.builtin) {
          return { ...chunk, ...match, title: `Built-in: ${chunk.builtin.title}`, scope: 'builtin', score: relevance * BUILTIN_WEIGHT };
        }
        const date = chunk.eventDate || allowed.get(chunk.document_id).created_at.slice(0, 10);
        const age = Math.max(0, (Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
        return { ...chunk, ...match, date, title: allowed.get(chunk.document_id).title, scope: allowed.get(chunk.document_id).scope,
          score: relevance * (0.5 + 0.5 / (1 + age / 180)) };
      }).filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score);
      const selected = [];
      for (const chunk of scored) {
        if (selected.length === 5) break;
        if (chunk.builtin && selected.filter(item => item.builtin).length === BUILTIN_LIMIT) continue;
        selected.push(chunk);
      }
      return selected.map((chunk, index) => chunk.builtin ? {
        label: `S${index + 1}`, documentId: chunk.document_id, title: chunk.title, scope: 'builtin',
        text: chunk.content, builtin: true, domain: chunk.builtin.domain, hasOriginal: false,
        ...(chunk.match ? { match: chunk.match } : {}),
      } : {
          label: `S${index + 1}`, documentId: chunk.document_id,
          title: chunk.title, scope: chunk.scope, text: chunk.content, date: chunk.date,
          hasOriginal: Boolean(allowed.get(chunk.document_id).hasOriginal),
          ...(chunk.match ? { match: chunk.match } : {}),
          ...(videos.has(chunk.document_id) ? {
            video: true,
            videoTimestamps: [...new Set([
              ...(sampledVideoTimestamps.get(chunk.document_id) || []),
              ...Array.from(chunk.content.matchAll(/\b(\d{2,}:\d{2}:\d{2})\b/g), match => match[1]),
            ])],
          } : {}),
          ...(chunk.memoryId ? { memoryId: chunk.memoryId, memoryStatus: chunk.memoryStatus } : {}),
        });
    },
    projects(profileId) {
      profile(profileId);
      return db.prepare('SELECT * FROM projects WHERE profile_id = ? ORDER BY created_at, rowid').all(profileId);
    },
    addProject(input) {
      profile(input.profileId);
      const id = randomUUID();
      db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run(id, input.profileId, text(input.name, 'Project name', 80), new Date().toISOString());
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    },
    deleteProject(id, profileId) {
      profile(profileId);
      if (!db.prepare('DELETE FROM projects WHERE id = ? AND profile_id = ?').run(id, profileId).changes) throw new InputError('Project not found.', 404);
    },
    conversations(profileId) {
      profile(profileId);
      return db.prepare('SELECT * FROM conversations WHERE profile_id = ? ORDER BY updated_at DESC, rowid DESC').all(profileId);
    },
    addConversation(input) {
      context(input);
      if (input.projectId && !db.prepare('SELECT id FROM projects WHERE id = ? AND profile_id = ?').get(input.projectId, input.profileId)) {
        throw new InputError('Project not found.', 404);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.executiveId, input.profileId, input.mode, input.projectId || null, 'New conversation', now, now);
      return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    },
    updateConversation(id, input) {
      const item = db.prepare('SELECT * FROM conversations WHERE id = ? AND profile_id = ?').get(id, input.profileId);
      if (!item) throw new InputError('Conversation not found.', 404);
      const projectId = input.projectId === undefined ? item.project_id : input.projectId || null;
      if (projectId && !db.prepare('SELECT id FROM projects WHERE id = ? AND profile_id = ?').get(projectId, input.profileId)) throw new InputError('Project not found.', 404);
      const title = input.title === undefined ? item.title : text(input.title, 'Conversation title', 80);
      db.prepare('UPDATE conversations SET title = ?, project_id = ? WHERE id = ?').run(title, projectId, id);
      return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    },
    deleteConversation(id, profileId) {
      profile(profileId);
      const item = db.prepare('SELECT executive_id FROM conversations WHERE id = ? AND profile_id = ?').get(id, profileId);
      if (!db.prepare('DELETE FROM conversations WHERE id = ? AND profile_id = ?').run(id, profileId).changes) throw new InputError('Conversation not found.', 404);
      syncRelationshipMemory(item.executive_id);
    },
    history(input) {
      context(input);
      if (input.conversationId && !db.prepare('SELECT id FROM conversations WHERE id = ? AND executive_id = ? AND profile_id = ? AND mode = ?')
        .get(input.conversationId, input.executiveId, input.profileId, input.mode)) throw new InputError('Conversation not found in this context.', 404);
      return db.prepare(`
        SELECT * FROM messages WHERE executive_id = ? AND profile_id = ? AND mode = ?
        AND (? IS NULL OR conversation_id = ?)
        ORDER BY rowid
      `).all(input.executiveId, input.profileId, input.mode, input.conversationId || null, input.conversationId || null)
        .map(message => ({ ...message, sources: JSON.parse(message.sources) }));
    },
    saveExchange(input, question, answer) {
      this.history(input);
      const insert = db.prepare('INSERT INTO messages (id, executive_id, profile_id, mode, role, content, sources, engine, created_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const ids = { questionId: randomUUID(), answerId: randomUUID() };
      db.exec('BEGIN');
      try {
        for (const [id, role, content, sources] of [
          [ids.questionId, 'user', question, []], [ids.answerId, 'assistant', answer.content, answer.sources],
        ]) {
          insert.run(id, input.executiveId, input.profileId, input.mode,
            role, content, JSON.stringify(sources), answer.engine, new Date().toISOString(), input.conversationId || null);
        }
        if (input.conversationId) db.prepare("UPDATE conversations SET updated_at = ?, title = CASE WHEN (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) = 2 AND title = 'New conversation' THEN ? ELSE title END WHERE id = ?")
          .run(new Date().toISOString(), input.conversationId, question.slice(0, 80), input.conversationId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return ids;
    },
    chatMemories(input, { activeOnly = false, limit } = {}) {
      context(input);
      return db.prepare(`SELECT chat_memories.id, kind, topic, chat_memories.content, evidence, speaker, date,
        superseded_by AS supersededBy, messages.conversation_id AS conversationId, conversations.title AS conversationTitle
        FROM chat_memories JOIN messages ON messages.id = chat_memories.message_id
        LEFT JOIN conversations ON conversations.id = messages.conversation_id
        WHERE chat_memories.executive_id = ? AND chat_memories.profile_id = ? AND chat_memories.mode = ?
        AND (? = 0 OR superseded_by IS NULL)
        ORDER BY chat_memories.created_at DESC, chat_memories.rowid DESC LIMIT ?`)
        .all(input.executiveId, input.profileId, input.mode, activeOnly ? 1 : 0, limit ?? -1);
    },
    chatMemoryTopics(input) {
      return db.prepare(`SELECT DISTINCT kind || ':' || topic AS key FROM chat_memories WHERE executive_id = ? AND profile_id = ?
        AND mode = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 200`)
        .all(input.executiveId, input.profileId, input.mode).map(row => row.key);
    },
    saveChatMemories(input, messageId, memories) {
      // The chat or executive may have been deleted while extraction was running.
      const message = db.prepare("SELECT created_at FROM messages WHERE id = ? AND executive_id = ? AND profile_id = ? AND mode = ? AND role = 'assistant'")
        .get(messageId, input.executiveId, input.profileId, input.mode);
      if (!message) return { saved: 0 };
      const insert = db.prepare('INSERT INTO chat_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)');
      const supersede = db.prepare(`UPDATE chat_memories SET superseded_by = ? WHERE executive_id = ? AND profile_id = ?
        AND mode = ? AND kind = ? AND topic = ? AND superseded_by IS NULL AND id != ?`);
      db.exec('BEGIN');
      try {
        for (const memory of memories) {
          const id = randomUUID();
          insert.run(id, input.executiveId, input.profileId, input.mode, messageId, memory.kind, memory.topic,
            memory.content, memory.evidence, memory.speaker, message.created_at.slice(0, 10), new Date().toISOString());
          supersede.run(id, input.executiveId, input.profileId, input.mode, memory.kind, memory.topic, id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      syncRelationshipMemory(input.executiveId);
      return { saved: memories.length };
    },
    relationship(input) {
      const executive = context(input);
      const person = db.prepare('SELECT * FROM profiles WHERE id = ?').get(input.profileId);
      const entries = relationshipRows(executive.id, person.id);
      return { path: relationshipPath(executive.id, person.id),
        content: entries.length ? renderRelationship({ executive, person, entries }) : '' };
    },
    deleteChatMemory(input, id) {
      context(input);
      if (!db.prepare('DELETE FROM chat_memories WHERE id = ? AND executive_id = ? AND profile_id = ? AND mode = ?')
        .run(id, input.executiveId, input.profileId, input.mode).changes) throw new InputError('Conversation memory not found.', 404);
      syncRelationshipMemory(input.executiveId);
      return { deleted: true };
    },
  };
}

// Built-in reference ranks below comparable uploaded evidence and never fills every source slot.
const BUILTIN_WEIGHT = 0.75;
const BUILTIN_LIMIT = 3;
// Built-in sections are broad, so meaning alone must be a little stronger to count.
const BUILTIN_SIMILARITY_MARGIN = 0.05;
// On real mailboxes, off-topic keyword hits scored about 0.07 and genuine ones (names, acronyms) at least 0.24.
const KEYWORD_SIMILARITY_FLOOR = 0.15;
const STOP_WORDS = new Set(`a an the is are was were be been being to of and or in on for with my me i you your we our us it its this that
  these those what which who how why when where does do did can could should would will shall may might must about from by at as into than
  then so if not no but all any some there their they them he she his her has have had also just get got`.split(/\s+/));
// Light English suffix normalization so "discounting", "discounts" and "discount" match; numbers are kept intact.
function stem(term) {
  if (term.length <= 4 || /\d/.test(term)) return term;
  let result = term;
  if (result.endsWith('ies')) result = `${result.slice(0, -3)}y`;
  else if (result.endsWith('ing') && result.length > 6) result = result.slice(0, -3);
  else if (result.endsWith('ed') && result.length > 5) result = result.slice(0, -2);
  else if (result.endsWith('s') && !/(ss|us|is)$/.test(result)) result = result.slice(0, -1);
  return result.length > 4 && result.endsWith('e') ? result.slice(0, -1) : result;
}
function tokenize(value) {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(term => term.length > 1 && !STOP_WORDS.has(term)).map(stem);
}
