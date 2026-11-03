// Zero-dep runner for the live gateway test suites.
// Usage: node tests/run.js

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['user-tools.test.mjs', 'isolated-token.test.mjs'];

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const r = spawnSync('node', [join(here, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed}/${suites.length} test file(s) FAILED`);
  process.exit(1);
}
console.log(`\nALL ${suites.length} LIVE GATEWAY TEST FILES PASSED`);
