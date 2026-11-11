/**
 * CPQ catalog extractor.
 *
 * 1. Schema inspection: describeGlobal() finds which CPQ setup objects exist in the org
 *    (and any other non-transactional SBQQ objects); describe() picks the fields to read
 *    (system/audit fields and binary/compound fields omitted) and resolves relationship
 *    fields per org.
 * 2. Extraction: cursor pagination (query + queryMore) consumed as an async generator,
 *    so the next page is only requested after the current one has been processed —
 *    natural backpressure, bounded in-flight memory. Records are slimmed as they arrive
 *    (no `attributes`, no null fields).
 * 3. Assembly: a normalized, hierarchical JSON tree
 *    Product -> Features -> Options -> Child Products (-> nested bundles) with option
 *    constraints, configuration attributes, rules and pricing schedules attached.
 * 4. Serialization: the tree is streamed into gzip piece by piece, never as one giant
 *    JSON string.
 */
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import {
  CPQ_OBJECTS,
  EXCLUDED_TRANSACTIONAL,
  SKIPPED_FIELD_TYPES,
  SYSTEM_FIELDS,
  TRANSACTIONAL_PATTERN,
} from './cpqSchema.ts';
import type { Category, ObjectSpec } from './cpqSchema.ts';
import { analyzeCatalog } from './cpqAnalysis.ts';

// ------------------------------------------------------------------ types

export type SfRecord = { Id: string; links?: Record<string, string>; [field: string]: unknown };

export interface DescribeField {
  name: string;
  label?: string;
  type: string;
  referenceTo?: string[] | null;
  calculated?: boolean;
  deprecatedAndHidden?: boolean;
}

export interface QueryPage {
  records: Array<Record<string, unknown>>;
  done: boolean;
  nextRecordsUrl?: string;
  totalSize: number;
}

/** The subset of a jsforce Connection the extractor needs (also implemented by test fakes). */
export interface SfConnectionLike {
  describeGlobal(): Promise<{ sobjects: Array<{ name: string; label: string; queryable: boolean; customSetting?: boolean }> }>;
  describe(name: string): Promise<{ name: string; label: string; fields: DescribeField[] }>;
  query(soql: string): PromiseLike<QueryPage>;
  queryMore(locator: string): PromiseLike<QueryPage>;
}

export type ObjectStatus = 'pending' | 'running' | 'done' | 'missing' | 'failed' | 'counted';

export interface ObjectProgress {
  name: string;
  label: string;
  category: Category;
  status: ObjectStatus;
  fetched: number;
  total: number | null;
  error?: string;
}

export interface ExtractionProgress {
  stage: 'discovery' | 'extracting' | 'building' | 'done';
  message: string;
  objects: ObjectProgress[];
}

export interface ExtractOptions {
  includeInactive?: boolean;
  maxRecordsPerObject?: number;
  /** Called after every page; keep it cheap (the caller throttles DB writes). */
  onProgress?: (p: ExtractionProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface SourceInfo {
  connectionName: string;
  environmentType: string;
  orgId: string | null;
  instanceUrl: string | null;
  apiVersion: string;
  cpqPackageVersion?: string | null;
}

export interface ObjectInventory {
  name: string;
  label: string;
  key: string;
  category: Category;
  rcaTarget: string;
  present: boolean;
  recordCount: number;
  extracted: boolean;
  truncated: boolean;
  fieldCount: number;
  customFieldCount: number;
  relationFields: Record<string, string | null>;
  error?: string;
}

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => PromiseLike<T>, what: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message || err);
      // Only retry transient failures; SOQL / permission errors fail fast.
      if (!/ECONNRESET|ETIMEDOUT|socket hang up|503|502|SERVER_UNAVAILABLE|UNABLE_TO_LOCK_ROW|fetch failed/i.test(msg)) break;
      await sleep(500 * 2 ** i);
    }
  }
  throw new Error(`${what}: ${(lastErr as Error)?.message || lastErr}`);
}

