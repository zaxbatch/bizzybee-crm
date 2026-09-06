'use strict';

/**
 * BizzyBee CRM — subscription plans (Z Dot LLC pricing strategy).
 *
 *   Free                Pro ($19/mo)              Business ($49/mo)
 *   Contacts: 1,000     Unlimited                 Unlimited
 *   Pipelines: 5        20                        Unlimited
 *   Custom fields: 0    50                        Unlimited
 *   Seats: 1 (you)      5                         7,500
 *   Roles & permissions no (solo)                 Admin / Editor / Viewer with customizable privileges
 *   Custom subcategories 0                        2                         Unlimited
 *   Reyna (AI): no       300 credits/mo           5,000 credits/mo
 *   API: no             yes                       full access
 *   White-label: no     no                        yes (rebrand + custom domain)
 *   Priority support: no                          yes (1–4h, dedicated queue)
 *   Workflow: none      basic                     advanced
 *   Reports: basic      custom                    advanced + AI insights
 *
 * A "seat" is one user of the workspace, INCLUDING the account owner, so the
 * Free plan (1 seat) is owner-only — there are no teams on Free. Pro fits 5
 * people, Business scales to 7,500. Custom subcategories (Sales, Marketing,
 * HR, … beyond the built-in set) are capped by `limits.subcategories`.
 *
 * Reyna — the AI assistant — is a Pro/Business feature (`features.ai`); the
 * allowance `limits.aiCredits` is a per-workspace monthly credit cap that is
 * enforced server-side and resets each calendar month.
 *
 * This file is the single source of truth for plans. Limits are enforced
 * server-side wherever the feature exists today (contacts, seats, custom
 * fields, subcategories, AI credits). The API, app UI and landing page all
 * read from here so pricing stays in sync.
 */

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    limits: { contacts: 1000, pipelines: 5, customFields: 0, seats: 1, subcategories: 0, aiCredits: 0 },
    features: {
      api: false,
      whiteLabel: false,
      prioritySupport: false,
      workflow: 'none',
      reports: 'basic',
      teams: false,
      ai: false
    }
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19,
    limits: { contacts: Infinity, pipelines: 20, customFields: 50, seats: 5, subcategories: 2, aiCredits: 300 },
    features: {
      api: true,
      whiteLabel: false,
      prioritySupport: false,
      workflow: 'basic',
      reports: 'custom',
      teams: true,
      ai: true
    }
  },
  business: {
    id: 'business',
    name: 'Business',
    priceMonthly: 49,
    limits: { contacts: Infinity, pipelines: Infinity, customFields: Infinity, seats: 7500, subcategories: Infinity, aiCredits: 5000 },
    features: {
      api: 'full',
      whiteLabel: true,
      prioritySupport: true,
      workflow: 'advanced',
      reports: 'advanced-ai',
      teams: true,
      ai: true
    }
  }
};

const PLAN_IDS = Object.keys(PLANS);

/** Resolve a user's plan id (accounts created before plans default to free). */
function getPlanId(user) {
  return user && PLAN_IDS.includes(user.plan) ? user.plan : 'free';
}

/** The full plan object for a user. */
function getPlan(user) {
  return PLANS[getPlanId(user)];
}

/** A single numeric limit for a user's plan (Infinity = unlimited). */
function limit(user, key) {
  return getPlan(user).limits[key];
}

/** Current usage for the limits that exist today. */
function usage(db, userId) {
  const contacts = db.allFor('contacts', userId).length;
  // The app currently ships one pipeline (fixed stages); the plan's pipeline
  // allowance is pre-wired for the multi-pipeline feature.
  const pipelines = 1;
  const customFields = db.allFor('custom_fields', userId).length;
  // Seats = every user in the workspace, INCLUDING the account owner. The
  // Free plan's 1 seat is the owner themselves (no teams on Free).
  const seats = db.all('users').filter((u) => u.id === userId || u.workspaceOwnerId === userId).length;
  // Custom subcategories live on the owner's workspace record.
  const owner = db.get('users', userId);
  const subcategories = (owner && owner.workspace && Array.isArray(owner.workspace.subcategories)) ? owner.workspace.subcategories.length : 0;
  return { contacts, pipelines, customFields, seats, subcategories };
}

/**
 * Contact-limit check for a create/import. Returns an error payload to send
 * as a 403, or null when the account is within its allowance.
 */
function contactLimitError(db, user) {
  const plan = getPlan(user);
  const n = db.allFor('contacts', user.id).length;
  if (n >= plan.limits.contacts) {
    return {
      status: 403,
      json: {
        error: `Your ${plan.name} plan includes ${plan.limits.contacts.toLocaleString()} contacts`,
        code: 'PLAN_LIMIT',
        limit: plan.limits.contacts,
        usage: n,
        plan: plan.id,
        upgrade: plan.id === 'free' ? 'pro' : null
      }
    };
  }
  return null;
}

module.exports = { PLANS, PLAN_IDS, getPlanId, getPlan, limit, usage, contactLimitError };
