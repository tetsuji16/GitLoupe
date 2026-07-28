import assert from 'node:assert/strict';
import test from 'node:test';
import { graphWorkbenchHtml } from '../src/graphWebview.js';
import { visualFileHistoryHtml } from '../src/visualHistoryWebview.js';

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
