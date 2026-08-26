const encoder = new TextEncoder();

export class ChallengeExpiredError extends Error {}

function decodeSalt(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    throw new Error('登录挑战无效');
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('登录挑战无效');
  }
  if (bytes.length !== 16) throw new Error('登录挑战无效');
  return bytes;
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function createLoginProof(password, challenge, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const cryptoImpl = options.cryptoImpl ?? crypto;
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)
    || typeof challenge.challengeToken !== 'string'
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(challenge.challengeToken)
    || challenge.iterations !== 210000
    || challenge.hash !== 'SHA-256'
    || !Number.isSafeInteger(challenge.expiresAt)) {
    throw new Error('登录挑战无效');
  }
  const salt = decodeSalt(challenge.salt);
  if (challenge.expiresAt <= Math.floor(nowMs / 1000)) {
    throw new ChallengeExpiredError('登录请求已过期，请重试');
  }

  const passwordBytes = encoder.encode(password);
  let derived;
  try {
    const passwordKey = await cryptoImpl.subtle.importKey(
      'raw', passwordBytes, 'PBKDF2', false, ['deriveBits']
    );
    derived = new Uint8Array(await cryptoImpl.subtle.deriveBits({
      name: 'PBKDF2',
      salt,
      iterations: challenge.iterations,
      hash: challenge.hash
    }, passwordKey, 256));
    const proofKey = await cryptoImpl.subtle.importKey(
      'raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const proof = new Uint8Array(await cryptoImpl.subtle.sign(
      'HMAC', proofKey, encoder.encode(challenge.challengeToken)
    ));
    return encodeBase64Url(proof);
  } catch {
    throw new Error('登录验证失败');
  } finally {
    passwordBytes.fill(0);
    derived?.fill(0);
  }
}
