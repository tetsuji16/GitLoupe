# Changelog

## 0.3.5

### Changed

- Replaced the GitLoupe icon with a theme-independent blue and coral mark
- Added a new GitHub and Marketplace introduction banner
- Refined the English product description around visual history and safe local workflows

## 0.3.4

### Changed

- Refined the GitLoupe icon for clearer activity-bar and Marketplace display

## 0.3.3

### Changed

- Added GitHub Sponsors metadata and project funding configuration
- Refined GitHub and Marketplace documentation for English-speaking users

## 0.3.2

### Added

- Drag-to-reorder commits with guarded interactive rebase and recovery branches
- Read-only Launchpad discovery for public GitLab merge requests and Bitbucket Cloud pull requests

### Fixed

- Avoid no-op history rewrites and make graph drag handling reliable across webview drag events
- Follow validated GitLab pagination headers when loading merge requests

## 0.3.1

### Changed

- Refreshed the Marketplace icon with the Git graph magnifier mark

## 0.3.0

### Added

- Native Welcome, Home, and Inspect views in the GitLoupe activity-bar container
- Visual History selection synchronization between the timeline, revision list,
  and commit details
- Marketplace-specific product documentation and packaging support

### Changed

- Refreshed the GitHub README with a focused product overview and quick start
- Refined the GitLoupe icon for light and dark themes with a transparent PNG
  and theme-aware SVG activity-bar glyph

## 0.2.1

### Added

- Local/private-network Ollama support for commit messages and change explanations
- Pull, push, publish, merge, branch rebase, revert, reset, and undo actions
- Staged-only, unstaged-only, and combined working-file diffs
- Merge, rebase, cherry-pick, and revert conflict continuation controls
- Manual current, incoming, and delete conflict resolutions
- Multi-file stage, unstage, stash, discard, and multi-diff workflow
- Whole-file blame annotations and previous-revision comparison
- Branch-focused graph scope
- Launchpad pagination, transient-request retries, pinning, and snoozing
- Extension Host smoke tests, CI matrix, dependency audit, and Dependabot

### Security

- Restrict trusted blame hover commands to an explicit allowlist
- Escape untrusted author, email, and commit-message Markdown
- Reject Ollama endpoints outside loopback and private IP networks
- Store optional Ollama gateway credentials in VS Code SecretStorage

### Performance

- Cancel superseded full graph Git processes
- Watch active graph worktrees for live WIP refresh
- Skip offscreen graph row rendering with CSS content visibility

### Fixed

- Allow local Ollama model discovery before a model has been selected

## 0.2.0

- Added the Graph Workbench, Visual History, worktrees, stashes, blame, and
  the provider-neutral Pull Request Launchpad.

## 0.1.0

- Initial Marketplace release.
