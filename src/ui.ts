import * as path from 'node:path';
import * as vscode from 'vscode';
import { CommitDetails, FileHistoryEntry, GitService, Repository, RewriteAction, Stash, WORKING_TREE, Worktree } from './git.js';
import { graphWorkbenchHtml } from './graphWebview.js';
import { visualFileHistoryHtml } from './visualHistoryWebview.js';
import { OllamaController } from './ollama.js';
import { safeRepositoryPath } from './security.js';
import { homeViewHtml } from './homeWebview.js';
import { inspectViewHtml } from './inspectWebview.js';
import { welcomeViewHtml } from './welcomeWebview.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

type GraphMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'repository'; root: string }
  | { type: 'search'; query: string; request: number }
  | { type: 'commit'; hash: string }
  | { type: 'compare'; hash: string; target: string }
  | { type: 'compareAny'; base: string; target: string }
  | { type: 'multiDiff'; base: string; target: string }
  | { type: 'rewrite'; action: RewriteAction; hash: string; subject: string }
  | { type: 'rewriteMany'; action: 'squash' | 'drop'; hashes: string[]; subject: string }
  | { type: 'reorder'; hash: string; before: string }
  | { type: 'rebaseContinue' }
  | { type: 'rebaseAbort' }
  | { type: 'checkout'; ref: string }
  | { type: 'switchBranch'; ref: string }
  | { type: 'fetch' | 'pull' | 'push' | 'publish' | 'undoCommit' }
  | { type: 'merge' | 'rebaseBranch'; ref: string }
  | { type: 'revert'; hash: string }
  | { type: 'reset'; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { type: 'launchpad' }
  | { type: 'createBranch'; hash: string }
  | { type: 'cherryPick'; hash: string }
  | { type: 'diffFile'; hash: string; parent?: string; file: string; oldFile?: string }
  | { type: 'diffComparison'; base: string; target: string; status: string; file: string; oldFile?: string }
  | { type: 'workingDiff'; file: string; mode?: 'combined' | 'staged' | 'unstaged' }
  | { type: 'stage'; file: string }
  | { type: 'unstage'; file: string }
  | { type: 'discard'; file: string; untracked: boolean }
  | { type: 'resolveConflict'; file: string; resolution: 'current' | 'incoming' | 'delete' }
  | { type: 'batchFiles'; action: 'stage' | 'unstage' | 'discard' | 'stash' | 'multiDiff'; files: string[] }
  | { type: 'commitWorking'; message: string }
  | { type: 'generateCommitMessage' | 'explainWorking' }
  | { type: 'explainCommit'; hash: string }
  | { type: 'copyWorkingPatch'; staged: boolean }
  | { type: 'stashView'; ref: string }
  | { type: 'addWorktree' }
  | { type: 'openWorktree'; path: string }
  | { type: 'removeWorktree'; path: string };

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly git: GitService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = new URLSearchParams(uri.query);
    const root = query.get('root');
    const hash = query.get('hash');
    const file = query.get('file');
    if (!root || !hash || !file) return '';
    try {
      return hash === ':index'
        ? await this.git.fileAtIndex(root, file)
        : await this.git.fileAtRevision(root, hash, file);
    } catch {
      return '';
    }
  }
}

export class RepositoryViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'gitloupe.homeView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly openGraph: () => Promise<void>
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.onDidReceiveMessage((message: { type?: string; root?: string; ref?: string }) => {
      if (message?.type === 'openGraph') void this.openGraph();
      else if (message?.type === 'refresh') void this.refresh();
      else if (message?.type === 'openFileHistory') void vscode.commands.executeCommand('gitloupe.openFileHistory');
      else if (message?.type === 'openRepositoryHistory') void vscode.commands.executeCommand('gitloupe.openRepositoryHistory');
      else if (message?.type === 'openLaunchpad') void vscode.commands.executeCommand('gitloupe.openLaunchpad');
      else if (message?.type === 'stashView') void vscode.commands.executeCommand('gitloupe.openStash', { root: message.root, ref: message.ref });
      else if (message?.type === 'stashPop') void vscode.commands.executeCommand('gitloupe.popStash', { root: message.root, ref: message.ref });
      else if (message?.type === 'stashApply') void vscode.commands.executeCommand('gitloupe.applyStash', { root: message.root, ref: message.ref });
      else if (message?.type === 'stashDrop') void vscode.commands.executeCommand('gitloupe.dropStash', { root: message.root, ref: message.ref });
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    const repositories = await this.git.discoverRepositories();
    const stashes = new Map<string, Stash[]>();
    await Promise.all(
      repositories.map(async repo => {
        try {
          stashes.set(repo.root, await this.git.listStashes(repo.root));
        } catch {
          stashes.set(repo.root, []);
        }
      })
    );
    const nonce = createNonce();
    this.view.webview.html = homeViewHtml(repositories, stashes, nonce);
  }
}

export class WelcomeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'gitloupe.welcomeView';

  constructor(private readonly openGraph: () => Promise<void>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = welcomeViewHtml(createNonce());
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'openGraph') void this.openGraph();
    });
  }
}

export class InspectViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'gitloupe.inspectView';

  constructor(private readonly openGraph: () => Promise<void>) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = inspectViewHtml(createNonce());
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'openGraph') void this.openGraph();
      else if (message?.type === 'openFileHistory') void vscode.commands.executeCommand('gitloupe.openFileHistory');
      else if (message?.type === 'openRepositoryHistory') void vscode.commands.executeCommand('gitloupe.openRepositoryHistory');
    });
  }
}

