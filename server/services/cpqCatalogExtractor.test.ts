import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { buildBundleTree, extractCpqCatalog, indexCatalog, serializeCatalogGzip } from './cpqCatalogExtractor.ts';
import type { CpqCatalog, ExtractionProgress, SfRecord } from './cpqCatalogExtractor.ts';
import { createFakeCpqOrg } from './testing/fakeCpqOrg.ts';

const source = { connectionName: 'Test', environmentType: 'SANDBOX', orgId: '00D000000000001', instanceUrl: 'https://x.my.salesforce.com', apiVersion: '62.0' };

async function run(opts = {}, orgOpts = {}) {
  const conn = createFakeCpqOrg({ products: 3_000, bundles: 300, pageSize: 500, ...orgOpts });
  const progress: ExtractionProgress[] = [];
  const catalog = await extractCpqCatalog(conn, source, { onProgress: (p) => void progress.push(structuredClone(p)), ...opts });
  return { conn, catalog, progress };
}

const findProduct = (c: CpqCatalog, name: string) => c.catalog.products.find((p) => p.Name === name) as SfRecord;

test('extracts every registry object that exists and reports missing ones', async () => {
  const { catalog } = await run();
  const inv = Object.fromEntries(catalog.discovery.objects.map((o) => [o.name, o]));
  assert.equal(inv.Product2.recordCount, 3_000);
  assert.equal(inv.PricebookEntry.recordCount, 6_000);
  assert.equal(inv.SBQQ__Dimension__c.present, false);
  assert.equal(inv.SBQQ__ContractedPrice__c.extracted, false, 'count-only object must not be extracted');
  assert.equal(inv.SBQQ__ContractedPrice__c.recordCount, 500);
  assert.ok(catalog.discovery.otherCpqObjects.some((o) => o.name === 'SBQQ__Theme__c'));
  assert.ok(!catalog.discovery.otherCpqObjects.some((o) => o.name === 'SBQQ__Quote__c'), 'quotes are never touched');
  assert.ok(catalog.discovery.excludedTransactionalObjects.includes('SBQQ__QuoteLine__c'));
});

test('paginates with queryMore and never holds more than one page in flight', async () => {
  const { conn } = await run();
  assert.ok(conn.stats.queryMores >= 10, `expected many queryMore calls, got ${conn.stats.queryMores}`);
  assert.equal(conn.stats.maxPageRecords, 500);
});

test('omits system/audit fields, null fields and transpiled QCP code', async () => {
  const { catalog } = await run();
  const p = catalog.catalog.products[0];
  for (const f of ['CreatedDate', 'LastModifiedById', 'SystemModstamp', 'OwnerId', 'IsDeleted', 'attributes', 'Description']) {
    assert.ok(!(f in p), `${f} should be omitted`);
  }
  assert.equal(p.Custom_Attribute__c, 'attr-0', 'custom fields are kept');
  assert.ok(!('SBQQ__TranspiledCode__c' in catalog.customizations.customScripts[0]));
  assert.ok(catalog.customizations.customScripts[0].SBQQ__Code__c);
});

test('builds Product -> Feature -> Option -> nested bundle hierarchy with levels and cycles', async () => {
  const { catalog } = await run();
  const b0 = findProduct(catalog, 'Bundle 0');
  const bundle = b0.bundle as { features: SfRecord[]; options: SfRecord[]; levels: number };
  assert.equal(bundle.features.length, 2);
  assert.equal(bundle.options.length, 6);
  assert.equal(bundle.levels, 4, 'Bundle 0 -> Bundle 1 -> Bundle 2 -> SKU = 4 tiers');
  assert.equal((findProduct(catalog, 'Bundle 2').bundle as { levels: number }).levels, 2, 'plain bundle = 2 tiers');
  assert.ok((findProduct(catalog, 'Bundle 40').bundle as { circularReference?: boolean }).circularReference);

  const tree = buildBundleTree(indexCatalog(catalog), b0.Id);
  const nested = tree.features![0].options[0].product;
  assert.equal(nested.name, 'Bundle 1');
  assert.ok(nested.isBundle && nested.features!.length === 2);
  assert.equal(tree.configurationRules![0].ruleName, 'Product Rule 0');
  assert.equal(tree.constraints!.length, 1);
  assert.match(String(tree.constraints![0].constrainingProduct), /Bundle 1|SKU/);

  const cyc = buildBundleTree(indexCatalog(catalog), findProduct(catalog, 'Bundle 40').Id);
  const json = JSON.stringify(cyc);
  assert.match(json, /"cycle":true/, 'cycles are marked, not followed');
});

