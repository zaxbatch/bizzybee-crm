'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-import-')), 'db.json');
let server;
let base;
let token;
let tokenB;

before(async () => {
  const app = createApp({ dataFile: tmpFile, log: false, hubspot: false });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
});

async function api(method, url, body, tok = token) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function register(email) {
  const { json } = await api('POST', '/api/auth/register', { name: 'X', email, password: 'password123' }, null);
  return json.token;
}

test('import requires authentication', async () => {
  const { status } = await api('POST', '/api/import/contacts', { csv: 'firstName\nA' }, null);
  assert.strictEqual(status, 401);
});

test('contacts import creates contacts, auto-creates and links companies', async () => {
  token = await register('import@example.com');
  const csv = [
    'firstName,lastName,email,phone,title,company,status,tags,notes',
    'Dana,Lee,dana@acme.example,+1 555-0101,CTO,Acme Corp,customer,technical; vip,"Multi\nline note"',
    'Bob,Smith,bob@globex.example,,,Globex Ltd,lead,,'
  ].join('\n');

  const res = await api('POST', '/api/import/contacts', { csv });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.imported, 2);
  assert.strictEqual(res.json.skipped, 0);
  assert.strictEqual(res.json.companiesCreated, 2);

  const contacts = await api('GET', '/api/contacts');
  assert.strictEqual(contacts.json.length, 2);
  const dana = contacts.json.find((c) => c.email === 'dana@acme.example');
  assert.strictEqual(dana.companyName, 'Acme Corp');
  assert.strictEqual(dana.status, 'customer');
  assert.deepStrictEqual(dana.tags, ['technical', 'vip']);
  assert.strictEqual(dana.notes, 'Multi\nline note');

  const companies = await api('GET', '/api/companies');
  assert.strictEqual(companies.json.length, 2);
});

test('importing the same company name links, not duplicates', async () => {
  const csv = 'firstName,lastName,email,company\n' +
    'Carol,White,carol@acme.example,Acme Corp\n' +
    'Dan,Gray,dan@globex.example,Globex Ltd\n';
  const res = await api('POST', '/api/import/contacts', { csv });
  assert.strictEqual(res.json.imported, 2);
  assert.strictEqual(res.json.companiesCreated, 0);
  assert.strictEqual((await api('GET', '/api/companies')).json.length, 2);
});

test('bad rows are skipped and reported, good rows still import', async () => {
  const csv = 'firstName,lastName,email,status\n' +
    'Good,Row,good@example.com,lead\n' +
    'Bad,Row,not-an-email,lead\n' +
    'NoEmail,Row,,lead\n' +
    'BadStatus,Row,x@example.com,banana\n';
  const res = await api('POST', '/api/import/contacts', { csv });
  assert.strictEqual(res.json.imported, 1);
  assert.strictEqual(res.json.skipped, 3);
  assert.strictEqual(res.json.errors.length, 3);
  assert.ok(res.json.errors.every((e) => e.row >= 2));
  assert.ok(res.json.errors.some((e) => e.email === 'not-an-email' && e.errors.some((m) => m.includes('email'))));
});

test('imports require a header row', async () => {
  const res = await api('POST', '/api/import/contacts', { csv: 'only,one,row' });
  assert.strictEqual(res.status, 400);
});

test('bad rows do not create companies', async () => {
  const csv = 'firstName,lastName,email,company\n' +
    'Good,Row,good2@example.com,Real Co\n' +
    'Bad,Row,not-an-email,Phantom Co\n';
  const res = await api('POST', '/api/import/contacts', { csv });
  assert.strictEqual(res.json.imported, 1);
  assert.strictEqual(res.json.skipped, 1);
  const companies = (await api('GET', '/api/companies')).json;
  assert.ok(companies.some((c) => c.name === 'Real Co'));
  assert.ok(!companies.some((c) => c.name === 'Phantom Co'));
});

// ---- Field mapping + mandatory toggles -------------------------------------

