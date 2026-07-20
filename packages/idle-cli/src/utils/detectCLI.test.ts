import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { buildAugmentedPath, commandExistsOnPath } from './detectCLI';

describe('buildAugmentedPath', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'idle-detect-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prepends ~/.local/bin — where Claude Code native installer puts it — so a reduced daemon PATH still finds claude', () => {
    // Regression: the daemon ran with PATH lacking ~/.local/bin, so
    // `command -v claude` failed and the app hid Claude from the picker.
    const reducedDaemonPath = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
    const result = buildAugmentedPath('/home/example', reducedDaemonPath);
    expect(result.split(':')).toContain('/home/example/.local/bin');
  });

  it('includes every fixed standard user + system bin dir', () => {
    const parts = buildAugmentedPath('/home/example', '').split(':');
    expect(parts).toContain(join('/home/example', '.local', 'bin'));
    expect(parts).toContain(join('/home/example', '.npm-global', 'bin'));
    expect(parts).toContain(join('/home/example', 'bin'));
    expect(parts).toContain(join('/home/example', '.volta', 'bin'));
    expect(parts).toContain(join('/home/example', '.asdf', 'shims'));
    expect(parts).toContain(join('/home/example', '.local', 'share', 'mise', 'shims'));
    expect(parts).toContain(join('/home/example', '.cargo', 'bin'));
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain('/usr/local/bin');
  });

  it('keeps the inherited PATH appended after the standard dirs', () => {
    const result = buildAugmentedPath('/home/example', '/custom/tool/bin');
    expect(result.endsWith('/custom/tool/bin')).toBe(true);
    // standard dirs come first so they are not shadowed by the inherited PATH
    expect(result.indexOf('/home/example/.local/bin')).toBeLessThan(result.indexOf('/custom/tool/bin'));
  });

  it('handles an undefined inherited PATH without a trailing empty entry', () => {
    const parts = buildAugmentedPath('/home/example', undefined).split(':');
    expect(parts.every((p) => p.length > 0)).toBe(true);
  });

  it('handles an empty inherited PATH without a trailing empty entry', () => {
    const parts = buildAugmentedPath('/home/example', '').split(':');
    expect(parts.every((p) => p.length > 0)).toBe(true);
  });

  it('enumerates every installed NVM Node version (~/.nvm/versions/node/<v>/bin)', () => {
    // NVM installs each Node version under its own bin dir — there is no shim
    // dir, so we have to enumerate. Two versions installed:
    mkdirSync(join(tmpHome, '.nvm', 'versions', 'node', 'v20.10.0', 'bin'), { recursive: true });
    mkdirSync(join(tmpHome, '.nvm', 'versions', 'node', 'v22.0.0', 'bin'), { recursive: true });
    const parts = buildAugmentedPath(tmpHome, '').split(':');
    expect(parts).toContain(join(tmpHome, '.nvm', 'versions', 'node', 'v20.10.0', 'bin'));
    expect(parts).toContain(join(tmpHome, '.nvm', 'versions', 'node', 'v22.0.0', 'bin'));
  });

  it('enumerates every installed fnm Node version (~/.fnm/node-versions/<v>/installation/bin)', () => {
    mkdirSync(join(tmpHome, '.fnm', 'node-versions', 'v22.0.0', 'installation', 'bin'), { recursive: true });
    const parts = buildAugmentedPath(tmpHome, '').split(':');
    expect(parts).toContain(join(tmpHome, '.fnm', 'node-versions', 'v22.0.0', 'installation', 'bin'));
  });

  it('omits version-manager paths when no version manager is installed', () => {
    const parts = buildAugmentedPath(tmpHome, '').split(':');
    expect(parts.find((p) => p.includes('.nvm/versions'))).toBeUndefined();
    expect(parts.find((p) => p.includes('.fnm/node-versions'))).toBeUndefined();
  });

  it('looks up only the fixed internal CLI names without invoking a shell', () => {
    const binDir = join(tmpHome, 'bin');
    mkdirSync(binDir, { recursive: true });
    const claude = join(binDir, 'claude');
    writeFileSync(claude, '#!/bin/sh\nexit 0\n');
    chmodSync(claude, 0o755);
    const marker = join(tmpHome, 'shell-injection-marker');

    expect(commandExistsOnPath('claude', binDir, 'linux')).toBe(true);
    expect(commandExistsOnPath(`claude; touch ${marker}`, binDir, 'linux')).toBe(false);
    expect(() => commandExistsOnPath('not-an-idle-provider', binDir, 'linux')).not.toThrow();
    expect(commandExistsOnPath('not-an-idle-provider', binDir, 'linux')).toBe(false);
  });
});
