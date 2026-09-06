'use strict';

/**
 * Team roles & privileges.
 *
 * Conventional role ladder (the account owner is the person who created the
 * workspace — they always keep full access and can never be edited, demoted
 * or removed by anyone):
 *
 *   Admin   — full control (team, roles, subcategories, settings, billing view)
 *   Editor  — day-to-day CRM work (add/edit/delete records, import/export)
 *   Viewer  — view-only access to the workspace data
 *
 * Privileges are action-level toggles (see PERMISSION_GROUPS below). Each role
 * has a default set that an Admin with `manage.permissions` can customize for
 * the whole role AND for individual members (per-user overrides). The owner's
 * own access is always everything and is not editable.
 *
 * Role presets are stored on the OWNER's user record under
 * `workspace.roles[role]` (only the roles that were customized) and custom
 * subcategories under `workspace.subcategories`. A member's own overrides live
 * on the member record as `permissionOverrides`. Members share the owner's
 * workspace (same data, plan and settings), so a member's effective
 * permissions are always resolved against their workspace owner.
 */

const ROLES = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer'
};

/** The roles an admin can assign/inspect in the UI. `owner` is protected. */
const EDITABLE_ROLES = ['admin', 'editor', 'viewer'];

/** Role → one-line description shown in the UI. */
const ROLE_BLURBS = {
  owner: 'Account creator. Full access — cannot be edited, demoted or removed.',
  admin: 'Full control: manage the team, roles, privileges and settings.',
  editor: 'Day-to-day CRM work: add, edit, delete and organize records, import & export.',
  viewer: 'View-only access to the workspace data.'
};

const PERMISSION_GROUPS = [
  {
    id: 'data',
    title: 'CRM data',
    items: [
      { key: 'data.view', label: 'View contacts, companies, deals & activity' },
      { key: 'data.create', label: 'Add contacts, companies, deals & activity' },
      { key: 'data.edit', label: 'Edit records' },
      { key: 'data.delete', label: 'Delete records' }
    ]
  },
  {
    id: 'tools',
    title: 'Data tools',
    items: [
      { key: 'import', label: 'Import from CSV' },
      { key: 'export', label: 'Export to CSV' }
    ]
  },
  {
    id: 'manage',
    title: 'Workspace settings',
    items: [
      { key: 'manage.customFields', label: 'Manage custom fields' },
      { key: 'manage.members', label: 'Invite & manage team members' },
      { key: 'manage.permissions', label: 'Customize roles & member privileges' },
      { key: 'manage.subcategories', label: 'Manage subcategories' }
    ]
  }
];

const PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

const KEY_LABELS = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.items).map((i) => [i.key, i.label]));

/** Express 403 payload for a missing permission (send + return it). */
function denied(res, key) {
  const what = KEY_LABELS[key] ? `“${KEY_LABELS[key]}”` : `"${key}"`;
  return res.status(403).json({
    error: `Permission denied: your role doesn't include ${what}.`,
    code: 'FORBIDDEN',
    required: key
  });
}

function allTruePermissions() {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
}

function basePermissions(keys) {
  const p = allTruePermissions();
  for (const k of PERMISSION_KEYS) if (!keys.includes(k)) p[k] = false;
  return p;
}

/** Default privilege set per role (role presets start here). */
const DEFAULT_PERMISSIONS = {
  owner: allTruePermissions(),
  admin: allTruePermissions(),
  editor: basePermissions(['data.view', 'data.create', 'data.edit', 'data.delete', 'import', 'export']),
  viewer: basePermissions(['data.view'])
};

function normalizeRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role) ? role : (role ? 'editor' : 'editor');
}

/** Owner of the workspace a user belongs to (themselves when they are the owner). */
function workspaceOwner(db, user) {
  if (!user) return null;
  return user.workspaceOwnerId ? db.get('users', user.workspaceOwnerId) : user;
}

/**
 * Effective privilege map for a member: role defaults → workspace role preset
 * (customized by an admin) → this member's personal overrides. The account
 * owner always has everything.
 */
function effectivePermissions(db, user) {
  const all = allTruePermissions();
  if (!user) return all;
  if (!user.workspaceOwnerId) return all; // the owner

  const role = normalizeRole(user.role);
  const owner = workspaceOwner(db, user);
  const preset = (owner && owner.workspace && owner.workspace.roles && owner.workspace.roles[role]) || {};
  const merged = { ...DEFAULT_PERMISSIONS[role] };
  for (const key of PERMISSION_KEYS) {
    if (typeof preset[key] === 'boolean') merged[key] = preset[key];
  }
  if (user.permissionOverrides) {
    for (const key of PERMISSION_KEYS) {
      if (typeof user.permissionOverrides[key] === 'boolean') merged[key] = user.permissionOverrides[key];
    }
  }
  return merged;
}

/** Granted (true) permission keys for a user — what the client sees. */
function grantedKeys(db, user) {
  const map = effectivePermissions(db, user);
  return PERMISSION_KEYS.filter((k) => map[k] === true);
}

function can(db, user, key) {
  return effectivePermissions(db, user)[key] === true;
}

/**
 * Effective set a given role would have in this workspace (defaults merged
 * with the admin's role preset, no per-user overrides). Used to render and
 * edit the role matrix.
 */
function roleEffective(db, owner, role) {
  if (!owner) return {};
  const preset = (owner.workspace && owner.workspace.roles && owner.workspace.roles[role]) || {};
  const merged = { ...(DEFAULT_PERMISSIONS[role] || {}) };
  for (const key of PERMISSION_KEYS) {
    if (typeof preset[key] === 'boolean') merged[key] = preset[key];
  }
  return merged;
}

/**
 * Validate + sanitize an incoming permission map (e.g. a role preset or a
 * per-user override). Only catalog keys and booleans survive.
 */
function sanitizePermissionMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of PERMISSION_KEYS) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}

module.exports = {
  ROLES, EDITABLE_ROLES, ROLE_BLURBS,
  PERMISSION_GROUPS, PERMISSION_KEYS, KEY_LABELS, DEFAULT_PERMISSIONS,
  normalizeRole, effectivePermissions, grantedKeys, can,
  roleEffective, sanitizePermissionMap, denied
};
