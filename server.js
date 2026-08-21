'use strict';

const { createApp } = require('./src/app');
const { port } = require('./src/config');

const app = createApp();

app.listen(port, () => {
  console.log(`\n  🐝 BizzyBee CRM running at http://localhost:${port}`);
  console.log(`  API health check: http://localhost:${port}/api/health\n`);
});
