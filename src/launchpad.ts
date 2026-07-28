import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './git.js';
import { launchpadHtml } from './launchpadWebview.js';
import { GitHubPullRequestProvider, PullRequestSummary } from './providers.js';

interface LaunchpadItem extends PullRequestSummary {
  root: string;
  currentBranch: boolean;
}

type LaunchpadMessage =
  | { type: 'ready' | 'refresh' | 'connect' }
  | { type: 'open' | 'checkout' | 'changes'; index: number };

export class LaunchpadPanel {
  private panel?: vscode.WebviewPanel;
  private items: LaunchpadItem[] = [];
  private abort?: AbortController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly onRepositoryChanged: () => Promise<void>
  ) {}

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.load(false);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'gitloupe.launchpad',
      'GitLoupe — Launchpad',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] }
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'gitloupe.svg');
    this.panel.webview.html = launchpadHtml(createNonce());
    this.panel.webview.onDidReceiveMessage(message => void this.handle(message as LaunchpadMessage));
    this.panel.onDidDispose(() => {
      this.abort?.abort();
      this.panel = undefined;
    });
  }

  private async handle(message: LaunchpadMessage): Promise<void> {
    try {
      if (message.type === 'ready' || message.type === 'refresh') await this.load(false);
      if (message.type === 'connect') await this.load(true);
      if (message.type === 'open') await this.open(message.index);
      if (message.type === 'checkout') await this.checkout(message.index);
      if (message.type === 'changes') await this.openChanges(message.index);
    } catch (error) {
      await this.panel?.webview.postMessage({ type: 'error', message: errorMessage(error) });
    }
  }

  private async load(connect: boolean): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const session = await vscode.authentication.getSession(
      'github',
      ['repo'],
      connect ? { createIfNone: true } : { createIfNone: false }
    );
    const provider = new GitHubPullRequestProvider(session?.accessToken);
    const repositories = await this.git.discoverRepositories();
    const results = await Promise.allSettled(repositories.map(async repository => {
      const remoteUrl = await this.git.remoteUrl(repository.root).catch(() => '');
      const providerRepository = provider.parseRemote(remoteUrl);
      if (!providerRepository) return [];
      const pulls = await provider.listPullRequests(providerRepository, controller.signal);
      return pulls.map(pull => ({
        ...pull,
        root: repository.root,
        currentBranch: pull.head === repository.branch
      }));
    }));
    if (controller.signal.aborted) return;
    this.items = results
      .filter((result): result is PromiseFulfilledResult<LaunchpadItem[]> => result.status === 'fulfilled')
      .flatMap(result => result.value)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    await this.panel?.webview.postMessage({
      type: 'model',
      items: this.items,
      account: session?.account.label,
      warning: results.some(result => result.status === 'rejected')
        ? 'Some repositories could not be loaded. Connect GitHub for private repositories or a higher API rate limit.'
        : undefined
    });
  }

  private async open(index: number): Promise<void> {
    const item = this.items[index];
    if (!item) return;
    const uri = vscode.Uri.parse(item.url);
    if (uri.scheme !== 'https' || uri.authority !== 'github.com') throw new Error('Refusing an unexpected provider URL.');
    await vscode.env.openExternal(uri);
  }

  private async checkout(index: number): Promise<void> {
    const item = this.items[index];
    if (!item) return;
    const answer = await vscode.window.showWarningMessage(
      `Checkout ${item.repository}#${item.number} into a new local branch?`,
      { modal: true, detail: `Creates gitloupe/pr-${item.number} from the provider pull ref.` },
      'Checkout Pull Request'
    );
    if (answer !== 'Checkout Pull Request') return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking out #${item.number}…` },
      () => this.git.checkoutPullRequest(item.root, item.number)
    );
    await Promise.all([this.onRepositoryChanged(), this.load(false)]);
  }

  private async openChanges(index: number): Promise<void> {
    const item = this.items[index];
    if (!item) return;
    const head = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching changes for #${item.number}…` },
      () => this.git.fetchPullRequest(item.root, item.number, 'origin', item.base)
    );
    const base = `origin/${item.base}`;
    const comparison = await this.git.compare(item.root, base, head);
    const makeUri = (revision: string, file: string) => vscode.Uri.from({
      scheme: 'gitloupe',
      path: `/${path.basename(file)}`,
      query: new URLSearchParams({ root: item.root, hash: revision, file }).toString()
    });
    const resources = comparison.files.map(file => [
      vscode.Uri.file(path.resolve(item.root, file.path)),
      makeUri(base, file.oldPath ?? file.path),
      makeUri(head, file.path)
    ]);
    if (!resources.length) {
      void vscode.window.showInformationMessage(`GitLoupe: Pull request #${item.number} has no changes against ${item.base}.`);
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.changes',
      `${item.repository}#${item.number}: ${item.title}`,
      resources
    );
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
