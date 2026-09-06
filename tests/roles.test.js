'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-roles-')), 'db.json');
let server;
let base;
let ownerToken;
const tokens = {}; // email → token

const OWNER = { name: 'Priv Owner', email: 'priv-owner@test.dev', password: 'correct horse battery staple' };
const VIEWER = { name: 'Vee Viewer', email: 'vee@test.dev', password: 'correct horse battery staple', role: 'viewer' };
const EDITOR = { name: 'Ed Editor', email: 'ed@test.dev', password: 'correct horse battery staple', role: 'editor' };
const ADMIN = { name: 'Ada Admin', email: 'ada@test.dev', password: 'correct horse battery staple', role: 'admin' };

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
  assert.strictEqual(res.status, 200, `login ${email}`);
  tokens[email] = res.json.token;
  return res.json.user;
}

async function memberId(email) {
  const team = await api('GET', '/api/team', null, ownerToken);
  const row = team.json.members.find((m) => m.email === email);
  assert.ok(row, `member ${email} exists`);
  return row.id;
}

test('Free blocks custom subcategories; Pro allows 2; Business is unlimited', async () => {
  const reg = await api('POST', '/api/auth/register', OWNER);
  assert.strictEqual(reg.status, 201);
  ownerToken = reg.json.token;

  // Free: every account gets the built-ins, but zero custom ones.
  let team = await api('GET', '/api/team', null, ownerToken);
  assert.strictEqual(team.status, 200);
  assert.strictEqual(team.json.subcategories.builtIn.length, 6);
  assert.strictEqual(team.json.subcategories.usage, 0);
  assert.strictEqual(team.json.subcategories.limit, 0);
  const freeAdd = await api('POST', '/api/team/subcategories', { name: 'Renewables' }, ownerToken);
  assert.strictEqual(freeAdd.status, 403);
  assert.strictEqual(freeAdd.json.code, 'PLAN_LIMIT');
  assert.strictEqual(freeAdd.json.upgrade, 'pro');

  // Pro: exactly 2 custom subcategories.
  await api('PUT', '/api/account/plan', { plan: 'pro' }, ownerToken);
  const one = await api('POST', '/api/team/subcategories', { name: 'Renewables' }, ownerToken);
  assert.strictEqual(one.status, 201);
  const two = await api('POST', '/api/team/subcategories', { name: 'Government' }, ownerToken);
  assert.strictEqual(two.status, 201);
  const three = await api('POST', '/api/team/subcategories', { name: 'Partners' }, ownerToken);
  assert.strictEqual(three.status, 403);
  assert.strictEqual(three.json.code, 'PLAN_LIMIT');
  assert.strictEqual(three.json.usage, 2);

  // Business: unlimited custom subcategories.
  const up = await api('PUT', '/api/account/plan', { plan: 'business' }, ownerToken);
  assert.strictEqual(up.status, 200);
  const third = await api('POST', '/api/team/subcategories', { name: 'Partners' }, ownerToken);
  assert.strictEqual(third.status, 201);

  // Names must be unique (built-ins included) and within the length cap.
  const dupBuiltIn = await api('POST', '/api/team/subcategories', { name: 'Sales' }, ownerToken);
  assert.strictEqual(dupBuiltIn.status, 400);
  const dupCustom = await api('POST', '/api/team/subcategories', { name: 'renewables' }, ownerToken);
  assert.strictEqual(dupCustom.status, 400);
  const noName = await api('POST', '/api/team/subcategories', { name: '  ' }, ownerToken);
  assert.strictEqual(noName.status, 400);

  team = await api('GET', '/api/team', null, ownerToken);
  assert.strictEqual(team.json.subcategories.limit, 'unlimited');
  assert.strictEqual(team.json.subcategories.custom.length, 3);

  // Rename a custom subcategory.
  const renewId = team.json.subcategories.custom.find((s) => s.name === 'Renewables').id;
  const renamed = await api('PUT', `/api/team/subcategories/${renewId}`, { name: 'Green Energy' }, ownerToken);
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.json.name, 'Green Energy');

  // Built-ins cannot be renamed or deleted (404 — they're not custom).
  const renameBuiltIn = await api('PUT', '/api/team/subcategories/sales', { name: 'X' }, ownerToken);
  assert.strictEqual(renameBuiltIn.status, 404);
  const delBuiltIn = await api('DELETE', '/api/team/subcategories/sales', null, ownerToken);
  assert.strictEqual(delBuiltIn.status, 404);
});