/** Cursor pagination as an async generator: one page in flight at a time. */
export async function* paginate(conn: SfConnectionLike, soql: string, signal?: AbortSignal): AsyncGenerator<Array<Record<string, unknown>>> {
  let page = await withRetry(() => conn.query(soql), 'Query failed');
  for (;;) {
    if (signal?.aborted) throw new Error('Extraction cancelled');
    yield page.records ?? [];
    if (page.done || !page.nextRecordsUrl) return;
    const locator = page.nextRecordsUrl;
    page = await withRetry(() => conn.queryMore(locator), 'queryMore failed');
  }
}

/** Drops `attributes`, null/undefined fields and nested relationship objects. */
export function slim(raw: Record<string, unknown>): SfRecord {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'attributes' || v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out as SfRecord;
}

export function selectFields(spec: ObjectSpec, fields: DescribeField[]): DescribeField[] {
  const excluded = new Set(spec.excludeFields ?? []);
  const usable = fields.filter(
    (f) => f.name === 'Id' || (!SYSTEM_FIELDS.has(f.name) && !SKIPPED_FIELD_TYPES.has(f.type) && !f.deprecatedAndHidden && !excluded.has(f.name)),
  );
  if (spec.fieldMode === 'curated') {
    const wanted = new Set(spec.fields ?? []);
    return usable.filter((f) => f.name === 'Id' || wanted.has(f.name) || f.name.endsWith('__c'));
  }
  return usable;
}

/** Picks the org's actual field for each logical relationship (see cpqSchema.ts). */
export function resolveRelations(spec: ObjectSpec, fields: DescribeField[]): Record<string, string | null> {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const resolved: Record<string, string | null> = {};
  const used = new Set<string>();
  const pending: string[] = [];
  for (const [rel, def] of Object.entries(spec.relations ?? {})) {
    const hit = def.candidates.find((c) => byName.has(c));
    resolved[rel] = hit ?? null;
    if (hit) used.add(hit);
    else pending.push(rel);
  }
  // Fallback: exactly one unused reference field pointing at the expected target.
  for (const rel of pending) {
    const target = spec.relations![rel].target;
    const refs = fields.filter((f) => f.type === 'reference' && !used.has(f.name) && (f.referenceTo ?? []).includes(target));
    if (refs.length === 1) {
      resolved[rel] = refs[0].name;
      used.add(refs[0].name);
    }
  }
  return resolved;
}

const MAX_SOQL_LENGTH = 90_000;

export function buildSoql(objectName: string, fieldNames: string[], where?: string): { soql: string; dropped: number } {
  let fields = [...fieldNames];
  let dropped = 0;
  const make = () => `SELECT ${fields.join(', ')} FROM ${objectName}${where ? ` WHERE ${where}` : ''}`;
  // Extremely wide objects: drop non-CPQ custom fields until the statement fits.
  while (make().length > MAX_SOQL_LENGTH) {
    const idx = fields.findLastIndex((f) => f.endsWith('__c') && !f.startsWith('SBQQ__'));
    if (idx < 0) break;
    fields.splice(idx, 1);
    dropped++;
  }
  return { soql: make(), dropped };
}

// ------------------------------------------------------------------ extraction

export interface RawExtraction {
  data: Record<string, SfRecord[]>;
  inventory: ObjectInventory[];
  otherCpqObjects: Array<{ name: string; label: string; recordCount: number | null }>;
  cpqInstalled: boolean;
  recordCount: number;
}

