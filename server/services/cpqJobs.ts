/**
 * Background jobs for catalog extraction and AI assessment generation.
 *
 * Both can run for minutes on large orgs, longer than typical load-balancer / App Runner
 * request timeouts (120s). So the API creates a job row, returns 202 immediately, runs
 * the work in-process, and persists progress to the row for the UI to poll.
 * Jobs interrupted by a restart are marked FAILED on boot (recoverInterruptedJobs).
 */
import { gunzipSync } from 'node:zlib';
import { prisma } from '../db.js';
import { CredentialsUnreadableError, flagUnreadable, openSavedConnection, UNREADABLE_MESSAGE } from './connection.service.js';
import { DecryptionError } from '../lib/crypto.js';
import { extractCpqCatalog, serializeCatalogGzip } from './cpqCatalogExtractor.ts';
import type { CpqCatalog, ExtractionProgress, SfConnectionLike } from './cpqCatalogExtractor.ts';
import { GEMINI_MODEL, generateAssessment } from './geminiService.ts';

const MAX_RECORDS_PER_OBJECT = Number(process.env.CPQ_MAX_RECORDS_PER_OBJECT) || 250_000;
const MAX_CONCURRENT_EXTRACTIONS = Number(process.env.CPQ_MAX_CONCURRENT_EXTRACTIONS) || 2;
const KEEP_EXTRACTIONS = Number(process.env.CPQ_KEEP_EXTRACTIONS) || 10;
const API_VERSION = process.env.SF_API_VERSION || '62.0';
/** Dev-only: extract from a synthetic CPQ org. Ignored in production. */
const DEMO_ORG = process.env.CPQ_DEMO_ORG === 'true' && process.env.NODE_ENV !== 'production';
if (DEMO_ORG) console.warn('[jobs] CPQ_DEMO_ORG=true: extractions use a synthetic CPQ org, not Salesforce');

const runningExtractions = new Map<string, AbortController>();
const runningAssessments = new Map<string, AbortController>();

export class JobError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fields safe for list/detail responses (never the catalog blob). */
export const extractionSelect = {
  id: true,
  connectionId: true,
  status: true,
  progress: true,
  summary: true,
  catalogBytes: true,
  recordCount: true,
  error: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} as const;

const HEARTBEAT_MS = 15_000;
const STALE_AFTER_MS = 2 * 60_000;

/**
 * Marks jobs whose worker stopped heart-beating as FAILED (crash, deploy, scale-in).
 * Safe with several app instances: a live worker on another instance keeps its job's
 * heartbeat fresh, so only genuinely orphaned jobs are touched.
 */
export async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const where = {
    status: { in: ['QUEUED', 'RUNNING'] as Array<'QUEUED' | 'RUNNING'> },
    OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, createdAt: { lt: cutoff } }],
  };
  const data = { status: 'FAILED' as const, error: 'The worker running this job stopped (server restart or deploy). Please run it again.', finishedAt: new Date() };
  const [e, a] = await Promise.all([prisma.catalogExtraction.updateMany({ where, data }), prisma.assessmentReport.updateMany({ where, data })]);
  if (e.count || a.count) console.log(`[jobs] recovered ${e.count} stale extraction(s) and ${a.count} stale assessment(s)`);
}

/** Runs recovery now and every minute. */
export function startJobJanitor() {
  const run = () => recoverStaleJobs().catch((err) => console.error('[jobs] recovery failed:', err.message));
  run();
  setInterval(run, 60_000).unref();
}

