'use strict';

const express = require('express');
const { validateDeal } = require('../validators');
const { DEAL_STAGES } = require('../db');

function dealsRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { stage, q } = req.query;
    let list = db.allFor('deals', req.userId);
    if (stage) list = list.filter((d) => d.stage === stage);
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((d) => [d.title, d.notes, d.stage].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)));
    }
    const out = list.map((d) => decorate(db, d, req.userId));
    res.json(out);
  });

  router.get('/stages', (req, res) => {
    res.json(DEAL_STAGES.map((stage) => {
      const deals = db.allFor('deals', req.userId).filter((d) => d.stage === stage);
      const total = deals.reduce((s, d) => s + Number(d.amount || 0), 0);
      return { stage, count: deals.length, total };
    }));
  });

  router.post('/', (req, res) => {
    const errors = validateDeal(req.body || {});
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    const { contactId, companyId } = req.body;
    if (contactId && !db.getFor('contacts', contactId, req.userId)) return res.status(400).json({ error: `Contact ${contactId} does not exist` });
    if (companyId && !db.getFor('companies', companyId, req.userId)) return res.status(400).json({ error: `Company ${companyId} does not exist` });
    const deal = db.insert('deals', { ...req.body, stage: req.body.stage || 'lead', ownerId: req.userId });
    res.status(201).json(decorate(db, deal, req.userId));
  });

  // POST /api/deals/bulk-delete
  router.post('/bulk-delete', (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? (req.body || {}).ids.filter((i) => typeof i === 'string' && i) : [];
    if (!ids.length) return res.status(400).json({ error: 'No ids provided' });
    let deleted = 0;
    const errors = [];
    for (const id of ids) {
      if (!db.getFor('deals', id, req.userId)) { errors.push({ id, error: 'Deal not found' }); continue; }
      db.remove('deals', id);
      deleted += 1;
    }
    res.json({ deleted, skipped: errors.length, errors });
  });

  router.get('/:id', (req, res) => {
    const deal = db.getFor('deals', req.params.id, req.userId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    res.json(decorate(db, deal, req.userId));
  });

  router.put('/:id', (req, res) => {
    const existing = db.getFor('deals', req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    const errors = validateDeal(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    const { contactId, companyId } = req.body;
    if (contactId && !db.getFor('contacts', contactId, req.userId)) return res.status(400).json({ error: `Contact ${contactId} does not exist` });
    if (companyId && !db.getFor('companies', companyId, req.userId)) return res.status(400).json({ error: `Company ${companyId} does not exist` });
    res.json(decorate(db, db.update('deals', req.params.id, req.body), req.userId));
  });

  // PATCH /api/deals/:id/stage — quick pipeline moves
  router.patch('/:id/stage', (req, res) => {
    const { stage } = req.body || {};
    if (!DEAL_STAGES.includes(stage)) {
      return res.status(400).json({ error: `stage must be one of: ${DEAL_STAGES.join(', ')}` });
    }
    const existing = db.getFor('deals', req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    res.json(decorate(db, db.update('deals', req.params.id, { stage }), req.userId));
  });

  router.delete('/:id', (req, res) => {
    if (!db.getFor('deals', req.params.id, req.userId)) return res.status(404).json({ error: 'Deal not found' });
    db.remove('deals', req.params.id);
    res.status(204).end();
  });

  return router;
}

function decorate(db, deal, ownerId) {
  const contact = deal.contactId ? db.getFor('contacts', deal.contactId, ownerId) : null;
  const company = deal.companyId ? db.getFor('companies', deal.companyId, ownerId) : null;
  return {
    ...deal,
    contactName: contact ? `${contact.firstName} ${contact.lastName}` : null,
    companyName: company ? company.name : null
  };
}

module.exports = dealsRouter;
