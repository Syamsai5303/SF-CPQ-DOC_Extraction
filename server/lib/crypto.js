import crypto from 'node:crypto';

/**
 * AES-256-GCM symmetric encryption for secrets at rest.
 *
 * Current format (v2):  v2:<keyId>:<iv b64>:<authTag b64>:<ciphertext b64>
 * Legacy format (v1):   v1:<iv b64>:<authTag b64>:<ciphertext b64>        (still decrypted)
 *
 *  - 12-byte random IV per encryption (GCM recommended size)
 *  - 16-byte auth tag => tampering, or the wrong key, is detected on decrypt
 *  - keyId = first 8 hex chars of SHA-256(key). Not secret; it identifies WHICH key
 *    encrypted a value, so a key mismatch is reported precisely and key rotation works.
 *  - Optional AAD (the owning userId) binds a ciphertext to its owner, so a row copied
 *    onto another user's record fails to decrypt.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Thrown for every decryption failure; `reason` lets callers react precisely. */
export class DecryptionError extends Error {
  /**
   * @param {string} message
   * @param {'MALFORMED' | 'KEY_MISMATCH' | 'AUTH_FAILED'} reason
   */
  constructor(message, reason) {
    super(message);
    this.name = 'DecryptionError';
    this.reason = reason;
  }
}

/**
 * Parses an ENCRYPTION_KEY value into exactly 32 bytes.
 * Accepts 64 hex chars (recommended) or base64/base64url that decodes to 32 bytes.
 * Surrounding quotes/whitespace are ignored. Anything else is rejected rather than
 * hashed: silently deriving a key from a typo'd value would make every stored secret
 * undecryptable without any hint why.
 */
export function parseKey(raw) {
  const value = String(raw ?? '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const buf = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === 32) return buf;
  }
  throw new Error('ENCRYPTION_KEY must be 32 bytes: 64 hex characters (recommended, see `npm run gen:secrets`) or base64');
}

/** Non-secret fingerprint of a key, stored with each ciphertext. */
export const keyId = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Encryption key must be a 32-byte Buffer');
  }
}

const toKeyList = (keys) => (Array.isArray(keys) ? keys : [keys]).filter(Boolean);

function b64(part, label, expectedLength) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(part)) {
    throw new DecryptionError(`Stored secret is corrupt: ${label} is not valid base64`, 'MALFORMED');
  }
  const buf = Buffer.from(part, 'base64');
  if (expectedLength !== undefined && buf.length !== expectedLength) {
    throw new DecryptionError(`Stored secret is corrupt: ${label} must be ${expectedLength} bytes, got ${buf.length}`, 'MALFORMED');
  }
  return buf;
}

/** Splits and validates a payload before any crypto runs. */
export function parsePayload(payload) {
  const parts = String(payload ?? '').split(':');
  let version;
  let kid = null;
  let rest;
  if (parts[0] === 'v2' && parts.length === 5) {
    version = 2;
    kid = parts[1];
    rest = parts.slice(2);
    if (!/^[0-9a-f]{8}$/.test(kid)) throw new DecryptionError('Stored secret is corrupt: invalid key id', 'MALFORMED');
  } else if (parts[0] === 'v1' && parts.length === 4) {
    version = 1;
    rest = parts.slice(1);
  } else {
    throw new DecryptionError('Stored secret has an unsupported format', 'MALFORMED');
  }
  return {
    version,
    kid,
    iv: b64(rest[0], 'IV', IV_LENGTH),
    tag: b64(rest[1], 'auth tag', TAG_LENGTH),
    data: b64(rest[2], 'ciphertext'),
  };
}

export function encrypt(plaintext, key, aad) {
  assertKey(key);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v2', keyId(key), iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function tryDecrypt(parsed, key, aad) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, parsed.iv, { authTagLength: TAG_LENGTH });
  if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(parsed.tag);
  return Buffer.concat([decipher.update(parsed.data), decipher.final()]).toString('utf8');
}

/**
 * Decrypts with the first matching key.
 * @param {string} payload
 * @param {Buffer | Buffer[]} keys  current key first, then any previous keys (rotation)
 * @param {string} [aad]
 * @returns {{ plaintext: string, keyIndex: number, needsReencrypt: boolean }}
 *   needsReencrypt is true for legacy v1 payloads or ones decrypted with a previous key.
 */
export function decryptWithMeta(payload, keys, aad) {
  const list = toKeyList(keys);
  list.forEach(assertKey);
  const parsed = parsePayload(payload);

  const candidates = list.map((key, index) => ({ key, index })).filter(({ key }) => parsed.version === 1 || keyId(key) === parsed.kid);
  if (!candidates.length) {
    throw new DecryptionError(
      `Stored secret was encrypted with a different ENCRYPTION_KEY (key id ${parsed.kid}; configured: ${list.map(keyId).join(', ')}).`,
      'KEY_MISMATCH',
    );
  }
  for (const { key, index } of candidates) {
    try {
      return { plaintext: tryDecrypt(parsed, key, aad), keyIndex: index, needsReencrypt: parsed.version === 1 || index > 0 };
    } catch {
      // try the next candidate key
    }
  }
  throw parsed.version === 1
    ? new DecryptionError('Stored secret could not be decrypted: it was saved with a different ENCRYPTION_KEY (or was altered).', 'KEY_MISMATCH')
    : new DecryptionError('Stored secret failed authentication: it was altered or belongs to a different record.', 'AUTH_FAILED');
}

export const decrypt = (payload, keys, aad) => decryptWithMeta(payload, keys, aad).plaintext;

export const encryptJson = (obj, key, aad) => encrypt(JSON.stringify(obj), key, aad);
export const decryptJson = (payload, keys, aad) => JSON.parse(decrypt(payload, keys, aad));
export function decryptJsonWithMeta(payload, keys, aad) {
  const { plaintext, ...meta } = decryptWithMeta(payload, keys, aad);
  return { value: JSON.parse(plaintext), ...meta };
}

/** URL-safe random token (used for password reset links). */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** One-way hash for storing tokens: only the hash is persisted, never the raw token. */
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