export async function extractRaw(conn: SfConnectionLike, opts: ExtractOptions = {}): Promise<RawExtraction> {
  const includeInactive = opts.includeInactive ?? true;
  const maxRecords = opts.maxRecordsPerObject ?? 250_000;

  const progress: ExtractionProgress = {
    stage: 'discovery',
    message: 'Inspecting org schema (describeGlobal)…',
    objects: CPQ_OBJECTS.map((s) => ({ name: s.name, label: s.name, category: s.category, status: 'pending', fetched: 0, total: null })),
  };
  const emit = async () => {
    await opts.onProgress?.(progress);
  };
  await emit();

  const global = await withRetry(() => conn.describeGlobal(), 'describeGlobal failed');
  const available = new Map(global.sobjects.filter((o) => o.queryable).map((o) => [o.name, o]));
  const cpqInstalled = available.has('SBQQ__ProductOption__c');

  const data: Record<string, SfRecord[]> = {};
  const inventory: ObjectInventory[] = [];
  let recordCount = 0;

  progress.stage = 'extracting';
  for (const [i, spec] of CPQ_OBJECTS.entries()) {
    const p = progress.objects[i];
    data[spec.key] = [];
    const inv: ObjectInventory = {
      name: spec.name,
      label: available.get(spec.name)?.label ?? spec.name,
      key: spec.key,
      category: spec.category,
      rcaTarget: spec.rcaTarget,
      present: available.has(spec.name),
      recordCount: 0,
      extracted: false,
      truncated: false,
      fieldCount: 0,
      customFieldCount: 0,
      relationFields: {},
    };
    inventory.push(inv);
    p.label = inv.label;

    if (!inv.present) {
      p.status = 'missing';
      await emit();
      continue;
    }

    try {
      p.status = 'running';
      progress.message = `Describing ${spec.name}…`;
      await emit();

      const describe = await withRetry(() => conn.describe(spec.name), `describe ${spec.name} failed`);
      const fields = selectFields(spec, describe.fields);
      inv.fieldCount = fields.length;
      inv.customFieldCount = fields.filter((f) => f.name.endsWith('__c')).length;
      inv.relationFields = resolveRelations(spec, describe.fields);

      const hasActive = spec.activeField && describe.fields.some((f) => f.name === spec.activeField);
      const where = !includeInactive && hasActive ? `${spec.activeField} = true` : undefined;

      const countRes = await withRetry(() => conn.query(`SELECT COUNT() FROM ${spec.name}${where ? ` WHERE ${where}` : ''}`), `count ${spec.name} failed`);
      inv.recordCount = countRes.totalSize;
      p.total = countRes.totalSize;

      if (spec.countOnly) {
        p.status = 'counted';
        await emit();
        continue;
      }

      const { soql } = buildSoql(spec.name, fields.map((f) => f.name), where);
      progress.message = `Extracting ${spec.name} (${inv.recordCount.toLocaleString()} records)…`;
      const relEntries = Object.entries(inv.relationFields).filter(([, f]) => f) as Array<[string, string]>;
      const bucket = data[spec.key];

      for await (const page of paginate(conn, soql, opts.signal)) {
        for (const raw of page) {
          if (bucket.length >= maxRecords) {
            inv.truncated = true;
            break;
          }
          const rec = slim(raw);
          if (relEntries.length) {
            const links: Record<string, string> = {};
            for (const [rel, field] of relEntries) {
              const v = rec[field];
              if (typeof v === 'string') links[rel] = v;
            }
            rec.links = links;
          }
          bucket.push(rec);
        }
        p.fetched = bucket.length;
        await emit();
        if (inv.truncated) break;
      }
      inv.extracted = true;
      recordCount += bucket.length;
      p.status = 'done';
    } catch (err) {
      p.status = 'failed';
      p.error = inv.error = String((err as Error)?.message || err).slice(0, 500);
    }
    await emit();
  }

  // Other SBQQ setup objects present in the org but not in the registry: counted, not extracted.
  progress.message = 'Discovering other CPQ objects…';
  await emit();
  const known = new Set([...CPQ_OBJECTS.map((s) => s.name), ...EXCLUDED_TRANSACTIONAL]);
  const others = global.sobjects
    .filter((o) => o.queryable && o.name.startsWith('SBQQ__') && o.name.endsWith('__c') && !known.has(o.name) && !TRANSACTIONAL_PATTERN.test(o.name))
    .slice(0, 60);
  const otherCpqObjects: RawExtraction['otherCpqObjects'] = [];
  for (const o of others) {
    let n: number | null = null;
    try {
      n = (await conn.query(`SELECT COUNT() FROM ${o.name}`)).totalSize;
    } catch {
      n = null;
    }
    otherCpqObjects.push({ name: o.name, label: o.label, recordCount: n });
  }

  progress.stage = 'building';
  progress.message = 'Assembling hierarchical catalog…';
  await emit();
  return { data, inventory, otherCpqObjects, cpqInstalled, recordCount };
}

