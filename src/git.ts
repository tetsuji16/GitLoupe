import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  BlameLine,
  Commit,
  CommitDetails,
  countTextLines,
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

export type RewriteAction = 'reword' | 'squash' | 'fixup' | 'drop' | 'moveParent' | 'moveHead';
type RewritePlanAction = RewriteAction | 'move';
export const WORKING_TREE = ':working-tree';

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
    const cwd = (await stat(fileOrFolder).catch(() => undefined))?.isDirectory()
      ? fileOrFolder
      : path.dirname(fileOrFolder);
    const root = (await this.run(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return { name: path.basename(root), root, branch: await this.currentBranch(root) };
  }

  async currentBranch(root: string, signal?: AbortSignal): Promise<string> {
    const branch = (await this.run(root, ['branch', '--show-current'], signal)).trim();
    if (branch) return branch;
    return (await this.run(root, ['rev-parse', '--short', 'HEAD'], signal)).trim();
  }

  async remoteUrl(root: string, remote = 'origin'): Promise<string> {
    assertRef(remote);
    return (await this.run(root, ['remote', 'get-url', remote])).trim();
  }

  async checkoutPullRequest(root: string, number: number, remote = 'origin'): Promise<void> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.');
    assertRef(remote);
    const status = await this.status(root);
    if (status.files.length) throw new Error('Commit or stash working changes before checking out a pull request.');
    await this.fetchPullRequest(root, number, remote);
    await this.run(root, ['checkout', '-b', `gitloupe/pr-${number}`, 'FETCH_HEAD']);
    this.invalidate(root);
  }

  async fetchPullRequest(root: string, number: number, remote = 'origin', base?: string): Promise<string> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid pull request number.');
    assertRef(remote);
    if (base) assertRef(base);
    const args = ['fetch', remote, `pull/${number}/head`];
    if (base) args.push(`refs/heads/${base}:refs/remotes/${remote}/${base}`);
    await this.run(root, args);
    return (await this.run(root, ['rev-parse', 'FETCH_HEAD'])).trim();
  }

  async graph(root: string, limit: number, signal?: AbortSignal): Promise<Commit[]> {
    try {
      const output = await this.run(root, [
        'log',
        '--all',
        '--topo-order',
        `--max-count=${limit}`,
        `--format=${RECORD}${COMMIT_FORMAT}`,
        '--numstat'
      ], signal);
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
    assertRevisionOrRef(base);
    assertRevisionOrRef(target);
    const [names, numstat] = await Promise.all([
      this.run(root, ['diff', '--name-status', '-M', base, target]),
      this.run(root, ['diff', '--numstat', base, target])
    ]);
    return { base, target, ...sumNumstat(numstat), files: parseNameStatus(names) };
  }

  async compareAny(root: string, base: string, target: string): Promise<ComparisonDetails> {
    if (target !== WORKING_TREE) return this.compare(root, base, target);
    assertRevisionOrRef(base);
    const [names, numstat, status] = await Promise.all([
      this.run(root, ['diff', '--name-status', '-M', base]),
      this.run(root, ['diff', '--numstat', base]),
      this.status(root)
    ]);
    const files = parseNameStatus(names);
    const totals = sumNumstat(numstat);
    for (const file of status.files.filter(item => item.untracked)) {
      if (files.some(existing => existing.path === file.path)) continue;
      files.push({ status: 'A', path: file.path });
      const absolute = safeRepositoryPath(root, file.path);
      const content = await readFile(absolute).catch(() => Buffer.alloc(0));
      if (!content.includes(0)) totals.added += countTextLines(content.toString('utf8'));
    }
    return { base, target, ...totals, files };
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
    if ((action === 'squash' || action === 'fixup') && !details.parents[0]) throw new Error('The root commit has no parent to combine into.');
    if ((action === 'reword' || action === 'squash') && !message?.trim()) {
      throw new Error('A commit message is required.');
    }

    const firstParent = (action === 'moveParent' || action === 'moveHead')
      ? (await this.run(root, ['rev-list', '--first-parent', 'HEAD'])).trim().split(/\r?\n/)
      : [];
    const position = firstParent.indexOf(hash);
    if (action === 'moveParent' && (position < 0 || position + 1 >= firstParent.length)) {
      throw new Error('This commit cannot move farther toward its parent.');
    }
    if (action === 'moveHead' && position <= 0) {
      throw new Error('This commit cannot move farther toward HEAD.');
    }
    const combinesWithParent = action === 'squash' || action === 'fixup';
    const upstream = combinesWithParent ? details.parents[0] : hash;
    const upstreamDetails = combinesWithParent && upstream ? await this.commitDetails(root, upstream) : undefined;
    const parentNeighbor = action === 'moveParent' ? await this.commitDetails(root, firstParent[position + 1]!) : undefined;
    const rebaseBase = combinesWithParent
      ? upstreamDetails?.parents[0]
      : action === 'moveParent'
        ? parentNeighbor?.parents[0]
        : details.parents[0];
    await this.ensureLinearRange(root, rebaseBase);
    return this.executeRewritePlan(root, action, [hash], rebaseBase, message);
  }

  async rewriteCommits(
    root: string,
    action: 'squash' | 'drop',
    hashes: string[],
    message?: string
  ): Promise<{ backup: string }> {
    const unique = [...new Set(hashes)];
    if (unique.length < 2) throw new Error('Select at least two commits.');
    unique.forEach(assertRevision);
    const status = await this.status(root);
    if (status.files.length) throw new Error('Commit or stash working changes before rewriting history.');
    const firstParent = (await this.run(root, ['rev-list', '--first-parent', 'HEAD'])).trim().split(/\r?\n/);
    const positions = unique.map(hash => firstParent.indexOf(hash));
    if (positions.some(index => index < 0)) throw new Error('Only first-parent commits on the current branch can be rewritten together.');
    const ordered = unique
      .map((hash, index) => ({ hash, position: positions[index]! }))
      .sort((a, b) => a.position - b.position);
    if (action === 'squash' && ordered.some((item, index) => index > 0 && item.position !== ordered[index - 1]!.position + 1)) {
      throw new Error('Squash requires a contiguous first-parent commit range.');
    }
    const details = await Promise.all(ordered.map(item => this.commitDetails(root, item.hash)));
    if (details.some(commit => commit.parents.length > 1)) throw new Error('Merge commits cannot be rewritten by this workflow.');
    const oldest = details[details.length - 1]!;
    const rebaseBase = oldest.parents[0];
    await this.ensureLinearRange(root, rebaseBase);
    if (action === 'squash' && !message?.trim()) throw new Error('A combined commit message is required.');
    const targets = action === 'squash' ? ordered.slice(0, -1).map(item => item.hash) : ordered.map(item => item.hash);
    return this.executeRewritePlan(root, action, targets, rebaseBase, message);
  }

  async moveCommitBefore(root: string, hash: string, before: string): Promise<{ backup: string }> {
    assertRevision(hash);
    assertRevision(before);
    if (hash === before) throw new Error('A commit cannot be moved onto itself.');
    const status = await this.status(root);
    if (status.files.length) throw new Error('Commit or stash working changes before rewriting history.');
    const firstParent = (await this.run(root, ['rev-list', '--first-parent', 'HEAD'])).trim().split(/\r?\n/).filter(Boolean);
    const source = firstParent.indexOf(hash);
    const destination = firstParent.indexOf(before);
    if (source < 0 || destination < 0) throw new Error('Only first-parent commits on the current branch can be reordered.');
    if (source + 1 === destination) throw new Error('The commit is already in that position.');
    const [sourceDetails, destinationDetails] = await Promise.all([
      this.commitDetails(root, hash),
      this.commitDetails(root, before)
    ]);
    if (sourceDetails.parents.length > 1 || destinationDetails.parents.length > 1) {
      throw new Error('Merge commits cannot be reordered by this workflow.');
    }
    const oldest = firstParent[Math.max(source, destination)]!;
    const base = (await this.commitDetails(root, oldest)).parents[0];
    await this.ensureLinearRange(root, base);
    // The graph is newest-first; placing before a row means after it in Git's todo list.
    return this.executeRewritePlan(root, 'move', [hash], base, undefined, before);
  }

  private async executeRewritePlan(
    root: string,
    action: RewritePlanAction,
    targets: string[],
    rebaseBase: string | undefined,
    message?: string,
    after?: string
  ): Promise<{ backup: string }> {
    const backup = `gitloupe/backup-${Date.now()}`;
    await this.run(root, ['branch', backup, 'HEAD']);
    const temporary = await mkdtemp(path.join(tmpdir(), 'gitloupe-rebase-'));
    const sequenceEditor = path.join(temporary, 'sequence-editor.cjs');
    const messageEditor = path.join(temporary, 'message-editor.cjs');
    await writeFile(sequenceEditor, sequenceEditorSource, 'utf8');
    await writeFile(messageEditor, messageEditorSource, 'utf8');
    try {
      await this.run(
        root,
        rebaseBase ? ['rebase', '-i', rebaseBase] : ['rebase', '-i', '--root'],
        undefined,
        {
          GIT_SEQUENCE_EDITOR: nodeScriptCommand(sequenceEditor),
          GIT_EDITOR: nodeScriptCommand(messageEditor),
          GITLOUPE_REBASE_ACTION: action,
          GITLOUPE_REBASE_TARGETS: JSON.stringify(targets),
          GITLOUPE_REBASE_MESSAGE: message?.trim() ?? '',
          GITLOUPE_REBASE_AFTER: after ?? ''
        }
      );
      this.invalidate(root);
      return { backup };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async rebaseState(root: string, signal?: AbortSignal): Promise<'rebase' | undefined> {
    const paths = await Promise.all([
      this.run(root, ['rev-parse', '--git-path', 'rebase-merge'], signal),
      this.run(root, ['rev-parse', '--git-path', 'rebase-apply'], signal)
    ]);
    return paths.some(value => existsSync(path.resolve(root, value.trim()))) ? 'rebase' : undefined;
  }

  async operationState(
    root: string,
    signal?: AbortSignal
  ): Promise<'rebase' | 'merge' | 'cherry-pick' | 'revert' | undefined> {
    if (await this.rebaseState(root, signal)) return 'rebase';
    const markers = [
      ['merge', 'MERGE_HEAD'],
      ['cherry-pick', 'CHERRY_PICK_HEAD'],
      ['revert', 'REVERT_HEAD']
    ] as const;
    for (const [operation, marker] of markers) {
      const value = await this.run(root, ['rev-parse', '--git-path', marker], signal);
      if (existsSync(path.resolve(root, value.trim()))) return operation;
    }
    return undefined;
  }

  async rebaseContinue(root: string): Promise<void> {
    await this.run(root, ['-c', 'core.editor=true', 'rebase', '--continue']);
    this.invalidate(root);
  }

  async rebaseAbort(root: string): Promise<void> {
    await this.run(root, ['rebase', '--abort']);
    this.invalidate(root);
  }

  async continueOperation(root: string, operation: 'rebase' | 'merge' | 'cherry-pick' | 'revert'): Promise<void> {
    await this.run(root, ['-c', 'core.editor=true', operation, '--continue']);
    this.invalidate(root);
  }

  async abortOperation(root: string, operation: 'rebase' | 'merge' | 'cherry-pick' | 'revert'): Promise<void> {
    await this.run(root, [operation, '--abort']);
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

  async scopeHistory(root: string, absoluteScope: string, limit = 500): Promise<FileHistoryEntry[]> {
    const relative = slash(path.relative(root, absoluteScope));
    if (relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('The selected scope is outside of the repository.');
    }
    const args = [
      'log',
      `--max-count=${limit}`,
      `--format=${RECORD}${COMMIT_FORMAT}`,
      '--numstat'
    ];
    if (relative) args.push('--', relative);
    return parseFileHistory(await this.run(root, args));
  }

  async fileAtRevision(root: string, hash: string, relativePath: string): Promise<string> {
    assertRevisionOrRef(hash);
    return this.run(root, ['show', `${hash}:${slash(relativePath)}`]);
  }

  async fileAtIndex(root: string, relativePath: string): Promise<string> {
    safeRepositoryPath(root, relativePath);
    return this.run(root, ['show', `:${slash(relativePath)}`]);
  }

  async latestFileRevision(root: string, relativePath: string): Promise<string | undefined> {
    safeRepositoryPath(root, relativePath);
    const output = await this.run(root, ['log', '-1', '--follow', '--format=%H', '--', slash(relativePath)]);
    return output.trim() || undefined;
  }

  async fileRevisions(root: string, relativePath: string, limit = 300): Promise<string[]> {
    safeRepositoryPath(root, relativePath);
    const output = await this.run(root, [
      'log',
      '--follow',
      `--max-count=${limit}`,
      '--format=%H',
      '--',
      slash(relativePath)
    ]);
    return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  }

  async checkout(root: string, ref: string): Promise<void> {
    assertRef(ref);
    await this.run(root, ['checkout', ref]);
  }

  async refs(root: string, signal?: AbortSignal): Promise<{ branches: string[]; remotes: string[]; tags: string[] }> {
    const read = async (prefix: string): Promise<string[]> => {
      const output = await this.run(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', prefix], signal);
      return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    };
    const [branches, remotes, tags] = await Promise.all([
      read('refs/heads'),
      read('refs/remotes'),
      read('refs/tags')
    ]);
    return { branches, remotes, tags };
  }

  async status(root: string, signal?: AbortSignal): Promise<WorkingTreeStatus> {
    return parseStatus(await this.run(root, ['status', '--porcelain=v2', '--branch', '-z'], signal));
  }

  async fetch(root: string): Promise<void> {
    await this.run(root, ['fetch', '--all', '--prune']);
  }

  async pull(root: string): Promise<void> {
    await this.run(root, ['pull', '--ff-only']);
    this.invalidate(root);
  }

  async push(root: string, setUpstream = false): Promise<void> {
    const args = ['push'];
    if (setUpstream) {
      const branch = await this.currentBranch(root);
      if (/^[0-9a-f]{7,40}$/i.test(branch)) throw new Error('A detached HEAD cannot be published.');
      args.push('--set-upstream', 'origin', branch);
    }
    await this.run(root, args);
    this.invalidate(root);
  }

  async merge(root: string, ref: string): Promise<void> {
    assertRef(ref);
    await this.run(root, ['merge', '--no-edit', ref]);
    this.invalidate(root);
  }

  async rebaseBranch(root: string, ref: string): Promise<void> {
    assertRef(ref);
    await this.run(root, ['rebase', ref]);
    this.invalidate(root);
  }

  async revert(root: string, hash: string): Promise<void> {
    assertRevision(hash);
    await this.run(root, ['revert', '--no-edit', hash]);
    this.invalidate(root);
  }

  async resetTo(root: string, hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    assertRevision(hash);
    await this.run(root, ['reset', `--${mode}`, hash]);
    this.invalidate(root);
  }

  async undoCommit(root: string): Promise<void> {
    const status = await this.status(root);
    if (status.files.length) throw new Error('Commit or stash working changes before undoing the last commit.');
    await this.run(root, ['reset', '--mixed', 'HEAD^']);
    this.invalidate(root);
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

  async resolveConflict(root: string, relativePath: string, resolution: 'current' | 'incoming' | 'delete'): Promise<void> {
    safeRepositoryPath(root, relativePath);
    if (resolution === 'delete') {
      await this.run(root, ['rm', '--', slash(relativePath)]);
    } else {
      await this.run(root, ['checkout', resolution === 'current' ? '--ours' : '--theirs', '--', slash(relativePath)]);
      await this.run(root, ['add', '--', slash(relativePath)]);
    }
    this.invalidate(root);
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

  async listWorktrees(root: string, signal?: AbortSignal): Promise<Worktree[]> {
    return parseWorktrees(await this.run(root, ['worktree', 'list', '--porcelain', '-z'], signal));
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

  async listStashes(root: string, signal?: AbortSignal): Promise<Stash[]> {
    const output = await this.run(root, [
      'stash',
      'list',
      `--format=%H${FIELD}%at${FIELD}%gd${FIELD}%s`
    ], signal);
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

  private async ensureLinearRange(root: string, base: string | undefined): Promise<void> {
    const range = base ? `${base}..HEAD` : 'HEAD';
    const merges = (await this.run(root, ['rev-list', '--merges', range])).trim();
    if (merges) throw new Error('The rewrite range contains merge commits and cannot be safely flattened.');
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

function safeRepositoryPath(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (!normalizeKey(absolute).startsWith(normalizeKey(prefix))) throw new Error('Path is outside the repository.');
  return absolute;
}
