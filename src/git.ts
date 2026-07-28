import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BlameLine,
  Commit,
  CommitDetails,
  FileHistoryEntry,
  parseBlame,
  parseCommits,
  parseFileHistory,
  parseStatus,
  parseStashes,
  parseWorktrees,
  Stash,
  WorkingTreeStatus,
  Worktree
} from './parsers.js';
import { parseGraphSearchQuery } from './search.js';
import { messageEditorSource, nodeScriptCommand, sequenceEditorSource } from './rewrite.js';

export type { Commit, CommitDetails, FileHistoryEntry, Stash, WorkingFile, WorkingTreeStatus, Worktree } from './parsers.js';

export interface ComparisonDetails {
  base: string;
  target: string;
  added: number;
  deleted: number;
  files: CommitDetails['files'];
}

export type RewriteAction = 'reword' | 'squash' | 'drop';

export interface Repository {
  name: string;
  root: string;
  branch: string;
}

const RECORD = '\x1e';
const FIELD = '\x1f';
const COMMIT_FORMAT = `%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%D${FIELD}%s`;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null
  ) {
    super(message);
  }
}

export class GitService {
  private readonly searchCache = new Map<string, { expires: number; commits: Commit[] }>();

  private get executable(): string {
    return vscode.workspace.getConfiguration('gitloupe').get('git.path', 'git');
  }

