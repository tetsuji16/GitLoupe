import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlame } from '../src/parsers.js';

const A = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const B = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222';
const C = 'cccc3333cccc3333cccc3333cccc3333cccc3333';
const D = 'dddd4444dddd4444dddd4444dddd4444dddd4444';

test('parseBlame maps each line to its commit', () => {
  const output = [
    `${A} 1 1 1`,
    'author Alice',
    'author-mail <alice@example.com>',
    'author-time 1700000000',
    'author-tz +0000',
    'committer Alice',
    'committer-mail <alice@example.com>',
    'committer-time 1700000000',
    'summary First commit',
    'filename file.txt',
    '\tline one',
    `${B} 2 2 1`,
    'author Bob',
    'author-mail <bob@example.com>',
    'author-time 1700001000',
    'summary Second commit',
    'filename file.txt',
    '\tline two'
  ].join('\n');

  assert.deepEqual(parseBlame(output), [
    { line: 1, hash: A, author: 'Alice', email: 'alice@example.com', timestamp: 1700000000, summary: 'First commit', uncommitted: false },
    { line: 2, hash: B, author: 'Bob', email: 'bob@example.com', timestamp: 1700001000, summary: 'Second commit', uncommitted: false }
  ]);
});

test('parseBlame expands multi-line hunks', () => {
  const output = [
    `${C} 1 1 3`,
    'author Carol',
    'author-mail <carol@example.com>',
    'author-time 1700002000',
    'summary Three lines',
    'filename f.txt',
    '\talpha',
    '\tbeta',
    '\tgamma'
  ].join('\n');

  const lines = parseBlame(output);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(entry => entry.line), [1, 2, 3]);
  assert.ok(lines.every(entry => entry.hash === C && entry.author === 'Carol'));
});

test('parseBlame flags uncommitted lines', () => {
  const output = [
    '0000000000000000000000000000000000000000 1 1 1',
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'summary ',
    'filename f.txt',
    '\tfoo'
  ].join('\n');

  const lines = parseBlame(output);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.uncommitted, true);
  assert.equal(lines[0]!.author, 'Not Committed Yet');
});

test('parseBlame tolerates boundary markers', () => {
  const output = [
    `(${D}) 1 1 1`,
    'author Dan',
    'author-mail <dan@example.com>',
    'author-time 1700003000',
    'summary Boundary',
    'filename f.txt',
    '\tbar'
  ].join('\n');

  const lines = parseBlame(output);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.author, 'Dan');
  assert.equal(lines[0]!.hash, D);
});
