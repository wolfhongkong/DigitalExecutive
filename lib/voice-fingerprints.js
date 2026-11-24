import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { agnes } from 'ml-hclust';
import { InputError } from './input.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('../scripts/voice-fingerprints.py', import.meta.url));
const defaultPython = fileURLToPath(new URL('../.venv-voices/bin/python', import.meta.url));
const DIMENSIONS = 192;

export function expectedSpeakerCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new InputError('Speaker count must be between 1 and 20, or empty for automatic grouping.');
  return count;
}

const similarity = (first, second) => first.reduce((sum, value, index) => sum + value * second[index], 0);

function centroid(samples) {
  const mean = Array(DIMENSIONS).fill(0);
  for (const sample of samples) for (let index = 0; index < DIMENSIONS; index++) mean[index] += sample.vector[index];
  const norm = Math.hypot(...mean);
  return norm > 1e-8 ? mean.map(value => value / norm) : null;
}

function groupWholeRecording(segments, vectors, { expectedSpeakers, margin, newThreshold }) {
  const result = segments.map(({ voiceFingerprint, speakerIssue, ...segment }) => ({ ...segment,
    speakerId: null, ...(speakerIssue ? { speakerIssue } : {}) }));
  const samples = segments.map((segment, index) => ({ index, vector: vectors.get(index), start: segment.start }))
    .filter(sample => segments[sample.index].speakerId && sample.vector);
  if (samples.length < expectedSpeakers) throw new InputError(`Need at least ${expectedSpeakers} usable speech samples to group ${expectedSpeakers} speakers.`);
  const tree = agnes(samples.map(sample => sample.vector), {
    method: 'average', distanceFunction: (first, second) => 1 - similarity(first, second),
  });
  const groups = (expectedSpeakers === 1 ? [tree] : tree.group(expectedSpeakers).children)
    .map(group => group.indices().map(index => samples[index]))
    .sort((first, second) => Math.min(...first.map(sample => sample.start)) - Math.min(...second.map(sample => sample.start)));
  const centers = groups.map(group => centroid(group));
  for (const [position, group] of groups.entries()) {
    for (const sample of group) {
      const others = group.filter(other => other.index !== sample.index);
      const reference = others.length ? centroid(others) : centers[position];
      const score = reference ? similarity(sample.vector, reference) : -1;
      const competitor = Math.max(-1, ...centers.filter((center, index) => index !== position && center)
        .map(center => similarity(sample.vector, center)));
      if (score < Math.min(newThreshold, 0.25) || score - competitor < margin) {
        result[sample.index].voiceFingerprint = { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [...sample.vector] };
        result[sample.index].speakerIssue = 'Voice fingerprint is weak or ambiguous against the recording-wide speaker groups. Review this turn manually.';
        delete result[sample.index].speakerVisual;
        continue;
      }
      result[sample.index].speakerId = `speaker-${position + 1}`;
      result[sample.index].voiceFingerprint = { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [...sample.vector] };
      delete result[sample.index].speakerIssue;
    }
  }
  for (const [index, segment] of result.entries()) {
    if (segment.speakerId || !segments[index].speakerId || vectors.get(index)) continue;
    delete segment.speakerVisual;
    segment.speakerIssue = 'Voice fingerprint needs at least two seconds of usable single-speaker audio; this turn remains unassigned.';
  }
  return result;
}

export function voiceFingerprintConfig(env = process.env) {
  const mode = env.VOICE_FINGERPRINTS || 'speechbrain';
  if (!['off', 'speechbrain'].includes(mode)) throw new InputError('VOICE_FINGERPRINTS must be off or speechbrain.', 503);
  const threshold = Number(env.VOICE_FINGERPRINT_THRESHOLD || 0.75);
  const newThreshold = Number(env.VOICE_FINGERPRINT_NEW_THRESHOLD || 0.45);
  const margin = Number(env.VOICE_FINGERPRINT_MARGIN || 0.08);
  const identityThreshold = Number(env.VOICE_IDENTITY_THRESHOLD || 0.8);
  if (!Number.isFinite(identityThreshold) || identityThreshold <= 0 || identityThreshold > 1) {
    throw new InputError('VOICE_IDENTITY_THRESHOLD must be greater than 0 and at most 1.', 503);
  }
  if (![threshold, newThreshold, margin].every(Number.isFinite) || newThreshold < 0 ||
      threshold > 1 || newThreshold >= threshold || margin <= 0 || margin > 1) {
    throw new InputError('Invalid voice fingerprint thresholds: require 0 <= new threshold < match threshold <= 1 and 0 < margin <= 1.', 503);
  }
  return { enabled: mode === 'speechbrain', python: env.VOICE_FINGERPRINT_PYTHON || defaultPython,
    threshold, newThreshold, margin, identityThreshold };
}

