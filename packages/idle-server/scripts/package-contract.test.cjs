'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const tar = require('tar');

const serverRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');
const agentRoot = path.join(repoRoot, 'packages', 'idle-agent');
const appRoot = path.join(repoRoot, 'packages', 'idle-app');
const cliRoot = path.join(repoRoot, 'packages', 'idle-cli');
const e2eRoot = path.join(repoRoot, 'packages', 'idle-e2e');
const wireRoot = path.join(repoRoot, 'packages', 'idle-wire');
const upstreamLicenseNotice = 'Copyright (c) 2026 Happy Coder Contributors';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const read = file => fs.readFileSync(file, 'utf8');

function resolveNpmInvocation({
  env = process.env,
  execPath = process.execPath,
  existsSync = fs.existsSync,
  platform = process.platform,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const lifecycleCli = env.npm_execpath;
  const candidates = [
    typeof lifecycleCli === 'string'
      && pathApi.basename(lifecycleCli).toLowerCase() === 'npm-cli.js'
      ? lifecycleCli
      : null,
    pathApi.join(pathApi.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidates.find(candidate => existsSync(candidate));

  if (npmCli) {
    return { file: execPath, args: [npmCli] };
  }
  if (platform === 'win32') {
    throw new Error('Unable to locate npm-cli.js for shell-free package inspection on Windows');
  }
  return { file: 'npm', args: [] };
}

test('npm package inspection executes the npm JavaScript CLI through Node on Windows', () => {
  const npmCli = 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js';
  const invocation = resolveNpmInvocation({
    env: { npm_execpath: npmCli },
    execPath: 'C:\\node\\node.exe',
    existsSync: candidate => candidate === npmCli,
    platform: 'win32',
  });

  assert.deepEqual(invocation, {
    args: [npmCli],
    file: 'C:\\node\\node.exe',
  });
});

function listFiles(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

async function packAndExtract(packageRoot, tempRoot, label) {
  const packDir = path.join(tempRoot, `${label}-pack`);
  const extractDir = path.join(tempRoot, `${label}-extract`);
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const packEnv = { ...process.env, npm_config_loglevel: 'silent' };
  for (const key of Object.keys(packEnv)) {
    if (key.toLowerCase() === 'npm_config_dry_run') {
      delete packEnv[key];
    }
  }
  const npm = resolveNpmInvocation();
  const output = execFileSync(npm.file, [
    ...npm.args,
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDir,
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: packEnv,
  });
  const metadata = JSON.parse(output)[0];
  const tarball = path.join(packDir, metadata.filename);
  await tar.x({ file: tarball, cwd: extractDir, strict: true });
  const extractedPackage = path.join(extractDir, 'package');
  return {
    metadata,
    files: listFiles(extractedPackage),
    root: extractedPackage,
  };
}

function assertOnlyAllowedPaths(files, allowed, label) {
  const unexpected = files.filter(file => !allowed.some(rule =>
    typeof rule === 'string' ? file === rule : rule.test(file),
  ));
  assert.deepEqual(unexpected, [], `${label} packed unexpected files`);
}

function readPackedTextFiles(packed) {
  return packed.files
    .map(file => {
      const contents = fs.readFileSync(path.join(packed.root, file));
      return contents.includes(0) ? '' : contents.toString('utf8');
    })
    .join('\n');
}

function assertPackedScriptDependencies(packed, label) {
  const files = new Set(packed.files);
  for (const file of packed.files.filter(candidate => /^scripts\/.*\.cjs$/.test(candidate))) {
    const source = read(path.join(packed.root, file));
    for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}/index.cjs`];
      assert.ok(
        candidates.some(candidate => files.has(candidate)),
        `${label} tarball is missing the local dependency ${match[1]} required by ${file}`,
      );
    }
  }
}

const serverPackage = readJson(path.join(serverRoot, 'package.json'));
const rootPackage = readJson(path.join(repoRoot, 'package.json'));
const agentPackage = readJson(path.join(agentRoot, 'package.json'));
const appPackage = readJson(path.join(appRoot, 'package.json'));
const cliPackage = readJson(path.join(cliRoot, 'package.json'));
const e2ePackage = readJson(path.join(e2eRoot, 'package.json'));
const wirePackage = readJson(path.join(wireRoot, 'package.json'));

test('every workspace Wire consumer tracks the current contract version', () => {
  assert.equal(agentPackage.dependencies['@northglass/idle-wire'], wirePackage.version);
  assert.equal(appPackage.dependencies['@northglass/idle-wire'], `^${wirePackage.version}`);
  assert.equal(cliPackage.devDependencies['@northglass/idle-wire'], wirePackage.version);
  assert.equal(e2ePackage.devDependencies['@northglass/idle-wire'], `^${wirePackage.version}`);
  assert.equal(serverPackage.devDependencies['@northglass/idle-wire'], wirePackage.version);
});

test('public package identity and runtime requirements stay aligned', () => {
  assert.deepEqual(rootPackage.engines, { node: '>=22.12.0' });

  for (const [label, packageJson] of [
    ['server', serverPackage],
    ['agent', agentPackage],
    ['CLI', cliPackage],
    ['Wire', wirePackage],
  ]) {
    assert.equal(packageJson.author, 'Northglass', `${label} author`);
    assert.deepEqual(packageJson.engines, { node: '>=22.12.0' }, `${label} Node engine`);
  }

  assert.match(cliPackage.description, /Claude Code/);
  assert.match(cliPackage.description, /Codex/);
  assert.match(cliPackage.description, /Gemini/);
  assert.match(cliPackage.description, /OpenClaw/);
  assert.match(cliPackage.description, /ACP/);
  assert.doesNotMatch(cliPackage.description, /Mobile and Web client|Idle Coder/i);
  assert.doesNotMatch(agentPackage.description, /Idle Coder/i);
});

test('embedded database adapter stays on the Prisma 6 compatible line', () => {
  assert.equal(serverPackage.dependencies['@prisma/client'], '6.19.3');
  assert.equal(serverPackage.dependencies.prisma, '6.19.3');
  assert.equal(serverPackage.dependencies['pglite-prisma-adapter'], '0.6.1');
});

test('server postinstall invokes Prisma through Node without a platform shim', () => {
  assert.equal(serverPackage.scripts.generate, 'prisma generate --schema=prisma/schema.prisma');
  assert.equal(serverPackage.scripts.postinstall, 'node scripts/generate-prisma.cjs');
  assert.ok(serverPackage.files.includes('scripts/generate-prisma.cjs'));
  assert.equal(serverPackage.dependencies['prisma-json-types-generator'], undefined);
  assert.equal(serverPackage.devDependencies['prisma-json-types-generator'], '^3.5.1');

  const generator = read(path.join(serverRoot, 'scripts', 'generate-prisma.cjs'));
  assert.match(generator, /require\.resolve\(['"]prisma\/build\/index\.js['"]/);
  assert.match(generator, /resolveOptional\(['"]prisma-json-types-generator\/index\.js['"]\)/);
  assert.match(generator, /mkdtempSync/);
  assert.match(generator, /prisma-json-types-generator/);
  assert.match(generator, /generatorArgs\.push\(['"]--generator=client['"]\)/);
  assert.match(generator, /spawnSync\(\s*process\.execPath/);
  assert.match(generator, /shell:\s*false/);
  assert.doesNotMatch(generator, /spawnSync\(['"]prisma(?:\.cmd)?['"]/);
});

test('repository and package licenses use the legal entity name', () => {
  for (const licensePath of [
    path.join(repoRoot, 'LICENSE'),
    path.join(appRoot, 'LICENSE'),
    path.join(agentRoot, 'LICENSE'),
    path.join(cliRoot, 'LICENSE'),
    path.join(serverRoot, 'LICENSE'),
    path.join(wireRoot, 'LICENSE'),
  ]) {
    const license = read(licensePath);
    assert.match(license, /Copyright \(c\) 2026 Northglass LLC/);
    assert.doesNotMatch(license, /Copyright \(c\) 2026 Northglass Labs/);
  }
});

test('server package is a publishable Northglass runtime with a strict allowlist', () => {
  assert.equal(serverPackage.name, '@northglass/idle-server');
  assert.notEqual(serverPackage.private, true);
  assert.equal(serverPackage.author, 'Northglass');
  assert.deepEqual(serverPackage.bin, {
    'idle-server': 'bin/idle-server.cjs',
  });
  assert.deepEqual(serverPackage.files, [
    'LICENSE',
    'bin/idle-server.cjs',
    'dist/standalone.mjs',
    'index.cjs',
    'prisma/migrations',
    'prisma/schema.prisma',
    'README.md',
    'scripts/generate-prisma.cjs',
  ]);
});

test('idle-coder installs the exact matching server runtime', () => {
  assert.equal(
    cliPackage.dependencies['@northglass/idle-server'],
    serverPackage.version,
  );
  assert.equal(cliPackage.author, 'Northglass');
  assert.deepEqual(cliPackage.engines, { node: '>=22.12.0' });
  assert.deepEqual(cliPackage.files, [
    'LICENSE',
    'dist',
    'bin/idle.mjs',
    'bin/idle-mcp.mjs',
    'scripts/claude_local_launcher.cjs',
    'scripts/claude_version_utils.cjs',
    'scripts/ripgrep_launcher.cjs',
  ]);
  assert.equal(cliPackage.scripts.postinstall, undefined);
  assert.equal(cliPackage.dependencies.tar, undefined);
  assert.equal(cliPackage.dependencies['@northglass/idle-wire'], undefined);
  assert.equal(cliPackage.devDependencies['@northglass/idle-wire'], wirePackage.version);
  assert.equal(serverPackage.dependencies['@northglass/idle-wire'], undefined);
  assert.equal(serverPackage.devDependencies['@northglass/idle-wire'], wirePackage.version);
  assert.equal(wirePackage.author, 'Northglass');
  assert.deepEqual(wirePackage.engines, { node: '>=22.12.0' });
  assert.deepEqual(wirePackage.files, ['LICENSE', 'dist', 'README.md']);
});

test('agent package is a publishable Northglass client with a strict allowlist', () => {
  assert.equal(agentPackage.name, '@northglass/agent');
  assert.notEqual(agentPackage.private, true);
  assert.equal(agentPackage.author, 'Northglass');
  assert.deepEqual(agentPackage.engines, { node: '>=22.12.0' });
  assert.deepEqual(agentPackage.files, [
    'LICENSE',
    'README.md',
    'dist',
    'bin/idle-agent.mjs',
  ]);
  assert.equal(agentPackage.dependencies['@northglass/idle-wire'], wirePackage.version);

  const readme = read(path.join(agentRoot, 'README.md'));
  assert.match(readme, /yarn workspace @northglass\/agent build/);
  assert.doesNotMatch(readme, /yarn workspace idle-agent\b/);
});

test('wire package README covers every public entrypoint module', () => {
  const index = read(path.join(wireRoot, 'src', 'index.ts'));
  const readme = read(path.join(wireRoot, 'README.md'));
  const modules = [...index.matchAll(/export \* from ['"]\.\/([^'"]+)['"]/g)]
    .map(match => match[1]);

  assert.ok(modules.length > 0);
  for (const module of modules) {
    assert.match(readme, new RegExp(`src/${module}\\.ts`));
  }
});

test('runtime build and public command boundary do not depend on Bun or Happy branding', () => {
  const build = read(path.join(serverRoot, 'scripts', 'build-runtime.cjs'));
  const bin = read(path.join(serverRoot, 'bin', 'idle-server.cjs'));
  const cliServer = read(path.join(cliRoot, 'src', 'commands', 'server.ts'));

  assert.doesNotMatch(build, /spawnSync\(['"]bun['"]/);
  assert.doesNotMatch(bin, /\bhappy\b|happy[-_]/i);
  assert.doesNotMatch(cliServer, /happy-server-self-host|packages\/happy-server|packages\/happy-app/i);

  const compatibilityNamesRemoved = cliServer
    .replaceAll('HAPPY_STATIC_DIR', '')
    .replaceAll('HAPPY_INJECT_HTML_CONFIG', '');
  assert.doesNotMatch(compatibilityNamesRemoved, /\bhappy\b|happy[-_]/i);
});

test('published server launcher runs the runtime in-process without a secret-bearing parent', () => {
  const bin = read(path.join(serverRoot, 'bin', 'idle-server.cjs'));

  assert.match(bin, /import\(pathToFileURL\(/);
  assert.doesNotMatch(bin, /\bspawn\(/);
  assert.doesNotMatch(bin, /node:child_process/);
});

test('published CLI launcher does not retain a long-lived wrapper process', () => {
  const bin = read(path.join(cliRoot, 'bin', 'idle.mjs'));

  assert.match(bin, /import\(/);
  assert.doesNotMatch(bin, /execFileSync/);
  assert.doesNotMatch(bin, /child_process/);
});

test('self-host configuration uses Idle names at every public boundary', () => {
  const standalone = read(path.join(serverRoot, 'sources', 'standalone.ts'));
  const bootSecret = read(path.join(serverRoot, 'sources', 'utils', 'validateBootSecret.ts'));
  const api = read(path.join(serverRoot, 'sources', 'app', 'api', 'api.ts'));
  const inlineConfig = read(path.join(serverRoot, 'sources', 'app', 'api', 'inlineConfig.ts'));
  const serverConfig = read(path.join(repoRoot, 'packages', 'idle-app', 'sources', 'sync', 'serverConfig.ts'));

  assert.match(standalone, /consumeBootSecret/);
  assert.match(bootSecret, /IDLE_MASTER_SECRET/);
  assert.match(bootSecret, /IDLE_MASTER_SECRET_FILE/);
  assert.doesNotMatch(standalone, /HANDY_MASTER_SECRET/);
  assert.match(standalone, /process\.env\.IDLE_STATIC_DIR/);
  assert.match(standalone, /process\.env\.IDLE_INJECT_HTML_CONFIG/);
  assert.doesNotMatch(standalone, /["']happy-server(?:\.exe)?["']/i);
  assert.match(api, /createInlineConfigScript/);
  assert.match(inlineConfig, /window\.__IDLE_CONFIG__/);
  assert.match(serverConfig, /__IDLE_CONFIG__\?\.serverUrl/);
});

test('retired AI-provider credentials are removed from the runtime and upgrade path', () => {
  const schema = read(path.join(serverRoot, 'prisma', 'schema.prisma'));
  const connectRoutes = read(path.join(serverRoot, 'sources', 'app', 'api', 'routes', 'connectRoutes.ts'));
  const accountRoutes = read(path.join(serverRoot, 'sources', 'app', 'api', 'routes', 'accountRoutes.ts'));
  const apiDocs = read(path.join(repoRoot, 'docs', 'api.md'));
  const retirementMigration = read(path.join(
    serverRoot,
    'prisma',
    'migrations',
    '20260713060000_drop_service_account_tokens',
    'migration.sql',
  ));

  assert.doesNotMatch(schema, /\bServiceAccountToken\b/);
  assert.doesNotMatch(connectRoutes, /serviceAccountToken|\/v1\/connect\/:vendor/);
  assert.doesNotMatch(accountRoutes, /serviceAccountToken|connectedServices/);
  assert.doesNotMatch(apiDocs, /\/v1\/connect\/:vendor|\/v1\/connect\/tokens/);
  assert.match(retirementMigration, /^DROP TABLE IF EXISTS "ServiceAccountToken";$/m);
});

test('nested package inspection materializes tarballs during an outer npm dry-run', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-package-dry-run-contract-'));
  const previousDryRun = process.env.npm_config_dry_run;
  const previousUpperDryRun = process.env.NPM_CONFIG_DRY_RUN;
  t.after(() => {
    if (previousDryRun === undefined) {
      delete process.env.npm_config_dry_run;
    } else {
      process.env.npm_config_dry_run = previousDryRun;
    }
    if (previousUpperDryRun === undefined) {
      delete process.env.NPM_CONFIG_DRY_RUN;
    } else {
      process.env.NPM_CONFIG_DRY_RUN = previousUpperDryRun;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  process.env.npm_config_dry_run = 'true';
  process.env.NPM_CONFIG_DRY_RUN = 'true';
  const wire = await packAndExtract(wireRoot, tempRoot, 'wire');
  assert.ok(wire.files.includes('package.json'));
});

test('actual npm tarballs contain licenses and no private build artifacts', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-package-contract-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const server = await packAndExtract(serverRoot, tempRoot, 'server');
  const agent = await packAndExtract(agentRoot, tempRoot, 'agent');
  const cli = await packAndExtract(cliRoot, tempRoot, 'cli');
  const wire = await packAndExtract(wireRoot, tempRoot, 'wire');

  assert.ok(
    cli.files.includes('scripts/claude_local_launcher.cjs'),
    'CLI tarball must include the Claude launcher used by the installed help and runtime paths',
  );
  assert.ok(
    cli.files.includes('scripts/claude_version_utils.cjs'),
    'CLI tarball must include the version/path helper required by the Claude launcher',
  );

  assertOnlyAllowedPaths(server.files, [
    'LICENSE',
    'README.md',
    'bin/idle-server.cjs',
    'dist/standalone.mjs',
    'index.cjs',
    'package.json',
    /^prisma\/migrations\/(?:[^/]+\/migration\.sql|migration_lock\.toml)$/,
    'prisma/schema.prisma',
    'scripts/generate-prisma.cjs',
  ], 'server');
  assertOnlyAllowedPaths(agent.files, [
    'LICENSE',
    'README.md',
    'bin/idle-agent.mjs',
    /^dist\/[^/]+$/,
    'package.json',
  ], 'agent');
  assertOnlyAllowedPaths(cli.files, [
    'LICENSE',
    'README.md',
    'bin/idle.mjs',
    'bin/idle-mcp.mjs',
    /^dist\/[^/]+$/,
    /^dist\/codex\/[^/]+$/,
    'package.json',
    'scripts/claude_local_launcher.cjs',
    'scripts/claude_version_utils.cjs',
    'scripts/ripgrep_launcher.cjs',
  ], 'cli');
  assert.deepEqual(
    cli.files.filter(file =>
      file.startsWith('tools/')
      || /(?:download|unpack)-tools/.test(file)
      || /\.(?:tar\.gz|tgz|zip)$/i.test(file),
    ),
    [],
    'CLI tarball must not embed native archives or retired tool installers',
  );
  assertOnlyAllowedPaths(wire.files, [
    'LICENSE',
    'README.md',
    /^dist\/[^/]+$/,
    'package.json',
  ], 'wire');

  assertPackedScriptDependencies(cli, 'CLI');

  for (const [label, packed] of [['server', server], ['agent', agent], ['cli', cli], ['wire', wire]]) {
    assert.ok(packed.files.includes('LICENSE'), `${label} tarball must contain LICENSE`);
    const license = read(path.join(packed.root, 'LICENSE'));
    assert.match(license, /^MIT License/m);
    assert.ok(license.includes(upstreamLicenseNotice));
    assert.match(license, /Copyright \(c\) 2026 Northglass LLC/);
    const forbiddenPaths = packed.files.filter(file =>
      /(^|\/)(?:\.env(?:\.|$)|__tests__|tests?|internal|adrs?)(?:\/|$)/i.test(file)
      || /\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file)
      || /(^|\/)sources\//i.test(file)
      || /\.map$/i.test(file),
    );
    assert.deepEqual(forbiddenPaths, [], `${label} tarball leaked private paths`);

    const text = readPackedTextFiles(packed);
    assert.doesNotMatch(text, /[A-Z0-9._%+-]+@gmail\.com/i);
    assert.doesNotMatch(text, /\/Users\/[^/\s]+\/|\/home\/runner\/work\/|[A-Za-z]:\\Users\\/);
    assert.doesNotMatch(text, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
    assert.doesNotMatch(text, /github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(text, /(?:client[_-]?secret|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/i);
  }

  assert.doesNotMatch(readPackedTextFiles(server), /(?:from\s+|require\()["']@northglass\/idle-wire/);
  assert.doesNotMatch(readPackedTextFiles(cli), /(?:from\s+|require\()["']@northglass\/idle-wire/);

  let agentText = readPackedTextFiles(agent);
  for (const protocolCompatibilityToken of [upstreamLicenseNotice, 'Happy EnCoder', 'X-Happy-Client']) {
    agentText = agentText.replaceAll(protocolCompatibilityToken, '');
  }
  assert.doesNotMatch(agentText, /\bhappy\b|happy[-_]|\bhandy\b/i);

  let serverText = readPackedTextFiles(server);
  for (const compatibilityToken of [
    upstreamLicenseNotice,
    'HAPPY_STATIC_DIR',
    'HAPPY_INJECT_HTML_CONFIG',
    'X-Happy-Client',
    'x-happy-client',
    'happyClient',
  ]) {
    serverText = serverText.replaceAll(compatibilityToken, '');
  }
  assert.doesNotMatch(serverText, /\bhappy\b|happy[-_]|\bhandy\b/i);
});
