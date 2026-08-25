export function createApiClient({ apiBase, getToken, onUnauthorized, timeoutMs, fetchImpl = fetch }) {
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const token = getToken();
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      };
      let response;
      try {
        response = await fetchImpl(`${apiBase}${path}`, {
          ...options,
          signal: controller.signal,
          headers: { ...headers, ...(options.headers || {}) }
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('网络连接超时，请稍后重试');
        if (error instanceof TypeError) throw new Error('网络连接失败，请稍后重试');
        throw error;
      }
      if (!response || typeof response !== 'object' || typeof response.json !== 'function') {
        throw new Error('请求失败');
      }
      let body;
      let parseError = null;
      try {
        body = await response.json();
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('网络连接超时，请稍后重试');
        parseError = error;
      }
      const validBody = body !== null && typeof body === 'object' && !Array.isArray(body);
      if (response.status === 401) {
        try {
          await onUnauthorized?.();
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
      if (error.name === 'AbortError') throw new Error('网络连接超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body: JSON.stringify(body) }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body: JSON.stringify(body) }),
    delete: (path, options) => request(path, { ...options, method: 'DELETE' })
  };
}
