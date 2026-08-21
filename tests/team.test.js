'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-team-')), 'db.json');
let server;
let base;
let ownerToken;
let member1Token;
let member2Token;

const MEMBER1 = { name: 'Pat Team', email: 'pat@team.dev', password: 'correct horse battery staple' };
const MEMBER2 = { name: 'Sam Team', email: 'sam@team.dev', password: 'another solid pass' };

before(async () => {
  const app = createApp({ dataFile: tmpFile, log: false, hubspot: false });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
});

async function api(method, url, body, tok, headers = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (tok) h.Authorization = `Bearer ${tok}`;
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('owner on Free sees 0 members with a limit of 1', async () => {
  const reg = await api('POST', '/api/auth/register', { name: 'Team Owner', email: 'owner@team.dev', password: 'correct horse battery staple' });
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.json.user.role, 'owner');
  ownerToken = reg.json.token;

  const { status, json } = await api('GET', '/api/team', null, ownerToken);
  assert.strictEqual(status, 200);
  assert.strictEqual(json.members.length, 0);
  assert.strictEqual(json.limit, 1);
});

test('Free plan allows 1 member, blocks the second (PLAN_LIMIT)', async () => {
  const one = await api('POST', '/api/team/members', MEMBER1, ownerToken);
  assert.strictEqual(one.status, 201);
  assert.strictEqual(one.json.role, 'member');

  const two = await api('POST', '/api/team/members', MEMBER2, ownerToken);
  assert.strictEqual(two.status, 403);
  assert.strictEqual(two.json.code, 'PLAN_LIMIT');
  assert.strictEqual(two.json.limit, 1);

  const acct = await api('GET', '/api/account', null, ownerToken);
  assert.strictEqual(acct.json.usage.members, 1);
});

test('member logs in, shares the workspace, and cannot manage the team', async () => {
  const login = await api('POST', '/api/auth/login', { email: MEMBER1.email, password: MEMBER1.password });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.json.user.role, 'member');
  member1Token = login.json.token;

  // Shared workspace: member sees the same (empty) contacts as the owner.
  const contacts = await api('GET', '/api/contacts', null, member1Token);
  assert.strictEqual(contacts.status, 200);
  assert.deepStrictEqual(contacts.json, []);

  // Member can add data to the shared workspace.
  const created = await api('POST', '/api/contacts', { firstName: 'Grace', lastName: 'Hopper', email: 'grace@team.dev' }, member1Token);
  assert.strictEqual(created.status, 201);

  // Owner sees the member's contact.
  const ownerContacts = await api('GET', '/api/contacts', null, ownerToken);
  assert.strictEqual(ownerContacts.json.length, 1);
  assert.strictEqual(ownerContacts.json[0].email, 'grace@team.dev');

  // Member cannot add/remove members.
  const add = await api('POST', '/api/team/members', MEMBER2, member1Token);
  assert.strictEqual(add.status, 403);
  const del = await api('DELETE', '/api/team/members/' + (await api('GET', '/api/team', null, member1Token)).json.members[0].id, null, member1Token);
  assert.strictEqual(del.status, 403);

  // Member can view the team list.
  const team = await api('GET', '/api/team', null, member1Token);
  assert.strictEqual(team.status, 200);
  assert.strictEqual(team.json.members.length, 1);
});

test('Pro plan allows more members; owner can remove one', async () => {
  await api('PUT', '/api/account/plan', { plan: 'pro' }, ownerToken);
  const two = await api('POST', '/api/team/members', MEMBER2, ownerToken);
  assert.strictEqual(two.status, 201);

  const members = (await api('GET', '/api/team', null, ownerToken)).json.members;
  assert.strictEqual(members.length, 2);

  // Remove member 2 — their session dies and login is rejected.
  const m2 = members.find((m) => m.email === MEMBER2.email);
  const login2 = await api('POST', '/api/auth/login', { email: MEMBER2.email, password: MEMBER2.password });
  assert.strictEqual(login2.status, 200);
  const m2Token = login2.json.token;

  const del = await api('DELETE', `/api/team/members/${m2.id}`, null, ownerToken);
  assert.strictEqual(del.status, 204);

  const after = await api('GET', '/api/team', null, ownerToken);
  assert.strictEqual(after.json.members.length, 1);

  const deadSession = await api('GET', '/api/contacts', null, m2Token);
  assert.strictEqual(deadSession.status, 401);
});
