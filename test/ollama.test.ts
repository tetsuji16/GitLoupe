import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { OllamaClient } from '../src/ollamaClient.js';

test('Ollama client lists models and sends a non-streaming local chat', async () => {
  const requests: Array<{ url: string; authorization?: string; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { model: 'gemma3:4b' }] }));
      } else {
        response.end(JSON.stringify({ message: { role: 'assistant', content: '  concise answer  ' }, done: true }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new OllamaClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      model: 'qwen3:8b',
      apiKey: 'local-gateway-secret'
    });
    assert.deepEqual(await client.listModels(), ['gemma3:4b', 'qwen3:8b']);
    assert.equal(await client.chat('system', 'prompt'), 'concise answer');
    assert.equal(requests[1]?.authorization, 'Bearer local-gateway-secret');
    const chat = JSON.parse(requests[1]!.body) as { model: string; stream: boolean; messages: unknown[] };
    assert.equal(chat.model, 'qwen3:8b');
    assert.equal(chat.stream, false);
    assert.equal(chat.messages.length, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Ollama client can discover models before one is selected', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new OllamaClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      model: ''
    });
    assert.deepEqual(await client.listModels(), ['qwen3:8b']);
    await assert.rejects(client.chat('system', 'prompt'), /Select an Ollama model/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Ollama client rejects non-local endpoints', () => {
  assert.throws(
    () => new OllamaClient({ endpoint: 'https://ollama.com', model: 'cloud' }),
    /private-network/
  );
});
