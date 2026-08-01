import assert from 'node:assert/strict';
import test from 'node:test';
import { graphWorkbenchHtml } from '../src/graphWebview.js';
import { visualFileHistoryHtml } from '../src/visualHistoryWebview.js';
import { launchpadHtml } from '../src/launchpadWebview.js';
import { homeViewHtml } from '../src/homeWebview.js';
import { inspectViewHtml } from '../src/inspectWebview.js';
import { welcomeViewHtml } from '../src/welcomeWebview.js';

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
