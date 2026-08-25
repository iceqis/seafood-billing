import { describe, expect, it, vi } from 'vitest';
import { createAuthStore, login } from '../../assets/js/auth.js';

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

describe('login request', () => {
  it('posts the password and returns only the signed token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      message: 'success',
      data: { token: 'signed-token', expiresIn: 2592000 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(login('https://api.test', 'shop-password', fetchMock)).resolves.toBe('signed-token');
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'shop-password' })
    });
  });

  it('uses stable errors for rejected, malformed, and non-JSON responses', async () => {
    const rejected = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 401,
      message: '店铺密码错误',
      data: null
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    await expect(login('https://api.test', 'wrong', rejected)).rejects.toThrow('店铺密码错误');

    const missingToken = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      message: 'success',
      data: null
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(login('https://api.test', 'password', missingToken)).rejects.toThrow('登录失败');

    const nonJson = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(login('https://api.test', 'password', nonJson)).rejects.toThrow('登录失败');

    const network = vi.fn().mockRejectedValue(new TypeError('socket secret'));
    await expect(login('https://api.test', 'password', network)).rejects.toThrow('网络连接失败，请稍后重试');
  });
});