// ------------------------------------------------------------------ assembly

const groupBy = (records: SfRecord[], rel: string) => {
  const map = new Map<string, SfRecord[]>();
  for (const r of records) {
    const k = r.links?.[rel];
    if (!k) continue;
    const list = map.get(k);
    if (list) list.push(r);
    else map.set(k, [r]);
  }
  return map;
};

const num = (v: unknown) => (typeof v === 'number' ? v : Number.POSITIVE_INFINITY);
const byNumber = (a: SfRecord, b: SfRecord) => num(a.SBQQ__Number__c) - num(b.SBQQ__Number__c);

export interface CpqCatalog {
  schemaVersion: string;
  generatedAt: string;
  source: SourceInfo & { cpqInstalled: boolean };
  options: { includeInactive: boolean; maxRecordsPerObject: number };
  discovery: {
    objects: ObjectInventory[];
    otherCpqObjects: RawExtraction['otherCpqObjects'];
    excludedTransactionalObjects: string[];
    notes: string[];
  };
  summary: ReturnType<typeof analyzeCatalog>;
  catalog: { pricebooks: SfRecord[]; products: SfRecord[]; bundleHierarchies: BundleTreeNode[] };
  rules: { productRules: SfRecord[]; priceRules: SfRecord[]; summaryVariables: SfRecord[] };
  pricing: { discountSchedules: SfRecord[]; contractedPriceCount: number };
  customizations: {
    customScripts: SfRecord[];
    pluginSettings: SfRecord[];
    customActions: SfRecord[];
    searchFilters: SfRecord[];
    guidedSelling: SfRecord[];
  };
}

/**
 * Attaches children to parents (normalized: every record appears exactly once, nested
 * under its owner; cross references are by Id) and computes bundle depth.
 */
