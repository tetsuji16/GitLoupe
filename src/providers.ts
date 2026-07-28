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
  head: { ref: string };
  base: { ref: string };
  draft?: boolean;
  updated_at: string;
  labels?: Array<{ name?: string }>;
  requested_reviewers?: GitHubUser[];
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
    const pulls = await this.request<GitHubPull[]>(
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      signal
    );
    return pulls.map(pull => ({
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
      mine: Boolean(this.user && pull.user.login === this.user.login)
    }));
  }

  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'GitLoupe-VSCode'
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`https://api.github.com${path}`, { headers, signal });
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
