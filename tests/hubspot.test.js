'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHubspotClient, splitName } = require('../src/hubspot');
const { createApp } = require('../src/app');

// ---- Unit tests for the client --------------------------------------------

test('splitName handles full, single, and empty names', () => {
  assert.deepStrictEqual(splitName('Jane Doe'), { firstname: 'Jane', lastname: 'Doe' });
  assert.deepStrictEqual(splitName('  Bob   Smith  '), { firstname: 'Bob', lastname: 'Smith' });
  assert.deepStrictEqual(splitName('Cher'), { firstname: 'Cher', lastname: '' });
  assert.deepStrictEqual(splitName(''), { firstname: '', lastname: '' });
  assert.deepStrictEqual(splitName(undefined), { firstname: '', lastname: '' });
});

test('createContact POSTs standard properties with the bearer token', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201, json: async () => ({ id: '9001' }) };
  };
  const client = createHubspotClient({ token: 'secret-token', fetchImpl });
  assert.strictEqual(client.enabled, true);

  const result = await client.createContact({ name: 'Jane Doe', email: 'Jane@Example.com', company: 'Acme', phone: '+1 555-0101', source: 'bizzybee-crm-signup' });
  assert.deepStrictEqual(result, { ok: true, id: '9001', status: 201 });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://api.hubapi.com/crm/v3/objects/contacts');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer secret-token');
  const body = JSON.parse(calls[0].opts.body);
  assert.strictEqual(body.properties.email, 'jane@example.com'); // normalized
  assert.strictEqual(body.properties.firstname, 'Jane');
  assert.strictEqual(body.properties.lastname, 'Doe');
  assert.strictEqual(body.properties.company, 'Acme');
  assert.strictEqual(body.properties.phone, '+1 555-0101');
  assert.strictEqual(body.properties.lifecyclestage, 'lead');
  assert.strictEqual(body.properties.hs_lead_status, 'NEW');
  assert.strictEqual(body.properties.hs_analytics_source, 'OTHER_CAMPAIGNS');
  assert.strictEqual(body.properties.hs_analytics_utm_campaign, undefined); // absent on this portal
});

test('createContact is disabled without a token', async () => {
  const client = createHubspotClient({ token: '', fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.strictEqual(client.enabled, false);
  const result = await client.createContact({ email: 'x@example.com' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /not configured/i);
});

test('createContact treats 409 duplicate as success', async () => {
  const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({ message: 'Contact already exists' }) });
  const client = createHubspotClient({ token: 't', fetchImpl });
  const result = await client.createContact({ email: 'dup@example.com' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.duplicate, true);
});

test('createContact swallows upstream failures as { ok: false }', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) });
  const client = createHubspotClient({ token: 't', fetchImpl });
  const result = await client.createContact({ email: 'x@example.com' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 500);
});

// ---- Register → HubSpot wiring (fake client, offline) ----------------------

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-hs-test-')), 'db.json');
let server;
let base;
let hubspotCalls = [];

before(async () => {
  const fakeHubspot = {
    enabled: true,
    createContact(info) {
      hubspotCalls.push(info);
      return Promise.resolve({ ok: true, id: 'fake-1' });
    }
  };
  const app = createApp({ dataFile: tmpFile, log: false, hubspot: fakeHubspot });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
});

test('registering a user pushes their sign-up info to the HubSpot client', async () => {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com', phone: '+1 555-0101', password: 'password123' })
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(hubspotCalls.length, 1);
  assert.strictEqual(hubspotCalls[0].email, 'jane@example.com');
  assert.strictEqual(hubspotCalls[0].name, 'Jane Doe');
  assert.strictEqual(hubspotCalls[0].phone, '+1 555-0101');
  assert.strictEqual(hubspotCalls[0].source, 'bizzybee-crm-signup');
});

test('a failing HubSpot client does not block account creation', async () => {
  // Second app with a client that rejects: registration must still succeed.
  const tmp2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-hs2-')), 'db.json');
  const failing = {
    enabled: true,
    createContact() { return Promise.reject(new Error('HubSpot down')); }
  };
  const app2 = createApp({ dataFile: tmp2, log: false, hubspot: failing });
  const srv2 = await new Promise((resolve) => { const s = app2.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv2.address().port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ok User', email: 'ok@example.com', password: 'password123' })
    });
    assert.strictEqual(res.status, 201);
  } finally {
    srv2.close();
    try { fs.rmSync(path.dirname(tmp2), { recursive: true, force: true }); } catch {}
  }
});
