import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLoginRateLimit } from '../../worker/login-rate-limit.js';

function request(ip) {
  const headers = ip ? { 'CF-Connecting-IP': ip } : {};
  return new Request('https://worker.example/api/auth/login', { headers });
}

afterEach(() => vi.restoreAllMocks());

describe('login rate limiter adapter', () => {
  it('uses the client IP as the Cloudflare limiter key', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });

    await expect(checkLoginRateLimit(request('203.0.113.8'), {
      LOGIN_RATE_LIMITER: { limit }
    })).resolves.toBe(true);

    expect(limit).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.8' });
  });

  it('uses one stable key when Cloudflare IP metadata is absent locally', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });

    await checkLoginRateLimit(request(), { LOGIN_RATE_LIMITER: { limit } });

    expect(limit).toHaveBeenCalledWith({ key: 'local-development' });
  });

  it('returns false when Cloudflare rejects the request', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });

    await expect(checkLoginRateLimit(request('203.0.113.9'), {
      LOGIN_RATE_LIMITER: { limit }
    })).resolves.toBe(false);
  });

  it.each([
    ['the binding is absent', () => ({})],
    ['the binding throws', () => ({
      LOGIN_RATE_LIMITER: { limit: vi.fn().mockRejectedValue(new Error('provider details')) }
    })]
  ])('fails open with a static safe log when %s', async (_name, createEnv) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(checkLoginRateLimit(request('203.0.113.10'), createEnv())).resolves.toBe(true);

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith({ event: 'login_rate_limiter_unavailable' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('provider details');
  });
});
