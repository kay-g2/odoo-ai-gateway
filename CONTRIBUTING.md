# Contributing

## Setup

Node 26 (`.nvmrc`), then `npm install`.

- `npm test`: vitest, fully offline. No API keys, no network.
- `npm run typecheck` and `npm run build`.
- `npm run dev`: the gateway on :8080 from `gateway.config.yaml` and `.env`, reloading on change.

## Commits and releases

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with `!` or a `BREAKING CHANGE:` footer
for breaking changes. PRs are squash-merged under their title.

[release-please](https://github.com/googleapis/release-please) reads those messages. A push to
`main` with a `feat:` or `fix:` commit, or a breaking change, opens or updates a release PR with
the next version and the changelog; `docs:`, `refactor:`, `test:` and `chore:` commits alone do
not. Merging it creates the tag and the GitHub release, and the release workflow publishes
`ghcr.io/kay-g2/odoo-ai-gateway`. The version in `package.json`, `src/app.ts` and
`.release-please-manifest.json` is changed by that PR only. Opening the PR needs the repository
setting *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*,
which is off by default.

The first release, `v0.1.0`, is the one exception: it is published by hand from the initial commit
(`gh release create v0.1.0`), which also publishes its image. Do it once the repository is public:
a package first pushed from a private repository stays private until its visibility is changed in
the package settings.

## Pull requests

- `npm run typecheck && npm test && npm run build` pass.
- A change to a provider's `options` comes with `npm run docs:options`; a test compares the README
  table with the adapters' declarations.
- Protocol behaviour comes with the Odoo file it was read from, in `docs/protocol.md`.
- No Odoo source code in this repository. The gateway reimplements the network protocol only.
