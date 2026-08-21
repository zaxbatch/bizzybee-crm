'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');
const plans = require('../src/plans');

// Main server: no admin key configured → plan switches are open (preview mode).
const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-plans-')), 'db.json');
let server;
let base;
let token;

// Gated server: an admin key IS configured → switches require it.
const tmpFileGated = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-plans-gated-')), 'db.json');
let serverGated;
let baseGated;
let tokenGated;
const GATED_KEY = 'gated-secret-key';

before(async () => {
  const app = createApp({ dataFile: tmpFile, log: false, hubspot: false });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const appGated = createApp({ dataFile: tmpFileGated, log: false, hubspot: false, adminKey: GATED_KEY });
  await new Promise((resolve) => { serverGated = appGated.listen(0, resolve); });
  baseGated = `http://127.0.0.1:${serverGated.address().port}`;
});

after(() => {
  server.close();
  serverGated.close();
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.dirname(tmpFileGated), { recursive: true, force: true }); } catch {}
});

async function api(method, url, body, tok = token, headers = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (tok) h.Authorization = `Bearer ${tok}`;
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function apiGated(method, url, body, headers = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (tokenGated) h.Authorization = `Bearer ${tokenGated}`;
  const res = await fetch(baseGated + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('new accounts start on the Free plan', async () => {
  const { status, json } = await api('POST', '/api/auth/register', {
    name: 'Plan Tester', email: 'plans@test.dev', password: 'correct horse battery staple'
  });
  assert.strictEqual(status, 201);
  assert.strictEqual(json.user.plan, 'free');
  token = json.token;
});

test('GET /api/account returns plan, limits, usage and prices', async () => {
  const { status, json } = await api('GET', '/api/account');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.plan.id, 'free');
  assert.strictEqual(json.plan.priceMonthly, 0);
  assert.strictEqual(json.plan.limits.contacts, 1000);
  assert.deepStrictEqual(json.usage, { contacts: 0, pipelines: 1, customFields: 0, members: 0 });
  assert.strictEqual(json.prices.pro, 19);
  assert.strictEqual(json.prices.business, 49);
});

test('plan switch is open when no admin key is configured', async () => {
  const { status, json } = await api('PUT', '/api/account/plan', { plan: 'pro' });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.plan.id, 'pro');
  assert.strictEqual(json.plan.priceMonthly, 19);
  const again = await api('GET', '/api/account');
  assert.strictEqual(again.json.plan.limits.contacts, 'unlimited');
});

test('unknown plan is rejected', async () => {
  const { status } = await api('PUT', '/api/account/plan', { plan: 'enterprise' });
  assert.strictEqual(status, 400);
});

test('plan switch requires the admin key when one is configured', async () => {
  const reg = await apiGated('POST', '/api/auth/register', {
    name: 'Gated Tester', email: 'gated@test.dev', password: 'correct horse battery staple'
  });
  assert.strictEqual(reg.status, 201);
  tokenGated = reg.json.token;

  const noKey = await apiGated('PUT', '/api/account/plan', { plan: 'business' });
  assert.strictEqual(noKey.status, 403);
  const badKey = await apiGated('PUT', '/api/account/plan', { plan: 'business' }, { 'x-admin-key': 'wrong' });
  assert.strictEqual(badKey.status, 403);
  const good = await apiGated('PUT', '/api/account/plan', { plan: 'business' }, { 'x-admin-key': GATED_KEY });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.json.plan.id, 'business');
});

// ---- unit checks on the limit helper ----
test('contactLimitError blocks at the allowance and passes under it', () => {
  const stub = (count) => ({ allFor: () => Array(count).fill({}) });
  assert.ok(plans.contactLimitError(stub(1000), { id: 'u1' }), 'free user at 1000 contacts should be blocked');
  assert.strictEqual(plans.contactLimitError(stub(999), { id: 'u1' }), null, 'free user at 999 contacts should pass');
  assert.strictEqual(plans.contactLimitError(stub(100000), { id: 'u1', plan: 'pro' }), null, 'pro user is unlimited');
  const err = plans.contactLimitError(stub(1000), { id: 'u1' });
  assert.strictEqual(err.status, 403);
  assert.strictEqual(err.json.code, 'PLAN_LIMIT');
  assert.strictEqual(err.json.upgrade, 'pro');
});

test('getPlanId defaults legacy users to free', () => {
  assert.strictEqual(plans.getPlanId({}), 'free');
  assert.strictEqual(plans.getPlanId({ plan: 'business' }), 'business');
  assert.strictEqual(plans.getPlanId({ plan: 'nonsense' }), 'free');
});
