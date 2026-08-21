'use strict';

/**
 * Netlify Function hosting the whole BizzyBee CRM API.
 *
 * netlify.toml rewrites /api/* → /.netlify/functions/api/:splat, so the full
 * Express app (auth, contacts, companies, deals, activities, dashboard,
 * search, export) runs serverlessly. Data persists in Netlify Blobs:
 *  - init() hydrates the in-memory store at cold start,
 *  - flush() writes any mutations back after the response.
 *
 * The same code runs locally unchanged (file-backed Db) via `npm start`.
 *
 * Initialization is lazy and retryable: if building the app fails once (e.g.
 * a transient blobs/env hiccup during a deploy), the next request tries
 * again instead of the instance staying broken for its lifetime.
 */

const serverless = require('serverless-http');
const { Db } = require('../../src/db');
const { createApp } = require('../../src/app');
const config = require('../../src/config');

let db = null;
let expressHandler = null;
let initError = null;
let buildPromise = null;
// Serializes requests per warm instance (see handler).
let requestQueue = Promise.resolve();

function buildApp() {
  db = new Db(config.dataFile, { useBlobs: true });
  const app = createApp({ db });
  expressHandler = serverless(app);
}

async function ensureReady() {
  if (expressHandler) return;
  try {
    if (!buildPromise) {
      buildPromise = Promise.resolve().then(buildApp);
    }
    await buildPromise;
  } catch (err) {
    initError = err;
    buildPromise = null; // allow a fresh attempt on the next request
    console.error('[api] function init failed (will retry on next request):', err);
    throw err;
  }
}

function diagnostics() {
  return {
    error: 'BizzyBee API failed to initialize',
    message: initError ? initError.message : 'unknown',
    env: {
      NETLIFY: process.env.NETLIFY || null,
      CONTEXT: process.env.CONTEXT || null,
      NETLIFY_SITE_ID: process.env.NETLIFY_SITE_ID ? 'set' : 'missing',
      NETLIFY_AUTH_TOKEN: process.env.NETLIFY_AUTH_TOKEN ? 'set' : 'missing',
      HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN ? 'set' : 'missing'
    },
    blobError: db && db.blobError ? db.blobError.message : null,
    useBlobs: db ? db.useBlobs : null
  };
}

exports.handler = async (event, context) => {
  try {
    await ensureReady();
  } catch {
    return { statusCode: 503, body: JSON.stringify(diagnostics()) };
  }

  // Requests are serialized per warm instance (a simple promise chain) so a
  // fresh rehydrate can never interleave with another request's mutation.
  // Cross-instance staleness is handled by rehydrating from blobs on EVERY
  // request — an older warm instance no longer serves (or writes back) a
  // stale snapshot, which was the cause of phantom "session expired".
  const run = requestQueue.then(async () => {
    await db.rehydrate();
    // Netlify rewrites /api/* → /.netlify/functions/api/*; Express is mounted
    // at /api, so hand it back the original path (strip the prefix if present).
    const path = event.path.replace(/^\/\.netlify\/functions\/api/, '') || '/';
    const result = await expressHandler({ ...event, path }, context);
    // Persist any buffered mutations from this request.
    await db.flush();
    return result;
  });
  // Keep the chain alive even if this request fails.
  requestQueue = run.catch(() => {});
  return run;
};
