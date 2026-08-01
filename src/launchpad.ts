import * as vscode from 'vscode';
import * as path from 'node:path';
import { GitService } from './git.js';
import { launchpadHtml } from './launchpadWebview.js';
import {
  BitbucketPullRequestProvider,
  GitHubPullRequestProvider,
  GitLabMergeRequestProvider,
  ProviderRepository,
  PullRequestProvider,
  PullRequestSummary
} from './providers.js';

interface LaunchpadItem extends PullRequestSummary {
  root: string;
  currentBranch: boolean;
  pinned: boolean;
  snoozed: boolean;
}

type LaunchpadMessage =
  | { type: 'ready' | 'refresh' | 'connect' }
  | { type: 'open' | 'checkout' | 'changes' | 'pin' | 'snooze' | 'approve' | 'requestChanges' | 'comment'; index: number };

export class LaunchpadPanel {
  private panel?: vscode.WebviewPanel;
  private items: LaunchpadItem[] = [];
  private abort?: AbortController;
  private account?: string;
  private githubProvider?: GitHubPullRequestProvider;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly onRepositoryChanged: () => Promise<void>,
    private readonly state: vscode.Memento
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
      if (message.type === 'pin') await this.toggleState(message.index, 'pinned');
      if (message.type === 'snooze') await this.toggleState(message.index, 'snoozed');
      if (message.type === 'approve') await this.submitReview(message.index, 'APPROVE');
      if (message.type === 'requestChanges') await this.submitReview(message.index, 'REQUEST_CHANGES');
      if (message.type === 'comment') await this.submitReview(message.index, 'COMMENT');
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
    const providers: PullRequestProvider[] = [
      new GitHubPullRequestProvider(session?.accessToken),
      new GitLabMergeRequestProvider(),
      new BitbucketPullRequestProvider()
    ];
    this.githubProvider = providers[0] as GitHubPullRequestProvider;
    this.account = session?.account.label;
    const repositories = await this.git.discoverRepositories();
    const results = await Promise.allSettled(repositories.map(async repository => {
      const remoteUrl = await this.git.remoteUrl(repository.root).catch(() => '');
      const provider = providers.find(candidate => candidate.parseRemote(remoteUrl));
      const providerRepository = provider?.parseRemote(remoteUrl);
      if (!provider || !providerRepository) return [];
      const pulls = await provider.listPullRequests(providerRepository, controller.signal);
      return pulls.map(pull => {
        const key = `${pull.repository}#${pull.number}`;
        return {
          ...pull,
          root: repository.root,
          currentBranch: pull.head === repository.branch,
          pinned: this.state.get<string[]>('gitloupe.launchpad.pinned', []).includes(key),
          snoozed: this.state.get<string[]>('gitloupe.launchpad.snoozed', []).includes(key)
        };
      });
    }));
    if (controller.signal.aborted) return;
    this.items = results
      .filter((result): result is PromiseFulfilledResult<LaunchpadItem[]> => result.status === 'fulfilled')
      .flatMap(result => result.value)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    await this.panel?.webview.postMessage({
      type: 'model',
      items: this.items,
      account: this.account,
      warning: results.some(result => result.status === 'rejected')
        ? 'Some repositories could not be loaded. Public GitHub, GitLab, and Bitbucket repositories work without login; private repositories may require their provider integration.'
        : undefined
    });
  }

  private async open(index: number): Promise<void> {
    const item = this.items[index];
    if (!item) return;
    const uri = vscode.Uri.parse(item.url);
    const allowedHost: Record<string, string> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };
    if (uri.scheme !== 'https' || uri.authority !== allowedHost[item.providerId]) throw new Error('Refusing an unexpected provider URL.');
    await vscode.env.openExternal(uri);
  }

  private async checkout(index: number): Promise<void> {
    const item = this.items[index];
    if (!item) return;
    if (item.providerId !== 'github') throw new Error('Checkout is currently available for GitHub pull requests only.');
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
    if (item.providerId !== 'github') throw new Error('Changes are currently available for GitHub pull requests only.');
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

  private async toggleState(index: number, kind: 'pinned' | 'snoozed'): Promise<void> {
    const item = this.items[index];
    if (!item) return;
    const storageKey = `gitloupe.launchpad.${kind}`;
    const itemKey = `${item.repository}#${item.number}`;
    const values = new Set(this.state.get<string[]>(storageKey, []));
    if (values.has(itemKey)) values.delete(itemKey);
    else values.add(itemKey);
    await this.state.update(storageKey, [...values]);
    item[kind] = values.has(itemKey);
    await this.panel?.webview.postMessage({
      type: 'model',
      items: this.items,
      account: this.account
    });
  }

  private async submitReview(
    index: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  ): Promise<void> {
    const item = this.items[index];
    if (!item || item.providerId !== 'github' || !this.githubProvider) return;
    const body = await vscode.window.showInputBox({
      title: `${event === 'APPROVE' ? 'Approve' : event === 'REQUEST_CHANGES' ? 'Request changes on' : 'Comment on'} ${item.repository}#${item.number}`,
      prompt: event === 'APPROVE' ? 'Optional review summary' : 'Review summary',
      validateInput: value => event !== 'APPROVE' && !value.trim() ? 'Enter a review summary.' : undefined,
      ignoreFocusOut: true
    });
    if (body === undefined) return;
    const confirm = await vscode.window.showWarningMessage(
      `Submit ${event.toLowerCase().replace('_', ' ')} to ${item.repository}#${item.number}?`,
      { modal: true, detail: 'This writes a pull request review to GitHub.' },
      'Submit Review'
    );
    if (confirm !== 'Submit Review') return;
    const [owner, name] = item.repository.split('/');
    if (!owner || !name) throw new Error('Invalid GitHub repository identifier.');
    const repository: ProviderRepository = {
      providerId: 'github',
      host: 'github.com',
      owner,
      name,
      remoteUrl: `https://github.com/${item.repository}.git`
    };
    await this.githubProvider.submitReview(repository, item.number, event, body.trim());
    void vscode.window.showInformationMessage(`GitLoupe: Review submitted to ${item.repository}#${item.number}.`);
    await this.load(false);
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