export function assembleCatalog(raw: RawExtraction, source: SourceInfo, opts: ExtractOptions = {}): CpqCatalog {
  const d = raw.data;
  const products = d.products;
  const productsById = new Map(products.map((p) => [p.Id, p]));

  // ---- pricing attached to products
  const pbeByProduct = groupBy(d.pricebookEntries, 'product');
  const costsByProduct = groupBy(d.costs, 'product');
  const blockByProduct = groupBy(d.blockPrices, 'product');
  const dimsByProduct = groupBy(d.priceDimensions, 'product');

  // ---- bundle structure
  const featuresByBundle = groupBy(d.features, 'bundle');
  const optionsByBundle = groupBy(d.options, 'bundle');
  const constraintsByBundle = groupBy(d.optionConstraints, 'bundle');
  const attrsByBundle = groupBy(d.configurationAttributes, 'bundle');
  const cfgRulesByBundle = groupBy(d.configurationRules, 'bundle');

  for (const p of products) {
    const pricing: Record<string, SfRecord[]> = {};
    if (pbeByProduct.has(p.Id)) pricing.pricebookEntries = pbeByProduct.get(p.Id)!;
    if (costsByProduct.has(p.Id)) pricing.costs = costsByProduct.get(p.Id)!;
    if (blockByProduct.has(p.Id)) pricing.blockPrices = blockByProduct.get(p.Id)!;
    if (Object.keys(pricing).length) p.pricing = pricing;
    if (dimsByProduct.has(p.Id)) p.priceDimensions = dimsByProduct.get(p.Id);

    const options = (optionsByBundle.get(p.Id) ?? []).sort(byNumber);
    const features = (featuresByBundle.get(p.Id) ?? []).sort(byNumber);
    if (options.length || features.length) {
      const optionIdsByFeature = groupBy(options, 'feature');
      p.bundle = {
        features: features.map((f) => ({ ...f, optionIds: (optionIdsByFeature.get(f.Id) ?? []).map((o) => o.Id) })),
        options,
        optionConstraints: constraintsByBundle.get(p.Id) ?? [],
        configurationAttributes: attrsByBundle.get(p.Id) ?? [],
        configurationRules: cfgRulesByBundle.get(p.Id) ?? [],
      };
    }
  }

  const levels = computeBundleLevels(productsById);
  for (const [id, info] of levels) {
    const p = productsById.get(id)!;
    const b = p.bundle as Record<string, unknown>;
    b.levels = info.levels;
    if (info.cycle) b.circularReference = true;
  }

  // ---- rules
  const errorConditionsByRule = groupBy(d.errorConditions, 'rule');
  const productActionsByRule = groupBy(d.productActions, 'rule');
  const lookupByProductRule = groupBy(d.lookupQueries, 'productRule');
  const lookupByPriceRule = groupBy(d.lookupQueries, 'priceRule');
  const cfgRulesByRule = groupBy(d.configurationRules, 'rule');
  for (const r of d.productRules) {
    r.errorConditions = errorConditionsByRule.get(r.Id) ?? [];
    r.actions = productActionsByRule.get(r.Id) ?? [];
    r.lookupQueries = lookupByProductRule.get(r.Id) ?? [];
    r.appliesToBundleIds = (cfgRulesByRule.get(r.Id) ?? []).map((c) => c.links?.bundle).filter(Boolean);
  }
  const conditionsByRule = groupBy(d.priceConditions, 'rule');
  const priceActionsByRule = groupBy(d.priceActions, 'rule');
  for (const r of d.priceRules) {
    r.conditions = conditionsByRule.get(r.Id) ?? [];
    r.actions = priceActionsByRule.get(r.Id) ?? [];
    r.lookupQueries = lookupByPriceRule.get(r.Id) ?? [];
  }

  // ---- pricing schedules
  const tiersBySchedule = groupBy(d.discountTiers, 'schedule');
  for (const s of d.discountSchedules) {
    s.tiers = (tiersBySchedule.get(s.Id) ?? []).sort((a, b) => num(a.SBQQ__LowerBound__c) - num(b.SBQQ__LowerBound__c));
  }

  // ---- customizations
  const condsByAction = groupBy(d.customActionConditions, 'action');
  for (const a of d.customActions) a.conditions = condsByAction.get(a.Id) ?? [];
  const inputsByProcess = groupBy(d.guidedSellingInputs, 'process');
  for (const g of d.guidedSellingProcesses) g.inputs = inputsByProcess.get(g.Id) ?? [];

  // ---- nested bundle hierarchies (roots = bundles that are not an option of another bundle)
  const childOf = new Set(d.options.map((o) => o.links?.product).filter(Boolean) as string[]);
  const bundles = products.filter((p) => p.bundle);
  const roots = bundles.filter((p) => !childOf.has(p.Id));
  const index = indexCatalogParts(productsById, d.productRules);
  const budget = { nodes: 200_000 };
  const bundleHierarchies = (roots.length ? roots : bundles).map((p) => buildBundleTree(index, p.Id, { budget }));

  const contractedPriceCount = raw.inventory.find((i) => i.key === 'contractedPrices')?.recordCount ?? 0;

  const notes = [
    'Transactional records (quotes, quote lines, subscriptions, orders) are intentionally excluded.',
    'System/audit fields (CreatedDate, LastModifiedById, SystemModstamp, OwnerId, ...) are omitted; null fields are dropped.',
    'Each record keeps its Salesforce field API names; `links` holds resolved parent Ids independent of field naming.',
    'Bundle "levels" counts product tiers: a bundle with plain options = 2, a bundle containing a bundle = 3+.',
  ];
  if (budget.nodes <= 0) notes.push('Bundle hierarchy expansion hit its size budget; deeper repeats appear as {ref: true} nodes.');
  const truncated = raw.inventory.filter((i) => i.truncated).map((i) => i.name);
  if (truncated.length) notes.push(`Record cap reached (partial data) for: ${truncated.join(', ')}.`);

  const catalog: CpqCatalog = {
    schemaVersion: 'cpq-rca-catalog/1',
    generatedAt: new Date().toISOString(),
    source: { ...source, cpqInstalled: raw.cpqInstalled },
    options: { includeInactive: opts.includeInactive ?? true, maxRecordsPerObject: opts.maxRecordsPerObject ?? 250_000 },
    discovery: {
      objects: raw.inventory,
      otherCpqObjects: raw.otherCpqObjects,
      excludedTransactionalObjects: EXCLUDED_TRANSACTIONAL,
      notes,
    },
    summary: undefined as unknown as CpqCatalog['summary'],
    catalog: { pricebooks: d.pricebooks, products, bundleHierarchies },
    rules: { productRules: d.productRules, priceRules: d.priceRules, summaryVariables: d.summaryVariables },
    pricing: { discountSchedules: d.discountSchedules, contractedPriceCount },
    customizations: {
      customScripts: d.customScripts,
      pluginSettings: d.pluginSettings,
      customActions: d.customActions,
      searchFilters: d.searchFilters,
      guidedSelling: d.guidedSellingProcesses,
    },
  };
  catalog.summary = analyzeCatalog(catalog);
  return catalog;
}

