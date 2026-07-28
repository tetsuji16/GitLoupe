import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBlame } from '../src/parsers.js';

test('parseBlame resolves a real repository blame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitloupe-blame-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  git('init', '-q');
  git('config', 'user.name', 'Alice');
  git('config', 'user.email', 'alice@example.com');
  writeFileSync(join(dir, 'file.txt'), 'one\ntwo\nthree\n');
  git('add', 'file.txt');
  git('commit', '-q', '-m', 'initial');

  git('config', 'user.name', 'Bob');
  git('config', 'user.email', 'bob@example.com');
  writeFileSync(join(dir, 'file.txt'), 'one\nTWO\nthree\n');
  git('add', 'file.txt');
  git('commit', '-q', '-m', 'edit line two');

  const lines = parseBlame(git('blame', '--porcelain', '--date=unix', '--', 'file.txt'));
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.author, 'Alice');
  assert.equal(lines[1]!.author, 'Bob');
  assert.equal(lines[1]!.summary, 'edit line two');
  assert.equal(lines[2]!.author, 'Alice');

  const single = parseBlame(git('blame', '--porcelain', '--date=unix', '-L', '2,2', '--', 'file.txt'));
  assert.equal(single.length, 1);
  assert.equal(single[0]!.line, 2);
  assert.equal(single[0]!.author, 'Bob');
});
