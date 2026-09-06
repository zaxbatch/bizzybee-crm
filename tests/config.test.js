'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// config.js reads .env files + process.env at require time, so each case
// re-requires it with a clean environment. The env-file loader is disabled so
// the real bizzybee-crm/.env can't leak DeepSeek/OpenAI keys into these cases.
process.env.BIZZYBEE_SKIP_ENV_FILES = '1';

const CONFIG = path.join(__dirname, '..', 'src', 'config.js');
const AI_ENV_KEYS = [
  'OPENAI_API_KEY', 'REYNA_API_KEY', 'DEEPSEEK_API_KEY',
  'OPENAI_BASE_URL', 'REYNA_BASE_URL', 'OPENAI_MODEL', 'REYNA_MODEL'
];

/** Load config.ai with exactly the given env vars set (restores env after). */
function loadAiConfig(envPatch = {}) {
  const saved = {};
  for (const key of AI_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    Object.assign(process.env, envPatch);
    delete require.cache[CONFIG];
    return require(CONFIG).ai;
  } finally {
    for (const key of AI_ENV_KEYS) {
      delete process.env[key];
      if (saved[key] !== undefined) process.env[key] = saved[key];
    }
  }
}

test('no keys configured → OpenAI defaults, disabled', () => {
  const ai = loadAiConfig();
  assert.strictEqual(ai.apiKey, '');
  assert.strictEqual(ai.baseUrl, 'https://api.openai.com/v1');
  assert.strictEqual(ai.model, 'gpt-4o-mini');
  assert.strictEqual(ai.provider, 'openai-compatible');
});

test('DEEPSEEK_API_KEY alone → DeepSeek endpoint + model, one line setup', () => {
  const ai = loadAiConfig({ DEEPSEEK_API_KEY: 'sk-deepseek-123' });
  assert.strictEqual(ai.apiKey, 'sk-deepseek-123');
  assert.strictEqual(ai.baseUrl, 'https://api.deepseek.com/v1');
  assert.strictEqual(ai.model, 'deepseek-chat');
  assert.strictEqual(ai.provider, 'deepseek');
});

test('OPENAI_API_KEY wins over DEEPSEEK_API_KEY and stays on OpenAI defaults', () => {
  const ai = loadAiConfig({ OPENAI_API_KEY: 'sk-openai-1', DEEPSEEK_API_KEY: 'sk-deepseek-1' });
  assert.strictEqual(ai.apiKey, 'sk-openai-1');
  assert.strictEqual(ai.baseUrl, 'https://api.openai.com/v1');
  assert.strictEqual(ai.model, 'gpt-4o-mini');
  assert.strictEqual(ai.provider, 'openai-compatible');
});

test('DeepSeek key + REYNA_BASE_URL/REYNA_MODEL overrides honored', () => {
  const ai = loadAiConfig({
    DEEPSEEK_API_KEY: 'sk-deepseek-2',
    REYNA_BASE_URL: 'https://my-gateway.example/v1',
    REYNA_MODEL: 'custom-model'
  });
  assert.strictEqual(ai.apiKey, 'sk-deepseek-2');
  assert.strictEqual(ai.baseUrl, 'https://my-gateway.example/v1');
  assert.strictEqual(ai.model, 'custom-model');
});

test('brand-neutral REYNA_API_KEY alias is honored (provider stays openai-compatible)', () => {
  const ai = loadAiConfig({ REYNA_API_KEY: 'sk-reyna-1' });
  assert.strictEqual(ai.apiKey, 'sk-reyna-1');
  assert.strictEqual(ai.baseUrl, 'https://api.openai.com/v1');
  assert.strictEqual(ai.provider, 'openai-compatible');
});
