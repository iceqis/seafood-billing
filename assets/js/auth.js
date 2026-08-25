const TOKEN_KEY = 'seafood_billing_session';

export function createAuthStore(storage) {
  let initialized = false;
  let memoryToken = '';

  return {
    getToken: () => {
      if (initialized) return memoryToken;
      initialized = true;
      try {
        memoryToken = storage?.getItem(TOKEN_KEY) || '';
      } catch {
        memoryToken = '';
      }
      return memoryToken;
    },
    saveToken: (token) => {
      initialized = true;
      memoryToken = String(token);
      try {
        storage?.setItem(TOKEN_KEY, memoryToken);
      } catch {
        // Keep the signed token in memory for the current page session.
      }
    },
    clear: () => {
      initialized = true;
      memoryToken = '';
      try {
        storage?.removeItem(TOKEN_KEY);
      } catch {
        // Memory state remains authoritative when storage is unavailable.
      }
    }
  };
}

export async function login(apiBase, password, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('网络连接超时，请稍后重试');
    if (error instanceof TypeError) throw new Error('网络连接失败，请稍后重试');
    throw new Error('登录失败');
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('登录失败');
  }

  const validBody = body !== null && typeof body === 'object' && !Array.isArray(body);
  if (!validBody || !response.ok || body.code !== 0) {
    throw new Error(validBody && typeof body.message === 'string' ? body.message : '登录失败');
  }
  const token = body.data?.token;
  if (typeof token !== 'string' || token.length === 0) throw new Error('登录失败');
  return token;
}