test('mapped import with custom headers and a required toggle', async () => {
  // Non-standard headers; only email is required.
  const csv = 'Full Name,Email Address,Org\n' +
    'Jane Roe,jane@custom.example,Widgets Inc\n' +
    'John Doe,john@custom.example,\n' +
    'No Email,,Solo Co\n';
  const res = await api('POST', '/api/import/contacts', {
    csv,
    mapping: { name: 'Full Name', email: 'Email Address', company: 'Org' },
    required: ['email']
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.imported, 2); // Jane + John
  assert.strictEqual(res.json.skipped, 1); // "No Email" row (email required)
  assert.strictEqual(res.json.companiesCreated, 1); // only Widgets Inc (bad row creates nothing)

  const contacts = await api('GET', '/api/contacts');
  const jane = contacts.json.find((c) => c.email === 'jane@custom.example');
  assert.strictEqual(jane.firstName, 'Jane');
  assert.strictEqual(jane.lastName, 'Roe');
  assert.strictEqual(jane.companyName, 'Widgets Inc');
  const john = contacts.json.find((c) => c.email === 'john@custom.example');
  assert.strictEqual(john.companyName, null);
});

test('mapped import with nothing mandatory imports partial rows', async () => {
  const csv = 'First,Last,Email\n' +
    'Only First,,j@example.com\n' +
    ',,bareemail@example.com\n';
  const res = await api('POST', '/api/import/contacts', {
    csv,
    mapping: { firstName: 'First', lastName: 'Last', email: 'Email' },
    required: []
  });
  assert.strictEqual(res.json.imported, 2);
  assert.strictEqual(res.json.skipped, 0);
});

test('mapped import rejects a required field with no column', async () => {
  const csv = 'First,Last\nA,B\n';
  const res = await api('POST', '/api/import/contacts', {
    csv,
    mapping: { firstName: 'First', lastName: 'Last' },
    required: ['email']
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.json.error, /email.*not mapped/i);
});

test('mapped companies import with custom headers', async () => {
  const csv = 'Business Name,Sector,Web\n' +
    'Mapped Co,Software,https://mapped.example\n';
  const res = await api('POST', '/api/import/companies', {
    csv,
    mapping: { name: 'Business Name', industry: 'Sector', website: 'Web' },
    required: ['name']
  });
  assert.strictEqual(res.json.imported, 1);
  const companies = (await api('GET', '/api/companies')).json;
  const mc = companies.find((c) => c.name === 'Mapped Co');
  assert.strictEqual(mc.industry, 'Software');
  assert.strictEqual(mc.website, 'https://mapped.example');
});

test('companies import dedupes and validates', async () => {
  const csv = 'name,industry,size,website,notes\n' +
    'New Co,Software,1-10,https://newco.example,\n' +
    'New Co,Duplicate,,,\n' +
    ',No Name,,,\n';
  const res = await api('POST', '/api/import/companies', { csv });
  assert.strictEqual(res.json.imported, 1);
  assert.strictEqual(res.json.skipped, 1); // duplicate (blank name row is ignored, not counted)
  assert.strictEqual(res.json.errors.length, 1);
  assert.ok(res.json.errors[0].errors.includes('Company already exists'));
});

test('per-user isolation: user B starts empty and imports separately', async () => {
  tokenB = await register('import2@example.com');
  const contactsB = await api('GET', '/api/contacts', null, tokenB);
  assert.strictEqual(contactsB.json.length, 0);

  const csv = 'firstName,lastName,email,company\nEve,Adam,eve@example.com,Acme Corp\n';
  const res = await api('POST', '/api/import/contacts', { csv }, tokenB);
  assert.strictEqual(res.json.companiesCreated, 1); // B's own Acme Corp, not A's
  const companiesB = await api('GET', '/api/companies', null, tokenB);
  assert.strictEqual(companiesB.json.length, 1);
  // A is untouched (Acme, Globex, New Co, Real Co, Widgets Inc, Mapped Co — B's import created none of these)
  assert.strictEqual((await api('GET', '/api/companies')).json.length, 6);
});
