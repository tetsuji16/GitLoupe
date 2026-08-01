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

interface GitLabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  author: { username?: string; name?: string };
  source_branch: string;
  target_branch: string;
  draft?: boolean;
  updated_at: string;
  labels?: string[];
}

/** Read-only, public GitLab.com merge-request discovery. */
export class GitLabMergeRequestProvider implements PullRequestProvider {
  readonly id = 'gitlab';

  parseRemote(remoteUrl: string): ProviderRepository | undefined {
    return parseGitLabRemote(remoteUrl);
  }

  async listPullRequests(repository: ProviderRepository, signal?: AbortSignal): Promise<PullRequestSummary[]> {
    const project = encodeURIComponent(`${repository.owner}/${repository.name}`);
    const merges: GitLabMergeRequest[] = [];
    let page = 1;
    for (; page <= 5; page++) {
      const response = await fetch(
        `https://gitlab.com/api/v4/projects/${project}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=100&page=${page}`,
        { headers: { Accept: 'application/json', 'User-Agent': 'GitLoupe-VSCode' }, signal }
      );
      if (!response.ok) throw new Error(`GitLab API request failed (${response.status} ${response.statusText}).`);
      const batch = await response.json() as GitLabMergeRequest[];
      merges.push(...batch);
      const next = response.headers.get('x-next-page');
      const nextPage = next && /^\d+$/.test(next) ? Number(next) : undefined;
      if (!nextPage || nextPage <= page) break;
      page = nextPage - 1;
    }
    return merges.map(merge => ({
      providerId: this.id,
      repository: `${repository.owner}/${repository.name}`,
      number: merge.iid,
      title: merge.title,
      url: merge.web_url,
      author: merge.author.username ?? merge.author.name ?? 'unknown',
      head: merge.source_branch,
      base: merge.target_branch,
      draft: merge.draft ?? false,
      updatedAt: merge.updated_at,
      labels: merge.labels ?? [],
      reviewRequested: false,
      mine: false,
      checkState: 'unknown'
    }));
  }
}

interface BitbucketPullRequest {
  id: number;
  title: string;
  links: { html?: { href?: string } };
  author?: { nickname?: string; display_name?: string };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
  updated_on: string;
  draft?: boolean;
}

interface BitbucketPullRequestPage {
  values?: BitbucketPullRequest[];
  next?: string;
}

/** Read-only, public Bitbucket Cloud pull-request discovery. */
export class BitbucketPullRequestProvider implements PullRequestProvider {
  readonly id = 'bitbucket';

  parseRemote(remoteUrl: string): ProviderRepository | undefined {
    return parseBitbucketRemote(remoteUrl);
  }

  async listPullRequests(repository: ProviderRepository, signal?: AbortSignal): Promise<PullRequestSummary[]> {
    const pulls: BitbucketPullRequest[] = [];
    let endpoint: string | undefined = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pullrequests?state=OPEN&sort=-updated_on&pagelen=100`;
    for (let page = 0; endpoint && page < 5; page++) {
      const response = await fetch(endpoint, { headers: { Accept: 'application/json', 'User-Agent': 'GitLoupe-VSCode' }, signal });
      if (!response.ok) throw new Error(`Bitbucket API request failed (${response.status} ${response.statusText}).`);
      const result = await response.json() as BitbucketPullRequestPage;
      pulls.push(...(result.values ?? []));
      let next: URL | undefined;
      try {
        next = result.next ? new URL(result.next) : undefined;
      } catch {
        next = undefined;
      }
      endpoint = next?.protocol === 'https:' && next.hostname === 'api.bitbucket.org' ? next.toString() : undefined;
    }
    return pulls.map(pull => ({
      providerId: this.id,
      repository: `${repository.owner}/${repository.name}`,
      number: pull.id,
      title: pull.title,
      url: pull.links.html?.href ?? `https://bitbucket.org/${repository.owner}/${repository.name}/pull-requests/${pull.id}`,
      author: pull.author?.nickname ?? pull.author?.display_name ?? 'unknown',
      head: pull.source?.branch?.name ?? 'unknown',
      base: pull.destination?.branch?.name ?? 'unknown',
      draft: pull.draft ?? false,
      updatedAt: pull.updated_on,
      labels: [],
      reviewRequested: false,
      mine: false,
      checkState: 'unknown'
    }));
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

export function parseGitLabRemote(remoteUrl: string): ProviderRepository | undefined {
  const trimmed = remoteUrl.trim();
  const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)gitlab\.com(?::|\/)(.+)\.git$/.exec(trimmed);
  if (!match) return undefined;
  const segments = match[1]!.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name || !segments.length || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment))) return undefined;
  return { providerId: 'gitlab', host: 'gitlab.com', owner: segments.join('/'), name, remoteUrl: trimmed };
}

export function parseBitbucketRemote(remoteUrl: string): ProviderRepository | undefined {
  const trimmed = remoteUrl.trim();
  const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)bitbucket\.org(?::|\/)([^/:\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (!match) return undefined;
  return { providerId: 'bitbucket', host: 'bitbucket.org', owner: match[1]!, name: match[2]!, remoteUrl: trimmed };
}
