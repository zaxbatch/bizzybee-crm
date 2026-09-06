'use strict';

/**
 * Reyna — the BizzyBee CRM AI assistant.
 *
 * A thin, OpenAI-compatible chat client. Anything that speaks the
 * /chat/completions wire format works: OpenAI, Groq, Together, a local
 * llama.cpp / vLLM server, etc. The API key is read server-side from the
 * environment (see config.js) and is never exposed to the browser.
 *
 * The client is deliberately generic — the routes build the persona + prompt
 * and decide what context (workspace digest, a contact's record, …) to send.
 * Privacy rule: we only ever send data from the caller's OWN workspace.
 *
 * createReynaClient(opts):
 *   { apiKey?, baseUrl?, model?, fetchImpl?, timeoutMs? }
 *   - apiKey undefined → falls back to the configured key ('' = disabled).
 *   - fetchImpl is injectable so tests can stub the upstream.
 *
 * Returns { enabled, model, complete({ system, user, temperature, maxTokens }) }.
 */

const config = require('./config');

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_TEMPERATURE = 0.4;

function createReynaClient(opts = {}) {
  // Explicit opts.apiKey wins (even empty, to force-disable); otherwise use
  // the environment key. This mirrors the HubSpot client's behavior.
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : config.ai.apiKey;
  const baseUrl = String(opts.baseUrl || config.ai.baseUrl).replace(/\/+$/, '');
  const model = opts.model || config.ai.model;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || 45 * 1000;

  const enabled = Boolean(apiKey);

  /**
   * Run one completion and return the assistant's reply text.
   * Throws { kind: 'http'|'network'|'parse', status?, message } on failure so
   * the route can map it to a clean user-facing error.
   */
  async function complete({ system, user, temperature = DEFAULT_TEMPERATURE, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
    if (!enabled) {
      const err = new Error('Reyna is not configured yet (set OPENAI_API_KEY in the server environment)');
      err.kind = 'config';
      throw err;
    }
    const messages = [];
    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push({ role: 'user', content: String(user) });

    let res;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const e = new Error(`Could not reach the AI provider: ${err && err.message ? err.message : 'network error'}`);
      e.kind = 'network';
      throw e;
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error && data.error.message) detail = String(data.error.message).slice(0, 300);
      } catch { /* keep HTTP detail */ }
      const e = new Error(`The AI provider returned an error: ${detail}`);
      e.kind = 'http';
      e.status = res.status;
      throw e;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      const e = new Error('The AI provider returned an unreadable response');
      e.kind = 'parse';
      throw e;
    }
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) {
      const e = new Error('The AI provider returned an empty response');
      e.kind = 'parse';
      throw e;
    }
    return text.trim();
  }

  return { enabled, model, complete };
}

module.exports = { createReynaClient };
