# BizzyBee CRM

A lightweight CRM for small teams, brought to you by **Z Dot LLC** — with a
subscription model: **Free / Pro ($19/mo) / Business ($49/mo)**.

- Contacts, companies, deals (pipeline), activities, dashboard, CSV export/import
- **Reyna** — the AI assistant (Pro/Business): ask about your workspace, draft
  emails & follow-ups, summarize records with next steps, sales coaching, and
  note polish. Monthly credit caps (Pro 300 / Business 5,000), server-side.
- Teams with roles — **Admin / Editor / Viewer**, customizable per-role and
  per-member privileges, and member subcategories (Sales, Marketing, HR, …)
- Seats include the account owner: **Free 1 (solo), Pro 5, Business 7,500**
- Per-account private workspaces with real login protection
- Plan limits enforced server-side (contacts, seats, custom fields, subcategories)
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
| `HUBSPOT_ACCESS_TOKEN` | Sign-ups are synced to the Z Dot LLC CRM |
| `OPENAI_API_KEY` | Reyna (AI assistant). Any OpenAI-compatible key works |
| `OPENAI_BASE_URL` / `OPENAI_MODEL` | Optional provider override (default `https://api.openai.com/v1`, `gpt-4o-mini`) |
| `NETLIFY_AUTH_TOKEN` / `NETLIFY_AUTH_TOKEN_ZDOT` | Blob-store access + deploys |
| `NETLIFY_SITE_ID` | Blob-store scope (set on the site by the deploy script) |

## Plans

Single source of truth: `src/plans.js`. Exposed via `GET /api/account`
(plan, limits, live usage, prices) and switched via `PUT /api/account/plan`
(owner-only; open during preview — gating auto-activates when
`BIZZYBEE_ADMIN_KEY` is set).

Teams: every workspace has a seat allowance that includes the owner
(Free 1 → owner only, Pro 5, Business 7,500). Reyna — the AI assistant — is
gated to Pro/Business with a per-workspace monthly credit cap
(`limits.aiCredits`: Pro 300, Business 5,000) tracked in `owner.workspace.aiUsage`
and reset monthly. Invited members get a role
(Admin / Editor / Viewer) and an optional subcategory. Privileges come from
`src/permissions.js` (role defaults + workspace role presets + per-member
overrides) and are enforced on every `/api` route. Built-in subcategories
(Sales, Marketing, HR, Finance, Support, Operations) ship on every plan;
custom ones are plan-gated (Free 0, Pro 2, Business unlimited).
