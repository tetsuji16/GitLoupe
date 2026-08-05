import assert from 'node:assert/strict';
import test from 'node:test';
import { graphWorkbenchHtml } from '../src/graphWebview.js';
import { visualFileHistoryHtml } from '../src/visualHistoryWebview.js';
import { launchpadHtml } from '../src/launchpadWebview.js';
import { homeViewHtml } from '../src/homeWebview.js';
import { inspectViewHtml } from '../src/inspectWebview.js';
import { welcomeViewHtml } from '../src/welcomeWebview.js';
import { graphState, type GraphCommit } from '../src/graphLayout.js';

function assertEmbeddedScriptCompiles(html: string): void {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'Expected an embedded webview script.');
  assert.doesNotThrow(() => new Function(script));
}

test('Graph Workbench embedded script compiles', () => {
  assertEmbeddedScriptCompiles(graphWorkbenchHtml('test-nonce'));
});

test('Visual History embedded script compiles', () => {
  assertEmbeddedScriptCompiles(visualFileHistoryHtml('src/file.ts', [], 'test-nonce'));
});

test('Launchpad embedded script compiles', () => {
  assertEmbeddedScriptCompiles(launchpadHtml('test-nonce'));
});

test('Home view embedded script compiles', () => {
  const html = homeViewHtml(
    [{ name: 'GitLoupe', root: '/workspace/GitLoupe', branch: 'main' }],
    new Map([['/workspace/GitLoupe', [{
      ref: 'stash@{0}',
      message: 'WIP: sidebar refresh',
      timestamp: Math.floor(Date.now() / 1000)
    }]]]),
    'test-nonce'
  );
  assertEmbeddedScriptCompiles(html);
  assert.match(html, /Repositories \(1\)/);
  assert.match(html, /Stashes \(1\)/);
});

test('Welcome and Inspect embedded scripts compile', () => {
  assertEmbeddedScriptCompiles(welcomeViewHtml('test-nonce'));
  assertEmbeddedScriptCompiles(inspectViewHtml('test-nonce'));
});

test('graphState draws an edge for every parent and threads the first parent down its lane', () => {
  const commits: GraphCommit[] = [
    { hash: 'm', parents: ['c1', 'c2', 'c3'] },
    { hash: 'c1', parents: ['r'] },
    { hash: 'c2', parents: ['r'] },
    { hash: 'c3', parents: ['r'] },
    { hash: 'r', parents: [] }
  ];
  const states = graphState(commits);
  states.forEach((state, index) => {
    const commit = commits[index]!;
    const parents = commit.parents;
    // Every parent (including merge parents) must be reachable from the
    // commit's `after` lanes so a visible edge is always drawn.
    for (const parent of parents) {
      assert.ok(parent === '' || state.after.includes(parent), `parent ${parent} of ${commit.hash} must be present in after lanes`);
    }
    // The first parent continues straight down the commit's own lane.
    const first = parents[0];
    if (first) assert.equal(state.after[state.lane], first, `first parent of ${commit.hash} must continue down its own lane`);
  });
});

test('graphState honors git-provided column for pixel-parity with GitLens', () => {
  // Mirrors `git log --graph` output for a criss-cross merge: lanes [0,1,0,1,0].
  const commits: GraphCommit[] = [
    { hash: 'e', parents: ['d', 'c'], column: 0 },
    { hash: 'd', parents: ['c'], column: 1 },
    { hash: 'c', parents: ['b', 'a'], column: 0 },
    { hash: 'b', parents: ['a'], column: 1 },
    { hash: 'a', parents: [], column: 0 }
  ];
  const states = graphState(commits);
  assert.deepEqual(states.map(s => s.lane), [0, 1, 0, 1, 0]);
  // Every parent edge is still drawn and curves to its real lane.
  states.forEach((state, index) => {
    const commit = commits[index]!;
    for (const parent of commit.parents) {
      assert.ok(state.after.includes(parent), `parent ${parent} of ${commit.hash} must be present in after lanes`);
    }
  });
  // e's merge parents d (lane 1) and c (lane 0) curve to their actual lanes.
  assert.equal(states[0]!.after[1], 'd');
  assert.equal(states[0]!.after[0], 'c');
});

test('graphState falls back to a self-contained allocator when columns are absent', () => {
  const commits: GraphCommit[] = [
    { hash: 'm', parents: ['c1', 'c2'] },
    { hash: 'c1', parents: ['r'] },
    { hash: 'c2', parents: ['r'] },
    { hash: 'r', parents: [] }
  ];
  const states = graphState(commits);
  states.forEach((state, index) => {
    const commit = commits[index]!;
    for (const parent of commit.parents) {
      assert.ok(state.after.includes(parent), `parent ${parent} of ${commit.hash} missing`);
    }
  });
});

test('graphState keeps every parent edge across many random DAGs', () => {
  let seed = 1;
  const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 500; run++) {
    const n = 2 + Math.floor(rng() * 12);
    const commits: GraphCommit[] = [];
    for (let i = 0; i < n; i++) {
      const parents = [] as string[];
      const count = i === 0 ? 0 : Math.min(1 + Math.floor(rng() * 3), i);
      for (let k = 0; k < count; k++) parents.push(`c${Math.floor(rng() * i)}`);
      commits.push({ hash: `c${i}`, parents });
    }
    const states = graphState(commits);
    states.forEach((state, i) => {
      for (const parent of commits[i]!.parents) {
        assert.ok(parent === '' || state.after.includes(parent), `run ${run}: parent ${parent} of c${i} missing`);
      }
    });
  }
});
