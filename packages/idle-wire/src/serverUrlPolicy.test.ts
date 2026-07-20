import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from './serverUrlPolicy';

function credentialedTestUrl(hostAndPath: string): string {
  const url = new URL(`https://${hostAndPath}`);
  url.username = 'test-user';
  url.password = 'test-password';
  return url.toString();
}

describe('shared credential-bearing server URL policy', () => {
  it.each([
    ['HTTPS://Relay.Example.COM:443/', 'https://relay.example.com'],
    ['https://relay.example.com:8443/', 'https://relay.example.com:8443'],
    ['http://localhost:3005/', 'http://localhost:3005'],
    ['http://dev.localhost:3005', 'http://dev.localhost:3005'],
    ['http://127.42.0.1:3005', 'http://127.42.0.1:3005'],
    ['http://[::1]:3005/', 'http://[::1]:3005'],
  ])('canonicalizes an HTTPS or loopback origin: %s', (raw, expected) => {
    expect(normalizeServerUrl(raw)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'relay.example.com',
    '//relay.example.com',
    'ftp://relay.example.com',
    'http://relay.example.com',
    'http://192.168.1.10:3005',
    'http://[fd00::1]:3005',
    credentialedTestUrl('relay.example.com'),
    'https://relay.example.com/v1',
    'https://relay.example.com/?target=other',
    'https://relay.example.com/#fragment',
    ' https://relay.example.com',
    'https://relay.example.com ',
    `https://${'a'.repeat(2048)}.example.com`,
  ])('rejects an unsafe or non-origin URL: %s', (raw) => {
    expect(() => normalizeServerUrl(raw)).toThrow(/server URL/i);
  });
});
