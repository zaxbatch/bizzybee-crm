'use strict';

const express = require('express');
const { getPlan } = require('../plans');

const FIELD_TYPES = ['text', 'textarea', 'email', 'url', 'phone', 'number', 'date', 'select', 'checkbox'];
const MAX_LABEL = 60;

/** All custom field definitions owned by a user, sorted by creation. */
function defsFor(db, userId) {
  return db.allFor('custom_fields', userId)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * Validate a contact's `custom` values object against the user's field
 * definitions. Returns { ok: true, value } or { ok: false, error }.
 * Values are normalized to strings ('true'/'false' for checkboxes).
 */
function validateCustomValues(db, userId, custom) {
  if (custom === undefined || custom === null) return { ok: true, value: undefined };
  if (typeof custom !== 'object' || Array.isArray(custom)) {
    return { ok: false, error: 'custom must be an object of field values' };
  }
  const byId = new Map(defsFor(db, userId).map((d) => [d.id, d]));
  const cleaned = {};
  for (const [key, raw] of Object.entries(custom)) {
    const def = byId.get(key);
    if (!def) return { ok: false, error: `Unknown custom field "${key}"` };
    if (raw === undefined || raw === null || raw === '') { cleaned[key] = ''; continue; }
    if (def.type === 'checkbox') {
      cleaned[key] = (raw === true || raw === 'true' || raw === 'on') ? 'true' : 'false';
    } else if (def.type === 'number') {
      const n = Number(raw);
      if (Number.isNaN(n)) return { ok: false, error: `Custom field "${def.label}" must be a number` };
      cleaned[key] = String(n);
    } else if (def.type === 'select') {
      const options = Array.isArray(def.options) ? def.options : [];
      if (options.length && !options.includes(String(raw))) {
        return { ok: false, error: `Custom field "${def.label}" must be one of: ${options.join(', ')}` };
      }
      cleaned[key] = String(raw);
    } else if (def.type === 'email') {
      const v = String(raw).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return { ok: false, error: `Custom field "${def.label}" must be a valid email` };
      }
      cleaned[key] = v;
    } else if (def.type === 'url') {
      const v = String(raw).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(v)) {
        return { ok: false, error: `Custom field "${def.label}" must be a valid URL (https://…)` };
      }
      cleaned[key] = v;
    } else if (def.type === 'phone') {
      const v = String(raw).trim();
      if (!/^[+()\-.\d\s]{7,20}$/.test(v)) {
        return { ok: false, error: `Custom field "${def.label}" must be a valid phone number` };
      }
      cleaned[key] = v;
    } else if (def.type === 'textarea') {
      cleaned[key] = String(raw).slice(0, 2000);
    } else {
      cleaned[key] = String(raw).slice(0, 500);
    }
  }
  return { ok: true, value: cleaned };
}

function customfieldsRouter(db) {
  const router = express.Router();

  // GET /api/custom-fields — the account's field definitions.
  router.get('/', (req, res) => res.json(defsFor(db, req.userId)));

  // POST /api/custom-fields — create (plan-gated: Free 0 / Pro 50 / Business ∞).
  router.post('/', (req, res) => {
    const plan = getPlan(req.user);
    const limit = plan.limits.customFields;
    const count = defsFor(db, req.userId).length;
    if (Number.isFinite(limit) && count >= limit) {
      return res.status(403).json({
        error: `Your ${plan.name} plan includes ${limit} custom field${limit === 1 ? '' : 's'}`,
        code: 'PLAN_LIMIT', limit, usage: count, plan: plan.id,
        upgrade: plan.id === 'free' ? 'pro' : null,
      });
    }
    const label = String((req.body || {}).label || '').trim();
    const type = String((req.body || {}).type || 'text');
    if (!label) return res.status(400).json({ error: 'A label is required' });
    if (label.length > MAX_LABEL) return res.status(400).json({ error: `Label must be ${MAX_LABEL} characters or fewer` });
    if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: `Type must be one of: ${FIELD_TYPES.join(', ')}` });

    let options;
    if (type === 'select') {
      const raw = (req.body || {}).options;
      if (!Array.isArray(raw) || !raw.length || raw.some((o) => typeof o !== 'string' || !o.trim())) {
        return res.status(400).json({ error: 'Select fields require a non-empty list of options' });
      }
      options = raw.map((o) => String(o).trim());
    }

    const field = db.insert('custom_fields', { label, type, options, ownerId: req.userId });
    res.status(201).json(field);
  });

  // PUT /api/custom-fields/:id — rename / retype / update options.
  router.put('/:id', (req, res) => {
    const field = db.getFor('custom_fields', req.params.id, req.userId);
    if (!field) return res.status(404).json({ error: 'Custom field not found' });

    const label = String((req.body || {}).label ?? field.label).trim();
    if (!label) return res.status(400).json({ error: 'A label is required' });
    if (label.length > MAX_LABEL) return res.status(400).json({ error: `Label must be ${MAX_LABEL} characters or fewer` });

    const type = String((req.body || {}).type ?? field.type);
    if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: `Type must be one of: ${FIELD_TYPES.join(', ')}` });

    let options = field.options;
    if ((req.body || {}).options !== undefined || type === 'select') {
      const raw = (req.body || {}).options !== undefined ? (req.body || {}).options : field.options;
      if (type === 'select') {
        if (!Array.isArray(raw) || !raw.length || raw.some((o) => typeof o !== 'string' || !o.trim())) {
          return res.status(400).json({ error: 'Select fields require a non-empty list of options' });
        }
        options = raw.map((o) => String(o).trim());
      } else {
        options = undefined;
      }
    }

    res.json(db.update('custom_fields', field.id, { label, type, options }));
  });

  // DELETE /api/custom-fields/:id — remove the field + strip values from contacts.
  router.delete('/:id', (req, res) => {
    const field = db.getFor('custom_fields', req.params.id, req.userId);
    if (!field) return res.status(404).json({ error: 'Custom field not found' });
    db.allFor('contacts', req.userId).forEach((c) => {
      if (c.custom && field.id in c.custom) {
        const next = { ...c.custom };
        delete next[field.id];
        db.update('contacts', c.id, { custom: next });
      }
    });
    db.remove('custom_fields', field.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { customfieldsRouter, defsFor, validateCustomValues, FIELD_TYPES };
