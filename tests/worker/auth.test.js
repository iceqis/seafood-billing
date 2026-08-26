import { describe, expect, it } from 'vitest';
import {
  TOKEN_TTL_SECONDS,
  issueToken,
  readBearerToken,
  verifyToken
} from '../../worker/auth.js';

const encoder = new TextEncoder();

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(bytes) {
  return encodeBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signedToken(payload, secret) {
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload)));
  return `${encodedPayload}.${encodeBase64Url(signature)}`;
}

describe('shared shop authentication', () => {
  it('issues a 30-day HMAC token with the documented payload structure', async () => {
    const nowMs = 1_800_000;
    const token = await issueToken('test-secret', nowMs);
    const [encodedPayload, signature, extra] = token.split('.');
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));

    expect(TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(extra).toBeUndefined();
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload).toEqual({
      version: 1,
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS
    });
  });

  it('accepts a valid token and returns its validated payload', async () => {
    const token = await issueToken('test-secret', 1_000, 60);

    await expect(verifyToken(token, 'test-secret', 2_000)).resolves.toEqual({
      version: 1,
      iat: 1,
      exp: 61
    });
  });

  it('rejects expired, tampered, and malformed tokens with stable messages', async () => {
    const token = await issueToken('test-secret', 1_000, 1);

    await expect(verifyToken(token, 'test-secret', 3_000)).rejects.toThrow('登录已过期');
    await expect(verifyToken(`${token}x`, 'test-secret', 1_500)).rejects.toThrow('登录凭证无效');
    await expect(verifyToken('not-a-token', 'test-secret', 1_500)).rejects.toThrow('登录凭证无效');
    await expect(verifyToken('***.***', 'test-secret', 1_500)).rejects.toThrow('登录凭证无效');
  });

  it.each([
    [{ version: 2, iat: 1, exp: 61 }],
    [{ version: 1, exp: 61 }],
    [{ version: 1, iat: '1', exp: 61 }],
    [{ version: 1, iat: 1, exp: '61' }],
    [{ version: 1, iat: 61, exp: 61 }]
  ])('rejects a signed token with an invalid payload: %o', async (payload) => {
    const token = await signedToken(payload, 'test-secret');
    await expect(verifyToken(token, 'test-secret', 2_000)).rejects.toThrow('登录凭证无效');
  });

  it('reads only a Bearer authorization scheme', () => {
    expect(readBearerToken(new Request('https://test', {
      headers: { Authorization: 'Bearer signed.token' }
    }))).toBe('signed.token');
    expect(readBearerToken(new Request('https://test', {
      headers: { Authorization: 'bearer lowercase.token' }
    }))).toBe('lowercase.token');
    expect(readBearerToken(new Request('https://test', {
      headers: { Authorization: 'Basic signed.token' }
    }))).toBe('');
    expect(readBearerToken(new Request('https://test', {
      headers: { Authorization: 'signed.token' }
    }))).toBe('');
  });
});