export class GraphPanel {
  private panel?: vscode.WebviewPanel;
  private repositories: Repository[] = [];
  private selected?: Repository;
  private disposables: vscode.Disposable[] = [];
  private pendingCommit?: string;
  private loadGeneration = 0;
  private searchAbort?: AbortController;
  private loadAbort?: AbortController;
  private worktreeWatchers: vscode.Disposable[] = [];
  private watchedWorktreePaths: string[] = [];
  private watcherTimer?: NodeJS.Timeout;
  private operation?: 'rebase' | 'merge' | 'cherry-pick' | 'revert';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly ollama?: OllamaController
  ) {}

  async show(preferredRoot?: string): Promise<void> {
    this.repositories = await this.git.discoverRepositories();
    this.selected = this.repositories.find(repo => repo.root === preferredRoot) ?? this.repositories[0];
    if (!this.selected) {
      void vscode.window.showInformationMessage('GitLoupe: Open a folder containing a Git repository first.');
      return;
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.load();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gitloupe.graph',
      `GitLoupe — ${this.selected.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri]
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'gitloupe.svg');
    this.panel.webview.html = graphWorkbenchHtml(createNonce());
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(message => void this.handleMessage(message as GraphMessage)),
      this.panel.onDidDispose(() => {
        this.searchAbort?.abort();
        this.loadAbort?.abort();
        if (this.watcherTimer) clearTimeout(this.watcherTimer);
        for (const watcher of this.worktreeWatchers.splice(0)) watcher.dispose();
        this.panel = undefined;
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
      })
    );
  }

  async refresh(): Promise<void> {
    if (this.panel) await this.load();
  }

  async revealCommit(root?: string, hash?: string): Promise<void> {
    if (!root || !hash) return;
    this.pendingCommit = hash;
    await this.show(root);
  }

  async manageSelectedFiles(): Promise<void> {
    this.repositories = await this.git.discoverRepositories();
    this.selected ??= this.repositories[0];
    if (!this.selected) throw new Error('Open a Git repository first.');
    const status = await this.git.status(this.selected.root);
    const picks = await vscode.window.showQuickPick(
      status.files.map(file => ({
        label: file.path,
        description: `${file.indexStatus}${file.worktreeStatus}${file.conflicted ? ' · conflicted' : ''}`,
        file
      })),
      { title: 'GitLoupe: Select working files', canPickMany: true, matchOnDescription: true }
    );
    if (!picks?.length) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Open selected changes', value: 'multiDiff' as const },
        { label: 'Stage selected', value: 'stage' as const },
        { label: 'Unstage selected', value: 'unstage' as const },
        { label: 'Stash selected', value: 'stash' as const },
        { label: 'Discard selected working changes', value: 'discard' as const }
      ],
      { title: `${picks.length} selected files` }
    );
    if (action) await this.batchFiles(action.value, picks.map(item => item.file.path));
  }

  async manageWorktree(): Promise<void> {
    this.repositories = await this.git.discoverRepositories();
    this.selected ??= this.repositories[0];
    if (!this.selected) throw new Error('Open a Git repository first.');
    const worktrees = (await this.git.listWorktrees(this.selected.root)).filter(tree => !tree.bare);
    const choice = await vscode.window.showQuickPick(
      worktrees.map(tree => ({
        label: tree.branch || '(detached)',
        description: tree.path,
        tree
      })),
      { title: 'GitLoupe: Select worktree', matchOnDescription: true }
    );
    if (!choice) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: 'Open in new window', value: 'open' as const },
        { label: 'Open integrated terminal', value: 'terminal' as const },
        { label: 'Fetch remotes', value: 'fetch' as const },
        { label: 'Fast-forward pull', value: 'pull' as const },
        { label: 'Push', value: 'push' as const }
      ],
      { title: choice.tree.path }
    );
    if (!action) return;
    if (action.value === 'open') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(choice.tree.path), true);
    } else if (action.value === 'terminal') {
      const terminal = vscode.window.createTerminal({ name: `GitLoupe: ${choice.label}`, cwd: choice.tree.path });
      terminal.show();
    } else {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${action.label}: ${choice.label}…` },
        () => action.value === 'fetch'
          ? this.git.fetch(choice.tree.path)
          : action.value === 'pull'
            ? this.git.pull(choice.tree.path)
            : this.git.push(choice.tree.path)
      );
      await this.load();
    }
  }

  private async handleMessage(message: GraphMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.load();
          break;
        case 'repository': {
          const selected = this.repositories.find(repo => repo.root === message.root);
          if (selected) {
            this.selected = selected;
            await this.load();
          }
          break;
        }
        case 'search':
          await this.search(message.query, message.request);
          break;
        case 'commit':
          await this.sendCommit(message.hash);
          break;
        case 'compare':
          await this.compare(message.hash, message.target);
          break;
        case 'compareAny':
          await this.compare(message.base, message.target);
          break;
        case 'multiDiff':
          await this.openMultiDiff(message.base, message.target);
          break;
        case 'rewrite':
          await this.rewrite(message.action, message.hash, message.subject);
          break;
        case 'rewriteMany':
          await this.rewriteMany(message.action, message.hashes, message.subject);
          break;
        case 'reorder':
          await this.reorder(message.hash, message.before);
          break;
        case 'rebaseContinue':
          await this.finishRebase(false);
          break;
        case 'rebaseAbort':
          await this.finishRebase(true);
          break;
        case 'checkout':
          await this.checkout(message.ref);
          break;
        case 'switchBranch':
          await this.checkout(message.ref);
          break;
        case 'fetch':
          await this.fetch();
          break;
        case 'pull':
          await this.sync('pull');
          break;
        case 'push':
          await this.sync('push');
          break;
        case 'publish':
          await this.sync('publish');
          break;
        case 'merge':
          await this.integrate('merge', message.ref);
          break;
        case 'rebaseBranch':
          await this.integrate('rebase', message.ref);
          break;
        case 'undoCommit':
          await this.undoCommit();
          break;
        case 'revert':
          await this.revert(message.hash);
          break;
        case 'reset':
          await this.reset(message.hash, message.mode);
          break;
        case 'launchpad':
          await vscode.commands.executeCommand('gitloupe.openLaunchpad');
          break;
        case 'createBranch':
          await this.createBranch(message.hash);
          break;
        case 'cherryPick':
          await this.cherryPick(message.hash);
          break;
        case 'diffFile':
          await this.diffFile(message.hash, message.parent, message.file, message.oldFile);
          break;
        case 'diffComparison':
          await this.diffComparison(message.base, message.target, message.status, message.file, message.oldFile);
          break;
        case 'workingDiff':
          await this.workingDiff(message.file, message.mode ?? 'combined');
          break;
        case 'stage':
          await this.changeStage(message.file, true);
          break;
        case 'unstage':
          await this.changeStage(message.file, false);
          break;
        case 'discard':
          await this.discard(message.file, message.untracked);
          break;
        case 'resolveConflict':
          await this.resolveConflict(message.file, message.resolution);
          break;
        case 'batchFiles':
          await this.batchFiles(message.action, message.files);
          break;
        case 'commitWorking':
          await this.commitWorking(message.message);
          break;
        case 'generateCommitMessage':
          await this.generateCommitMessage();
          break;
        case 'explainWorking':
          await this.explainWorking();
          break;
        case 'explainCommit':
          await this.explainCommit(message.hash);
          break;
        case 'copyWorkingPatch':
          await this.copyWorkingPatch(message.staged);
          break;
        case 'stashView':
          if (this.selected) {
            await vscode.commands.executeCommand('gitloupe.openStash', { root: this.selected.root, ref: message.ref });
          }
          break;
        case 'addWorktree':
          await this.addWorktree();
          break;
        case 'openWorktree':
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(await this.validateWorktreePath(message.path)), true);
          break;
        case 'removeWorktree':
          await this.removeWorktree(await this.validateWorktreePath(message.path));
          break;
      }
    } catch (error) {
      await this.send({ type: 'error', message: errorMessage(error) });
    }
  }

  private async load(): Promise<void> {
    const repo = this.selected;
    if (!repo || !this.panel) return;
    this.searchAbort?.abort();
    this.loadAbort?.abort();
    const controller = new AbortController();
    this.loadAbort = controller;
    this.git.invalidate(repo.root);
    const generation = ++this.loadGeneration;
    await this.send({ type: 'loading', value: true });
    try {
      const limit = vscode.workspace.getConfiguration('gitloupe').get('graph.maxCommits', 500);
      const [commits, worktrees, branch, refs, status, stashes, operation] = await Promise.all([
        this.git.graph(repo.root, limit, controller.signal),
        this.git.listWorktrees(repo.root, controller.signal),
        this.git.currentBranch(repo.root, controller.signal),
        this.git.refs(repo.root, controller.signal),
        this.git.status(repo.root, controller.signal),
        this.git.listStashes(repo.root, controller.signal),
        this.git.operationState(repo.root, controller.signal)
      ]);
      const workingTrees = await Promise.all(worktrees.map(async tree => ({
        ...tree,
        status: tree.bare ? undefined : await this.git.status(tree.path, controller.signal).catch(() => undefined)
      })));
      if (generation !== this.loadGeneration || repo !== this.selected) return;
      repo.branch = branch;
      this.operation = operation;
      this.watchWorktrees(workingTrees.filter(tree => !tree.bare).map(tree => tree.path));
      this.panel.title = `GitLoupe — ${repo.name}`;
      await this.send({
        type: 'graph',
        repositories: this.repositories,
        repository: repo,
        commits,
        worktrees: workingTrees,
        refs,
        status,
        stashes,
        operation
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (generation === this.loadGeneration) {
        await this.send({ type: 'loading', value: false });
        if (this.pendingCommit) {
          const hash = this.pendingCommit;
          this.pendingCommit = undefined;
          await this.sendCommit(hash);
        }
      }
    }
  }

  private async search(query: string, request: number): Promise<void> {
    const repo = this.selected;
    if (!repo) return;
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    const limit = vscode.workspace.getConfiguration('gitloupe').get('graph.maxCommits', 500);
    let commits;
    try {
      commits = await this.git.searchGraph(repo.root, query, limit, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    }
    if (repo !== this.selected) return;
    await this.send({ type: 'search', request, commits });
  }

  private async sendCommit(hash: string): Promise<void> {
    if (!this.selected) return;
    const details = await this.git.commitDetails(this.selected.root, hash);
    await this.send({ type: 'commit', commit: details });
  }

  private async compare(hash: string, target: string): Promise<void> {
    if (!this.selected) return;
    const comparison = await this.git.compareAny(this.selected.root, hash, target);
    await this.send({ type: 'comparison', comparison });
  }

  private async openMultiDiff(base: string, target: string): Promise<void> {
    if (!this.selected) return;
    const comparison = await this.git.compareAny(this.selected.root, base, target);
    if (!comparison.files.length) {
      void vscode.window.showInformationMessage('GitLoupe: These revisions have no file changes.');
      return;
    }
    const makeUri = (revision: string, revisionFile: string) => vscode.Uri.from({
      scheme: 'gitloupe',
      path: `/${path.basename(revisionFile)}`,
      query: new URLSearchParams({ root: this.selected!.root, hash: revision, file: revisionFile }).toString()
    });
    const resources = comparison.files.map(file => [
      vscode.Uri.file(safeWorkingPath(this.selected!.root, file.path)),
      makeUri(base, file.oldPath ?? file.path),
      target === WORKING_TREE && !file.status.startsWith('D')
        ? vscode.Uri.file(safeWorkingPath(this.selected!.root, file.path))
        : makeUri(target === WORKING_TREE ? ':empty' : target, file.path)
    ]);
    await vscode.commands.executeCommand(
      'vscode.changes',
      `GitLoupe: ${base.slice(0, 8)} ↔ ${target}`,
      resources
    );
  }

  private async rewrite(action: RewriteAction, hash: string, subject: string): Promise<void> {
    if (!this.selected) return;
    const labels: Record<RewriteAction, string> = {
      reword: 'Reword',
      squash: 'Squash into Parent',
      fixup: 'Fixup into Parent',
      drop: 'Drop',
      moveParent: 'Move toward Parent',
      moveHead: 'Move toward HEAD'
    };
    let message: string | undefined;
    if (action === 'reword' || action === 'squash') {
      message = await vscode.window.showInputBox({
        title: labels[action],
        prompt: action === 'squash' ? 'Message for the combined commit' : 'New commit message',
        value: subject,
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Enter a commit message.'
      });
      if (message === undefined) return;
    }
    const answer = await vscode.window.showWarningMessage(
      `${labels[action]} ${hash.slice(0, 8)}?`,
      {
        modal: true,
        detail: 'This rewrites the current branch. GitLoupe will create a gitloupe/backup-* recovery branch first. The working tree must be clean.'
      },
      labels[action]
    );
    if (answer !== labels[action]) return;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${labels[action]}…` },
        () => this.git.rewriteCommit(this.selected!.root, action, hash, message)
      );
      void vscode.window.showInformationMessage(`GitLoupe: History updated. Recovery branch: ${result.backup}`);
    } catch (error) {
      if (await this.git.rebaseState(this.selected.root)) {
        const choice = await vscode.window.showErrorMessage(
          `GitLoupe: Rebase paused. Resolve conflicts, then continue, or abort to restore the original branch. ${errorMessage(error)}`,
          'Open Source Control',
          'Abort Rebase'
        );
        if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
        if (choice === 'Abort Rebase') await this.git.rebaseAbort(this.selected.root);
      } else {
        throw error;
      }
    }
    await this.load();
  }

  private async rewriteMany(
    action: 'squash' | 'drop',
    hashes: string[],
    subject: string
  ): Promise<void> {
    if (!this.selected || hashes.length < 2) return;
    const label = action === 'squash' ? 'Squash Selected' : 'Drop Selected';
    let message: string | undefined;
    if (action === 'squash') {
      message = await vscode.window.showInputBox({
        title: label,
        prompt: 'Message for the combined commit',
        value: subject,
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Enter a commit message.'
      });
      if (message === undefined) return;
    }
    const answer = await vscode.window.showWarningMessage(
      `${label} (${hashes.length} commits)?`,
      {
        modal: true,
        detail: 'This rewrites the current branch. GitLoupe creates a gitloupe/backup-* recovery branch first.'
      },
      label
    );
    if (answer !== label) return;
    try {
      const result = await this.git.rewriteCommits(this.selected.root, action, hashes, message);
      void vscode.window.showInformationMessage(`GitLoupe: History updated. Recovery branch: ${result.backup}`);
    } catch (error) {
      if (await this.git.rebaseState(this.selected.root)) {
        void vscode.window.showErrorMessage(`GitLoupe: Rebase paused. Resolve conflicts in Source Control, then continue or abort. ${errorMessage(error)}`);
        await vscode.commands.executeCommand('workbench.view.scm');
      } else {
        throw error;
      }
    }
    await this.load();
  }

  private async reorder(hash: string, before: string): Promise<void> {
    if (!this.selected || hash === before) return;
    const answer = await vscode.window.showWarningMessage(
      `Move ${hash.slice(0, 8)} before ${before.slice(0, 8)}?`,
      {
        modal: true,
        detail: 'This rewrites the current branch. GitLoupe creates a gitloupe/backup-* recovery branch first. The working tree must be clean.'
      },
      'Move Commit'
    );
    if (answer !== 'Move Commit') return;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Reordering commit…' },
        () => this.git.moveCommitBefore(this.selected!.root, hash, before)
      );
      void vscode.window.showInformationMessage(`GitLoupe: History updated. Recovery branch: ${result.backup}`);
    } catch (error) {
      if (await this.git.rebaseState(this.selected.root)) {
        void vscode.window.showErrorMessage(`GitLoupe: Rebase paused. Resolve conflicts in Source Control, then continue or abort. ${errorMessage(error)}`);
        await vscode.commands.executeCommand('workbench.view.scm');
      } else {
        throw error;
      }
    }
    await this.load();
  }

  private async finishRebase(abort: boolean): Promise<void> {
    if (!this.selected || !this.operation) return;
    if (abort) {
      const label = `Abort ${this.operation}`;
      const answer = await vscode.window.showWarningMessage(`Abort the active ${this.operation}?`, { modal: true }, label);
      if (answer !== label) return;
      await this.git.abortOperation(this.selected.root, this.operation);
    } else {
      await this.git.continueOperation(this.selected.root, this.operation);
    }
    await this.load();
  }

  private async checkout(ref: string): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Checkout "${ref}" in ${this.selected.name}?`,
      { modal: true },
      'Checkout'
    );
    if (answer !== 'Checkout') return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out ${ref}…` },
      () => this.git.checkout(this.selected!.root, ref)
    );
    await this.load();
  }

  private async fetch(): Promise<void> {
    if (!this.selected) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching ${this.selected.name}…` },
      () => this.git.fetch(this.selected!.root)
    );
    await this.load();
  }

  private async sync(action: 'pull' | 'push' | 'publish'): Promise<void> {
    if (!this.selected) return;
    const label = action === 'publish' ? 'Publish Branch' : action[0]!.toUpperCase() + action.slice(1);
    const run = action === 'pull'
      ? () => this.git.pull(this.selected!.root)
      : () => this.git.push(this.selected!.root, action === 'publish');
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${label}: ${this.selected.branch}…` },
      run
    );
    await this.load();
  }

  private async integrate(action: 'merge' | 'rebase', ref: string): Promise<void> {
    if (!this.selected) return;
    const label = action === 'merge' ? 'Merge' : 'Rebase';
    const answer = await vscode.window.showWarningMessage(
      `${label} "${ref}" ${action === 'merge' ? 'into' : 'onto'} "${this.selected.branch}"?`,
      { modal: true, detail: 'The working tree must be clean. Conflicts may pause the operation.' },
      label
    );
    if (answer !== label) return;
    if (action === 'merge') await this.git.merge(this.selected.root, ref);
    else await this.git.rebaseBranch(this.selected.root, ref);
    await this.load();
  }

  private async undoCommit(): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Undo the latest commit on "${this.selected.branch}"?`,
      { modal: true, detail: 'The commit is removed with a mixed reset; its changes remain in the working tree.' },
      'Undo Commit'
    );
    if (answer !== 'Undo Commit') return;
    await this.git.undoCommit(this.selected.root);
    await this.load();
  }

  private async revert(hash: string): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Create a revert commit for ${hash.slice(0, 8)}?`,
      { modal: true },
      'Revert'
    );
    if (answer !== 'Revert') return;
    await this.git.revert(this.selected.root, hash);
    await this.load();
  }

  private async reset(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    if (!this.selected) return;
    const destructive = mode === 'hard';
    const answer = await vscode.window.showWarningMessage(
      `Reset "${this.selected.branch}" to ${hash.slice(0, 8)} (${mode})?`,
      {
        modal: true,
        detail: destructive
          ? 'Hard reset permanently discards tracked working-tree and index changes.'
          : mode === 'mixed'
            ? 'Commits are removed and their changes remain unstaged.'
            : 'Commits are removed and their changes remain staged.'
      },
      destructive ? 'Hard Reset' : 'Reset'
    );
    if (answer !== (destructive ? 'Hard Reset' : 'Reset')) return;
    await this.git.resetTo(this.selected.root, hash, mode);
    await this.load();
  }

  private async createBranch(hash: string): Promise<void> {
    if (!this.selected) return;
    const name = await vscode.window.showInputBox({
      title: `Create branch at ${hash.slice(0, 8)}`,
      prompt: 'Branch name',
      validateInput: value => value.trim() ? undefined : 'Enter a branch name.'
    });
    if (!name) return;
    await this.git.createBranch(this.selected.root, name.trim(), hash);
    await this.load();
  }

  private async cherryPick(hash: string): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Cherry-pick ${hash.slice(0, 8)} onto ${this.selected.branch}?`,
      { modal: true, detail: 'This changes the working tree and current branch.' },
      'Cherry-pick'
    );
    if (answer !== 'Cherry-pick') return;
    await this.git.cherryPick(this.selected.root, hash);
    await this.load();
  }

  private async diffFile(hash: string, parent: string | undefined, file: string, oldFile?: string): Promise<void> {
    if (!this.selected) return;
    const leftHash = parent ?? EMPTY_TREE;
    const makeUri = (revision: string, revisionFile: string) => vscode.Uri.from({
      scheme: 'gitloupe',
      path: `/${path.basename(revisionFile)}`,
      query: new URLSearchParams({ root: this.selected!.root, hash: revision, file: revisionFile }).toString()
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      makeUri(leftHash, oldFile ?? file),
      makeUri(hash, file),
      `${file} (${leftHash.slice(0, 8)} ↔ ${hash.slice(0, 8)})`
    );
  }

  private async workingDiff(file: string, mode: 'combined' | 'staged' | 'unstaged'): Promise<void> {
    if (!this.selected) return;
    const absolute = safeWorkingPath(this.selected.root, file);
    const makeUri = (hash: string) => vscode.Uri.from({
      scheme: 'gitloupe',
      path: `/${path.basename(file)}`,
      query: new URLSearchParams({ root: this.selected!.root, hash, file }).toString()
    });
    const left = makeUri(mode === 'unstaged' ? ':index' : 'HEAD');
    const right = mode === 'staged' ? makeUri(':index') : vscode.Uri.file(absolute);
    const label = mode === 'staged' ? 'HEAD ↔ Index' : mode === 'unstaged' ? 'Index ↔ Working Tree' : 'HEAD ↔ Working Tree';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${file} (${label})`);
  }

  private async diffComparison(
    base: string,
    target: string,
    status: string,
    file: string,
    oldFile?: string
  ): Promise<void> {
    if (!this.selected) return;
    const makeUri = (revision: string, revisionFile: string) => vscode.Uri.from({
      scheme: 'gitloupe',
      path: `/${path.basename(revisionFile)}`,
      query: new URLSearchParams({ root: this.selected!.root, hash: revision, file: revisionFile }).toString()
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      makeUri(base, oldFile ?? file),
      target === WORKING_TREE && !status.startsWith('D')
        ? vscode.Uri.file(safeWorkingPath(this.selected.root, file))
        : makeUri(target === WORKING_TREE ? ':empty' : target, file),
      `${file} (${base.slice(0, 8)} ↔ ${target})`
    );
  }

  private async changeStage(file: string, stage: boolean): Promise<void> {
    if (!this.selected) return;
    safeWorkingPath(this.selected.root, file);
    if (stage) await this.git.stage(this.selected.root, file);
    else await this.git.unstage(this.selected.root, file);
    await this.load();
  }

  private async discard(file: string, untracked: boolean): Promise<void> {
    if (!this.selected) return;
    safeWorkingPath(this.selected.root, file);
    if (untracked) throw new Error('Untracked files are never deleted by GitLoupe. Remove the file from Explorer if intended.');
    const answer = await vscode.window.showWarningMessage(
      `Discard working changes in "${file}"?`,
      { modal: true, detail: 'This restores the file from the index and cannot be undone by Git.' },
      'Discard Changes'
    );
    if (answer !== 'Discard Changes') return;
    await this.git.discard(this.selected.root, file);
    await this.load();
  }

  private async resolveConflict(file: string, resolution: 'current' | 'incoming' | 'delete'): Promise<void> {
    if (!this.selected) return;
    safeWorkingPath(this.selected.root, file);
    const label = resolution === 'current' ? 'Take Current' : resolution === 'incoming' ? 'Take Incoming' : 'Delete';
    const answer = await vscode.window.showWarningMessage(
      `${label} for conflicted file "${file}"?`,
      {
        modal: true,
        detail: 'For rebases, Git’s current/incoming sides can differ from merge terminology. Review the staged result before continuing.'
      },
      label
    );
    if (answer !== label) return;
    await this.git.resolveConflict(this.selected.root, file, resolution);
    await this.load();
  }

  private async batchFiles(
    action: 'stage' | 'unstage' | 'discard' | 'stash' | 'multiDiff',
    files: string[]
  ): Promise<void> {
    if (!this.selected) return;
    const unique = [...new Set(files)].filter(Boolean);
    if (!unique.length) return;
    unique.forEach(file => safeWorkingPath(this.selected!.root, file));
    if (action === 'multiDiff') {
      const resources = unique.map(file => [
        vscode.Uri.file(safeWorkingPath(this.selected!.root, file)),
        vscode.Uri.from({
          scheme: 'gitloupe',
          path: `/${path.basename(file)}`,
          query: new URLSearchParams({ root: this.selected!.root, hash: 'HEAD', file }).toString()
        }),
        vscode.Uri.file(safeWorkingPath(this.selected!.root, file))
      ]);
      await vscode.commands.executeCommand('vscode.changes', `GitLoupe: ${unique.length} working files`, resources);
      return;
    }
    if (action === 'discard') {
      const status = await this.git.status(this.selected.root);
      const untracked = unique.filter(file => status.files.some(item => item.path === file && item.untracked));
      if (untracked.length) throw new Error(`Untracked files are never deleted by GitLoupe: ${untracked.join(', ')}`);
      const answer = await vscode.window.showWarningMessage(
        `Discard working changes in ${unique.length} selected files?`,
        { modal: true, detail: 'Tracked working-tree changes are restored from the index and cannot be recovered by Git.' },
        'Discard Selected'
      );
      if (answer !== 'Discard Selected') return;
    }
    if (action === 'stash') {
      const message = await vscode.window.showInputBox({ title: `Stash ${unique.length} selected files`, value: `Selected files from ${this.selected.branch}` });
      if (message === undefined) return;
      await this.git.createStash(this.selected.root, message || undefined, unique);
    } else {
      for (const file of unique) {
        if (action === 'stage') await this.git.stage(this.selected.root, file);
        if (action === 'unstage') await this.git.unstage(this.selected.root, file);
        if (action === 'discard') await this.git.discard(this.selected.root, file);
      }
    }
    await this.load();
  }

  private async commitWorking(message: string): Promise<void> {
    if (!this.selected || !message.trim()) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Committing on ${this.selected.branch}…` },
      () => this.git.commit(this.selected!.root, message)
    );
    await this.load();
  }

  private async generateCommitMessage(): Promise<void> {
    if (!this.selected || !this.ollama) return;
    const message = await this.ollama.generateCommitMessage(this.selected.root);
    await this.send({ type: 'commitMessage', message });
  }

  private async explainWorking(): Promise<void> {
    if (!this.selected || !this.ollama) return;
    await showMarkdownDocument('GitLoupe — Working Changes Explanation', await this.ollama.explainWorkingChanges(this.selected.root));
  }

  private async explainCommit(hash: string): Promise<void> {
    if (!this.selected || !this.ollama) return;
    await showMarkdownDocument(`GitLoupe — ${hash.slice(0, 8)} Explanation`, await this.ollama.explainCommit(this.selected.root, hash));
  }

  private async copyWorkingPatch(staged: boolean): Promise<void> {
    if (!this.selected) return;
    const patch = await this.git.diffWorking(this.selected.root, staged);
    await vscode.env.clipboard.writeText(patch);
    void vscode.window.showInformationMessage(`GitLoupe: Copied ${staged ? 'staged' : 'working'} changes as a patch.`);
  }

  private async addWorktree(): Promise<void> {
    if (!this.selected) return;
    const parent = await vscode.window.showOpenDialog({
      title: 'Choose the parent folder for the new worktree',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false
    });
    if (!parent?.[0]) return;
    const folderName = await vscode.window.showInputBox({
      title: 'New worktree folder',
      value: `${this.selected.name}-worktree`,
      validateInput: value => value.trim() ? undefined : 'Enter a folder name.'
    });
    if (!folderName) return;
    const refs = (await this.git.graph(this.selected.root, 100))
      .flatMap(commit => commit.refs)
      .map(cleanRef)
      .filter((ref, index, all) => ref && all.indexOf(ref) === index);
    const selectedRef = await vscode.window.showQuickPick(
      [{ label: 'HEAD', description: 'Current revision' }, ...refs.map(ref => ({ label: ref }))],
      { title: 'Revision for the new worktree' }
    );
    if (!selectedRef) return;
    await this.git.addWorktree(this.selected.root, path.join(parent[0].fsPath, folderName), selectedRef.label);
    await this.load();
  }

  private async removeWorktree(worktreePath: string): Promise<void> {
    if (!this.selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Remove worktree "${worktreePath}"?`,
      { modal: true, detail: 'Git refuses removal when the worktree has uncommitted changes.' },
      'Remove'
    );
    if (answer !== 'Remove') return;
    await this.git.removeWorktree(this.selected.root, worktreePath);
    await this.load();
  }

  private async send(message: unknown): Promise<void> {
    await this.panel?.webview.postMessage(message);
  }

  private async validateWorktreePath(candidate: string): Promise<string> {
    if (!this.selected) throw new Error('No repository is selected.');
    const worktrees = await this.git.listWorktrees(this.selected.root);
    const normalized = path.resolve(candidate);
    const match = worktrees.find(tree => path.resolve(tree.path) === normalized);
    if (!match) throw new Error('The requested path is not a linked worktree of the selected repository.');
    return match.path;
  }

  private watchWorktrees(paths: string[]): void {
    if (this.watchedWorktreePaths.length === paths.length && paths.every(value => this.watchedWorktreePaths.includes(value))) return;
    for (const watcher of this.worktreeWatchers.splice(0)) watcher.dispose();
    this.watchedWorktreePaths = paths.slice();
    for (const worktreePath of paths) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(worktreePath, '**/*'));
      const queue = (): void => {
        if (this.watcherTimer) clearTimeout(this.watcherTimer);
        this.watcherTimer = setTimeout(() => {
          this.watcherTimer = undefined;
          void this.load();
        }, 300);
      };
      this.worktreeWatchers.push(
        watcher,
        watcher.onDidCreate(queue),
        watcher.onDidChange(queue),
        watcher.onDidDelete(queue)
      );
    }
  }
}

export async function showFileHistory(
  extensionUri: vscode.Uri,
  git: GitService,
  resource?: vscode.Uri,
  repositoryOnly = false
): Promise<void> {
  let uri = resource ?? (repositoryOnly ? undefined : vscode.window.activeTextEditor?.document.uri);
  if (!uri && repositoryOnly) {
    const repositories = await git.discoverRepositories();
    const selected = await vscode.window.showQuickPick(
      repositories.map(repository => ({ label: repository.name, description: repository.root, repository })),
      { title: 'Repository Visual History' }
    );
    if (selected) uri = vscode.Uri.file(selected.repository.root);
  }
  if (!uri || uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('GitLoupe: Select a file, folder, or repository first.');
    return;
  }
  try {
    const repo = await git.findRepository(uri.fsPath);
    const kind = await vscode.workspace.fs.stat(uri);
    const isDirectory = (kind.type & vscode.FileType.Directory) !== 0;
    const entries = isDirectory
      ? await git.scopeHistory(repo.root, uri.fsPath)
      : await git.fileHistory(repo.root, uri.fsPath);
    const relative = path.relative(repo.root, uri.fsPath).replaceAll('\\', '/');
    const scope = relative || repo.name;
    const panel = vscode.window.createWebviewPanel(
      'gitloupe.fileHistory',
      `History — ${scope}`,
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri] }
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'gitloupe.svg');
    panel.webview.html = visualFileHistoryHtml(scope, entries, createNonce());
    panel.webview.onDidReceiveMessage((message: { type?: string; hash?: string }) => {
      if (message.type === 'commit' && message.hash) {
        void vscode.commands.executeCommand('gitloupe.openCommit', { root: repo.root, hash: message.hash });
      }
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`GitLoupe: ${errorMessage(error)}`);
  }
}

function graphHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${commonCss()}
    body { overflow: hidden; }
    header { height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--vscode-panel-border); }
    header select { min-width: 160px; }
    #search { flex: 1; max-width: 520px; }
    .layout { display: grid; grid-template-columns: minmax(440px, 1fr) minmax(280px, 390px); height: calc(100vh - 49px); }
    .list { overflow: auto; }
    .row { height: 34px; display: grid; grid-template-columns: 112px minmax(180px,1fr) 130px 100px; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); cursor: pointer; }
    .row:hover, .row.selected { background: var(--vscode-list-hoverBackground); }
    .graph { width: 112px; height: 34px; overflow: visible; }
    .subject { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8px; }
    .author,.date { color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .refs { display: inline-flex; gap: 4px; margin-right: 7px; vertical-align: middle; }
    .ref { border: 1px solid var(--vscode-badge-background); border-radius: 9px; padding: 0 6px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: 10px; }
    aside { border-left: 1px solid var(--vscode-panel-border); overflow: auto; padding: 14px; }
    .empty { display: grid; place-items: center; min-height: 180px; color: var(--vscode-descriptionForeground); text-align: center; }
    .hash { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
    .body { white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
    .file { display: flex; gap: 8px; align-items: center; width: 100%; text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 7px 2px; color: inherit; }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .status { width: 20px; font-weight: 700; color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
    details { margin-top: 18px; }
    summary { cursor: pointer; font-weight: 600; }
    .worktree { margin: 8px 0; padding: 8px; background: var(--vscode-sideBar-background); }
    .worktree-path { overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); font-size: 11px; }
    #loading { width: 100%; height: 2px; position: fixed; top: 48px; z-index: 2; background: var(--vscode-progressBar-background); animation: pulse 1s infinite alternate; display: none; }
    @keyframes pulse { from { opacity:.25 } to { opacity:1 } }
    @media(max-width:760px) { .layout { grid-template-columns:1fr } aside { display:none } .row { grid-template-columns:100px minmax(160px,1fr) 100px } .date{display:none} }
  </style>
</head>
<body>
  <header>
    <select id="repo" aria-label="Repository"></select>
    <input id="search" type="search" placeholder="Search commits, authors, hashes, or refs">
    <button id="refresh" title="Refresh">↻</button>
    <span id="count"></span>
  </header>
  <div id="loading"></div>
  <main class="layout">
    <section id="list" class="list"><div class="empty">Loading commit graph…</div></section>
    <aside id="details"><div class="empty">Select a commit to inspect it.</div></aside>
  </main>
  <script nonce="${nonce}">${graphScript()}</script>
</body>
</html>`;
}

function graphScript(): string {
  return String.raw`
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);
    let model = { commits: [], worktrees: [], repository: null };
    let selectedHash = '';
    const colors = ['#4ec9b0','#569cd6','#dcdcaa','#c586c0','#ce9178','#9cdcfe','#b5cea8'];
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const relative = timestamp => {
      const seconds = Math.max(0, Date.now()/1000 - timestamp);
      if (seconds < 60) return 'now';
      if (seconds < 3600) return Math.floor(seconds/60) + 'm ago';
      if (seconds < 86400) return Math.floor(seconds/3600) + 'h ago';
      if (seconds < 86400*30) return Math.floor(seconds/86400) + 'd ago';
      return new Date(timestamp*1000).toLocaleDateString();
    };
    function cleanRef(ref) {
      return ref.replace(/^HEAD -> /,'').replace(/^tag: /,'').replace(/^origin\//,'');
    }
    function graphState(commits) {
      const lanes = [];
      return commits.map(commit => {
        let lane = lanes.indexOf(commit.hash);
        if (lane < 0) {
          lane = lanes.findIndex(value => !value);
          if (lane < 0) lane = lanes.length;
        }
        lanes[lane] = commit.parents[0] || '';
        for (let i=1; i<commit.parents.length; i++) {
          let target = lanes.indexOf(commit.parents[i]);
          if (target < 0) {
            target = lanes.findIndex((value,index) => index > lane && !value);
            if (target < 0) target = lanes.length;
            lanes[target] = commit.parents[i];
          }
        }
        while (lanes.length && !lanes[lanes.length-1]) lanes.pop();
        return { lane, active: lanes.slice(), parents: commit.parents };
      });
    }
    function graphSvg(state) {
      const x = lane => 12 + lane*16;
      let svg = '';
      state.active.forEach((hash,lane) => {
        if (hash) svg += '<path d="M'+x(lane)+' 0V34" stroke="'+colors[lane%colors.length]+'" />';
      });
      state.parents.slice(1).forEach((parent,index) => {
        const target = state.active.indexOf(parent);
        if (target >= 0) svg += '<path d="M'+x(state.lane)+' 17 C'+x(state.lane)+' 26 '+x(target)+' 8 '+x(target)+' 34" stroke="'+colors[target%colors.length]+'" />';
      });
      svg += '<circle cx="'+x(state.lane)+'" cy="17" r="4.5" fill="'+colors[state.lane%colors.length]+'" stroke="var(--vscode-editor-background)" stroke-width="2"/>';
      return '<svg class="graph" viewBox="0 0 112 34" preserveAspectRatio="xMinYMid meet" fill="none" stroke-width="2">'+svg+'</svg>';
    }
    function render() {
      const query = $('search').value.trim().toLowerCase();
      const states = graphState(model.commits);
      const rows = model.commits.map((commit,index) => ({commit,index})).filter(({commit}) => {
        if (!query) return true;
        return [commit.hash,commit.subject,commit.author,commit.email,...commit.refs].join(' ').toLowerCase().includes(query);
      });
      $('count').textContent = rows.length + ' commits';
      $('list').innerHTML = rows.length ? rows.map(({commit,index}) => {
        const refs = commit.refs.slice(0,3).map(ref => '<span class="ref">'+esc(ref)+'</span>').join('');
        return '<div class="row '+(commit.hash===selectedHash?'selected':'')+'" data-hash="'+commit.hash+'">'+graphSvg(states[index])+
          '<div class="subject"><span class="refs">'+refs+'</span>'+esc(commit.subject)+'</div>'+
          '<div class="author" title="'+esc(commit.email)+'">'+esc(commit.author)+'</div>'+
          '<div class="date">'+relative(commit.timestamp)+'</div></div>';
      }).join('') : '<div class="empty">No matching commits.</div>';
      $('list').querySelectorAll('.row').forEach(row => row.addEventListener('click', () => {
        selectedHash = row.dataset.hash;
        vscode.postMessage({type:'commit',hash:selectedHash});
        render();
      }));
    }
    function renderCommit(commit) {
      const files = commit.files.map(file => '<button class="file" data-file="'+esc(file.path)+'"><span class="status">'+esc(file.status[0])+'</span><span>'+esc(file.oldPath ? file.oldPath+' → '+file.path : file.path)+'</span></button>').join('');
      const refs = commit.refs.map(ref => '<span class="ref">'+esc(ref)+'</span>').join(' ');
      const checkoutRef = commit.refs.map(cleanRef).find(ref => ref && !ref.includes(' -> '));
      $('details').innerHTML = '<div>'+refs+'</div><h2>'+esc(commit.subject)+'</h2>'+
        '<div><span class="hash">'+esc(commit.hash.slice(0,12))+'</span> · '+esc(commit.author)+' · '+new Date(commit.timestamp*1000).toLocaleString()+'</div>'+
        (commit.body?'<p class="body">'+esc(commit.body)+'</p>':'')+
        '<div class="actions">'+(checkoutRef?'<button id="checkout">Checkout '+esc(checkoutRef)+'</button>':'')+'<button id="branch">New branch</button><button id="pick">Cherry-pick</button></div>'+
        '<h3>Changed files ('+commit.files.length+')</h3><div>'+files+'</div>'+
        renderWorktrees();
      $('checkout')?.addEventListener('click',()=>vscode.postMessage({type:'checkout',ref:checkoutRef}));
      $('branch').addEventListener('click',()=>vscode.postMessage({type:'createBranch',hash:commit.hash}));
      $('pick').addEventListener('click',()=>vscode.postMessage({type:'cherryPick',hash:commit.hash}));
      $('details').querySelectorAll('.file').forEach(button => button.addEventListener('click',()=>vscode.postMessage({
        type:'diffFile',hash:commit.hash,parent:commit.parents[0],file:button.dataset.file
      })));
      wireWorktrees();
    }
    function renderWorktrees() {
      return '<details open><summary>Worktrees ('+model.worktrees.length+')</summary>'+
        '<div class="actions"><button id="add-worktree">Add worktree</button></div>'+
        model.worktrees.map((tree,index) => '<div class="worktree"><strong>'+esc(tree.branch || '(detached)')+'</strong>'+
          '<div class="worktree-path">'+esc(tree.path)+'</div><div class="actions"><button data-open="'+index+'">Open</button>'+
          (index?'<button data-remove="'+index+'">Remove</button>':'')+'</div></div>').join('')+'</details>';
    }
    function wireWorktrees() {
      $('add-worktree')?.addEventListener('click',()=>vscode.postMessage({type:'addWorktree'}));
      document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'openWorktree',path:model.worktrees[Number(button.dataset.open)].path})));
      document.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'removeWorktree',path:model.worktrees[Number(button.dataset.remove)].path})));
    }
    $('search').addEventListener('input',render);
    $('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
    $('repo').addEventListener('change',event=>vscode.postMessage({type:'repository',root:event.target.value}));
    window.addEventListener('message',event => {
      const message = event.data;
      if (message.type === 'loading') $('loading').style.display = message.value ? 'block' : 'none';
      if (message.type === 'error') {
        $('loading').style.display = 'none';
        $('details').innerHTML = '<div class="empty">'+esc(message.message)+'</div>';
      }
      if (message.type === 'graph') {
        model = message;
        $('repo').innerHTML = message.repositories.map(repo=>'<option value="'+esc(repo.root)+'" '+(repo.root===message.repository.root?'selected':'')+'>'+esc(repo.name)+' · '+esc(repo.branch)+'</option>').join('');
        selectedHash = '';
        $('details').innerHTML = '<div class="empty"><div><strong>'+esc(message.repository.branch)+'</strong><br>Select a commit to inspect it.<br><br>'+renderWorktrees()+'</div></div>';
        wireWorktrees();
        render();
      }
      if (message.type === 'commit') renderCommit(message.commit);
    });
    vscode.postMessage({type:'ready'});
  `;
}

function fileHistoryHtml(file: string, entries: FileHistoryEntry[], nonce: string): string {
  const data = safeJson(entries);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${commonCss()}
    body { padding: 20px; max-width: 1100px; margin: auto; }
    .summary { color: var(--vscode-descriptionForeground); }
    .chart { display: grid; grid-template-columns: repeat(auto-fit,minmax(8px,1fr)); height: 180px; align-items: end; gap: 2px; margin: 24px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .bar { min-width: 3px; display: flex; flex-direction: column; justify-content: end; cursor: pointer; height: 100%; }
    .added { background: var(--vscode-gitDecoration-addedResourceForeground); min-height: 1px; }
    .deleted { background: var(--vscode-gitDecoration-deletedResourceForeground); min-height: 1px; }
    .entry { display:grid; grid-template-columns: 90px minmax(200px,1fr) 140px 100px; gap: 12px; padding: 8px; border-bottom:1px solid var(--vscode-panel-border); }
    .hash { font-family:var(--vscode-editor-font-family); color:var(--vscode-textLink-foreground) }
    .muted { color:var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
    @media(max-width:650px){.entry{grid-template-columns:80px 1fr}.entry .muted{display:none}}
  </style>
</head>
<body>
  <h1>${escapeHtml(file)}</h1>
  <div id="summary" class="summary"></div>
  <div id="chart" class="chart"></div>
  <div id="entries"></div>
  <script nonce="${nonce}">
    const entries=${data};
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const max=Math.max(1,...entries.map(entry=>entry.added+entry.deleted));
    const totalAdded=entries.reduce((sum,entry)=>sum+entry.added,0);
    const totalDeleted=entries.reduce((sum,entry)=>sum+entry.deleted,0);
    document.getElementById('summary').textContent=entries.length+' revisions · +'+totalAdded+' / −'+totalDeleted+' lines';
    document.getElementById('chart').innerHTML=entries.slice().reverse().map(entry=>{
      const added=entry.added/max*100, deleted=entry.deleted/max*100;
      return '<div class="bar" title="'+esc(entry.subject)+' · +'+entry.added+' −'+entry.deleted+'"><div class="added" style="height:'+added+'%"></div><div class="deleted" style="height:'+deleted+'%"></div></div>';
    }).join('');
    document.getElementById('entries').innerHTML=entries.map(entry=>'<div class="entry"><span class="hash">'+esc(entry.hash.slice(0,8))+'</span><span>'+esc(entry.subject)+'</span><span class="muted">'+esc(entry.author)+'</span><span class="muted">+'+entry.added+' −'+entry.deleted+'</span></div>').join('') || '<p>No history found. The file may be untracked.</p>';
  </script>
</body>
</html>`;
}

async function showMarkdownDocument(title: string, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.window.showTextDocument(document, { preview: true });
  void vscode.window.setStatusBarMessage(title, 4_000);
}

function commonCss(): string {
  return `
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); }
    button, input, select { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border,transparent); padding: 5px 8px; border-radius: 2px; font: inherit; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    input:focus,select:focus,button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    h1 { font-size: 22px; } h2 { font-size: 17px; overflow-wrap:anywhere; } h3 { font-size: 13px; }
  `;
}

function cleanRef(ref: string): string {
  return ref.replace(/^HEAD -> /, '').replace(/^tag: /, '').replace(/^origin\//, '');
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character] ?? character);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeWorkingPath(root: string, relative: string): string {
  // Delegate to the shared, unit-tested boundary check in security.ts.
  return safeRepositoryPath(root, relative);
}
