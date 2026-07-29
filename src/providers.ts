export interface ProviderRepository {
  providerId: string;
  host: string;
  owner: string;
  name: string;
  remoteUrl: string;
}

export interface PullRequestSummary {
  providerId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  updatedAt: string;
  labels: string[];
  reviewRequested: boolean;
  mine: boolean;
  checkState: 'success' | 'failure' | 'pending' | 'unknown';
}

export interface PullRequestProvider {
  readonly id: string;
  parseRemote(remoteUrl: string): ProviderRepository | undefined;
  listPullRequests(repository: ProviderRepository, signal?: AbortSignal): Promise<PullRequestSummary[]>;
}

interface GitHubUser {
  login: string;
}

interface GitHubPull {
  number: number;
  title: string;
  html_url: string;
  user: GitHubUser;
  head: { ref: string; sha: string };
  base: { ref: string };
  draft?: boolean;
  updated_at: string;
  labels?: Array<{ name?: string }>;
  requested_reviewers?: GitHubUser[];
}

interface GitHubCheckRuns {
  check_runs?: Array<{
    status?: string;
    conclusion?: string | null;
  }>;
}

export class GitHubPullRequestProvider implements PullRequestProvider {
  readonly id = 'github';
  private user?: GitHubUser;

  constructor(private readonly token?: string) {}

  parseRemote(remoteUrl: string): ProviderRepository | undefined {
    return parseGitHubRemote(remoteUrl);
  }

  async listPullRequests(
    repository: ProviderRepository,
    signal?: AbortSignal
  ): Promise<PullRequestSummary[]> {
    if (this.token && !this.user) this.user = await this.request<GitHubUser>('/user', signal);
    const pulls: GitHubPull[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.request<GitHubPull[]>(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
        signal
      );
      pulls.push(...batch);
      if (batch.length < 100) break;
    }
    const summaries = pulls.map(pull => ({
      providerId: this.id,
      repository: `${repository.owner}/${repository.name}`,
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      author: pull.user.login,
      head: pull.head.ref,
      base: pull.base.ref,
      draft: pull.draft ?? false,
      updatedAt: pull.updated_at,
      labels: (pull.labels ?? []).map(label => label.name ?? '').filter(Boolean),
      reviewRequested: Boolean(this.user && pull.requested_reviewers?.some(user => user.login === this.user!.login)),
      mine: Boolean(this.user && pull.user.login === this.user.login),
      checkState: 'unknown' as PullRequestSummary['checkState'],
      headSha: pull.head.sha
    }));
    for (let offset = 0; offset < Math.min(summaries.length, 50); offset += 8) {
      await Promise.all(summaries.slice(offset, offset + 8).map(async summary => {
        const checks = await this.request<GitHubCheckRuns>(
          `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${summary.headSha}/check-runs?per_page=100`,
          signal
        ).catch(() => undefined);
        summary.checkState = checkState(checks?.check_runs ?? []);
      }));
    }
    return summaries.map(({ headSha: _, ...summary }) => summary);
  }

  async submitReview(
    repository: ProviderRepository,
    number: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string
  ): Promise<void> {
    if (!this.token) throw new Error('Connect GitHub before submitting a review.');
    await this.request(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/reviews`,
      undefined,
      { method: 'POST', body: JSON.stringify({ event, body }) }
    );
  }

  private async request<T>(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'GitLoupe-VSCode'
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
        signal
      });
      if (init.method && init.method !== 'GET') break;
      if (![502, 503, 504].includes(response.status) || attempt === 2) break;
      await delay(250 * 2 ** attempt, signal);
    }
    if (!response) throw new Error('GitHub API request failed before a response was received.');
    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (response.status === 403 && remaining === '0') {
        throw new Error('GitHub API rate limit reached. Connect GitHub to use the authenticated rate limit.');
      }
      throw new Error(`GitHub API request failed (${response.status} ${response.statusText}).`);
    }
    return response.json() as Promise<T>;
  }
}

function checkState(
  checks: Array<{ status?: string; conclusion?: string | null }>
): PullRequestSummary['checkState'] {
  if (!checks.length) return 'unknown';
  if (checks.some(check => check.status !== 'completed')) return 'pending';
  const failed = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
  return checks.some(check => failed.has(check.conclusion ?? '')) ? 'failure' : 'success';
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('GitHub request cancelled.'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function parseGitHubRemote(remoteUrl: string): ProviderRepository | undefined {
  const trimmed = remoteUrl.trim();
  const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?::|\/)([^/:\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (!match) return undefined;
  return {
    providerId: 'github',
    host: 'github.com',
    owner: match[1]!,
    name: match[2]!,
    remoteUrl: trimmed
  };
}
