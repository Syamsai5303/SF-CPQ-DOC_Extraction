/**
 * Catalog KPIs, distributions and RCA migration complexity indicators.
 * Pure functions over an assembled catalog, so they run identically on fresh
 * extractions and on stored JSON.
 */
import type { CpqCatalog, SfRecord } from './cpqCatalogExtractor.ts';

export type Severity = 'high' | 'medium' | 'low';

export interface ComplexityFlag {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  rcaGuidance: string;
  examples: Array<{ id: string; name: string; info?: string }>;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 15, medium: 6, low: 2 };

const isTrue = (v: unknown) => v === true || v === 'true';
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const example = (r: SfRecord, info?: string) => ({ id: r.Id, name: str(r.Name) || r.Id, ...(info ? { info } : {}) });
const pick = <T>(arr: T[], n = 8) => arr.slice(0, n);

/** Counts values of a (possibly multi-select ';') field. */
function distribution(records: SfRecord[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) {
    const raw = r[field];
    if (raw === undefined) continue;
    for (const v of str(raw).split(';').map((s) => s.trim()).filter(Boolean)) out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

type BundleInfo = { options: SfRecord[]; features: SfRecord[]; optionConstraints: SfRecord[]; configurationAttributes: SfRecord[]; levels?: number; circularReference?: boolean };

export function analyzeCatalog(catalog: Pick<CpqCatalog, 'catalog' | 'rules' | 'pricing' | 'customizations' | 'discovery'>) {
  const products = catalog.catalog.products;
  const bundles = products.filter((p) => p.bundle);
  const bundleOf = (p: SfRecord) => p.bundle as BundleInfo;
  const activeProducts = products.filter((p) => isTrue(p.IsActive));
  const activeBundles = bundles.filter((p) => isTrue(p.IsActive));
  const optionProductIds = new Set(bundles.flatMap((b) => bundleOf(b).options.map((o) => o.links?.product).filter(Boolean)));
  const standalone = activeProducts.filter((p) => !p.bundle);

  const { productRules, priceRules, summaryVariables } = catalog.rules;
  const { discountSchedules } = catalog.pricing;
  const { customScripts, pluginSettings, customActions } = catalog.customizations;

  const allOptions = bundles.flatMap((b) => bundleOf(b).options);
  const allFeatures = bundles.flatMap((b) => bundleOf(b).features);
  const allConstraints = bundles.flatMap((b) => bundleOf(b).optionConstraints);
  const allConfigAttrs = bundles.flatMap((b) => bundleOf(b).configurationAttributes);
  const maxLevels = bundles.reduce((m, b) => Math.max(m, bundleOf(b).levels ?? 2), 0);
  const pricebookEntryCount = products.reduce(
    (n, p) => n + ((p.pricing as { pricebookEntries?: unknown[] } | undefined)?.pricebookEntries?.length ?? 0),
    0,
  );

  const kpis = {
    totalProducts: products.length,
    activeProducts: activeProducts.length,
    activeBundles: activeBundles.length,
    totalBundles: bundles.length,
    standaloneSkus: standalone.length,
    optionOnlyProducts: products.filter((p) => !p.bundle && optionProductIds.has(p.Id)).length,
    pricingRules: priceRules.length,
    activePricingRules: priceRules.filter((r) => isTrue(r.SBQQ__Active__c)).length,
    productRules: productRules.length,
    activeProductRules: productRules.filter((r) => isTrue(r.SBQQ__Active__c)).length,
    discountSchedules: discountSchedules.length,
    features: allFeatures.length,
    options: allOptions.length,
    optionConstraints: allConstraints.length,
    configurationAttributes: allConfigAttrs.length,
    pricebooks: catalog.catalog.pricebooks.length,
    pricebookEntries: pricebookEntryCount,
    summaryVariables: summaryVariables.length,
    customScripts: customScripts.length,
    maxBundleLevels: maxLevels,
  };

  const distributions = {
    productFamily: distribution(products, 'Family'),
    configurationType: distribution(products, 'SBQQ__ConfigurationType__c'),
    pricingMethod: distribution(products, 'SBQQ__PricingMethod__c'),
    subscriptionPricing: distribution(products, 'SBQQ__SubscriptionPricing__c'),
    chargeType: distribution(products, 'SBQQ__ChargeType__c'),
    billingType: distribution(products, 'SBQQ__BillingType__c'),
    optionType: distribution(allOptions, 'SBQQ__Type__c'),
    constraintType: distribution(allConstraints, 'SBQQ__Type__c'),
    productRuleType: distribution(productRules, 'SBQQ__Type__c'),
    productRuleEvaluationEvent: distribution(productRules, 'SBQQ__EvaluationEvent__c'),
    priceRuleEvaluationEvent: distribution(priceRules, 'SBQQ__EvaluationEvent__c'),
    discountScheduleType: distribution(discountSchedules, 'SBQQ__Type__c'),
  };

  // ------------------------------------------------------------ complexity flags
  const flags: ComplexityFlag[] = [];
  const add = (f: ComplexityFlag) => {
    if (f.count > 0) flags.push(f);
  };

  const deep = bundles.filter((b) => (bundleOf(b).levels ?? 2) >= 3).sort((a, b) => (bundleOf(b).levels ?? 0) - (bundleOf(a).levels ?? 0));
  add({
    id: 'deep-bundles',
    severity: 'high',
    title: 'Deeply nested bundles (3+ tiers)',
    detail: `${deep.length} bundle(s) contain nested bundles; the deepest has ${maxLevels} product tiers.`,
    count: deep.length,
    rcaGuidance: 'Model as nested Product Related Components in RCA; validate configurator performance and flatten tiers that only exist for pricing roll-up.',
    examples: pick(deep).map((b) => example(b, `${bundleOf(b).levels} tiers`)),
  });

  const cycles = bundles.filter((b) => bundleOf(b).circularReference);
  add({
    id: 'bundle-cycles',
    severity: 'high',
    title: 'Circular bundle references',
    detail: `${cycles.length} bundle(s) are reachable from their own options.`,
    count: cycles.length,
    rcaGuidance: 'RCA product structures must be acyclic; break the loop before migrating the catalog.',
    examples: pick(cycles).map((b) => example(b)),
  });

  const qcpPluginFields = pluginSettings.flatMap((s) =>
    Object.entries(s).filter(([k, v]) => /Calculator/i.test(k) && typeof v === 'string' && v.trim()).map(([, v]) => str(v)),
  );
  const codeLines = customScripts.reduce((n, s) => n + (str(s.SBQQ__Code__c).match(/\n/g)?.length ?? 0) + (s.SBQQ__Code__c ? 1 : 0), 0);
  add({
    id: 'qcp-scripts',
    severity: 'high',
    title: 'Quote Calculator Plugin (QCP) / custom scripts',
    detail:
      `${customScripts.length} custom script(s), ~${codeLines.toLocaleString()} lines of JavaScript.` +
      (qcpPluginFields.length ? ` Active QCP in package settings: ${[...new Set(qcpPluginFields)].join(', ')}.` : ''),
    count: customScripts.length,
    rcaGuidance: 'No QCP runtime in RCA. Re-implement logic as Pricing Procedure elements, Expression Sets / Decision Tables, or Apex hooks; plan for manual rewrite and regression testing.',
    examples: pick(customScripts).map((s) => example(s, `${(str(s.SBQQ__Code__c).match(/\n/g)?.length ?? 0) + 1} lines`)),
  });

  const lookupPriceRules = priceRules.filter((r) => r.SBQQ__LookupObject__c || (r.lookupQueries as unknown[] | undefined)?.length);
  const lookupProductRules = productRules.filter((r) => r.SBQQ__LookupObject__c || (r.lookupQueries as unknown[] | undefined)?.length);
  add({
    id: 'lookup-rules',
    severity: 'medium',
    title: 'Rules driven by lookup tables',
    detail: `${lookupPriceRules.length} price rule(s) and ${lookupProductRules.length} product rule(s) use lookup objects / lookup queries.`,
    count: lookupPriceRules.length + lookupProductRules.length,
    rcaGuidance: 'Convert lookup objects to RCA Decision Tables and reference them from Pricing Procedures or configurator rules.',
    examples: pick([...lookupPriceRules, ...lookupProductRules]).map((r) => example(r)),
  });

  const advanced = [...priceRules, ...productRules].filter((r) => str(r.SBQQ__AdvancedCondition__c).trim() || str(r.SBQQ__ConditionsMet__c) === 'Custom');
  add({
    id: 'advanced-conditions',
    severity: 'medium',
    title: 'Custom / advanced condition logic',
    detail: `${advanced.length} rule(s) use custom condition logic (e.g. "1 AND (2 OR 3)").`,
    count: advanced.length,
    rcaGuidance: 'Rebuild as Expression Set condition groups; verify operator precedence with test cases.',
    examples: pick(advanced).map((r) => example(r, str(r.SBQQ__AdvancedCondition__c))),
  });

  const heavyPrice = priceRules.filter((r) => ((r.conditions as unknown[])?.length ?? 0) > 5 || ((r.actions as unknown[])?.length ?? 0) > 5);
  const heavyProduct = productRules.filter((r) => ((r.errorConditions as unknown[])?.length ?? 0) > 5 || ((r.actions as unknown[])?.length ?? 0) > 5);
  add({
    id: 'complex-rules',
    severity: 'medium',
    title: 'Rules with many conditions or actions',
    detail: `${heavyPrice.length + heavyProduct.length} rule(s) have more than 5 conditions or actions.`,
    count: heavyPrice.length + heavyProduct.length,
    rcaGuidance: 'Split into smaller Expression Sets / configurator rules; consider Decision Tables for matrix-style logic.',
    examples: pick([...heavyPrice, ...heavyProduct]).map((r) =>
      example(r, `${((r.conditions ?? r.errorConditions) as unknown[])?.length ?? 0} conditions, ${(r.actions as unknown[])?.length ?? 0} actions`),
    ),
  });

  const formulaActions = priceRules.filter((r) => ((r.actions as SfRecord[]) ?? []).some((a) => str(a.SBQQ__Formula__c).trim()));
  add({
    id: 'price-action-formulas',
    severity: 'medium',
    title: 'Price actions with formulas',
    detail: `${formulaActions.length} price rule(s) compute values with formulas.`,
    count: formulaActions.length,
    rcaGuidance: 'Translate formulas to Expression Set calculation elements; check function parity.',
    examples: pick(formulaActions).map((r) => example(r)),
  });

  const svUsed = summaryVariables.length;
  add({
    id: 'summary-variables',
    severity: 'medium',
    title: 'Summary variables',
    detail: `${svUsed} summary variable(s) aggregate quote-line data for rules.`,
    count: svUsed,
    rcaGuidance: 'Recreate as aggregation steps in Pricing Procedures or rollups available to configurator rules.',
    examples: pick(summaryVariables).map((s) => example(s, `${str(s.SBQQ__AggregateFunction__c)} ${str(s.SBQQ__AggregateField__c)}`.trim())),
  });

  const selectionRules = productRules.filter((r) => /Selection|Filter/i.test(str(r.SBQQ__Type__c)));
  add({
    id: 'selection-filter-rules',
    severity: 'medium',
    title: 'Selection & filter product rules',
    detail: `${selectionRules.length} rule(s) auto-select, hide or filter options.`,
    count: selectionRules.length,
    rcaGuidance: 'Map to RCA configurator constraint rules (CML require/exclude/hide); dynamic filter rules may need Product Discovery qualification rules.',
    examples: pick(selectionRules).map((r) => example(r, str(r.SBQQ__Type__c))),
  });

  add({
    id: 'option-constraints',
    severity: allConstraints.length > 200 ? 'medium' : 'low',
    title: 'Option constraints',
    detail: `${allConstraints.length} dependency/exclusion constraint(s) between bundle options.`,
    count: allConstraints.length,
    rcaGuidance: 'Express as CML constraints in the RCA configurator.',
    examples: [],
  });

  const dynamicFeatures = allFeatures.filter((f) => /Dynamic/i.test(str(f.SBQQ__OptionSelectionMethod__c)));
  add({
    id: 'dynamic-features',
    severity: 'medium',
    title: 'Dynamic option selection features',
    detail: `${dynamicFeatures.length} feature(s) let reps search/add options dynamically.`,
    count: dynamicFeatures.length,
    rcaGuidance: 'Use RCA dynamic bundles / product classification-based component groups.',
    examples: pick(dynamicFeatures).map((f) => example(f)),
  });

  add({
    id: 'configuration-attributes',
    severity: 'low',
    title: 'Configuration attributes',
    detail: `${allConfigAttrs.length} configuration attribute(s) on bundles.`,
    count: allConfigAttrs.length,
    rcaGuidance: 'Recreate as RCA Product Attributes (attribute definitions + categories) and attribute-based pricing where values drive price.',
    examples: [],
  });

  const mdq = products.filter((p) => (p.priceDimensions as unknown[] | undefined)?.length);
  add({
    id: 'mdq-products',
    severity: 'high',
    title: 'Multi-dimensional quoting (MDQ)',
    detail: `${mdq.length} product(s) use price dimensions.`,
    count: mdq.length,
    rcaGuidance: 'Re-model as RCA ramp deals / term-based Product Selling Models; MDQ segments have no 1:1 equivalent.',
    examples: pick(mdq).map((p) => example(p)),
  });

  const pctOfTotal = products.filter((p) => /Percent Of Total/i.test(str(p.SBQQ__PricingMethod__c)) || /Percent Of Total/i.test(str(p.SBQQ__SubscriptionPricing__c)));
  add({
    id: 'percent-of-total',
    severity: 'medium',
    title: 'Percent-of-total pricing',
    detail: `${pctOfTotal.length} product(s) are priced as a percentage of other lines.`,
    count: pctOfTotal.length,
    rcaGuidance: 'Implement with a Pricing Procedure aggregate + derived pricing element.',
    examples: pick(pctOfTotal).map((p) => example(p)),
  });

  const block = products.filter((p) => /Block/i.test(str(p.SBQQ__PricingMethod__c)) || (p.pricing as { blockPrices?: unknown[] } | undefined)?.blockPrices?.length);
  add({
    id: 'block-pricing',
    severity: 'low',
    title: 'Block pricing',
    detail: `${block.length} product(s) use block prices.`,
    count: block.length,
    rcaGuidance: 'Use RCA tiered / volume price adjustment schedules or a Decision Table lookup.',
    examples: pick(block).map((p) => example(p)),
  });

  const costPlus = products.filter((p) => /^Cost$/i.test(str(p.SBQQ__PricingMethod__c)));
  add({
    id: 'cost-plus',
    severity: 'low',
    title: 'Cost-plus pricing',
    detail: `${costPlus.length} product(s) are priced from cost records.`,
    count: costPlus.length,
    rcaGuidance: 'Migrate costs to an RCA cost book and add a cost-plus markup element to the Pricing Procedure.',
    examples: pick(costPlus).map((p) => example(p)),
  });

  const accountSchedules = discountSchedules.filter((s) => s.links?.account);
  const contracted = catalog.pricing.contractedPriceCount;
  add({
    id: 'account-pricing',
    severity: 'medium',
    title: 'Account-specific pricing',
    detail: `${accountSchedules.length} account-specific discount schedule(s) and ${contracted.toLocaleString()} contracted price record(s).`,
    count: accountSchedules.length + contracted,
    rcaGuidance: 'Plan negotiated-price migration (price book per segment, Decision Table keyed by account, or contract pricing in RCA).',
    examples: pick(accountSchedules).map((s) => example(s)),
  });

  const external = products.filter((p) => isTrue(p.SBQQ__ExternallyConfigurable__c));
  add({
    id: 'external-configurator',
    severity: 'high',
    title: 'External configurator',
    detail: `${external.length} product(s) are configured by an external configurator.`,
    count: external.length,
    rcaGuidance: 'Re-integrate via RCA Configurator APIs; requires custom development.',
    examples: pick(external).map((p) => example(p)),
  });

  add({
    id: 'custom-actions',
    severity: 'low',
    title: 'Custom actions & search filters',
    detail: `${customActions.length} custom action(s) in the quote line editor / configurator.`,
    count: customActions.length,
    rcaGuidance: 'Rebuild as Lightning actions or Transaction Line Editor customizations.',
    examples: pick(customActions).map((a) => example(a)),
  });

  const inactiveRules = [...priceRules, ...productRules].filter((r) => r.SBQQ__Active__c === false);
  add({
    id: 'inactive-rules',
    severity: 'low',
    title: 'Inactive rules (clean-up candidates)',
    detail: `${inactiveRules.length} inactive price/product rule(s).`,
    count: inactiveRules.length,
    rcaGuidance: 'Retire instead of migrating; confirm with business owners.',
    examples: pick(inactiveRules).map((r) => example(r)),
  });

  const volumeIssues = products.length > 10_000 || allOptions.length > 50_000;
  add({
    id: 'catalog-volume',
    severity: 'low',
    title: 'Large catalog volume',
    detail: `${products.length.toLocaleString()} products and ${allOptions.length.toLocaleString()} options.`,
    count: volumeIssues ? 1 : 0,
    rcaGuidance: 'Use bulk data loads (Bulk API 2.0 / Data Loader) and stage the catalog migration by product family.',
    examples: [],
  });

  const missing = catalog.discovery.objects.filter((o) => o.error);
  add({
    id: 'extraction-errors',
    severity: 'low',
    title: 'Objects that could not be read',
    detail: missing.map((o) => `${o.name}: ${o.error}`).join(' | '),
    count: missing.length,
    rcaGuidance: 'Grant the integration user read access to these objects and re-run the extraction.',
    examples: [],
  });

  flags.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.count - a.count);

  // Score: severity-weighted, log-scaled by count so one huge category doesn't dominate.
  const raw = flags.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity] * (1 + Math.log10(Math.max(1, f.count))), 0);
  const score = Math.min(100, Math.round(raw));
  const level = score >= 70 ? 'Very High' : score >= 45 ? 'High' : score >= 20 ? 'Medium' : 'Low';

  return {
    kpis,
    distributions,
    complexity: { score, level, flags },
  };
}
