'use strict';

const crypto = require('crypto');
const express = require('express');
const { validatePassword } = require('./validators');
const { getPlanId } = require('./plans');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---- Password hashing (Node's built-in scrypt — no extra deps) ------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const hash = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHash, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicUser(user) {
  return {
    id: user.id, name: user.name || '', email: user.email, phone: user.phone || '',
    plan: getPlanId(user), role: user.workspaceOwnerId ? 'member' : 'owner', createdAt: user.createdAt
  };
}

function createSession(db, userId) {
  // Drop expired sessions opportunistically so the store does not grow forever.
  db.all('sessions').filter((s) => new Date(s.expiresAt) <= new Date()).forEach((s) => db.remove('sessions', s.id));
  const token = newToken();
  db.insert('sessions', { token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  return token;
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Middleware: requires a valid, unexpired session token and attaches
 * req.userId / req.user for downstream routes.
 *
 * Team members share the owner's workspace: data scoping (req.userId), the
 * plan, and the workspace identity (req.user) all resolve to the owner;
 * req.member is the person who actually logged in (for display).
 */
function requireAuth(db) {
  return (req, res, next) => {
    const token = bearerToken(req);
    const session = token
      ? db.all('sessions').find((s) => s.token === token && new Date(s.expiresAt) > new Date())
      : null;
    const user = session ? db.get('users', session.userId) : null;
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    const owner = user.workspaceOwnerId ? db.get('users', user.workspaceOwnerId) : user;
    if (!owner) return res.status(401).json({ error: 'Workspace no longer exists' });
    req.member = user;
    req.userId = owner.id;
    req.user = owner;
    next();
  };
}

// ---- Routes ---------------------------------------------------------------

function authRouter(db, hubspot) {
  const router = express.Router();

  const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  const emailTaken = (email) => db.all('users').some((u) => u.email.toLowerCase() === email);

  // POST /api/auth/register — create account, return a session token.
  router.post('/register', (req, res) => {
    const { name, email, password, phone } = req.body || {};
    const errors = [];
    if (typeof name !== 'string' || !name.trim()) errors.push('Name is required');
    if (!isEmail(email)) errors.push('A valid email is required');
    if (email && isEmail(email) && emailTaken(email.trim().toLowerCase())) errors.push('An account with this email already exists');
    const pwErr = validatePassword(password);
    if (pwErr) errors.push(pwErr);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const { salt, hash } = hashPassword(password);
    const user = db.insert('users', {
      name: String(name || '').trim(),
      email: email.trim().toLowerCase(),
      phone: String(phone || '').trim(),
      salt,
      passwordHash: hash,
      plan: 'free'
    });
    const token = createSession(db, user.id);

    // Push the sign-up to the Z Dot LLC HubSpot portal (fire-and-forget —
    // a HubSpot hiccup must never block account creation).
    if (hubspot) {
      hubspot.createContact({
        name: user.name,
        email: user.email,
        phone: user.phone,
        source: 'bizzybee-crm-signup'
      }).catch((err) => console.error('[hubspot] signup sync failed:', err && err.message));
    }

    res.status(201).json({ token, user: publicUser(user) });
  });

  // POST /api/auth/login — verify credentials, return a session token.
  router.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = email && isEmail(email)
      ? db.all('users').find((u) => u.email.toLowerCase() === email.trim().toLowerCase())
      : null;
    if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = createSession(db, user.id);
    res.json({ token, user: publicUser(user) });
  });

  // GET /api/auth/me — current user (used by the UI on page load).
  router.get('/me', requireAuth(db), (req, res) => res.json({ user: publicUser(req.member || req.user) }));

  // POST /api/auth/logout — invalidate the current session token.
  router.post('/logout', requireAuth(db), (req, res) => {
    const token = bearerToken(req);
    const session = token ? db.all('sessions').find((s) => s.token === token) : null;
    if (session) db.remove('sessions', session.id);
    res.status(204).end();
  });

  // POST /api/auth/forgot — request a password reset.
  // No mail server is configured, so the reset token is returned directly in
  // the response (dev mode). Swap this for an emailed link in production.
  router.post('/forgot', (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'A valid email is required' });
    const user = db.all('users').find((u) => u.email.toLowerCase() === email);
    if (!user) {
      // Never reveal whether the account exists.
      return res.json({ ok: true, note: 'If an account exists for that email, a reset token has been generated.' });
    }
    const token = newToken();
    db.insert('resets', { token, userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(), used: false });
    res.json({
      ok: true,
      resetToken: token,
      expiresInMinutes: RESET_TTL_MS / 60000,
      devNote: 'No mailer configured — this token would normally be emailed. Use it with POST /api/auth/reset.'
    });
  });

  // POST /api/auth/reset — set a new password with a reset token.
  router.post('/reset', (req, res) => {
    const { token, password } = req.body || {};
    const reset = token
      ? db.all('resets').find((r) => r.token === token && !r.used && new Date(r.expiresAt) > new Date())
      : null;
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const { salt, hash } = hashPassword(password);
    db.update('users', reset.userId, { salt, passwordHash: hash });
    // Invalidate every session for this user and burn the reset token.
    db.all('sessions').filter((s) => s.userId === reset.userId).forEach((s) => db.remove('sessions', s.id));
    db.update('resets', reset.id, { used: true });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { authRouter, requireAuth, hashPassword };