function heartbeat(update: () => Promise<unknown>) {
  const timer = setInterval(() => void update().catch(() => {}), HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ catalog cache

const CACHE_SIZE = 2;
const catalogCache = new Map<string, CpqCatalog>();

function cachePut(id: string, catalog: CpqCatalog) {
  catalogCache.delete(id);
  catalogCache.set(id, catalog);
  while (catalogCache.size > CACHE_SIZE) catalogCache.delete(catalogCache.keys().next().value!);
}

/** Parsed catalog for an extraction (LRU-cached; the stored blob is gzip JSON). */
export async function loadCatalog(extractionId: string): Promise<CpqCatalog> {
  const hit = catalogCache.get(extractionId);
  if (hit) {
    cachePut(extractionId, hit);
    return hit;
  }
  const row = await prisma.catalogExtraction.findUnique({ where: { id: extractionId }, select: { catalogGz: true } });
  if (!row?.catalogGz) throw new JobError(404, 'Catalog data not available for this extraction');
  const catalog = JSON.parse(gunzipSync(row.catalogGz).toString('utf8')) as CpqCatalog;
  cachePut(extractionId, catalog);
  return catalog;
}

export async function getCatalogGz(extractionId: string): Promise<Buffer> {
  const row = await prisma.catalogExtraction.findUnique({ where: { id: extractionId }, select: { catalogGz: true } });
  if (!row?.catalogGz) throw new JobError(404, 'Catalog data not available for this extraction');
  return Buffer.from(row.catalogGz);
}

export function summaryOf(catalog: CpqCatalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    generatedAt: catalog.generatedAt,
    source: catalog.source,
    options: catalog.options,
    kpis: catalog.summary.kpis,
    distributions: catalog.summary.distributions,
    complexity: catalog.summary.complexity,
    inventory: catalog.discovery.objects,
    otherCpqObjects: catalog.discovery.otherCpqObjects,
    excludedTransactionalObjects: catalog.discovery.excludedTransactionalObjects,
    notes: catalog.discovery.notes,
  };
}

// ------------------------------------------------------------------ extraction

type JsforceConn = {
  describeGlobal(): Promise<unknown>;
  describe(name: string): Promise<unknown>;
  query(soql: string): PromiseLike<unknown>;
  queryMore(locator: string): PromiseLike<unknown>;
  tooling: { query(soql: string): PromiseLike<{ records: Array<Record<string, unknown>> }> };
};

async function cpqPackageVersion(conn: JsforceConn): Promise<string | null> {
  try {
    const res = await conn.tooling.query(
      "SELECT SubscriberPackage.NamespacePrefix, SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion FROM InstalledSubscriberPackage WHERE SubscriberPackage.NamespacePrefix = 'SBQQ'",
    );
    const v = res.records[0]?.SubscriberPackageVersion as Record<string, unknown> | undefined;
    return v ? `${v.MajorVersion}.${v.MinorVersion}${v.PatchVersion ? `.${v.PatchVersion}` : ''}` : null;
  } catch {
    return null; // needs "View Setup"; informational only
  }
}

/** Throttles progress writes (max ~1/800ms unless the stage changes) and keeps them ordered. */
function progressWriter(update: (p: ExtractionProgress) => Promise<unknown>) {
  let last = 0;
  let lastStage = '';
  let pending: Promise<void> = Promise.resolve();
  return (p: ExtractionProgress): Promise<void> => {
    const now = Date.now();
    if (now - last < 800 && p.stage === lastStage) return pending;
    last = now;
    lastStage = p.stage;
    const snapshot = structuredClone(p);
    pending = pending.then(() => update(snapshot)).then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
}

export async function startExtraction(userId: string, connection: { id: string; name: string; environmentType: string; orgId: string | null; instanceUrl: string | null }, includeInactive: boolean) {
  const active = await prisma.catalogExtraction.findFirst({ where: { connectionId: connection.id, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
  if (active) throw new JobError(409, 'An extraction is already running for this org');
  if (runningExtractions.size >= MAX_CONCURRENT_EXTRACTIONS) throw new JobError(429, 'The server is busy with other extractions. Try again in a few minutes.');

  const row = await prisma.catalogExtraction.create({
    data: { userId, connectionId: connection.id, status: 'QUEUED', heartbeatAt: new Date(), progress: { stage: 'queued', message: 'Queued', objects: [] } },
    select: extractionSelect,
  });
  const controller = new AbortController();
  runningExtractions.set(row.id, controller);
  setImmediate(() => {
    runExtraction(row.id, userId, connection, includeInactive, controller.signal)
      .catch((err) => console.error('[extraction] unexpected', err))
      .finally(() => runningExtractions.delete(row.id));
  });
  return row;
}

async function runExtraction(
  id: string,
  userId: string,
  connection: { id: string; name: string; environmentType: string; orgId: string | null; instanceUrl: string | null },
  includeInactive: boolean,
  signal: AbortSignal,
) {
  await prisma.catalogExtraction.update({ where: { id }, data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date(), progress: { stage: 'connecting', message: 'Connecting to Salesforce…', objects: [] } } });
  const stopHeartbeat = heartbeat(() => prisma.catalogExtraction.update({ where: { id }, data: { heartbeatAt: new Date() } }));
  const writeProgress = progressWriter((p) => prisma.catalogExtraction.update({ where: { id }, data: { progress: p as object } }));
  try {
    const record = await prisma.salesforceConnection.findUniqueOrThrow({ where: { id: connection.id } });
    let conn: JsforceConn;
    let info: { orgId: string | null; instanceUrl: string | null };
    let version: string | null;
    if (DEMO_ORG) {
      // Dev-only demo mode: a synthetic CPQ org instead of Salesforce (see README).
      const { createFakeCpqOrg } = await import('./testing/fakeCpqOrg.ts');
      conn = createFakeCpqOrg({ products: Number(process.env.CPQ_DEMO_PRODUCTS) || 3_000, bundles: 300 }) as unknown as JsforceConn;
      info = { orgId: '00DDEMO00000001', instanceUrl: 'https://demo.my.salesforce.com' };
      version = '258.1 (demo)';
    } else {
      ({ conn, info } = (await openSavedConnection(record)) as { conn: JsforceConn; info: { orgId: string; instanceUrl: string } });
      version = await cpqPackageVersion(conn);
    }

    const catalog = await extractCpqCatalog(
      conn as unknown as SfConnectionLike,
      {
        connectionName: connection.name,
        environmentType: connection.environmentType,
        orgId: info.orgId ?? connection.orgId,
        instanceUrl: info.instanceUrl ?? connection.instanceUrl,
        apiVersion: API_VERSION,
        cpqPackageVersion: version,
      },
      { includeInactive, maxRecordsPerObject: MAX_RECORDS_PER_OBJECT, onProgress: writeProgress, signal },
    );
    const recordCount = catalog.discovery.objects.reduce((n, o) => n + (o.extracted ? Math.min(o.recordCount, MAX_RECORDS_PER_OBJECT) : 0), 0);
    const { gz, bytes } = await serializeCatalogGzip(catalog);
    await writeProgress({ stage: 'done', message: 'Extraction complete', objects: [] });

    const lastProgress = (await prisma.catalogExtraction.findUnique({ where: { id }, select: { progress: true } }))?.progress as ExtractionProgress | null;
    await prisma.catalogExtraction.update({
      where: { id },
      data: {
        status: 'SUCCEEDED',
        summary: summaryOf(catalog) as object,
        catalogGz: new Uint8Array(gz),
        catalogBytes: bytes,
        recordCount,
        finishedAt: new Date(),
        progress: { stage: 'done', message: 'Extraction complete', objects: lastProgress?.objects ?? [] } as object,
      },
    });
    cachePut(id, catalog);
    await pruneOldExtractions(connection.id);
  } catch (err) {
    let message = String((err as Error)?.message || err).slice(0, 1000);
    if (err instanceof CredentialsUnreadableError || err instanceof DecryptionError) {
      // Actionable message instead of Node's "Unsupported state or unable to authenticate data".
      message = UNREADABLE_MESSAGE;
      await flagUnreadable({ id: connection.id, name: connection.name }, err);
    }
    console.error(`[extraction ${id}] failed:`, message);
    await prisma.catalogExtraction.update({ where: { id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } }).catch(() => {});
  } finally {
    stopHeartbeat();
  }
  void userId;
}

async function pruneOldExtractions(connectionId: string) {
  const old = await prisma.catalogExtraction.findMany({
    where: { connectionId, status: { in: ['SUCCEEDED', 'FAILED'] } },
    orderBy: { createdAt: 'desc' },
    skip: KEEP_EXTRACTIONS,
    select: { id: true },
  });
  if (old.length) {
    await prisma.catalogExtraction.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    old.forEach((o) => catalogCache.delete(o.id));
  }
}

export function cancelExtraction(id: string) {
  runningExtractions.get(id)?.abort();
}

export function forgetCatalog(id: string) {
  catalogCache.delete(id);
}

// ------------------------------------------------------------------ assessment

export async function startAssessment(userId: string, extraction: { id: string; connectionId: string }) {
  const active = await prisma.assessmentReport.findFirst({ where: { extractionId: extraction.id, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } });
  if (active) throw new JobError(409, 'An assessment is already being generated for this extraction');

  const row = await prisma.assessmentReport.create({
    data: { userId, extractionId: extraction.id, model: GEMINI_MODEL, status: 'QUEUED', heartbeatAt: new Date(), progress: { stage: 'queued', outputChars: 0 } },
  });
  const controller = new AbortController();
  runningAssessments.set(row.id, controller);
  setImmediate(() => {
    runAssessment(row.id, extraction.id, controller.signal)
      .catch((err) => console.error('[assessment] unexpected', err))
      .finally(() => runningAssessments.delete(row.id));
  });
  return row;
}

async function runAssessment(id: string, extractionId: string, signal: AbortSignal) {
  await prisma.assessmentReport.update({ where: { id }, data: { status: 'RUNNING', heartbeatAt: new Date(), progress: { stage: 'preparing', outputChars: 0 } } });
  const stopHeartbeat = heartbeat(() => prisma.assessmentReport.update({ where: { id }, data: { heartbeatAt: new Date() } }));
  try {
    const catalog = await loadCatalog(extractionId);
    const label = `${catalog.source.connectionName} (${catalog.source.environmentType.charAt(0)}${catalog.source.environmentType.slice(1).toLowerCase()})`;
    let last = 0;
    const result = await generateAssessment(catalog, label, {
      signal,
      onProgress: async (p) => {
        if (Date.now() - last < 1000 && p.stage === 'generating' && p.outputChars > 0) return;
        last = Date.now();
        await prisma.assessmentReport
          .update({ where: { id }, data: { progress: p as object, promptTokens: p.promptTokens ?? undefined, ...(p.model ? { model: p.model } : {}) } })
          .catch(() => {});
      },
    });
    await prisma.assessmentReport.update({
      where: { id },
      data: {
        status: 'SUCCEEDED',
        markdown: result.markdown,
        model: result.model,
        promptTokens: result.promptTokens,
        outputTokens: result.outputTokens,
        progress: { stage: 'done', outputChars: result.markdown.length, finishReason: result.finishReason, attempts: result.attempts } as object,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    const message = String((err as Error)?.message || err).slice(0, 1500);
    console.error(`[assessment ${id}] failed:`, message.slice(0, 500));
    await prisma.assessmentReport.update({ where: { id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } }).catch(() => {});
  } finally {
    stopHeartbeat();
  }
}
