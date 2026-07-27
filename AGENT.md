# GitLoupe Agent Guidelines

## Clean-room implementation of `plus` functionality

Functionality corresponding to features implemented under GitLens'
`plus/` directories must be developed as a clean-room implementation.

When designing or implementing such functionality:

- Use publicly observable product behavior, independently written
  requirements, public Git documentation, and public VS Code APIs as the
  specification.
- Write all production code, tests, UI assets, text, and documentation
  independently for GitLoupe.
- Do not copy, translate, adapt, port, or derive code from GitLens'
  `plus/` directories.
- Do not use non-public implementation details, decompiled artifacts, or
  techniques intended to bypass GitLens licensing, subscriptions, or
  authentication.
- Keep GitLoupe local-first and do not require a GitKraken account or GitLoupe
  account.
- Record relevant third-party attribution and license notices whenever
  permitted OSS code is reused.

GitLens source outside `plus/` may only be reused when its applicable license
permits it, with required copyright and license notices preserved. Prefer an
independent implementation when the licensing boundary or source provenance is
unclear.
