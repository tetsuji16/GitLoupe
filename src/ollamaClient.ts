import { isPrivateOllamaEndpoint, normalizeOllamaEndpoint } from './security.js';

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export interface OllamaOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class OllamaClient {
  constructor(private readonly options: OllamaOptions) {
    if (!isPrivateOllamaEndpoint(options.endpoint)) {
      throw new Error('Ollama endpoint must be localhost or a private-network IP address.');
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.request<OllamaTagsResponse>('/api/tags', { method: 'GET' }, signal);
    return (response.models ?? [])
      .map(model => model.name ?? model.model ?? '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  async chat(system: string, prompt: string, signal?: AbortSignal): Promise<string> {
    if (!this.options.model.trim()) throw new Error('Select an Ollama model first.');
    const response = await this.request<OllamaChatResponse>(
      '/api/chat',
      {
        method: 'POST',
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ]
        })
      },
      signal
    );
    const content = response.message?.content?.trim();
    if (!content) throw new Error(response.error || 'Ollama returned an empty response.');
    return content;
  }

  private async request<T>(path: string, init: RequestInit, parentSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Ollama request timed out.')), this.options.timeoutMs ?? 120_000);
    const abort = (): void => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', abort, { once: true });
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body) headers['Content-Type'] = 'application/json';
      if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
      const response = await fetch(`${normalizeOllamaEndpoint(this.options.endpoint)}${path}`, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) {
        let detail = body.slice(0, 300);
        try {
          detail = (JSON.parse(body) as { error?: string }).error ?? detail;
        } catch {
          // Preserve the bounded response text.
        }
        throw new Error(`Ollama request failed (${response.status}): ${detail || response.statusText}`);
      }
      return JSON.parse(body) as T;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
    }
  }
}
