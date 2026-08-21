'use strict';

/**
 * Deploy the BizzyBee landing page to Netlify (brought to you by Z Dot LLC).
 *
 * Steps:
 *   1. Load credentials from the repo-root .env (NETLIFY_AUTH_TOKEN,
 *      HUBSPOT_ACCESS_TOKEN).
 *   2. Find or create the Netlify site named "bizzybee-zdotllc".
 *   3. Put HUBSPOT_ACCESS_TOKEN into the site's environment so the lead
 *      function can forward sign-ups to HubSpot.
 *   4. Deploy the landing dir + functions to production via netlify-cli.
 *   5. Attach the custom domain bizzybee.zdotllc.com.
 *
 * Usage: node scripts/deploy-netlify.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '..', '.env');
const SITE_NAME = 'bizzybee-zdotllc';
const CUSTOM_DOMAIN = 'bizzybee.zdotllc.com';
const NETLIFY_API = 'https://api.netlify.com/api/v1';

// ---- Load .env (without overwriting already-set vars) ----------------------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv(ENV_FILE);

// Prefer the Z Dot LLC account token (owns zdotllc.com / bizzybee.zdotllc.com),
// fall back to the generic account token.
const TOKEN = process.env.NETLIFY_AUTH_TOKEN_ZDOT || process.env.NETLIFY_AUTH_TOKEN;
const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

if (!TOKEN) {
  console.error('NETLIFY_AUTH_TOKEN_ZDOT / NETLIFY_AUTH_TOKEN is missing (check ../.env)');
  process.exit(1);
}

// ---- Tiny Netlify API helper ----------------------------------------------

async function api(method, urlPath, body) {
  const res = await fetch(NETLIFY_API + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function findOrCreateSite() {
  const { data: sites } = await api('GET', '/sites?per_page=100');
  const existing = (sites || []).find((s) => s.name === SITE_NAME);
  if (existing) {
    console.log(`✔ Using existing site "${SITE_NAME}" — ${existing.ssl_url || existing.url}`);
    return existing;
  }
  const { status, data } = await api('POST', '/sites', { name: SITE_NAME });
  if (status >= 300 || !data || !data.id) {
    throw new Error(`Could not create site (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  console.log(`✔ Created site "${SITE_NAME}" — ${data.ssl_url || data.url}`);
  return data;
}

async function setSiteEnvVar(siteId, key, value) {
  try {
    // Account-scoped env API, scoped to one site via ?site_id=.
    // The `scopes` field is skipped on purpose — it requires a paid plan.
    const { data: accounts } = await api('GET', '/accounts');
    const accountId = Array.isArray(accounts) && accounts[0] && accounts[0].id;
    if (!accountId) throw new Error('no account found');
    const { status, data } = await api('POST', `/accounts/${accountId}/env?site_id=${siteId}`, [{
      key,
      values: [{ context: 'production', value }]
    }]);
    // 422 "already exists" is fine — the variable is in place either way.
    const alreadyExists = status === 422 && /already exists/i.test(JSON.stringify(data || ''));
    if (status >= 300 && !alreadyExists) {
      console.warn(`⚠ Could not set ${key} env var (HTTP ${status}): ${JSON.stringify(data).slice(0, 200)} — set it manually in the Netlify dashboard.`);
      return false;
    }
    console.log(`✔ ${key} env var present on the site.`);
    return true;
  } catch (err) {
    console.warn(`⚠ Could not set ${key} env var: ${err.message}`);
    return false;
  }
}

async function attachCustomDomain(siteId) {
  const { status, data } = await api('PUT', `/sites/${siteId}`, { custom_domain: CUSTOM_DOMAIN });
  if (status >= 300 || !data) {
    console.warn(`⚠ Could not attach custom domain (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`);
    return false;
  }
  console.log(`✔ Custom domain set to ${CUSTOM_DOMAIN}`);
  return true;
}

// ---- Main -------------------------------------------------------------------

async function main() {
  const site = await findOrCreateSite();

  if (HUBSPOT_TOKEN) {
    await setSiteEnvVar(site.id, 'HUBSPOT_ACCESS_TOKEN', HUBSPOT_TOKEN);
  } else {
    console.warn('⚠ HUBSPOT_ACCESS_TOKEN not found — landing lead capture will report "not configured".');
  }

  // The API function persists via Netlify Blobs; CLI-uploaded function zips
  // don't receive the ambient blobs context, so the function reads the site id
  // and an API token from site env vars (see src/db.js).
  await setSiteEnvVar(site.id, 'NETLIFY_SITE_ID', site.id);
  await setSiteEnvVar(site.id, 'NETLIFY_AUTH_TOKEN', TOKEN);

  console.log('\nStaging the publish dir (landing + CRM frontend)…');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-site.js')], { cwd: ROOT, stdio: 'inherit' });

  console.log('\nDeploying via netlify-cli…');
  // npm's default cache under ~/.npm may contain root-owned files in this
  // environment, so use a scratch cache. The token is passed through the
  // child's environment (not argv) so it never shows up in process listings.
  const deployArgs = [
    '-y', 'netlify-cli', 'deploy',
    '--dir', 'site',
    '--functions', 'netlify/functions',
    '--prod',
    '--site', site.id,
    '--message', 'BizzyBee CRM (landing + app) — brought to you by Z Dot LLC'
  ];
  execFileSync('npx', deployArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NETLIFY_AUTH_TOKEN: TOKEN,
      // ~/.npm and ~/.config are root-owned in this environment, so point both
      // at a scratch location the CLI can actually write to.
      npm_config_cache: path.join(require('os').tmpdir(), 'npm-cache-zdotllc'),
      XDG_CONFIG_HOME: path.join(require('os').tmpdir(), 'xdg-config-zdotllc')
    }
  });

  await attachCustomDomain(site.id);

  console.log('\n──────────────────────────────────────────────');
  console.log(`  Landing:  ${site.ssl_url || site.url}/`);
  console.log(`  CRM app:  ${site.ssl_url || site.url}/app/`);
  console.log(`  API:      ${site.ssl_url || site.url}/api/health`);
  if (CUSTOM_DOMAIN) {
    console.log(`  Custom domain: https://${CUSTOM_DOMAIN}`);
    console.log('  (DNS: point a CNAME from ' + CUSTOM_DOMAIN + ' to ' +
      String(site.ssl_url || site.url).replace(/^https?:\/\//, '') + ')');
  }
  console.log('──────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('Deploy failed:', err.message);
  process.exit(1);
});
