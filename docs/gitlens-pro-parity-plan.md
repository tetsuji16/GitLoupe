# GitLens Pro parity review

This review uses only publicly observable GitLens behavior, public Git
documentation, and VS Code APIs. It does not use GitLens `plus/` source or
private implementation details.

## Verdict

GitLoupe 0.2 implemented useful isolated workflows, but it was not a faithful
GitLens Pro replacement. Its commit graph was primarily a history viewer,
while current GitLens 18 presents the graph as a workbench for repository,
working-tree, branch, and worktree operations.

The first parity increment in this branch closes the most disruptive local
workflow gaps:

- integrated working-changes row and details
- staged and unstaged file groups
- stage, unstage, commit, safe discard, and patch-copy actions
- per-worktree WIP indicators
- repository and branch selectors, upstream status, fetch, and refresh
- local branch, remote, tag, stash, and worktree navigation
- per-commit additions and deletions
- prefixed commit, message, author, and ref filtering
- file path and changed-content history search
- arbitrary commit/ref and Working Tree comparison with per-file and native
  VS Code multi-diffs, including untracked files
- cancellable deep searches with a bounded short-lived cache
- debounced repository-state refresh for external Git changes
- guarded reword, squash, and drop actions with automatic recovery branches
- paused-rebase continue and abort controls
- graph minimap markers for HEAD, refs, merges, and search matches
- Ctrl/Cmd and Shift commit multi-selection with endpoint compare, contiguous
  squash, and arbitrary drop
- keyboard row navigation
- root-commit and renamed-file diff correctness
- nested repository discovery
- file, folder, and repository visual history with author lanes, time scale,
  magnitude bubbles, change bars, zooming, period filters, and author slicing
- provider-neutral pull-request model with an optional GitHub REST adapter
- Launchpad categories, public unauthenticated discovery, explicit VS Code
  authentication, PR multi-diff, browser open, and guarded local checkout

## Adversarial findings

### Critical

- No WIP or staging workflow existed in the graph.
- No ref-oriented navigation existed alongside the graph.
- Graph rows omitted change magnitude and upstream context.
- Root commit diffs used an invalid `commit^` revision.
- Renamed-file diffs requested the new path from the parent revision.

### High

- Search was a single unstructured substring filter.
- Visual File History did not reproduce the author swim lanes, time axis,
  magnitude bubbles, zooming, brushing, or slicing of the reference product.
- Repository discovery only considered workspace-folder roots.
- Worktrees had no working-change or ahead/behind indicators.
- The narrow layout discarded important context instead of adapting columns.

### Still out of scope

- GitLab, Bitbucket, Jira, and organization integrations
- inline review submission, checks, merge queues, and provider mutations
- Cloud Patches and account-backed sharing
- hosted AI explanations, code review, and commit composition
- agent session monitoring

Provider access remains optional and user-initiated. The local Git core,
Graph, comparison, rewriting, and Visual History do not require an account or
provider network access.

## Remaining roadmap

1. Add cancellation for full graph reloads and linked-worktree metadata watchers.
2. Extend comparison to staged-only state and symmetric Working Tree bases.
3. Extend history editing with reorder, fixup, safe merge, and branch rebase.
4. Add drag brushing and richer selection synchronization to Visual History.
5. Extend the graph minimap with WIP markers, branch focus, and configurable
   columns.
6. Add multi-select file operations and staged/unstaged diff fidelity.
7. Add repository watchers, request cancellation, and bounded caches so large
   repositories remain responsive.
8. Add GitLab/Bitbucket adapters, check status, review submission, and merge
   queue support without weakening the login-free local core.

## Acceptance gates

- TypeScript check, parser/unit tests, production bundle, and `git diff --check`
  must pass.
- WIP actions must be exercised in a disposable repository.
- Root, rename, binary, merge, detached-HEAD, unborn-branch, and multi-worktree
  repositories require fixtures.
- The webview must be checked at narrow, two-pane, and full three-pane widths
  with both light and dark VS Code themes.
- Destructive actions require explicit confirmation and must never silently
  delete untracked files.
