import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../db.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { extractCatalogSchema, generateAssessmentSchema } from '../validators.js';
import { CredentialsUnreadableError, flagUnreadable, getOwnedConnection, resolveSaved } from '../services/connection.service.js';
import { buildBundleTree, indexCatalog } from '../services/cpqCatalogExtractor.ts';
import {
  extractionSelect,
  forgetCatalog,
  getCatalogGz,
  JobError,
  loadCatalog,
  startAssessment,
  startExtraction,
} from '../services/cpqJobs.ts';
import { GEMINI_MODEL, isGeminiConfigured } from '../services/geminiService.ts';
import { renderAssessmentDocument } from '../services/docGenerator.ts';
import { getLogoForUser } from '../services/branding.js';

const router = Router();
router.use(requireAuth);

const jobLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many jobs started, please wait a few minutes' },
});

const asHttp = (err) => (err instanceof JobError ? new HttpError(err.status, err.message) : err);

async function ownedExtraction(userId, id, select = extractionSelect) {
  const row = await prisma.catalogExtraction.findFirst({ where: { id, userId }, select: { ...select, connectionId: true } });
  if (!row) throw notFound('Extraction not found');
  return row;
}

async function ownedSucceededExtraction(userId, id) {
  const row = await ownedExtraction(userId, id);
  if (row.status !== 'SUCCEEDED') throw badRequest('This extraction has not completed successfully');
  return row;
}

const slug = (s) => String(s || 'org').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'org';
const stamp = (d) => new Date(d).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

/** GET /api/cpq/status — feature availability for the UI. */
router.get('/status', (req, res) => {
  res.json({ geminiConfigured: isGeminiConfigured(), geminiModel: GEMINI_MODEL });
});

// ------------------------------------------------------------------ extraction

/** POST /api/cpq/extract-catalog — start an extraction for a connection (default: active org). */
router.post('/extract-catalog', jobLimiter, async (req, res) => {
  const { connectionId, includeInactive } = extractCatalogSchema.parse(req.body ?? {});
  let id = connectionId;
  if (!id) {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { activeConnectionId: true } });
    id = user?.activeConnectionId;
  }
  if (!id) throw badRequest('Select or add a Salesforce connection first');
  const connection = await getOwnedConnection(req.user.id, id);
  // Fail fast, before a job is created, if the stored secrets can't be decrypted.
  try {
    resolveSaved(connection);
  } catch (err) {
    if (err instanceof CredentialsUnreadableError) await flagUnreadable(connection, err);
    throw err;
  }
  try {
    const extraction = await startExtraction(req.user.id, connection, includeInactive);
    res.status(202).json({ extraction });
  } catch (err) {
    throw asHttp(err);
  }
});

