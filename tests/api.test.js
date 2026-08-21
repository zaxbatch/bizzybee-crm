'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-')), 'db.json');
let server;
let base;
let token; // user A's session
let tokenB; // user B's session

before(async () => {
  // hubspot: false keeps tests fully offline (no real HubSpot calls).
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
  const res = await fetch(base + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/** Fetch a raw CSV body (with auth) for export tests. */
async function csv(method, url, tok = token) {
  const headers = {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(base + url, { method, headers });
  const text = await res.text();
  return { status: res.status, text, type: res.headers.get('content-type') };
}

// ---- Auth ----------------------------------------------------------------

test('health endpoint is public', async () => {
  const { status, json } = await api('GET', '/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.status, 'ok');
});

test('API routes require authentication', async () => {
  const { status } = await api('GET', '/api/contacts', null, null);
  assert.strictEqual(status, 401);
  const dash = await api('GET', '/api/dashboard', null, null);
  assert.strictEqual(dash.status, 401);
});

test('register creates a user, returns a token, and me() works', async () => {
  const { status, json } = await api('POST', '/api/auth/register', {
    name: 'Alice', email: 'alice@example.com', password: 'hunter2secret'
  }, null);
  assert.strictEqual(status, 201);
  assert.ok(json.token);
  assert.strictEqual(json.user.email, 'alice@example.com');
  assert.strictEqual(json.user.passwordHash, undefined);
  token = json.token;

  const me = await api('GET', '/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.json.user.email, 'alice@example.com');
});

test('register rejects duplicate email and weak password', async () => {
  const dup = await api('POST', '/api/auth/register', { name: 'X', email: 'ALICE@example.com', password: 'hunter2secret' }, null);
  assert.strictEqual(dup.status, 400);
  assert.ok(dup.json.details.some((e) => e.includes('already exists')));

  const weak = await api('POST', '/api/auth/register', { name: 'X', email: 'x@example.com', password: 'short' }, null);
  assert.strictEqual(weak.status, 400);
  assert.ok(weak.json.details.some((e) => e.includes('8 characters')));
});

test('register requires a name and stores an optional phone', async () => {
  const noName = await api('POST', '/api/auth/register', { email: 'noname@example.com', password: 'password123' }, null);
  assert.strictEqual(noName.status, 400);
  assert.ok(noName.json.details.some((e) => e.includes('Name is required')));

  const withPhone = await api('POST', '/api/auth/register', {
    name: 'Pat Kelly', email: 'pat@example.com', phone: '+1 555-0199', password: 'password123'
  }, null);
  assert.strictEqual(withPhone.status, 201);
  assert.strictEqual(withPhone.json.user.phone, '+1 555-0199');
  assert.strictEqual(withPhone.json.user.name, 'Pat Kelly');

  const withoutPhone = await api('POST', '/api/auth/register', {
    name: 'No Phone', email: 'nophone@example.com', password: 'password123'
  }, null);
  assert.strictEqual(withoutPhone.status, 201);
  assert.strictEqual(withoutPhone.json.user.phone, '');
});

test('login succeeds with correct password, fails with wrong one', async () => {
  const bad = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'wrongpass' }, null);
  assert.strictEqual(bad.status, 401);

  const good = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'hunter2secret' }, null);
  assert.strictEqual(good.status, 200);
  assert.ok(good.json.token);
});

test('logout invalidates the session token', async () => {
  const login = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'hunter2secret' }, null);
  const temp = login.json.token;
  const out = await api('POST', '/api/auth/logout', null, temp);
  assert.strictEqual(out.status, 204);
  const after = await api('GET', '/api/auth/me', null, temp);
  assert.strictEqual(after.status, 401);
});

// ---- Empty default state ---------------------------------------------------

test('a new user starts with an empty workspace', async () => {
  const reg = await api('POST', '/api/auth/register', { name: 'Bob', email: 'bob@example.com', password: 'bobpass1234' }, null);
  tokenB = reg.json.token;

  const dash = await api('GET', '/api/dashboard');
  assert.deepStrictEqual(dash.json.counts, { contacts: 0, companies: 0, openDeals: 0, wonDeals: 0, activities: 0 });
  assert.strictEqual(dash.json.totals.openPipeline, 0);
  assert.deepStrictEqual(await (await api('GET', '/api/contacts')).json, []);
  assert.deepStrictEqual(await (await api('GET', '/api/companies')).json, []);
  assert.deepStrictEqual(await (await api('GET', '/api/deals')).json, []);
});

// ---- CRUD (scoped to the authenticated user) ------------------------------

