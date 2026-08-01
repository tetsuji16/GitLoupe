# GitLoupe — Local Git Explorer

<p align="center">
  <img src="resources/gitloupe.png" width="128" height="128" alt="GitLoupe icon">
</p>

Explore Git history, review changes, and manage local workflows without
leaving VS Code.

GitLoupe is a local-first Git workbench with an interactive commit graph,
Visual File History, blame insights, safe history editing, worktrees, stashes,
and an optional pull-request Launchpad. Core features use your local Git
installation—no GitLoupe account is required.

## Highlights

- Interactive Commit Graph with ref navigation, search, comparison, and
  multi-commit selection
- Working-change workflow for staging, committing, stashing, patch copying,
  and safe discard
- File, folder, and repository Visual History with author lanes and change
  magnitude
- Inline blame, hover details, CodeLens, heatmap, and revision navigation
- Worktree management and guarded reword, reorder, squash, fixup, and drop
  workflows with recovery branches
- Optional GitHub Pull Request Launchpad and local Ollama assistance

## Start here

1. Open a Git repository in VS Code.
2. Select the GitLoupe icon in the Activity Bar.
3. Choose **Open Commit Graph** from Home, or run
   **GitLoupe: Open Commit Graph** from the Command Palette.

## Privacy and safety

GitLoupe runs core Git actions through your locally installed `git`
executable. It does not perform analytics or background cloud synchronization.
Network features are optional and run only when you explicitly open or connect
a provider workflow. History-rewriting and destructive actions require
confirmation.

See the [GitHub repository](https://github.com/tetsuji16/GitLoupe) for full
documentation, configuration, security notes, and contributing guidance.
