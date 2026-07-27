import { spawn } from 'node:child_process';
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
  parseStashes,
  parseWorktrees,
  Stash,
  Worktree
} from './parsers.js';

export type { Commit, CommitDetails, FileHistoryEntry, Stash, Worktree } from './parsers.js';

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
  private get executable(): string {
    return vscode.workspace.getConfiguration('gitloupe').get('git.path', 'git');
  }

  async run(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['-c', 'color.ui=false', ...args], {
        cwd,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never'
        }
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
      child.on('error', reject);
      child.on('close', code => {
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
    await Promise.all(roots.map(async folder => {
      try {
        const root = (await this.run(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim();
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
        `--format=${RECORD}${COMMIT_FORMAT}`
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
    const names = await this.run(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', hash]);
    return {
      hash: fields[0] ?? '',
      parents: fields[1]?.trim() ? fields[1].trim().split(/\s+/) : [],
      author: fields[2] ?? '',
      email: fields[3] ?? '',
      timestamp: Number(fields[4] ?? 0),
      refs: splitRefs(fields[5]),
      subject: fields[6] ?? '',
      body: fields.slice(7).join(FIELD).trim(),
      files: parseNameStatus(names)
    };
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
    assertRevision(hash);
    return this.run(root, ['show', `${hash}:${slash(relativePath)}`]);
  }

  async checkout(root: string, ref: string): Promise<void> {
    assertRef(ref);
    await this.run(root, ['checkout', ref]);
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

function assertRevision(value: string): void {
  if (!/^[0-9a-fA-F]{4,64}$/.test(value)) throw new Error('Invalid Git revision.');
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