/** GET /api/cpq/extractions?connectionId= — history (newest first), without the catalog blob. */
router.get('/extractions', async (req, res) => {
  const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
  if (connectionId) await getOwnedConnection(req.user.id, connectionId);
  const extractions = await prisma.catalogExtraction.findMany({
    where: { userId: req.user.id, ...(connectionId ? { connectionId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: { ...extractionSelect, summary: false },
  });
  res.json({ extractions });
});

/** GET /api/cpq/extractions/:id — status, live progress and summary (KPIs, flags, inventory). */
router.get('/extractions/:id', async (req, res) => {
  res.json({ extraction: await ownedExtraction(req.user.id, req.params.id) });
});

router.delete('/extractions/:id', async (req, res) => {
  const row = await ownedExtraction(req.user.id, req.params.id);
  if (row.status === 'RUNNING' || row.status === 'QUEUED') throw badRequest('Wait for the extraction to finish before deleting it');
  await prisma.catalogExtraction.delete({ where: { id: row.id } });
  forgetCatalog(row.id);
  res.json({ ok: true });
});

/** GET /api/cpq/extractions/:id/bundles?q=&offset=&limit=&sort=levels|options|name — bundle list for the explorer. */
router.get('/extractions/:id/bundles', async (req, res) => {
  const row = await ownedSucceededExtraction(req.user.id, req.params.id);
  const catalog = await loadCatalog(row.id);
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const sort = String(req.query.sort || 'levels');

  let bundles = catalog.catalog.products
    .filter((p) => p.bundle)
    .map((p) => ({
      productId: p.Id,
      name: p.Name,
      productCode: p.ProductCode ?? null,
      active: p.IsActive === true,
      levels: p.bundle.levels ?? 2,
      features: p.bundle.features.length,
      options: p.bundle.options.length,
      constraints: p.bundle.optionConstraints.length,
      rules: p.bundle.configurationRules.length,
      circularReference: Boolean(p.bundle.circularReference),
    }));
  if (q) bundles = bundles.filter((b) => String(b.name).toLowerCase().includes(q) || String(b.productCode ?? '').toLowerCase().includes(q));
  bundles.sort((a, b) =>
    sort === 'name' ? String(a.name).localeCompare(String(b.name)) : sort === 'options' ? b.options - a.options : b.levels - a.levels || b.options - a.options,
  );
  res.json({ total: bundles.length, offset, limit, bundles: bundles.slice(offset, offset + limit) });
});

/** GET /api/cpq/extractions/:id/bundles/:productId — nested Product -> Feature -> Option tree. */
router.get('/extractions/:id/bundles/:productId', async (req, res) => {
  const row = await ownedSucceededExtraction(req.user.id, req.params.id);
  const catalog = await loadCatalog(row.id);
  const index = indexCatalog(catalog);
  if (!index.productsById.get(req.params.productId)?.bundle) throw notFound('Bundle not found in this extraction');
  res.json({ tree: buildBundleTree(index, req.params.productId, { maxDepth: 8, budget: { nodes: 3_000 } }) });
});

/** GET /api/cpq/download-catalog-json?extractionId= — the raw hierarchical catalog JSON. */
router.get('/download-catalog-json', async (req, res) => {
  const extractionId = String(req.query.extractionId ?? '');
  if (!extractionId) throw badRequest('extractionId is required');
  const row = await ownedSucceededExtraction(req.user.id, extractionId);
  const connection = await prisma.salesforceConnection.findUnique({ where: { id: row.connectionId }, select: { name: true } });
  const gz = await getCatalogGz(row.id);
  const filename = `cpq-catalog-${slug(connection?.name)}-${stamp(row.createdAt)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  // Stored gzip-compressed: send as-is when the client accepts gzip (all browsers do).
  if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', gz.length);
    return res.end(gz);
  }
  const { gunzipSync } = await import('node:zlib');
  res.end(gunzipSync(gz));
});

// ------------------------------------------------------------------ assessment

/** POST /api/cpq/generate-assessment — start Gemini generation for a completed extraction. */
router.post('/generate-assessment', jobLimiter, async (req, res) => {
  if (!isGeminiConfigured()) throw new HttpError(503, 'AI assessment is not configured. Set GEMINI_API_KEY on the server.');
  const { extractionId } = generateAssessmentSchema.parse(req.body ?? {});
  const extraction = await ownedSucceededExtraction(req.user.id, extractionId);
  try {
    const assessment = await startAssessment(req.user.id, extraction);
    res.status(202).json({ assessment });
  } catch (err) {
    throw asHttp(err);
  }
});

const assessmentSelect = {
  id: true,
  extractionId: true,
  status: true,
  model: true,
  progress: true,
  promptTokens: true,
  outputTokens: true,
  error: true,
  createdAt: true,
  finishedAt: true,
};

router.get('/assessments', async (req, res) => {
  const extractionId = String(req.query.extractionId ?? '');
  if (!extractionId) throw badRequest('extractionId is required');
  await ownedExtraction(req.user.id, extractionId);
  const assessments = await prisma.assessmentReport.findMany({
    where: { userId: req.user.id, extractionId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: assessmentSelect,
  });
  res.json({ assessments });
});

async function ownedAssessment(userId, id, withMarkdown = true) {
  const row = await prisma.assessmentReport.findFirst({ where: { id, userId }, select: { ...assessmentSelect, markdown: withMarkdown } });
  if (!row) throw notFound('Assessment not found');
  return row;
}

router.get('/assessments/:id', async (req, res) => {
  res.json({ assessment: await ownedAssessment(req.user.id, req.params.id) });
});

/** GET /api/cpq/assessments/:id/document?format=docx|pdf — branded, downloadable document. */
router.get('/assessments/:id/document', async (req, res) => {
  const format = req.query.format === 'pdf' ? 'pdf' : 'docx';
  const assessment = await ownedAssessment(req.user.id, req.params.id);
  if (assessment.status !== 'SUCCEEDED' || !assessment.markdown) throw badRequest('The assessment has not finished generating');

  const extraction = await prisma.catalogExtraction.findUnique({ where: { id: assessment.extractionId }, select: { summary: true, createdAt: true } });
  const summary = extraction?.summary ?? {};
  const source = summary.source ?? {};
  const env = String(source.environmentType ?? '').toLowerCase();
  const orgLabel = `${source.connectionName ?? 'Salesforce org'}${env ? ` (${env.charAt(0).toUpperCase()}${env.slice(1)})` : ''}`;

  const buffer = await renderAssessmentDocument(format, {
    title: 'RCA Migration Assessment',
    subtitle: `${orgLabel}${source.orgId ? ` · Org ${source.orgId}` : ''}`,
    generatedAt: assessment.finishedAt ?? new Date(),
    markdown: assessment.markdown,
    logo: await getLogoForUser(req.user.id),
    modelNote: `Narrative sections were generated by ${assessment.model} from the extracted CPQ configuration and should be reviewed before distribution. Appendix tables come directly from the extraction.`,
    appendix: { kpis: summary.kpis, complexity: summary.complexity, inventory: summary.inventory },
  });

  const filename = `rca-migration-assessment-${slug(source.connectionName)}-${stamp(assessment.finishedAt ?? new Date())}.${format}`;
  res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
});

export default router;