test('full CRUD lifecycle for companies, contacts, deals, activities', async () => {
  // Create company
  const company = await api('POST', '/api/companies', { name: 'Acme Corp', industry: 'Software', address: '1 Main St, Springfield, IL 62701' });
  assert.strictEqual(company.status, 201);
  assert.strictEqual(company.json.ownerId, (await api('GET', '/api/auth/me')).json.user.id);
  assert.strictEqual(company.json.address, '1 Main St, Springfield, IL 62701');

  // Create contact linked to the company
  const contact = await api('POST', '/api/contacts', {
    firstName: 'Dana', lastName: 'Lee', email: 'dana@acme.example', companyId: company.json.id, status: 'lead',
    address: '200 Riverside Dr, Springfield, IL 62704'
  });
  assert.strictEqual(contact.status, 201);
  assert.strictEqual(contact.json.address, '200 Riverside Dr, Springfield, IL 62704');

  // Read + update contact
  const got = await api('GET', `/api/contacts/${contact.json.id}`);
  assert.strictEqual(got.json.companyName, 'Acme Corp');
  const updated = await api('PUT', `/api/contacts/${contact.json.id}`, { title: 'CTO', status: 'customer' });
  assert.strictEqual(updated.json.title, 'CTO');

  // Create deal against the contact/company, move its stage
  const deal = await api('POST', '/api/deals', {
    title: 'Annual License', amount: 48000, stage: 'lead', contactId: contact.json.id, companyId: company.json.id
  });
  assert.strictEqual(deal.status, 201);
  assert.strictEqual(deal.json.contactName, 'Dana Lee');
  const moved = await api('PATCH', `/api/deals/${deal.json.id}/stage`, { stage: 'negotiation' });
  assert.strictEqual(moved.json.stage, 'negotiation');

  // Log an activity, then list by contact
  const activity = await api('POST', '/api/activities', { type: 'call', subject: 'Intro call', contactId: contact.json.id });
  assert.strictEqual(activity.status, 201);
  const list = await api('GET', `/api/activities?contactId=${contact.json.id}`);
  assert.ok(list.json.some((a) => a.id === activity.json.id));

  // An activity without a contact is allowed (contact is optional)
  const standalone = await api('POST', '/api/activities', { type: 'note', subject: 'Standalone task' });
  assert.strictEqual(standalone.status, 201);
  assert.strictEqual(standalone.json.contactId, undefined);
  const all = await api('GET', '/api/activities');
  const found = all.json.find((a) => a.id === standalone.json.id);
  assert.strictEqual(found.contactName, null);

  // Search finds the new records
  const search = await api('GET', '/api/search?q=acme');
  assert.ok(search.json.companies.some((c) => c.name === 'Acme Corp'));
  assert.ok(search.json.contacts.some((c) => c.email.includes('acme')));

  // Dashboard reflects the data
  const dash = await api('GET', '/api/dashboard');
  assert.strictEqual(dash.json.counts.contacts, 1);
  assert.strictEqual(dash.json.counts.openDeals, 1);
  assert.strictEqual(dash.json.totals.openPipeline, 48000);

  // Deletes
  await api('DELETE', `/api/activities/${activity.json.id}`);
  await api('DELETE', `/api/deals/${deal.json.id}`);
  await api('DELETE', `/api/contacts/${contact.json.id}`);
  const companyDel = await api('DELETE', `/api/companies/${company.json.id}`);
  assert.strictEqual(companyDel.status, 204);
  assert.deepStrictEqual(await (await api('GET', '/api/companies')).json, []);
});

test('referencing another users company is rejected', async () => {
  const companyA = await api('POST', '/api/companies', { name: 'Only Mine' });
  const bad = await api('POST', '/api/contacts', { firstName: 'X', lastName: 'Y', email: 'xy@example.com', companyId: companyA.json.id }, tokenB);
  assert.strictEqual(bad.status, 400);
});

// ---- Per-user isolation ----------------------------------------------------

test('users cannot see or touch each other\'s records', async () => {
  const contact = await api('POST', '/api/contacts', { firstName: 'Priv', lastName: 'Ate', email: 'priv@example.com' });

  // B sees an empty list, and a 404 for A's record
  const listB = await api('GET', '/api/contacts', null, tokenB);
  assert.deepStrictEqual(listB.json, []);
  const peek = await api('GET', `/api/contacts/${contact.json.id}`, null, tokenB);
  assert.strictEqual(peek.status, 404);
  const del = await api('DELETE', `/api/contacts/${contact.json.id}`, null, tokenB);
  assert.strictEqual(del.status, 404);

  // B cannot edit it either
  const put = await api('PUT', `/api/contacts/${contact.json.id}`, { title: 'Hacked' }, tokenB);
  assert.strictEqual(put.status, 404);

  // A still owns it and it is untouched
  const mine = await api('GET', `/api/contacts/${contact.json.id}`);
  assert.strictEqual(mine.status, 200);
  assert.strictEqual(mine.json.title, undefined);
});

