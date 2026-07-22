import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(
  new URL('../../../Dockerfile.webapp', import.meta.url),
  'utf8',
);

describe('web image dependency sanitization', () => {
  it('applies every reviewed dependency transform after install and before export', () => {
    const installIndex = dockerfile.indexOf('RUN yarn install --frozen-lockfile --non-interactive');
    const dependencyPatchIndex = dockerfile.indexOf('RUN node patches/force-elevenlabs-livekit-v0.cjs');
    const exportIndex = dockerfile.indexOf('RUN yarn expo export --platform web --output-dir dist');

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(dependencyPatchIndex).toBeGreaterThan(installIndex);
    expect(exportIndex).toBeGreaterThan(dependencyPatchIndex);

    for (const patchName of [
      'force-elevenlabs-livekit-v0.cjs',
      'sanitize-shiki-hack-opsec.cjs',
      'sanitize-react-native-url-polyfill-opsec.cjs',
      'sanitize-skia-reanimated-metadata-opsec.cjs',
    ]) {
      expect(dockerfile).toContain(`node patches/${patchName}`);
    }
  });
});
