import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const mustMatch = (value, pattern, message) => {
  assert.ok(pattern.test(value), message);
};
const mustNotMatch = (value, pattern, message) => {
  assert.equal(pattern.test(value), false, message);
};

test('public CI scans the exact committed tree and complete fetched history with a pinned Gitleaks binary', () => {
  const workflow = read('.github/workflows/public-hygiene.yml');

  mustMatch(workflow, /GITLEAKS_VERSION:\s*['"]?8\.30\.1['"]?/, 'Gitleaks version must be fixed');
  mustMatch(
    workflow,
    /GITLEAKS_LINUX_X64_SHA256:\s*['"]?551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb['"]?/,
    'the Linux release checksum must be fixed',
  );
  mustMatch(
    workflow,
    /gitleaks_\$\{GITLEAKS_VERSION\}_linux_x64\.tar\.gz/,
    'the pinned Linux release must be downloaded',
  );
  mustMatch(workflow, /curl --proto ['"]=https['"] --tlsv1\.2 --fail --silent --show-error --location/, 'download must require modern HTTPS and fail closed');
  mustMatch(workflow, /sha256sum --check --strict/, 'the archive must be verified before extraction');
  mustMatch(workflow, /tar -xzf "\$archive" -C "\$bin_dir" gitleaks/, 'only the scanner binary must be extracted');

  const archiveIndex = workflow.indexOf('git archive --format=tar "$HEAD_SHA"');
  const treeScanIndex = workflow.indexOf('gitleaks dir');
  const historyScanIndex = workflow.indexOf('gitleaks git');
  assert.ok(archiveIndex >= 0, 'CI must materialize the exact committed tree without ignored runner files');
  assert.ok(treeScanIndex > archiveIndex, 'the exact committed tree must be scanned');
  assert.ok(historyScanIndex > treeScanIndex, 'fetched Git history must be scanned after the tree');

  const scanSection = workflow.slice(archiveIndex, historyScanIndex + 1000);
  mustMatch(scanSection, /--redact=100/, 'scanner output must be fully redacted');
  mustMatch(scanSection, /--no-banner/, 'scanner output must omit the banner');
  mustMatch(scanSection, /--no-color/, 'scanner output must be stable and uncolored');
  mustMatch(scanSection, /--config "\$GITHUB_WORKSPACE\/\.gitleaks\.toml"/, 'the reviewed policy must be explicit');
  mustMatch(scanSection, /--max-archive-depth=0/, 'opaque archives must not be expanded by CI');
  mustMatch(scanSection, /--max-target-megabytes=64/, 'per-file work must be bounded');
  mustMatch(scanSection, /--timeout=120/, 'scanner work must be bounded');
  mustMatch(scanSection, /--log-opts="--all"/, 'all fetched history must be scanned');

  mustNotMatch(workflow, /gitleaks\/gitleaks-action@/, 'CI must not depend on the separately licensed action wrapper');
  mustMatch(workflow, /scripts\/secret-scanning-boundary\.test\.mjs/, 'CI must test its own scanner boundary');
});

test('trusted pull-request policy protects secret-scanner controls and inline suppressions', () => {
  const policy = read('scripts/check-upstream-cruft.mjs');
  const trustedWorkflow = read('.github/workflows/upstream-policy.yml');

  mustMatch(policy, /['"]\.gitleaks\.toml['"]/, 'scanner configuration must be protected');
  mustMatch(policy, /['"]\.gitleaksignore['"]/, 'scanner ignore files must be protected');
  mustMatch(policy, /['"]scripts\/opsec-boundary\.mjs['"]/, 'the private-policy scanner must be protected');
  mustMatch(policy, /['"]scripts\/publication-policy\.mjs['"]/, 'the authenticated policy loader must be protected');
  mustMatch(policy, /['"]scripts\/publication-policy\.encrypted\.json['"]/, 'the authenticated policy payload must be protected');
  mustMatch(policy, /['"]scripts\/publication-policy-keychain\.swift['"]/, 'the Keychain helper must be protected');
  mustMatch(policy, /gitleaks\s*\\s\*:\\s\*allow|gitleaks:allow/i, 'inline scanner suppressions must be rejected');
  mustMatch(trustedWorkflow, /pull_request_target:/, 'policy must run from the trusted base branch');
  mustMatch(trustedWorkflow, /verify-upstream-import\.mjs --ci-range/, 'trusted code must inspect the PR object delta');

  const privateJobStart = trustedWorkflow.indexOf('\n  private-publication:');
  assert.ok(privateJobStart >= 0, 'private matching must run in a separately approved job');
  const staticJob = trustedWorkflow.slice(0, privateJobStart);
  const privateJob = trustedWorkflow.slice(privateJobStart);
  const privateScanStepStart = privateJob.indexOf('- name: Inspect candidate tree with private publication policy');
  assert.ok(privateScanStepStart >= 0, 'private matching must have one explicit key-bearing scanner step');
  const privatePreparation = privateJob.slice(0, privateScanStepStart);
  const privateScanStep = privateJob.slice(privateScanStepStart);
  mustNotMatch(staticJob, /secrets\.|IDLE_PUBLICATION_POLICY_KEY/, 'automatic public PR inspection must remain secret-free');
  mustNotMatch(privatePreparation, /secrets\.|IDLE_PUBLICATION_POLICY_KEY/, 'fetch and validation must remain secret-free');
  assert.equal(trustedWorkflow.match(/secrets\.IDLE_PUBLICATION_POLICY_KEY/g)?.length, 1);
  mustMatch(privateJob, /needs:\s*static-policy/, 'private matching must wait for the bounded generic policy gate');
  mustMatch(privateJob, /environment:\s*private-publication-review/, 'private matching must require protected-environment approval');
  mustMatch(privateJob, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/, 'scanner code must be checked out from the trusted base commit');
  mustMatch(privateJob, /refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/private-policy\/pr-head/, 'the candidate must be fetched only as bounded Git objects');
  mustMatch(privatePreparation, /timeout 60s git fetch[\s\S]{0,220}--depth=4098[\s\S]{0,120}--filter=blob:limit=16777217/, 'the approved job must repeat the bounded candidate fetch');
  mustMatch(privatePreparation, /git merge-base --is-ancestor "\$BASE_SHA" "\$HEAD_SHA"/, 'the approved job must verify candidate ancestry');
  mustMatch(privatePreparation, /rev-list --count --max-count=4097/, 'the approved job must bound candidate commit count');
  mustMatch(privateScanStep, /IDLE_PUBLICATION_POLICY_KEY:\s*\$\{\{\s*secrets\.IDLE_PUBLICATION_POLICY_KEY\s*\}\}/, 'only the exact scanner step may receive the private key');
  mustMatch(privateScanStep, /node scripts\/opsec-boundary\.mjs --require-private-policy --tree "\$HEAD_SHA"/, 'the exact OPSEC tree scanner must be required');
  mustMatch(privateScanStep, /node scripts\/check-upstream-cruft\.mjs --require-private-policy --tree "\$HEAD_SHA"/, 'the exact upstream tree scanner must be required');
  mustNotMatch(privateJob, /git (?:checkout|switch|restore)[^\n]*HEAD_SHA|actions\/checkout@[\s\S]{0,250}head\.sha/, 'the candidate tree must never be checked out or executed');
});

test('ordinary push and pull-request hygiene remains entirely private-key free', () => {
  const workflow = read('.github/workflows/public-hygiene.yml');
  mustNotMatch(workflow, /private-policy:|secrets\.|IDLE_PUBLICATION_POLICY_KEY/, 'ordinary push and PR automation must never receive the private policy key');
  mustMatch(
    workflow,
    /name: Verify generic publication boundary[\s\S]{0,100}run: bash scripts\/check-docs-hygiene\.sh/,
    'ordinary pull requests and pushes must retain the generic secret-free publication scan',
  );
});
