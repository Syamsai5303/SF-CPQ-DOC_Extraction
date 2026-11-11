import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { SalesforceError } from '../lib/salesforce.js';
import { requireAuth } from '../middleware/auth.js';
import { connectionMetaSchema, credentialInputSchema, testInputSchema } from '../validators.js';
import {
  CredentialsUnreadableError,
  flagUnreadable,
  createVerified,
  deleteConnection,
  getOwnedConnection,
  listConnections,
  recordTestResult,
  resolveInput,
  resolveSaved,
  setActive,
  testResolved,
  toPublic,
  updateVerified,
} from '../services/connection.service.js';

const router = Router();
router.use(requireAuth);

// Each test opens a real Salesforce session; keep it modest per user.
const sfLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many connection tests, please wait a minute' },
});

const sfFailure = (err) => (err instanceof SalesforceError ? new HttpError(400, err.message) : err);

async function testOrThrow(resolved) {
  try {
    return await testResolved(resolved);
  } catch (err) {
    throw sfFailure(err);
  }
}

async function listPayload(userId) {
  const [connections, user] = await Promise.all([
    listConnections(userId),
    prisma.user.findUnique({ where: { id: userId }, select: { activeConnectionId: true } }),
  ]);
  return { connections: connections.map(toPublic), activeConnectionId: user.activeConnectionId };
}

/** GET /api/salesforce/connections — all of the user's orgs + which one is active. */
router.get('/connections', async (req, res) => {
  res.json(await listPayload(req.user.id));
});

/** POST /api/salesforce/connections — test against Salesforce, then encrypt + create. */
router.post('/connections', sfLimiter, async (req, res) => {
  const meta = connectionMetaSchema.parse(req.body);
  const input = credentialInputSchema.parse(req.body);
  const resolved = resolveInput(input, null);
  const info = await testOrThrow(resolved); // not saved when the test fails
  const created = await createVerified(req.user.id, meta, resolved, info);
  res.status(201).json({ connection: toPublic(created), testResult: info, ...(await listPayload(req.user.id)) });
});

/** PUT /api/salesforce/connections/:id — update (blank secrets keep saved values), re-tested first. */
router.put('/connections/:id', sfLimiter, async (req, res) => {
  const existing = await getOwnedConnection(req.user.id, req.params.id);
  const meta = connectionMetaSchema.parse(req.body);
  const input = credentialInputSchema.parse(req.body);
  const resolved = resolveInput(input, existing);
  const info = await testOrThrow(resolved);
  const updated = await updateVerified(req.user.id, existing, meta, resolved, info);
  res.json({ connection: toPublic(updated), testResult: info, ...(await listPayload(req.user.id)) });
});

/** DELETE /api/salesforce/connections/:id — also deletes its extractions and reports (cascade). */
router.delete('/connections/:id', async (req, res) => {
  await deleteConnection(req.user.id, req.params.id);
  res.json({ ok: true, ...(await listPayload(req.user.id)) });
});

/** POST /api/salesforce/connections/:id/activate — org switcher. */
router.post('/connections/:id/activate', async (req, res) => {
  await setActive(req.user.id, req.params.id);
  res.json(await listPayload(req.user.id));
});

/** POST /api/salesforce/connections/:id/test — re-test saved credentials and record the result. */
router.post('/connections/:id/test', sfLimiter, async (req, res) => {
  const existing = await getOwnedConnection(req.user.id, req.params.id);
  let resolved;
  try {
    resolved = resolveSaved(existing);
  } catch (err) {
    if (err instanceof CredentialsUnreadableError) await flagUnreadable(existing, err);
    throw err;
  }
  try {
    const info = await testResolved(resolved);
    const updated = await recordTestResult(existing.id, info);
    res.json({ ok: true, testResult: info, connection: toPublic(updated) });
  } catch (err) {
    if (err instanceof SalesforceError) await recordTestResult(existing.id, null, err.message);
    throw sfFailure(err);
  }
});

/**
 * POST /api/salesforce/test — test credentials from the form without saving.
 * Pass `connectionId` when editing so blank secret fields reuse that connection's saved values.
 */
router.post('/test', sfLimiter, async (req, res) => {
  const input = testInputSchema.parse(req.body);
  const existing = input.connectionId ? await getOwnedConnection(req.user.id, input.connectionId) : null;
  const info = await testOrThrow(resolveInput(input, existing));
  res.json({ ok: true, testResult: info });
});

export default router;
