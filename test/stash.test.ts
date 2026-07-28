import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStashes } from '../src/parsers.js';

const FIELD = '\x1f';

test('parseStashes reads index, ref, hash, and message', () => {
  const output = [
    `aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111${FIELD}1700000000${FIELD}stash@{0}${FIELD}On main: WIP thing`,
    `bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222${FIELD}1700001000${FIELD}stash@{1}${FIELD}On main: experiment`
  ].join('\n');

  const stashes = parseStashes(output);
  assert.equal(stashes.length, 2);
  assert.deepEqual(stashes[0], {
    index: 0,
    ref: 'stash@{0}',
    hash: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
    timestamp: 1700000000,
    message: 'On main: WIP thing'
  });
  assert.equal(stashes[1]!.index, 1);
  assert.equal(stashes[1]!.ref, 'stash@{1}');
  assert.equal(stashes[1]!.message, 'On main: experiment');
});

test('parseStashes returns an empty list for empty output', () => {
  assert.deepEqual(parseStashes(''), []);
  assert.deepEqual(parseStashes('\n\n'), []);
});

test('parseStashes resolves a real repository stash list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitloupe-stash-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  git('init', '-q');
  git('config', 'user.name', 'Alice');
  git('config', 'user.email', 'alice@example.com');
  writeFileSync(join(dir, 'file.txt'), 'one\ntwo\n');
  git('add', 'file.txt');
  git('commit', '-q', '-m', 'initial');

  git('config', 'user.name', 'Bob');
  git('config', 'user.email', 'bob@example.com');
  writeFileSync(join(dir, 'file.txt'), 'ONE\ntwo\n');
  git('stash', 'push', '-q', '-m', 'my stash');

  const raw = git('stash', 'list', '--format=' + `%H${FIELD}%at${FIELD}%gd${FIELD}%s`);
  const stashes = parseStashes(raw);
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0]!.index, 0);
  assert.equal(stashes[0]!.ref, 'stash@{0}');
  assert.ok(stashes[0]!.hash.length === 40);
  assert.ok(stashes[0]!.timestamp > 0);
  assert.match(stashes[0]!.message, /my stash/);
});
