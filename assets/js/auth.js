import { ChallengeExpiredError, createLoginProof } from './auth-proof.js';

const TOKEN_KEY = 'seafood_billing_session';
const EXPIRED_CHALLENGE_MESSAGE = '登录请求已过期，请重试';

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

async function requestEnvelope(fetchImpl, url, init, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, init);
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
    if (validBody
      && options.allowExpired
      && response.status === 401
      && body.message === EXPIRED_CHALLENGE_MESSAGE) {
      return { expired: true };
    }
    throw new Error(validBody && typeof body.message === 'string' ? body.message : '登录失败');
  }
  return { data: body.data };
}

export async function login(apiBase, password, fetchImpl = fetch, proofFactory = createLoginProof) {
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
        challengeToken: challenge.data?.challengeToken,
        proof
      })
    }, { allowExpired: attempt === 0 });
    if (loginResponse.expired && attempt === 0) continue;

    const token = loginResponse.data?.token;
    if (typeof token !== 'string' || token.length === 0) throw new Error('登录失败');
    return token;
  }
  throw new Error(EXPIRED_CHALLENGE_MESSAGE);
}
