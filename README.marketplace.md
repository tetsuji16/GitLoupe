# GitLoupe — Local Git Explorer

<p align="center">
  <img src="resources/gitloupe-hero.png" width="1200" alt="GitLoupe — See history clearly. Act with confidence.">
</p>

See the shape of your Git history, understand every change, and act with
confidence—without leaving VS Code.

GitLoupe is a local-first visual Git workbench. It brings together an
interactive commit graph, file and repository history, authorship insights,
worktrees, stashes, guarded history editing, and an optional pull-request
Launchpad. Core features run through your locally installed Git executable—no
GitLoupe account, analytics, or background cloud synchronization is required.

## Highlights

- Interactive Commit Graph with ref navigation, search, comparison, and
  multi-commit selection
- Working-change workflow for staging, committing, stashing, patch copying,
  and safe discard
- File, folder, and repository Visual History with author lanes and change
  magnitude
- Inline blame, hover details, CodeLens, heatmap, and revision navigation
- Worktree management and guarded reword, reorder, squash, fixup, and drop
  workflows; drag-to-reorder history edits create recovery branches
- Optional Launchpad for public GitHub, GitLab, and Bitbucket Cloud PRs/MRs
- GitHub PR multi-diff, safe checkout, and review actions
- Optional local Ollama assistance for commit messages and explanations

## Start here

1. Open a Git repository in VS Code.
2. Select the GitLoupe icon in the Activity Bar.
3. Choose **Open Commit Graph** from Home, or run
   **GitLoupe: Open Commit Graph** from the Command Palette.

## Privacy and safety

GitLoupe runs core Git actions through your locally installed `git`
executable. It does not perform analytics or background cloud synchronization.
Network features are optional and run only when you explicitly open or connect
a provider workflow. GitHub authentication is delegated to VS Code and is used
only for private GitHub repositories and review actions; public GitLab and
Bitbucket Cloud discovery is read-only. History-rewriting and destructive
actions require confirmation.

See the [GitHub repository](https://github.com/tetsuji16/GitLoupe) for full
documentation, configuration, security notes, and contributing guidance.

## Support GitLoupe

If GitLoupe saves you time, please consider supporting ongoing development via
[GitHub Sponsors](https://github.com/sponsors/tetsuji16).
