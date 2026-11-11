// Scale check: node scripts/bench-extractor.ts [products] [bundles]
import { extractCpqCatalog, serializeCatalogGzip } from '../server/services/cpqCatalogExtractor.ts';
import { createFakeCpqOrg } from '../server/services/testing/fakeCpqOrg.ts';

const products = Number(process.argv[2] ?? 15_000);
const bundles = Number(process.argv[3] ?? 3_000);
const conn = createFakeCpqOrg({ products, bundles, pageSize: 2_000 });
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
let peak = 0;
const t0 = Date.now();
const catalog = await extractCpqCatalog(conn, { connectionName: 'bench', environmentType: 'SANDBOX', orgId: null, instanceUrl: null, apiVersion: '62.0' }, {
  onProgress: () => { peak = Math.max(peak, process.memoryUsage().heapUsed); },
});
const t1 = Date.now();
const { gz, bytes } = await serializeCatalogGzip(catalog);
peak = Math.max(peak, process.memoryUsage().heapUsed);
console.log({
  products: catalog.summary.kpis.totalProducts, bundles: catalog.summary.kpis.totalBundles, options: catalog.summary.kpis.options,
  pricebookEntries: catalog.summary.kpis.pricebookEntries, queryMores: conn.stats.queryMores,
  extractMs: t1 - t0, serializeMs: Date.now() - t1, json: mb(bytes), gzip: mb(gz.length), peakHeap: mb(peak),
  complexity: `${catalog.summary.complexity.level} (${catalog.summary.complexity.score})`,
});