export function validateFingerprints(entries, indices) {
  if (!Array.isArray(entries) || entries.length !== indices.length) throw new Error('Voice worker returned an incomplete fingerprint list.');
  const remaining = new Set(indices);
  const vectors = new Map();
  for (const entry of entries) {
    if (!entry || !remaining.delete(entry.index)) throw new Error('Voice worker returned duplicate or unexpected indices.');
    if (entry.embedding === null) { vectors.set(entry.index, null); continue; }
    if (!Array.isArray(entry.embedding) || entry.embedding.length !== DIMENSIONS || !entry.embedding.every(Number.isFinite)) {
      throw new Error('Voice worker returned an invalid embedding.');
    }
    const norm = Math.hypot(...entry.embedding);
    if (norm < 1e-8) throw new Error('Voice worker returned an empty embedding.');
    vectors.set(entry.index, entry.embedding.map(value => value / norm));
  }
  return vectors;
}

export function clusterFingerprintTurns(segments, vectors, { threshold = 0.75, newThreshold = 0.45, margin = 0.08, expectedSpeakers = null } = {}) {
  const count = expectedSpeakerCount(expectedSpeakers);
  if (count) return groupWholeRecording(segments, vectors, { expectedSpeakers: count, margin, newThreshold });
  const result = segments.map(({ voiceFingerprint, ...segment }) => ({ ...segment, speakerId: null }));
  const clusters = [];
  const ordered = segments.map((segment, index) => ({ ...segment, index }))
    .filter(segment => segment.speakerId).sort((a, b) => a.start - b.start || a.index - b.index);
  for (const segment of ordered) {
    const vector = vectors.get(segment.index);
    let issue = 'Voice fingerprint needs at least two seconds of usable single-speaker audio; this turn remains unassigned.';
    if (vector) {
      result[segment.index].voiceFingerprint = { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [...vector] };
      const scores = clusters.map(cluster => {
        const similarities = cluster.samples.map(sample =>
          vector.reduce((sum, value, position) => sum + value * sample.vector[position], 0));
        const ordered = [...similarities].sort((first, second) => first - second);
        return { cluster, score: ordered.length < 3 ? ordered[0] : ordered[Math.floor((ordered.length - 1) / 2)],
          strongest: Math.max(...similarities) };
      })
        .sort((a, b) => b.score - a.score);
      let cluster;
      if (!scores.length || scores.every(candidate => candidate.strongest < newThreshold)) {
        if (clusters.length >= 20) {
          delete result[segment.index].speakerVisual;
          result[segment.index].speakerIssue = 'Voice fingerprint reference capacity reached (20 groups). This sample may be a new voice, noise, or a fragmented match; it remains unassigned. Established groups are retained. Review this turn manually.';
          continue;
        }
        cluster = { id: `speaker-${clusters.length + 1}`, samples: [] };
        clusters.push(cluster);
      } else if (scores[0].score >= threshold && scores.slice(1).every(candidate => scores[0].score - candidate.strongest >= margin)) {
        cluster = scores[0].cluster;
      }
      if (cluster) {
        result[segment.index].speakerId = cluster.id;
        result[segment.index].voiceFingerprint = { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: [...vector] };
        cluster.samples = [...cluster.samples, { vector, duration: Math.min(8, segment.end - segment.start) }]
          .sort((a, b) => b.duration - a.duration).slice(0, 5);
        continue;
      }
      issue = 'Voice fingerprint similarity is ambiguous or conflicts with reference samples; this turn remains unassigned.';
    }
    delete result[segment.index].speakerVisual;
    result[segment.index].speakerIssue = issue;
  }
  return result;
}

export async function fingerprintRecording({ path, segments, config = voiceFingerprintConfig(), temporaryRoot = tmpdir(), run = execute, preserveGroups = false }) {
  const eligible = segments.map((segment, index) => ({ index, start: segment.start, end: segment.end, speakerId: segment.speakerId }))
    .filter(segment => segment.speakerId && segment.end - segment.start >= 2 &&
      !segments.some((other, index) => index !== segment.index && other.start < segment.end && segment.start < other.end));
  if (!eligible.length) return preserveGroups ? segments.map(({ voiceFingerprint, ...segment }) => segment) : clusterFingerprintTurns(segments, new Map(), config);
  const directory = await mkdtemp(join(temporaryRoot, 'executive-voiceprints-'));
  try {
    const audio = join(directory, 'recording.wav');
    const manifest = join(directory, 'turns.json');
    await run(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', path,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio],
    { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    await writeFile(manifest, JSON.stringify(eligible.map(({ index, start, end }) => ({ index, start, end }))), { mode: 0o600 });
    let stdout;
    try {
      ({ stdout } = await run(config.python, [worker, audio, manifest], { timeout: 900_000, maxBuffer: 16 * 1024 * 1024 }));
    } catch {
      throw new Error('SpeechBrain voice fingerprint worker failed. Install requirements-voices.txt in .venv-voices, verify model download access, or set VOICE_FINGERPRINT_PYTHON to that environment. No fingerprint tracks were saved.');
    }
    const vectors = validateFingerprints(JSON.parse(stdout), eligible.map(segment => segment.index));
    if (preserveGroups) return segments.map(({ voiceFingerprint, ...segment }, index) => ({ ...segment,
      ...(vectors.get(index) ? { voiceFingerprint: { model: 'speechbrain/spkrec-ecapa-voxceleb', embedding: vectors.get(index) } } : {}),
    }));
    return clusterFingerprintTurns(segments, vectors, config);
  } finally { await rm(directory, { recursive: true, force: true }); }
}