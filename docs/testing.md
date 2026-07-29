# Testing and release gates

Run the complete local verification:

```console
npm ci
npm run check
npm test
npm run build
npm run test:extension
npm run package
git diff --check
```

The unit and integration suites cover parsers, real Git blame, stash and
interactive-rebase fixtures, webview script compilation, Markdown boundary
escaping, private Ollama endpoint enforcement, and the Ollama HTTP contract.
The Extension Host smoke test activates the packaged extension and verifies
its public command surface.

Before a Marketplace release, manually exercise these disposable-repository
scenarios on Windows, macOS, and Linux:

- root, merge, signed, binary, and renamed-file commits
- unborn and detached HEAD states
- files with staged and unstaged hunks at the same time
- merge, rebase, cherry-pick, and revert conflicts
- multiple linked worktrees, including WIP outside the primary worktree
- repositories with at least 100,000 commits and 2,000 refs
- narrow, two-pane, and full-width Graph layouts in light and dark themes
- local Ollama, an authenticated private-network gateway, cancellation, and timeout

Record Graph initial-load time, refresh time, extension-host peak memory, and
Git child-process duration for the large-repository fixture. Regressions over
20% require investigation before release.
