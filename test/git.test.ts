import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { countTextLines, parseCommits, parseFileHistory, parseStatus, parseWorktrees, parseCommitColumns } from '../src/parsers.js';
import { parseGraphSearchQuery } from '../src/search.js';
import { safeRepositoryPath } from '../src/security.js';

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
    // Real `git status --porcelain=v2` unmerged ("u") line: same 9 fields as a "1"
    // line, so the path is at index 8 (NOT 10). The earlier fixture padded it with
    // two bogus fields, which masked a bug that dropped the path to "".
    'u UU N... 100644 100644 100644 abc def conflicted file.ts'
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

test('parseStatus recovers the path for a real unmerged conflict', () => {
  // Both sides modified: classic "UU" conflict. Path must not collapse to "".
  const output = 'u UU N... 100644 100644 100644 deadbeef cafebabe path with space.ts';
  const status = parseStatus(output);
  assert.equal(status.files.length, 1);
  assert.equal(status.files[0]?.path, 'path with space.ts');
  assert.equal(status.files[0]?.conflicted, true);
  assert.equal(status.files[0]?.staged, true);
  assert.equal(status.files[0]?.unstaged, true);
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

test('countTextLines matches Git numstat semantics for empty and terminated files', () => {
  assert.equal(countTextLines(''), 0);
  assert.equal(countTextLines('one\n'), 1);
  assert.equal(countTextLines('one\r\ntwo'), 2);
});

test('safeRepositoryPath rejects paths that escape the repository root', () => {
  const root = 'C:/repos/project';
  // Inside the repo: allowed (path.resolve normalizes to the OS separator).
  assert.equal(safeRepositoryPath(root, 'src/file.ts'), path.join('C:/repos/project', 'src/file.ts'));
  assert.equal(safeRepositoryPath(root, 'nested/dir/../file.ts'), path.join('C:/repos/project', 'nested/file.ts'));
  // Path traversal escapes the repo: must throw.
  assert.throws(() => safeRepositoryPath(root, '../secrets.txt'));
  assert.throws(() => safeRepositoryPath(root, '../../etc/passwd'));
});

test('parseCommitColumns reads the graph column for every commit, even when the hash is preceded by graph chars', () => {
  // `git log --graph` may pad the commit marker with drawing chars, e.g.
  // `* |   a1b2c3...` — the hash is not the first whitespace token.
  const graph = [
    '* a1b2c3d4e5f6',
    '| * b2c3d4e5f6a7',
    '* |   c3d4e5f6a7b8',
    '|/  ',
    '* d4e5f6a7b8c3'
  ].join('\n');
  const columns = parseCommitColumns(graph);
  assert.equal(columns.get('a1b2c3d4e5f6'), 0);
  assert.equal(columns.get('b2c3d4e5f6a7'), 1);
  assert.equal(columns.get('c3d4e5f6a7b8'), 0);
  assert.equal(columns.get('d4e5f6a7b8c3'), 0);
  // Continuation-only lines (`|/`) carry no commit and are ignored.
  assert.equal(columns.size, 4);
});
