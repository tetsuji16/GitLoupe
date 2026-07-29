import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'gitloupe-workflow-'));
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'GitLoupe Test');
  await git(root, 'config', 'user.email', 'gitloupe@example.test');
  await writeFile(path.join(root, 'file.txt'), 'one\ntwo\nthree\n');
  await git(root, 'add', 'file.txt');
  await git(root, 'commit', '-m', 'initial');
  return root;
}

test('partial-stage bases produce staged, unstaged, and combined diffs', async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, 'file.txt'), 'ONE\ntwo\nthree\n');
    await git(root, 'add', 'file.txt');
    await writeFile(path.join(root, 'file.txt'), 'ONE\ntwo\nTHREE\n');
    const staged = await git(root, 'diff', '--cached', '--', 'file.txt');
    const unstaged = await git(root, 'diff', '--', 'file.txt');
    const combined = await git(root, 'diff', 'HEAD', '--', 'file.txt');
    assert.match(staged, /ONE/);
    assert.doesNotMatch(staged, /THREE/);
    assert.match(unstaged, /THREE/);
    assert.doesNotMatch(unstaged, /-one/);
    assert.match(combined, /ONE/);
    assert.match(combined, /THREE/);

    await git(root, 'restore', '--worktree', '--', 'file.txt');
    assert.equal((await readFile(path.join(root, 'file.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'ONE\ntwo\nthree\n');
    assert.match(await git(root, 'diff', '--cached'), /ONE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manual conflict side selection can be staged and continued', async () => {
  const root = await repository();
  try {
    const base = (await git(root, 'branch', '--show-current')).trim();
    await git(root, 'checkout', '-b', 'incoming');
    await writeFile(path.join(root, 'file.txt'), 'incoming\n');
    await git(root, 'commit', '-am', 'incoming');
    await git(root, 'checkout', base);
    await writeFile(path.join(root, 'file.txt'), 'current\n');
    await git(root, 'commit', '-am', 'current');
    await assert.rejects(() => git(root, 'merge', 'incoming'));
    await git(root, 'checkout', '--ours', '--', 'file.txt');
    await git(root, 'add', '--', 'file.txt');
    assert.equal((await git(root, 'diff', '--name-only', '--diff-filter=U')).trim(), '');
    assert.equal((await readFile(path.join(root, 'file.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'current\n');
    await git(root, '-c', 'core.editor=true', 'merge', '--continue');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
