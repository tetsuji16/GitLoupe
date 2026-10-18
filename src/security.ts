import * as net from 'node:net';
import { existsSync, realpathSync } from 'node:fs';
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
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    return a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
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

  // `path.resolve` only guards the lexical path. An untracked file (or a
  // directory on its path) can be a symbolic link whose target is elsewhere,
  // and callers such as `compareAny` subsequently read that path directly.
  // Resolve the repository and the deepest existing ancestor before accepting
  // it, so a link cannot turn an apparently repository-local path into an
  // external read. A non-existent root is retained for the helper's pure
  // path-normalization use in tests; real repositories always exist.
  const resolvedRoot = path.resolve(root);
  if (!existsSync(resolvedRoot)) return absolute;
  const canonicalRoot = realpathSync.native(resolvedRoot);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('The requested path is outside of the selected repository.');
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  const canonicalPrefix = canonicalRoot + path.sep;
  if (!normalize(canonicalExisting).startsWith(normalize(canonicalPrefix)) && normalize(canonicalExisting) !== normalize(canonicalRoot)) {
    throw new Error('The requested path is outside of the selected repository.');
  }
  return absolute;
}
