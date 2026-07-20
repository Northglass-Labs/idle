import { describe, expect, it } from 'vitest';
import { buildAgentChildEnvironment } from './agentChildEnvironment';

describe('buildAgentChildEnvironment', () => {
  const hostEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/example',
    LANG: 'en_US.UTF-8',
    HTTPS_PROXY: 'http://127.0.0.1:8080',
    IDLE_ADMIN_SECRET: 'idle-secret',
    GITHUB_TOKEN: 'github-secret',
    NPM_TOKEN: 'npm-secret',
    NODE_OPTIONS: '--require /tmp/inject.js',
    ANTHROPIC_API_KEY: 'anthropic-key',
    GEMINI_API_KEY: 'gemini-key',
    GOOGLE_API_KEY: 'google-key',
  };

  it('gives generic ACP agents only operational environment by default', () => {
    const environment = buildAgentChildEnvironment('acp', hostEnvironment);

    expect(environment).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/example',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
    });
    expect(environment).not.toHaveProperty('IDLE_ADMIN_SECRET');
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('NPM_TOKEN');
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(environment).not.toHaveProperty('GEMINI_API_KEY');
  });

  it('keeps only provider-scoped host credentials for Claude and Gemini', () => {
    const claudeEnvironment = buildAgentChildEnvironment('claude', hostEnvironment);
    const geminiEnvironment = buildAgentChildEnvironment('gemini', hostEnvironment);

    expect(claudeEnvironment.ANTHROPIC_API_KEY).toBe('anthropic-key');
    expect(claudeEnvironment).not.toHaveProperty('GEMINI_API_KEY');
    expect(claudeEnvironment).not.toHaveProperty('GITHUB_TOKEN');

    expect(geminiEnvironment.GEMINI_API_KEY).toBe('gemini-key');
    expect(geminiEnvironment.GOOGLE_API_KEY).toBe('google-key');
    expect(geminiEnvironment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(geminiEnvironment).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('preserves explicitly supplied per-session variables without mutating the host map', () => {
    const explicitEnvironment = {
      CUSTOM_PROVIDER_TOKEN: 'explicit-token',
      ANTHROPIC_BASE_URL: 'https://provider.example',
    };

    const environment = buildAgentChildEnvironment(
      'claude',
      hostEnvironment,
      explicitEnvironment,
    );

    expect(environment.CUSTOM_PROVIDER_TOKEN).toBe('explicit-token');
    expect(environment.ANTHROPIC_BASE_URL).toBe('https://provider.example');
    expect(hostEnvironment).not.toHaveProperty('CUSTOM_PROVIDER_TOKEN');
  });
});