/** levels = number of product tiers in a bundle (memoized DFS with cycle detection). */
export function computeBundleLevels(productsById: Map<string, SfRecord>): Map<string, { levels: number; cycle: boolean }> {
  const memo = new Map<string, { levels: number; cycle: boolean }>();
  const visiting = new Set<string>();
  const visit = (id: string): { levels: number; cycle: boolean } => {
    const cached = memo.get(id);
    if (cached) return cached;
    const p = productsById.get(id);
    const options = (p?.bundle as { options?: SfRecord[] } | undefined)?.options;
    if (!options?.length) return { levels: 1, cycle: false };
    visiting.add(id);
    let deepest = 1;
    let cycle = false;
    for (const o of options) {
      const child = o.links?.product;
      if (!child) continue;
      if (visiting.has(child)) {
        cycle = true;
        continue;
      }
      const r = visit(child);
      deepest = Math.max(deepest, r.levels);
      cycle ||= r.cycle;
    }
    visiting.delete(id);
    const res = { levels: deepest + 1, cycle };
    memo.set(id, res);
    return res;
  };
  for (const [id, p] of productsById) if (p.bundle) visit(id);
  return memo;
}

// ------------------------------------------------------------------ bundle tree (UI + JSON)

export interface BundleTreeOption {
  optionId: string;
  number?: unknown;
  type?: unknown;
  required: boolean;
  selected: boolean;
  bundled: boolean;
  quantity?: unknown;
  minQuantity?: unknown;
  maxQuantity?: unknown;
  quantityEditable?: unknown;
  product: BundleTreeNode;
}

