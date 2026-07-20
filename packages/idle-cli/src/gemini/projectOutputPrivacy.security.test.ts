import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Gemini project command output privacy', () => {
  it('never interpolates project or account identifiers into terminal output', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('Google Cloud Project set to: ${projectId}');
    expect(source).not.toContain('Current Google Cloud Project: ${config.googleCloudProject}');
    expect(source).not.toContain('Linked to account: ${config.googleCloudProjectEmail}');
    expect(source).not.toContain('Current Google Cloud Project: ${process.env.GOOGLE_CLOUD_PROJECT}');
    expect(source).not.toContain('Show current Google Cloud Project ID');
    expect(source).not.toContain('Config saved to: ${configPath}');
    expect(source).not.toContain("console.error('Failed to save project configuration:', error)");
    expect(source).not.toContain("console.error('Failed to read project configuration:', error)");
  });
});
