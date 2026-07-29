const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'dist-test', 'test', 'suite', 'index.js'),
    launchArgs: [path.join(root, 'test', 'fixtures', 'workspace'), '--disable-extensions']
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