export interface BundleTreeNode {
  productId: string;
  name: string;
  productCode?: unknown;
  active?: unknown;
  isBundle: boolean;
  levels?: unknown;
  configurationType?: unknown;
  ref?: boolean; // expanded elsewhere / budget exhausted
  cycle?: boolean;
  missing?: boolean;
  features?: Array<{ featureId: string; name: unknown; number: unknown; category?: unknown; selectionMethod?: unknown; minOptions?: unknown; maxOptions?: unknown; options: BundleTreeOption[] }>;
  ungroupedOptions?: BundleTreeOption[];
  constraints?: Array<{ id: string; type: unknown; active: unknown; constrainingOptionId?: string; constrainedOptionId?: string; constrainingProduct?: unknown; constrainedProduct?: unknown }>;
  configurationAttributes?: Array<{ id: string; name: unknown; targetField?: unknown; featureId?: string }>;
  configurationRules?: Array<{ id: string; ruleId?: string; ruleName?: unknown; ruleType?: unknown; active?: unknown }>;
}

export interface CatalogIndex {
  productsById: Map<string, SfRecord>;
  productRulesById: Map<string, SfRecord>;
}

export function indexCatalogParts(productsById: Map<string, SfRecord>, productRules: SfRecord[]): CatalogIndex {
  return { productsById, productRulesById: new Map(productRules.map((r) => [r.Id, r])) };
}

/** Build the index from a parsed catalog JSON (used by the API's bundle explorer). */
export function indexCatalog(catalog: Pick<CpqCatalog, 'catalog' | 'rules'>): CatalogIndex {
  return indexCatalogParts(new Map(catalog.catalog.products.map((p) => [p.Id, p])), catalog.rules.productRules);
}

/**
 * Nested Product -> Feature -> Option -> Child Product tree. Child bundles are expanded
 * recursively up to `maxDepth`; a shared budget caps total nodes so pathological catalogs
 * (heavily shared sub-bundles) can't explode memory. Cycles are marked, not followed.
 */
export function buildBundleTree(
  index: CatalogIndex,
  productId: string,
  { maxDepth = 10, budget = { nodes: 20_000 } }: { maxDepth?: number; budget?: { nodes: number } } = {},
  path: Set<string> = new Set(),
): BundleTreeNode {
  const p = index.productsById.get(productId);
  budget.nodes--;
  if (!p) return { productId, name: '(product not extracted)', isBundle: false, missing: true };
  const bundle = p.bundle as
    | { features: SfRecord[]; options: SfRecord[]; optionConstraints: SfRecord[]; configurationAttributes: SfRecord[]; configurationRules: SfRecord[]; levels?: number }
    | undefined;
  const node: BundleTreeNode = {
    productId,
    name: String(p.Name ?? productId),
    productCode: p.ProductCode,
    active: p.IsActive,
    isBundle: Boolean(bundle),
    configurationType: p.SBQQ__ConfigurationType__c,
  };
  if (!bundle) return node;
  node.levels = bundle.levels;
  if (path.has(productId)) return { ...node, cycle: true };
  if (path.size >= maxDepth || budget.nodes <= 0) return { ...node, ref: true };

  path.add(productId);
  const optionsById = new Map(bundle.options.map((o) => [o.Id, o]));
  const toOption = (o: SfRecord): BundleTreeOption => ({
    optionId: o.Id,
    number: o.SBQQ__Number__c,
    type: o.SBQQ__Type__c,
    required: o.SBQQ__Required__c === true,
    selected: o.SBQQ__Selected__c === true,
    bundled: o.SBQQ__Bundled__c === true,
    quantity: o.SBQQ__Quantity__c,
    minQuantity: o.SBQQ__MinQuantity__c,
    maxQuantity: o.SBQQ__MaxQuantity__c,
    quantityEditable: o.SBQQ__QuantityEditable__c,
    product: o.links?.product
      ? buildBundleTree(index, o.links.product, { maxDepth, budget }, path)
      : { productId: '', name: '(no optional product)', isBundle: false, missing: true },
  });
  const grouped = new Set<string>();
  node.features = bundle.features.map((f) => {
    const ids = (f.optionIds as string[]) ?? [];
    ids.forEach((id) => grouped.add(id));
    return {
      featureId: f.Id,
      name: f.Name,
      number: f.SBQQ__Number__c,
      category: f.SBQQ__Category__c,
      selectionMethod: f.SBQQ__OptionSelectionMethod__c,
      minOptions: f.SBQQ__MinOptionCount__c,
      maxOptions: f.SBQQ__MaxOptionCount__c,
      options: ids.map((id) => optionsById.get(id)).filter(Boolean).map((o) => toOption(o!)),
    };
  });
  node.ungroupedOptions = bundle.options.filter((o) => !grouped.has(o.Id)).map(toOption);
  const optionProductName = (optionId?: string) => {
    const o = optionId ? optionsById.get(optionId) : undefined;
    const prod = o?.links?.product ? index.productsById.get(o.links.product) : undefined;
    return prod?.Name ?? (optionId ? `(option ${optionId})` : undefined);
  };
  node.constraints = bundle.optionConstraints.map((c) => ({
    id: c.Id,
    type: c.SBQQ__Type__c,
    active: c.SBQQ__Active__c,
    constrainingOptionId: c.links?.constrainingOption,
    constrainedOptionId: c.links?.constrainedOption,
    constrainingProduct: optionProductName(c.links?.constrainingOption),
    constrainedProduct: optionProductName(c.links?.constrainedOption),
  }));
  node.configurationAttributes = bundle.configurationAttributes.map((a) => ({
    id: a.Id,
    name: a.Name,
    targetField: a.SBQQ__TargetField__c,
    featureId: a.links?.feature,
  }));
  node.configurationRules = bundle.configurationRules.map((c) => {
    const rule = c.links?.rule ? index.productRulesById.get(c.links.rule) : undefined;
    return { id: c.Id, ruleId: c.links?.rule, ruleName: rule?.Name, ruleType: rule?.SBQQ__Type__c, active: c.SBQQ__Active__c };
  });
  path.delete(productId);
  return node;
}

