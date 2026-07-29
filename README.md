# GitLoupe

<p align="center">
  <img src="resources/gitloupe.png" width="128" height="128" alt="GitLoupe icon">
</p>

GitLoupe is a local-first Git explorer for Visual Studio Code. It brings the
most useful visual workflows commonly associated with paid Git tooling into a
small MIT-licensed extension that does not require a GitLoupe or GitKraken
account.

## Features

- Interactive commit graph across all local refs
- Graph minimap for HEAD, refs, merges, and search results
- Ctrl/Cmd and Shift multi-selection with endpoint compare and bulk rewrites
- GitLens-style Graph Workbench with working changes and commit details
- Stage, unstage, commit, safely discard, and copy changes as patches
- Staged-only, unstaged-only, and combined diffs for partially staged files
- Multi-file stage, unstage, stash, discard, and multi-diff actions
- Prefixed commit, message, author, hash, ref, file, and changed-content search
- Branch switching, upstream status, fetch, and per-worktree WIP indicators
- Pull, push, publish, merge, rebase, revert, reset, and undo workflows
- Branch-focused graph scope and live WIP refresh across linked worktrees
- Branches, remotes, tags, stashes, and worktrees alongside the graph
- Per-commit addition and deletion totals
- Arbitrary commit/ref and Working Tree comparison with native multi-file diffs
- Branch creation, checkout, and confirmed cherry-pick actions
- Guarded reword, reorder, squash, and drop actions with recovery branches
- Merge, rebase, cherry-pick, and revert conflict controls
- File, folder, and repository Visual History with author lanes and change bars
- Visual History period/author slicing and adjustable timeline zoom
- Worktree creation, opening, and safe removal
- Stash listing, inspection, apply, pop, and drop from the Stashes view
- Multi-root workspace support
- Inline current-line blame with a configurable format
- Status bar blame for the line under the cursor
- Hover blame with copy-hash and open-in-graph actions
- Authorship CodeLens at the top of files and on document symbols
- Recency heatmap in the overview ruler
- Optional whole-file blame blocks, previous-revision comparison, and forward/back revision navigation
- Optional provider-neutral Pull Request Launchpad with a GitHub adapter
- Public PR discovery, native PR multi-diff, browser open, and safe checkout
- Launchpad pinning, snoozing, pagination, and transient-network retries
- Optional local Ollama commit messages and change explanations

The Git core uses your locally installed `git` executable and performs no
analytics or background cloud synchronization. Opening Launchpad explicitly
queries GitHub for repositories whose `origin` points to GitHub. Public
repositories work without authentication. Choosing **Connect GitHub** uses
VS Code's built-in authentication session for private repositories and
personalized categories; GitLoupe does not store the token. Git is launched
with terminal credential prompts disabled.

## Local Ollama

GitLoupe can generate a staged-change commit message or explain a commit or
working tree with an Ollama model. This stays disabled until you select a
model.

1. Start Ollama. Its default API is `http://127.0.0.1:11434`.
2. Run **GitLoupe: Select Local Ollama Model**.
3. Open Working Changes in the Graph and choose **Generate with Ollama** or
   **Explain locally**.

`gitloupe.ollama.endpoint` accepts loopback and private-network IP addresses
only. Requests to public Internet hosts are rejected. Local Ollama normally
requires no key; an authenticated LAN gateway can use **GitLoupe: Set Ollama
Gateway API Key**, which stores the value in VS Code SecretStorage. Diff input
is bounded by `gitloupe.ollama.maxDiffCharacters`.

## Run from source

```console
npm install
npm run check
npm test
npm run build
npm run test:extension
```

Open this folder in VS Code and press `F5` to launch an Extension Development
Host. Use **GitLoupe: Open Commit Graph** from the Command Palette or select the
GitLoupe icon in the Activity Bar.

To build an installable extension:

```console
npm run package
```

## License and relationship to GitLens

GitLoupe is an independent implementation inspired by GitLens workflows.
GitLens' non-`plus` source is MIT-licensed, while its `plus` source is covered
by the GitLens Pro License and is not suitable for an unrestricted OSS fork.
GitLoupe therefore contains no source copied from GitLens' `plus` directories.
See [NOTICE](NOTICE) for attribution.

Features corresponding to functionality found in GitLens' `plus` directories
are implemented in GitLoupe using a clean-room process. Contributors must work
from publicly observable behavior, independently written requirements, and
public Git documentation or APIs. They must not copy, translate, adapt, or use
the implementation details of GitLens' `plus` source when creating those
features. All resulting implementation and tests must be original GitLoupe
work.

GitLens is a trademark of GitKraken. GitLoupe is not affiliated with,
sponsored by, or endorsed by GitKraken.

The authorship features — inline blame, status-bar blame, hover blame,
authorship CodeLens, and the recency heatmap — are independent
implementations of GitLens' free authorship workflows and do not rely on
any GitLens source.

See [the GitLens Pro parity review and roadmap](docs/gitlens-pro-parity-plan.md)
for the adversarial gap analysis, implemented scope, and remaining work.
