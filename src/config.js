'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal .env loader (no dependency). Reads KEY=VALUE lines from the given
 * file into process.env without overwriting values that are already set
 * (so variables exported in the shell always win).
 *
 * Load order — first loaded wins on overlaps:
 *   1. this repo's own `.env`  (bizzybee-crm/.env — local/provider settings),
 *   2. the workspace-level `.env` one level above the repo (shared Z Dot LLC
 *      credentials such as HUBSPOT_ACCESS_TOKEN / NETLIFY tokens).
 */
function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// Tests (tests/config.test.js) set BIZZYBEE_SKIP_ENV_FILES=1 to resolve the
// provider matrix against a clean environment instead of the real .env files.
if (process.env.BIZZYBEE_SKIP_ENV_FILES !== '1') {
  loadEnvFile(path.join(__dirname, '..', '.env')); // this repo (project root)
  loadEnvFile(path.join(__dirname, '..', '..', '.env')); // shared workspace creds
}

// ---- Reyna (AI) provider resolution -------------------------------------
// Any OpenAI-compatible /chat/completions endpoint works. Key precedence:
// OPENAI_API_KEY → REYNA_API_KEY → DEEPSEEK_API_KEY. When the key comes from
// DEEPSEEK_API_KEY and no base/model override is set, the endpoint + model
// default to DeepSeek so a single .env line is enough.
const aiKey = process.env.OPENAI_API_KEY || process.env.REYNA_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const usingDeepSeek = !process.env.OPENAI_API_KEY && !process.env.REYNA_API_KEY && Boolean(process.env.DEEPSEEK_API_KEY);

module.exports = {
  port: process.env.PORT || 3000,
  // Data file lives outside src so it is easy to back up / reset.
  dataFile: process.env.CRM_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
  // Plan switches require this key (header: x-admin-key) until real billing
  // is wired. Set it in the .env / Netlify env vars — a long random string.
  adminKey: process.env.BIZZYBEE_ADMIN_KEY || '',
  hubspot: {
    // Sign-ups are pushed to the Z Dot LLC HubSpot portal as contacts.
    token: process.env.HUBSPOT_ACCESS_TOKEN || ''
  },
  ai: {
    // Reyna's provider settings — read server-side, never sent to the browser.
    apiKey: aiKey,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.REYNA_BASE_URL
      || (usingDeepSeek ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'),
    model: process.env.OPENAI_MODEL || process.env.REYNA_MODEL
      || (usingDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini'),
    provider: usingDeepSeek ? 'deepseek' : 'openai-compatible'
  }
};
