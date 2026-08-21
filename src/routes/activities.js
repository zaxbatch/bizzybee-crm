'use strict';

const express = require('express');
const { validateActivity } = require('../validators');

function activitiesRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const { contactId, type } = req.query;
    let list = db.allFor('activities', req.userId);
    if (contactId) list = list.filter((a) => a.contactId === contactId);
    if (type) list = list.filter((a) => a.type === type);
    list = list.sort((a, b) => new Date(b.happenedAt || b.createdAt) - new Date(a.happenedAt || a.createdAt));
    const out = list.map((a) => {
      const contact = a.contactId ? db.getFor('contacts', a.contactId, req.userId) : null;
      return { ...a, contactName: contact ? `${contact.firstName} ${contact.lastName}` : null };
    });
    res.json(out);
  });

  router.post('/', (req, res) => {
    const errors = validateActivity(req.body || {});
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    const body = req.body;
    if (body.contactId && !db.getFor('contacts', body.contactId, req.userId)) {
      return res.status(400).json({ error: `Contact ${body.contactId} does not exist` });
    }
    const activity = db.insert('activities', { ...body, type: body.type || 'note', happenedAt: body.happenedAt || new Date().toISOString(), ownerId: req.userId });
    res.status(201).json(activity);
  });

  // POST /api/activities/bulk-delete
  router.post('/bulk-delete', (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? (req.body || {}).ids.filter((i) => typeof i === 'string' && i) : [];
    if (!ids.length) return res.status(400).json({ error: 'No ids provided' });
    let deleted = 0;
    const errors = [];
    for (const id of ids) {
      if (!db.getFor('activities', id, req.userId)) { errors.push({ id, error: 'Activity not found' }); continue; }
      db.remove('activities', id);
      deleted += 1;
    }
    res.json({ deleted, skipped: errors.length, errors });
  });

  router.get('/:id', (req, res) => {
    const activity = db.getFor('activities', req.params.id, req.userId);
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    res.json(activity);
  });

  router.put('/:id', (req, res) => {
    const existing = db.getFor('activities', req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Activity not found' });
    const errors = validateActivity(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    if (req.body.contactId && !db.getFor('contacts', req.body.contactId, req.userId)) {
      return res.status(400).json({ error: `Contact ${req.body.contactId} does not exist` });
    }
    res.json(db.update('activities', req.params.id, req.body));
  });

  router.delete('/:id', (req, res) => {
    if (!db.getFor('activities', req.params.id, req.userId)) return res.status(404).json({ error: 'Activity not found' });
    db.remove('activities', req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = activitiesRouter;
