const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CHALLENGE_TTL_SECONDS = 60;
export const PASSWORD_KDF = Object.freeze({ iterations: 210000, hash: 'SHA-256' });

export class AuthConfigurationError extends Error {}

export class LoginChallengeError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new AuthConfigurationError('invalid auth configuration');
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new AuthConfigurationError('invalid auth configuration');
  }
  if (bytes.length !== expectedLength) throw new AuthConfigurationError('invalid auth configuration');
  let roundTrip = '';
  for (const byte of bytes) roundTrip += String.fromCharCode(byte);
  if (btoa(roundTrip) !== value) throw new AuthConfigurationError('invalid auth configuration');
  return bytes;
}

function decodeBase64UrlBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new LoginChallengeError('登录凭证无效');
  }
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let bytes;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new LoginChallengeError('登录凭证无效');
  }
  if (encodeBase64Url(bytes) !== value) throw new LoginChallengeError('登录凭证无效');
  return bytes;
}

function decodeBase64Url(value, expectedLength) {
  const bytes = decodeBase64UrlBytes(value);
  if (bytes.length !== expectedLength) throw new LoginChallengeError('登录凭证无效');
  return bytes;
}

function timingSafeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function authConfiguration(env) {
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length === 0) {
    throw new AuthConfigurationError('invalid auth configuration');
  }
  const salt = decodeBase64(env.SHOP_PASSWORD_SALT, 16);
  return {
    salt,
    saltBase64: env.SHOP_PASSWORD_SALT,
    expectedHash: decodeBase64(env.SHOP_PASSWORD_HASH, 32),
    authSecret: encoder.encode(env.AUTH_SECRET)
  };
}

function defaultRandomBytes() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hasExactPayloadShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'exp,hash,iat,iterations,nonce,salt,version'
    && value.version === 1
    && typeof value.nonce === 'string'
    && typeof value.salt === 'string'
    && value.iterations === PASSWORD_KDF.iterations
    && value.hash === PASSWORD_KDF.hash
    && Number.isSafeInteger(value.iat)
    && Number.isSafeInteger(value.exp)
    && value.iat >= 0
    && value.exp - value.iat === CHALLENGE_TTL_SECONDS;
}

export async function issueLoginChallenge(env, options = {}) {
  const config = authConfiguration(env);
  const issuedAt = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const nonceBytes = (options.randomBytes ?? defaultRandomBytes)();
  if (!(nonceBytes instanceof Uint8Array) || nonceBytes.length !== 16) {
    throw new Error('invalid challenge nonce');
  }
  const payload = {
    version: 1,
    nonce: encodeBase64Url(nonceBytes),
    salt: config.saltBase64,
    iterations: PASSWORD_KDF.iterations,
    hash: PASSWORD_KDF.hash,
    iat: issuedAt,
    exp: issuedAt + CHALLENGE_TTL_SECONDS
  };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = encodeBase64Url(await hmac(config.authSecret, encodedPayload));
  return {
    challengeToken: `${encodedPayload}.${signature}`,
    salt: payload.salt,
    iterations: payload.iterations,
    hash: payload.hash,
    expiresAt: payload.exp
  };
}

export async function verifyLoginProof(body, env, options = {}) {
  const config = authConfiguration(env);
  const [encodedPayload, encodedSignature, extra] = String(body?.challengeToken ?? '').split('.');
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new LoginChallengeError('登录凭证无效');
  }

  const receivedSignature = decodeBase64Url(encodedSignature, 32);
  const expectedSignature = await hmac(config.authSecret, encodedPayload);
  if (!timingSafeEqual(receivedSignature, expectedSignature)) {
    throw new LoginChallengeError('登录凭证无效');
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(decodeBase64UrlBytes(encodedPayload)));
  } catch (error) {
    if (error instanceof LoginChallengeError) throw error;
    throw new LoginChallengeError('登录凭证无效');
  }
  if (!hasExactPayloadShape(payload)) throw new LoginChallengeError('登录凭证无效');
  decodeBase64Url(payload.nonce, 16);

  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (payload.iat > now + 5) throw new LoginChallengeError('登录凭证无效');
  if (payload.exp <= now) throw new LoginChallengeError('登录请求已过期，请重试');
  if (payload.salt !== config.saltBase64) throw new LoginChallengeError('登录凭证无效');

  const receivedProof = decodeBase64Url(body?.proof, 32);
  const expectedProof = await hmac(config.expectedHash, body.challengeToken);
  if (!timingSafeEqual(receivedProof, expectedProof)) {
    throw new LoginChallengeError('店铺密码错误');
  }
  return true;
}