test('invite members with roles and subcategory assignments', async () => {
  for (const member of [VIEWER, EDITOR, ADMIN]) {
    const body = {
      name: member.name,
      email: member.email,
      password: member.password,
      role: member.role,
      subcategoryId: member.role === 'editor' ? 'sales' : ''
    };
    const add = await api('POST', '/api/team/members', body, ownerToken);
    assert.strictEqual(add.status, 201, `invite ${member.email}`);
    assert.strictEqual(add.json.role, member.role);
    assert.strictEqual(add.json.roleLabel, member.role === 'admin' ? 'Admin' : member.role === 'editor' ? 'Editor' : 'Viewer');
    assert.strictEqual(add.json.subcategoryId, member.role === 'editor' ? 'sales' : '');
  }

  // Invalid role and unknown subcategory are rejected.
  const badRole = await api('POST', '/api/team/members',
    { name: 'X', email: 'bad-role@test.dev', password: 'correct horse battery staple', role: 'superuser' }, ownerToken);
  assert.strictEqual(badRole.status, 400);
  const badSub = await api('POST', '/api/team/members',
    { name: 'X', email: 'bad-sub@test.dev', password: 'correct horse battery staple', subcategoryId: 'nope' }, ownerToken);
  assert.strictEqual(badSub.status, 400);

  const team = await api('GET', '/api/team', null, ownerToken);
  const vee = team.json.members.find((m) => m.email === VIEWER.email);
  const ed = team.json.members.find((m) => m.email === EDITOR.email);
  assert.strictEqual(vee.role, 'viewer');
  assert.strictEqual(ed.subcategoryId, 'sales');
  assert.strictEqual(ed.subcategoryName, 'Sales');
});

test('role defaults: viewer read-only, editor works data but not settings', async () => {
  const vee = await login(VIEWER.email, VIEWER.password);
  assert.deepStrictEqual(vee.permissions, ['data.view'], 'viewer starts with view-only');
  const vTok = tokens[VIEWER.email];

  assert.strictEqual((await api('GET', '/api/contacts', null, vTok)).status, 200);
  const addContact = await api('POST', '/api/contacts', { firstName: 'V', lastName: 'Blocked', email: 'v@blocked.dev' }, vTok);
  assert.strictEqual(addContact.status, 403);
  assert.strictEqual(addContact.json.code, 'FORBIDDEN');
  assert.strictEqual((await raw('GET', '/api/export/contacts.csv', vTok)).status, 403, 'viewer cannot export');
  assert.strictEqual((await api('POST', '/api/import/companies', { csv: 'name\nAcme' }, vTok)).status, 403, 'viewer cannot import');
  assert.strictEqual((await api('POST', '/api/custom-fields', { label: 'Nope', type: 'text' }, vTok)).status, 403, 'viewer cannot manage custom fields');

  const ed = await login(EDITOR.email, EDITOR.password);
  assert.ok(ed.permissions.includes('data.create') && ed.permissions.includes('data.delete'));
  assert.ok(!ed.permissions.includes('manage.members'));
  const eTok = tokens[EDITOR.email];

  const created = await api('POST', '/api/contacts', { firstName: 'Ed', lastName: 'Makes', email: 'ed@makes.dev' }, eTok);
  assert.strictEqual(created.status, 201);
  const del = await api('DELETE', `/api/contacts/${created.json.id}`, null, eTok);
  assert.strictEqual(del.status, 204, 'editor can delete its own records');
  const cf = await api('POST', '/api/custom-fields', { label: 'Dept', type: 'text' }, eTok);
  assert.strictEqual(cf.status, 403, 'editor cannot manage custom fields by default');
  const teamMgmt = await api('PATCH', `/api/team/members/${await memberId(EDITOR.email)}`, { role: 'admin' }, eTok);
  assert.strictEqual(teamMgmt.status, 403, 'editor cannot manage the team');
});

