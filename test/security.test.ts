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

test('isPrivateOllamaEndpoint classifies 172.16.0.0/12 correctly', () => {
  // The 172.16.0.0/12 private block spans 172.16.0.0 .. 172.31.255.255.
  assert.equal(isPrivateOllamaEndpoint('http://172.16.0.1:11434'), true);
  assert.equal(isPrivateOllamaEndpoint('http://172.20.5.5:11434'), true);
  assert.equal(isPrivateOllamaEndpoint('http://172.31.255.254:11434'), true);
  // Adjacent public ranges must NOT be treated as private.
  assert.equal(isPrivateOllamaEndpoint('http://172.15.0.1:11434'), false);
  assert.equal(isPrivateOllamaEndpoint('http://172.32.0.1:11434'), false);
});

test('normalizeOllamaEndpoint removes trailing slashes without changing the host', () => {
  assert.equal(normalizeOllamaEndpoint('http://127.0.0.1:11434///'), 'http://127.0.0.1:11434');
});
