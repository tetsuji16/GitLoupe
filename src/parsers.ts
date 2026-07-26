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

function splitWords(value: string | undefined): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

function splitRefs(value: string | undefined): string[] {
  return value?.trim() ? value.split(',').map(ref => ref.trim()).filter(Boolean) : [];
}
