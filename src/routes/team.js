'use strict';

const express = require('express');
const { validatePassword } = require('../validators');
const { getPlan } = require('../plans');
const { hashPassword } = require('../auth');

/**
 * Team management. The account owner creates members who log in with their
 * own email/password and share the owner's workspace (all CRM data, plan,
 * custom fields). Member counts are plan-gated: Free 1 / Pro 5 / Business ∞.
 */

function membersOf(db, ownerId) {
  return db.all('users')
    .filter((u) => u.workspaceOwnerId === ownerId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function teamRouter(db) {
  const router = express.Router();

  const isOwner = (req) => !req.member.workspaceOwnerId;

  // GET /api/team — the workspace's members + plan allowance.
  router.get('/', (req, res) => {
    const members = membersOf(db, req.userId);
    const plan = getPlan(req.user);
    const limit = plan.limits.members;
    res.json({
      members: members.map((u) => ({
        id: u.id, name: u.name || '', email: u.email, role: 'member', createdAt: u.createdAt,
      })),
      limit: Number.isFinite(limit) ? limit : 'unlimited',
      usage: members.length,
      plan: plan.id,
    });
  });

  // POST /api/team/members — owner adds a member (plan-gated).
  router.post('/members', (req, res) => {
    if (!isOwner(req)) {
      return res.status(403).json({ error: 'Only the account owner can add team members' });
    }
    const plan = getPlan(req.user);
    const limit = plan.limits.members;
    const members = membersOf(db, req.userId);
    if (Number.isFinite(limit) && members.length >= limit) {
      return res.status(403).json({
        error: `Your ${plan.name} plan includes ${limit} team member${limit === 1 ? '' : 's'}`,
        code: 'PLAN_LIMIT', limit, usage: members.length, plan: plan.id,
        upgrade: plan.id === 'free' ? 'pro' : null,
      });
    }

    const { name, email, password } = req.body || {};
    const errors = [];
    if (typeof name !== 'string' || !name.trim()) errors.push('Name is required');
    const isEmail = (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
    if (!isEmail(email)) errors.push('A valid email is required');
    const emailTaken = db.all('users').some((u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase());
    if (emailTaken) errors.push('An account with this email already exists');
    const pwErr = validatePassword(password);
    if (pwErr) errors.push(pwErr);
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

    const { salt, hash } = hashPassword(password);
    const member = db.insert('users', {
      name: String(name).trim(),
      email: String(email).trim().toLowerCase(),
      phone: '',
      salt,
      passwordHash: hash,
      workspaceOwnerId: req.userId,
    });
    res.status(201).json({ id: member.id, name: member.name, email: member.email, role: 'member' });
  });

  // DELETE /api/team/members/:id — owner removes a member.
  router.delete('/members/:id', (req, res) => {
    if (!isOwner(req)) {
      return res.status(403).json({ error: 'Only the account owner can remove team members' });
    }
    const member = db.get('users', req.params.id);
    if (!member || member.workspaceOwnerId !== req.userId) {
      return res.status(404).json({ error: 'Team member not found' });
    }
    db.all('sessions').filter((s) => s.userId === member.id).forEach((s) => db.remove('sessions', s.id));
    db.remove('users', member.id);
    res.status(204).end();
  });

  return router;
}

module.exports = teamRouter;
