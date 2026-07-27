export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  timestamp: number;
  refs: string[];
  subject: string;
}

export interface CommitDetails extends Commit {
  body: string;
  files: Array<{ status: string; path: string; oldPath?: string }>;
}

export interface Worktree {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
}

export interface FileHistoryEntry extends Commit {
  added: number;
  deleted: number;
}

const RECORD = '\x1e';
const FIELD = '\x1f';

export function parseCommits(output: string): Commit[] {
  return output
    .split(RECORD)
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const fields = record.split(FIELD);
      return {
        hash: fields[0] ?? '',
        parents: splitWords(fields[1]),
        author: fields[2] ?? '',
        email: fields[3] ?? '',
        timestamp: Number(fields[4] ?? 0),
        refs: splitRefs(fields[5]),
        subject: fields.slice(6).join(FIELD)
      };
    });
}

export function parseFileHistory(output: string): FileHistoryEntry[] {
  return output
    .split(RECORD)
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const lines = record.split(/\r?\n/);
      const fields = (lines.shift() ?? '').split(FIELD);
      let added = 0;
      let deleted = 0;
      for (const line of lines) {
        const [a, d] = line.split('\t');
        if (a !== '-') added += Number(a ?? 0);
        if (d !== '-') deleted += Number(d ?? 0);
      }
      return {
        hash: fields[0] ?? '',
        parents: splitWords(fields[1]),
        author: fields[2] ?? '',
        email: fields[3] ?? '',
        timestamp: Number(fields[4] ?? 0),
        refs: splitRefs(fields[5]),
        subject: fields.slice(6).join(FIELD),
        added,
        deleted
      };
    });
}

export function parseWorktrees(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const entry of output.split('\0').filter(Boolean)) {
    const separator = entry.indexOf(' ');
    const key = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? '' : entry.slice(separator + 1);
    if (key === 'worktree') {
      current = { path: value, head: '', bare: false, detached: false };
      worktrees.push(current);
    } else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'bare') current.bare = true;
      else if (key === 'detached') current.detached = true;
      else if (key === 'locked') current.locked = value;
      else if (key === 'prunable') current.prunable = value;
    }
  }
  return worktrees;
}

export interface Stash {
  index: number;
  ref: string;
  hash: string;
  timestamp: number;
  message: string;
}

export function parseStashes(output: string): Stash[] {
  return output
    .split('\n')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const fields = record.split(FIELD);
      const ref = fields[2] ?? '';
      const indexMatch = /^stash@\{(\d+)\}$/.exec(ref);
      return {
        index: indexMatch ? Number(indexMatch[1]) : -1,
        ref,
        hash: fields[0] ?? '',
        timestamp: Number(fields[1] ?? 0),
        message: fields.slice(3).join(FIELD)
      };
    });
}

function splitWords(value: string | undefined): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

function splitRefs(value: string | undefined): string[] {
  return value?.trim() ? value.split(',').map(ref => ref.trim()).filter(Boolean) : [];
}

export interface BlameLine {
  line: number;
  hash: string;
  author: string;
  email: string;
  timestamp: number;
  summary: string;
  uncommitted: boolean;
}

const UNCOMMITTED_HASH = '0000000000000000000000000000000000000000';

export function parseBlame(output: string): BlameLine[] {
  const lines = output.split(/\r?\n/);
  const result: BlameLine[] = [];
  const seen = new Map<string, { author: string; email: string; timestamp: number; summary: string }>();
  let pending: {
    hash: string;
    finalStart: number;
    count: number;
    author: string;
    email: string;
    timestamp: number;
    summary: string;
  } | undefined;

  const header = /^\(?([0-9a-f]{40})\)? (\d+) (\d+) (\d+)$/;
  const flush = (): void => {
    if (!pending) return;
    const entry = pending;
    if (entry.hash !== UNCOMMITTED_HASH) {
      seen.set(entry.hash, {
        author: entry.author,
        email: entry.email,
        timestamp: entry.timestamp,
        summary: entry.summary
      });
    }
    for (let offset = 0; offset < entry.count; offset++) {
      result.push({
        line: entry.finalStart + offset,
        hash: entry.hash,
        author: entry.author,
        email: entry.email,
        timestamp: entry.timestamp,
        summary: entry.summary,
        uncommitted: entry.hash === UNCOMMITTED_HASH
      });
    }
    pending = undefined;
  };

  for (const raw of lines) {
    const match = header.exec(raw);
    if (match) {
      flush();
      const hash = match[1] ?? '';
      const existing = seen.get(hash);
      pending = {
        hash,
        finalStart: Number(match[3] ?? '0'),
        count: Number(match[4] ?? '1'),
        author: existing?.author ?? '',
        email: existing?.email ?? '',
        timestamp: existing?.timestamp ?? 0,
        summary: existing?.summary ?? ''
      };
      continue;
    }
    if (!pending) continue;
    if (raw.charCodeAt(0) === 9) continue; // content line (tab-prefixed) — not needed
    const separator = raw.indexOf(' ');
    if (separator === -1) continue;
    const key = raw.slice(0, separator);
    const value = raw.slice(separator + 1);
    switch (key) {
      case 'author':
        pending.author = value;
        break;
      case 'author-mail':
        pending.email = stripMail(value);
        break;
      case 'author-time':
        pending.timestamp = Number(value);
        break;
      case 'summary':
        pending.summary = value;
        break;
      default:
        break;
    }
  }
  flush();
  return result;
}

function stripMail(value: string): string {
  const trimmed = value.trim().replace(/^[<('"]+/, '').replace(/[>')"]+$/, '');
  return trimmed || value.trim();
}