test('role presets: an admin can grant viewer export and strip editor delete', async () => {
  // Editor tries to touch role presets → forbidden (no manage.permissions).
  const eTok = tokens[EDITOR.email];
  const editorEdit = await api('PUT', '/api/team/permissions/roles',
    { role: 'viewer', permissions: { 'data.view': true } }, eTok);
  assert.strictEqual(editorEdit.status, 403);

  // Owner customizes the Viewer role: adds export.
  const grantExport = await api('PUT', '/api/team/permissions/roles',
    { role: 'viewer', permissions: { 'data.view': true, export: true } }, ownerToken);
  assert.strictEqual(grantExport.status, 200);
  assert.strictEqual(grantExport.json.permissions.export, true);

  const vTok = tokens[VIEWER.email];
  const exported = await raw('GET', '/api/export/contacts.csv', vTok);
  assert.strictEqual(exported.status, 200, 'viewer can export once granted');
  assert.match(exported.headers.get('content-type') || '', /text\/csv/);

  // Owner strips Editor's delete permission.
  const stripDelete = await api('PUT', '/api/team/permissions/roles',
    {
      role: 'editor',
      permissions: {
        'data.view': true, 'data.create': true, 'data.edit': true,
        'data.delete': false, import: true, export: true
      }
    }, ownerToken);
  assert.strictEqual(stripDelete.status, 200);
  assert.strictEqual(stripDelete.json.permissions['data.delete'], false);

  const made = await api('POST', '/api/contacts', { firstName: 'Ed', lastName: 'Again', email: 'ed@again.dev' }, eTok);
  assert.strictEqual(made.status, 201);
  const del = await api('DELETE', `/api/contacts/${made.json.id}`, null, eTok);
  assert.strictEqual(del.status, 403, 'editor can no longer delete');
  const edit = await api('PUT', `/api/contacts/${made.json.id}`, { notes: 'still editable' }, eTok);
  assert.strictEqual(edit.status, 200, 'editor can still edit');
});

test('per-user privilege overrides can raise and later restrict a member', async () => {
  const vTok = tokens[VIEWER.email];
  const vId = await memberId(VIEWER.email);

  // The owner grants the viewer the create privilege as a personal override.
  const grant = await api('PUT', `/api/team/members/${vId}/permissions`,
    { permissions: { 'data.create': true } }, ownerToken);
  assert.strictEqual(grant.status, 200);
  const made = await api('POST', '/api/contacts', { firstName: 'Vee', lastName: 'NowWrites', email: 'vee@writes.dev' }, vTok);
  assert.strictEqual(made.status, 201, 'personal override grants create to a viewer');

  // Clearing overrides (empty map) puts the viewer back to read-only.
  const clear = await api('PUT', `/api/team/members/${vId}/permissions`, { permissions: {} }, ownerToken);
  assert.strictEqual(clear.status, 200);
  assert.strictEqual(clear.json.permissionOverrides, null);
  const blocked = await api('POST', '/api/contacts', { firstName: 'Vee', lastName: 'NoMore', email: 'vee@nomore.dev' }, vTok);
  assert.strictEqual(blocked.status, 403);

  // The owner can never be overridden.
  const ownerRow = (await api('GET', '/api/team', null, ownerToken)).json.members.find((m) => m.isOwner);
  const ownerOverride = await api('PUT', `/api/team/members/${ownerRow.id}/permissions`,
    { permissions: { 'data.delete': false } }, ownerToken);
  assert.strictEqual(ownerOverride.status, 403);
  assert.strictEqual(ownerOverride.json.code, 'OWNER_PROTECTED');
});

