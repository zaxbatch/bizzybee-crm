'use strict';

const crypto = require('crypto');
const express = require('express');
const { validatePassword } = require('../validators');
const { getPlan } = require('../plans');
const { hashPassword } = require('../auth');
const {
  ROLES, EDITABLE_ROLES, ROLE_BLURBS, PERMISSION_KEYS, PERMISSION_GROUPS,
  roleEffective, sanitizePermissionMap, denied
} = require('../permissions');

/**
 * Team management.
 *
 * Seats: a seat is one user of the workspace INCLUDING the account owner, so
 * the plan caps the whole team (Free 1 → owner only, Pro 5, Business 7,500).
 *
 * Roles: Admin / Editor / Viewer (Owner = the account creator, protected).
 * Privileges are action-level toggles; a user with `manage.permissions` can
 * customize them per role and per individual member. Role presets and custom
 * subcategories are stored on the owner's workspace record
 * (`owner.workspace.{roles,subcategories}`), personal overrides on the member
 * (`member.permissionOverrides`).
 *
 * Every action here checks the ACTING user's effective permissions (req.perms)
 * — team features are no longer owner-only; admins can manage the team too.
 */

/** Built-in subcategories available to every plan (custom ones are plan-gated). */
const BUILTIN_SUBCATEGORIES = [
  { id: 'sales', name: 'Sales' },
  { id: 'marketing', name: 'Marketing' },
  { id: 'hr', name: 'HR' },
  { id: 'finance', name: 'Finance' },
  { id: 'support', name: 'Support' },
  { id: 'operations', name: 'Operations' }
];

const MAX_SUBCATEGORY_NAME = 40;