// ---- Password reset ---------------------------------------------------------

test('forgot returns a reset token; reset changes the password', async () => {
  const forgot = await api('POST', '/api/auth/forgot', { email: 'alice@example.com' }, null);
  assert.strictEqual(forgot.status, 200);
  assert.ok(forgot.json.resetToken);

  // Wrong token is rejected
  const badReset = await api('POST', '/api/auth/reset', { token: 'nope', password: 'brandnewpass1' }, null);
  assert.strictEqual(badReset.status, 400);

  // Old password no longer works after reset
  const ok = await api('POST', '/api/auth/reset', { token: forgot.json.resetToken, password: 'brandnewpass1' }, null);
  assert.strictEqual(ok.status, 200);
  const oldLogin = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'hunter2secret' }, null);
  assert.strictEqual(oldLogin.status, 401);
  const newLogin = await api('POST', '/api/auth/login', { email: 'alice@example.com', password: 'brandnewpass1' }, null);
  assert.strictEqual(newLogin.status, 200);
  token = newLogin.json.token;
});

test('forgot never reveals whether an account exists', async () => {
  const unknown = await api('POST', '/api/auth/forgot', { email: 'ghost@example.com' }, null);
  assert.strictEqual(unknown.status, 200);
  assert.strictEqual(unknown.json.resetToken, undefined);
});

// ---- CSV export -------------------------------------------------------------

test('CSV export requires authentication', async () => {
  const { status } = await csv('GET', '/api/export/contacts.csv', null);
  assert.strictEqual(status, 401);
});

test('CSV export returns scoped, properly escaped data for each entity', async () => {
  // Seed a company/contact/deal/activity with a comma + quote in the name to test escaping.
  const company = await api('POST', '/api/companies', { name: 'Acme, Inc. "HQ"', industry: 'Software', address: '1 Main St, Springfield, IL 62701' });
  const contact = await api('POST', '/api/contacts', {
    firstName: 'Dana', lastName: 'Lee', email: 'dana@acme.example', companyId: company.json.id,
    status: 'lead', tags: ['enterprise', 'key account'], notes: 'Multi\nline note', address: '200 Riverside Dr, Springfield, IL 62704'
  });
  const deal = await api('POST', '/api/deals', { title: 'Annual License', amount: 48000, stage: 'qualified', companyId: company.json.id, contactId: contact.json.id });
  await api('POST', '/api/activities', { type: 'call', subject: 'Intro call', body: 'Went well', contactId: contact.json.id });

  // contacts.csv
  const contacts = await csv('GET', '/api/export/contacts.csv');
  assert.strictEqual(contacts.status, 200);
  assert.match(contacts.type, /text\/csv/);
  const contactLines = contacts.text.trim().split('\r\n');
  assert.strictEqual(contactLines[0], 'firstName,lastName,email,phone,title,address,company,status,tags,notes,createdAt');
  assert.ok(contactLines.some((l) => l.includes('"Acme, Inc. ""HQ"""')));
  assert.ok(contactLines.some((l) => l.includes('200 Riverside Dr, Springfield, IL 62704')));
  assert.ok(contactLines.some((l) => l.includes('enterprise; key account')));
  assert.ok(contactLines.some((l) => l.includes('"Multi\nline note"')));

  // companies.csv includes derived counts
  const companies = await csv('GET', '/api/export/companies.csv');
  assert.strictEqual(companies.status, 200);
  assert.strictEqual(companies.text.trim().split('\r\n')[0], 'name,industry,size,website,address,notes,contactCount,dealCount,openPipeline,createdAt');
  assert.ok(companies.text.includes('"Acme, Inc. ""HQ"""'));
  assert.ok(companies.text.includes('1 Main St, Springfield, IL 62701'));

  // deals.csv joins names
  const deals = await csv('GET', '/api/export/deals.csv');
  assert.strictEqual(deals.status, 200);
  assert.strictEqual(deals.text.trim().split('\r\n')[0], 'title,amount,stage,company,contact,expectedClose,notes,createdAt');
  assert.ok(deals.text.includes('Annual License,48000,qualified,"Acme, Inc. ""HQ"""'));
  assert.ok(deals.text.includes('Dana Lee'));

  // activities.csv
  const activities = await csv('GET', '/api/export/activities.csv');
  assert.strictEqual(activities.status, 200);
  assert.strictEqual(activities.text.trim().split('\r\n')[0], 'type,subject,body,contact,happenedAt,createdAt');
  assert.ok(activities.text.includes('call,Intro call,Went well,Dana Lee'));

  // Exports are scoped: user B sees only a header row for each entity
  for (const entity of ['contacts', 'companies', 'deals', 'activities']) {
    const out = await csv('GET', `/api/export/${entity}.csv`, tokenB);
    assert.strictEqual(out.text.trim().split('\r\n').length, 1, `${entity}.csv should have only a header for user B`);
  }
});

