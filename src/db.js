'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { dataFile: DEFAULT_DATA_FILE } = require('./config');

const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

/**
 * Tiny JSON datastore with atomic writes.
 *
 * Two backends:
 *  - Local dev: an atomic JSON file (temp file + rename).
 *  - Netlify: Netlify Blobs, because function runtimes have a read-only
 *    filesystem. The API function calls init() once at cold start to hydrate
 *    memory from the blob store, and flush() after each request to persist
 *    mutations. The Db API itself stays synchronous — the routes are unchanged.
 */
class Db {
  constructor(file, opts = {}) {
    this.file = file || DEFAULT_DATA_FILE;
    this.data = null;
    this.blobStore = null;
    this._pendingJson = null; // latest serialized dataset awaiting flush()
    this._flushChain = Promise.resolve();
    this.useBlobs = opts.useBlobs === true || (Boolean(process.env.NETLIFY) && opts.useBlobs !== false);
    if (this.useBlobs) {
      // Lazy require so local runs never touch the Netlify SDK.
      try {
        const { getStore } = require('@netlify/blobs');
        // CLI-uploaded function zips don't get the runtime's ambient blobs
        // context, so pass the site id + token explicitly (site env vars set
        // by scripts/deploy-netlify.js).
        this.blobStore = getStore({
          name: opts.blobStoreName || 'crm-data',
          siteID: opts.siteID || process.env.NETLIFY_SITE_ID,
          token: opts.token || process.env.NETLIFY_AUTH_TOKEN
        });
      } catch (err) {
        console.error('[db] Netlify Blobs unavailable, falling back to file:', err.message);
        this.useBlobs = false;
        this.blobStore = null;
        this.blobError = err;
      }
    }
  }

  /**
   * Hydrate the dataset. On Netlify this is async (blob read) and is called by
   * the function wrapper before any request is served; locally it behaves like
   * the old synchronous load(). Safe to call more than once.
   */
  async init() {
    if (this.blobStore) return this.rehydrate();
    return this.load();
  }

  /**
   * Blob mode: ALWAYS re-read the dataset from Netlify Blobs and replace the
   * in-memory snapshot. Netlify keeps several warm function instances alive,
   * each with its own copy of the data from when it cold-started; without a
   * fresh read per request, an older instance serves a stale snapshot and can
   * even write it back, wiping newer records (e.g. sessions → phantom
   * "session expired"). Reads are cheap; consistency is worth it.
   */
  async rehydrate() {
    if (!this.blobStore) return this.data || this.load();
    try {
      // Default (eventual) consistency: manual siteID+token mode has no
      // uncachedEdgeURL, so "strong" would throw. The function wrapper also
      // serializes requests and the frontend retries 401s, which rides out
      // the brief propagation window.
      const raw = await this.blobStore.get('db.json', { type: 'text' });
      this.data = raw ? JSON.parse(raw) : emptyData();
      if (!Array.isArray(this.data.users)) {
        this.data = emptyData();
        await this.save();
      }
    } catch (err) {
      // Keep whatever we have rather than losing the workspace; log loudly.
      console.error('[db] rehydrate failed, keeping current snapshot:', err.message);
      if (!this.data) this.data = emptyData();
    }
    return this.data;
  }

  /** Load the data file (empty on first run). Safe to call more than once. */
  load() {
    if (this.data) return this.data;
    if (this.blobStore) {
      // Blob mode hydrates asynchronously via init() (called by the function
      // wrapper before any request). Never seed empty data here, or init()
      // would skip the blob read and wipe persistence on every cold start.
      return this.data;
    }
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        throw new Error(`Could not read data file ${this.file}: ${err.message}`);
      }
      // Legacy files predate auth and per-user scoping; the CRM records in them
      // have no owner, so start those installs fresh. New users always begin
      // with an empty workspace.
      if (!Array.isArray(this.data.users)) {
        this.data = emptyData();
        this.save();
      }
    } else {
      this.data = emptyData();
      this.save();
    }
    return this.data;
  }

  /** Persist: blob write (buffered until flush) or atomic file write. */
  save() {
    if (!this.data) return;
    if (this.blobStore) {
      // Buffer the latest snapshot; the function wrapper flushes it after the
      // response, which keeps writes durable without making routes async.
      this._pendingJson = JSON.stringify(this.data);
      return;
    }
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Persist any buffered blob write. Call after serving a request (Netlify). */
  async flush() {
    if (!this.blobStore || this._pendingJson === null) return;
    const json = this._pendingJson;
    this._pendingJson = null;
    this._flushChain = this._flushChain.then(() => this.blobStore.set('db.json', json))
      .catch((err) => console.error('[db] blob save failed:', err.message));
    return this._flushChain;
  }

  newId() {
    return crypto.randomUUID();
  }

  // ---- Generic collection helpers ----------------------------------------

  all(collection) {
    this.load();
    return this.data[collection] || [];
  }

  get(collection, id) {
    return this.all(collection).find((item) => item.id === id) || null;
  }

  /** All records in a collection owned by one user. */
  allFor(collection, ownerId) {
    return this.all(collection).filter((item) => item.ownerId === ownerId);
  }

  /** A single record, but only if it belongs to the given owner. */
  getFor(collection, id, ownerId) {
    return this.allFor(collection, ownerId).find((item) => item.id === id) || null;
  }

  insert(collection, record) {
    this.load();
    const doc = { id: this.newId(), createdAt: new Date().toISOString(), ...record };
    this.data[collection] = this.data[collection] || [];
    this.data[collection].push(doc);
    this.save();
    return doc;
  }

  update(collection, id, patch) {
    const list = this.all(collection);
    const idx = list.findIndex((item) => item.id === id);
    if (idx === -1) return null;
    const updated = { ...list[idx], ...patch, id, updatedAt: new Date().toISOString() };
    list[idx] = updated;
    this.save();
    return updated;
  }

  remove(collection, id) {
    const list = this.all(collection);
    const idx = list.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.save();
    return true;
  }

  /** Find first record matching a predicate (returns object, not a cursor). */
  find(collection, predicate) {
    return this.all(collection).find(predicate) || null;
  }
}

// ---- Initial data ---------------------------------------------------------

/**
 * A brand-new install starts completely empty: no demo contacts, companies,
 * deals or activities. New users register through /api/auth/register and get
 * their own blank workspace (all CRM records carry an ownerId).
 */
function emptyData() {
  return { users: [], sessions: [], resets: [], companies: [], contacts: [], deals: [], activities: [], custom_fields: [] };
}

module.exports = { Db, DEAL_STAGES };
