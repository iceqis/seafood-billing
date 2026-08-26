# Free Worker Login Challenge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace server-side PBKDF2 with a 60-second signed challenge and browser-side PBKDF2 so shared-shop login works within Cloudflare Workers Free CPU limits without changing Feishu data.

**Architecture:** A focused Worker module issues and verifies stateless HMAC-signed login challenges. A focused browser module derives the existing 32-byte PBKDF2 result and signs the challenge; the Worker compares that proof with an HMAC generated from `SHOP_PASSWORD_HASH`, then issues the existing 30-day session token. Existing secrets, login rate limiting, business APIs, and all five Feishu tables remain unchanged.

**Tech Stack:** Vanilla ES modules, Web Crypto, Cloudflare Workers, Vitest, Node test runner, Playwright, GitHub Actions, Wrangler.

---

## File map

- Create `worker/login-challenge.js`: strict auth configuration validation, signed challenge issue/verify, proof verification, and protocol-specific errors.
- Create `tests/worker/login-challenge.test.js`: independent cryptographic vectors and challenge edge cases.
- Modify `worker/auth.js`: keep only 30-day session token and Bearer-token responsibilities; remove server-side `verifyPassword`.
- Modify `worker/index.js`: add challenge route, accept proof-based login, map safe configuration/protocol errors, and preserve rate-limit ordering.
- Modify `tests/worker/auth.test.js`: remove server PBKDF2 tests and retain session-token coverage.
- Modify `tests/worker/router-auth.test.js`: exercise challenge, proof login, legacy request rejection, 503 configuration errors, and existing rate limiting.
- Create `assets/js/auth-proof.js`: validate challenge data, run browser PBKDF2, and generate a Base64URL HMAC proof.
- Create `tests/frontend/auth-proof.test.js`: known vector, validation, expiration, and no-password-return tests.
- Modify `assets/js/auth.js`: perform challenge GET, proof POST, one expiration retry, and stable error handling.
- Modify `tests/frontend/auth.test.js`: verify the two-request protocol and prove raw passwords never enter request bodies.
- Modify `assets/js/app.js`: display the security-verification busy state and restore the login button deterministically.
- Modify `tests/frontend/auth-flow.test.js`: update page-level login mocks and busy-state assertions.
- Modify `tests/e2e/mock-api.js`: mock challenge/proof authentication without forwarding production requests.
- Modify `tests/e2e/order-lifecycle.spec.js` and `tests/e2e/responsive.spec.js`: keep the existing user-visible login flows with the new protocol.
- Modify `assets/js/config.js`, `wrangler.toml`, `index.html`, and version assertions: publish version `3.2.0`.
- Modify `.github/workflows/deploy.yml` and `tests/config/workflows.test.js`: verify the production challenge endpoint after Worker deployment.
- Modify `docs/operations.md` and `tests/config/operations.test.js`: document free-plan behavior, new login diagnostics, password rotation, and read-only production acceptance.

### Task 1: Worker signed-challenge core

**Files:**
- Create: `worker/login-challenge.js`
- Create: `tests/worker/login-challenge.test.js`

- [x] **Step 1: Write failing tests for challenge issue and correct proof verification**

```js
import { describe, expect, it } from 'vitest';
import {
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
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run --config vitest.worker.config.js tests/worker/login-challenge.test.js`

Expected: FAIL because `worker/login-challenge.js` does not exist.

- [x] **Step 3: Implement strict configuration decoding and challenge issue/verify**

Create `worker/login-challenge.js` with these public contracts and no server-side PBKDF2 call:

```js
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CHALLENGE_TTL_SECONDS = 60;
export const PASSWORD_KDF = Object.freeze({ iterations: 210000, hash: 'SHA-256' });

export class AuthConfigurationError extends Error {}

export class LoginChallengeError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new AuthConfigurationError('invalid auth configuration');
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new AuthConfigurationError('invalid auth configuration');
  }
  if (bytes.length !== expectedLength) throw new AuthConfigurationError('invalid auth configuration');
  let roundTrip = '';
  for (const byte of bytes) roundTrip += String.fromCharCode(byte);
  if (btoa(roundTrip) !== value) throw new AuthConfigurationError('invalid auth configuration');
  return bytes;
}

function decodeBase64UrlBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new LoginChallengeError('登录凭证无效');
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let bytes;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new LoginChallengeError('登录凭证无效');
  }
  if (encodeBase64Url(bytes) !== value) throw new LoginChallengeError('登录凭证无效');
  return bytes;
}

function decodeBase64Url(value, expectedLength) {
  const bytes = decodeBase64UrlBytes(value);
  if (bytes.length !== expectedLength) throw new LoginChallengeError('登录凭证无效');
  return bytes;
}

function timingSafeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function authConfiguration(env) {
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length === 0) {
    throw new AuthConfigurationError('invalid auth configuration');
  }
  return {
    salt: decodeBase64(env.SHOP_PASSWORD_SALT, 16),
    saltBase64: env.SHOP_PASSWORD_SALT,
    expectedHash: decodeBase64(env.SHOP_PASSWORD_HASH, 32),
    authSecret: encoder.encode(env.AUTH_SECRET)
  };
}

function defaultRandomBytes() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hasExactPayloadShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'exp,hash,iat,iterations,nonce,salt,version'
    && value.version === 1
    && typeof value.nonce === 'string'
    && typeof value.salt === 'string'
    && value.iterations === PASSWORD_KDF.iterations
    && value.hash === PASSWORD_KDF.hash
    && Number.isSafeInteger(value.iat)
    && Number.isSafeInteger(value.exp)
    && value.iat >= 0
    && value.exp - value.iat === CHALLENGE_TTL_SECONDS;
}

export async function issueLoginChallenge(env, options = {}) {
  const config = authConfiguration(env);
  const issuedAt = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const nonceBytes = (options.randomBytes ?? defaultRandomBytes)();
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 16) {
    throw new Error('invalid challenge nonce');
  }
  const payload = {
    version: 1,
    nonce: encodeBase64Url(nonceBytes),
    salt: config.saltBase64,
    iterations: PASSWORD_KDF.iterations,
    hash: PASSWORD_KDF.hash,
    iat: issuedAt,
    exp: issuedAt + CHALLENGE_TTL_SECONDS
  };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = encodeBase64Url(await hmac(config.authSecret, encodedPayload));
  return {
    challengeToken: `${encodedPayload}.${signature}`,
    salt: payload.salt,
    iterations: payload.iterations,
    hash: payload.hash,
    expiresAt: payload.exp
  };
}

export async function verifyLoginProof(body, env, options = {}) {
  const config = authConfiguration(env);
  const [encodedPayload, encodedSignature, extra] = String(body?.challengeToken ?? '').split('.');
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new LoginChallengeError('登录凭证无效');
  }

  const receivedSignature = decodeBase64Url(encodedSignature, 32);
  const expectedSignature = await hmac(config.authSecret, encodedPayload);
  if (!timingSafeEqual(receivedSignature, expectedSignature)) {
    throw new LoginChallengeError('登录凭证无效');
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(decodeBase64UrlBytes(encodedPayload)));
  } catch (error) {
    if (error instanceof LoginChallengeError) throw error;
    throw new LoginChallengeError('登录凭证无效');
  }
  if (!hasExactPayloadShape(payload)) throw new LoginChallengeError('登录凭证无效');
  decodeBase64Url(payload.nonce, 16);

  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (payload.iat > now + 5) throw new LoginChallengeError('登录凭证无效');
  if (payload.exp <= now) throw new LoginChallengeError('登录请求已过期，请重试');
  if (payload.salt !== config.saltBase64) throw new LoginChallengeError('登录凭证无效');

  const receivedProof = decodeBase64Url(body?.proof, 32);
  const expectedProof = await hmac(config.expectedHash, body.challengeToken);
  if (!timingSafeEqual(receivedProof, expectedProof)) {
    throw new LoginChallengeError('店铺密码错误');
  }
  return true;
}
```

The literal object order above is the protocol's stable JSON order. Keep the signature-before-parse order and do not add PBKDF2 to this Worker module.

- [x] **Step 4: Add failing edge-case tests, then complete the minimal validation**

Add concrete table-driven cases:

```js
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
  await expect(issueLoginChallenge({ ...env, [key]: value })).rejects.toBeInstanceOf(AuthConfigurationError);
});
```

Run the focused test after each validation group until all cases pass.

- [x] **Step 5: Commit the Worker challenge core**

```bash
git add worker/login-challenge.js tests/worker/login-challenge.test.js
git commit -m "feat: add stateless login challenge proof"
```