test('attaches rules, conditions, actions, lookups and discount tiers', async () => {
  const { catalog } = await run();
  const pr0 = catalog.rules.priceRules.find((r) => r.Name === 'Price Rule 0')!;
  assert.equal((pr0.conditions as unknown[]).length, 6);
  assert.equal((pr0.actions as unknown[]).length, 1);
  assert.equal((pr0.lookupQueries as unknown[]).length, 1);
  const prod0 = catalog.rules.productRules.find((r) => r.Name === 'Product Rule 0')!;
  assert.equal((prod0.errorConditions as unknown[]).length, 7);
  assert.deepEqual(prod0.appliesToBundleIds, [findProduct(catalog, 'Bundle 0').Id]);
  assert.equal((catalog.pricing.discountSchedules[0].tiers as unknown[]).length, 3);
});

test('computes KPIs and complexity flags', async () => {
  const { catalog } = await run();
  const { kpis, complexity } = catalog.summary;
  assert.equal(kpis.totalProducts, 3_000);
  assert.equal(kpis.totalBundles, 300);
  assert.equal(kpis.pricingRules, 40);
  assert.equal(kpis.productRules, 50);
  assert.equal(kpis.discountSchedules, 10);
  assert.ok(kpis.standaloneSkus > 2_000);
  const ids = new Set(complexity.flags.map((f) => f.id));
  for (const f of ['deep-bundles', 'bundle-cycles', 'qcp-scripts', 'lookup-rules', 'advanced-conditions', 'complex-rules', 'summary-variables', 'external-configurator', 'account-pricing', 'block-pricing']) {
    assert.ok(ids.has(f), `missing flag ${f}`);
  }
  assert.match(complexity.flags.find((f) => f.id === 'qcp-scripts')!.detail, /MyQCP/);
  assert.ok(['Medium', 'High', 'Very High'].includes(complexity.level));
});

test('includeInactive=false filters by the active flag', async () => {
  const { catalog } = await run({ includeInactive: false });
  assert.ok(catalog.catalog.products.every((p) => p.IsActive === true));
});

test('record cap marks the object truncated', async () => {
  const { catalog } = await run({ maxRecordsPerObject: 1_000 });
  const inv = catalog.discovery.objects.find((o) => o.name === 'Product2')!;
  assert.equal(inv.truncated, true);
  assert.equal(catalog.catalog.products.length, 1_000);
});

test('gzip serializer round-trips the full catalog', async () => {
  const { catalog } = await run();
  const { gz, bytes } = await serializeCatalogGzip(catalog);
  const text = gunzipSync(gz).toString('utf8');
  assert.equal(Buffer.byteLength(text), bytes);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(catalog)));
});

test('falls back to a unique reference field when a candidate name differs', async () => {
  const { resolveRelations } = await import('./cpqCatalogExtractor.ts');
  const { CPQ_OBJECTS } = await import('./cpqSchema.ts');
  const spec = CPQ_OBJECTS.find((s) => s.name === 'SBQQ__DiscountTier__c')!;
  const resolved = resolveRelations(spec, [
    { name: 'Id', type: 'id' },
    { name: 'SBQQ__ParentSchedule__c', type: 'reference', referenceTo: ['SBQQ__DiscountSchedule__c'] },
  ]);
  assert.equal(resolved.schedule, 'SBQQ__ParentSchedule__c');
});
