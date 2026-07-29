import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeMarkdown, isPrivateOllamaEndpoint, normalizeOllamaEndpoint } from '../src/security.js';

test('escapeMarkdown neutralizes command-link and formatting syntax', () => {
  const malicious = 'author [](command:workbench.action.terminal.new) **admin** <tag>';
  const escaped = escapeMarkdown(malicious);
  assert.ok(!escaped.includes('[](command:'));
  assert.ok(escaped.includes('\\['));
  assert.ok(escaped.includes('\\*\\*admin\\*\\*'));
});

test('Ollama endpoint policy accepts local networks and rejects public hosts', () => {
  assert.equal(isPrivateOllamaEndpoint('http://127.0.0.1:11434'), true);
  assert.equal(isPrivateOllamaEndpoint('http://localhost:11434'), true);
  assert.equal(isPrivateOllamaEndpoint('http://192.168.1.25:11434'), true);
  assert.equal(isPrivateOllamaEndpoint('http://10.20.30.40:11434'), true);
  assert.equal(isPrivateOllamaEndpoint('https://ollama.com/api'), false);
  assert.equal(isPrivateOllamaEndpoint('http://8.8.8.8:11434'), false);
  assert.equal(isPrivateOllamaEndpoint('file:///tmp/socket'), false);
});

test('normalizeOllamaEndpoint removes trailing slashes without changing the host', () => {
  assert.equal(normalizeOllamaEndpoint('http://127.0.0.1:11434///'), 'http://127.0.0.1:11434');
});
