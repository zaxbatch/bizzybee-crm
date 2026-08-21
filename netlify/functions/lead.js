'use strict';

/**
 * Netlify Function: POST /.netlify/functions/lead
 *
 * Forwards a landing-page sign-up to the Z Dot LLC HubSpot portal as a
 * contact. The HubSpot access token lives in the site's environment
 * (HUBSPOT_ACCESS_TOKEN) — never in the browser.
 */

const HUBSPOT_API = 'https://api.hubapi.com/crm/v3/objects/contacts';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const token = process.env.HUBSPOT_ACCESS_TOKEN || '';
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'HubSpot not configured on this site' }) };
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'A valid email is required' }) };
  }

  // Honeypot: bots fill hidden fields; pretend success without storing.
  if (body.company_website) {
    return { statusCode: 201, body: JSON.stringify({ ok: true, duplicate: false }) };
  }

  const name = String(body.name || '').trim();
  const nameParts = name.split(/\s+/).filter(Boolean);
  const firstname = nameParts[0] || '';
  const lastname = nameParts.slice(1).join(' ');

  const properties = {
    email,
    firstname,
    lastname,
    lifecyclestage: 'lead',
    hs_lead_status: 'NEW',
    hs_analytics_source: 'OTHER_CAMPAIGNS'
  };
  if (body.company) properties.company = String(body.company).trim();

  const res = await fetch(HUBSPOT_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties })
  });
  const data = await res.json().catch(() => null);

  // 409 = contact already exists (matched by email) — treat as success.
  if (res.status === 409) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, duplicate: true }) };
  }
  if (!res.ok) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: (data && data.message) || 'HubSpot sync failed' })
    };
  }
  return { statusCode: 201, body: JSON.stringify({ ok: true, id: data.id }) };
};
