import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueToken } from '../../worker/auth.js';
import worker from '../../worker/index.js';

const encoder = new TextEncoder();
const SHOP_PASSWORD = 'shared-shop-password';
const AUTH_SECRET = 'test-signing-secret-with-enough-length';
const ALLOWED_ORIGIN = 'https://allowed.example';

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function passwordHash(password, saltBase64) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(atob(saltBase64), (character) => character.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256'
  }, key, 256);
  return encodeBase64(new Uint8Array(bits));
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function loginProof(password) {
  const challengeResponse = await worker.fetch(request('/api/auth/challenge'), env);
  const challenge = (await challengeResponse.json()).data;
  const passwordKey = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBytes = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: Uint8Array.from(atob(challenge.salt), (character) => character.charCodeAt(0)),
    iterations: challenge.iterations,
    hash: challenge.hash
  }, passwordKey, 256));
  const proofKey = await crypto.subtle.importKey(
    'raw', hashBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const proof = new Uint8Array(await crypto.subtle.sign(
    'HMAC', proofKey, encoder.encode(challenge.challengeToken)
  ));
  return {
    challengeToken: challenge.challengeToken,
    proof: encodeBase64Url(proof)
  };
}

const env = {
  FEISHU_APP_ID: 'app',
  FEISHU_APP_SECRET: 'secret',
  FEISHU_BASE_TOKEN: 'base',
  TABLE_CUSTOMERS: 'customers',
  TABLE_SUPPLIERS: 'suppliers',
  TABLE_PRODUCTS: 'products',
  TABLE_ORDERS: 'orders',
  TABLE_PURCHASES: 'purchases',
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  APP_VERSION: '3.1.0',
  SHOP_PASSWORD_SALT: encodeBase64(encoder.encode('router-test-salt')),
  SHOP_PASSWORD_HASH: '',
  AUTH_SECRET,
  LOGIN_RATE_LIMITER: null
};

function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.withOrigin !== false) headers.set('Origin', ALLOWED_ORIGIN);
  return new Request(`https://worker.example${path}`, { ...options, headers });
}

beforeAll(async () => {
  env.SHOP_PASSWORD_HASH = await passwordHash(SHOP_PASSWORD, env.SHOP_PASSWORD_SALT);
});

