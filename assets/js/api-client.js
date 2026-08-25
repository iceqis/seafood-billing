export class RequestCancelled extends Error {
  constructor() {
    super('请求已取消');
    this.name = 'RequestCancelled';
  }
}

export function createApiClient({
  apiBase,
  getToken,
  onUnauthorized,
  timeoutMs,
  getSessionVersion,
  fetchImpl = fetch
}) {
  const activeRequests = new Set();

  function isStale(request) {
    return request.cancelled
      || (typeof getSessionVersion === 'function'
        && getSessionVersion() !== request.sessionVersion);
  }

  function assertCurrent(request) {
    if (isStale(request)) throw new RequestCancelled();
  }

  function cancelAll() {
    for (const request of activeRequests) {
      request.cancelled = true;
      request.controller.abort();
    }
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const activeRequest = {
      controller,
      cancelled: false,
      timedOut: false,
      token: getToken(),
      sessionVersion: typeof getSessionVersion === 'function' ? getSessionVersion() : undefined
    };
    activeRequests.add(activeRequest);
    const timeout = setTimeout(() => {
      activeRequest.timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(activeRequest.token ? { Authorization: `Bearer ${activeRequest.token}` } : {})
      };
      let response;
      try {
        response = await fetchImpl(`${apiBase}${path}`, {
          ...options,
          signal: controller.signal,
          headers: { ...headers, ...(options.headers || {}) }
        });
      } catch (error) {
        if (isStale(activeRequest)) throw new RequestCancelled();
        if (error?.name === 'AbortError') {
          if (activeRequest.cancelled) throw new RequestCancelled();
          throw new Error('网络连接超时，请稍后重试');
        }
        if (error instanceof TypeError) throw new Error('网络连接失败，请稍后重试');
        throw error;
      }
      assertCurrent(activeRequest);
      if (!response || typeof response !== 'object' || typeof response.json !== 'function') {
        throw new Error('请求失败');
      }
      let body;
      let parseError = null;
      try {
        body = await response.json();
      } catch (error) {
        if (isStale(activeRequest)) throw new RequestCancelled();
        if (error?.name === 'AbortError') throw new Error('网络连接超时，请稍后重试');
        parseError = error;
      }
      assertCurrent(activeRequest);
      const validBody = body !== null && typeof body === 'object' && !Array.isArray(body);
      if (response.status === 401) {
        try {
          await onUnauthorized?.({
            token: activeRequest.token,
            sessionVersion: activeRequest.sessionVersion
          });
        } catch {
          // Unauthorized cleanup must not replace the service error.
        }
        throw new Error(validBody && typeof body.message === 'string' ? body.message : '登录已过期');
      }
      if (parseError) throw new Error('请求失败');
      if (!validBody || !response.ok || body.code !== 0) {
        throw new Error(typeof body?.message === 'string' ? body.message : '请求失败');
      }
      return body.data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('网络连接超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(activeRequest);
    }
  }

  return {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body: JSON.stringify(body) }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body: JSON.stringify(body) }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
    cancelAll
  };
}
