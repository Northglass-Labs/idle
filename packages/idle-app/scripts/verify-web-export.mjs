#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { inspectScriptTags } from './script-tag-boundary.mjs';
import { findUnexpectedUpstreamMarkers } from './web-export-upstream-boundary.mjs';

const exportDirectory = path.resolve(process.cwd(), process.argv[2] ?? 'dist');
const problems = [];

function read(relativePath) {
  const absolutePath = path.join(exportDirectory, relativePath);
  if (!fs.existsSync(absolutePath)) {
    problems.push(`missing ${relativePath}`);
    return null;
  }
  return fs.readFileSync(absolutePath);
}

function expect(condition, message) {
  if (!condition) problems.push(message);
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolutePath));
    else files.push(absolutePath);
  }
  return files;
}

function pngDimensions(relativePath) {
  const contents = read(relativePath);
  if (!contents) return null;
  if (
    contents.length < 24
    || contents.subarray(1, 4).toString('ascii') !== 'PNG'
  ) {
    problems.push(`${relativePath} is not a valid PNG`);
    return null;
  }
  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}

const htmlContents = read('index.html');
if (htmlContents) {
  const html = htmlContents.toString('utf8');
  expect(
    /<link\b(?=[^>]*\brel=["']manifest["'])(?=[^>]*\bhref=["']\/manifest\.json["'])[^>]*>/i.test(html),
    'index.html is missing the Idle manifest link',
  );
  expect(
    /<meta\b(?=[^>]*\bname=["']theme-color["'])(?=[^>]*\bcontent=["']#080808["'])[^>]*>/i.test(html),
    'index.html is missing the Idle theme color',
  );
  expect(/<div\b[^>]*\bid=["']root["'][^>]*>/i.test(html), 'index.html is missing the Expo root');

  const scriptInspection = inspectScriptTags(html);
  expect(scriptInspection.valid, 'index.html contains a malformed or unclosed script element');
  expect(scriptInspection.tags.length > 0, 'index.html does not load an application script');
  for (const scriptTag of scriptInspection.tags) {
    expect(scriptTag.hasSource, 'index.html contains an inline script blocked by the release CSP');
    expect(!scriptTag.isModule, 'Expo SPA scripts unexpectedly changed to module scripts; review the export validator');
  }
}

const manifestContents = read('manifest.json');
if (manifestContents) {
  try {
    const manifest = JSON.parse(manifestContents.toString('utf8'));
    expect(manifest.name === 'Idle', 'manifest name must be Idle');
    expect(manifest.short_name === 'Idle', 'manifest short_name must be Idle');
    expect(manifest.id === '/', 'manifest id must be /');
    expect(manifest.start_url === '/', 'manifest start_url must be /');
    expect(manifest.scope === '/', 'manifest scope must be /');
    expect(manifest.display === 'standalone', 'manifest display must be standalone');
    expect(manifest.background_color === '#080808', 'manifest background color must match Idle');
    expect(manifest.theme_color === '#080808', 'manifest theme color must match Idle');

    const expectedIcons = [192, 512];
    for (const size of expectedIcons) {
      const icon = Array.isArray(manifest.icons)
        ? manifest.icons.find(candidate => candidate?.src === `/pwa-icon-${size}.png`)
        : null;
      expect(
        icon?.sizes === `${size}x${size}`
          && icon?.type === 'image/png'
          && icon?.purpose === 'any',
        `manifest icon ${size} metadata is invalid`,
      );
    }
  } catch (error) {
    problems.push(`manifest.json is invalid JSON: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

for (const size of [192, 512]) {
  const dimensions = pngDimensions(`pwa-icon-${size}.png`);
  expect(
    dimensions?.width === size && dimensions?.height === size,
    `pwa-icon-${size}.png must be ${size}x${size}`,
  );
}

const javascriptFiles = listFiles(exportDirectory).filter(file => file.endsWith('.js'));
expect(javascriptFiles.length > 0, 'export does not contain JavaScript bundles');

const forbiddenBundleMarkers = [
  {
    pattern: /["']\.\/[^"'\r\n]+\.(?:test|spec)\.[cm]?[jt]sx?["']/i,
    message: 'Expo route context includes a test module',
  },
  {
    // Some production libraries check VITEST_WORKER_ID alongside JEST_WORKER_ID
    // without shipping a test runner. Reject markers that belong to the runner
    // itself instead of treating that harmless environment probe as a finding.
    pattern: /@vitest\/|\bVITEST_PENDING\b|\b__VITEST_|\bTestRunAbortError\b/,
    message: 'production bundle includes the Vitest runtime',
  },
  {
    pattern: /settingsPublicHygiene\.test/,
    message: 'production bundle includes the public-hygiene test',
  },
  {
    pattern: /\bimport\.meta\b/,
    message: 'classic-script production bundle contains import.meta',
  },
];

for (const file of javascriptFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of forbiddenBundleMarkers) {
    if (marker.pattern.test(source)) {
      problems.push(`${marker.message} (${path.relative(exportDirectory, file)})`);
    }
  }
  if (findUnexpectedUpstreamMarkers(source).length > 0) {
    problems.push(`production bundle contains an unreviewed upstream marker (${path.relative(exportDirectory, file)})`);
  }
}

if (problems.length > 0) {
  throw new Error(`Unsafe web export:\n- ${[...new Set(problems)].join('\n- ')}`);
}

console.log(`Verified Idle web export (${javascriptFiles.length} JavaScript bundles).`);
