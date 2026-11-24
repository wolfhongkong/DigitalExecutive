import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { createStore } from '../lib/store.js';
import { providerConfig } from '../lib/provider.js';
import { semanticSearchConfig } from '../lib/embeddings.js';

// Each concept is one vector axis, so texts sharing a concept are similar even without shared words.
const CONCEPTS = [/discount|price|rabatt/i, /hire|hiring|recruit/i, /falcon/i, /france/i];
function fakeVector(text) {
  const vector = CONCEPTS.map(pattern => pattern.test(text) ? 1 : 0);
  return [...vector, vector.some(Boolean) ? 0.1 : 1];
}

const provider = providerConfig({ OPENAI_API_KEY: 'test-key' });
const scope = { executiveId: 'alex-executive', profileId: 'alex', mode: 'twin' };

async function fixture(t, { failEmbeddings = false, seed = () => {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'semantic-search-'));
  const seeded = createStore(directory);
  // The sample executive has no built-in domains here, so only uploaded evidence competes.
  seeded.updateExecutive('alex-executive', { knowledgeDomains: [] });
  const ids = seed(seeded) || {};
  const conversations = { twin: seeded.addConversation(scope).id, public: seeded.addConversation({ ...scope, mode: 'public' }).id };
  seeded.close();
  const embedded = [];
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === provider.embeddingUrl) {
      if (failEmbeddings) return new Response('{}', { status: 500 });
      embedded.push(...body.input);
      return Response.json({ data: body.input.map((text, index) => ({ index, embedding: fakeVector(text) })) });
    }
    return Response.json({ choices: [{ message: { content: 'Answer [S1].' } }] });
  };
  const app = createApp({ directory, provider, apiKey: 'test-key', chatMemory: false, generalizer: async () => '', fetcher,
    semanticSearch: semanticSearchConfig(provider, 'test-key', {}) });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const ask = (question, as = scope) => request('chat', 'POST', { ...as, conversationId: conversations[as.mode], question });
  return { app, request, ask, embedded, ids, directory };
}

function seedPricing(store) {
  return {
    pricing: store.insertDocument({ ...scope, scope: 'twin', title: 'Pricing decision',
      content: 'We cut list prices by 15 percent for enterprise accounts signing multi-year agreements.' }).id,
    hiring: store.insertDocument({ ...scope, scope: 'twin', title: 'Team plan',
      content: 'We recruit three senior engineers next quarter.' }).id,
  };
}

test('semantic search finds a passage that shares meaning but no words with the question', async t => {
  const { ask, embedded } = await fixture(t, { seed: seedPricing });
  const answer = (await ask('Are we giving discounts to big clients?')).body;
  assert.deepEqual(answer.sources.map(source => [source.title, source.match]), [['Pricing decision', 'semantic']]);
  assert.equal(answer.engine, 'openai');
  // Passages are embedded once; later questions only embed the question itself.
  embedded.length = 0;
  await ask('Do enterprise customers get a discount?');
  assert.deepEqual(embedded, ['Do enterprise customers get a discount?']);
});

test('semantic search stays within the asker\'s visible documents and drops keyword hits with unrelated meaning', async t => {
  const { ask } = await fixture(t, { seed: store => {
    seedPricing(store);
    store.insertDocument({ executiveId: 'alex-executive', profileId: 'jordan', scope: 'enriched', title: 'Jordan private pricing',
      content: 'Confidential rabatt schedule for strategic accounts.' });
    store.insertDocument({ ...scope, scope: 'twin', title: 'Plant budget', content: 'Capital expenditure for the new plant was approved.' });
  } });
  const own = (await ask('Are we giving discounts to big clients?')).body;
  assert.ok(!own.sources.some(source => source.title === 'Jordan private pricing'));
  const publicView = (await ask('Are we giving discounts to big clients?', { ...scope, mode: 'public' })).body;
  assert.deepEqual(publicView.sources, []);
  // "capital" is a shared keyword, but the meaning is unrelated, so the answer stays general.
  const unrelated = (await ask('What is the capital of France?')).body;
  assert.deepEqual(unrelated.sources, []);
  assert.equal(unrelated.engine, 'openai-general');
});

test('a failing embeddings endpoint falls back to keyword search and is reported in setup status', async t => {
  const { ask, request } = await fixture(t, { failEmbeddings: true, seed: seedPricing });
  assert.deepEqual((await ask('Are we giving discounts to big clients?')).body.sources, []);
  const keyword = (await ask('What did we decide about list prices?')).body;
  assert.deepEqual(keyword.sources.map(source => [source.title, source.match]), [['Pricing decision', undefined]]);
  const status = (await request('setup')).body.checks.find(item => item.id === 'semantic');
  assert.equal(status.status, 'warn');
  assert.match(status.summary, /HTTP 500/);
});

test('background indexing embeds every passage and removes vectors of deleted documents', async t => {
  const { app, request, ids, embedded } = await fixture(t, { seed: seedPricing });
  await app.refreshEmbeddings();
  assert.ok(embedded.includes('We recruit three senior engineers next quarter.'));
  const indexed = async () => Number((await request('setup')).body.checks.find(item => item.id === 'semantic')
    .details.find(line => line.startsWith('Indexed passages:')).split(': ')[1]);
  const before = await indexed();
  assert.equal((await request(`documents/${ids.hiring}`, 'DELETE')).status, 200);
  await app.refreshEmbeddings();
  assert.equal(await indexed(), before - 1);
});

test('semantic search configuration follows the AI provider and validates its settings', () => {
  const farm = providerConfig({ AI_PROVIDER: 'llm-farm', AI_CHAT_URL: 'https://aoai-farm.bosch-temp.com/api/openai/deployments/chat/chat/completions',
    AI_MODEL: 'chat', MODEL_FARM_API_KEY: 'key' });
  assert.match(semanticSearchConfig(farm, 'key', {}).reason, /AI_EMBEDDING_URL/);
  // Without an endpoint there is no model, so cached vectors of the real model are never pruned.
  assert.equal(farm.embeddingModel, null);
  const withEmbeddings = providerConfig({ AI_PROVIDER: 'llm-farm', AI_CHAT_URL: farm.chatUrl, AI_MODEL: 'chat', MODEL_FARM_API_KEY: 'key',
    AI_EMBEDDING_URL: 'https://aoai-farm.bosch-temp.com/api/openai/deployments/farm-embedding-small/embeddings?api-version=2024-02-01' });
  assert.equal(withEmbeddings.embeddingModel, 'farm-embedding-small');
  assert.equal(semanticSearchConfig(withEmbeddings, 'key', {}).enabled, true);
  assert.throws(() => providerConfig({ AI_PROVIDER: 'llm-farm', AI_EMBEDDING_URL: 'https://example.com/embeddings' }), /aoai-farm/);
  assert.equal(semanticSearchConfig(provider, '', {}).enabled, false);
  assert.equal(semanticSearchConfig(provider, 'key', { SEMANTIC_SEARCH: 'off' }).enabled, false);
  assert.throws(() => semanticSearchConfig(provider, 'key', { SEMANTIC_MIN_SIMILARITY: '1.5' }), /between 0 and 1/);
});
