import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubPullRequestProvider, parseGitHubRemote } from '../src/providers.js';

test('parseGitHubRemote supports HTTPS, SCP-style SSH, and ssh URLs', () => {
  for (const remote of [
    'https://github.com/openai/codex.git',
    'git@github.com:openai/codex.git',
    'ssh://git@github.com/openai/codex.git'
  ]) {
    assert.deepEqual(parseGitHubRemote(remote), {
      providerId: 'github',
      host: 'github.com',
      owner: 'openai',
      name: 'codex',
      remoteUrl: remote
    });
  }
});

test('parseGitHubRemote rejects non-GitHub and malformed remotes', () => {
  assert.equal(parseGitHubRemote('https://gitlab.com/openai/codex.git'), undefined);
  assert.equal(parseGitHubRemote('https://github.com/only-owner'), undefined);
});

test('GitHub provider maps public pull request responses without authentication', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('/commits/abc123/check-runs')) {
      return new Response(JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }] }), { status: 200 });
    }
    assert.match(String(input), /\/repos\/openai\/codex\/pulls\?/);
    return new Response(JSON.stringify([{
      number: 42,
      title: 'Improve graph',
      html_url: 'https://github.com/openai/codex/pull/42',
      user: { login: 'ada' },
      head: { ref: 'feature', sha: 'abc123' },
      base: { ref: 'main' },
      draft: false,
      updated_at: '2026-01-01T00:00:00Z',
      labels: [{ name: 'ui' }],
      requested_reviewers: []
    }]), { status: 200 });
  }) as typeof fetch;
  try {
    const provider = new GitHubPullRequestProvider();
    const repository = parseGitHubRemote('https://github.com/openai/codex.git')!;
    const [pull] = await provider.listPullRequests(repository);
    assert.equal(pull?.number, 42);
    assert.equal(pull?.head, 'feature');
    assert.deepEqual(pull?.labels, ['ui']);
    assert.equal(pull?.mine, false);
    assert.equal(pull?.checkState, 'success');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub review submission requires authentication and uses the review endpoint', async () => {
  const repository = parseGitHubRemote('https://github.com/openai/codex.git')!;
  await assert.rejects(
    () => new GitHubPullRequestProvider().submitReview(repository, 42, 'APPROVE', ''),
    /Connect GitHub/
  );
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as typeof fetch;
  try {
    await new GitHubPullRequestProvider('secret').submitReview(repository, 42, 'REQUEST_CHANGES', 'Please add tests.');
    assert.match(request?.url ?? '', /\/pulls\/42\/reviews$/);
    assert.equal(request?.method, 'POST');
    assert.equal(request?.headers.get('authorization'), 'Bearer secret');
    assert.deepEqual(await request?.json(), { event: 'REQUEST_CHANGES', body: 'Please add tests.' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
