import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const readJson = relativePath => JSON.parse(read(relativePath));

function listFiles(relativeDirectory) {
  const directory = path.join(repoRoot, relativeDirectory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(relativePath));
    else files.push(relativePath);
  }
  return files;
}

function readPngSize(relativePath) {
  const png = fs.readFileSync(path.join(repoRoot, relativePath));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${relativePath} must be a PNG`);
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

test('Docker build contexts exclude local credentials and maintainer-only state', () => {
  const dockerignore = new Set(
    read('.dockerignore')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')),
  );
  const required = [
    '.env*',
    '**/.env*',
    'credentials.json',
    '**/credentials.json',
    '.npmrc',
    '**/.npmrc',
    '.yarnrc',
    '**/.yarnrc',
    '.yarnrc.yml',
    '**/.yarnrc.yml',
    '.netrc',
    '**/.netrc',
    '.pypirc',
    '**/.pypirc',
    '*.key',
    '*.pem',
    '*.p8',
    '*.p12',
    '*.jks',
    '*.mobileprovision',
    'environments/data',
    '.environments',
    '.idle-dev',
    '.idle-fully-local',
    '.agents',
    '**/.agents',
    '.codex',
    '**/.codex',
    '.claude',
    '**/.claude',
    'AGENTS.md',
    '**/AGENTS.md',
    'CLAUDE.md',
    '**/CLAUDE.md',
    '.mcp.json',
    '**/.mcp.json',
    '.worktrees',
    'notes',
    'docs/adr',
    'docs/plans',
    '*.log',
    '*.sqlite*',
    '*.jsonl',
  ];

  for (const pattern of required) {
    assert.ok(dockerignore.has(pattern), `missing Docker context exclusion: ${pattern}`);
  }
});

test('the canonical relay image runs the Node 22 build as an unprivileged user', () => {
  const dockerfile = read('Dockerfile');

  assert.match(dockerfile, /^FROM node:22(?:-|\s)/m);
  assert.match(dockerfile, /^FROM node:22-trixie-slim@sha256:[0-9a-f]{64} AS runner$/m);
  assert.doesNotMatch(dockerfile, /^FROM node:(?:18|20)(?:-|\s)/m);
  assert.doesNotMatch(dockerfile, /--ignore-engines/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^RUN install -d -m 0700 -o node -g node \/data$/m);
  assert.match(dockerfile, /delete p\.devDependencies/);
  assert.match(dockerfile, /--production --non-interactive --ignore-scripts/);
  assert.match(dockerfile, /COPY --from=builder \/build\/node_modules\/\.prisma \/runtime\/node_modules\/\.prisma/);
  assert.match(dockerfile, /^FROM node:22-trixie-slim@sha256:[0-9a-f]{64} AS wire-builder$/m);
  assert.ok(
    dockerfile.match(/^FROM /gm)?.every((_, index) => dockerfile.split('\n').filter(line => line.startsWith('FROM '))[index].includes('@sha256:')),
    'every relay base image must be digest-pinned',
  );
  assert.match(dockerfile, /COPY package\.json \/workspace-package\.json/);
  assert.match(dockerfile, /p\.resolutions=\{\.\.\.root\.resolutions,\.\.\.p\.resolutions\}/);
  assert.match(dockerfile, /COPY --from=wire-builder \/wire\/dist \/build\/node_modules\/@northglass\/idle-wire\/dist/);
  assert.match(dockerfile, /^COPY --from=builder \/build\/dist \/repo\/packages\/idle-server\/dist$/m);
  assert.match(dockerfile, /^COPY --from=builder \/build\/prisma \/repo\/packages\/idle-server\/prisma$/m);
  assert.doesNotMatch(dockerfile, /COPY --from=builder --chown=node:node/);
  assert.match(
    dockerfile,
    /^RUN chmod -R a-w \/repo\/packages\/idle-server\/dist \/repo\/packages\/idle-server\/prisma$/m,
  );
  assert.doesNotMatch(dockerfile, /COPY packages\/(?:idle-app|idle-cli|idle-agent)/);
  assert.doesNotMatch(dockerfile, /fix-pglite-prisma-bytes/);
  assert.doesNotMatch(dockerfile, /apt-get install[\s\S]*\b(?:curl|ffmpeg)\b/);
  assert.match(
    dockerfile,
    /^RUN apt-get update && apt-get install -y --no-install-recommends openssl \\\n\s+&& rm -rf \/var\/lib\/apt\/lists\/\*$/m,
  );
  assert.match(dockerfile, /RUN rm -rf \/usr\/local\/lib\/node_modules\/npm[\s\S]*\/opt\/yarn-v1\.22\.22/);
  assert.match(dockerfile, /rm -f \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx \/usr\/local\/bin\/yarn \/usr\/local\/bin\/yarnpkg \/usr\/local\/bin\/corepack/);
  assert.match(dockerfile, /^HEALTHCHECK .*CMD \["node", "-e", "fetch\('http:\/\/127\.0\.0\.1:3005\/health'\)/m);
  assert.doesNotMatch(dockerfile, /^HEALTHCHECK .*curl/m);
  assert.match(
    dockerfile,
    /^CMD \["sh", "-c", "node \.\/dist\/standalone\.mjs migrate && exec node \.\/dist\/standalone\.mjs serve"\]$/m,
  );
  assert.doesNotMatch(dockerfile, /(?:tsx|sources\/standalone\.ts)/);
});

test('the duplicate relay image is removed and has no live references', () => {
  const duplicateName = ['Dockerfile', 'server'].join('.');
  assert.equal(fs.existsSync(path.join(repoRoot, duplicateName)), false);

  const liveFiles = [
    'docker-compose.yml',
    'fly.toml',
    'railway.json',
    'render.yaml',
    'docs/SELF-HOSTING.md',
    'docs/deploy-targets/fly.md',
    'docs/deploy-targets/railway.md',
    'docs/deploy-targets/render.md',
  ];
  for (const relativePath of liveFiles) {
    assert.doesNotMatch(read(relativePath), new RegExp(duplicateName.replace('.', '\\.')));
  }
});

test('the web image is Node 22, unprivileged, and receives the configured relay URL', () => {
  const dockerfile = read('Dockerfile.webapp');
  const compose = read('docker-compose.yml');
  const deployWorkflow = read('.github/workflows/deploy-webapp.yml');
  const runtimeConfigPath = path.join(repoRoot, 'nginx.webapp.runtime.conf');

  assert.match(dockerfile, /^FROM node:22-alpine@sha256:[0-9a-f]{64} AS builder$/m);
  assert.match(dockerfile, /^FROM node:22-alpine@sha256:[0-9a-f]{64} AS wire-builder$/m);
  assert.match(dockerfile, /^FROM nginx:alpine-slim@sha256:[0-9a-f]{64} AS runner$/m);
  assert.ok(
    dockerfile.match(/^FROM /gm)?.every((_, index) => dockerfile.split('\n').filter(line => line.startsWith('FROM '))[index].includes('@sha256:')),
    'every web base image must be digest-pinned',
  );
  assert.match(dockerfile, /COPY package\.json \/workspace-package\.json/);
  assert.match(dockerfile, /p\.resolutions=\{\.\.\.root\.resolutions,\.\.\.p\.resolutions\}/);
  assert.doesNotMatch(dockerfile, /--ignore-engines/);
  assert.doesNotMatch(dockerfile, /HAPPY_BUILD|happy[-_]/i);
  assert.doesNotMatch(dockerfile, /COPY packages\/(?:idle-server|idle-cli|idle-agent)/);
  assert.match(dockerfile, /COPY --from=wire-builder \/wire\/dist \/app\/node_modules\/@northglass\/idle-wire\/dist/);
  const installIndex = dockerfile.indexOf('RUN yarn install --frozen-lockfile --non-interactive');
  const dependencyPatchIndex = dockerfile.indexOf('RUN node patches/force-elevenlabs-livekit-v0.cjs');
  const exportIndex = dockerfile.indexOf('RUN yarn expo export --platform web --output-dir dist');
  assert.ok(
    installIndex >= 0 && dependencyPatchIndex > installIndex && exportIndex > dependencyPatchIndex,
    'the isolated web install must apply reviewed dependency patches before export',
  );
  for (const patchName of [
    'force-elevenlabs-livekit-v0.cjs',
    'sanitize-shiki-hack-opsec.cjs',
    'sanitize-react-native-url-polyfill-opsec.cjs',
    'sanitize-skia-reanimated-metadata-opsec.cjs',
  ]) {
    assert.ok(
      dockerfile.includes(`node patches/${patchName}`),
      `the isolated web install must apply ${patchName}`,
    );
  }
  assert.match(dockerfile, /^ARG EXPO_PUBLIC_POSTHOG_API_KEY=""$/m);
  assert.match(dockerfile, /^ARG EXPO_PUBLIC_IDLE_SERVER_URL=""$/m);
  assert.match(
    dockerfile,
    /RUN yarn expo export --platform web --output-dir dist\s+\\\s+&& node scripts\/verify-web-export\.mjs dist/,
  );
  assert.match(dockerfile, /^USER nginx$/m);
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.ok(fs.existsSync(runtimeConfigPath), 'the non-root Nginx runtime config must be committed');
  const runtimeConfig = fs.readFileSync(runtimeConfigPath, 'utf8');
  assert.match(dockerfile, /^COPY nginx\.webapp\.runtime\.conf \/etc\/nginx\/nginx\.conf$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["nginx"\]$/m);
  assert.match(dockerfile, /^CMD \["-g", "daemon off;"\]$/m);
  assert.doesNotMatch(dockerfile, /\/var\/run\/nginx\.pid/);
  assert.doesNotMatch(dockerfile, /chown -R nginx:nginx [^\n]*\/var\/cache\/nginx/);
  assert.doesNotMatch(dockerfile, /chown -R nginx:nginx [^\n]*\/usr\/share\/nginx\/html/);
  assert.match(dockerfile, /^RUN chmod -R a-w \/usr\/share\/nginx\/html$/m);
  assert.match(runtimeConfig, /^pid \/tmp\/nginx\.pid;$/m);
  for (const temporaryPath of [
    'client_body_temp_path /tmp/nginx-client;',
    'proxy_temp_path /tmp/nginx-proxy;',
    'fastcgi_temp_path /tmp/nginx-fastcgi;',
    'uwsgi_temp_path /tmp/nginx-uwsgi;',
    'scgi_temp_path /tmp/nginx-scgi;',
  ]) {
    assert.match(runtimeConfig, new RegExp(`^\\s*${temporaryPath}$`, 'm'));
  }
  assert.doesNotMatch(runtimeConfig, /^user\s/m);
  assert.doesNotMatch(deployWorkflow, /\/var\/cache\/nginx/);
  assert.match(deployWorkflow, /--tmpfs \/tmp:rw,noexec,nosuid,nodev,mode=1777/);
  assert.match(compose, /^\s+EXPO_PUBLIC_IDLE_SERVER_URL: \$\{EXPO_PUBLIC_IDLE_SERVER_URL:-http:\/\/localhost:3005\}$/m);
  assert.match(compose, /^\s+- "127\.0\.0\.1:8080:8080"$/m);
});

test('the exported web app has an installable manifest backed by Idle brand assets', () => {
  const manifest = readJson('packages/idle-app/public/manifest.json');
  const htmlTemplate = read('packages/idle-app/public/index.html');
  const htmlRoot = read('packages/idle-app/sources/app/+html.tsx');

  assert.equal(manifest.name, 'Idle');
  assert.equal(manifest.short_name, 'Idle');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#080808');
  assert.equal(manifest.theme_color, '#080808');
  assert.match(htmlRoot, /<link rel="manifest" href="\/manifest\.json" \/>/);
  assert.match(htmlRoot, /<meta name="theme-color" content="#080808" \/>/);
  assert.match(htmlTemplate, /<link rel="manifest" href="\/manifest\.json" \/>/);
  assert.match(htmlTemplate, /<meta name="theme-color" content="#080808" \/>/);

  const requiredIcons = new Map([
    ['/pwa-icon-192.png', 192],
    ['/pwa-icon-512.png', 512],
  ]);
  assert.ok(Array.isArray(manifest.icons));
  for (const [src, size] of requiredIcons) {
    const icon = manifest.icons.find(candidate => candidate.src === src);
    assert.deepEqual(icon, {
      src,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any',
    });
    assert.deepEqual(
      readPngSize(`packages/idle-app/public/${src.slice(1)}`),
      { width: size, height: size },
    );
  }
});

test('the Expo Router tree contains routes, not executable test modules', () => {
  const routeTests = listFiles('packages/idle-app/sources/app')
    .filter(relativePath => /\.(?:test|spec)\.[jt]sx?$/.test(relativePath));

  assert.deepEqual(routeTests, []);
});

test('the production web boundary sends a restrictive security-header baseline', () => {
  const dockerfile = read('Dockerfile.webapp');
  const nginx = read('nginx.webapp.conf');

  assert.match(dockerfile, /^COPY nginx\.webapp\.conf \/etc\/nginx\/conf\.d\/default\.conf$/m);
  assert.match(nginx, /^\s*server_tokens off;$/m);
  assert.match(nginx, /add_header Content-Security-Policy "/);
  assert.match(nginx, /default-src 'self'/);
  assert.match(nginx, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(nginx, /script-src[^;]*'unsafe-eval'/);
  assert.match(nginx, /style-src 'self' 'unsafe-inline'/);
  assert.match(nginx, /connect-src 'self' https: wss:/);
  assert.match(nginx, /http:\/\/localhost:\*/);
  assert.match(nginx, /ws:\/\/localhost:\*/);
  assert.match(nginx, /frame-ancestors 'none'/);
  assert.match(nginx, /object-src 'none'/);
  assert.match(nginx, /base-uri 'self'/);
  assert.match(nginx, /form-action 'self'/);
  assert.doesNotMatch(nginx, /default-src (?:\*|https?:|data:|blob:)/);
  assert.match(nginx, /add_header X-Content-Type-Options "nosniff" always;/);
  assert.match(nginx, /add_header X-Frame-Options "DENY" always;/);
  assert.match(nginx, /add_header Referrer-Policy "no-referrer" always;/);
  assert.match(
    nginx,
    /add_header Permissions-Policy "camera=\(self\), microphone=\(self\), payment=\(self \\"https:\/\/js\.stripe\.com\\" \\"https:\/\/hooks\.stripe\.com\\" \\"https:\/\/buy\.paddle\.com\\" \\"https:\/\/sandbox-buy\.paddle\.com\\"\)" always;/,
  );
  assert.match(
    nginx,
    /add_header Strict-Transport-Security "max-age=31536000" always;/,
  );
  assert.match(nginx, /location \/_expo\/ \{[\s\S]*?try_files \$uri =404;/);
  assert.doesNotMatch(nginx, /error_page 404/);
});

test('the production web CSP does not trust the native Mermaid CDN', () => {
  const nginx = read('nginx.webapp.conf');
  const renderer = read('packages/idle-app/sources/components/markdown/MermaidRenderer.tsx');
  const nativeDocument = read('packages/idle-app/sources/components/markdown/buildMermaidWebViewHtml.ts');

  assert.doesNotMatch(nginx, /(?:cdn|fastly)\.jsdelivr\.net/);
  assert.match(renderer, /Platform\.OS === 'web'[\s\S]*?import\('mermaid'\)/);
  assert.match(nativeDocument, /https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.16\.0\/dist\/mermaid\.min\.js/);
  assert.match(nativeDocument, /integrity="sha384-[A-Za-z0-9+/=]+"/);
  assert.match(nativeDocument, /worker-src 'none'/);
});

test('production web access logs retain metrics without request or client identifiers', () => {
  const nginx = read('nginx.webapp.conf');
  const logFormat = nginx.match(/^log_format idle_release '([^']+)';$/m);

  assert.ok(logFormat, 'missing the privacy-preserving web access log format');
  assert.equal(logFormat[1], '$request_method $status $body_bytes_sent $request_time');
  assert.match(nginx, /^\s*access_log \/dev\/stdout idle_release;$/m);

  const loggedVariables = new Set(logFormat[1].match(/\$[a-z0-9_]+/gi) ?? []);
  const prohibitedVariables = [
    '$remote_addr',
    '$remote_user',
    '$request',
    '$request_uri',
    '$uri',
    '$args',
    '$query_string',
    '$http_referer',
    '$http_user_agent',
  ];
  for (const variable of prohibitedVariables) {
    assert.ok(!loggedVariables.has(variable), `${variable} must not enter production web logs`);
  }
});

test('the local Compose stack publishes HTTP services on loopback only', () => {
  const compose = read('docker-compose.yml');

  assert.match(compose, /^\s+- "127\.0\.0\.1:3005:3005"$/m);
  assert.match(compose, /^\s+- "127\.0\.0\.1:8080:8080"$/m);
  assert.doesNotMatch(compose, /^\s+- "(?:3005:3005|8080:8080)"$/m);
});

test('Compose runs both services with read-only roots and explicit writable runtime mounts', () => {
  const compose = read('docker-compose.yml');
  const server = compose.match(/^\s{2}idle-server:\n([\s\S]*?)(?=^\s{2}idle-webapp:)/m)?.[1] ?? '';
  const web = compose.match(/^\s{2}idle-webapp:\n([\s\S]*?)(?=^volumes:)/m)?.[1] ?? '';

  assert.match(server, /^\s{4}read_only: true$/m);
  assert.match(server, /^\s{4}tmpfs:\s*\n\s{6}- \/tmp:rw,noexec,nosuid,nodev$/m);
  assert.match(web, /^\s{4}read_only: true$/m);
  assert.match(
    web,
    /^\s{4}tmpfs:\s*\n\s{6}- \/tmp:rw,noexec,nosuid,nodev,mode=1777$/m,
  );
  assert.doesNotMatch(web, /\/var\/cache\/nginx/);
});

test('Compose mounts a caller-environment secret without persisting it in a dot-env file', () => {
  const compose = read('docker-compose.yml');
  const quickStart = compose.split(/^services:/m, 1)[0];

  assert.match(compose, /^secrets:\s*\n\s+idle_master_secret:\s*\n\s+environment: IDLE_MASTER_SECRET$/m);
  assert.match(compose, /^\s+IDLE_MASTER_SECRET_FILE: \/run\/secrets\/idle_master_secret$/m);
  assert.match(
    compose,
    /^\s+- source: idle_master_secret\s*\n\s+target: idle_master_secret\s*\n\s+uid: "1000"\s*\n\s+gid: "1000"\s*\n\s+mode: 0400$/m,
  );
  assert.doesNotMatch(compose, /^\s+IDLE_MASTER_SECRET:/m);
  assert.doesNotMatch(compose, /--env-file|\.env\.(?:idle|production|dev)|idle-server\.env/i);
  assert.match(quickStart, /stty -echo[\s\S]{0,300}read -r IDLE_MASTER_SECRET/i);
  assert.match(quickStart, /unset IDLE_MASTER_SECRET/i);
});

test('self-host platforms use the canonical built runtime without operator-specific defaults', () => {
  const compose = read('docker-compose.yml');
  const fly = read('fly.toml');
  const railway = JSON.parse(read('railway.json'));
  const buildRuntime = read('packages/idle-server/scripts/build-runtime.cjs');
  const selfHosting = read('docs/SELF-HOSTING.md');

  assert.match(
    compose,
    /test: \["CMD", "node", "-e", "fetch\('http:\/\/127\.0\.0\.1:3005\/health'\)\.then\(response => \{ if \(!response\.ok\) process\.exit\(1\); \}\)\.catch\(\(\) => process\.exit\(1\)\);"\]/,
  );
  assert.doesNotMatch(compose, /test: \["CMD", "curl"/);
  assert.equal(railway.deploy.startCommand, undefined);
  assert.doesNotMatch(fly, /^primary_region\s*=/m);
  assert.doesNotMatch(fly, /verified by|smoke \d{4}-\d{2}-\d{2}/i);
  assert.match(buildRuntime, /target:\s*['"]node22['"]/);
  assert.match(selfHosting, /^npm install -g @northglass\/idle-server$/m);
  assert.match(selfHosting, /^\s*idle-server migrate$/m);
  assert.match(selfHosting, /^\s*idle-server serve$/m);
  assert.doesNotMatch(selfHosting, /(?:dist\/standalone\.mjs|tsx|sources\/)/);
});