/** Users of a workspace: the owner first, then members by join date. */
function workspaceUsers(db, ownerId) {
  const owner = db.get('users', ownerId);
  const members = db.all('users')
    .filter((u) => u.workspaceOwnerId === ownerId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return owner ? [owner, ...members] : members;
}

/** Custom (workspace-created) subcategories stored on the owner's record. */
function customSubcategories(owner) {
  return (owner && owner.workspace && Array.isArray(owner.workspace.subcategories)) ? owner.workspace.subcategories : [];
}

function allSubcategories(owner) {
  return [...BUILTIN_SUBCATEGORIES, ...customSubcategories(owner)];
}

function findSubcategory(owner, id) {
  return allSubcategories(owner).find((s) => s.id === id) || null;
}

function writeWorkspace(db, owner, patch) {
  return db.update('users', owner.id, { workspace: { ...(owner.workspace || {}), ...patch } });
}

function roleOf(u) {
  return u.workspaceOwnerId ? (EDITABLE_ROLES.includes(u.role) ? u.role : 'editor') : 'owner';
}

/** Member summary for the team list (role label + subcategory resolved). */
function memberJson(db, owner, u, includeOverrides) {
  const role = roleOf(u);
  const sub = u.subcategoryId ? findSubcategory(owner, u.subcategoryId) : null;
  const json = {
    id: u.id,
    name: u.name || '',
    email: u.email,
    role,
    roleLabel: ROLES[role] || role,
    subcategoryId: u.subcategoryId || '',
    subcategoryName: sub ? sub.name : '',
    createdAt: u.createdAt,
    isOwner: !u.workspaceOwnerId
  };
  if (includeOverrides) {
    json.permissionOverrides = (u.permissionOverrides && Object.keys(u.permissionOverrides).length)
      ? u.permissionOverrides
      : null;
  }
  return json;
}

/** Name checks shared by create + rename (unique against built-ins too). */
function subcategoryNameError(owner, name, exceptId) {
  if (!name) return 'A name is required';
  if (name.length > MAX_SUBCATEGORY_NAME) return `Name must be ${MAX_SUBCATEGORY_NAME} characters or fewer`;
  const key = name.toLowerCase();
  const clash = allSubcategories(owner).find((s) => s.id !== exceptId && s.name.toLowerCase() === key);
  if (clash) return `"${name}" already exists`;
  return null;
}

function teamRouter(db) {
  const router = express.Router();

  const isOwnerMember = (req) => !req.member.workspaceOwnerId;
  // JSON-safe limit: Infinity (Business custom subcategories) → "unlimited".
  const jsonLimit = (v) => (Number.isFinite(v) ? v : 'unlimited');

  // GET /api/team — workspace directory + seats + roles + subcategories.
  router.get('/', (req, res) => {
    const owner = req.user;
    const plan = getPlan(owner);
    const users = workspaceUsers(db, owner.id);
    const canSeeOverrides = req.perms['manage.permissions'] === true;
    const seatLimit = plan.limits.seats;
    const customLimit = plan.limits.subcategories;

    res.json({
      seats: { limit: jsonLimit(seatLimit), usage: users.length },
      members: users.map((u) => memberJson(db, owner, u, canSeeOverrides)),
      roles: EDITABLE_ROLES.map((id) => ({
        id,
        label: ROLES[id],
        blurb: ROLE_BLURBS[id] || '',
        permissions: roleEffective(db, owner, id)
      })),
      catalog: PERMISSION_GROUPS.map((g) => ({
        id: g.id,
        title: g.title,
        items: g.items.map((i) => ({ key: i.key, label: i.label }))
      })),
      subcategories: {
        builtIn: BUILTIN_SUBCATEGORIES,
        custom: customSubcategories(owner),
        limit: jsonLimit(customLimit),
        usage: customSubcategories(owner).length
      },
      current: {
        id: req.member.id,
        role: roleOf(req.member),
        roleLabel: ROLES[roleOf(req.member)],
        isOwner: isOwnerMember(req),
        permissions: PERMISSION_KEYS.filter((k) => req.perms[k] === true)
      },
      can: {
        members: req.perms['manage.members'] === true,
        permissions: req.perms['manage.permissions'] === true,
        subcategories: req.perms['manage.subcategories'] === true
      },
      plan: { id: plan.id, name: plan.name }
    });
  });

  // POST /api/team/members — add a member (seat + plan gated).
  router.post('/members', (req, res) => {
    if (req.perms['manage.members'] !== true) return denied(res, 'manage.members');
    const owner = req.user;
    const plan = getPlan(owner);
    const seatLimit = plan.limits.seats;
    const users = workspaceUsers(db, owner.id);
    if (users.length >= seatLimit) {
      const freeMsg = plan.id === 'free'
        ? 'Free workspaces are for 1 person. Upgrade to Pro for 5 seats — or Business for up to 7,500 — to invite teammates.'
        : `Your ${plan.name} plan includes ${seatLimit.toLocaleString()} seats and you're at ${users.length}.`;
      return res.status(403).json({
        error: freeMsg,
        code: 'PLAN_LIMIT', limit: seatLimit, usage: users.length, plan: plan.id,
        upgrade: plan.id === 'free' ? 'pro' : null,
      });
    }

    const body = req.body || {};
    const errors = [];
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('Name is required');
    const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
    if (!isEmail(body.email)) errors.push('A valid email is required');
    const emailTaken = db.all('users').some((u) => u.email.toLowerCase() === String(body.email || '').trim().toLowerCase());
    if (emailTaken) errors.push('An account with this email already exists');
    const pwErr = validatePassword(body.password);
    if (pwErr) errors.push(pwErr);
    if (body.role && !EDITABLE_ROLES.includes(body.role)) errors.push(`Role must be one of: ${EDITABLE_ROLES.join(', ')}`);
    let subcategoryId = '';
    if (body.subcategoryId) {
      const sub = findSubcategory(owner, body.subcategoryId);
      if (!sub) errors.push('That subcategory does not exist');
      else subcategoryId = sub.id;
    }
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const role = EDITABLE_ROLES.includes(body.role) ? body.role : 'editor';
    const { salt, hash } = hashPassword(body.password);
    const member = db.insert('users', {
      name: String(body.name).trim(),
      email: String(body.email).trim().toLowerCase(),
      phone: '',
      salt,
      passwordHash: hash,
      workspaceOwnerId: owner.id,
      role,
      subcategoryId
    });
    res.status(201).json({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      roleLabel: ROLES[member.role],
      subcategoryId: member.subcategoryId || '',
      seats: { usage: users.length + 1, limit: seatLimit }
    });
  });

  // PATCH /api/team/members/:id — rename, change role or subcategory.
  router.patch('/members/:id', (req, res) => {
    if (req.perms['manage.members'] !== true) return denied(res, 'manage.members');
    const owner = req.user;
    const target = db.get('users', req.params.id);
    if (!target) return res.status(404).json({ error: 'Team member not found' });
    if (!target.workspaceOwnerId) {
      // The account owner is protected — from everyone, including themselves.
      if (target.id !== owner.id) return res.status(404).json({ error: 'Team member not found' });
      return res.status(403).json({ error: 'The account owner cannot be edited', code: 'OWNER_PROTECTED' });
    }
    if (target.workspaceOwnerId !== owner.id) return res.status(404).json({ error: 'Team member not found' });
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name is required' });
      patch.name = name;
    }
    if (body.role !== undefined) {
      if (!EDITABLE_ROLES.includes(body.role)) {
        return res.status(400).json({ error: `Role must be one of: ${EDITABLE_ROLES.join(', ')}` });
      }
      patch.role = body.role;
    }
    if (body.subcategoryId !== undefined) {
      const subId = body.subcategoryId ? String(body.subcategoryId) : '';
      if (subId && !findSubcategory(owner, subId)) {
        return res.status(400).json({ error: 'That subcategory does not exist' });
      }
      patch.subcategoryId = subId;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    const updated = db.update('users', target.id, patch);
    const sub = updated.subcategoryId ? findSubcategory(owner, updated.subcategoryId) : null;
    res.json({
      id: updated.id,
      name: updated.name,
      role: updated.role,
      roleLabel: ROLES[updated.role],
      subcategoryId: updated.subcategoryId || '',
      subcategoryName: sub ? sub.name : ''
    });
  });

  // PUT /api/team/members/:id/permissions — per-user privilege overrides.
  router.put('/members/:id/permissions', (req, res) => {
    if (req.perms['manage.permissions'] !== true) return denied(res, 'manage.permissions');
    const owner = req.user;
    const target = db.get('users', req.params.id);
    if (!target) return res.status(404).json({ error: 'Team member not found' });
    if (!target.workspaceOwnerId) {
      if (target.id !== owner.id) return res.status(404).json({ error: 'Team member not found' });
      return res.status(403).json({ error: 'The account owner always has full access', code: 'OWNER_PROTECTED' });
    }
    if (target.workspaceOwnerId !== owner.id) return res.status(404).json({ error: 'Team member not found' });
    const overrides = sanitizePermissionMap((req.body || {}).permissions);
    const patch = { permissionOverrides: Object.keys(overrides).length ? overrides : null };
    db.update('users', target.id, patch);
    res.json({ id: target.id, permissionOverrides: patch.permissionOverrides });
  });

  // PUT /api/team/permissions/roles — customize a role's default privileges.
  router.put('/permissions/roles', (req, res) => {
    if (req.perms['manage.permissions'] !== true) return denied(res, 'manage.permissions');
    const owner = req.user;
    const role = String((req.body || {}).role || '');
    if (!EDITABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${EDITABLE_ROLES.join(', ')}` });
    }
    // Only the owner may change what Admins can do — otherwise one admin could
    // strip another admin's ability to fix the workspace.
    if (role === 'admin' && !isOwnerMember(req)) {
      return res.status(403).json({ error: 'Only the account owner can change Admin privileges', code: 'OWNER_ONLY' });
    }
    const preset = sanitizePermissionMap((req.body || {}).permissions);
    if (!Object.keys(preset).length) {
      return res.status(400).json({ error: 'permissions must include at least one toggle' });
    }
    const roles = { ...(owner.workspace && owner.workspace.roles ? owner.workspace.roles : {}) };
    roles[role] = preset;
    writeWorkspace(db, owner, { roles });
    res.json({ role, permissions: roleEffective(db, db.get('users', owner.id), role) });
  });

  // DELETE /api/team/members/:id — remove a member.
  router.delete('/members/:id', (req, res) => {
    if (req.perms['manage.members'] !== true) return denied(res, 'manage.members');
    const owner = req.user;
    const target = db.get('users', req.params.id);
    if (!target) return res.status(404).json({ error: 'Team member not found' });
    if (!target.workspaceOwnerId) {
      if (target.id !== owner.id) return res.status(404).json({ error: 'Team member not found' });
      return res.status(403).json({ error: 'The account owner cannot be removed', code: 'OWNER_PROTECTED' });
    }
    if (target.workspaceOwnerId !== owner.id) return res.status(404).json({ error: 'Team member not found' });
    if (target.id === req.member.id) {
      return res.status(403).json({ error: 'You cannot remove yourself — ask another admin', code: 'SELF_REMOVE' });
    }
    db.all('sessions').filter((s) => s.userId === target.id).forEach((s) => db.remove('sessions', s.id));
    db.remove('users', target.id);
    res.status(204).end();
  });

  // POST /api/team/subcategories — create a custom subcategory (plan-gated).
  router.post('/subcategories', (req, res) => {
    if (req.perms['manage.subcategories'] !== true) return denied(res, 'manage.subcategories');
    const owner = req.user;
    const plan = getPlan(owner);
    const limit = plan.limits.subcategories;
    const custom = customSubcategories(owner);
    if (custom.length >= limit) {
      const freeMsg = plan.id === 'free'
        ? 'Subcategories are a paid feature — Pro includes 2 custom ones, Business gets unlimited.'
        : `Your ${plan.name} plan includes ${limit} custom subcategor${limit === 1 ? 'y' : 'ies'}.`;
      return res.status(403).json({
        error: freeMsg, code: 'PLAN_LIMIT', limit, usage: custom.length, plan: plan.id,
        upgrade: plan.id === 'free' ? 'pro' : null,
      });
    }
    const name = String((req.body || {}).name || '').trim();
    const nameErr = subcategoryNameError(owner, name, null);
    if (nameErr) return res.status(400).json({ error: nameErr });
    const sub = { id: crypto.randomUUID(), name };
    writeWorkspace(db, owner, { subcategories: [...custom, sub] });
    res.status(201).json({ id: sub.id, name: sub.name, builtIn: false });
  });

  // PUT /api/team/subcategories/:id — rename a custom subcategory.
  router.put('/subcategories/:id', (req, res) => {
    if (req.perms['manage.subcategories'] !== true) return denied(res, 'manage.subcategories');
    const owner = req.user;
    const custom = customSubcategories(owner);
    const existing = custom.find((s) => s.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Custom subcategory not found' });
    const name = String((req.body || {}).name || '').trim();
    const nameErr = subcategoryNameError(owner, name, existing.id);
    if (nameErr) return res.status(400).json({ error: nameErr });
    const next = custom.map((s) => (s.id === existing.id ? { ...s, name } : s));
    writeWorkspace(db, owner, { subcategories: next });
    res.json({ id: existing.id, name, builtIn: false });
  });

  // DELETE /api/team/subcategories/:id — remove a custom subcategory.
  router.delete('/subcategories/:id', (req, res) => {
    if (req.perms['manage.subcategories'] !== true) return denied(res, 'manage.subcategories');
    const owner = req.user;
    const custom = customSubcategories(owner);
    if (!custom.some((s) => s.id === req.params.id)) {
      return res.status(404).json({ error: 'Custom subcategory not found' });
    }
    const next = custom.filter((s) => s.id !== req.params.id);
    writeWorkspace(db, owner, { subcategories: next });
    // Un-assign members who were in the removed subcategory.
    db.all('users')
      .filter((u) => u.workspaceOwnerId === owner.id && u.subcategoryId === req.params.id)
      .forEach((u) => db.update('users', u.id, { subcategoryId: '' }));
    res.status(204).end();
  });

  return router;
}

module.exports = teamRouter;
module.exports.BUILTIN_SUBCATEGORIES = BUILTIN_SUBCATEGORIES;
