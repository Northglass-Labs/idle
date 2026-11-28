# Delivery

How a change in this repository reaches people. Nothing deploys on merge: a
merge to `main` runs verification only, and every release is started by a
maintainer.

Only some checks gate a merge. The required checks are the type check, the
five package test jobs, CodeQL, public hygiene, the trusted static policy, and
the private publication scan. The image verifications below and the CLI smoke
test also run on pull requests and `main`, but they are not required checks,
so a failure there does not block a merge; read their results before merging
and before any release.

| Surface | Verified here by | Released by |
|---|---|---|
| Relay server | [Server Release Verification](../.github/workflows/deploy-server.yml) | A maintainer, by hand, outside this repository |
| Web app | [Verify Web App Release](../.github/workflows/deploy-webapp.yml) | A maintainer, by hand, outside this repository |
| npm packages | Package tests in [Test All Packages](../.github/workflows/test-all.yml) | A maintainer-dispatched [npm publish](../.github/workflows/npm-publish.yml) run |
| iOS app | App tests in [Test All Packages](../.github/workflows/test-all.yml) | A maintainer-dispatched [TestFlight](../.github/workflows/deploy-testflight.yml) run |

## Relay server

For each pull request and push to `main` that touches the server, its wire
types, patches, the lockfile, or the image, the verification workflow:

1. installs the workspace, builds the shared wire types and the server runtime,
   and runs the server test suite and the container and release boundary tests;
2. builds the root `Dockerfile` image, starts it read-only, and waits for its
   health check;
3. fails if Grype finds a high-severity vulnerability with an available fix in
   the image.

It publishes no image and changes no server. Northglass releases its hosted
relay by hand from an exact, reviewed `main` commit through a private procedure
that keeps the previous release for rollback. To run your own relay, start from
[Self-hosting](SELF-HOSTING.md) or a [deployment target](deploy-targets/README.md).

## Web app

The web verification workflow builds `Dockerfile.webapp` (an Expo web export
served by an unprivileged nginx) against a placeholder relay, checks that the
container serves the app, and applies the same Grype gate. It publishes
nothing. The hosted web app is released by hand with the relay procedure above.

## npm packages

`@northglass/idle-wire`, `@northglass/idle-server`, `idle-coder`, and
`@northglass/agent` are published by the
[npm publish workflow](../.github/workflows/npm-publish.yml):

1. Bump the package version on `main`.
2. A maintainer runs the workflow for one package. It runs only from `main`, in
   the protected `npm-release` environment, and authenticates with npm Trusted
   Publishing, so no npm token is stored. The package's `prepublishOnly` build
   and tests run before anything is published.
3. Publish the wire package first, then the server and CLI; the agent package
   follows the wire release it needs.

A published npm version cannot be replaced. To undo a bad release, publish a
fixed patch version and deprecate the bad one.

## iOS app

A maintainer runs the [TestFlight workflow](../.github/workflows/deploy-testflight.yml)
from `main` with the full 40-character SHA of the current head of `main`; the
workflow refuses any other commit, including an older `main` commit. It runs in
the protected `production` environment, builds with EAS, and submits the build
to TestFlight. Submitting a build for App Store review is a separate manual
step in App Store Connect.

## Not available yet

This repository has no automatic deployment of the Northglass-hosted service,
no preview environments for it, and no scripted health-check or rollback
commands for it. The [deployment targets](deploy-targets/README.md) describe
deploying your own relay or web app, which is a different thing.
