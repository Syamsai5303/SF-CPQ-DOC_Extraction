import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decrypt,
  decryptJson,
  decryptWithMeta,
  DecryptionError,
  encrypt,
  encryptJson,
  keyId,
  parseKey,
  parsePayload,
  sha256,
} from './crypto.js';

const key = crypto.randomBytes(32);
const otherKey = crypto.randomBytes(32);

/** Builds a legacy v1 payload exactly like the Step 1 code did. */
function encryptV1(plaintext, k, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

const expectDecryptionError = (fn, reason, pattern) =>
  assert.throws(fn, (err) => err instanceof DecryptionError && err.reason === reason && (!pattern || pattern.test(err.message)));

test('round-trips plaintext in the v2 format with a key id', () => {
  const ct = encrypt('s3cr3t-value', key, 'user-1');
  const [v, kid] = ct.split(':');
  assert.equal(v, 'v2');
  assert.equal(kid, keyId(key));
  assert.equal(decrypt(ct, key, 'user-1'), 's3cr3t-value');
});

test('uses a fresh IV every time', () => {
  assert.notEqual(encrypt('same', key), encrypt('same', key));
});

test('round-trips JSON', () => {
  const obj = { password: 'p', securityToken: 't' };
  assert.deepEqual(decryptJson(encryptJson(obj, key, 'u'), key, 'u'), obj);
});

test('still decrypts legacy v1 payloads and asks for re-encryption', () => {
  const legacy = encryptV1('old-secret', key, 'user-1');
  const r = decryptWithMeta(legacy, [key], 'user-1');
  assert.equal(r.plaintext, 'old-secret');
  assert.equal(r.needsReencrypt, true);
});

test('key rotation: decrypts with a previous key and flags re-encryption', () => {
  const ct = encrypt('rotate-me', otherKey, 'u');
  const r = decryptWithMeta(ct, [key, otherKey], 'u');
  assert.equal(r.plaintext, 'rotate-me');
  assert.equal(r.keyIndex, 1);
  assert.equal(r.needsReencrypt, true);
  assert.equal(decryptWithMeta(encrypt('x', key, 'u'), [key, otherKey], 'u').needsReencrypt, false);
});

test('wrong key gives a precise KEY_MISMATCH error naming both key ids (v2)', () => {
  const ct = encrypt('x', otherKey, 'u');
  expectDecryptionError(() => decrypt(ct, key, 'u'), 'KEY_MISMATCH', new RegExp(`${keyId(otherKey)}.*${keyId(key)}`));
});

test('wrong key on a legacy v1 payload is reported as KEY_MISMATCH, not a raw crypto error', () => {
  const legacy = encryptV1('x', otherKey, 'u');
  expectDecryptionError(() => decrypt(legacy, key, 'u'), 'KEY_MISMATCH', /different ENCRYPTION_KEY/);
});

test('wrong AAD (ciphertext moved to another user) fails authentication', () => {
  const ct = encrypt('x', key, 'user-1');
  expectDecryptionError(() => decrypt(ct, key, 'user-2'), 'AUTH_FAILED');
});

test('detects tampering', () => {
  const [v, kid, iv, tag, data] = encrypt('hello world', key).split(':');
  const buf = Buffer.from(data, 'base64');
  buf[0] ^= 0xff;
  expectDecryptionError(() => decrypt([v, kid, iv, tag, buf.toString('base64')].join(':'), key), 'AUTH_FAILED');
});

test('validates structure and lengths before running any crypto', () => {
  const [v, kid, iv, tag, data] = encrypt('x', key).split(':');
  expectDecryptionError(() => parsePayload('garbage'), 'MALFORMED');
  expectDecryptionError(() => parsePayload([v, kid, iv, data].join(':')), 'MALFORMED'); // missing part
  expectDecryptionError(() => parsePayload([v, kid, Buffer.alloc(8).toString('base64'), tag, data].join(':')), 'MALFORMED', /IV must be 12 bytes/);
  expectDecryptionError(() => parsePayload([v, kid, iv, Buffer.alloc(4).toString('base64'), data].join(':')), 'MALFORMED', /auth tag must be 16 bytes/);
  expectDecryptionError(() => parsePayload([v, kid, iv, '***', data].join(':')), 'MALFORMED', /not valid base64/);
  expectDecryptionError(() => parsePayload([v, 'ZZZZ', iv, tag, data].join(':')), 'MALFORMED', /key id/);
});

test('parseKey accepts hex, base64 and quoted values; rejects anything else', () => {
  const hex = key.toString('hex');
  assert.deepEqual(parseKey(hex), key);
  assert.deepEqual(parseKey(hex.toUpperCase()), key);
  assert.deepEqual(parseKey(`  "${hex}"  `), key);
  assert.deepEqual(parseKey(key.toString('base64')), key);
  assert.deepEqual(parseKey(key.toString('base64url')), key);
  assert.throws(() => parseKey('too-short'));
  assert.throws(() => parseKey(hex.slice(0, 62)));
  assert.throws(() => parseKey(''));
});

test('sha256 is deterministic hex', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
