import { describe, expect, it } from 'vitest';
import {
  AuthConfigurationError,
  CHALLENGE_TTL_SECONDS,
  issueLoginChallenge,
  verifyLoginProof
} from '../../worker/login-challenge.js';

const encoder = new TextEncoder();
const env = {
  SHOP_PASSWORD_SALT: 'MDEyMzQ1Njc4OWFiY2RlZg==',
  SHOP_PASSWORD_HASH: 'i4a2bJd4Vz8QLhaUdLN7zfe4ev9YcLmolZJN8R2Lqn0=',
  AUTH_SECRET: 'challenge-signing-secret-with-enough-length'
};

async function deriveHash(password, saltBase64) {
  const passwordKey = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: Uint8Array.from(atob(saltBase64), (value) => value.charCodeAt(0)),
    iterations: 210000,
    hash: 'SHA-256'
  }, passwordKey, 256));
}

async function proofFor(hashBytes, challengeToken) {
  const key = await crypto.subtle.importKey(
    'raw', hashBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, encoder.encode(challengeToken)
  ));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function signedChallengeToken(payload) {
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, encoder.encode(encodedPayload)
  ));
  return `${encodedPayload}.${encodeBase64Url(signature)}`;
}

function validPayload(overrides = {}) {
  return {
    version: 1,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
    salt: env.SHOP_PASSWORD_SALT,
    iterations: 210000,
    hash: 'SHA-256',
    iat: 1000,
    exp: 1060,
    ...overrides
  };
}

describe('login challenge', () => {
  it('issues a 60-second challenge and verifies a correct proof', async () => {
    const hashBytes = await deriveHash('shared-shop-password', env.SHOP_PASSWORD_SALT);
    const challenge = await issueLoginChallenge(env, {
      nowMs: 1_000_000,
      randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index)
    });
    const proof = await proofFor(hashBytes, challenge.challengeToken);

    expect(CHALLENGE_TTL_SECONDS).toBe(60);
    expect(challenge).toMatchObject({
      salt: env.SHOP_PASSWORD_SALT,
      iterations: 210000,
      hash: 'SHA-256',
      expiresAt: 1060
    });
    await expect(verifyLoginProof({
      challengeToken: challenge.challengeToken,
      proof
    }, env, { nowMs: 1_010_000 })).resolves.toBe(true);
  });

  it.each([
    ['tampered challenge', (challenge) => `${challenge}x`, '登录凭证无效'],
    ['malformed challenge', () => 'not-a-token', '登录凭证无效']
  ])('rejects %s', async (_name, mutate, message) => {
    const challenge = await issueLoginChallenge(env, { nowMs: 1_000_000 });
    await expect(verifyLoginProof({
      challengeToken: mutate(challenge.challengeToken),
      proof: 'A'.repeat(43)
    }, env, { nowMs: 1_010_000 })).rejects.toThrow(message);
  });

  it('rejects an expired challenge with the retryable message', async () => {
    const challenge = await issueLoginChallenge(env, { nowMs: 1_000_000 });
    await expect(verifyLoginProof({
      challengeToken: challenge.challengeToken,
      proof: 'A'.repeat(43)
    }, env, { nowMs: 1_061_000 })).rejects.toThrow('登录请求已过期，请重试');
  });

  it.each([
    ['future issue time', validPayload({ iat: 1006, exp: 1066 })],
    ['wrong version', validPayload({ version: 2 })],
    ['wrong iterations', validPayload({ iterations: 1000 })],
    ['wrong hash', validPayload({ hash: 'SHA-1' })],
    ['wrong nonce length', validPayload({ nonce: 'AA' })],
    ['extra payload field', validPayload({ extra: true })]
  ])('rejects a signed challenge with %s', async (_name, payload) => {
    await expect(verifyLoginProof({
      challengeToken: await signedChallengeToken(payload),
      proof: 'A'.repeat(43)
    }, env, { nowMs: 1_000_000 })).rejects.toThrow('登录凭证无效');
  });

  it('rejects a challenge immediately after password salt rotation', async () => {
    const challenge = await issueLoginChallenge(env, { nowMs: 1_000_000 });
    const rotatedEnv = {
      ...env,
      SHOP_PASSWORD_SALT: 'ZmVkY2JhOTg3NjU0MzIxMA=='
    };
    await expect(verifyLoginProof({
      challengeToken: challenge.challengeToken,
      proof: 'A'.repeat(43)
    }, rotatedEnv, { nowMs: 1_010_000 })).rejects.toThrow('登录凭证无效');
  });

  it('returns the stable wrong-password error for an incorrect proof', async () => {
    const challenge = await issueLoginChallenge(env, { nowMs: 1_000_000 });
    await expect(verifyLoginProof({
      challengeToken: challenge.challengeToken,
      proof: 'A'.repeat(43)
    }, env, { nowMs: 1_010_000 })).rejects.toThrow('店铺密码错误');
  });

  it.each([
    ['SHOP_PASSWORD_SALT', 'not-base64'],
    ['SHOP_PASSWORD_HASH', 'not-base64'],
    ['AUTH_SECRET', '']
  ])('rejects invalid %s before issuing a challenge', async (key, value) => {
    await expect(issueLoginChallenge({ ...env, [key]: value }))
      .rejects.toBeInstanceOf(AuthConfigurationError);
  });
});
