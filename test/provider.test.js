import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerConfig, providerHeaders } from '../lib/provider.js';
import { answerQuestion } from '../lib/chat.js';

test('MODEL_FARM_API_KEY takes precedence while preserving legacy key aliases', () => {
  const env = {
    AI_PROVIDER: 'llm-farm', MODEL_FARM_API_KEY: 'synthetic-model-farm-key',
    BMF_API_KEY: 'synthetic-bmf-key', LLM_FARM_API_KEY: 'synthetic-legacy-key',
  };
  assert.equal(providerConfig(env).apiKey, 'synthetic-model-farm-key');
  assert.deepEqual(providerHeaders(providerConfig(env).apiKey, providerConfig(env)), {
    Authorization: 'Bearer synthetic-model-farm-key',
  });
  assert.equal(providerConfig({ ...env, MODEL_FARM_API_KEY: '' }).apiKey, 'synthetic-bmf-key');
  assert.equal(providerConfig({ ...env, MODEL_FARM_API_KEY: '', BMF_API_KEY: '' }).apiKey, 'synthetic-legacy-key');
});

test('Farm configuration requires explicit deployment routes and never falls back to OpenAI', () => {
  const provider = providerConfig({ AI_PROVIDER: 'llm-farm', LLM_FARM_API_KEY: 'synthetic-key' });
  assert.match(provider.configurationError, /AI_CHAT_URL/);
  assert.equal(provider.chatUrl, undefined);
  assert.equal(provider.transcriptionUrl, undefined);
  assert.deepEqual(providerHeaders('synthetic-key', provider), {
    Authorization: 'Bearer synthetic-key',
  });
  assert.deepEqual(providerHeaders('synthetic-key', providerConfig({
    AI_PROVIDER: 'llm-farm', LLM_FARM_AUTH: 'subscription-key',
  })), {
    'genaiplatform-farm-subscription-key': 'synthetic-key',
  });
  assert.throws(() => providerConfig({
    AI_PROVIDER: 'llm-farm', AI_CHAT_URL: 'https://other.example/chat', AI_MODEL: 'test',
  }), /endpoints must use/);
});

test('Farm chat sends custom authentication, exact route and model, without Authorization', async () => {
  const provider = providerConfig({
    AI_PROVIDER: 'llm-farm', LLM_FARM_API_KEY: 'synthetic-key',
    LLM_FARM_AUTH: 'subscription-key',
    AI_CHAT_URL: 'https://aoai-farm.bosch-temp.com/test/chat?api-version=test', AI_MODEL: 'test-deployment',
  });
  const answer = await answerQuestion({
    executive: { name: 'Fictional', role: 'CEO', bio: '' }, question: 'Priority?',
    sources: [{ label: 'S1', text: 'Reliability.' }], history: [],
    apiKey: provider.apiKey, model: provider.model, provider,
    fetcher: async (url, options) => {
      assert.equal(url, provider.chatUrl);
      assert.equal(options.headers['genaiplatform-farm-subscription-key'], 'synthetic-key');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).model, 'test-deployment');
      return Response.json({ choices: [{ message: { content: 'Reliability [S1].' } }] });
    },
  });
  assert.match(answer.content, /Reliability/);
  assert.equal(answer.engine, 'llm-farm');
});

test('documented BMF authentication accepts BMF_API_KEY and uses Bearer only', async () => {
  const provider = providerConfig({
    AI_PROVIDER: 'llm-farm', BMF_API_KEY: 'synthetic-bmf-key',
    LLM_FARM_API_KEY: 'old-key',
    AI_CHAT_URL: 'https://aoai-farm.bosch-temp.com/api/openai/deployments/gpt-5-nano-2025-08-07/chat/completions?api-version=2025-04-01-preview',
    AI_MODEL: 'gpt-5-nano-2025-08-07',
  });
  assert.equal(provider.apiKey, 'synthetic-bmf-key');
  assert.equal(provider.configurationError, null);
  await assert.rejects(answerQuestion({
    executive: { name: 'Fictional', role: 'CEO', bio: '' }, question: 'Priority?',
    sources: [{ label: 'S1', text: 'Reliability.' }], history: [],
    apiKey: provider.apiKey, model: provider.model, provider,
    fetcher: async (url, options) => {
      assert.equal(url, provider.chatUrl);
      assert.deepEqual(options.headers, {
        Authorization: 'Bearer synthetic-bmf-key', 'Content-Type': 'application/json',
      });
      assert.equal(JSON.parse(options.body).model, provider.model);
      return Response.json({ message: 'invalid subscription' }, { status: 401 });
    },
  }), /LLM Farm rejected the API key.*401/);
  assert.throws(() => providerConfig({
    AI_PROVIDER: 'llm-farm', LLM_FARM_AUTH: 'invalid',
  }), /LLM_FARM_AUTH/);
});
