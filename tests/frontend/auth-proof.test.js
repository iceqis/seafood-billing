import { describe, expect, it, vi } from 'vitest';
import { ChallengeExpiredError, createLoginProof } from '../../assets/js/auth-proof.js';

const challenge = {
  challengeToken: 'cGF5bG9hZA.c2lnbmF0dXJl',
  salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
  iterations: 210000,
  hash: 'SHA-256',
  expiresAt: 2000
};

describe('browser login proof', () => {
  it('derives a stable Base64URL proof without returning the password', async () => {
    const result = await createLoginProof('shared-shop-password', challenge, { nowMs: 1_000_000 });

    expect(result).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result).toBe('Mvp8YBBzKnw5qn3it809_lTlD7WKcGUTGkKEYcoErdI');
    expect(result).not.toContain('shared-shop-password');
  });

  it('rejects an already expired challenge before PBKDF2', async () => {
    const cryptoImpl = { subtle: { importKey: vi.fn() } };

    await expect(createLoginProof('shared-shop-password', challenge, {
      nowMs: 2_001_000,
      cryptoImpl
    })).rejects.toBeInstanceOf(ChallengeExpiredError);
    expect(cryptoImpl.subtle.importKey).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid salt length', { salt: 'c2hvcnQ=' }],
    ['invalid token shape', { challengeToken: 'not-a-token' }],
    ['wrong iterations', { iterations: 1000 }],
    ['wrong hash', { hash: 'SHA-1' }],
    ['non-integer expiration', { expiresAt: 2000.5 }]
  ])('rejects %s with a stable message', async (_name, override) => {
    await expect(createLoginProof('private-input-password', {
      ...challenge,
      ...override
    }, { nowMs: 1_000_000 })).rejects.toThrow('登录挑战无效');
  });

  it('does not expose the password when Web Crypto rejects', async () => {
    const cryptoImpl = {
      subtle: {
        importKey: vi.fn().mockRejectedValue(new Error('low-level failure'))
      }
    };

    let error;
    try {
      await createLoginProof('private-input-password', challenge, {
        nowMs: 1_000_000,
        cryptoImpl
      });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toBe('登录验证失败');
    expect(String(error)).not.toContain('private-input-password');
    expect(String(error)).not.toContain('low-level failure');
  });
});