### Task 2: Worker routing, safe errors, and rate-limit ordering

**Files:**
- Modify: `worker/auth.js`
- Modify: `worker/index.js`
- Modify: `tests/worker/auth.test.js`
- Modify: `tests/worker/router-auth.test.js`

- [x] **Step 1: Remove the obsolete server-password unit test and write failing router tests**

Delete the `verifyPassword` import/test from `tests/worker/auth.test.js`. In `tests/worker/router-auth.test.js`, add an independent `loginProof(password)` helper that first requests `/api/auth/challenge`, derives PBKDF2 in the test, signs the returned `challengeToken`, and returns `{ challengeToken, proof }`.

Add these route expectations:

```js
it('issues a public challenge only for an allowed Origin', async () => {
  const allowed = await worker.fetch(request('/api/auth/challenge'), env);
  const noOrigin = await worker.fetch(request('/api/auth/challenge', { withOrigin: false }), env);
  expect(allowed.status).toBe(200);
  await expect(allowed.json()).resolves.toMatchObject({
    code: 0,
    data: { salt: env.SHOP_PASSWORD_SALT, iterations: 210000, hash: 'SHA-256' }
  });
  expect(noOrigin.status).toBe(403);
});

it('logs in with a challenge proof and never accepts a raw password', async () => {
  const body = await loginProof(SHOP_PASSWORD);
  const accepted = await worker.fetch(request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env);
  const legacy = await worker.fetch(request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: SHOP_PASSWORD })
  }), env);
  expect(accepted.status).toBe(200);
  expect(legacy.status).toBe(400);
  await expect(legacy.json()).resolves.toMatchObject({
    code: 400,
    message: '登录协议已更新，请刷新页面'
  });
});
```

- [x] **Step 2: Run router/auth tests and verify RED**

Run: `npx vitest run --config vitest.worker.config.js tests/worker/auth.test.js tests/worker/router-auth.test.js`

Expected: challenge route is protected as a business route and proof bodies are rejected.

- [x] **Step 3: Integrate the challenge route and proof login**

In `worker/index.js`, import:

```js
import {
  AuthConfigurationError,
  LoginChallengeError,
  issueLoginChallenge,
  verifyLoginProof
} from './login-challenge.js';
```

Delete `REQUIRED_AUTH_ENV` and `assertAuthEnvironment`; `authConfiguration` is now the single strict validator for challenge/login configuration and maps every missing or malformed auth value to the safe 503 path. Replace password verification in `login` with exact-body validation followed by:

```js
if (body && typeof body === 'object' && !Array.isArray(body) && 'password' in body) {
  throw new ValidationError('登录协议已更新，请刷新页面');
}
if (!body || typeof body !== 'object' || Array.isArray(body)
  || Object.keys(body).sort().join(',') !== 'challengeToken,proof'
  || typeof body.challengeToken !== 'string'
  || body.challengeToken.length === 0
  || typeof body.proof !== 'string'
  || body.proof.length === 0) {
  throw new ValidationError('登录请求无效');
}
await verifyLoginProof(body, env);
```

Add the allowed-origin challenge route before `POST /api/auth/login`:

```js
} else if (url.pathname === '/api/auth/challenge' && request.method === 'GET') {
  response = origin
    ? successResponse(await issueLoginChallenge(env))
    : errorResponse('来源不允许', 403);
```

Remove `verifyPassword`, `MAX_PASSWORD_LENGTH`, `REQUIRED_AUTH_ENV`, and `assertAuthEnvironment`. Keep `readJsonBody`, the 4KB body limit, `rateLimitedLogin`, and token issuance.

- [x] **Step 4: Map safe protocol/configuration errors and test the logs**

Update `responseForError`:

```js
function responseForError(error) {
  if (error instanceof AuthConfigurationError) {
    console.error({ event: 'auth_configuration_invalid' });
    return errorResponse('登录服务配置异常', 503);
  }
  if (error instanceof LoginChallengeError) return errorResponse(error.message, error.status);
  if (error instanceof ValidationError) return errorResponse(error.message, error.status);
  if (error instanceof FeishuError) return errorResponse(error.message, 502);
  return errorResponse('服务器内部错误', 500);
}
```

Add assertions that invalid salt/hash return 503, `console.error` receives exactly `{ event: 'auth_configuration_invalid' }`, and logs contain no salt/hash/secret/proof. Change the 429 test to spy on `crypto.subtle.sign` and assert it is not called after the limiter rejects.