test('admins manage privileges too, but only the owner edits the Admin preset', async () => {
  const admin = await login(ADMIN.email, ADMIN.password);
  assert.ok(admin.permissions.includes('manage.permissions'));
  assert.ok(admin.permissions.includes('manage.subcategories'));
  const aTok = tokens[ADMIN.email];

  // Admin can create a custom field and a subcategory.
  const cf = await api('POST', '/api/custom-fields', { label: 'Region', type: 'select', options: ['East', 'West'] }, aTok);
  assert.strictEqual(cf.status, 201);
  const sub = await api('POST', '/api/team/subcategories', { name: 'Enterprise' }, aTok);
  assert.strictEqual(sub.status, 201);

  // Admin may customize Editor/Viewer presets but not the Admin preset.
  const editorPreset = await api('PUT', '/api/team/permissions/roles',
    {
      role: 'editor',
      permissions: {
        'data.view': true, 'data.create': true, 'data.edit': true, 'data.delete': true,
        import: true, export: true
      }
    }, aTok);
  assert.strictEqual(editorPreset.status, 200, 'admin can edit the editor preset');
  const adminPreset = await api('PUT', '/api/team/permissions/roles',
    { role: 'admin', permissions: { 'data.view': true } }, aTok);
  assert.strictEqual(adminPreset.status, 403);
  assert.strictEqual(adminPreset.json.code, 'OWNER_ONLY');

  // Admin can grant another member personal overrides.
  const eId = await memberId(EDITOR.email);
  const grant = await api('PUT', `/api/team/members/${eId}/permissions`,
    { permissions: { 'manage.customFields': true } }, aTok);
  assert.strictEqual(grant.status, 200);
  const eTok = tokens[EDITOR.email];
  const cf2 = await api('POST', '/api/custom-fields', { label: 'Tier', type: 'text' }, eTok);
  assert.strictEqual(cf2.status, 201, 'editor now manages custom fields via personal override');

  // A member cannot set a custom subcategory they don't have rights to manage.
  const eAddSub = await api('POST', '/api/team/subcategories', { name: 'SMB' }, eTok);
  assert.strictEqual(eAddSub.status, 403);
});

test('deleting a custom subcategory unassigns its members; role change is instant', async () => {
  const team = await api('GET', '/api/team', null, ownerToken);
  const edRow = team.json.members.find((m) => m.email === EDITOR.email);
  const edId = edRow.id;

  // Move the editor onto the custom "Government" subcategory, then delete it.
  const move = await api('PATCH', `/api/team/members/${edId}`,
    { subcategoryId: team.json.subcategories.custom.find((s) => s.name === 'Government').id }, ownerToken);
  assert.strictEqual(move.status, 200);

  const govId = team.json.subcategories.custom.find((s) => s.name === 'Government').id;
  const del = await api('DELETE', `/api/team/subcategories/${govId}`, null, ownerToken);
  assert.strictEqual(del.status, 204);

  const after = await api('GET', '/api/team', null, ownerToken);
  const edAfter = after.json.members.find((m) => m.email === EDITOR.email);
  assert.strictEqual(edAfter.subcategoryId, '', 'member unassigned when their subcategory is deleted');

  // Demote the admin to viewer → the change is effective immediately.
  const adminRow = after.json.members.find((m) => m.email === ADMIN.email);
  const demote = await api('PATCH', `/api/team/members/${adminRow.id}`, { role: 'viewer' }, ownerToken);
  assert.strictEqual(demote.status, 200);
  const demoted = await api('GET', '/api/auth/me', null, tokens[ADMIN.email]);
  assert.strictEqual(demoted.json.user.role, 'viewer');
  const addSub = await api('POST', '/api/team/subcategories', { name: 'Startups' }, tokens[ADMIN.email]);
  assert.strictEqual(addSub.status, 403, 'demoted admin lost manage.subcategories');
});

/** Raw fetch (CSV responses aren't JSON). */
async function raw(method, url, tok) {
  const headers = {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return fetch(base + url, { method, headers });
}
