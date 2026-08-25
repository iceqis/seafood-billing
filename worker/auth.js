const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return decodeBase64(padded);
}

function timingSafeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function hasValidPayloadShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 3
    && keys[0] === 'exp'
    && keys[1] === 'iat'
    && keys[2] === 'version'
    && value.version === 1
    && Number.isSafeInteger(value.iat)
    && Number.isSafeInteger(value.exp)
    && value.exp > value.iat;
}

export async function verifyPassword(password, saltBase64, expectedHashBase64) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: decodeBase64(saltBase64),
    iterations: 210000,
    hash: 'SHA-256'
  }, passwordKey, 256));
  return timingSafeEqual(derived, decodeBase64(expectedHashBase64));
}

export async function issueToken(secret, nowMs = Date.now(), ttlSeconds = TOKEN_TTL_SECONDS) {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    version: 1,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  })));
  const key = await importHmacKey(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${payload}.${encodeBase64Url(signature)}`;
}

export async function verifyToken(token, secret, nowMs = Date.now()) {
  try {
    const [payload, encodedSignature, extra] = String(token).split('.');
    if (!payload || !encodedSignature || extra !== undefined) throw new Error('invalid');

    const key = await importHmacKey(secret);
    const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
    const received = decodeBase64Url(encodedSignature);
    if (!timingSafeEqual(expected, received)) throw new Error('invalid');

    const value = JSON.parse(decoder.decode(decodeBase64Url(payload)));
    if (!hasValidPayloadShape(value)) throw new Error('invalid');
    if (value.exp <= Math.floor(nowMs / 1000)) throw new Error('expired');
    return value;
  } catch (error) {
    if (error.message === 'expired') throw new Error('登录已过期');
    throw new Error('登录凭证无效');
  }
}

export function readBearerToken(request) {
  const match = /^Bearer[\t ]+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  return match?.[1] || '';
}
