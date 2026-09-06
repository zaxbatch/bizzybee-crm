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
let memberTokens = {}; // email → token

const OWNER = { name: 'Team Owner', email: 'owner@team.dev', password: 'correct horse battery staple' };
const M1 = { name: 'Pat Team', email: 'pat@team.dev', password: 'correct horse battery staple' };
const M2 = { name: 'Sam Team', email: 'sam@team.dev', password: 'another solid pass' };
const M3 = { name: 'Alex Team', email: 'alex@team.dev', password: 'third solid pass' };
const M4 = { name: 'Rae Team', email: 'rae@team.dev', password: 'fourth solid pass' };
const M5 = { name: 'Jo Team', email: 'jo@team.dev', password: 'fifth solid pass' };

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

async function login(email, password) {
  const res = await api('POST', '/api/auth/login', { email, password });
  assert.strictEqual(res.status, 200, `login for ${email} should work`);
  memberTokens[email] = res.json.token;
  return res.json;
}

test('Free: 1 seat (owner only) — the team list is just the owner and adding is blocked', async () => {
  const reg = await api('POST', '/api/auth/register', OWNER);
  assert.strictEqual(reg.status, 201);
  assert.strictEqual(reg.json.user.role, 'owner');
  assert.ok(reg.json.user.permissions.includes('manage.members'), 'owner has full permissions');
  ownerToken = reg.json.token;

  const team = await api('GET', '/api/team', null, ownerToken);
  assert.strictEqual(team.status, 200);
  assert.deepStrictEqual(team.json.seats, { limit: 1, usage: 1 });
  assert.strictEqual(team.json.members.length, 1);
  const ownerRow = team.json.members[0];
  assert.strictEqual(ownerRow.role, 'owner');
  assert.strictEqual(ownerRow.isOwner, true);
  assert.strictEqual(team.json.current.role, 'owner');
  assert.strictEqual(team.json.current.isOwner, true);

  const acct = await api('GET', '/api/account', null, ownerToken);
  assert.strictEqual(acct.json.usage.seats, 1);

  // Free = no teams: adding anyone is a PLAN_LIMIT with an upgrade hint.
  const add = await api('POST', '/api/team/members', M1, ownerToken);
  assert.strictEqual(add.status, 403);
  assert.strictEqual(add.json.code, 'PLAN_LIMIT');
  assert.strictEqual(add.json.upgrade, 'pro');
});

test('Pro: seats include the owner — 4 members fit, the 5th blocks (PLAN_LIMIT)', async () => {
  const up = await api('PUT', '/api/account/plan', { plan: 'pro' }, ownerToken);
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.json.plan.limits.seats, 5);

  for (const member of [M1, M2, M3, M4]) {
    const add = await api('POST', '/api/team/members', member, ownerToken);
    assert.strictEqual(add.status, 201, `adding ${member.email} should succeed`);
    assert.strictEqual(add.json.role, 'editor', 'members default to the editor role');
  }
  const team = await api('GET', '/api/team', null, ownerToken);
  assert.deepStrictEqual(team.json.seats, { limit: 5, usage: 5 });

  // Seat 5 is taken by the owner + 4 members: one more is a PLAN_LIMIT.
  const blocked = await api('POST', '/api/team/members', M5, ownerToken);
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.json.code, 'PLAN_LIMIT');
  assert.strictEqual(blocked.json.usage, 5);
});

