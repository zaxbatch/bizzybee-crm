'use strict';

const express = require('express');
const { validateCompany } = require('../validators');

function companiesRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { q } = req.query;
    let list = db.allFor('companies', req.userId);
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((c) =>
        [c.name, c.industry, c.website, c.size, c.notes].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))
      );
    }
    const out = list.map((c) => {
      const contacts = db.allFor('contacts', req.userId).filter((ct) => ct.companyId === c.id);
      const deals = db.allFor('deals', req.userId).filter((d) => d.companyId === c.id);
      const pipeline = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost').reduce((s, d) => s + Number(d.amount || 0), 0);
      return { ...c, contactCount: contacts.length, dealCount: deals.length, openPipeline: pipeline };
    });
    res.json(out);
  });

  router.post('/', (req, res) => {
    const errors = validateCompany(req.body || {});
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    res.status(201).json(db.insert('companies', { ...req.body, ownerId: req.userId }));
  });

  // POST /api/companies/bulk-delete — companies with deals are blocked
  router.post('/bulk-delete', (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? (req.body || {}).ids.filter((i) => typeof i === 'string' && i) : [];
    if (!ids.length) return res.status(400).json({ error: 'No ids provided' });
    let deleted = 0;
    const errors = [];
    for (const id of ids) {
      const existing = db.getFor('companies', id, req.userId);
      if (!existing) { errors.push({ id, error: 'Company not found' }); continue; }
      const deals = db.allFor('deals', req.userId).filter((d) => d.companyId === id);
      if (deals.length) { errors.push({ id, error: `${deals.length} deal(s) reference this company` }); continue; }
      db.allFor('contacts', req.userId).filter((ct) => ct.companyId === id).forEach((ct) => db.update('contacts', ct.id, { companyId: null }));
      db.remove('companies', id);
      deleted += 1;
    }
    res.json({ deleted, skipped: errors.length, errors });
  });

  router.get('/:id', (req, res) => {
    const company = db.getFor('companies', req.params.id, req.userId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const contacts = db.allFor('contacts', req.userId).filter((c) => c.companyId === company.id);
    const deals = db.allFor('deals', req.userId).filter((d) => d.companyId === company.id);
    res.json({ ...company, contacts, deals });
  });

  router.put('/:id', (req, res) => {
    const existing = db.getFor('companies', req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Company not found' });
    const errors = validateCompany(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    res.json(db.update('companies', req.params.id, req.body));
  });

  router.delete('/:id', (req, res) => {
    const existing = db.getFor('companies', req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Company not found' });
    const deals = db.allFor('deals', req.userId).filter((d) => d.companyId === req.params.id);
    if (deals.length) {
      return res.status(409).json({ error: `Cannot delete company: ${deals.length} deal(s) reference this company` });
    }
    // Unlink contacts (keep them, just remove the association)
    db.allFor('contacts', req.userId).filter((c) => c.companyId === req.params.id).forEach((c) => db.update('contacts', c.id, { companyId: null }));
    db.remove('companies', req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = companiesRouter;
