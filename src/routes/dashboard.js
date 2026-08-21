'use strict';

const express = require('express');
const { DEAL_STAGES } = require('../db');

function dashboardRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const contacts = db.allFor('contacts', req.userId);
    const companies = db.allFor('companies', req.userId);
    const deals = db.allFor('deals', req.userId);
    const activities = db.allFor('activities', req.userId);

    const openDeals = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
    const wonDeals = deals.filter((d) => d.stage === 'won');

    const byStage = DEAL_STAGES.map((stage) => {
      const stageDeals = deals.filter((d) => d.stage === stage);
      return {
        stage,
        count: stageDeals.length,
        total: stageDeals.reduce((s, d) => s + Number(d.amount || 0), 0)
      };
    });

    const recentActivities = activities
      .slice()
      .sort((a, b) => new Date(b.happenedAt || b.createdAt) - new Date(a.happenedAt || a.createdAt))
      .slice(0, 10)
      .map((a) => {
        const contact = a.contactId ? db.getFor('contacts', a.contactId, req.userId) : null;
        return { ...a, contactName: contact ? `${contact.firstName} ${contact.lastName}` : null };
      });

    res.json({
      counts: {
        contacts: contacts.length,
        companies: companies.length,
        openDeals: openDeals.length,
        wonDeals: wonDeals.length,
        activities: activities.length
      },
      totals: {
        openPipeline: openDeals.reduce((s, d) => s + Number(d.amount || 0), 0),
        wonRevenue: wonDeals.reduce((s, d) => s + Number(d.amount || 0), 0)
      },
      dealsByStage: byStage,
      recentActivities
    });
  });

  return router;
}

module.exports = dashboardRouter;
