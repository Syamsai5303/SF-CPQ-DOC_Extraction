import jsforce from 'jsforce';
import { config } from '../config.js';

export class SalesforceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * User-supplied URLs are only ever contacted if they are https and belong to a
 * Salesforce domain. This stops the "test connection" feature being abused as
 * an SSRF proxy into the VPC (e.g. http://169.254.169.254).
 */
export function assertSalesforceUrl(raw, label = 'URL') {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new SalesforceError(`${label} is not a valid URL`, 'INVALID_URL');
  }
  if (url.protocol !== 'https:') {
    throw new SalesforceError(`${label} must use https://`, 'INVALID_URL');
  }
  const host = url.hostname.toLowerCase();
  const ok = config.salesforce.allowedHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
  if (!ok) {
    throw new SalesforceError(
      `${label} must be a Salesforce domain (e.g. login.salesforce.com, test.salesforce.com or <mydomain>.my.salesforce.com)`,
      'INVALID_URL',
    );
  }
  if (url.username || url.password) {
    throw new SalesforceError(`${label} must not contain credentials`, 'INVALID_URL');
  }
  return url;
}

/** https://login.salesforce.com/anything -> https://login.salesforce.com */
export function normalizeLoginUrl(raw) {
  return assertSalesforceUrl(raw, 'Login URL').origin;
}

/** Accepts a My Domain base URL or the full token endpoint; returns the token endpoint. */
export function normalizeTokenUrl(raw) {
  const url = assertSalesforceUrl(raw, 'Token URL');
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '' || path === '/') return `${url.origin}/services/oauth2/token`;
  if (!/\/services\/oauth2\/token$/.test(path)) {
    throw new SalesforceError('Token URL path must be /services/oauth2/token (or omit the path)', 'INVALID_URL');
  }
  return `${url.origin}${path}`;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SalesforceError(`${what} timed out after ${ms / 1000}s`, 'TIMEOUT')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function friendly(err) {
  if (err instanceof SalesforceError) return err;
  const raw = err?.message || String(err);
  const code = err?.errorCode || err?.name || 'SALESFORCE_ERROR';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return new SalesforceError('Could not reach Salesforce: the host name does not resolve. Check the URL / My Domain.', 'NETWORK');
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(raw)) {
    return new SalesforceError('Could not reach Salesforce (network error). Try again shortly.', 'NETWORK');
  }
  return new SalesforceError(raw.replace(/^[A-Z_]+:\s*/, '') || 'Salesforce rejected the credentials', code);
}

async function describeConnection(conn) {
  const identity = await conn.identity();
  return {
    orgId: identity.organization_id,
    sfUserId: identity.user_id,
    sfUsername: identity.username,
    displayName: identity.display_name,
    instanceUrl: conn.instanceUrl,
  };
}

/** Option A: Username + Password + Security Token (SOAP login via jsforce). Returns a live connection. */
export async function connectUsernamePassword({ loginUrl, username, password, securityToken }) {
  const conn = new jsforce.Connection({
    loginUrl: normalizeLoginUrl(loginUrl),
    version: config.salesforce.apiVersion,
  });
  try {
    await withTimeout(conn.login(username, `${password}${securityToken || ''}`), config.salesforce.timeoutMs, 'Salesforce login');
    const info = await withTimeout(describeConnection(conn), config.salesforce.timeoutMs, 'Identity lookup');
    return { conn, info };
  } catch (err) {
    throw friendly(err);
  }
}

/** Option B: Connected App / External Client App using the OAuth 2.0 Client Credentials flow. */
export async function connectClientCredentials({ tokenUrl, clientId, clientSecret }) {
  const endpoint = normalizeTokenUrl(tokenUrl);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      redirect: 'error',
      signal: AbortSignal.timeout(config.salesforce.timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const desc = body.error_description || body.error || `HTTP ${res.status}`;
      const hint =
        body.error === 'invalid_grant' || /request not supported on this domain/i.test(desc)
          ? ' (Client Credentials requires your My Domain URL, e.g. https://<mydomain>.my.salesforce.com, and a Run-As user configured on the Connected App.)'
          : '';
      throw new SalesforceError(`OAuth token request failed: ${desc}${hint}`, body.error || 'OAUTH_ERROR');
    }
    // The instance URL is returned by Salesforce; validate it before we call it.
    const instanceUrl = assertSalesforceUrl(body.instance_url, 'Instance URL').origin;
    const conn = new jsforce.Connection({ instanceUrl, accessToken: body.access_token, version: config.salesforce.apiVersion });
    const info = await withTimeout(describeConnection(conn), config.salesforce.timeoutMs, 'Identity lookup');
    return { conn, info };
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new SalesforceError('OAuth token request timed out', 'TIMEOUT');
    throw friendly(err);
  }
}

/** Test-only variants: connect, report identity, and release the session. */
export async function testUsernamePassword(input) {
  const { conn, info } = await connectUsernamePassword(input);
  conn.logout().catch(() => {});
  return info;
}

export async function testClientCredentials(input) {
  const { info } = await connectClientCredentials(input);
  return info;
}
