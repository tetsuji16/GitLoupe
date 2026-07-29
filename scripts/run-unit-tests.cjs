const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testRoot = path.resolve(__dirname, '..', 'test');
const files = [];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolute);
    else if (entry.name.endsWith('.test.ts')) files.push(absolute);
  }
}

collect(testRoot);
files.sort();

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' }
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
