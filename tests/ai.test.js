'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const { Db } = require('../src/db');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ai-'));
let server;
let db;
let base;
let ownerToken;
let lastPrompt = null;

/** Stub Reyna client: captures prompts, returns a canned reply. */
const STUB = {
  enabled: true,
  model: 'stub-1',
  async complete(prompt) {
    lastPrompt = prompt;
    return 'STUB REPLY from Reyna.';
  }
};

// Small credit caps for tests: Pro 5 / Business 6.
const CREDITS = { free: 0, pro: 5, business: 6 };

async function api(method, url, body, tok) {
  const h = {};
  if (body) h['Content-Type'] = 'application/json';
  if (tok) h.Authorization = `Bearer ${tok}`;
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

before(async () => {
  const file = path.join(tmpDir, 'db.json');
  db = new Db(file);
  const app = createApp({ db, log: false, hubspot: false, ai: STUB, aiCreditOverrides: CREDITS });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('Reyna is off on Free and reports an upgrade hint', async () => {
  const reg = await api('POST', '/api/auth/register', { name: 'AI Owner', email: 'ai-owner@test.dev', password: 'correct horse battery staple' });
  assert.strictEqual(reg.status, 201);
  ownerToken = reg.json.token;

  const info = await api('GET', '/api/ai', null, ownerToken);
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.json.enabled, false);
  assert.strictEqual(info.json.configured, true); // provider key present (stub)
  assert.strictEqual(info.json.persona.name, 'Reyna');
  assert.strictEqual(info.json.credits.limit, 0);
  assert.strictEqual(info.json.credits.used, 0);
  assert.strictEqual(info.json.upgrade, 'pro');

  const chat = await api('POST', '/api/ai/chat', { message: 'hello?' }, ownerToken);
  assert.strictEqual(chat.status, 403);
  assert.strictEqual(chat.json.code, 'AI_PLAN');
  assert.strictEqual(chat.json.upgrade, 'pro');
});

test('Pro: chat, summarize and coach each consume one credit', async () => {
  const up = await api('PUT', '/api/account/plan', { plan: 'pro' }, ownerToken);
  assert.strictEqual(up.status, 200);

  const info = await api('GET', '/api/ai', null, ownerToken);
  assert.strictEqual(info.json.enabled, true);
  assert.deepStrictEqual(info.json.credits, { limit: 5, used: 0, month: info.json.credits.month });

  const chat = await api('POST', '/api/ai/chat', { message: 'What is my pipeline worth?' }, ownerToken);
  assert.strictEqual(chat.status, 200);
  assert.strictEqual(chat.json.text, 'STUB REPLY from Reyna.');
  assert.strictEqual(chat.json.credits.used, 1);
  assert.match(lastPrompt.user, /What is my pipeline worth\?/);

  // Bad lookups are rejected without charging.
  const bad = await api('POST', '/api/ai/summarize', { type: 'contact', id: 'missing' }, ownerToken);
  assert.strictEqual(bad.status, 404);
  const badType = await api('POST', '/api/ai/summarize', { type: 'invoice', id: 'x' }, ownerToken);
  assert.strictEqual(badType.status, 400);
  const still = await api('GET', '/api/ai', null, ownerToken);
  assert.strictEqual(still.json.credits.used, 1);

  const contact = await api('POST', '/api/contacts', { firstName: 'Grace', lastName: 'Hopper', email: 'grace@ai.test' }, ownerToken);
  assert.strictEqual(contact.status, 201);
  const summary = await api('POST', '/api/ai/summarize', { type: 'contact', id: contact.json.id }, ownerToken);
  assert.strictEqual(summary.status, 200);
  assert.strictEqual(summary.json.credits.used, 2);
  assert.match(lastPrompt.user, /Grace Hopper/);

  const coach = await api('POST', '/api/ai/coach', {}, ownerToken);
  assert.strictEqual(coach.status, 200);
  assert.strictEqual(coach.json.credits.used, 3);
});

test('email drafts and polish parse Subject/body and spend credits 4 and 5', async () => {
  const contact = (await api('GET', '/api/contacts', null, ownerToken)).json[0];
  const original = STUB.complete;
  STUB.complete = async (prompt) => {
    lastPrompt = prompt;
    return 'Subject: Quick follow-up\n\nHi Grace,\n\nAre you free Thursday?\n\n— You';
  };
  try {
    const draft = await api('POST', '/api/ai/email-draft', { type: 'contact', id: contact.id, intent: 'follow-up after our call' }, ownerToken);
    assert.strictEqual(draft.status, 200);
    assert.strictEqual(draft.json.subject, 'Quick follow-up');
    assert.match(draft.json.body, /Are you free Thursday/);
    assert.strictEqual(draft.json.credits.used, 4);
    assert.match(lastPrompt.user, /follow-up after our call/);

    // Polish keeps the provided subject when the model replies without one.
    STUB.complete = original;
    const polished = await api('POST', '/api/ai/polish', { subject: 'Intro call notes', body: 'met with Acme about their CRM needs' }, ownerToken);
    assert.strictEqual(polished.status, 200);
    assert.strictEqual(polished.json.subject, 'Intro call notes');
    assert.strictEqual(polished.json.body, 'STUB REPLY from Reyna.');
    assert.strictEqual(polished.json.credits.used, 5);
  } finally {
    STUB.complete = original;
  }
});

test('caps: Pro is exhausted at 5, Business gets a larger bucket', async () => {
  const blocked = await api('POST', '/api/ai/chat', { message: 'one more?' }, ownerToken);
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.json.code, 'AI_CREDITS');
  assert.strictEqual(blocked.json.used, 5);
  assert.strictEqual(blocked.json.limit, 5);

  // Same workspace usage carries into Business, which allows 6 total.
  const up = await api('PUT', '/api/account/plan', { plan: 'business' }, ownerToken);
  assert.strictEqual(up.status, 200);
  const info = await api('GET', '/api/ai', null, ownerToken);
  assert.deepStrictEqual(info.json.credits, { limit: 6, used: 5, month: info.json.credits.month });

  const ok = await api('POST', '/api/ai/chat', { message: 'hi' }, ownerToken);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.credits.used, 6);

  const again = await api('POST', '/api/ai/chat', { message: 'blocked' }, ownerToken);
  assert.strictEqual(again.status, 403);
  assert.strictEqual(again.json.code, 'AI_CREDITS');
  assert.strictEqual(again.json.used, 6);
});

