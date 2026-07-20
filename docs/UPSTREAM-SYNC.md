# Importing reviewed upstream changes

Idle incorporates selected changes from the public
[`slopus/happy`](https://github.com/slopus/happy) project. Imports must preserve
the upstream license and attribution while keeping Idle's public identity,
configuration, and artwork separate.

## Configure a fetch-only remote

Use the public repository only as a source. The explicit disabled push URL is
required because a Git remote otherwise uses its fetch URL for pushes too.

For a new checkout:

```bash
git remote add upstream https://github.com/slopus/happy.git
git remote set-url --push upstream disabled://fetch-only
git config --replace-all remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/main'
git config remote.upstream.tagOpt --no-tags
scripts/check-upstream-cruft.sh --check-remote
```

For a checkout that already has `upstream`:

```bash
git remote set-url upstream https://github.com/slopus/happy.git
git remote set-url --push upstream disabled://fetch-only
git config --replace-all remote.upstream.fetch '+refs/heads/main:refs/remotes/upstream/main'
git config remote.upstream.tagOpt --no-tags
scripts/check-upstream-cruft.sh --check-remote
```

The final command must pass before fetching. Never change `origin` as part of an
upstream import.

## Import without committing first

Start from a current Idle branch and apply only the required commits without
creating a commit:

```bash
git fetch --no-tags upstream main
git switch -c sync/upstream-YYYYMMDD origin/main
BASE_SHA="$(git rev-parse HEAD)"
SOURCE_SHA=<full-lowercase-upstream-commit-id>
git cherry-pick --no-commit "$SOURCE_SHA"
yarn verify:upstream-import --staged "$SOURCE_SHA"
```

`SOURCE_SHA` must be the complete 40-character SHA-1 or 64-character SHA-256
commit object ID. Branch names, tags, abbreviated IDs, `HEAD`, and
`refs/remotes/upstream/main` are rejected. This keeps the reviewed source
immutable even if the upstream branch moves between review and import.

Resolve conflicts in favor of Idle's product names, bundle identifiers, hosts,
signing settings, deployment configuration, and artwork. Remove unrelated
upstream deployment files. Do not copy an entire upstream branch into Idle.

The canonical staged command checks the fetch-only remote, public-document and
OPSEC boundaries, source reachability from the fetched upstream `main`, the
exact source-to-delta relationship, the staged import, whitespace, typecheck,
and tests. An exact cherry-pick passes the provenance check directly. A
selective, conflict-resolved, or otherwise transformed import requires a
separate pre-existing `source-transformation` review bound to the exact base,
source commit, and imported bytes. The command temporarily defers only the
full-tree compatibility-count baseline; the exact staged branding, identity,
configuration, asset, and protected-control checks still run.

If the staged command passes without an exact-review finding, create the import
commit. If it adds no new compatibility occurrence, verify its exact committed
range before pushing:

```bash
git commit
IMPORT_SHA="$(git rev-parse HEAD)"
yarn verify:upstream-import --range "$BASE_SHA" "$SOURCE_SHA" "$IMPORT_SHA"
```

### Exact review requires a separate base change

An import cannot change `.upstream-import-review.txt` or approve itself. When a
source transformation, required compatibility symbol, Idle-owned
configuration, or inspected asset produces a review fingerprint, save the
candidate patch, remove it from the branch, and commit only the emitted review
record:

```bash
PATCH_FILE="$(mktemp "${TMPDIR:-/tmp}/idle-upstream.XXXXXX.patch")"
chmod 600 "$PATCH_FILE"
git diff --cached --binary --full-index --no-color --no-ext-diff -- \
  . ':(exclude).upstream-import-review.txt' >"$PATCH_FILE"
git restore --source=HEAD --staged --worktree -- .

# Add only the exact seven-field record printed by the failed staged guard.
${EDITOR:-vi} .upstream-import-review.txt
git add .upstream-import-review.txt
git commit -m "chore(security): pre-authorize exact upstream delta"
REVIEW_SHA="$(git rev-parse HEAD)"
yarn verify:upstream-import --policy-range "$BASE_SHA" "$REVIEW_SHA"
```

Merge and independently review that policy-only change before opening or
updating the import pull request. The import branch must then start from the
merged review commit. Reapply the exact saved patch and rerun the staged gate:

```bash
IMPORT_BASE_SHA="$(git rev-parse HEAD)"
git apply --index --binary "$PATCH_FILE"
rm -f "$PATCH_FILE"
yarn verify:upstream-import --staged "$SOURCE_SHA"
git commit
IMPORT_SHA="$(git rev-parse HEAD)"
```

The review fingerprint is bound to the pre-review Idle base, upstream source,
and imported-delta SHA-256. The delta digest excludes the two policy files, but
not imported source, configuration, or asset bytes. Changing any imported byte
invalidates the review. The guard reads review records from the import base,
not its staged or committed result, so placing a review in the import range is
always rejected.

If the import intentionally changes an already reviewed compatibility count,
update `.upstream-cruft-allow.txt` in one final, baseline-only commit. Do not
amend it into the source import commit. The committed-range gate accepts that
shape only when the review file is unchanged, no earlier import commit changes
a protected control, and the final baseline exactly matches the target tree:

```bash
# Edit only the exact affected path/count after inspecting the final tree.
${EDITOR:-vi} .upstream-cruft-allow.txt
git add .upstream-cruft-allow.txt
git commit -m "chore(security): align upstream compatibility baseline"
FINAL_SHA="$(git rev-parse HEAD)"
yarn verify:upstream-import --range "$IMPORT_BASE_SHA" "$SOURCE_SHA" "$FINAL_SHA"
```

Do not squash the import and final baseline commits. A baseline-only policy
change that does not accompany an import uses the same dedicated maintainer
gate: `yarn verify:upstream-import --policy-range <base> <head>`.

Approved commit email identities are `hello@northglass.io` with the Northglass
name, or a GitHub-generated `users.noreply.github.com` address. GitHub's exact
service identity is also accepted for web-created commits and merges. Keep the
commit message public-safe and record only the source commit identifier; do not
copy unrelated upstream notes or identity metadata into Idle.

## What the guard enforces

`scripts/check-upstream-cruft.sh` has two complementary checks:

- The full check compares every current branding-compatible occurrence with an
  exact path and count in `.upstream-cruft-allow.txt`. Wildcards and directory
  exceptions are rejected.
- `--staged` and `--diff <base> <head>` examine newly added filenames and text.
  They also detect external identities, signing or deployment configuration,
  and changed binary or visual assets. Existing compatibility entries cannot
  authorize a new addition.

Import deltas cannot add, remove, rename, or modify either policy file, the
upstream/documentation/metadata guards and their boundary tests, `package.json`,
GitHub workflows, Gitleaks policy, attribution files, or package licenses. A
review-only or baseline-only policy update uses `--policy-diff`; mixed policy
and product changes fail. The one exception is the isolated final exact-count
commit described above, which cannot add review records or weaken controls.
New inline secret-scanner suppression directives are non-reviewable and must be
removed rather than imported.

Diagnostics contain paths, categories, and opaque fingerprints only. They do
not repeat matching source lines, email addresses, hostnames, or configuration
values.

Most findings should be scrubbed. An intentionally transformed source delta, a
required wire/storage compatibility symbol or filename, an independently
inspected asset, or verified Idle-owned configuration can receive a one-change
review entry in
`.upstream-import-review.txt` using the exact category, path, and fingerprint
printed by the source-bound guard. Each seven-field entry also records the exact
Idle base commit, upstream source commit, and imported-delta SHA-256. The import
digest excludes only the two policy files, avoiding a circular policy hash
while binding approval to every imported byte. Any base, source, or
imported-delta change invalidates the approval. Each entry needs a short
public-safe reason.
Wildcards are not supported, and external or known upstream identities cannot
be approved.

Visual assets require a human comparison against Idle's brand source even when
the exact fingerprint is recorded. A later byte change produces a different
fingerprint and requires another review.

## Git metadata and hosted refs

The committed-range verification checks author and committer identities, commit
messages, and locally visible branch, pull, and tag metadata that targets the
selected commits. Diagnostics suppress metadata values. Public-hygiene CI uses
the exact pull-request head SHA rather than GitHub's synthetic merge commit and
runs the same range guards; the ordinary test and typecheck workflows cover the
dependency-heavy parts separately.

The trusted CI range does not infer an upstream source commit from contributor
text. The source-bound staged and committed commands above are therefore the
provenance authority: reviewers should require the exact `SOURCE_SHA` and a
passing canonical source-bound verification for an upstream import. CI
independently rechecks protected paths, metadata, branding, configuration,
assets, and policy-record integrity against the complete proposed range.

The required `Trusted upstream policy / static-policy` pull-request check runs
from the base branch with read-only permissions. It fetches bounded pull-request
Git objects, keeps the pull-request tree out of the worktree, and uses only the
trusted base copy of the static guards; it never installs, builds, sources, or
executes pull-request-controlled files. This follows GitHub's
[`pull_request_target` safety boundary](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
The branch must contain the current target base as an ancestor. The job fetches
at most the 4,096 allowed commits plus one rejection sentinel, proves ancestry,
and fails closed if the history is shallow, divergent, or over the limit; this
keeps commit-metadata inspection complete rather than silently scanning only a
pull request's tip.
Protect `main` against direct pushes and require this check plus an independent
maintainer approval. A pull request can modify its ordinary CI workflow, so the
head-controlled public-hygiene job is not a substitute for the trusted check.

CI can reject unsafe metadata that it can see, but it cannot delete or rewrite
GitHub-hosted pull-request refs. A history replacement must separately verify
all hosted refs after the repository owner performs the cutover.

## Attribution boundary

Keep the root `LICENSE` and `AUTHORS` attribution intact. Package-specific
license files that cover imported code must remain in the packages and in any
published archives. Product copy, icons, bundle metadata, infrastructure, and
credentials are not attribution and must use Idle-owned values.