test('an Editor member shares the workspace but cannot manage the team or billing', async () => {
  const user = await login(M1.email, M1.password);
  assert.strictEqual(user.user.role, 'editor');
  assert.ok(user.user.permissions.includes('data.create'));
  assert.ok(!user.user.permissions.includes('manage.members'));

  const token = memberTokens[M1.email];

  // Team list is readable; seats/usage come from the shared workspace.
  const team = await api('GET', '/api/team', null, token);
  assert.strictEqual(team.status, 200);
  assert.strictEqual(team.json.seats.usage, 5);

  // Data work is allowed (default editor privileges).
  const created = await api('POST', '/api/contacts', { firstName: 'Grace', lastName: 'Hopper', email: 'grace@team.dev' }, token);
  assert.strictEqual(created.status, 201);
  const ownerContacts = await api('GET', '/api/contacts', null, ownerToken);
  assert.strictEqual(ownerContacts.json.length, 1);

  // Team management & plan switching are not.
  const add = await api('POST', '/api/team/members', M5, token);
  assert.strictEqual(add.status, 403);
  assert.strictEqual(add.json.code, 'FORBIDDEN');
  const del = await api('DELETE', `/api/team/members/${team.json.members.find((m) => m.email === M2.email).id}`, null, token);
  assert.strictEqual(del.status, 403);
  const plan = await api('PUT', '/api/account/plan', { plan: 'business' }, token);
  assert.strictEqual(plan.status, 403);
  assert.strictEqual(plan.json.code, 'OWNER_ONLY');
});

test('an Admin member manages the team: change roles, add, remove, self-remove guard', async () => {
  // Owner promotes Pat (M1) to Admin.
  const promote = await api('PATCH', `/api/team/members/${(await api('GET', '/api/team', null, ownerToken)).json.members.find((m) => m.email === M1.email).id}`,
    { role: 'admin' }, ownerToken);
  assert.strictEqual(promote.status, 200);
  assert.strictEqual(promote.json.role, 'admin');

  const adminTok = memberTokens[M1.email];
  const me = await api('GET', '/api/auth/me', null, adminTok);
  assert.strictEqual(me.json.user.role, 'admin');
  assert.ok(me.json.user.permissions.includes('manage.members'));

  // Admin can add a member (frees a seat by removing Rae first).
  const list = await api('GET', '/api/team', null, adminTok);
  const raeId = list.json.members.find((m) => m.email === M4.email).id;
  const rm = await api('DELETE', `/api/team/members/${raeId}`, null, adminTok);
  assert.strictEqual(rm.status, 204);

  const add = await api('POST', '/api/team/members', { ...M5, role: 'viewer' }, adminTok);
  assert.strictEqual(add.status, 201);
  assert.strictEqual(add.json.role, 'viewer');

  // Owner is protected from admins.
  const ownerId = list.json.members.find((m) => m.isOwner).id;
  const patchOwner = await api('PATCH', `/api/team/members/${ownerId}`, { role: 'viewer' }, adminTok);
  assert.strictEqual(patchOwner.status, 403);
  assert.strictEqual(patchOwner.json.code, 'OWNER_PROTECTED');
  const delOwner = await api('DELETE', `/api/team/members/${ownerId}`, null, adminTok);
  assert.strictEqual(delOwner.status, 403);

  // Admins cannot remove themselves.
  const selfId = list.json.members.find((m) => m.email === M1.email).id;
  const delSelf = await api('DELETE', `/api/team/members/${selfId}`, null, adminTok);
  assert.strictEqual(delSelf.status, 403);
  assert.strictEqual(delSelf.json.code, 'SELF_REMOVE');
});

test('a Viewer is strictly read-only; removing them kills their session', async () => {
  await login(M5.email, M5.password); // Jo was invited as viewer
  const viewerTok = memberTokens[M5.email];

  const view = await api('GET', '/api/contacts', null, viewerTok);
  assert.strictEqual(view.status, 200);

  const denied = await api('POST', '/api/contacts', { firstName: 'No', lastName: 'Write', email: 'no@write.dev' }, viewerTok);
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.json.code, 'FORBIDDEN');

  const del = await api('DELETE', `/api/contacts/${view.json[0].id}`, null, viewerTok);
  assert.strictEqual(del.status, 403);

  // Owner removes Jo — her session dies.
  const team = await api('GET', '/api/team', null, ownerToken);
  const joId = team.json.members.find((m) => m.email === M5.email).id;
  const rm = await api('DELETE', `/api/team/members/${joId}`, null, ownerToken);
  assert.strictEqual(rm.status, 204);

  const after = await api('GET', '/api/contacts', null, viewerTok);
  assert.strictEqual(after.status, 401);
});