- [x] **Step 5: Run focused Worker tests and commit**

Run: `npx vitest run --config vitest.worker.config.js tests/worker/auth.test.js tests/worker/login-challenge.test.js tests/worker/router-auth.test.js`

Expected: all focused Worker tests PASS.

```bash
git add worker/auth.js worker/index.js tests/worker/auth.test.js tests/worker/router-auth.test.js
git commit -m "feat: route login through challenge proofs"
```

### Task 3: Browser PBKDF2 and proof generation

**Files:**
- Create: `assets/js/auth-proof.js`
- Create: `tests/frontend/auth-proof.test.js`

- [x] **Step 1: Write a failing known-vector test**

```js
import { describe, expect, it } from 'vitest';
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
    await expect(createLoginProof('shared-shop-password', challenge, {
      nowMs: 2_001_000
    })).rejects.toBeInstanceOf(ChallengeExpiredError);
  });
});
```

The literal expected vector above was computed independently with `node:crypto` `pbkdf2Sync` plus `createHmac`; do not derive the expected value with production code.

- [x] **Step 2: Run the focused frontend test and verify RED**

Run: `npx vitest run --config vitest.config.js tests/frontend/auth-proof.test.js`

Expected: FAIL because `assets/js/auth-proof.js` does not exist.

- [x] **Step 3: Implement the browser-only proof module**

Create these exact public contracts:

```js
const encoder = new TextEncoder();

export class ChallengeExpiredError extends Error {}

function decodeSalt(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    throw new Error('登录挑战无效');
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.length !== 16) throw new Error('登录挑战无效');
  return bytes;
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function createLoginProof(password, challenge, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const cryptoImpl = options.cryptoImpl ?? crypto;
  if (!challenge || typeof challenge !== 'object'
    || typeof challenge.challengeToken !== 'string'
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(challenge.challengeToken)
    || challenge.iterations !== 210000
    || challenge.hash !== 'SHA-256'
    || !Number.isSafeInteger(challenge.expiresAt)) {
    throw new Error('登录挑战无效');
  }
  if (challenge.expiresAt <= Math.floor(nowMs / 1000)) {
    throw new ChallengeExpiredError('登录请求已过期，请重试');
  }
  const passwordKey = await cryptoImpl.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derived = new Uint8Array(await cryptoImpl.subtle.deriveBits({
    name: 'PBKDF2',
    salt: decodeSalt(challenge.salt),
    iterations: challenge.iterations,
    hash: challenge.hash
  }, passwordKey, 256));
  const proofKey = await cryptoImpl.subtle.importKey(
    'raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const proof = new Uint8Array(await cryptoImpl.subtle.sign(
    'HMAC', proofKey, encoder.encode(challenge.challengeToken)
  ));
  return encodeBase64Url(proof);
}
```

- [x] **Step 4: Add malformed-field tests and make them pass**

Use `it.each` for invalid salt length, invalid token shape, wrong iterations, wrong hash name, non-integer expiration, and a rejected Web Crypto operation. Assert stable messages and never include the input password in an error.

- [x] **Step 5: Run focused tests and commit**

Run: `npx vitest run --config vitest.config.js tests/frontend/auth-proof.test.js`

Expected: all proof tests PASS.

```bash
git add assets/js/auth-proof.js tests/frontend/auth-proof.test.js
git commit -m "feat: derive login proofs in the browser"
```

### Task 4: Two-request frontend login client

**Files:**
- Modify: `assets/js/auth.js`
- Modify: `tests/frontend/auth.test.js`

- [x] **Step 1: Replace the password-post test with a failing challenge/proof test**

```js
it('gets a challenge and posts only the generated proof', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      message: 'success',
      data: {
        challengeToken: 'payload.signature',
        salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
        iterations: 210000,
        hash: 'SHA-256',
        expiresAt: 2000000000
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      message: 'success',
      data: { token: 'signed-token', expiresIn: 2592000 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const proofFactory = vi.fn().mockResolvedValue('proof-value');

  await expect(login('https://api.test', 'shop-password', fetchMock, proofFactory))
    .resolves.toBe('signed-token');
  expect(fetchMock.mock.calls[0]).toEqual([
    'https://api.test/api/auth/challenge',
    { method: 'GET', headers: { Accept: 'application/json' } }
  ]);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    challengeToken: 'payload.signature',
    proof: 'proof-value'
  });
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('shop-password');
});
```

