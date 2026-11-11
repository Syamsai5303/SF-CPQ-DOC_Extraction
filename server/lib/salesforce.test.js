import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'x'.repeat(32);
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';

const { normalizeLoginUrl, normalizeTokenUrl } = await import('./salesforce.js');

test('accepts Salesforce login hosts and strips paths', () => {
  assert.equal(normalizeLoginUrl('https://login.salesforce.com/'), 'https://login.salesforce.com');
  assert.equal(normalizeLoginUrl('https://acme.my.salesforce.com/x'), 'https://acme.my.salesforce.com');
  assert.equal(normalizeLoginUrl('https://acme--uat.sandbox.my.salesforce.com'), 'https://acme--uat.sandbox.my.salesforce.com');
});

test('rejects non-https and non-Salesforce hosts (SSRF guard)', () => {
  assert.throws(() => normalizeLoginUrl('http://login.salesforce.com'));
  assert.throws(() => normalizeLoginUrl('https://169.254.169.254'));
  assert.throws(() => normalizeLoginUrl('https://evilsalesforce.com'));
  assert.throws(() => normalizeLoginUrl('https://salesforce.com.evil.io'));
  assert.throws(() => normalizeLoginUrl('https://user:pw@login.salesforce.com'));
});

test('token URL normalisation', () => {
  assert.equal(normalizeTokenUrl('https://acme.my.salesforce.com'), 'https://acme.my.salesforce.com/services/oauth2/token');
  assert.equal(
    normalizeTokenUrl('https://acme.my.salesforce.com/services/oauth2/token'),
    'https://acme.my.salesforce.com/services/oauth2/token',
  );
  assert.throws(() => normalizeTokenUrl('https://acme.my.salesforce.com/services/oauth2/authorize'));
});
