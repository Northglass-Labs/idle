import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const scopedDocs = [
  'docs/api.md',
  'docs/backend-architecture.md',
  'docs/protocol.md',
  'docs/encryption.md',
  'packages/idle-server/README.md',
  'packages/idle-wire/README.md',
  'packages/idle-agent/README.md',
  'packages/idle-cli/README.md',
];

const routeSources = [
  'packages/idle-server/sources/app/api/api.ts',
  'packages/idle-server/sources/app/api/localFileRoutes.ts',
  'packages/idle-server/sources/app/api/utils/enableMonitoring.ts',
  ...fs
    .readdirSync(path.join(repoRoot, 'packages/idle-server/sources/app/api/routes'))
    .filter(file => file.endsWith('.ts') && !/\.(?:spec|test)\.ts$/.test(file) && !file.startsWith('_'))
    .map(file => `packages/idle-server/sources/app/api/routes/${file}`),
];

const forbiddenBrandToken = ['Hap', 'py'].join('');
const forbiddenHostedApiHost = `${['idle', 'api'].join('-')}.${['north', 'glass'].join('')}.io`;

function implementedRoutes() {
  const routes = new Set();
  const routePattern = /app\.(get|post|put|delete)\(\s*['"]([^'"]+)['"]/g;
  for (const sourcePath of routeSources) {
    for (const match of read(sourcePath).matchAll(routePattern)) {
      routes.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }
  return routes;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('the HTTP catalog covers every registered route and invents no endpoints', () => {
  const api = read('docs/api.md');
  const implemented = implementedRoutes();

  for (const route of implemented) {
    assert.match(api, new RegExp('`' + escapeRegExp(route) + '(?:\\?[^`]*)?`'), `missing ${route}`);
  }

  const documented = new Set(
    [...api.matchAll(/`(GET|POST|PUT|DELETE) (\/[^`?\s]+)(?:\?[^`]*)?`/g)]
      .map(([, method, routePath]) => `${method} ${routePath}`),
  );
  for (const route of documented) {
    assert.ok(implemented.has(route), `documented route is not registered: ${route}`);
  }

  assert.match(api, /POST \/v1\/auth\/challenge[\s\S]{0,500}challengeId/);
  assert.match(api, /POST \/v1\/auth`[\s\S]{0,500}challengeId/);
  assert.doesNotMatch(api, /Body:\s*`\{ publicKey, challenge, signature \}`/);
  assert.match(api, /supportsV2[^\n]*true/);
});

test('encryption documentation separates client content keys from the relay master secret', () => {
  const encryption = read('docs/encryption.md');
  const backend = read('docs/backend-architecture.md');
  const server = read('packages/idle-server/README.md');
  const combined = `${encryption}\n${backend}\n${server}`;

  assert.match(encryption, /client account secret/i);
  assert.match(encryption, /separate from `?IDLE_MASTER_SECRET`?/i);
  assert.match(combined, /IDLE_MASTER_SECRET[\s\S]{0,500}(?:issue|sign|verify)[^\n]*(?:bearer|authentication) tokens/i);
  assert.match(combined, /server can decrypt[\s\S]{0,220}GitHub OAuth (?:token|credential)/i);
  assert.match(combined, /IDLE_MASTER_SECRET[\s\S]{0,500}does not[\s\S]{0,180}client-encrypted (?:session )?(?:content|messages|keys)/i);

  for (const visibleBoundary of [
    /routing (?:identifiers|metadata)/i,
    /usage (?:counts|reports|data)/i,
    /push tokens/i,
    /notification title/i,
    /account profile/i,
    /voice/i,
  ]) {
    assert.match(combined, visibleBoundary);
  }
});

test('package docs make no blanket confidentiality or infrastructure claims', () => {
  const corpus = scopedDocs.map(read).join('\n');
  for (const falseOrInternalClaim of [
    /all communication is end-to-end encrypted/i,
    /all machine and session data is end-to-end encrypted/i,
    /we can't see the content/i,
    /server never needs to understand plaintext/i,
    /server's job is simple/i,
    /zero[- ]knowledge/i,
    /distributed ready/i,
    /only essential features/i,
    /CORS:\s*`?\*`?/i,
    new RegExp(escapeRegExp(forbiddenHostedApiHost), 'i'),
    new RegExp(`\\b${forbiddenBrandToken}(?: Coder)?\\b`),
    /Northglass-specific|Idle addition|upstream mechanism|under review|remove once|follow-up|TODO/i,
    /202\d-\d{2}-\d{2}/,
  ]) {
    assert.doesNotMatch(corpus, falseOrInternalClaim);
  }

  assert.match(read('packages/idle-server/README.md'), /default[\s\S]{0,160}(?:PGlite|local filesystem)/i);
  assert.match(read('docs/backend-architecture.md'), /optional[\s\S]{0,220}(?:PostgreSQL|Redis|S3)/i);
});

test('protocol documentation matches current security and event boundaries', () => {
  const protocol = read('docs/protocol.md');
  const security = read('docs/SECURITY.md');
  assert.match(protocol, /exact browser origin/i);
  assert.doesNotMatch(protocol, /origin[^\n]*\*/i);
  for (const eventName of ['delete-machine', 'session-event', 'app-state', 'rpc-error']) {
    assert.match(protocol, new RegExp('`' + eventName + '`'));
  }
  assert.match(protocol, /title[\s\S]{0,120}body[\s\S]{0,180}server-readable/i);
  assert.match(protocol, /Socket\.IO[\s\S]{0,160}\/v1\/updates/);
  assert.match(
    security,
    /durably consumes? the request identity before handler dispatch/i,
  );
});

test('wire README documents exported contracts without duplicating the implementation', () => {
  const wireReadme = read('packages/idle-wire/README.md');
  const wireSources = fs
    .readdirSync(path.join(repoRoot, 'packages/idle-wire/src'))
    .filter(file => file.endsWith('.ts'))
    .map(file => read(`packages/idle-wire/src/${file}`))
    .join('\n');

  for (const moduleName of [
    'messages',
    'messageIdentity',
    'rpcProtocol',
    'legacyProtocol',
    'sessionProtocol',
    'sessionFieldEnvelope',
    'voice',
    'authProtocol',
  ]) {
    assert.match(wireReadme, new RegExp('`src/' + moduleName + '\\.ts`'));
    assert.match(read('packages/idle-wire/src/index.ts'), new RegExp("'\\./" + moduleName + "'"));
  }

  for (const exportedName of [
    'SessionMessageContentSchema',
    'CoreUpdateContainerSchema',
    'LegacyMessageContentSchema',
    'sessionEnvelopeSchema',
    'AuthenticatedMessageIdentitySchema',
    'AuthenticatedRpcRequestSchema',
    'AuthenticatedSessionFieldEnvelopeSchema',
    'createAuthenticatedSessionFieldEnvelope',
    'readAuthenticatedSessionFieldEnvelope',
    'VoiceConversationResponseSchema',
    'AuthPairingPayloadSchema',
    'buildAuthChallengeMessage',
  ]) {
    assert.match(wireReadme, new RegExp('`' + exportedName + '(?:\\(\\))?`'));
    assert.match(wireSources, new RegExp('export (?:const|function) ' + exportedName + '\\b'));
  }

  assert.match(wireReadme, /schemas validate structure[\s\S]{0,180}do not perform encryption/i);
  assert.ok(wireReadme.split(/\r?\n/).length <= 260, 'wire README should not duplicate every Zod field');
});

test('package commands and local credential warnings stay accurate', () => {
  const server = read('packages/idle-server/README.md');
  const selfHosting = read('docs/SELF-HOSTING.md');
  const contributing = read('docs/CONTRIBUTING.md');
  const agent = read('packages/idle-agent/README.md');
  const cli = read('packages/idle-cli/README.md');

  assert.match(server, /@northglass\/idle-server/);
  assert.match(server, /idle-server migrate/);
  assert.match(server, /idle-server serve/);
  assert.doesNotMatch(server, /IDLE_MASTER_SECRET\s*=\s*["']?\$\(openssl/i);
  assert.doesNotMatch(server, /\bexport\s+IDLE_MASTER_SECRET\s*=/i);
  assert.match(server, /stty -echo[\s\S]{0,300}read -r IDLE_MASTER_SECRET/i);
  assert.match(server, /unset IDLE_MASTER_SECRET/i);
  assert.match(server, /IDLE_MASTER_SECRET_FILE/i);
  assert.match(selfHosting, /stty -echo[\s\S]{0,300}read -r IDLE_MASTER_SECRET/i);
  assert.match(selfHosting, /unset IDLE_MASTER_SECRET/i);
  assert.match(selfHosting, /IDLE_MASTER_SECRET_FILE/i);
  for (const publicSurface of [server, selfHosting, contributing]) {
    assert.doesNotMatch(publicSurface, /--env-file|\.env\.(?:idle|production|dev)|idle-server\.env/i);
    assert.doesNotMatch(publicSurface, /(?:printf|echo)[^\n]*IDLE_MASTER_SECRET[^\n]*>/i);
  }

  assert.match(agent, /npm install -g @northglass\/agent/);
  assert.match(agent, /agent\.key[\s\S]{0,180}(?:sensitive|secret|0600)/i);
  assert.match(agent, /--yolo[\s\S]{0,200}(?:dangerous|bypass|approval)/i);

  assert.match(cli, /npm install -g idle-coder/);
  assert.match(cli, /--yolo[\s\S]{0,200}(?:dangerous|bypass|approval)/i);
  assert.match(cli, /provider credentials remain local/i);
  assert.doesNotMatch(cli, /idle connect (?:codex|claude|status)|upload provider service credentials/i);
  assert.match(cli, /git clone https:\/\/github\.com\/Northglass-Labs\/idle\.git/);
  assert.match(cli, /\ncd idle\n/);
  assert.doesNotMatch(cli, /\ncd idle-cli\n/);
});

test('server development commands do not expose local services or kill unrelated listeners', () => {
  const pkg = JSON.parse(read('packages/idle-server/package.json'));
  const scripts = pkg.scripts;
  for (const removedHelper of ['db', 'redis', 's3', 's3:down', 's3:init']) {
    assert.equal(scripts[removedHelper], undefined, `${removedHelper} must use documented managed setup`);
  }
  const commands = Object.values(scripts).join('\n');
  assert.doesNotMatch(commands, /kill\s+-9|xargs\s+kill/i);
  assert.doesNotMatch(commands, /--env-file|dotenv\s+-e|\.env\.(?:dev|idle|production)/i);
  assert.equal(pkg.devDependencies?.['dotenv-cli'], undefined);
  assert.equal(pkg.dependencies?.dotenv, undefined);
  assert.doesNotMatch(commands, /(?:5432|6379|9000|9001):(?:5432|6379|9000|9001)/);
  assert.doesNotMatch(commands, /POSTGRES_PASSWORD=postgres|minioadmin/i);

  const server = read('packages/idle-server/README.md');
  assert.match(server, /docker compose up/i);
  assert.match(server, /loopback/i);
  assert.match(server, /secret manager/i);
});

test('public package entrypoints use the repository toolchain and describe every workspace surface', () => {
  for (const relativePath of [
    'packages/idle-app/README.md',
    'packages/idle-cli/README.md',
    'packages/idle-agent/README.md',
    'packages/idle-server/README.md',
    'packages/idle-wire/README.md',
    'packages/idle-e2e/README.md',
    'packages/idle-e2e-mobile/README.md',
  ]) {
    assert.match(read(relativePath), /Node\.js 22\.12 or newer/i, relativePath);
  }

  const contributing = read('docs/CONTRIBUTING.md');
  assert.doesNotMatch(contributing, /^yarn test:(?:wire|server|cli|app|agent)\b/m);
  assert.match(contributing, /yarn workspace @northglass\/idle-wire test/);
  assert.match(contributing, /yarn workspace idle-coder test:unit/);
  assert.match(contributing, /yarn workspace @northglass\/idle-server test/);
  assert.match(contributing, /yarn workspace @northglass\/agent test/);
  assert.match(contributing, /yarn workspace idle-app test --run/);
});

test('scoped public docs are concise and contain no broken relative links', () => {
  const maxLines = new Map([
    ['docs/api.md', 220],
    ['docs/backend-architecture.md', 240],
    ['docs/protocol.md', 240],
    ['docs/encryption.md', 280],
    ['packages/idle-server/README.md', 200],
    ['packages/idle-wire/README.md', 260],
    ['packages/idle-agent/README.md', 220],
    ['packages/idle-cli/README.md', 220],
  ]);

  for (const relativePath of scopedDocs) {
    const content = read(relativePath);
    assert.ok(
      content.split(/\r?\n/).length <= maxLines.get(relativePath),
      `${relativePath} should keep one public contract instead of duplicated narrative`,
    );

    for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:\/\/|mailto:|#)([^)]+)\)/g)) {
      const linkTarget = decodeURIComponent(match[1].split('#')[0]);
      const resolved = path.resolve(path.dirname(path.join(repoRoot, relativePath)), linkTarget);
      assert.ok(fs.existsSync(resolved), `${relativePath} has a broken link to ${match[1]}`);
    }
  }
});