- [x] **Step 2: Run `auth.test.js` and verify RED**

Run: `npx vitest run --config vitest.config.js tests/frontend/auth.test.js`

Expected: FAIL because the current client performs one password POST.

- [x] **Step 3: Implement challenge GET, proof POST, and one expiration retry**

Import `ChallengeExpiredError` and `createLoginProof`. Keep `createAuthStore` unchanged. Implement `login(apiBase, password, fetchImpl = fetch, proofFactory = createLoginProof)` as a two-attempt loop:

```js
for (let attempt = 0; attempt < 2; attempt += 1) {
  const challenge = await requestEnvelope(fetchImpl, `${apiBase}/api/auth/challenge`, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  let proof;
  try {
    proof = await proofFactory(password, challenge.data);
  } catch (error) {
    if (error instanceof ChallengeExpiredError && attempt === 0) continue;
    throw error;
  }
  const loginResponse = await requestEnvelope(fetchImpl, `${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeToken: challenge.data.challengeToken,
      proof
    })
  }, { allowExpired: attempt === 0 });
  if (loginResponse.expired && attempt === 0) continue;
  const token = loginResponse.data?.token;
  if (typeof token !== 'string' || token.length === 0) throw new Error('登录失败');
  return token;
}
throw new Error('登录请求已过期，请重试');
```

`requestEnvelope` must preserve current network/Abort/non-JSON messages, require an object API envelope, and return `{ expired: true }` only for HTTP 401 with the exact message “登录请求已过期，请重试”. All other non-OK responses throw the server message.

- [x] **Step 4: Add retry and stable-error tests**

Add one test where the first POST returns the expiration message and the second challenge/login succeeds; assert exactly two challenge GETs and two login POSTs. Add one test where both attempts expire and assert no third challenge. Retain 401, missing token, non-JSON, and network tests with challenge responses included before each login response.

- [x] **Step 5: Run focused tests and commit**

Run: `npx vitest run --config vitest.config.js tests/frontend/auth-proof.test.js tests/frontend/auth.test.js`

Expected: all proof/client tests PASS.

```bash
git add assets/js/auth.js tests/frontend/auth.test.js
git commit -m "feat: use challenge proof login requests"
```

### Task 5: Page state and end-to-end protocol mocks

**Files:**
- Modify: `assets/js/app.js`
- Modify: `tests/frontend/auth-flow.test.js`
- Modify: `tests/e2e/mock-api.js`
- Modify: `tests/e2e/order-lifecycle.spec.js`
- Modify: `tests/e2e/responsive.spec.js`

- [x] **Step 1: Write failing page busy-state assertions**

In the existing delayed-login test, add:

```js
expect(document.querySelector('#login-password').value).toBe('');
expect(document.querySelector('#login-submit').disabled).toBe(true);
expect(document.querySelector('#login-submit').textContent).toBe('正在安全验证…');
```

After resolving login, assert:

```js
expect(document.querySelector('#login-submit').disabled).toBe(false);
expect(document.querySelector('#login-submit').textContent).toBe('登录');
```

- [x] **Step 2: Run `auth-flow.test.js` and verify RED**

Run: `npx vitest run --config vitest.config.js tests/frontend/auth-flow.test.js`

Expected: FAIL because the button text remains “登录” and mocks do not provide challenges.

- [x] **Step 3: Add deterministic busy-state restoration**

In `performLogin`, save and restore the fixed label:

```js
button.disabled = true;
setText(button, '正在安全验证…');
setText(document.getElementById('login-message'), '');
let saved = false;
try {
  const token = await login(apiBase, password);
  activateSession(token);
  saved = true;
  showApplication();
  await pages.home.enter();
} catch (error) {
  if (!saved) setText(document.getElementById('login-message'), error.message || '登录失败，请重试');
} finally {
  button.disabled = false;
  setText(button, '登录');
  loginInFlight = null;
}
```

- [x] **Step 4: Update frontend flow mocks to the two-request protocol**

Add a shared valid challenge constant and route-aware mock helper at the top of `auth-flow.test.js`:

```js
const TEST_CHALLENGE = {
  challengeToken: 'cGF5bG9hZA.c2lnbmF0dXJl',
  salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
  iterations: 210000,
  hash: 'SHA-256',
  expiresAt: 2000000000
};

