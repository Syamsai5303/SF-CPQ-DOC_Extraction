import { config } from '../config.js';
import { prisma } from '../db.js';
import { conflict, fieldError, HttpError, notFound } from '../lib/errors.js';
import { DecryptionError, decryptJsonWithMeta, encryptJson } from '../lib/crypto.js';
import {
  connectClientCredentials,
  connectUsernamePassword,
  normalizeLoginUrl,
  normalizeTokenUrl,
  SalesforceError,
  testClientCredentials,
  testUsernamePassword,
} from '../lib/salesforce.js';

// The userId is used as AAD so a ciphertext can only be decrypted for its owner.
const seal = (userId, secrets) => encryptJson(secrets, config.encryptionKey, userId);

/** What users see when stored secrets can't be decrypted (e.g. ENCRYPTION_KEY changed). */
export const UNREADABLE_MESSAGE = 'Stored credentials could not be decrypted. Please re-enter and save your Salesforce connection.';

/** Raised (as HTTP 409) when an action needs secrets that can no longer be decrypted. */
export class CredentialsUnreadableError extends HttpError {
  constructor(connection, cause) {
    super(409, UNREADABLE_MESSAGE);
    this.code = 'CREDENTIALS_UNREADABLE';
    this.connectionId = connection?.id;
    this.detail = cause?.message;
  }
}

/**
 * Decrypts a record's secrets with the current key or any ENCRYPTION_KEY_PREVIOUS key.
 * Values found under an old key (or the legacy v1 format) are re-encrypted with the
 * current key in the background, so a rotation completes itself as connections are used.
 */
function unseal(record) {
  const { value, needsReencrypt } = decryptJsonWithMeta(record.encryptedCredentials, config.encryptionKeys, record.userId);
  if (needsReencrypt && record.id) {
    prisma.salesforceConnection
      .update({ where: { id: record.id }, data: { encryptedCredentials: seal(record.userId, value) } })
      .catch((err) => console.warn(`[crypto] re-encrypting connection ${record.id} failed:`, err.message));
  }
  return value;
}

/** Like unseal, but converts decryption failures into an actionable, user-facing error. */
function unsealOrExplain(record) {
  try {
    return unseal(record);
  } catch (err) {
    if (err instanceof DecryptionError) throw new CredentialsUnreadableError(record, err);
    throw err;
  }
}

/** Marks a connection as needing re-entry so the UI can prompt the user. */
export function flagUnreadable(record, err) {
  console.warn(`[crypto] connection ${record.id} (${record.name ?? 'unnamed'}): ${err?.detail ?? err?.message ?? 'decryption failed'}`);
  return prisma.salesforceConnection
    .update({ where: { id: record.id }, data: { status: 'FAILED', lastError: UNREADABLE_MESSAGE } })
    .catch(() => {});
}

/**
 * Startup check: finds connections whose secrets the configured key(s) can't decrypt,
 * flags them for re-entry and logs one clear operator warning (instead of failing
 * later, mid-extraction, with an opaque crypto error).
 */
export async function checkStoredCredentials() {
  const rows = await prisma.salesforceConnection.findMany({ select: { id: true, userId: true, name: true, status: true, lastError: true, encryptedCredentials: true } });
  const bad = [];
  for (const r of rows) {
    try {
      unseal(r);
    } catch (err) {
      if (!(err instanceof DecryptionError)) throw err;
      bad.push({ r, err });
    }
  }
  for (const { r } of bad) {
    if (r.status !== 'FAILED' || r.lastError !== UNREADABLE_MESSAGE) {
      await prisma.salesforceConnection.update({ where: { id: r.id }, data: { status: 'FAILED', lastError: UNREADABLE_MESSAGE } });
    }
  }
  if (bad.length) {
    const reasons = [...new Set(bad.map(({ err }) => err.reason))].join(', ');
    console.warn(
      `[crypto] ${bad.length} of ${rows.length} Salesforce connection(s) cannot be decrypted with the configured ENCRYPTION_KEY (id ${config.encryptionKeyId}; reason: ${reasons}). ` +
        'They were flagged for re-entry. If ENCRYPTION_KEY was changed, set the old value as ENCRYPTION_KEY_PREVIOUS to recover them.',
    );
  }
  return { total: rows.length, unreadable: bad.length };
}

export const listConnections = (userId) =>
  prisma.salesforceConnection.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }] });

/** Loads a connection and enforces ownership (404 for other users' ids). */
export async function getOwnedConnection(userId, id) {
  const record = await prisma.salesforceConnection.findFirst({ where: { id, userId } });
  if (!record) throw notFound('Salesforce connection not found');
  return record;
}

