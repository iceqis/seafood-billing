import { describe, expect, it, vi } from 'vitest';
import { createAuthStore, login } from '../../assets/js/auth.js';
import { ChallengeExpiredError } from '../../assets/js/auth-proof.js';

const SESSION_KEY = 'seafood_billing_session';

function createStorage() {
  const values = {};
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { values[key] = String(value); },
    removeItem: (key) => { delete values[key]; }
  };
}

describe('auth store', () => {
  it('persists only the signed token under the fixed session key', () => {
    const storage = createStorage();
    const auth = createAuthStore(storage);
    auth.saveToken('signed-token');

    expect(auth.getToken()).toBe('signed-token');
    expect(storage.values).toEqual({ [SESSION_KEY]: 'signed-token' });
    expect(JSON.stringify(storage.values)).not.toContain('password');
  });

  it('clears the saved token', () => {
    const auth = createAuthStore(createStorage());
    auth.saveToken('signed-token');
    auth.clear();
    expect(auth.getToken()).toBe('');
  });

  it('keeps a current-page memory session when storage access is denied', () => {
    const deniedStorage = {
      getItem: () => { throw new DOMException('denied', 'SecurityError'); },
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
      removeItem: () => { throw new DOMException('denied', 'SecurityError'); }
    };
    const auth = createAuthStore(deniedStorage);

    expect(auth.getToken()).toBe('');
    expect(() => auth.saveToken('memory-token')).not.toThrow();
    expect(auth.getToken()).toBe('memory-token');
    expect(() => auth.clear()).not.toThrow();
    expect(auth.getToken()).toBe('');
  });
});

function apiResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function challengeResponse(token = 'payload.signature') {
  return apiResponse({
    code: 0,
    message: 'success',
    data: {
      challengeToken: token,
      salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
      iterations: 210000,
      hash: 'SHA-256',
      expiresAt: 2000000000
    }
  });
}

function loginResponse(token = 'signed-token') {
  return apiResponse({
    code: 0,
    message: 'success',
    data: { token, expiresIn: 2592000 }
  });
}

describe('login request', () => {
  it('gets a challenge and posts only the generated proof', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(loginResponse());
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
    expect(proofFactory).toHaveBeenCalledWith('shop-password', expect.objectContaining({
      challengeToken: 'payload.signature'
    }));
  });

  it('retries exactly once after the Worker reports an expired challenge', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(challengeResponse('first.signature'))
      .mockResolvedValueOnce(apiResponse({
        code: 401,
        message: '登录请求已过期，请重试',
        data: null
      }, 401))
      .mockResolvedValueOnce(challengeResponse('second.signature'))
      .mockResolvedValueOnce(loginResponse('retry-token'));
    const proofFactory = vi.fn()
      .mockResolvedValueOnce('first-proof')
      .mockResolvedValueOnce('second-proof');

    await expect(login('https://api.test', 'shop-password', fetchMock, proofFactory))
      .resolves.toBe('retry-token');
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/auth/challenge'))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/auth/login'))).toHaveLength(2);
  });

  it('gets one fresh challenge when browser proof generation sees expiration', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(challengeResponse('first.signature'))
      .mockResolvedValueOnce(challengeResponse('second.signature'))
      .mockResolvedValueOnce(loginResponse('retry-token'));
    const proofFactory = vi.fn()
      .mockRejectedValueOnce(new ChallengeExpiredError('登录请求已过期，请重试'))
      .mockResolvedValueOnce('second-proof');

    await expect(login('https://api.test', 'shop-password', fetchMock, proofFactory))
      .resolves.toBe('retry-token');
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/auth/challenge'))).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/auth/login'))).toHaveLength(1);
  });

  it('does not request a third challenge after two expirations', async () => {
    const expired = () => apiResponse({
      code: 401,
      message: '登录请求已过期，请重试',
      data: null
    }, 401);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(challengeResponse('first.signature'))
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(challengeResponse('second.signature'))
      .mockResolvedValueOnce(expired());

    await expect(login(
      'https://api.test',
      'shop-password',
      fetchMock,
      vi.fn().mockResolvedValue('proof')
    )).rejects.toThrow('登录请求已过期，请重试');
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/auth/challenge'))).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses stable errors for rejected, malformed, non-JSON, and network responses', async () => {
    const rejected = vi.fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(apiResponse({
        code: 401,
        message: '店铺密码错误',
        data: null
      }, 401));
    await expect(login(
      'https://api.test', 'wrong', rejected, vi.fn().mockResolvedValue('wrong-proof')
    )).rejects.toThrow('店铺密码错误');

    const missingToken = vi.fn()
      .mockResolvedValueOnce(challengeResponse())
      .mockResolvedValueOnce(apiResponse({
      code: 0,
      message: 'success',
      data: null
    }));
    await expect(login(
      'https://api.test', 'password', missingToken, vi.fn().mockResolvedValue('proof')
    )).rejects.toThrow('登录失败');

    const nonJson = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(login(
      'https://api.test', 'password', nonJson, vi.fn().mockResolvedValue('proof')
    )).rejects.toThrow('登录失败');

    const network = vi.fn().mockRejectedValue(new TypeError('socket secret'));
    await expect(login(
      'https://api.test', 'password', network, vi.fn().mockResolvedValue('proof')
    )).rejects.toThrow('网络连接失败，请稍后重试');

    const aborted = vi.fn().mockRejectedValue(new DOMException('timeout', 'AbortError'));
    await expect(login(
      'https://api.test', 'password', aborted, vi.fn().mockResolvedValue('proof')
    )).rejects.toThrow('网络连接超时，请稍后重试');
  });
});
