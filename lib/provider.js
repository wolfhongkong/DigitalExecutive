export function providerConfig(env = process.env) {
  const farm = env.AI_PROVIDER === 'llm-farm';
  const transcriptionMode = env.AI_TRANSCRIPTION_MODE || 'whisper';
  if (!['whisper', 'gemini'].includes(transcriptionMode)) {
    throw new Error('AI_TRANSCRIPTION_MODE must be whisper or gemini.');
  }
  const auth = env.LLM_FARM_AUTH || 'bearer';
  if (farm && !['bearer', 'subscription-key'].includes(auth)) {
    throw new Error('LLM_FARM_AUTH must be bearer or subscription-key.');
  }
  const chatUrl = farm ? env.AI_CHAT_URL : 'https://api.openai.com/v1/chat/completions';
  const transcriptionUrl = farm ? env.AI_TRANSCRIPTION_URL : 'https://api.openai.com/v1/audio/transcriptions';
  const embeddingUrl = farm ? env.AI_EMBEDDING_URL : 'https://api.openai.com/v1/embeddings';
  for (const value of [chatUrl, transcriptionUrl, embeddingUrl].filter(Boolean)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('AI endpoint URLs must use HTTPS and must not contain credentials.');
    if (farm && url.origin !== 'https://aoai-farm.bosch-temp.com') {
      throw new Error('LLM Farm endpoints must use https://aoai-farm.bosch-temp.com.');
    }
  }
  return {
    name: farm ? 'LLM Farm' : 'OpenAI',
    apiKey: farm ? env.MODEL_FARM_API_KEY || env.BMF_API_KEY || env.LLM_FARM_API_KEY : env.OPENAI_API_KEY,
    model: farm ? env.AI_MODEL : env.OPENAI_MODEL || 'gpt-4.1-mini',
    transcriptionModel: env.AI_TRANSCRIPTION_MODEL || 'whisper-1',
    transcriptionMode,
    chatUrl, transcriptionUrl, embeddingUrl,
    // Farm deployments are addressed by URL; the deployment name doubles as the model label.
    embeddingModel: !embeddingUrl ? null : env.AI_EMBEDDING_MODEL || (farm
      ? embeddingUrl.match(/\/deployments\/([^/]+)\//)?.[1] || 'farm-embedding'
      : 'text-embedding-3-small'),
    header: farm && auth === 'subscription-key' ? 'genaiplatform-farm-subscription-key' : 'Authorization',
    configurationError: farm && (!chatUrl || !env.AI_MODEL)
      ? 'LLM Farm requires AI_CHAT_URL and AI_MODEL from your gateway documentation. The subscription key is stored, but no verified chat route/deployment has been supplied.'
      : null,
  };
}

export function providerHeaders(apiKey, provider) {
  return provider?.header === 'genaiplatform-farm-subscription-key'
    ? { 'genaiplatform-farm-subscription-key': apiKey }
    : { Authorization: `Bearer ${apiKey}` };
}