test('spending resets when the calendar month rolls over', async () => {
  const owner = db.all('users').find((u) => u.email === 'ai-owner@test.dev');
  db.update('users', owner.id, { workspace: { ...(owner.workspace || {}), aiUsage: { month: '1999-01', used: 999 } } });
  const info = await api('GET', '/api/ai', null, ownerToken);
  assert.notStrictEqual(info.json.credits.month, '1999-01');
  assert.strictEqual(info.json.credits.used, 0, 'stale month resets to zero');

  const chat = await api('POST', '/api/ai/chat', { message: 'after reset' }, ownerToken);
  assert.strictEqual(chat.status, 200);
  assert.strictEqual(chat.json.credits.used, 1);
});

// ---- separate servers for provider problems ----

async function startServer(options) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'srv-'));
  const file = path.join(dir, 'db.json');
  const app = createApp({ dataFile: file, log: false, hubspot: false, ...options });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { srv, url: `http://127.0.0.1:${srv.address().port}`, dir };
}

test('missing provider key → 503 AI_CONFIG (never charged)', async () => {
  const { srv, url, dir } = await startServer({ ai: false, aiCreditOverrides: CREDITS });
  try {
    const reg = await apiAt(url, 'POST', '/api/auth/register', { name: 'No Key', email: 'nokey@test.dev', password: 'correct horse battery staple' });
    const tok = reg.json.token;
    await apiAt(url, 'PUT', '/api/account/plan', { plan: 'pro' }, tok);

    const chat = await apiAt(url, 'POST', '/api/ai/chat', { message: 'hi' }, tok);
    assert.strictEqual(chat.status, 503);
    assert.strictEqual(chat.json.code, 'AI_CONFIG');

    const info = await apiAt(url, 'GET', '/api/ai', null, tok);
    assert.strictEqual(info.json.configured, false);
    assert.strictEqual(info.json.credits.used, 0, 'nothing charged when provider missing');
  } finally {
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('provider failures map to 502 AI_ERROR and are not charged', async () => {
  const failing = {
    enabled: true,
    model: 'stub',
    async complete() { const e = new Error('upstream exploded'); e.kind = 'http'; throw e; }
  };
  const { srv, url, dir } = await startServer({ ai: failing, aiCreditOverrides: CREDITS });
  try {
    const reg = await apiAt(url, 'POST', '/api/auth/register', { name: 'Fail', email: 'fail@test.dev', password: 'correct horse battery staple' });
    const tok = reg.json.token;
    await apiAt(url, 'PUT', '/api/account/plan', { plan: 'pro' }, tok);

    const res = await apiAt(url, 'POST', '/api/ai/chat', { message: 'hi' }, tok);
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.json.code, 'AI_ERROR');

    const info = await apiAt(url, 'GET', '/api/ai', null, tok);
    assert.strictEqual(info.json.credits.used, 0, 'failed completions must not consume credits');
  } finally {
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

async function apiAt(url, method, path, body, tok) {
  const h = {};
  if (body) h['Content-Type'] = 'application/json';
  if (tok) h.Authorization = `Bearer ${tok}`;
  const res = await fetch(url + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('real client parses completions through a stubbed OpenAI-compatible fetch', async () => {
  // Fake transport returns the exact wire shape of /chat/completions.
  const fakeFetch = async (url, opts) => {
    lastPrompt = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Subject: Hello there\n\nThis is the body from the model.' } }] })
    };
  };
  const { srv, url, dir } = await startServer({ ai: { apiKey: 'test-key', model: 'test-model', fetchImpl: fakeFetch }, aiCreditOverrides: CREDITS });
  try {
    const reg = await apiAt(url, 'POST', '/api/auth/register', { name: 'Wire', email: 'wire@test.dev', password: 'correct horse battery staple' });
    const tok = reg.json.token;
    await apiAt(url, 'PUT', '/api/account/plan', { plan: 'pro' }, tok);

    const chat = await apiAt(url, 'POST', '/api/ai/chat', { message: 'hi' }, tok);
    assert.strictEqual(chat.status, 200);
    assert.match(lastPrompt.body.messages[0].role, /system/);
    assert.match(lastPrompt.body.model, /gpt|stub|test/i);

    const email = await apiAt(url, 'POST', '/api/ai/email-draft', { type: 'contact', id: 'x' }, tok);
    // No contact exists yet → entity lookup fails before the model is called.
    assert.strictEqual(email.status, 404);
  } finally {
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
