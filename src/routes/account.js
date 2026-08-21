'use strict';

const express = require('express');
const { PLANS, PLAN_IDS, getPlan, getPlanId, usage } = require('../plans');

/** JSON-safe limit: Infinity (unlimited) is sent as the string "unlimited". */
function jsonLimit(v) {
  return Number.isFinite(v) ? v : 'unlimited';
}

/**
 * Account & subscription endpoints.
 *
 *   GET  /api/account        → plan, limits, current usage, prices
 *   PUT  /api/account/plan   → switch plan (requires x-admin-key until real
 *                              billing is wired; the Stripe webhook will call
 *                              the same endpoint later)
 */
function accountRouter(db, options = {}) {
  const router = express.Router();
  const adminKey = options.adminKey || '';

  function accountJson(user) {
    const plan = getPlan(user);
    return {
      user: { id: user.id, name: user.name || '', email: user.email, plan: getPlanId(user) },
      plan: {
        id: plan.id, name: plan.name, priceMonthly: plan.priceMonthly,
        limits: {
          contacts: jsonLimit(plan.limits.contacts),
          pipelines: jsonLimit(plan.limits.pipelines),
          customFields: jsonLimit(plan.limits.customFields)
        },
        features: plan.features
      },
      // Every plan, serialized, so the client can render the upgrade UI.
      plans: Object.values(PLANS).map((p) => ({
        id: p.id, name: p.name, priceMonthly: p.priceMonthly,
        limits: {
          contacts: jsonLimit(p.limits.contacts),
          pipelines: jsonLimit(p.limits.pipelines),
          customFields: jsonLimit(p.limits.customFields)
        },
        features: p.features
      })),
      usage: usage(db, user.id),
      prices: Object.fromEntries(Object.entries(PLANS).map(([id, p]) => [id, p.priceMonthly]))
    };
  }

  // GET /api/account — the app UI calls this to render the plan badge.
  router.get('/', (req, res) => res.json(accountJson(req.user)));

  // PUT /api/account/plan — switch plan.
  // Until real billing is wired, switches are OPEN (preview mode). The gate
  // activates automatically once an admin key is configured: if BIZZYBEE_ADMIN_KEY
  // is set, the request must carry it in x-admin-key. The future Stripe webhook
  // will call this same endpoint.
  router.put('/plan', (req, res) => {
    const key = String(req.headers['x-admin-key'] || '');
    if (adminKey && key !== adminKey) {
      return res.status(403).json({ error: 'Admin key required to change plans', code: 'ADMIN_KEY_REQUIRED' });
    }
    const plan = String((req.body || {}).plan || '');
    if (!PLANS[plan]) {
      return res.status(400).json({ error: `Unknown plan "${plan}"`, valid: PLAN_IDS });
    }
    db.update('users', req.user.id, { plan });
    const user = db.get('users', req.user.id);
    res.json(accountJson(user));
  });

  return router;
}

module.exports = accountRouter;
