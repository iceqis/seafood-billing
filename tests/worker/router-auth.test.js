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

  it('rejects login without an Origin and malformed login requests without leaking secrets', async () => {
    const noOrigin = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: SHOP_PASSWORD }),
      withOrigin: false
    }), env);
    const missingPassword = await worker.fetch(request('/api/auth/login', {
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
    expect(missingPassword.status).toBe(400);
    expect(malformedJson.status).toBe(400);
    await expect(malformedJson.json()).resolves.toMatchObject({
      code: 400,
      message: '请求体必须是有效JSON'
    });
    const body = await missingPassword.text();
    expect(body).not.toContain(env.SHOP_PASSWORD_HASH);
    expect(body).not.toContain(AUTH_SECRET);
  });

  it('logs in with the shared password and returns only token expiry data', async () => {
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: SHOP_PASSWORD })
    }), env);
    const body = await response.json();

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
  });

  it('returns 401 for an incorrect password', async () => {
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' })
    }), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 401, message: '店铺密码错误' });
  });

  it('returns 429 before reading or hashing a rate-limited login', async () => {
    env.LOGIN_RATE_LIMITER.limit.mockResolvedValue({ success: false });
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');

    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.20'
      },
      body: JSON.stringify({ password: SHOP_PASSWORD })
    }), env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toMatchObject({
      code: 429,
      message: '登录尝试过于频繁，请稍后再试'
    });
    expect(env.LOGIN_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: '203.0.113.20' });
    expect(deriveSpy).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared login body before reading or deriving a password', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '4097'
      },
      body: JSON.stringify({ password: SHOP_PASSWORD })
    }), env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: 413, message: '请求体过大' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(deriveSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(SHOP_PASSWORD);
  });

  it('cancels and rejects an oversized streamed login body without Content-Length', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');
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
    expect(deriveSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(AUTH_SECRET);
  });

  it('rejects an overlong password before PBKDF2 without leaking it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const deriveSpy = vi.spyOn(crypto.subtle, 'deriveBits');
    const password = 'p'.repeat(257);
    const response = await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    }), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 400,
      message: '店铺密码长度不能超过256个字符'
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(deriveSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(password);
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
    await worker.fetch(request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-secret-value' })
    }), env);

    expect(console.log).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(console.log).mock.calls[0][0];
    expect(Object.keys(entry).sort()).toEqual(['durationMs', 'method', 'path', 'requestId', 'status']);
    expect(JSON.stringify(entry)).not.toContain('wrong-secret-value');
    expect(JSON.stringify(entry)).not.toContain(AUTH_SECRET);
  });
});
