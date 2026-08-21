'use strict';

/**
 * HubSpot integration for BizzyBee CRM sign-ups.
 *
 * When someone creates an account, we push their info into the Z Dot LLC
 * HubSpot portal (contact object) so marketing/sales can follow up.
 *
 * Design notes:
 *  - Fire-and-forget: a HubSpot failure must never block a sign-up, so the
 *    caller is expected to swallow errors (see app.js wiring).
 *  - No custom HubSpot properties are used (creating those needs extra
 *    scopes); we rely on standard contact properties plus the standard
 *    analytics-source fields to tag where the lead came from.
 *  - The token is read from the environment (HUBSPOT_ACCESS_TOKEN) and is
 *    never exposed to the browser.
 */

const HUBSPOT_API = 'https://api.hubapi.com/crm/v3/objects/contacts';

/** Split "First Last" into firstname/lastname (graceful fallbacks). */
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstname: '', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
}

/**
 * Build a HubSpot client.
 * @param {object} [opts] - { token, fetchImpl, log }
 */
function createHubspotClient(opts = {}) {
  // Explicit opts.token wins (even when empty, to force-disable); otherwise
  // fall back to the environment token.
  const token = opts.token !== undefined ? opts.token : (process.env.HUBSPOT_ACCESS_TOKEN || '');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const log = opts.log || ((...args) => console.log('[hubspot]', ...args));

  const enabled = Boolean(token);

  /**
   * Create (or match) a contact in HubSpot.
   * @param {{name?: string, email: string, company?: string, source?: string}} info
   * @returns {Promise<{ok: boolean, id?: string, status?: number, error?: string}>}
   */
  async function createContact(info = {}) {
    if (!enabled) return { ok: false, error: 'HubSpot not configured (set HUBSPOT_ACCESS_TOKEN)' };
    const email = String(info.email || '').trim().toLowerCase();
    if (!email) return { ok: false, error: 'email is required' };

    const { firstname, lastname } = splitName(info.name);
    const properties = { email, firstname, lastname };

    // Standard writable properties only (verified against the Z Dot LLC
    // portal): utm/analytics sub-fields are read-only or absent there.
    properties.lifecyclestage = 'lead';
    properties.hs_lead_status = 'NEW';
    if (info.company) properties.company = String(info.company);
    if (info.phone) properties.phone = String(info.phone);
    if (info.source) properties.hs_analytics_source = 'OTHER_CAMPAIGNS';

    const body = { properties };
    const res = await fetchImpl(`${HUBSPOT_API}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // 409 = contact already exists (matched by email) — that's fine.
      if (res.status === 409) {
        log(`contact already exists for ${email}`);
        return { ok: true, id: data && (data.id || data.message), status: 409, duplicate: true };
      }
      const msg = data && (data.message || JSON.stringify(data).slice(0, 200)) || `HTTP ${res.status}`;
      log(`createContact failed: ${msg}`);
      return { ok: false, status: res.status, error: String(msg).slice(0, 500) };
    }

    log(`contact created: ${email} (${data.id})`);
    return { ok: true, id: data.id, status: res.status };
  }

  return { enabled, createContact };
}

module.exports = { createHubspotClient, splitName };
