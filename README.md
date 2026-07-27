# GitLoupe

GitLoupe is a local-first Git explorer for Visual Studio Code. It brings the
most useful visual workflows commonly associated with paid Git tooling into a
small MIT-licensed extension that never asks you to create an account.

## Features

- Interactive commit graph across all local refs
- Fast commit, author, hash, and ref filtering
- Commit inspection with changed-file diffs
- Branch creation, checkout, and confirmed cherry-pick actions
- Visual file history with additions/deletions over time
- Worktree creation, opening, and safe removal
- Multi-root workspace support

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
