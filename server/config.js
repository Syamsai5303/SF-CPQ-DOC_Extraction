import 'dotenv/config';
import { keyId, parseKey } from './lib/crypto.js';

/**
 * Centralised, validated configuration. The process refuses to start with
 * weak or missing secrets so misconfiguration is caught at boot, not at runtime.
 */
function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

const JWT_SECRET = required('JWT_SECRET');
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}

const ENCRYPTION_KEY = parseKey(required('ENCRYPTION_KEY'));
// Key rotation: old keys (comma-separated) that can still DECRYPT. Values are re-encrypted
// with ENCRYPTION_KEY the next time they are used. Remove once nothing uses them.
const ENCRYPTION_KEYS_PREVIOUS = (process.env.ENCRYPTION_KEY_PREVIOUS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((k, i) => {
    try {
      return parseKey(k);
    } catch {
      throw new Error(`ENCRYPTION_KEY_PREVIOUS entry #${i + 1} is not a valid 32-byte key`);
    }
  });

const DEFAULT_SF_HOST_SUFFIXES = [
  'salesforce.com',
  'force.com',
  'cloudforce.com',
  'salesforce.mil',
  'sfcrmproducts.cn',
  'salesforce-setup.com',
];

export const config = {
  env: NODE_ENV,
  isProd: NODE_ENV === 'production',
  isDev: NODE_ENV === 'development',
  port: Number(process.env.PORT) || 3000,
  appUrl: APP_URL,
  databaseUrl: required('DATABASE_URL'),

  jwt: {
    secret: JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    cookieName: 'cpq_session',
  },
  // Secure cookies whenever the public URL is https (App Runner / ALB), unless overridden.
  cookieSecure:
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === 'true'
      : APP_URL.startsWith('https://'),

  /** Encrypts all new secrets. */
  encryptionKey: ENCRYPTION_KEY,
  /** Tried in order when decrypting: current key first, then previous keys. */
  encryptionKeys: [ENCRYPTION_KEY, ...ENCRYPTION_KEYS_PREVIOUS],
  encryptionKeyId: keyId(ENCRYPTION_KEY),

  bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 12,
  resetTokenTtlMinutes: Number(process.env.RESET_TOKEN_TTL_MINUTES) || 30,

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'CPQ to RCA <no-reply@localhost>',
  },

  salesforce: {
    apiVersion: process.env.SF_API_VERSION || '62.0',
    timeoutMs: Number(process.env.SF_TIMEOUT_MS) || 20000,
    // Only these host suffixes may be contacted (prevents SSRF via user-supplied URLs).
    allowedHostSuffixes: (process.env.SF_ALLOWED_HOST_SUFFIXES || DEFAULT_SF_HOST_SUFFIXES.join(','))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },

  // Number of reverse proxies in front of the app (App Runner / ALB = 1).
  trustProxy: process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : NODE_ENV === 'production' ? 1 : 0,
};