// ------------------------------------------------------------------ serialization

/**
 * Streams the catalog into gzip. Large arrays are written element by element and the
 * gzip stream's backpressure ('drain') is honoured, so no single huge string is built.
 */
export async function serializeCatalogGzip(value: unknown): Promise<{ gz: Buffer; bytes: number }> {
  const gzip = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  gzip.on('data', (c: Buffer) => chunks.push(c));
  const finished = once(gzip, 'end');
  let bytes = 0;
  let pending = '';

  const flush = async () => {
    if (!pending) return;
    const s = pending;
    pending = '';
    bytes += Buffer.byteLength(s);
    if (!gzip.write(s)) await once(gzip, 'drain');
  };
  const write = async (s: string) => {
    pending += s;
    if (pending.length >= 64 * 1024) await flush();
  };
  const writeValue = async (v: unknown, depth: number): Promise<void> => {
    if (Array.isArray(v) && v.length > 25) {
      await write('[');
      for (let i = 0; i < v.length; i++) {
        if (i) await write(',');
        await writeValue(v[i], depth + 1);
      }
      await write(']');
      return;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
      await write('{');
      let first = true;
      for (const [k, val] of Object.entries(v)) {
        if (val === undefined) continue;
        await write(`${first ? '' : ','}${JSON.stringify(k)}:`);
        first = false;
        await writeValue(val, depth + 1);
      }
      await write('}');
      return;
    }
    await write(JSON.stringify(v) ?? 'null');
  };

  await writeValue(value, 0);
  await flush();
  gzip.end();
  await finished;
  return { gz: Buffer.concat(chunks), bytes };
}

/** Full pipeline: inspect -> extract -> assemble. */
export async function extractCpqCatalog(conn: SfConnectionLike, source: SourceInfo, opts: ExtractOptions = {}): Promise<CpqCatalog> {
  const raw = await extractRaw(conn, opts);
  return assembleCatalog(raw, source, opts);
}
