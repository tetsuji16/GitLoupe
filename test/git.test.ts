import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommits, parseFileHistory, parseStatus, parseWorktrees } from '../src/parsers.js';
import { parseGraphSearchQuery } from '../src/search.js';

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
    subject: 'Ship it',
    added: 0,
    deleted: 0
  }]);
});

test('parseCommits includes text change totals', () => {
  const output = `${record}abc123${field}${field}Ada${field}ada@example.com${field}1700000000${field}${field}Ship it\n3\t2\tfile.ts\n-\t-\timage.png\n`;
  const [commit] = parseCommits(output);
  assert.equal(commit?.added, 3);
  assert.equal(commit?.deleted, 2);
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

test('parseStatus reads branch tracking and working files', () => {
  const output = [
    '# branch.oid abc123',
    '# branch.head feature',
    '# branch.upstream origin/feature',
    '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 abc def staged.ts',
    '1 .M N... 100644 100644 100644 abc def working.ts',
    '? new file.ts'
  ].join('\0') + '\0';
  const status = parseStatus(output);
  assert.equal(status.branch, 'feature');
  assert.equal(status.upstream, 'origin/feature');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.files.map(file => [file.path, file.staged, file.unstaged]), [
    ['staged.ts', true, false],
    ['working.ts', false, true],
    ['new file.ts', false, true]
  ]);
});

test('parseStatus handles rename records, paths with spaces, and conflicts', () => {
  const output = [
    '# branch.head main',
    '2 R. N... 100644 100644 100644 abc def R100 renamed file.ts',
    'old file.ts',
    'u UU N... 100644 100644 100644 100644 abc def 123 conflicted file.ts'
  ].join('\0') + '\0';
  const status = parseStatus(output);
  assert.deepEqual(status.files[0], {
    path: 'renamed file.ts',
    oldPath: 'old file.ts',
    indexStatus: 'R',
    worktreeStatus: '.',
    staged: true,
    unstaged: false,
    untracked: false,
    conflicted: false
  });
  assert.equal(status.files[1]?.path, 'conflicted file.ts');
  assert.equal(status.files[1]?.conflicted, true);
});

test('parseGraphSearchQuery extracts quoted file and change filters', () => {
  assert.deepEqual(
    parseGraphSearchQuery('author:Ada file:"src/a b.ts" change:"old API" message:fix'),
    { files: ['src/a b.ts'], changes: ['old API'] }
  );
});

test('parseGraphSearchQuery ignores empty and unsafe values', () => {
  assert.deepEqual(
    parseGraphSearchQuery('file: change:"" file:"bad\0path" CHANGE:needle'),
    { files: [], changes: ['needle'] }
  );
});
