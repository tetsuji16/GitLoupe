import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  messageEditorSource,
  nodeScriptCommand,
  rewriteRebaseTodo,
  rewriteRebaseTodoMany,
  sequenceEditorSource
} from '../src/rewrite.js';

test('rewriteRebaseTodo applies reword, squash, and drop to an exact commit', () => {
  const todo = 'pick abc123 first\npick def456 second\npick 789abc third\n';
  assert.match(rewriteRebaseTodo(todo, 'reword', 'def4560000'), /^reword def456 second$/m);
  assert.match(rewriteRebaseTodo(todo, 'squash', 'def4560000'), /^squash def456 second$/m);
  assert.match(rewriteRebaseTodo(todo, 'drop', 'def4560000'), /^drop def456 second$/m);
  assert.throws(() => rewriteRebaseTodo(todo, 'drop', 'eeeeee'), /not present/);
  const dropped = rewriteRebaseTodoMany(todo, 'drop', ['abc123000', '789abc000']);
  assert.match(dropped, /^drop abc123 first$/m);
  assert.match(dropped, /^drop 789abc third$/m);
});

test('sequence and message editors drive a real interactive rebase', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitloupe-rewrite-test-'));
  const sequence = path.join(root, 'sequence.cjs');
  const editor = path.join(root, 'editor.cjs');
  const run = (args: string[], env?: NodeJS.ProcessEnv): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  try {
    run(['init', '-q']);
    run(['config', 'user.name', 'GitLoupe Test']);
    run(['config', 'user.email', 'gitloupe@example.test']);
    writeFileSync(sequence, sequenceEditorSource);
    writeFileSync(editor, messageEditorSource);
    const commits: Array<[string, string]> = [['first', 'a'], ['second', 'a\nb'], ['third', 'a\nb\nc']];
    for (const [name, content] of commits) {
      writeFileSync(path.join(root, 'file.txt'), content);
      run(['add', 'file.txt']);
      run(['commit', '-q', '-m', name]);
    }
    const target = run(['rev-parse', 'HEAD~1']);
    run(['rebase', '-i', 'HEAD~2'], {
      GIT_SEQUENCE_EDITOR: nodeScriptCommand(sequence),
      GIT_EDITOR: nodeScriptCommand(editor),
      GITLOUPE_REBASE_ACTION: 'reword',
      GITLOUPE_REBASE_TARGETS: JSON.stringify([target]),
      GITLOUPE_REBASE_MESSAGE: 'renamed second'
    });
    assert.deepEqual(run(['log', '--format=%s']).split(/\r?\n/), ['third', 'renamed second', 'first']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