beforeEach(() => {
  env.LOGIN_RATE_LIMITER = {
    limit: vi.fn().mockResolvedValue({ success: true })
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authenticated Worker router', () => {
  it('keeps GET health and allowed OPTIONS public without contacting Feishu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const health = await worker.fetch(request('/api/health', { withOrigin: false }), env);
    const options = await worker.fetch(request('/api/orders', { method: 'OPTIONS' }), env);

    expect(health.status).toBe(200);
    expect(options.status).toBe(200);
    expect(options.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exposes only safe Feishu error codes through the temporary read-only diagnostic endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0, tenant_access_token: 'tenant-token', expire: 7200
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 1254302, msg: 'secret supplier details' })))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockRejectedValueOnce(new TypeError('network error with secret-token'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 1254043, msg: 'secret purchase details' })));

    const response = await worker.fetch(request('/api/health/feishu-diagnostic', {
      withOrigin: false
    }), env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      customers: { ok: true },
      suppliers: { ok: false, upstreamCode: 1254302, upstreamStatus: 200 },
      products: { ok: false, upstreamStatus: 403 },
      orders: { ok: false },
      purchases: { ok: false, upstreamCode: 1254043, upstreamStatus: 200 }
    });
    expect(JSON.stringify(body)).not.toMatch(/tenant-token|secret supplier details|secret purchase details|secret-token|"base"/);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });

  it('rejects a denied Origin with 403 before authentication or Feishu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(request('/api/orders', {
      headers: { Origin: 'https://denied.example' },
      withOrigin: false
    }), env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 403, message: '来源不允许' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('issues a public challenge only for an allowed Origin', async () => {
    const allowed = await worker.fetch(request('/api/auth/challenge'), env);
    const noOrigin = await worker.fetch(request('/api/auth/challenge', { withOrigin: false }), env);

    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      code: 0,
      data: {
        salt: env.SHOP_PASSWORD_SALT,
        iterations: 210000,
        hash: 'SHA-256'
      }
    });
    expect(noOrigin.status).toBe(403);
  });

  it('rejects login without an Origin and malformed proof requests without leaking secrets', async () => {
    const noOrigin = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: 'payload.signature', proof: 'proof' }),
      withOrigin: false
    }), env);
    const missingProof = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }), env);
    const malformedJson = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{'
    }), env);

    expect(noOrigin.status).toBe(403);
    expect(missingProof.status).toBe(400);
    expect(malformedJson.status).toBe(400);
    await expect(malformedJson.json()).resolves.toMatchObject({
      code: 400,
      message: '请求体必须是有效JSON'
    });
    const body = await missingProof.text();
    expect(body).not.toContain(env.SHOP_PASSWORD_HASH);
    expect(body).not.toContain(AUTH_SECRET);
  });

  it('logs in with a challenge proof and rejects a legacy raw password', async () => {
    const proofBody = await loginProof(SHOP_PASSWORD);
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proofBody)
    }), env);
    const body = await response.json();
    const legacy = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: SHOP_PASSWORD })
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(Object.keys(body.data).sort()).toEqual(['expiresAt', 'expiresIn', 'token']);
    expect(body.data.expiresIn).toBe(30 * 24 * 60 * 60);
    expect(body.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(body.data.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(body)).not.toContain(SHOP_PASSWORD);
    expect(JSON.stringify(body)).not.toContain(env.SHOP_PASSWORD_HASH);
    expect(JSON.stringify(body)).not.toContain(AUTH_SECRET);
    expect(legacy.status).toBe(400);
    await expect(legacy.json()).resolves.toMatchObject({
      code: 400,
      message: '登录协议已更新，请刷新页面'
    });
  });

  it('returns 401 for an incorrect password proof', async () => {
    const proofBody = await loginProof('wrong');
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proofBody)
    }), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 401, message: '店铺密码错误' });
  });

  it('returns 429 before reading or signing a rate-limited login', async () => {
    env.LOGIN_RATE_LIMITER.limit.mockResolvedValue({ success: false });
    const signSpy = vi.spyOn(crypto.subtle, 'sign');

    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.20'
      },
      body: JSON.stringify({ challengeToken: 'payload.signature', proof: 'proof' })
    }), env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toMatchObject({
      code: 429,
      message: '登录尝试过于频繁，请稍后再试'
    });
    expect(env.LOGIN_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: '203.0.113.20' });
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared login body before reading or signing a proof', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const signSpy = vi.spyOn(crypto.subtle, 'sign');
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '4097'
      },
      body: JSON.stringify({ challengeToken: 'payload.signature', proof: 'proof' })
    }), env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 413, message: '请求体过大' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(signSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(SHOP_PASSWORD);
  });

  it('cancels and rejects an oversized streamed login body without Content-Length', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const signSpy = vi.spyOn(crypto.subtle, 'sign');
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(3_000));
        controller.enqueue(new Uint8Array(1_097));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
      cancel
    });
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half'
    }), env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 413, message: '请求体过大' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(cancel).toHaveBeenCalledOnce();
    expect(signSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(AUTH_SECRET);
  });

  it.each([
    ['SHOP_PASSWORD_SALT', 'not-base64'],
    ['SHOP_PASSWORD_HASH', 'not-base64']
  ])('returns a safe 503 for invalid %s without logging sensitive values', async (key, value) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const invalidEnv = { ...env, [key]: value };
    const response = await worker.fetch(request('/api/auth/challenge'), invalidEnv);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 503,
      message: '登录服务配置异常'
    });
    expect(errorSpy).toHaveBeenCalledWith({ event: 'auth_configuration_invalid' });
    const logs = JSON.stringify([
      ...errorSpy.mock.calls,
      ...vi.mocked(console.log).mock.calls
    ]);
    expect(logs).not.toContain(value);
    expect(logs).not.toContain(env.SHOP_PASSWORD_HASH);
    expect(logs).not.toContain(AUTH_SECRET);
  });

  it('returns stable 401 errors for missing, invalid, and expired Bearer tokens without Feishu', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const expired = await issueToken(AUTH_SECRET, 1_000, 1);

    const missingResponse = await worker.fetch(request('/api/orders'), env);
    const invalidResponse = await worker.fetch(request('/api/orders', {
      headers: { Authorization: 'Bearer invalid.token' }
    }), env);
    const expiredResponse = await worker.fetch(request('/api/orders', {
      headers: { Authorization: `Bearer ${expired}` }
    }), env);

    expect(missingResponse.status).toBe(401);
    await expect(missingResponse.json()).resolves.toMatchObject({ code: 401, message: '请先登录' });
    expect(invalidResponse.status).toBe(401);
    await expect(invalidResponse.json()).resolves.toMatchObject({ code: 401, message: '登录凭证无效' });
    expect(expiredResponse.status).toBe(401);
    await expect(expiredResponse.json()).resolves.toMatchObject({ code: 401, message: '登录已过期' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows an authenticated API request without an Origin', async () => {
    const token = await issueToken(AUTH_SECRET);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0, tenant_access_token: 'tenant-token', expire: 7200
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0, data: { items: [], has_more: false }
      })));

    const response = await worker.fetch(request('/api/orders', {
      headers: { Authorization: `Bearer ${token}` },
      withOrigin: false
    }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('protects the data-source health check and returns only five availability booleans', async () => {
    const token = await issueToken(AUTH_SECRET);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0, tenant_access_token: 'tenant-token', expire: 7200
      })))
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ code: 0, data: { items: [] } })))
      );

    const unauthorized = await worker.fetch(request('/api/health/data-source'), env);
    const authorized = await worker.fetch(request('/api/health/data-source', {
      headers: { Authorization: `Bearer ${token}` }
    }), env);
    const body = await authorized.json();

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(200);
    expect(body.data).toEqual({
      customers: true,
      suppliers: true,
      products: true,
      orders: true,
      purchases: true
    });
    expect(JSON.stringify(body)).not.toContain('tenant-token');
    expect(JSON.stringify(body)).not.toContain('items');
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    for (const [url] of fetchSpy.mock.calls.slice(1)) {
      expect(new URL(url).searchParams.get('page_size')).toBe('1');
    }
  });

  it('logs only the five safe metadata fields for login and authorization failures', async () => {
    const proofBody = await loginProof('wrong-secret-value');
    vi.mocked(console.log).mockClear();
    await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proofBody)
    }), env);

    expect(console.log).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(console.log).mock.calls[0][0];
    expect(Object.keys(entry).sort()).toEqual(['durationMs', 'method', 'path', 'requestId', 'status']);
    expect(JSON.stringify(entry)).not.toContain('wrong-secret-value');
    expect(JSON.stringify(entry)).not.toContain(AUTH_SECRET);
  });
});