  async run(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Git operation cancelled.'));
        return;
      }
      const child = spawn(this.executable, ['-c', 'color.ui=false', ...args], {
        cwd,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
          ...extraEnv
        }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const abort = (): void => {
        child.kill();
        reject(signal?.reason ?? new Error('Git operation cancelled.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
      child.on('error', error => {
        signal?.removeEventListener('abort', abort);
        reject(error);
      });
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        const output = Buffer.concat(stdout).toString('utf8');
        const error = Buffer.concat(stderr).toString('utf8').trim();
        if (code === 0) {
          resolve(output);
        } else {
          reject(new GitError(error || `Git exited with code ${code}`, args, error, code));
        }
      });
    });
  }

  async discoverRepositories(): Promise<Repository[]> {
    const roots = vscode.workspace.workspaceFolders ?? [];
    const found = new Map<string, Repository>();
    const nestedHeads = await vscode.workspace.findFiles('**/.git/HEAD', '**/node_modules/**', 100);
    const worktreeMarkers = await vscode.workspace.findFiles('**/.git', '**/node_modules/**', 100);
    const candidates = [
      ...roots.map(folder => folder.uri.fsPath),
      ...nestedHeads.map(uri => path.dirname(path.dirname(uri.fsPath))),
      ...worktreeMarkers.map(uri => path.dirname(uri.fsPath))
    ];
    await Promise.all(candidates.map(async candidate => {
      try {
        const root = (await this.run(candidate, ['rev-parse', '--show-toplevel'])).trim();
        const branch = await this.currentBranch(root);
        found.set(normalizeKey(root), { name: path.basename(root), root, branch });
      } catch {
        // A workspace folder is allowed to not be a Git repository.
      }
    }));
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async findRepository(fileOrFolder: string): Promise<Repository> {
    const cwd = path.extname(fileOrFolder) ? path.dirname(fileOrFolder) : fileOrFolder;
    const root = (await this.run(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return { name: path.basename(root), root, branch: await this.currentBranch(root) };
  }

  async currentBranch(root: string): Promise<string> {
    const branch = (await this.run(root, ['branch', '--show-current'])).trim();
    if (branch) return branch;
    return (await this.run(root, ['rev-parse', '--short', 'HEAD'])).trim();
  }

  async graph(root: string, limit: number): Promise<Commit[]> {
    try {
      const output = await this.run(root, [
        'log',
        '--all',
        '--topo-order',
        `--max-count=${limit}`,
        `--format=${RECORD}${COMMIT_FORMAT}`,
        '--numstat'
      ]);
      return parseCommits(output);
    } catch (error) {
      // An initialized repository with an unborn branch has no graph yet.
      if (error instanceof GitError && /does not have any commits|bad revision|unknown revision/i.test(error.stderr)) {
        return [];
      }
      throw error;
    }
  }

  async searchGraph(root: string, query: string, limit: number, signal?: AbortSignal): Promise<Commit[]> {
    const search = parseGraphSearchQuery(query);
    if (!search.files.length && !search.changes.length) return this.graph(root, limit);
    const cacheKey = `${normalizeKey(root)}\0${limit}\0${query}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.commits;
    const args = [
      'log',
      '--all',
      '--topo-order',
      `--max-count=${limit}`,
      `--format=${RECORD}${COMMIT_FORMAT}`,
      '--numstat',
      ...search.changes.map(value => `-S${value}`)
    ];
    if (search.files.length) args.push('--', ...search.files.map(slash));
    try {
      const commits = parseCommits(await this.run(root, args, signal));
      this.searchCache.set(cacheKey, { expires: Date.now() + 15_000, commits });
      while (this.searchCache.size > 20) {
        const oldest = this.searchCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.searchCache.delete(oldest);
      }
      return commits;
    } catch (error) {
      if (error instanceof GitError && /does not have any commits|bad revision|unknown revision/i.test(error.stderr)) {
        return [];
      }
      throw error;
    }
  }

  invalidate(root: string): void {
    const prefix = `${normalizeKey(root)}\0`;
    for (const key of this.searchCache.keys()) {
      if (key.startsWith(prefix)) this.searchCache.delete(key);
    }
  }

  async commitDetails(root: string, hash: string): Promise<CommitDetails> {
    assertRevision(hash);
    const metadata = await this.run(root, [
      'show',
      '--no-patch',
      `--format=${RECORD}${COMMIT_FORMAT}${FIELD}%b`,
      hash
    ]);
    const fields = metadata.slice(metadata.indexOf(RECORD) + 1).trimEnd().split(FIELD);
    if (fields.length < 8) throw new Error('Could not parse commit metadata.');
    const [names, numstat] = await Promise.all([
      this.run(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', hash]),
      this.run(root, ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', hash])
    ]);
    const totals = sumNumstat(numstat);
    return {
      hash: fields[0] ?? '',
      parents: fields[1]?.trim() ? fields[1].trim().split(/\s+/) : [],
      author: fields[2] ?? '',
      email: fields[3] ?? '',
      timestamp: Number(fields[4] ?? 0),
      refs: splitRefs(fields[5]),
      subject: fields[6] ?? '',
      body: fields.slice(7).join(FIELD).trim(),
      added: totals.added,
      deleted: totals.deleted,
      files: parseNameStatus(names)
    };
  }

  async compare(root: string, base: string, target: string): Promise<ComparisonDetails> {
    assertRevision(base);
    assertRevisionOrRef(target);
    const [names, numstat] = await Promise.all([
      this.run(root, ['diff', '--name-status', '-M', base, target]),
      this.run(root, ['diff', '--numstat', base, target])
    ]);
    return { base, target, ...sumNumstat(numstat), files: parseNameStatus(names) };
  }

  async rewriteCommit(
    root: string,
    action: RewriteAction,
    hash: string,
    message?: string
  ): Promise<{ backup: string }> {
    assertRevision(hash);
    const status = await this.status(root);
    if (status.files.length) throw new Error('Commit or stash working changes before rewriting history.');
    const details = await this.commitDetails(root, hash);
    if (details.parents.length > 1) throw new Error('Merge commits cannot be rewritten by this workflow.');
    await this.ensureAncestor(root, hash, 'HEAD');
    if (action === 'squash' && !details.parents[0]) throw new Error('The root commit has no parent to squash into.');
    if ((action === 'reword' || action === 'squash') && !message?.trim()) {
      throw new Error('A commit message is required.');
    }

    const backup = `gitloupe/backup-${Date.now()}`;
    await this.run(root, ['branch', backup, 'HEAD']);
    const temporary = await mkdtemp(path.join(tmpdir(), 'gitloupe-rebase-'));
    const sequenceEditor = path.join(temporary, 'sequence-editor.cjs');
    const messageEditor = path.join(temporary, 'message-editor.cjs');
    await writeFile(sequenceEditor, sequenceEditorSource, 'utf8');
    await writeFile(messageEditor, messageEditorSource, 'utf8');
    const upstream = action === 'squash' ? details.parents[0] : hash;
    const upstreamDetails = action === 'squash' && upstream ? await this.commitDetails(root, upstream) : undefined;
    const rebaseBase = action === 'squash' ? upstreamDetails?.parents[0] : details.parents[0];
    try {
      await this.run(
        root,
        rebaseBase ? ['rebase', '-i', rebaseBase] : ['rebase', '-i', '--root'],
        undefined,
        {
          GIT_SEQUENCE_EDITOR: nodeScriptCommand(sequenceEditor),
          GIT_EDITOR: nodeScriptCommand(messageEditor),
          GITLOUPE_REBASE_ACTION: action,
          GITLOUPE_REBASE_TARGET: hash,
          GITLOUPE_REBASE_MESSAGE: message?.trim() ?? ''
        }
      );
      this.invalidate(root);
      return { backup };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async rebaseState(root: string): Promise<'rebase' | undefined> {
    const paths = await Promise.all([
      this.run(root, ['rev-parse', '--git-path', 'rebase-merge']),
      this.run(root, ['rev-parse', '--git-path', 'rebase-apply'])
    ]);
    return paths.some(value => existsSync(path.resolve(root, value.trim()))) ? 'rebase' : undefined;
  }

  async rebaseContinue(root: string): Promise<void> {
    await this.run(root, ['-c', 'core.editor=true', 'rebase', '--continue']);
    this.invalidate(root);
  }

  async rebaseAbort(root: string): Promise<void> {
    await this.run(root, ['rebase', '--abort']);
    this.invalidate(root);
  }

  async fileHistory(root: string, absolutePath: string, limit = 300): Promise<FileHistoryEntry[]> {
    const relative = slash(path.relative(root, absolutePath));
    if (relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('The file is outside of the selected repository.');
    }
    const output = await this.run(root, [
      'log',
      '--follow',
      `--max-count=${limit}`,
      `--format=${RECORD}${COMMIT_FORMAT}`,
      '--numstat',
      '--',
      relative
    ]);
    return parseFileHistory(output);
  }

  async fileAtRevision(root: string, hash: string, relativePath: string): Promise<string> {
    assertRevisionOrRef(hash);
    return this.run(root, ['show', `${hash}:${slash(relativePath)}`]);
  }

  async checkout(root: string, ref: string): Promise<void> {
    assertRef(ref);
    await this.run(root, ['checkout', ref]);
  }

  async refs(root: string): Promise<{ branches: string[]; remotes: string[]; tags: string[] }> {
    const read = async (prefix: string): Promise<string[]> => {
      const output = await this.run(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', prefix]);
      return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    };
    const [branches, remotes, tags] = await Promise.all([
      read('refs/heads'),
      read('refs/remotes'),
      read('refs/tags')
    ]);
    return { branches, remotes, tags };
  }

  async status(root: string): Promise<WorkingTreeStatus> {
    return parseStatus(await this.run(root, ['status', '--porcelain=v2', '--branch', '-z']));
  }

  async fetch(root: string): Promise<void> {
    await this.run(root, ['fetch', '--all', '--prune']);
  }

  async stage(root: string, relativePath: string): Promise<void> {
    await this.run(root, ['add', '--', slash(relativePath)]);
  }

  async unstage(root: string, relativePath: string): Promise<void> {
    await this.run(root, ['restore', '--staged', '--', slash(relativePath)]);
  }

  async discard(root: string, relativePath: string): Promise<void> {
    await this.run(root, ['restore', '--worktree', '--', slash(relativePath)]);
  }

  async commit(root: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error('Commit message is required.');
    await this.run(root, ['commit', '-m', message.trim()]);
  }

  async diffWorking(root: string, staged: boolean): Promise<string> {
    return this.run(root, staged ? ['diff', '--cached', '--binary'] : ['diff', '--binary']);
  }

  async createBranch(root: string, name: string, start: string): Promise<void> {
    assertRef(name);
    assertRevision(start);
    await this.run(root, ['checkout', '-b', name, start]);
  }

  async cherryPick(root: string, hash: string): Promise<void> {
    assertRevision(hash);
    await this.run(root, ['cherry-pick', hash]);
  }

  async listWorktrees(root: string): Promise<Worktree[]> {
    return parseWorktrees(await this.run(root, ['worktree', 'list', '--porcelain', '-z']));
  }

  async addWorktree(root: string, destination: string, ref?: string): Promise<void> {
    const args = ['worktree', 'add', destination];
    if (ref) {
      assertRef(ref);
      args.push(ref);
    }
    await this.run(root, args);
  }

  async removeWorktree(root: string, destination: string): Promise<void> {
    await this.run(root, ['worktree', 'remove', destination]);
  }

  async listStashes(root: string): Promise<Stash[]> {
    const output = await this.run(root, [
      'stash',
      'list',
      `--format=%H${FIELD}%at${FIELD}%gd${FIELD}%s`
    ]);
    return parseStashes(output);
  }

  async stashShow(root: string, ref: string): Promise<string> {
    assertStashRef(ref);
    return this.run(root, ['stash', 'show', '-p', ref]);
  }

  async stashDrop(root: string, ref: string): Promise<void> {
    assertStashRef(ref);
    await this.run(root, ['stash', 'drop', ref]);
  }

  async stashPop(root: string, ref: string): Promise<void> {
    assertStashRef(ref);
    await this.run(root, ['stash', 'pop', ref]);
  }

  async stashApply(root: string, ref: string): Promise<void> {
    assertStashRef(ref);
    await this.run(root, ['stash', 'apply', ref]);
  }

  async createStash(root: string, message?: string, paths?: string[]): Promise<void> {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    if (paths && paths.length) args.push('--', ...paths.map(slash));
    await this.run(root, args);
  }

  async blame(root: string, relativePath: string, startLine: number, endLine: number): Promise<BlameLine[]> {
    const output = await this.run(root, [
      'blame',
      '--porcelain',
      '--date=unix',
      '-L',
      `${startLine},${endLine}`,
      '--',
      slash(relativePath)
    ]);
    return parseBlame(output);
  }

  async blameFile(root: string, relativePath: string): Promise<BlameLine[]> {
    const output = await this.run(root, ['blame', '--porcelain', '--date=unix', '--', slash(relativePath)]);
    return parseBlame(output);
  }

  private async ensureAncestor(root: string, ancestor: string, descendant: string): Promise<void> {
    try {
      await this.run(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
    } catch {
      throw new Error('Only commits on the current branch can be rewritten.');
    }
  }
}

function parseNameStatus(output: string): CommitDetails['files'] {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const [status = '', first = '', second] = line.split('\t');
    return second
      ? { status, oldPath: first, path: second }
      : { status, path: first };
  });
}

function splitRefs(value: string | undefined): string[] {
  return value?.trim() ? value.split(',').map(ref => ref.trim()).filter(Boolean) : [];
}

function sumNumstat(output: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of output.split(/\r?\n/)) {
    const [a, d] = line.split('\t');
    if (a !== '-') added += Number(a ?? 0) || 0;
    if (d !== '-') deleted += Number(d ?? 0) || 0;
  }
  return { added, deleted };
}

function assertRevision(value: string): void {
  if (value !== 'HEAD' && !/^[0-9a-fA-F]{4,64}$/.test(value)) throw new Error('Invalid Git revision.');
}

function assertRevisionOrRef(value: string): void {
  if (value === 'HEAD' || /^[0-9a-fA-F]{4,64}$/.test(value)) return;
  assertRef(value);
}

function assertRef(value: string): void {
  if (!value || value.startsWith('-') || /[\0-\x20~^:?*[\]\\]/.test(value) || value.includes('..')) {
    throw new Error('Invalid Git reference.');
  }
}

function assertStashRef(value: string): void {
  if (!/^stash@\{\d+\}$/.test(value)) throw new Error('Invalid stash reference.');
}

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function normalizeKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
