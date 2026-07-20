import { describe, expect, it } from 'vitest';
import {
  assertSafeOpenClawGatewayUrl,
  canUseAutoDetectedOpenClawToken,
  normalizeOpenClawGatewayOrigin,
} from './openclawGateway';
import { OpenClawSocket } from './OpenClawSocket';

describe('OpenClaw gateway trust boundary', () => {
  it.each([
    'wss://gateway.example/socket',
    'ws://localhost:18789',
    'ws://127.0.0.42:18789',
    'ws://[::1]:18789',
  ])('accepts secure remote or loopback-only plaintext endpoints: %s', (url) => {
    expect(() => assertSafeOpenClawGatewayUrl(url)).not.toThrow();
  });

  it.each([
    'ws://192.168.1.10:18789',
    'ws://10.0.0.5:18789',
    'ws://gateway.example/socket',
    'http://gateway.example/socket',
    'file:///tmp/openclaw.sock',
    'wss://operator:secret@gateway.example/socket',
  ])('rejects an unsafe gateway endpoint: %s', (url) => {
    expect(() => assertSafeOpenClawGatewayUrl(url)).toThrow(/OpenClaw gateway/i);
  });

  it('normalizes default ports, host casing, and paths to one credential origin', () => {
    expect(normalizeOpenClawGatewayOrigin('wss://Gateway.Example:443/api')).toBe('wss://gateway.example');
    expect(normalizeOpenClawGatewayOrigin('ws://LOCALHOST:80/socket')).toBe('ws://localhost');
  });

  it('enforces the transport boundary in the socket before opening a connection', () => {
    const socket = new OpenClawSocket({ homeDir: '/tmp/idle-openclaw-url-test' });
    expect(() => socket.connect({ url: 'ws://192.168.1.10:18789', token: 'do-not-send' })).toThrow(
      /requires wss/i,
    );
    socket.dispose();
  });

  it('uses an auto-detected token only for the same normalized gateway origin', () => {
    expect(canUseAutoDetectedOpenClawToken('wss://gateway.example/chat', 'wss://GATEWAY.example:443/status')).toBe(true);
    expect(canUseAutoDetectedOpenClawToken('wss://other.example/chat', 'wss://gateway.example/status')).toBe(false);
    expect(canUseAutoDetectedOpenClawToken('wss://gateway.example/chat', 'ws://192.168.1.10:18789')).toBe(false);
  });
});
