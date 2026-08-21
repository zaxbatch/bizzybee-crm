'use strict';

const express = require('express');
const { parseCsv } = require('../csv');
const { getPlan } = require('../plans');
const { defsFor } = require('./customfields');

/**
 * CSV importer. Accepts the format produced by /api/export (header row +
 * data rows), scoped to the authenticated user.
 *
 *   POST /api/import/contacts    body: { csv, mapping?, required? }
 *   POST /api/import/companies   body: { csv, mapping?, required? }
 *
 * mapping:  { field: "CSV header" } — which CSV column feeds which CRM field
 *           (case-insensitive). Omit to auto-detect from known header names.
 * required: array of field names that must be non-empty in every row
 *           (default: contacts → firstName,lastName,email; companies → name).
 *
 * Contacts fields: firstName, lastName, name (combined), email, phone, title,
 * company (name → linked/auto-created), status, tags (split on ; or ,), notes.
 * Companies fields: name, industry, size, website, notes.
 *
 * Responses: { imported, skipped, errors: [{ row, email?, errors }] }.
 * Bad rows are skipped and reported — a bad row never aborts the file.
 */

const FIELD_LABELS = {
  firstName: 'First name', lastName: 'Last name', name: 'Name', email: 'Email',
  phone: 'Phone', title: 'Title', address: 'Address', company: 'Company', status: 'Status',
  tags: 'Tags', notes: 'Notes', industry: 'Industry', size: 'Size', website: 'Website'
};

const CONTACT_FIELDS = ['firstName', 'lastName', 'name', 'email', 'phone', 'title', 'address', 'company', 'status', 'tags', 'notes'];
const COMPANY_FIELDS = ['name', 'industry', 'size', 'website', 'address', 'notes'];

/** Resolve { field: header } into { field: columnIndex } against headers (lowercased). */
function buildColumns(headers, mapping) {
  const col = {};
  for (const field of Object.keys(mapping || {})) {
    const name = String(mapping[field] || '').trim().toLowerCase();
    col[field] = name ? headers.indexOf(name) : -1;
  }
  return col;
}

function rowValue(vals, col, field) {
  const i = col[field];
  return i !== undefined && i >= 0 && i < vals.length ? String(vals[i]).trim() : '';
}

/** Field-level validation honoring a per-import required list. */
function validateRow(contact, required, allowedStatuses) {
  const errors = [];
  for (const field of required) {
    const value = field === 'company' ? contact._companyName : contact[field];
    if (!value) errors.push(`${FIELD_LABELS[field] || field} is required`);
  }
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    errors.push('Email must be a valid email address');
  }
  if (contact.status && !allowedStatuses.includes(contact.status)) {
    errors.push(`Status must be one of: ${allowedStatuses.join(', ')}`);
  }
  return errors;
}

