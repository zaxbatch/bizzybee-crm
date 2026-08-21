'use strict';

/**
 * Stage the Netlify publish directory (site/):
 *
 *   site/index.html      ← landing/index.html        (marketing page at /)
 *   site/app/*           ← public/*                  (CRM frontend at /app/)
 *
 * The CRM's API is served by netlify/functions/api.js and reached through the
 * /api/* redirect in netlify.toml, so the static app needs no changes.
 *
 * Usage: node scripts/build-site.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const APP_DIR = path.join(SITE_DIR, 'app');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(SITE_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });

fs.copyFileSync(path.join(ROOT, 'landing', 'index.html'), path.join(SITE_DIR, 'index.html'));
copyDir(path.join(ROOT, 'public'), APP_DIR);

console.log('✔ Staged site/');
console.log('   - site/index.html  (landing)');
console.log('   - site/app/        (CRM frontend)');