test('unknown export type returns 404', async () => {
  const { status } = await api('GET', '/api/export/whatever.csv');
  assert.strictEqual(status, 404);
});

test('404 for unknown API route', async () => {
  const { status } = await api('GET', '/api/does-not-exist');
  assert.strictEqual(status, 404);
});

// ---- Bulk delete ------------------------------------------------------------

test('bulk delete contacts skips ones with open deals and deletes the rest', async () => {
  const company = await api('POST', '/api/companies', { name: 'Bulk Co' });
  const free = await api('POST', '/api/contacts', { firstName: 'Free', lastName: 'One', email: 'free1@example.com', companyId: company.json.id });
  const tied = await api('POST', '/api/contacts', { firstName: 'Tied', lastName: 'One', email: 'tied1@example.com', companyId: company.json.id });
  await api('POST', '/api/deals', { title: 'Open Deal', amount: 100, contactId: tied.json.id, companyId: company.json.id });

  const res = await api('POST', '/api/contacts/bulk-delete', { ids: [free.json.id, tied.json.id, 'nope'] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.deleted, 1);
  assert.strictEqual(res.json.skipped, 2);
  assert.ok(res.json.errors.some((e) => e.id === tied.json.id && /open deal/.test(e.error)));
  assert.ok(res.json.errors.some((e) => e.id === 'nope'));

  assert.strictEqual((await api('GET', `/api/contacts/${free.json.id}`)).status, 404);
  assert.strictEqual((await api('GET', `/api/contacts/${tied.json.id}`)).status, 200);
});

test('bulk delete companies blocked by deals, unlinks otherwise', async () => {
  const withDeal = await api('POST', '/api/companies', { name: 'Busy Co' });
  await api('POST', '/api/deals', { title: 'D', amount: 1, companyId: withDeal.json.id });
  const plain = await api('POST', '/api/companies', { name: 'Plain Co' });
  const contact = await api('POST', '/api/contacts', { firstName: 'Un', lastName: 'Link', email: 'unlink@example.com', companyId: plain.json.id });

  const res = await api('POST', '/api/companies/bulk-delete', { ids: [withDeal.json.id, plain.json.id] });
  assert.strictEqual(res.json.deleted, 1);
  assert.strictEqual(res.json.skipped, 1);
  assert.ok(res.json.errors.some((e) => e.id === withDeal.json.id));
  assert.strictEqual((await api('GET', `/api/contacts/${contact.json.id}`)).json.companyId, null);
});

test('bulk delete deals and activities', async () => {
  const d1 = await api('POST', '/api/deals', { title: 'Bulk D1', amount: 10 });
  const d2 = await api('POST', '/api/deals', { title: 'Bulk D2', amount: 20 });
  const a1 = await api('POST', '/api/activities', { type: 'note', subject: 'Bulk A1' });
  const a2 = await api('POST', '/api/activities', { type: 'note', subject: 'Bulk A2' });

  const deals = await api('POST', '/api/deals/bulk-delete', { ids: [d1.json.id, d2.json.id] });
  assert.strictEqual(deals.json.deleted, 2);
  const acts = await api('POST', '/api/activities/bulk-delete', { ids: [a1.json.id, a2.json.id] });
  assert.strictEqual(acts.json.deleted, 2);
  assert.strictEqual((await api('GET', `/api/deals/${d1.json.id}`)).status, 404);
  assert.strictEqual((await api('GET', `/api/activities/${a1.json.id}`)).status, 404);
});

test('bulk delete requires auth and ids, and is owner-scoped', async () => {
  const noAuth = await api('POST', '/api/contacts/bulk-delete', { ids: ['x'] }, null);
  assert.strictEqual(noAuth.status, 401);
  const noIds = await api('POST', '/api/deals/bulk-delete', { ids: [] });
  assert.strictEqual(noIds.status, 400);

  const mine = await api('POST', '/api/contacts', { firstName: 'Mine', lastName: 'Only', email: 'mineonly@example.com' });
  const crossUser = await api('POST', '/api/contacts/bulk-delete', { ids: [mine.json.id] }, tokenB);
  assert.strictEqual(crossUser.json.deleted, 0);
  assert.strictEqual(crossUser.json.skipped, 1);
  assert.strictEqual((await api('GET', `/api/contacts/${mine.json.id}`)).status, 200);
});
