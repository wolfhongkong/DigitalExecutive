import { providerHeaders } from './provider.js';

export const EMBEDDING_BATCH_SIZE = 64;
const EMBEDDING_CONCURRENCY = 4;
// Calibrated on text-embedding-3-small: related passages (including synonyms and German questions)
// scored 0.43-0.60, unrelated ones at most 0.32.
export const DEFAULT_MIN_SIMILARITY = 0.4;

export function semanticSearchConfig(provider, apiKey, env = process.env) {
  const setting = (env.SEMANTIC_SEARCH || 'on').toLowerCase();
  if (!['on', 'off'].includes(setting)) throw new Error('SEMANTIC_SEARCH must be on or off.');
  const raw = env.SEMANTIC_MIN_SIMILARITY;
  const minSimilarity = raw === undefined || raw === '' ? DEFAULT_MIN_SIMILARITY : Number(raw);
  if (!Number.isFinite(minSimilarity) || minSimilarity <= 0 || minSimilarity >= 1) {
    throw new Error('SEMANTIC_MIN_SIMILARITY must be a number between 0 and 1.');
  }
  const base = { model: provider?.embeddingModel || null, url: provider?.embeddingUrl || null, minSimilarity };
  if (setting === 'off') return { ...base, enabled: false, reason: 'Disabled (SEMANTIC_SEARCH=off).' };
  if (!apiKey || provider?.configurationError) return { ...base, enabled: false, reason: 'Inactive until an AI provider is configured.' };
  if (!base.url) return { ...base, enabled: false, reason: 'No embeddings endpoint: set AI_EMBEDDING_URL for LLM Farm.' };
  return { ...base, enabled: true, reason: '' };
}

function normalize(values) {
  const vector = Float32Array.from(values);
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!length) throw new Error('AI provider returned an empty embedding.');
  for (let index = 0; index < vector.length; index++) vector[index] /= length;
  return vector;
}

async function embedBatch(texts, { config, provider, apiKey, fetcher = fetch }) {
  const response = await fetcher(config.url, {
    method: 'POST',
    headers: { ...providerHeaders(apiKey, provider), 'Content-Type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: config.model, input: texts }),
  });
  if (!response.ok) {
    throw new Error(`Embeddings request returned HTTP ${response.status}. Check the embeddings endpoint, model, key and quota.`);
  }
  const data = (await response.json())?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new Error('AI provider returned an invalid embeddings response.');
  const vectors = new Array(texts.length);
  for (const [position, item] of data.entries()) {
    const index = Number.isInteger(item?.index) ? item.index : position;
    if (!Array.isArray(item?.embedding) || index < 0 || index >= texts.length || vectors[index]) {
      throw new Error('AI provider returned an invalid embeddings response.');
    }
    vectors[index] = normalize(item.embedding);
  }
  return vectors;
}

// Returns unit-length vectors in input order; batches run with bounded concurrency.
export async function embedTexts(texts, options) {
  const batches = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) batches.push(texts.slice(start, start + EMBEDDING_BATCH_SIZE));
  const results = new Array(batches.length);
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const index = next++;
      results[index] = await embedBatch(batches[index], options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(EMBEDDING_CONCURRENCY, batches.length) }, worker));
  return results.flat();
}

export function cosine(first, second) {
  if (first.length !== second.length) return 0;
  let sum = 0;
  for (let index = 0; index < first.length; index++) sum += first[index] * second[index];
  return sum;
}
