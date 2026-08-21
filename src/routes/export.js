'use strict';

const express = require('express');
const { toCsv } = require('../csv');

/**
 * CSV exporter. One endpoint per entity, scoped to the authenticated user.
 *
 *   GET /api/export/contacts.csv
 *   GET /api/export/companies.csv
 *   GET /api/export/deals.csv
 *   GET /api/export/activities.csv
 */

const CONTACT_COLUMNS = ['firstName', 'lastName', 'email', 'phone', 'title', 'company', 'status', 'tags', 'notes', 'createdAt'];
const COMPANY_COLUMNS = ['name', 'industry', 'size', 'website', 'notes', 'contactCount', 'dealCount', 'openPipeline', 'createdAt'];
const DEAL_COLUMNS = ['title', 'amount', 'stage', 'company', 'contact', 'expectedClose', 'notes', 'createdAt'];
const ACTIVITY_COLUMNS = ['type', 'subject', 'body', 'contact', 'happenedAt', 'createdAt'];

function csvResponse(res, filename, headers, rows) {
  const csv = toCsv([headers, ...rows.map((r) => headers.map((h) => r[h]))]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // UTF-8 BOM so Excel opens the file with correct encoding.
  res.send('\uFEFF' + csv);
}

function tagList(tags) {
  return Array.isArray(tags) ? tags.join('; ') : '';
}

function exportRouter(db) {
  const router = express.Router();

  router.get('/contacts.csv', (req, res) => {
    const rows = db.allFor('contacts', req.userId).map((c) => {
      const company = c.companyId ? db.getFor('companies', c.companyId, req.userId) : null;
      return {
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        title: c.title,
        company: company ? company.name : '',
        status: c.status || '',
        tags: tagList(c.tags),
        notes: c.notes,
        createdAt: c.createdAt
      };
    });
    csvResponse(res, 'contacts.csv', CONTACT_COLUMNS, rows);
  });

  router.get('/companies.csv', (req, res) => {
    const rows = db.allFor('companies', req.userId).map((c) => {
      const contacts = db.allFor('contacts', req.userId).filter((ct) => ct.companyId === c.id);
      const deals = db.allFor('deals', req.userId).filter((d) => d.companyId === c.id);
      const pipeline = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost').reduce((s, d) => s + Number(d.amount || 0), 0);
      return {
        name: c.name,
        industry: c.industry,
        size: c.size,
        website: c.website,
        notes: c.notes,
        contactCount: contacts.length,
        dealCount: deals.length,
        openPipeline: pipeline,
        createdAt: c.createdAt
      };
    });
    csvResponse(res, 'companies.csv', COMPANY_COLUMNS, rows);
  });

  router.get('/deals.csv', (req, res) => {
    const rows = db.allFor('deals', req.userId).map((d) => {
      const company = d.companyId ? db.getFor('companies', d.companyId, req.userId) : null;
      const contact = d.contactId ? db.getFor('contacts', d.contactId, req.userId) : null;
      return {
        title: d.title,
        amount: d.amount,
        stage: d.stage,
        company: company ? company.name : '',
        contact: contact ? `${contact.firstName} ${contact.lastName}` : '',
        expectedClose: d.expectedClose,
        notes: d.notes,
        createdAt: d.createdAt
      };
    });
    csvResponse(res, 'deals.csv', DEAL_COLUMNS, rows);
  });

  router.get('/activities.csv', (req, res) => {
    const rows = db.allFor('activities', req.userId).map((a) => {
      const contact = a.contactId ? db.getFor('contacts', a.contactId, req.userId) : null;
      return {
        type: a.type,
        subject: a.subject,
        body: a.body,
        contact: contact ? `${contact.firstName} ${contact.lastName}` : '',
        happenedAt: a.happenedAt || a.createdAt,
        createdAt: a.createdAt
      };
    });
    csvResponse(res, 'activities.csv', ACTIVITY_COLUMNS, rows);
  });

  return router;
}

module.exports = exportRouter;
