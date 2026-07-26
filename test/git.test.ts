import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommits, parseFileHistory, parseWorktrees } from '../src/parsers.js';

const record = '\x1e';
const field = '\x1f';

test('parseCommits parses parents and decorations', () => {
  const output = `${record}abc123${field}def456 987aaa${field}Ada${field}ada@example.com${field}1700000000${field}HEAD -> main, tag: v1${field}Ship it\n`;
  assert.deepEqual(parseCommits(output), [{
    hash: 'abc123',
    parents: ['def456', '987aaa'],
    author: 'Ada',
    email: 'ada@example.com',
    timestamp: 1700000000,
    refs: ['HEAD -> main', 'tag: v1'],
    subject: 'Ship it'
  }]);
});

test('parseFileHistory sums text changes and ignores binary markers', () => {
  const output = `${record}abc123${field}${field}Ada${field}ada@example.com${field}1700000000${field}${field}Change file\n3\t2\tfile.ts\n-\t-\timage.png\n`;
  const [entry] = parseFileHistory(output);
  assert.equal(entry?.added, 3);
  assert.equal(entry?.deleted, 2);
});

test('parseWorktrees reads porcelain zero-delimited output', () => {
  const output = [
    'worktree C:/repo',
    'HEAD abc123',
    'branch refs/heads/main',
    'worktree C:/repo-feature',
    'HEAD def456',
    'detached'
  ].join('\0') + '\0';
  assert.deepEqual(parseWorktrees(output), [
    { path: 'C:/repo', head: 'abc123', branch: 'main', bare: false, detached: false },
    { path: 'C:/repo-feature', head: 'def456', bare: false, detached: true }
  ]);
});
