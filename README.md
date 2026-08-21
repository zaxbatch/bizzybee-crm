# BizzyBee CRM

A lightweight CRM for small teams, brought to you by **Z Dot LLC** — with a
subscription model: **Free / Pro ($19/mo) / Business ($49/mo)**.

- Contacts, companies, deals (pipeline), activities, dashboard, CSV export/import
- Per-account private workspaces with real login protection
- Plan limits enforced server-side (contacts; pipelines & custom fields pre-wired)
- Runs locally (Express + JSON file) or serverless (Netlify Functions + Blobs)

## Run locally

```bash
npm install
npm start          # → http://localhost:3000
npm test           # test suite (node:test)
```

## Deployment

`netlify.toml` builds the publish dir with `scripts/build-site.js`
(landing → `/`, CRM frontend → `/app/`) and serves the whole API as a Netlify
Function (`/api/*`). Data persists in Netlify Blobs.

Environment variables (never committed — set in `.env` locally / Netlify env vars):

| Variable | Purpose |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Sign-ups are synced to the Z Dot LLC HubSpot portal |
| `NETLIFY_AUTH_TOKEN` / `NETLIFY_AUTH_TOKEN_ZDOT` | Blob-store access + deploys |
| `NETLIFY_SITE_ID` | Blob-store scope (set on the site by the deploy script) |

## Plans

Single source of truth: `src/plans.js`. Exposed via `GET /api/account`
(plan, limits, live usage, prices) and switched via `PUT /api/account/plan`
(open during preview; gating auto-activates when `BIZZYBEE_ADMIN_KEY` is set).
