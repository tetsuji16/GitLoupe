import assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('tetsuji16.gitloupe');
  assert.ok(extension, 'GitLoupe extension should be available in the Extension Host.');
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'gitloupe.openGraph',
    'gitloupe.openFileHistory',
    'gitloupe.manageSelectedFiles',
    'gitloupe.toggleFileBlame',
    'gitloupe.fileRevisionPrevious',
    'gitloupe.fileRevisionNext',
    'gitloupe.ollama.selectModel'
  ]) {
    assert.ok(commands.includes(command), `Expected registered command: ${command}`);
  }
}
