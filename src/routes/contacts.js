'use strict';

const express = require('express');
const { validateContact } = require('../validators');
const { contactLimitError } = require('../plans');

function idsOf(body) {
  const ids = Array.isArray(body && body.ids) ? body.ids : [];
  return ids.filter((i) => typeof i === 'string' && i);
}

function contactsRouter(db) {
  const router = express.Router();

  // GET /api/contacts?q=&companyId=&status=
  router.get('/', (req, res) => {
    const { q, companyId, status } = req.query;
    let list = db.allFor('contacts', req.userId);
    if (companyId) list = list.filter((c) => c.companyId === companyId);
    if (status) list = list.filter((c) => c.status === status);
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((c) =>
        [c.firstName, c.lastName, c.email, c.title, c.phone, ...(c.tags || [])]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle))
      );
    }
    // attach company name for convenient display
    const out = list.map((c) => {
      const company = c.companyId ? db.getFor('companies', c.companyId, req.userId) : null;
      return { ...c, companyName: company ? company.name : null };
    });
    res.json(out);
  });

  router.post('/', (req, res) => {
    const errors = validateContact(req.body || {});
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    const limitErr = contactLimitError(db, req.user);
    if (limitErr) return res.status(limitErr.status).json(limitErr.json);
    if (req.body.companyId && !db.getFor('companies', req.body.companyId, req.userId)) {
      return res.status(400).json({ error: `Company ${req.body.companyId} does not exist` });
    }
    const contact = db.insert('contacts', { ...req.body, ownerId: req.userId });
    res.status(201).json(contact);
  });

  // POST /api/contacts/bulk-delete — delete many (open deals block a contact)
  router.post('/bulk-delete', (req, res) => {
    const ids = idsOf(req.body);
    if (!ids.length) return res.status(400).json({ error: 'No ids provided' });
    let deleted = 0;
    const errors = [];
    for (const id of ids) {
      const existing = db.getFor('contacts', id, req.userId);
      if (!existing) { errors.push({ id, error: 'Contact not found' }); continue; }
      const openDeals = db.allFor('deals', req.userId).filter((d) => d.contactId === id && d.stage !== 'won' && d.stage !== 'lost');
      if (openDeals.length) { errors.push({ id, error: `${openDeals.length} open deal(s) reference this contact` }); continue; }
      db.allFor('activities', req.userId).filter((a) => a.contactId === id).forEach((a) => db.remove('activities', a.id));
      db.remove('contacts', id);
      deleted += 1;
    }
    res.json({ deleted, skipped: errors.length, errors });
  });

  router.get('/:id', (req, res) => {
    const contact = db.getFor('contacts', req.params.id, req.userId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const company = contact.companyId ? db.getFor('companies', contact.companyId, req.userId) : null;
    const deals = db.allFor('deals', req.userId).filter((d) => d.contactId === contact.id);
    const activities = db.allFor('activities', req.userId).filter((a) => a.contactId === contact.id);
    res.json({ ...contact, companyName: company ? company.name : null, deals, activities });
  });

  router.put('/:id', (req, res) => {
    const existing = db.getFor('contacts', req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    const errors = validateContact(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    if (req.body.companyId && !db.getFor('companies', req.body.companyId, req.userId)) {
      return res.status(400).json({ error: `Company ${req.body.companyId} does not exist` });
    }
    res.json(db.update('contacts', req.params.id, req.body));
  });

  router.delete('/:id', (req, res) => {
    const existing = db.getFor('contacts', req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });
    const openDeals = db.allFor('deals', req.userId).filter((d) => d.contactId === req.params.id && d.stage !== 'won' && d.stage !== 'lost');
    if (openDeals.length) {
      return res.status(409).json({ error: `Cannot delete contact: ${openDeals.length} open deal(s) reference this contact` });
    }
    // Remove contact and its activities
    db.allFor('activities', req.userId).filter((a) => a.contactId === req.params.id).forEach((a) => db.remove('activities', a.id));
    db.remove('contacts', req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = contactsRouter;