/** Shape returned to the browser: metadata + "is a secret stored" flags, never secret values. */
export function toPublic(record) {
  let secrets = {};
  let decryptable = true;
  try {
    secrets = unseal(record);
  } catch {
    decryptable = false; // e.g. ENCRYPTION_KEY changed since the secrets were saved
  }
  return {
    id: record.id,
    name: record.name,
    environmentType: record.environmentType,
    authType: record.authType,
    status: decryptable ? record.status : 'FAILED',
    loginUrl: record.loginUrl,
    sfUsername: record.sfUsername,
    clientId: record.clientId,
    tokenUrl: record.tokenUrl,
    orgId: record.orgId,
    sfUserId: record.sfUserId,
    instanceUrl: record.instanceUrl,
    lastVerified: record.lastVerified,
    lastError: decryptable ? record.lastError : UNREADABLE_MESSAGE,
    // false => the UI asks the user to re-enter and save the credentials
    credentialsReadable: decryptable,
    hasPassword: Boolean(secrets.password),
    hasSecurityToken: Boolean(secrets.securityToken),
    hasClientSecret: Boolean(secrets.clientSecret),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Turns validated form input into a complete credential set. Blank secret fields
 * fall back to the saved (decrypted) secrets of `existing` for the same auth type,
 * so the user can edit e.g. the login URL without re-typing their password.
 */
export function resolveInput(input, existing) {
  let saved = {};
  if (existing && existing.authType === input.authType) {
    try {
      saved = unseal(existing);
    } catch {
      saved = {};
    }
  }

  const normalize = (fn, raw, field) => {
    try {
      return fn(raw);
    } catch (err) {
      if (err instanceof SalesforceError) throw fieldError(field, err.message);
      throw err;
    }
  };

  if (input.authType === 'USERNAME_PASSWORD') {
    const password = input.password || saved.password;
    if (!password) throw fieldError('password', 'Password is required');
    return {
      authType: input.authType,
      meta: {
        loginUrl: normalize(normalizeLoginUrl, input.loginUrl, 'loginUrl'),
        sfUsername: input.username,
        clientId: null,
        tokenUrl: null,
      },
      secrets: { password, securityToken: input.securityToken || saved.securityToken || '' },
    };
  }

  const clientSecret = input.clientSecret || saved.clientSecret;
  if (!clientSecret) throw fieldError('clientSecret', 'Client Secret is required');
  return {
    authType: input.authType,
    meta: {
      tokenUrl: normalize(normalizeTokenUrl, input.tokenUrl, 'tokenUrl'),
      clientId: input.clientId,
      loginUrl: null,
      sfUsername: null,
    },
    secrets: { clientSecret },
  };
}

export function resolveSaved(record) {
  return {
    authType: record.authType,
    meta: { loginUrl: record.loginUrl, sfUsername: record.sfUsername, clientId: record.clientId, tokenUrl: record.tokenUrl },
    secrets: unsealOrExplain(record),
  };
}

/** Opens a real connection to Salesforce and reports identity. Throws SalesforceError on failure. */
export function testResolved({ authType, meta, secrets }) {
  return authType === 'USERNAME_PASSWORD'
    ? testUsernamePassword({ loginUrl: meta.loginUrl, username: meta.sfUsername, ...secrets })
    : testClientCredentials({ tokenUrl: meta.tokenUrl, clientId: meta.clientId, ...secrets });
}

/** Opens a live jsforce connection from a saved record (used by the catalog extractor). */
export function openSavedConnection(record) {
  const { authType, meta, secrets } = resolveSaved(record);
  return authType === 'USERNAME_PASSWORD'
    ? connectUsernamePassword({ loginUrl: meta.loginUrl, username: meta.sfUsername, ...secrets })
    : connectClientCredentials({ tokenUrl: meta.tokenUrl, clientId: meta.clientId, ...secrets });
}

function verifiedData(userId, resolved, info) {
  return {
    authType: resolved.authType,
    ...resolved.meta,
    // For OAuth, record which integration user Salesforce authenticated as.
    sfUsername: resolved.authType === 'USERNAME_PASSWORD' ? resolved.meta.sfUsername : info.sfUsername,
    encryptedCredentials: seal(userId, resolved.secrets),
    status: 'ACTIVE',
    orgId: info.orgId,
    sfUserId: info.sfUserId,
    instanceUrl: info.instanceUrl,
    lastVerified: new Date(),
    lastError: null,
  };
}

async function assertNameFree(userId, name, exceptId) {
  const clash = await prisma.salesforceConnection.findFirst({
    where: { userId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw Object.assign(conflict(`You already have a connection named "${name}"`), { fields: { name: 'Name already in use' } });
}

/** Creates a verified connection. The first connection becomes the active org automatically. */
export async function createVerified(userId, { name, environmentType }, resolved, info) {
  await assertNameFree(userId, name);
  return prisma.$transaction(async (tx) => {
    const created = await tx.salesforceConnection.create({
      data: { userId, name, environmentType, ...verifiedData(userId, resolved, info) },
    });
    const user = await tx.user.findUnique({ where: { id: userId }, select: { activeConnectionId: true } });
    if (!user.activeConnectionId) {
      await tx.user.update({ where: { id: userId }, data: { activeConnectionId: created.id } });
    }
    return created;
  });
}

export async function updateVerified(userId, existing, { name, environmentType }, resolved, info) {
  await assertNameFree(userId, name, existing.id);
  return prisma.salesforceConnection.update({
    where: { id: existing.id },
    data: { name, environmentType, ...verifiedData(userId, resolved, info) },
  });
}

export function recordTestResult(id, info, error) {
  return prisma.salesforceConnection.update({
    where: { id },
    data: info
      ? { status: 'ACTIVE', orgId: info.orgId, sfUserId: info.sfUserId, instanceUrl: info.instanceUrl, lastVerified: new Date(), lastError: null }
      : { status: 'FAILED', lastError: String(error).slice(0, 1000) },
  });
}

export async function setActive(userId, connectionId) {
  if (connectionId) await getOwnedConnection(userId, connectionId);
  await prisma.user.update({ where: { id: userId }, data: { activeConnectionId: connectionId } });
}

/** Deletes a connection; if it was active, the oldest remaining connection becomes active. */
export async function deleteConnection(userId, id) {
  await getOwnedConnection(userId, id);
  return prisma.$transaction(async (tx) => {
    await tx.salesforceConnection.delete({ where: { id } });
    const user = await tx.user.findUnique({ where: { id: userId }, select: { activeConnectionId: true } });
    if (!user.activeConnectionId) {
      const next = await tx.salesforceConnection.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
      if (next) await tx.user.update({ where: { id: userId }, data: { activeConnectionId: next.id } });
      return next?.id ?? null;
    }
    return user.activeConnectionId;
  });
}
