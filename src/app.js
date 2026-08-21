'use strict';

const path = require('path');
const express = require('express');
const { Db } = require('./db');
const config = require('./config');
const { authRouter, requireAuth } = require('./auth');
const { createHubspotClient } = require('./hubspot');
const contactsRouter = require('./routes/contacts');
const companiesRouter = require('./routes/companies');
const dealsRouter = require('./routes/deals');
const activitiesRouter = require('./routes/activities');
const dashboardRouter = require('./routes/dashboard');
const exportRouter = require('./routes/export');
const importRouter = require('./routes/import');
const accountRouter = require('./routes/account');

/**
 * Builds and configures the Express application.
 * The Db instance is created here and injected into every router,
 * which keeps the routes easy to test in isolation.
 */
function createApp(options = {}) {
  const db = options.db || new Db(options.dataFile);
  db.load();

  // HubSpot sign-up sync. Tests pass { hubspot: false }; production builds the
  // real client from HUBSPOT_ACCESS_TOKEN. A custom client can be injected too.
  const hubspot = options.hubspot === false
    ? null
    : (options.hubspot || createHubspotClient({ token: config.hubspot.token }));

  if (options.log !== false) {
    console.log(hubspot
      ? '  CRM sign-up sync: ENABLED — new accounts are added to your CRM'
      : '  CRM sign-up sync: DISABLED — set HUBSPOT_ACCESS_TOKEN to enable');
  }

  const app = express();
  // 2mb JSON limit so CSV imports (sent as { csv: "..." }) fit comfortably.
  app.use(express.json({ limit: '2mb' }));

  // Simple request log (skip in tests unless requested)
  if (options.log !== false) {
    app.use((req, res, next) => {
      res.on('finish', () => {
        console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode}`);
      });
      next();
    });
  }

  // Auth endpoints are public; everything else under /api requires a session.
  app.use('/api/auth', authRouter(db, hubspot));

  app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // Gate every other /api route behind a valid session.
  app.use('/api', requireAuth(db));

  // API
  app.use('/api/account', accountRouter(db, { adminKey: options.adminKey || config.adminKey }));
  app.use('/api/contacts', contactsRouter(db));
  app.use('/api/companies', companiesRouter(db));
  app.use('/api/deals', dealsRouter(db));
  app.use('/api/activities', activitiesRouter(db));
  app.use('/api/dashboard', dashboardRouter(db));
  app.use('/api/export', exportRouter(db));
  app.use('/api/import', importRouter(db));

  // Global search across the authenticated user's contacts, companies and deals
  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ contacts: [], companies: [], deals: [] });
    const match = (values) => values.filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    const contacts = db.allFor('contacts', req.userId).filter((c) => match([c.firstName, c.lastName, c.email, c.title, c.phone, ...(c.tags || [])]));
    const companies = db.allFor('companies', req.userId).filter((c) => match([c.name, c.industry, c.website, c.size]));
    const deals = db.allFor('deals', req.userId).filter((d) => match([d.title, d.notes]));
    res.json({
      contacts: contacts.map((c) => ({ ...c, type: 'contact' })),
      companies: companies.map((c) => ({ ...c, type: 'company' })),
      deals: deals.map((d) => ({ ...d, type: 'deal' }))
    });
  });

  // Static frontend
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 404 for unknown API routes
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Central error handler
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp, Db };
