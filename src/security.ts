import * as net from 'node:net';

const markdownCharacters = /[\\`*_{}[\]()<>#+.!|~-]/g;

export function escapeMarkdown(value: string): string {
  return value.replace(markdownCharacters, character => `\\${character}`);
}

export function isPrivateOllamaEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const family = net.isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 127 ||
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254);
  }
  return family === 6 && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'));
}

export function normalizeOllamaEndpoint(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
