# Agent instructions

These instructions apply to coding agents and other automated contributors in
this repository. People should start with
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md); the rules are the same.

## Read first

- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md): setup, verification, and the
  public documentation boundary.
- [docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md): protected controls, the
  review-only pull request flow, and approved commit identities.
- [docs/DELIVERY.md](docs/DELIVERY.md): how merged changes are released.
- [docs/SECURITY.md](docs/SECURITY.md): what the relay can and cannot read.

## This repository is public

Everything you commit is published, including commit messages, branch names,
and pull request text.

- Never commit credentials, personal data, hosted-service hostnames, server
  addresses, host paths, private repository names, dated plans, audits,
  decision records, or incident notes.
- Commit as `hello@northglass.io` with the Northglass name, or with a GitHub
  `users.noreply.github.com` address.
- This file and `CLAUDE.md` are the only tracked agent files, and both are
  protected: changing either needs a maintainer's review and merge. Keep local
  agent state out of the tree, including `.claude/`, `.codex/`, `.agents/`,
  `.mcp.json`, `CLAUDE.local.md`, `GEMINI.md`,
  `.github/copilot-instructions.md`, and nested agent files.
- Before pushing, run `bash scripts/check-docs-hygiene.sh` and
  `node scripts/verify-upstream-import.mjs --ci-range <base> <head>`.

## Protected controls

- `package.json` and the dependency and container boundary tests change only
  after a separate review-only pull request records the exact change in
  `.upstream-import-review.txt`. The change is then rebased onto that review,
  with nothing merged in between.
- Workflows, scanners, the publication policy, and the upstream policy files
  cannot be approved that way. They need a maintainer's review and merge.
- Never weaken a check, skip a hook, or add a scanner suppression to get a
  change through.

## Working here

- Use Node.js 22.12 or newer and Yarn Classic 1.22. CI runs Node 22.
- Verify with `yarn install --frozen-lockfile`, `yarn typecheck`, and
  `yarn test`. Add or update a test before fixing a bug.
- Fix transitive advisories with root `resolutions`. A parent-scoped key needs
  a leading `**/` to reach workspace dependencies; check that no vulnerable
  version remains in `yarn.lock`.
- Use Conventional Commit messages.
- Agents prepare pull requests. Maintainers approve the private publication
  scan, merge to `main` (which requires signed commits), and release.
