import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const exists = relativePath => fs.existsSync(path.join(repoRoot, relativePath));

function markdownFilesIn(directory) {
  const entries = fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true });
  return entries.flatMap(entry => {
    const relativePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFilesIn(relativePath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [relativePath] : [];
  });
}

const publicMarkdown = [
  'README.md',
  'PRIVACY.md',
  ...markdownFilesIn('docs'),
  ...fs
    .readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && exists(`packages/${entry.name}/README.md`))
    .map(entry => `packages/${entry.name}/README.md`),
];

test('public docs use the approved Northglass identity and product endorsement', () => {
  const readme = read('README.md');
  const authors = read('AUTHORS');
  const corpus = [...publicMarkdown.map(read), authors].join('\n');

  assert.match(
    readme,
    /<a href="https:\/\/northglass\.io">a Northglass Product<\/a>/,
  );
  assert.doesNotMatch(corpus, /Northglass Labs(?!-)/);
  assert.doesNotMatch(readme, /Your terminal, anywhere\./i);
  assert.doesNotMatch(
    authors,
    /credited in (?:this|the) repository's[\s\S]{0,80}(?:graph|git history)/i,
  );
  assert.doesNotMatch(corpus, /discord\.gg\/fX9WBAhyfD/i);
});

test('the public navigation covers every supported surface without Claude-only framing', () => {
  const readme = read('README.md');
  const docsIndex = read('docs/README.md');

  for (const provider of ['Claude Code', 'OpenAI Codex', 'Google Gemini', 'OpenClaw', 'ACP']) {
    assert.match(readme, new RegExp(provider, 'i'), provider);
  }
  assert.match(readme, /`idle acp -- <command> \[args\]`/);

  assert.doesNotMatch(docsIndex, /mobile and web client for Claude Code/i);
  assert.doesNotMatch(read('docs/ARCHITECTURE.md'), /\biPHONE\b|your phone/i);
  for (const relativePath of [
    '../packages/idle-app/README.md',
    '../packages/idle-cli/README.md',
    '../packages/idle-agent/README.md',
    '../packages/idle-server/README.md',
    '../packages/idle-wire/README.md',
    '../packages/idle-e2e/README.md',
    '../packages/idle-e2e-mobile/README.md',
  ]) {
    assert.match(docsIndex, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('all public documentation has resolvable relative links', () => {
  for (const relativePath of publicMarkdown) {
    const content = read(relativePath);
    for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
      const linkTarget = decodeURIComponent(rawTarget.split('#')[0]);
      if (!linkTarget) continue;
      const resolved = path.resolve(path.dirname(path.join(repoRoot, relativePath)), linkTarget);
      assert.ok(fs.existsSync(resolved), `${relativePath} has a broken link to ${match[1]}`);
    }
  }
});

test('public architecture excludes hosted relay topology', () => {
  for (const relativePath of ['docs/ARCHITECTURE.md', 'docs/SECURITY.md', 'docs/SELF-HOSTING.md']) {
    assert.doesNotMatch(read(relativePath), /idle-api\.northglass\.io/i, relativePath);
  }

  const architecture = read('docs/ARCHITECTURE.md');
  assert.match(architecture, /GET \/v1\/sessions/);
  assert.match(architecture, /POST \/v2\/sessions/);
  assert.doesNotMatch(architecture, /POST \/v1\/sessions/);
  assert.match(architecture, /NaCl public-key box/i);
  assert.doesNotMatch(architecture, /sealed box/i);
  assert.doesNotMatch(architecture, /GET \/v3\/sessions(?!\/)/);
});

test('security and self-hosting docs avoid blanket guarantees and audit-diary prose', () => {
  const security = read('docs/SECURITY.md');
  const selfHosting = read('docs/SELF-HOSTING.md');

  assert.match(security, /notification (?:title and body|title\/body)[^\n]*server-readable/i);
  assert.doesNotMatch(security, /cannot see what's inside any message/i);
  assert.doesNotMatch(security, /pre-auth DB-bloat|publicKey length check|before this split/i);

  assert.doesNotMatch(selfHosting, /all options below provide the same end-to-end encryption/i);
  assert.doesNotMatch(selfHosting, /relay server[^\n]*cannot decrypt them/i);
  assert.doesNotMatch(selfHosting, /\b(?:\d+[-–]\d+ min|\$\d+(?:[-–]\d+)?\/mo|years of metadata)\b/i);
  assert.doesNotMatch(selfHosting, /idle-coder@\d|100-second proxy idle timeout/i);
  assert.ok(selfHosting.split(/\r?\n/).length <= 400, 'self-hosting should route detail to focused guides');
});

test('the API catalog does not describe attachment ciphertext as a public file URL', () => {
  const api = read('docs/api.md');
  assert.match(api, /`GET \/files\/\*`[\s\S]{0,180}`public\/`[\s\S]{0,80}image\s+namespace/i);
  assert.match(api, /session attachments[\s\S]{0,180}authenticated attachment routes/i);
  assert.doesNotMatch(api, /`GET \/files\/\*`[\s\S]{0,180}possession of the URL is sufficient/i);
});

test('privacy notices defer legal terms to the canonical Northglass policy', () => {
  for (const relativePath of ['PRIVACY.md', 'packages/idle-app/PRIVACY.md']) {
    const notice = read(relativePath);
    assert.match(notice, /https:\/\/northglass\.io\/privacy/);
    assert.doesNotMatch(notice, /anonymous ID derived from a secret key/i);
    assert.doesNotMatch(notice, /We do not share your data with anyone\. Period\./i);
    assert.doesNotMatch(notice, /complies with:\s*[\s\S]*(?:GDPR|CCPA)/i);
    assert.doesNotMatch(notice, /permanently removed[^\n]*within 30 days/i);
  }
  const privacy = read('PRIVACY.md');
  assert.match(privacy, /custom ElevenLabs Agent\s+ID/i);
  assert.doesNotMatch(privacy, /voice provider credentials/i);
});

test('software terms preserve the MIT audit and modification rights', () => {
  const terms = read('packages/idle-app/TERMS.md');
  assert.match(terms, /https:\/\/northglass\.io\/terms/);
  assert.match(terms, /MIT License/);
  assert.doesNotMatch(terms, /reverse engineer/i);
});

test('permission documentation keeps approvals independent from sandbox configuration', () => {
  const guide = read('docs/permission-resolution.md');
  assert.match(guide, /safe default/i);
  assert.match(guide, /does not[^\n]*(?:enable|select|force)[^\n]*(?:bypassPermissions|yolo)/i);
  assert.doesNotMatch(guide, /sandbox fallback:[\s\S]{0,160}bypassPermissions/i);
  assert.doesNotMatch(guide, /sandbox enabled:\s*force `?bypassPermissions/i);
});

test('architecture states credential visibility without publishing operator topology', () => {
  const architecture = read('docs/ARCHITECTURE.md');
  assert.match(architecture, /GitHub OAuth token[\s\S]{0,160}server can decrypt/i);
  assert.match(architecture, /idle-rpc-request/);
  assert.match(architecture, /requestId, issuedAt/);
  assert.match(architecture, /validates[\s\S]{0,120}request identity,[\s\S]{0,80}route, freshness/i);
  assert.doesNotMatch(architecture, /Only ports 22, 80, 443/i);
  assert.doesNotMatch(architecture, /Deploy user with limited sudoers/i);
  assert.doesNotMatch(architecture, /Cloudflare WAF/i);
  assert.doesNotMatch(architecture, /Nginx static/i);
});

test('public docs do not advertise a retired coding-agent credential vault', () => {
  const corpus = publicMarkdown.map(read).join('\n');

  for (const retiredClaim of [
    /AI[- ]provider (?:service )?(?:tokens|credentials)/i,
    /registered OpenAI, Anthropic, or HTTP-level Gemini/i,
    /credentials stored for GitHub, OpenAI,?\s+Anthropic/i,
    /service tokens or credentials registered for GitHub and\s+AI providers/i,
    /Connected GitHub and other service credentials/i,
    /stored service credentials/i,
  ]) {
    assert.doesNotMatch(corpus, retiredClaim);
  }

  assert.match(read('README.md'), /provider CLI or SDK[\s\S]{0,180}authentication/i);
  assert.match(read('docs/SECURITY.md'), /GitHub OAuth credential[\s\S]{0,180}relay can decrypt/i);
  assert.match(read('docs/encryption.md'), /server can decrypt the GitHub OAuth token[\s\S]{0,120}not end-to-end encryption/i);
});

test('CLI architecture matches local provider auth and current control boundaries', () => {
  const guide = read('docs/cli-architecture.md');
  const entry = read('packages/idle-cli/src/index.ts');

  assert.match(guide, /POST \/v2\/sessions/);
  assert.doesNotMatch(guide, /POST \/v1\/sessions/);
  assert.match(guide, /official provider CLIs/i);
  assert.match(guide, /provider\s+credentials stay local/i);
  assert.match(guide, /explicit child-process\s+environment overrides/i);
  assert.match(guide, /not a provider-credential vault/i);
  assert.match(guide, /idle connect gemini/);
  assert.doesNotMatch(guide, /Connect machine/i);
  assert.match(guide, /controlToken/);
  assert.match(guide, /Bearer/);
  assert.doesNotMatch(guide, /GET \/list/);
  assert.doesNotMatch(entry, /Connect AI vendor API keys/i);
  assert.match(entry, /Local provider authentication guidance/i);
});

test('public product direction excludes operator SaaS notes and dated backlog state', () => {
  assert.equal(exists('docs/3dparty.md'), false);
  const roadmap = read('docs/ROADMAP.md');
  assert.doesNotMatch(roadmap, /^## (?:Now|Next)$/m);
  assert.doesNotMatch(roadmap, /still cooking|queued separately|trying the MCP|re-enable.*CI/i);
});

test('realtime documentation contains no missing internal links or backlog', () => {
  const realtime = read('docs/realtime-sync-and-rpc.md');
  assert.doesNotMatch(realtime, /multi-process\.md/);
  assert.doesNotMatch(realtime, /^## Current Sharp Edges$/m);
});

test('self-hosted server voice requires a server-owned key and agent', () => {
  const selfHosting = read('docs/SELF-HOSTING.md');
  assert.match(selfHosting, /ELEVENLABS_API_KEY/);
  assert.match(selfHosting, /ELEVENLABS_AGENT_ID/);
  assert.match(selfHosting, /server-owned agent/i);
});

test('the flagship README describes safe defaults and optional provider boundaries truthfully', () => {
  const readme = read('README.md');
  assert.match(readme, /safe default/i);
  assert.match(readme, /(?:--yolo|`yolo`)/);
  assert.match(readme, /explicit/i);
  assert.match(readme, /ElevenLabs/);
  assert.match(readme, /direct[\s\S]{0,80}custom[\s\S]{0,40}ElevenLabs agent/i);
  assert.doesNotMatch(readme, /bring-your-own-agent mode connects to the provider selected/i);
  assert.doesNotMatch(readme, /No third-party AI service connections/i);
  assert.doesNotMatch(readme, /zero external deps/i);
  assert.doesNotMatch(readme, /always-on PostHog analytics/i);
});

test('master-secret documentation does not confuse server credentials with end-to-end session keys', () => {
  const files = [
    'README.md',
    'docs/SECURITY.md',
    'docs/SELF-HOSTING.md',
    'docs/deploy-targets/fly.md',
    'docs/deploy-targets/railway.md',
    'docs/deploy-targets/render.md',
    'packages/idle-server/README.md',
  ];
  for (const relativePath of files) {
    const content = read(relativePath);
    assert.doesNotMatch(
      content,
      /IDLE_MASTER_SECRET[^.\n]*(?:seal|encrypt|decrypt)[^.\n]*(?:per-)?session (?:key|content|message)/i,
      relativePath,
    );
    assert.doesNotMatch(content, /IDLE_MASTER_SECRET rotation[^\n]*(?:data loss|pairing)/i, relativePath);
  }
  assert.match(read('docs/SECURITY.md'), /forge auth(?:entication)?\s+tokens/i);
  assert.match(read('docs/SECURITY.md'), /decrypt[^\n]*GitHub OAuth (?:token|credential)/i);
  assert.doesNotMatch(read('docs/ARCHITECTURE.md'), /PRIVATE KEY[\s\S]{0,100}master secret/i);
});

test('public bug reports do not request retired surfaces or private relay details', () => {
  const template = read('.github/ISSUE_TEMPLATE/bug_report.md');
  assert.doesNotMatch(template, /tap ["'`]?Idle["'`]? 10 times|dev info/i);
  assert.doesNotMatch(template, /macOS desktop/i);
  assert.doesNotMatch(template, /self-hosted \(URL\)|idle-api\.northglass\.io/i);
  assert.match(template, /hosted \/ self-hosted/);
  assert.match(template, /redact[\s\S]{0,300}(?:access tokens|API keys)/i);
  assert.match(template, /private contact/i);
});

test('the public app changelog is concise release history, not a build diary', () => {
  const changelog = read('packages/idle-app/CHANGELOG.md');
  const generated = read('packages/idle-app/sources/changelog/changelog.json');
  for (const content of [changelog, generated]) {
    assert.doesNotMatch(content, /(?:^|\n)# Version \d+/);
    assert.doesNotMatch(content, /\bBuild \d+\b|still cooking|queued separately|\[SESS-ID-|grep `?\[SESS/i);
    assert.doesNotMatch(content, /\bbypassPermissions\b/);
    assert.match(content, /--yolo/);
    assert.match(content, /--dangerously-skip-permissions/);
  }
  assert.match(changelog, /^# Idle \d+\.\d+\.\d+/);
  const parsed = JSON.parse(generated);
  assert.ok(parsed.entries.length > 0 && parsed.entries.length <= 8);
});
