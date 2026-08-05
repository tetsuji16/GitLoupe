import * as net from 'node:net';
import * as path from 'node:path';

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

/**
 * Resolve a repository-relative path and reject anything that escapes the
 * repository root. Every git read/write sink that accepts a user- or
 * model-supplied path funnels through this so a crafted path (for example a
 * `../` traversal handed to `git show <hash>:<path>`) can never read or write
 * outside the working tree. Pure and dependency-free so it is unit-testable.
 */
export function safeRepositoryPath(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!normalize(absolute).startsWith(normalize(prefix))) {
    throw new Error('The requested path is outside of the selected repository.');
  }
  return absolute;
}
