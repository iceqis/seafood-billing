import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../assets/js/api-client.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createClient(fetchImpl, options = {}) {
  const onUnauthorized = options.onUnauthorized || vi.fn();
  return {
    client: createApiClient({
      apiBase: 'https://api.test',
      getToken: options.getToken || (() => 'test-token'),
      onUnauthorized,
      timeoutMs: options.timeoutMs ?? 10,
      getSessionVersion: options.getSessionVersion,
      fetchImpl
    }),
    onUnauthorized
  };
}

describe('api client', () => {
  it('adds JSON headers and a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0, message: 'success', data: [] }));
    const { client } = createClient(fetchMock);
    await client.get('/api/customers');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/customers',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token'
        }),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it('does not send Authorization when no token is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0, message: 'success', data: null }));
    const { client } = createClient(fetchMock, { getToken: () => '' });
    await client.get('/api/health');
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('reports unauthorized responses exactly once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 401, message: '登录已过期', data: null }, 401));
    const { client, onUnauthorized } = createClient(fetchMock, { getSessionVersion: () => 7 });
    await expect(client.get('/api/customers')).rejects.toThrow('登录已过期');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onUnauthorized).toHaveBeenCalledWith({ token: 'test-token', sessionVersion: 7 });
  });

  it('still calls unauthorized once when the 401 body is not JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('expired', { status: 401 }));
    const { client, onUnauthorized } = createClient(fetchMock);
    await expect(client.get('/api/customers')).rejects.toThrow('登录已过期');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('converts aborts and network errors to stable friendly messages', async () => {
    const aborting = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { client: timeoutClient } = createClient(aborting);
    await expect(timeoutClient.get('/api/customers')).rejects.toThrow('网络连接超时，请稍后重试');

    const network = vi.fn().mockRejectedValue(new TypeError('socket failed with secret'));
    const { client: networkClient } = createClient(network);
    await expect(networkClient.get('/api/customers')).rejects.toThrow('网络连接失败，请稍后重试');
  });

  it('does not misclassify response parsing or business TypeErrors as network failures', async () => {
    const parsing = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new TypeError('body shape is wrong'); }
    });
    const { client: parsingClient } = createClient(parsing);
    await expect(parsingClient.get('/api/customers')).rejects.toThrow('请求失败');

    for (const response of [null, {}]) {
      const malformedResponse = vi.fn().mockResolvedValue(response);
      const { client } = createClient(malformedResponse);
      await expect(client.get('/api/customers')).rejects.toThrow('请求失败');
    }

    for (const value of [null, [], 'success']) {
      const malformed = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => value
      });
      const { client } = createClient(malformed);
      await expect(client.get('/api/customers')).rejects.toThrow('请求失败');
    }
  });

  it.each([
    ['sync', () => { throw new TypeError('callback failure'); }],
    ['async', async () => { throw new TypeError('callback failure'); }]
  ])('isolates %s unauthorized callback failures', async (_kind, onUnauthorized) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 401, message: '服务端登录已过期' }, 401));
    const { client } = createClient(fetchMock, { onUnauthorized });
    await expect(client.get('/api/customers')).rejects.toThrow('服务端登录已过期');
  });

  it('converts an abort while reading the response body to a timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new DOMException('aborted', 'AbortError'); }
    });
    const { client } = createClient(fetchMock);
    await expect(client.get('/api/customers')).rejects.toThrow('网络连接超时，请稍后重试');
  });

  it('handles non-JSON errors and clears timeout handles', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const { client } = createClient(fetchMock);
    await expect(client.get('/api/customers')).rejects.toThrow('请求失败');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('silently rejects stale success and stale 401 responses without unauthorized cleanup', async () => {
    let version = 1;
    let resolveRequest;
    const pending = new Promise((resolve) => { resolveRequest = resolve; });
    const fetchMock = vi.fn(() => pending);
    const onUnauthorized = vi.fn();
    const { client } = createClient(fetchMock, {
      getSessionVersion: () => version,
      onUnauthorized,
      timeoutMs: 1000
    });

    const staleSuccess = client.get('/api/customers');
    version += 1;
    resolveRequest(jsonResponse({ code: 0, message: 'success', data: [{ id: 'old' }] }));
    await expect(staleSuccess).rejects.toMatchObject({ name: 'RequestCancelled' });
    expect(onUnauthorized).not.toHaveBeenCalled();

    let resolveUnauthorized;
    const unauthorizedPending = new Promise((resolve) => { resolveUnauthorized = resolve; });
    const secondFetch = vi.fn(() => unauthorizedPending);
    const second = createClient(secondFetch, {
      getSessionVersion: () => version,
      onUnauthorized,
      timeoutMs: 1000
    }).client.get('/api/customers');
    version += 1;
    resolveUnauthorized(jsonResponse({ code: 401, message: '登录已过期', data: null }, 401));
    await expect(second).rejects.toMatchObject({ name: 'RequestCancelled' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('exposes cancelAll and distinguishes external cancellation from timeout', async () => {
    const fetchMock = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'));
      }, { once: true });
    }));
    const { client } = createClient(fetchMock, { timeoutMs: 1000 });

    expect(client.cancelAll).toBeTypeOf('function');
    const request = client.get('/api/customers');
    client.cancelAll();

    await expect(request).rejects.toMatchObject({ name: 'RequestCancelled' });
    await expect(request).rejects.not.toThrow('网络连接超时，请稍后重试');
  });
});