function headerIndex(headers, names) {
  for (const name of names) {
    const i = headers.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

/** Guess a mapping from header names when the client didn't provide one. */
function guessContactMapping(headers) {
  const mapping = {};
  const pick = (field, names) => {
    const i = headerIndex(headers, names);
    if (i !== -1) mapping[field] = headers[i];
  };
  pick('firstName', ['firstname', 'first name', 'first']);
  pick('lastName', ['lastname', 'last name', 'last']);
  pick('name', ['name', 'fullname', 'full name']);
  pick('email', ['email', 'emailaddress', 'email address', 'e-mail']);
  pick('phone', ['phone', 'phonenumber', 'phone number', 'mobile']);
  pick('title', ['title', 'jobtitle', 'job title', 'position']);
  pick('address', ['address', 'street', 'location']);
  pick('company', ['company', 'companyname', 'company name', 'organization']);
  pick('status', ['status']);
  pick('tags', ['tags', 'tag']);
  pick('notes', ['notes', 'note']);
  return mapping;
}

function guessCompanyMapping(headers) {
  const mapping = {};
  const pick = (field, names) => {
    const i = headerIndex(headers, names);
    if (i !== -1) mapping[field] = headers[i];
  };
  pick('name', ['name', 'companyname', 'company name']);
  pick('industry', ['industry']);
  pick('size', ['size', 'companysize']);
  pick('website', ['website', 'url']);
  pick('address', ['address', 'street', 'location']);
  pick('notes', ['notes', 'note']);
  return mapping;
}

function importRouter(db) {
  const router = express.Router();

  // POST /api/import/contacts
  router.post('/contacts', (req, res) => {
    const rows = parseCsv(String((req.body || {}).csv || ''));
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV must include a header row and at least one data row' });
    }

    const headers = rows[0].map((h) => String(h).trim().toLowerCase());
    const mapping = (req.body && req.body.mapping) || guessContactMapping(headers);
    // Auto-map CSV headers that match a custom field label (cf:<fieldId>).
    const defs = defsFor(db, req.userId);
    for (const d of defs) {
      const h = headers.find((x) => x === d.label.toLowerCase());
      if (h !== undefined) mapping[`cf:${d.id}`] = h;
    }
    const required = (req.body && Array.isArray(req.body.required)) ? req.body.required : ['firstName', 'lastName', 'email'];
    const col = buildColumns(headers, mapping);

    // Every required field must actually be mapped to a column.
    for (const field of required) {
      const idx = col[field];
      if (!CONTACT_FIELDS.includes(field) || idx === undefined || idx === -1) {
        return res.status(400).json({ error: `Required field "${FIELD_LABELS[field] || field}" is not mapped to any CSV column` });
      }
    }

    const companyIds = new Map();
    db.allFor('companies', req.userId).forEach((c) => companyIds.set(c.name.toLowerCase(), c.id));

    // Plan contact allowance: rows beyond the limit are skipped and reported,
    // never silently dropped. Infinity = unlimited (Pro / Business).
    const plan = getPlan(req.user);
    const contactAllowance = plan.limits.contacts;
    const existingContacts = db.allFor('contacts', req.userId).length;

    let imported = 0;
    let companiesCreated = 0;
    const errors = [];

    const ensureCompany = (rawName) => {
      const name = String(rawName || '').trim();
      const key = name.toLowerCase();
      if (!key) return null;
      if (companyIds.has(key)) return companyIds.get(key);
      const company = db.insert('companies', { name, ownerId: req.userId });
      companyIds.set(key, company.id);
      companiesCreated += 1;
      return company.id;
    };

    for (let r = 1; r < rows.length; r++) {
      const vals = rows[r];
      const get = (field) => rowValue(vals, col, field);

      let first = get('firstName');
      let last = get('lastName');
      if (!first && !last) {
        const parts = get('name').split(/\s+/).filter(Boolean);
        if (parts.length) { first = parts.shift(); last = parts.join(' '); }
      }

      const contact = {
        firstName: first,
        lastName: last,
        email: get('email'),
        phone: get('phone'),
        title: get('title'),
        address: get('address'),
        status: get('status') || 'lead',
        tags: get('tags').split(/[;,]/).map((t) => t.trim()).filter(Boolean),
        notes: get('notes'),
        _companyName: get('company')
      };

      // Custom field values from cf:<fieldId> columns.
      const custom = {};
      for (const d of defs) {
        const v = get(`cf:${d.id}`);
        if (v) custom[d.id] = v;
      }
      if (Object.keys(custom).length) contact.custom = custom;

      // Skip fully blank rows (no mapped data at all).
      if (!contact.firstName && !contact.lastName && !contact.email && !contact._companyName && !contact.phone && !contact.title) continue;

      // Validate BEFORE creating any company, so bad rows have no side effects.
      const errs = validateRow(contact, required, ['lead', 'prospect', 'customer', 'inactive']);
      if (errs.length) {
        errors.push({ row: r + 1, email: contact.email, errors: errs });
        continue;
      }
      if (col.company !== -1) contact.companyId = ensureCompany(contact._companyName);
      delete contact._companyName;
      if (Number.isFinite(contactAllowance) && existingContacts + imported >= contactAllowance) {
        errors.push({
          row: r + 1,
          email: contact.email,
          errors: [`Plan limit reached — ${plan.name} includes ${contactAllowance.toLocaleString()} contacts`]
        });
        continue;
      }
      db.insert('contacts', { ...contact, ownerId: req.userId });
      imported += 1;
    }

    res.json({ imported, skipped: errors.length, errors, companiesCreated });
  });

  // POST /api/import/companies
  router.post('/companies', (req, res) => {
    const rows = parseCsv(String((req.body || {}).csv || ''));
    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV must include a header row and at least one data row' });
    }

    const headers = rows[0].map((h) => String(h).trim().toLowerCase());
    const mapping = (req.body && req.body.mapping) || guessCompanyMapping(headers);
    const required = (req.body && Array.isArray(req.body.required)) ? req.body.required : ['name'];
    const col = buildColumns(headers, mapping);

    for (const field of required) {
      const idx = col[field];
      if (!COMPANY_FIELDS.includes(field) || idx === undefined || idx === -1) {
        return res.status(400).json({ error: `Required field "${FIELD_LABELS[field] || field}" is not mapped to any CSV column` });
      }
    }

    const seen = new Map();
    db.allFor('companies', req.userId).forEach((c) => seen.set(c.name.toLowerCase(), true));

    let imported = 0;
    const errors = [];

    for (let r = 1; r < rows.length; r++) {
      const vals = rows[r];
      const get = (field) => rowValue(vals, col, field);
      const name = get('name');
      if (!name) continue; // blank row

      const company = {
        name,
        industry: get('industry'),
        size: get('size'),
        website: get('website'),
        address: get('address'),
        notes: get('notes')
      };

      const key = name.toLowerCase();
      if (seen.has(key)) {
        errors.push({ row: r + 1, email: name, errors: ['Company already exists'] });
        continue;
      }
      const errs = validateRow(company, required, []);
      if (errs.length) {
        errors.push({ row: r + 1, email: name, errors: errs });
        continue;
      }
      seen.set(key, true);
      db.insert('companies', { ...company, ownerId: req.userId });
      imported += 1;
    }

    res.json({ imported, skipped: errors.length, errors });
  });

  return router;
}

module.exports = importRouter;