function challengeResponse() {
  return apiResponse({ code: 0, message: 'success', data: TEST_CHALLENGE });
}
```

For each login-flow mock, return `challengeResponse()` when the URL ends in `/api/auth/challenge`, return the intended token/error for `/api/auth/login`, and retain business responses for other paths. Update call-count assertions to count routes by URL rather than raw total calls.

- [x] **Step 5: Update the Playwright mock to verify real proofs**

In `tests/e2e/mock-api.js`, import `createLoginProof`, return a fixed challenge for GET, and compute the expected proof once per installed mock:

```js
import { createLoginProof } from '../../assets/js/auth-proof.js';

const LOGIN_CHALLENGE = {
  challengeToken: 'cGF5bG9hZA.c2lnbmF0dXJl',
  salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
  iterations: 210000,
  hash: 'SHA-256',
  expiresAt: 2000000000
};

const expectedProof = await createLoginProof(GOOD_PASSWORD, LOGIN_CHALLENGE, { nowMs: Date.now() });
```

Handle routes:

```js
if (path === '/api/auth/challenge' && method === 'GET') {
  entry.handled = true;
  return ok(route, LOGIN_CHALLENGE);
}
if (path === '/api/auth/login' && method === 'POST') {
  entry.handled = true;
  const body = await requestJson(request);
  if (body.challengeToken !== LOGIN_CHALLENGE.challengeToken || body.proof !== expectedProof) {
    return fail(route, 401, '店铺密码错误');
  }
  return ok(route, { token: TOKEN, expiresIn: 2592000 });
}
```

Update E2E request assertions to exempt both `/api/auth/challenge` and `/api/auth/login` from Bearer checks while still asserting no request body contains either test password.

- [x] **Step 6: Run page and E2E tests, then commit**

Run: `npx vitest run --config vitest.config.js tests/frontend/auth-flow.test.js`

Run: `npm run test:e2e`

Expected: frontend flow tests PASS; Playwright reports the existing desktop/mobile passes and the intentional project skip only.

```bash
git add assets/js/app.js tests/frontend/auth-flow.test.js tests/e2e/mock-api.js tests/e2e/order-lifecycle.spec.js tests/e2e/responsive.spec.js
git commit -m "test: cover challenge login user flows"
```

### Task 6: Version, deployment checks, and operations documentation

**Files:**
- Modify: `assets/js/config.js`
- Modify: `wrangler.toml`
- Modify: `worker/index.js`
- Modify: `index.html`
- Modify: `.github/workflows/deploy.yml`
- Modify: `tests/worker/baseline.test.js`
- Modify: `tests/config/workflows.test.js`
- Modify: `tests/config/operations.test.js`
- Modify: `docs/operations.md`

- [x] **Step 1: Write failing version and workflow assertions**

Update expected versions to `3.2.0` and add:

```js
assert.match(workflow, /Verify auth challenge/);
assert.match(workflow, /api\/auth\/challenge/);
assert.match(workflow, /Origin: https:\/\/iceqis\.github\.io/);
assert.match(runbook, /浏览器[\s\S]*PBKDF2[\s\S]*210,000/);
assert.match(runbook, /登录服务配置异常[\s\S]*auth_configuration_invalid/);
```

- [x] **Step 2: Run config/baseline tests and verify RED**

Run: `node --test tests/config/*.test.js`

Run: `npx vitest run --config vitest.worker.config.js tests/worker/baseline.test.js`

Expected: FAIL on old version strings and missing challenge deployment check/runbook text.

- [x] **Step 3: Bump version and add the production challenge check**

Set `APP_CONFIG.version`, production/dev `APP_VERSION`, health fallback, HTML title/footer, and relevant assertions to `3.2.0`.

Add this step immediately after Worker health verification:

```yaml
      - name: Verify auth challenge
        run: >-
          curl --fail-with-body --silent --show-error
          --retry 5 --retry-all-errors --retry-delay 5
          --connect-timeout 10 --max-time 30
          --header 'Origin: https://iceqis.github.io'
          https://seafood-billing-api.iceqy0313.workers.dev/api/auth/challenge
```

- [x] **Step 4: Document the exact new operations flow**

In `docs/operations.md`, document that PBKDF2 runs in the browser, the Worker verifies a 60-second proof, salt/hash rotation is unchanged, 503 means strict auth configuration validation failed, and no raw password/proof may appear in logs. Update production acceptance to require challenge 200, wrong password 401, correct login, and five-source read-only health before any separately authorized write test.

- [x] **Step 5: Run focused config/baseline tests and commit**

Run: `node --test tests/config/*.test.js`

Run: `npx vitest run --config vitest.worker.config.js tests/worker/baseline.test.js`

Expected: all focused tests PASS.

```bash
git add assets/js/config.js wrangler.toml worker/index.js index.html .github/workflows/deploy.yml tests/worker/baseline.test.js tests/config/workflows.test.js tests/config/operations.test.js docs/operations.md
git commit -m "docs: prepare challenge login deployment"
```

### Task 7: Complete verification and review

**Files:**
- Verify all changed files

- [x] **Step 1: Run the complete automated test suite**

Run: `npm test`

Expected: frontend, Worker, and config suites all PASS with no unhandled rejection or secret output.

- [x] **Step 2: Run real-browser end-to-end tests**

Run: `npm run test:e2e`

Expected: all configured desktop/mobile scenarios PASS, with only the existing intentional project skip.

- [x] **Step 3: Build Pages and dry-run Worker deployment**

Run: `npm run build:pages`

Expected: `_site` builds successfully and contains version `3.2.0` assets.

Run: `WRANGLER_WRITE_LOGS=false npx wrangler deploy --dry-run --env=""`

Expected: dry-run succeeds and lists only the existing `LOGIN_RATE_LIMITER` binding plus current variables.

- [x] **Step 4: Run static safety checks**

Run: `git diff --check publish/main...HEAD`

Run: `rg -n "shared-shop-password|correct-shop-password|AUTH_SECRET=|SHOP_PASSWORD_HASH=" assets worker index.html wrangler.toml .github docs/operations.md`

Expected: no production secret value; test fixture strings must not occur in production files.

- [x] **Step 5: Request code review and fix only evidenced issues**

Invoke `superpowers:requesting-code-review`, review the complete diff against the approved spec, and run the affected focused test after each correction.

- [x] **Step 6: Re-run completion verification**

Invoke `superpowers:verification-before-completion`, then repeat `npm test`, `npm run test:e2e`, `npm run build:pages`, Wrangler dry-run, `git diff --check`, and `git status --short` with fresh output.

### Task 8: Production publication and read-only acceptance

**Files:**
- No additional product files unless production evidence identifies a new bug

- [ ] **Step 1: Stop for explicit publication authorization**

Report local verification results and ask the user to reply `确认发布登录修复到 main`. Do not reuse the earlier release authorization.

- [ ] **Step 2: Re-establish the narrow temporary GitHub deploy key only if required**

If existing GitHub credentials still lack content write permission, ask for action-time authorization, generate an ED25519 key in a validated `/private/tmp/seafood-billing-deploy-key.*` directory, and add it as a write-enabled deploy key scoped only to `iceqis/seafood-billing`.

- [ ] **Step 3: Verify the remote baseline and push without force**

Run the equivalent of:

```bash
git ls-remote git@github.com:iceqis/seafood-billing.git refs/heads/main
git push git@github.com:iceqis/seafood-billing.git HEAD:main
```

Expected: remote `main` is the verified ancestor and the update is a normal fast-forward. Never pass `--force`.

- [ ] **Step 4: Monitor the production workflow**

Require `test`, `deploy-worker`, `Verify Worker health`, `Verify protected endpoint`, `Verify auth challenge`, `deploy-pages`, and `Verify deployed Pages site` to complete successfully for the new head SHA.

- [ ] **Step 5: Perform read-only login acceptance**

Verify Pages returns 200 and publishes version `3.2.0`. Ask the user to enter an intentionally wrong password in the page and confirm 401 “店铺密码错误”, then enter the correct password privately and confirm the home page loads. Do not request the password in chat.

- [ ] **Step 6: Verify all five Feishu sources without writes**

After the user is logged in, call only the protected read-only data-source health route and require:

```json
{
  "customers": true,
  "suppliers": true,
  "products": true,
  "orders": true,
  "purchases": true
}
```

Do not create, edit, settle, or delete any record without separate action-time confirmations.

- [ ] **Step 7: Revoke temporary publication access**

Ask for action-time deletion authorization, remove the GitHub deploy key, permanently delete only the validated temporary local key directory, and verify both are gone.
