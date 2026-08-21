'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-cf-')), 'db.json');
let server;
let base;
let token;

before(async () => {
  const app = createApp({ dataFile: tmpFile, log: false, hubspot: false });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
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

test('free plan cannot create custom fields (limit 0)', async () => {
  const reg = await api('POST', '/api/auth/register', { name: 'CF Tester', email: 'cf@test.dev', password: 'correct horse battery staple' });
  assert.strictEqual(reg.status, 201);
  token = reg.json.token;
  const { status, json } = await api('POST', '/api/custom-fields', { label: 'LinkedIn', type: 'text' });
  assert.strictEqual(status, 403);
  assert.strictEqual(json.code, 'PLAN_LIMIT');
  const acct = await api('GET', '/api/account');
  assert.strictEqual(acct.json.usage.customFields, 0);
});

test('pro plan creates fields; select requires options; list returns them', async () => {
  await api('PUT', '/api/account/plan', { plan: 'pro' });
  const text = await api('POST', '/api/custom-fields', { label: 'LinkedIn URL', type: 'text' });
  assert.strictEqual(text.status, 201);

  const noOpts = await api('POST', '/api/custom-fields', { label: 'Source', type: 'select' });
  assert.strictEqual(noOpts.status, 400);

  const sel = await api('POST', '/api/custom-fields', { label: 'Lead Source', type: 'select', options: ['Web', 'Referral', 'Ads'] });
  assert.strictEqual(sel.status, 201);

  const badType = await api('POST', '/api/custom-fields', { label: 'Bogus', type: 'emoji' });
  assert.strictEqual(badType.status, 400);

  const list = await api('GET', '/api/custom-fields');
  assert.strictEqual(list.json.length, 2);
  assert.deepStrictEqual(list.json.find((f) => f.type === 'select').options, ['Web', 'Referral', 'Ads']);
  const acct = await api('GET', '/api/account');
  assert.strictEqual(acct.json.usage.customFields, 2);
});

test('contact custom values: valid stored, unknown field / bad number / bad select rejected', async () => {
  const defs = (await api('GET', '/api/custom-fields')).json;
  const textField = defs.find((f) => f.type === 'text');
  const selField = defs.find((f) => f.type === 'select');
  const numField = (await api('POST', '/api/custom-fields', { label: 'Employees', type: 'number' })).json;

  const ok = await api('POST', '/api/contacts', {
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com',
    custom: { [textField.id]: 'https://linkedin.com/in/ada', [selField.id]: 'Referral', [numField.id]: '42' },
  });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.custom[textField.id], 'https://linkedin.com/in/ada');
  assert.strictEqual(ok.json.custom[numField.id], '42');

  const unknown = await api('POST', '/api/contacts', { firstName: 'X', lastName: 'Y', email: 'xy@example.com', custom: { nope: 'x' } });
  assert.strictEqual(unknown.status, 400);

  const badNum = await api('POST', '/api/contacts', { firstName: 'X', lastName: 'Y', email: 'xz@example.com', custom: { [numField.id]: 'abc' } });
  assert.strictEqual(badNum.status, 400);

  const badSel = await api('POST', '/api/contacts', { firstName: 'X', lastName: 'Y', email: 'xw@example.com', custom: { [selField.id]: 'Nope' } });
  assert.strictEqual(badSel.status, 400);
});

test('contacts.csv export includes custom field columns and values', async () => {
  const defs = (await api('GET', '/api/custom-fields')).json;
  const textField = defs.find((f) => f.type === 'text');
  const res = await fetch(base + '/api/export/contacts.csv', { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(text.includes(textField.label), 'export header should include the custom field label');
  assert.ok(text.includes('https://linkedin.com/in/ada'), 'export should include the custom value');
});

test('contacts.csv import maps custom field columns by label', async () => {
  const defs = (await api('GET', '/api/custom-fields')).json;
  const selField = defs.find((f) => f.type === 'select');
  const csv = `firstName,lastName,email,${selField.label}\nGrace,Hopper,grace@example.com,Ads\n`;
  const { status, json } = await api('POST', '/api/import/contacts', { csv, required: ['firstName', 'lastName', 'email'] });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.imported, 1);
  const contacts = (await api('GET', '/api/contacts?q=grace')).json;
  const g = contacts.find((c) => c.email === 'grace@example.com');
  assert.strictEqual(g.custom[selField.id], 'Ads');
});

test('deleting a custom field strips its values from contacts', async () => {
  const defs = (await api('GET', '/api/custom-fields')).json;
  const textField = defs.find((f) => f.type === 'text');
  const contacts = (await api('GET', '/api/contacts')).json;
  const withValue = contacts.find((c) => c.custom && c.custom[textField.id]);
  assert.ok(withValue, 'contact with the text-field value should exist');

  const del = await api('DELETE', `/api/custom-fields/${textField.id}`);
  assert.strictEqual(del.status, 204);

  const after = (await api('GET', `/api/contacts/${withValue.id}`)).json;
  assert.strictEqual(after.custom[textField.id], undefined, 'value should be stripped');
});
