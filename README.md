# GitLoupe

<p align="center">
  <img src="resources/gitloupe.png" width="128" height="128" alt="GitLoupe icon">
</p>

GitLoupe is a local-first Git explorer for Visual Studio Code. It brings the
most useful visual workflows commonly associated with paid Git tooling into a
small MIT-licensed extension that never asks you to create an account.

## Features

- Interactive commit graph across all local refs
- GitLens-style Graph Workbench with working changes and commit details
- Stage, unstage, commit, safely discard, and copy changes as patches
- Prefixed commit, message, author, hash, ref, file, and changed-content search
- Branch switching, upstream status, fetch, and per-worktree WIP indicators
- Branches, remotes, tags, stashes, and worktrees alongside the graph
- Per-commit addition and deletion totals
- Arbitrary commit/ref and Working Tree comparison with native multi-file diffs
- Branch creation, checkout, and confirmed cherry-pick actions
- Guarded reword, squash-into-parent, and drop actions with recovery branches
- Paused-rebase conflict guidance with continue and abort controls
- Visual file history with author swim lanes, timeline bubbles, and change bars
- Worktree creation, opening, and safe removal
- Stash listing, inspection, apply, pop, and drop from the Stashes view
- Multi-root workspace support
- Inline current-line blame with a configurable format
- Status bar blame for the line under the cursor
- Hover blame with copy-hash and open-in-graph actions
- Authorship CodeLens at the top of files and on document symbols
- Recency heatmap in the overview ruler

All repository data comes from your locally installed `git` executable.
GitLoupe does not include analytics, cloud services, account code, or network
requests. Git is launched with terminal credential prompts disabled.

## Run from source

```console
npm install
npm run check
npm test
npm run build
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
