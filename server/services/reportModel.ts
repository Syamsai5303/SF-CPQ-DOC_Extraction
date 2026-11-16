/**
 * Deterministic content of the merged "CPQ Assessment & RCA Migration Report".
 *
 * The report combines (1) the CPQ Configuration Document (current-state, item-level
 * detail: what each bundle/rule does, approach, effort) and (2) the RCA Migration
 * Assessment (mapping, gaps, roadmap). Every FACT table is generated here from the
 * extraction, so numbers are always exact; Gemini only writes analysis and marks
 * where each table goes with a {{PLACEHOLDER}}. This also keeps model output (and
 * cost) small.
 *
 * Structure:
 *   Part 1  Executive Summary & Current CPQ Architecture
 *   Part 2  Price Rules & Product Rules Breakdown
 *   Part 3  CPQ-to-RCA Mapping Matrix & Migration Strategy
 *   Appendices (custom fields used by logic, record inventory, complexity indicators)
 */
import type { CpqCatalog, SfRecord } from './cpqCatalogExtractor.ts';
import { explainPriceRule, explainPriceRuleParts, explainProductRule } from './ruleExplainer.ts';
import { isPackagedCustomAction } from './cpqAnalysis.ts';
import type { Probe } from './orgScopeScanner.ts';

export const REPORT_VERSION_MARKER = '<!-- cpq-rca-report:v2 -->';

/** Section titles renamed since a report was generated; applied when a stored report is rendered. */
const RENAMED_HEADINGS: Array<[RegExp, string]> = [[/^## 3\.6 Missing coverage & migration blind spots\s*$/m, '## 3.6 Dependencies outside the CPQ catalog']];
export const normalizeHeadings = (md: string) => RENAMED_HEADINGS.reduce((t, [re, to]) => t.replace(re, to), md);

// ------------------------------------------------------------------ approach & effort

export type Approach = 'Direct' | 'Adapt' | 'Redesign' | 'Retire';
export type Area = 'Bundles' | 'Product Rules' | 'Price Rules' | 'Pricing Schedules' | 'Code & Process';

/** Indicative configuration-rebuild hours per item (excludes data migration, testing, PM). */
export const EFFORT_HOURS: Record<Approach, number> = { Direct: 2, Adapt: 6, Redesign: 24, Retire: 0.5 };

export interface ClassifiedItem {
  id: string;
  name: string;
  area: Area;
  type: string;
  active: boolean;
  approach: Approach;
  reason: string;
  rcaTarget: string;
}

const s = (v: unknown) => (v == null ? '' : String(v));
const isFalse = (v: unknown) => v === false || v === 'false';
const arr = (v: unknown) => (Array.isArray(v) ? (v as SfRecord[]) : []);
type Bundle = { features: SfRecord[]; options: SfRecord[]; optionConstraints: SfRecord[]; configurationAttributes: SfRecord[]; configurationRules: SfRecord[]; levels?: number; circularReference?: boolean };

/** Classifies every migratable configuration item (same rules as the CPQ Configuration Document). */
export function classifyItems(catalog: CpqCatalog): ClassifiedItem[] {
  const items: ClassifiedItem[] = [];
  for (const p of catalog.catalog.products) {
    const b = p.bundle as Bundle | undefined;
    if (!b) continue;
    const dynamic = b.features.some((f) => /dynamic/i.test(s(f.SBQQ__OptionSelectionMethod__c)));
    const [approach, reason]: [Approach, string] = isFalse(p.IsActive)
      ? ['Retire', 'inactive product']
      : b.circularReference || p.SBQQ__ExternallyConfigurable__c === true
        ? ['Redesign', b.circularReference ? 'circular bundle reference' : 'external configurator']
        : (b.levels ?? 2) >= 3 || dynamic
          ? ['Adapt', (b.levels ?? 2) >= 3 ? `${b.levels}-tier nesting` : 'dynamic option selection']
          : ['Direct', 'standard bundle structure'];
    items.push({ id: p.Id, name: label(p), area: 'Bundles', type: 'Bundle', active: !isFalse(p.IsActive), approach, reason, rcaTarget: 'Product2 (bundle) + ProductComponentGroup + ProductRelatedComponent' });
  }
  for (const r of catalog.rules.productRules) {
    const lookup = Boolean(r.SBQQ__LookupObject__c) || arr(r.lookupQueries).length > 0;
    const usesVariable = arr(r.errorConditions).some((c) => c.links?.testedVariable);
    const custom = s(r.SBQQ__AdvancedCondition__c).trim() || s(r.SBQQ__ConditionsMet__c) === 'Custom';
    const [approach, reason]: [Approach, string] = isFalse(r.SBQQ__Active__c)
      ? ['Retire', 'inactive']
      : lookup || usesVariable || custom || /filter/i.test(s(r.SBQQ__Type__c))
        ? ['Adapt', lookup ? 'lookup-driven' : usesVariable ? 'uses summary variables' : custom ? 'custom condition logic' : 'filter rule']
        : ['Direct', 'maps to a CML constraint'];
    items.push({ id: r.Id, name: s(r.Name), area: 'Product Rules', type: `Product Rule - ${s(r.SBQQ__Type__c) || 'Unknown'}`, active: !isFalse(r.SBQQ__Active__c), approach, reason, rcaTarget: 'Advanced Configurator constraint rule (CML)' });
  }
  for (const v of catalog.rules.summaryVariables) {
    items.push({ id: v.Id, name: s(v.Name), area: 'Product Rules', type: 'Summary Variable', active: true, approach: 'Direct', reason: 'aggregate', rcaTarget: 'Pricing procedure aggregation / context aggregate' });
  }
  for (const r of catalog.rules.priceRules) {
    const lookup = Boolean(r.SBQQ__LookupObject__c) || arr(r.lookupQueries).length > 0;
    const formula = arr(r.actions).some((a) => s(a.SBQQ__Formula__c).trim());
    const heavy = arr(r.conditions).length > 5 || arr(r.actions).length > 5;
    const [approach, reason]: [Approach, string] = isFalse(r.SBQQ__Active__c)
      ? ['Retire', 'inactive']
      : heavy && (lookup || formula)
        ? ['Redesign', 'complex lookup/formula logic']
        : ['Adapt', lookup ? 'lookup → Decision Table' : formula ? 'formula → Pricing Procedure element' : 'Pricing Procedure element'];
    items.push({ id: r.Id, name: s(r.Name), area: 'Price Rules', type: 'Price Rule', active: !isFalse(r.SBQQ__Active__c), approach, reason, rcaTarget: lookup ? 'Pricing Procedure element + Decision Table' : 'Pricing Procedure element / Expression Set' });
  }
  for (const d of catalog.pricing.discountSchedules) {
    const account = Boolean(d.links?.account);
    items.push({ id: d.Id, name: s(d.Name), area: 'Pricing Schedules', type: `Discount Schedule (${s(d.SBQQ__Type__c) || 'n/a'})`, active: true, approach: account ? 'Adapt' : 'Direct', reason: account ? 'account-specific' : 'tiered schedule', rcaTarget: 'PriceAdjustmentSchedule + PriceAdjustmentTier' });
  }
  for (const c of catalog.customizations.customScripts) {
    items.push({ id: c.Id, name: s(c.Name), area: 'Code & Process', type: 'Custom Script (QCP)', active: true, approach: 'Redesign', reason: 'no QCP runtime in RCA', rcaTarget: 'Pricing Procedure custom elements / Apex hooks' });
  }
  for (const a of catalog.customizations.customActions) {
    if (isPackagedCustomAction(a)) continue; // CPQ-packaged action: replaced by standard RCA functions
    const inactive = isFalse(a.SBQQ__Active__c);
    items.push({ id: a.Id, name: s(a.Name), area: 'Code & Process', type: 'Custom Action', active: !inactive, approach: inactive ? 'Retire' : 'Adapt', reason: inactive ? 'inactive' : 'UI action', rcaTarget: 'Transaction Line Editor action / LWC' });
  }
  for (const g of catalog.customizations.guidedSelling) {
    items.push({ id: g.Id, name: s(g.Name), area: 'Code & Process', type: 'Guided Selling Process', active: true, approach: 'Redesign', reason: 'guided selling', rcaTarget: 'Product Discovery guided selection' });
  }
  return items;
}

export function approachSummary(items: ClassifiedItem[]) {
  const areas: Area[] = ['Bundles', 'Product Rules', 'Price Rules', 'Pricing Schedules', 'Code & Process'];
  const rows = areas
    .map((area) => {
      const list = items.filter((i) => i.area === area);
      const count = (a: Approach) => list.filter((i) => i.approach === a).length;
      return { area, items: list.length, Direct: count('Direct'), Adapt: count('Adapt'), Redesign: count('Redesign'), Retire: count('Retire'), hours: list.reduce((h, i) => h + EFFORT_HOURS[i.approach], 0) };
    })
    .filter((r) => r.items > 0);
  const total = rows.reduce(
    (t, r) => ({ items: t.items + r.items, Direct: t.Direct + r.Direct, Adapt: t.Adapt + r.Adapt, Redesign: t.Redesign + r.Redesign, Retire: t.Retire + r.Retire, hours: t.hours + r.hours }),
    { items: 0, Direct: 0, Adapt: 0, Redesign: 0, Retire: 0, hours: 0 },
  );
  return { rows, total, personDays: Math.round((total.hours / 8) * 10) / 10 };
}

// ------------------------------------------------------------------ markdown helpers

/** Escapes a value for a Markdown table cell. */
export const cell = (v: unknown, max = 220) => {
  let t = s(v).replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t.replace(/\|/g, '\\|') || '-';
};
const code = (v: unknown, max = 160) => {
  const t = cell(v, max).replace(/`/g, "'");
  return t === '-' ? '-' : `\`${t}\``;
};
const n = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x.toLocaleString('en-US') : '0';
};
const table = (header: string[], rows: unknown[][]) =>
  [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map((c) => (typeof c === 'string' && c.startsWith('`') ? c : cell(c, 700))).join(' | ')} |`)].join('\n');
const label = (p?: SfRecord) => (p ? (p.ProductCode ? `${s(p.Name)} (${s(p.ProductCode)})` : s(p.Name)) : '-');
const capNote = (shown: number, total: number, what: string) => (total > shown ? `\n\n*Showing ${n(shown)} of ${n(total)} ${what}; the full list is in the Catalog JSON export.*` : '');

// ------------------------------------------------------------------ rule descriptions

const OPERATORS: Record<string, string> = {
  equals: '=',
  'not equals': '≠',
  'less than': '<',
  'less or equals': '≤',
  'greater than': '>',
  'greater or equals': '≥',
  'starts with': 'starts with',
  contains: 'contains',
};
const op = (v: unknown) => OPERATORS[s(v).toLowerCase()] ?? s(v);

function variableName(catalog: CpqCatalog, id?: string) {
  if (!id) return '';
  return s(catalog.rules.summaryVariables.find((v) => v.Id === id)?.Name) || 'summary variable';
}

/** One condition as text, e.g. "Quote Line.Product Code = 'SUB-PRO'". */
export function describeCondition(catalog: CpqCatalog, c: SfRecord): string {
  const subject = c.links?.testedVariable
    ? `[${variableName(catalog, c.links.testedVariable)}]`
    : s(c.SBQQ__TestedFormula__c)
      ? `formula(${s(c.SBQQ__TestedFormula__c)})`
      : [s(c.SBQQ__Object__c ?? c.SBQQ__TestedObject__c), s(c.SBQQ__Field__c ?? c.SBQQ__TestedField__c)].filter(Boolean).join('.');
  const value = c.links?.filterVariable
    ? `[${variableName(catalog, c.links.filterVariable)}]`
    : s(c.SBQQ__FilterFormula__c)
      ? `formula(${s(c.SBQQ__FilterFormula__c)})`
      : `'${s(c.SBQQ__Value__c ?? c.SBQQ__FilterValue__c)}'`;
  return `${subject || '?'} ${op(c.SBQQ__Operator__c)} ${value}`.trim();
}

function conditionsText(catalog: CpqCatalog, rule: SfRecord, conditions: SfRecord[]): string {
  if (!conditions.length) return 'Always';
  const join = s(rule.SBQQ__ConditionsMet__c) === 'Any' ? ' OR ' : ' AND ';
  const body = conditions.map((c) => describeCondition(catalog, c)).join(join);
  const adv = s(rule.SBQQ__AdvancedCondition__c).trim();
  return adv ? `Custom (${adv}): ${body}` : body;
}

function productName(catalog: CpqCatalog, id?: string) {
  if (!id) return '';
  return label(catalog.catalog.products.find((p) => p.Id === id));
}

function priceActionText(a: SfRecord): string {
  const target = [s(a.SBQQ__TargetObject__c), s(a.SBQQ__Field__c)].filter(Boolean).join('.');
  const value = s(a.SBQQ__Formula__c)
    ? `formula ${s(a.SBQQ__Formula__c)}`
    : a.links?.sourceVariable
      ? 'summary variable'
      : s(a.SBQQ__SourceLookupField__c)
        ? `lookup.${s(a.SBQQ__SourceLookupField__c)}`
        : `'${s(a.SBQQ__Value__c)}'`;
  return `${target || '?'} ← ${value}`;
}

// ------------------------------------------------------------------ sections

export interface ReportContext {
  catalog: CpqCatalog;
  items: ClassifiedItem[];
  /** Business purpose per price rule name, written by the model in section 2.2. */
  pricePurposes?: Map<string, string>;
}

export function buildContext(catalog: CpqCatalog): ReportContext {
  return { catalog, items: classifyItems(catalog) };
}

const AREA_NOUN: Record<Area, string> = {
  Bundles: 'bundles',
  'Product Rules': 'product rules & summary variables',
  'Price Rules': 'price rules',
  'Pricing Schedules': 'discount schedules',
  'Code & Process': 'scripts, custom actions & guided selling',
};

export function footprintTable({ catalog, items }: ReportContext): string {
  const k = catalog.summary.kpis;
  const c = catalog.summary.complexity;
  const summary = approachSummary(items);
  const nested = catalog.catalog.products.filter((p) => ((p.bundle as Bundle | undefined)?.levels ?? 0) >= 3).length;
  const flags = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  c.flags.forEach((f) => (flags[f.severity] += 1));
  const inv = (key: string) => catalog.discovery.objects.find((o) => o.key === key)?.recordCount ?? 0;
  const totalRecords = catalog.discovery.objects.filter((o) => o.present).reduce((t, o) => t + (Number(o.recordCount) || 0), 0);
  const rows: unknown[][] = [
    ['Overall migration complexity', `**${c.level}** (${c.score}/100)`],
    ['Products (active / total)', `${n(k.activeProducts)} / ${n(k.totalProducts)}`],
    ['Standalone SKUs (active, not bundles)', n(k.standaloneSkus)],
    ['Bundles (active / total)', `${n(k.activeBundles)} / ${n(k.totalBundles)}`],
    ['Multi-level bundles (3+ tiers) · deepest', `${n(nested)} · ${k.maxBundleLevels || 1} tiers`],
    ['Features · Options (all records)', `${n(inv('features'))} · ${n(inv('options'))}${k.orphanOptions || k.orphanFeatures ? ` (${n(k.orphanFeatures ?? 0)} / ${n(k.orphanOptions ?? 0)} orphaned)` : ''}`],
    ['Option constraints · Configuration attributes', `${n(k.optionConstraints)} · ${n(k.configurationAttributes)}`],
    ['Product rules (active / total) · Summary variables', `${n(k.activeProductRules)} / ${n(k.productRules)} · ${n(k.summaryVariables)}`],
    ['Price rules (active / total)', `${n(k.activePricingRules)} / ${n(k.pricingRules)}`],
    ['Discount schedules · tiers', `${n(k.discountSchedules)} · ${n(inv('discountTiers'))}`],
    ['Price books · entries', `${n(k.pricebooks)} · ${n(k.pricebookEntries)}`],
    ['QCP / custom scripts · Custom actions (org-built)', `${n(k.customScripts)} · ${n(k.customActions ?? 0)}${k.packagedCustomActions ? ` (${n(k.packagedCustomActions)} CPQ-packaged actions excluded)` : ''}`],
    ['Total CPQ configuration records (all extracted objects, Appendix B)', n(totalRecords)],
    [
      'Items assessed for migration',
      `${n(summary.total.items)} (${summary.rows.map((r) => `${n(r.items)} ${AREA_NOUN[r.area]}`).join(' · ') || 'none'})`,
    ],
    ['Indicative configuration effort', `${n(summary.personDays)} person-days (${n(summary.total.hours)} h)`],
    ['Findings (high / medium / low)', `${flags.high} / ${flags.medium} / ${flags.low}`],
  ];
  if (catalog.source.cpqPackageVersion) rows.splice(1, 0, ['CPQ package version', s(catalog.source.cpqPackageVersion)]);
  return table(['Measure', 'Value'], rows);
}

export function keyFindingsTable({ catalog }: ReportContext): string {
  const rows: unknown[][] = [];
  const subs = (catalog.discovery.cutoverVolumes ?? []).filter((v) => /Subscription|Asset/.test(v.name)).reduce((t, v) => t + (v.recordCount ?? 0), 0);
  if (subs > 0) rows.push(['High', 'Transactions', `${n(subs)} subscription/asset record(s) in flight: active contracts must exist as RCA assets for renewals and amendments.`, 'Decide the transactional migration and cut-over strategy.']);
  for (const f of catalog.summary.complexity.flags.slice(0, 12)) {
    rows.push([f.severity.charAt(0).toUpperCase() + f.severity.slice(1), f.title, f.detail, f.rcaGuidance]);
  }
  if (!rows.length) return '*No findings: the configuration maps cleanly to standard RCA constructs.*';
  return table(['Severity', 'Area', 'Finding', 'Recommended action'], rows);
}

export function approachTable(ctx: ReportContext): string {
  const { rows, total } = approachSummary(ctx.items);
  if (!rows.length) return '*No configuration items found.*';
  return [
    table(
      ['Area', 'Items', 'Direct', 'Adapt', 'Redesign', 'Retire', 'Effort (h)'],
      [...rows.map((r) => [r.area, r.items, r.Direct, r.Adapt, r.Redesign, r.Retire, r.hours]), ['**Total**', `**${total.items}**`, total.Direct, total.Adapt, total.Redesign, total.Retire, `**${total.hours}**`]],
    ),
    '',
    '**Direct:** maps to an RCA equivalent with little change. **Adapt:** RCA equivalent exists but needs restructuring. **Redesign:** no direct equivalent; new RCA design needed. **Retire:** inactive or unused; confirm and exclude.',
    '',
    `*Indicative effort covers configuration rebuild only (${EFFORT_HOURS.Direct} h Direct, ${EFFORT_HOURS.Adapt} h Adapt, ${EFFORT_HOURS.Redesign} h Redesign, ${EFFORT_HOURS.Retire} h Retire per item) and excludes data migration, testing, integration and project management. Calibrate after the first migration wave.*`,
  ].join('\n');
}

/** Formats a scan probe: the value, or why it could not be checked. */
function probeText<T>(p: Probe<T> | undefined, fmt: (d: T) => string): string {
  if (!p) return '*Not scanned (re-run the extraction to include the org scope scan).*';
  if (p.status !== 'ok' || p.data === undefined) return `*Could not be checked: ${cell(p.reason ?? 'unavailable', 140)}.*`;
  return fmt(p.data);
}
const sample = (list: string[], max = 5) => (list.length ? `${list.slice(0, max).join(', ')}${list.length > max ? `, +${n(list.length - max)} more` : ''}` : '');
const plural = (x: number | null | undefined, w: string, pl = `${w}s`) => (x == null ? `? ${pl}` : `${n(x)} ${x === 1 ? w : pl}`);

/**
 * Part 3.6: scope outside the CPQ catalog. Each row: what the org scope scan found, and
 * why it matters for the migration. Detail lists are in Appendix E.
 */
export function blindSpotsTable(ctx: ReportContext): string {
  const { catalog } = ctx;
  const scope = catalog.discovery.orgScope;
  const ruleFields = new Set(fieldReferences(ctx).map((f) => f.field));

  const automation = scope
    ? [
        probeText(scope.automation.flows, (f) => `${plural(f.length, 'active flow')} on quoting objects${f.length ? ` (${sample(f.map((x) => `${x.label} on ${x.object}`), 3)})` : ''}`),
        probeText(scope.automation.apexTriggers, (t) => `${plural(t.length, 'Apex trigger')}${t.length ? ` (${sample(t.map((x) => `${x.name} on ${x.object}`), 3)})` : ''}`),
        probeText(scope.automation.validationRules, (v) => `${plural(v.length, 'validation rule')}${v.length ? ` (${sample(v.map((x) => `${x.object}.${x.name}`), 3)})` : ''}`),
      ].join('; ')
    : probeText(undefined, () => '');

  const fields = probeText(scope?.quoteFields, (q) => {
    const unused = [...q.quote, ...q.quoteLine].filter((f) => !ruleFields.has(f)).length;
    const twins = q.twins.length ? `${plural(q.twins.length, 'twin field')} (${sample(q.twins.map((t) => t.field), 4)})` : 'no twin fields detected';
    return `${plural(q.quote.length, 'custom Quote field')} and ${plural(q.quoteLine.length, 'custom Quote Line field')}, ${n(unused)} of them not referenced by any CPQ rule; ${twins}`;
  });

  const docs = probeText(scope?.documents, (d) =>
    [
      `${plural(d.templates.length, 'quote template')}${d.templates.length ? ` (${sample(d.templates, 4)})` : ''}`,
      d.templateSections != null ? plural(d.templateSections, 'template section') : '',
      d.quoteTerms != null ? plural(d.quoteTerms, 'quote term') : '',
      d.generatedDocuments != null ? `${plural(d.generatedDocuments, 'generated quote document')}` : '',
    ]
      .filter(Boolean)
      .join(', '),
  );

  const approvals = probeText(scope?.approvals, (a) =>
    a.installed ? `**Installed**: ${plural(a.rules, 'approval rule')}, ${plural(a.chains, 'approval chain')}${a.approvers != null ? `, ${plural(a.approvers, 'approver')}` : ''}` : 'Not installed',
  );

  const pkgs = scope?.packages.data ?? [];
  const pkgText = scope?.packages.status === 'ok' ? sample(pkgs.map((p) => `${p.name || p.namespace} ${p.version}`), 6) || 'none' : `CPQ ${s(catalog.source.cpqPackageVersion) || 'version unknown'}`;
  const settings = scope
    ? [
        `Packages: ${pkgText}`,
        `Salesforce Billing: ${scope.billing.installed ? '**installed**' : 'not installed'}`,
        probeText(scope.currency, (c) => (c.multiCurrency ? `multi-currency **on** (${c.currencies.join(', ')}; corporate ${c.corporate ?? '?'}${c.datedRates ? '; dated exchange rates' : ''})` : 'single currency')),
        probeText(scope.translations, (t) => {
          const langs = t.userLanguages.filter((l) => l.language !== t.orgLanguage);
          return `${t.cpqLocalizations ? `${plural(t.cpqLocalizations, 'CPQ translation record')}` : 'no CPQ translation records'}${langs.length ? `; users in ${sample(langs.map((l) => `${l.language} (${l.users})`), 4)}` : ''}`;
        }),
      ].join('; ')
    : probeText(undefined, () => '');

  const integ = scope
    ? [
        probeText(scope.integrations.apexClasses, (a) => `${plural(a.referencingCpq.length, 'Apex class', 'Apex classes')} reference CPQ objects${a.withCallouts.length ? `, ${n(a.withCallouts.length)} with external callouts (${sample(a.withCallouts, 3)})` : ''}`),
        probeText(scope.integrations.namedCredentials, (c) => `${plural(c.length, 'named credential')}${c.length ? ` (${sample(c, 3)})` : ''}`),
        probeText(scope.integrations.connectedApps, (c) => `${plural(c.length, 'connected app')}`),
        probeText(scope.integrations.reports, (r) => `${plural(r.referencingCpq.length, 'report')} on CPQ objects/fields (of the ${n(r.scanned)} most recently run)`),
        probeText(scope.integrations.dashboards, (d) => (d.usingCpqReports != null ? `${plural(d.usingCpqReports, 'dashboard')} built on them` : `${plural(d.total, 'dashboard')} in the org`)),
      ].join('; ')
    : probeText(undefined, () => '');

  const users = scope
    ? [
        probeText(scope.users.activeUsers, (u) => `${n(u)} active users`),
        probeText(scope.users.packageLicenses, (l) => sample(l.map((x) => `${x.namespace} licences ${n(x.used)}/${n(x.allowed < 0 ? 0 : x.allowed)} used`)) || 'no CPQ package licences found'),
        probeText(scope.users.permissionSets, (p) => (p.length ? `CPQ permission sets: ${sample(p.map((x) => `${x.label} (${x.assignees})`), 4)}` : 'no CPQ permission sets')),
      ].join('; ')
    : probeText(undefined, () => '');

  const rca = scope
    ? [
        scope.rca.objectsPresent.length ? `RCA objects present: ${sample(scope.rca.objectsPresent, 6)}` : 'No RCA objects provisioned yet',
        scope.rca.objectsMissing.length ? `missing: ${sample(scope.rca.objectsMissing, 4)}` : 'all core RCA objects present',
        probeText(scope.rca.licenses, (l) => {
          const rcaLic = l.filter((x) => /revenue|pricing|product catalog|configurator|rev lifecycle/i.test(x.name));
          return rcaLic.length ? `licences: ${sample(rcaLic.map((x) => `${x.name} ${n(x.used)}/${n(x.total)}`), 3)}` : 'no RCA permission set licences found';
        }),
      ].join('; ')
    : probeText(undefined, () => '');

  const subs = probeText(scope?.subscriptions, (d) => {
    const q = (t: string) => d.quotesByType.find((x) => x.type.toLowerCase() === t)?.count ?? 0;
    return [
      `${plural(d.activeSubscriptions, 'active subscription')} (${plural(d.subscriptionsEndingIn90Days, 'renewal')} due in 90 days)`,
      `${plural(d.activeContracts, 'active contract')} (${n(d.contractsEndingIn180Days ?? 0)} ending in 180 days${d.evergreenContracts ? `, ${n(d.evergreenContracts)} evergreen` : ''})`,
      d.quotesByType.length ? `${n(q('renewal'))} renewal and ${n(q('amendment'))} amendment quotes` : '',
    ]
      .filter(Boolean)
      .join('; ');
  });

  const rows: string[][] = [
    ['**Flows, Apex triggers and validation rules on CPQ objects**', automation, 'Hidden quoting logic that stops running after the move to RCA objects. This is the most common source of migration surprises.'],
    ['**Twin fields and custom fields on Quote / Quote Line** (all fields, not just those referenced by rules)', fields, "They have to be recreated on RCA objects, and CPQ's automatic copying of same-named fields between objects has no RCA equivalent."],
    ['**Quote templates, quote terms and document generation**', docs, 'Not part of the catalog; every template, section and term must be rebuilt in RCA document generation.'],
    ['**Advanced Approvals**', approvals, 'If installed, approval rules, chains and approvers have to be rebuilt (RCA/Flow approvals).'],
    ['**CPQ package version, Salesforce Billing, multi-currency, translations**', settings, 'All change the scope: Billing changes order-to-cash, multi-currency affects price books and decision tables, translations must be re-entered.'],
    ['**Integrations and downstream use** (ERP or billing sync, reports and dashboards on SBQQ fields)', integ, 'These break at cut-over and must be re-pointed to RCA objects and fields.'],
    ['**Users, permission sets and training**', users, 'Licences and permission sets must be replaced, and every user retrained on the Transaction Line Editor: change management is a project workstream.'],
    ['**RCA licensing and org prerequisites; running CPQ and RCA side by side during cut-over**', rca, 'Missing licences or prerequisites block the build; a coexistence plan decides which deals stay on CPQ and for how long.'],
    ['**Renewals and amendments of in-flight subscriptions**', subs, 'Active contracts must exist as RCA assets before they can be renewed or amended: the riskiest part of the data migration.'],
  ];
  return [
    'The CPQ catalog extraction covers products, bundles, rules and pricing setup. The migration also depends on the org configuration below, which was checked by the org scope scan; full lists are in Appendix E.',
    '',
    table(['Area', 'Found in this org', 'Why it matters'], rows),
  ].join('\n');
}

/** Appendix E: full lists behind the 3.6 summary. */
export function scopeAppendix(ctx: ReportContext): string {
  const scope = ctx.catalog.discovery.orgScope;
  if (!scope) return '*The org scope scan was not run for this extraction. Re-run the extraction to include it.*';
  const ruleFields = new Set(fieldReferences(ctx).map((f) => f.field));
  const out: string[] = [`*Scanned ${new Date(scope.scannedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC. Read-only queries; nothing was changed in the org.*`, ''];
  const section = <T,>(title: string, p: Probe<T[]>, header: string[], row: (x: T) => unknown[], empty: string) => {
    out.push(`### ${title}`, '');
    if (p.status !== 'ok' || !p.data) out.push(`*Could not be checked: ${cell(p.reason ?? 'unavailable', 200)}.*`, '');
    else if (!p.data.length) out.push(`*${empty}*`, '');
    else out.push(table(header, p.data.slice(0, 200).map(row)), capNote(Math.min(p.data.length, 200), p.data.length, title.toLowerCase()), '');
  };
  section('E.1 Flows on quoting objects', scope.automation.flows, ['Flow', 'Type', 'Trigger', 'Object'], (f) => [f.label, f.type, f.trigger, code(f.object)], 'No active flows on quoting objects.');
  section('E.2 Apex triggers', scope.automation.apexTriggers, ['Trigger', 'Object'], (t) => [code(t.name), code(t.object)], 'No custom Apex triggers on quoting objects.');
  section('E.3 Validation rules', scope.automation.validationRules, ['Rule', 'Object', 'Error message'], (v) => [code(v.name), code(v.object), v.message], 'No active validation rules on quoting objects.');
  const q = scope.quoteFields;
  const fieldRows: Probe<Array<{ object: string; field: string; twin: string; used: boolean }>> =
    q.status === 'ok' && q.data
      ? {
          status: 'ok',
          data: [
            ...q.data.quote.map((f) => ({ object: 'Quote', field: f, twin: '', used: ruleFields.has(f) })),
            ...q.data.quoteLine.map((f) => ({ object: 'Quote Line', field: f, twin: q.data!.twins.find((t) => t.field === f)?.objects.join(', ') ?? '', used: ruleFields.has(f) })),
          ],
        }
      : { status: 'unavailable', reason: q.reason };
  section('E.4 Custom fields on Quote and Quote Line', fieldRows, ['Object', 'Field', 'Used by CPQ rules', 'Twin field on'], (f) => [f.object, code(f.field), f.used ? 'Yes' : 'No', f.twin || '-'], 'No custom fields on Quote or Quote Line.');
  section('E.5 Installed packages', scope.packages, ['Package', 'Namespace', 'Version'], (p) => [p.name, code(p.namespace), p.version], 'No managed packages found.');
  const ai = scope.integrations;
  const classes: Probe<Array<{ name: string; callout: boolean }>> =
    ai.apexClasses.status === 'ok' && ai.apexClasses.data
      ? { status: 'ok', data: ai.apexClasses.data.referencingCpq.map((name) => ({ name, callout: ai.apexClasses.data!.withCallouts.includes(name) })) }
      : { status: 'unavailable', reason: ai.apexClasses.reason };
  section('E.6 Apex classes referencing CPQ', classes, ['Class', 'External callouts'], (c) => [code(c.name), c.callout ? 'Yes' : 'No'], 'No Apex classes reference CPQ objects.');
  section('E.7 Reports on CPQ objects or fields', ai.reports.status === 'ok' ? { status: 'ok', data: ai.reports.data!.referencingCpq } : { status: 'unavailable', reason: ai.reports.reason }, ['Report', 'Folder', 'Report type'], (r) => [r.name, r.folder, r.reportType], 'None of the most recently run reports use CPQ objects.');
  section('E.8 Named credentials (integration endpoints)', ai.namedCredentials, ['Named credential'], (c) => [c], 'No named credentials.');
  section('E.9 CPQ permission sets', scope.users.permissionSets, ['Permission set', 'API name', 'Assigned users'], (p) => [p.label, code(p.name), n(p.assignees)], 'No CPQ permission sets.');
  return out.join('\n').trim();
}

export function cutoverTable({ catalog }: ReportContext): string {
  const v = (catalog.discovery.cutoverVolumes ?? []).filter((x) => x.recordCount !== null);
  if (!v.length) return '*Transactional volumes were not available for this extraction.*';
  return `${table(['Object', 'Records', 'Suggested RCA target'], v.map((x) => [x.label, n(x.recordCount ?? 0), x.rcaTarget]))}\n\n*Counts only: transactional records are not extracted.*`;
}

export function bundleTable({ catalog, items }: ReportContext, max = 100): string {
  const approach = new Map(items.map((i) => [i.id, i]));
  const bundles = catalog.catalog.products
    .filter((p) => p.bundle)
    .sort((a, b) => ((b.bundle as Bundle).levels ?? 0) - ((a.bundle as Bundle).levels ?? 0) || (b.bundle as Bundle).options.length - (a.bundle as Bundle).options.length);
  if (!bundles.length) return '*No bundles (products with features or options) were found.*';
  const rows = bundles.slice(0, max).map((p) => {
    const b = p.bundle as Bundle;
    const required = b.options.filter((o) => o.SBQQ__Required__c === true).length;
    const selected = b.options.filter((o) => o.SBQQ__Selected__c === true).length;
    return [
      label(p),
      isFalse(p.IsActive) ? 'Inactive' : 'Active',
      b.levels ?? 2,
      b.features.length,
      `${b.options.length} (${required} req, ${selected} default)`,
      b.configurationAttributes.length,
      b.configurationRules.length,
      approach.get(p.Id)?.approach ?? '-',
    ];
  });
  return table(['Bundle', 'Status', 'Tiers', 'Features', 'Options', 'Attributes', 'Rules', 'Approach'], rows) + capNote(rows.length, bundles.length, 'bundles');
}

/** Feature → options outline for the most complex bundles (how the catalog is organised). */
export function bundleStructure({ catalog }: ReportContext, maxBundles = 3, maxOptions = 8): string {
  const productsById = new Map(catalog.catalog.products.map((p) => [p.Id, p]));
  const bundles = catalog.catalog.products
    .filter((p) => p.bundle && !isFalse(p.IsActive))
    .sort((a, b) => ((b.bundle as Bundle).levels ?? 0) - ((a.bundle as Bundle).levels ?? 0) || (b.bundle as Bundle).options.length - (a.bundle as Bundle).options.length)
    .slice(0, maxBundles);
  if (!bundles.length) return '';
  const out: string[] = [];
  for (const p of bundles) {
    const b = p.bundle as Bundle;
    out.push(`- **${label(p)}** · ${b.levels ?? 2} tiers`);
    const optionsById = new Map(b.options.map((o) => [o.Id, o]));
    const optLine = (o: SfRecord) => {
      const child = productsById.get(o.links?.product ?? '');
      const flags = [o.SBQQ__Required__c === true && 'required', o.SBQQ__Selected__c === true && 'default', child?.bundle && 'nested bundle', s(o.SBQQ__Type__c)].filter(Boolean).join(', ');
      return `    - ${label(child) || 'Unknown product'}${flags ? ` *(${flags})*` : ''}`;
    };
    for (const f of b.features) {
      const ids = (f.optionIds as string[]) ?? [];
      out.push(`  - Feature **${s(f.Name)}**${f.SBQQ__OptionSelectionMethod__c ? ` (${s(f.SBQQ__OptionSelectionMethod__c)})` : ''}: ${ids.length} option(s)`);
      ids.slice(0, maxOptions).forEach((id) => optionsById.get(id) && out.push(optLine(optionsById.get(id)!)));
      if (ids.length > maxOptions) out.push(`    - … ${ids.length - maxOptions} more`);
    }
    const loose = b.options.filter((o) => !o.links?.feature);
    if (loose.length) {
      out.push(`  - Options without a feature: ${loose.length}`);
      loose.slice(0, maxOptions).forEach((o) => out.push(optLine(o)));
    }
    if (b.configurationAttributes.length) out.push(`  - Attributes: ${b.configurationAttributes.map((a) => s(a.Name)).join(', ')}`);
  }
  return out.join('\n');
}

export function productRuleLogicTable(ctx: ReportContext, max = 150): string {
  const { catalog, items } = ctx;
  const approach = new Map(items.map((i) => [i.id, i]));
  const rules = [...catalog.rules.productRules].sort((a, b) => Number(isFalse(a.SBQQ__Active__c)) - Number(isFalse(b.SBQQ__Active__c)) || s(a.SBQQ__Type__c).localeCompare(s(b.SBQQ__Type__c)));
  if (!rules.length) return '*No product rules.*';
  const rows = rules.slice(0, max).map((r) => {
    const bundles = ((r.appliesToBundleIds as string[]) ?? []).map((id) => productName(catalog, id)).filter(Boolean);
    const actions = arr(r.actions).map((a) =>
      s(a.SBQQ__FilterField__c) && !a.links?.product
        ? `Filter: ${s(a.SBQQ__FilterField__c)} ${op(a.SBQQ__Operator__c)} '${s(a.SBQQ__FilterValue__c)}'`
        : `${s(a.SBQQ__Type__c) || 'Action'} ${productName(catalog, a.links?.product)}`.trim(),
    );
    const msg = s(r.SBQQ__ErrorMessage__c);
    return [
      r.Name,
      `${s(r.SBQQ__Type__c)}${isFalse(r.SBQQ__Active__c) ? ' (inactive)' : ''}`,
      `${s(r.SBQQ__EvaluationEvent__c).replace(/;/g, ', ') || '-'}${bundles.length ? ` · ${bundles.slice(0, 3).join(', ')}${bundles.length > 3 ? ` +${bundles.length - 3}` : ''}` : ''}`,
      code(conditionsText(catalog, r, arr(r.errorConditions))),
      [actions.join('; '), msg && `"${msg}"`].filter(Boolean).join(' · ') || '-',
      approach.get(r.Id)?.approach ?? '-',
    ];
  });
  return table(['Rule', 'Type', 'Runs on · Applies to', 'Conditions', 'Actions / message', 'Approach'], rows) + capNote(rows.length, rules.length, 'product rules');
}

export function priceRuleLogicTable(ctx: ReportContext, max = 150): string {
  const { catalog, items } = ctx;
  const approach = new Map(items.map((i) => [i.id, i]));
  const rules = [...catalog.rules.priceRules].sort((a, b) => Number(isFalse(a.SBQQ__Active__c)) - Number(isFalse(b.SBQQ__Active__c)) || Number(a.SBQQ__EvaluationOrder__c ?? 1e9) - Number(b.SBQQ__EvaluationOrder__c ?? 1e9));
  if (!rules.length) return '*No price rules.*';
  const rows = rules.slice(0, max).map((r) => [
    `${s(r.Name)}${isFalse(r.SBQQ__Active__c) ? ' (inactive)' : ''}`,
    `${s(r.SBQQ__EvaluationEvent__c).replace(/;/g, ', ') || '-'}${r.SBQQ__EvaluationOrder__c != null ? ` · order ${s(r.SBQQ__EvaluationOrder__c)}` : ''}`,
    code(conditionsText(catalog, r, arr(r.conditions))),
    code(arr(r.actions).map(priceActionText).join('; ') || '-'),
    r.SBQQ__LookupObject__c ? `${s(r.SBQQ__LookupObject__c)} (${arr(r.lookupQueries).length} quer${arr(r.lookupQueries).length === 1 ? 'y' : 'ies'})` : '-',
    approach.get(r.Id)?.approach ?? '-',
  ]);
  return table(['Price rule', 'Event · order', 'Conditions', 'Sets', 'Lookup table', 'Approach'], rows) + capNote(rows.length, rules.length, 'price rules');
}

const ruleSort = (a: SfRecord, b: SfRecord) =>
  Number(isFalse(a.SBQQ__Active__c)) - Number(isFalse(b.SBQQ__Active__c)) || s(a.SBQQ__Type__c).localeCompare(s(b.SBQQ__Type__c)) || s(a.Name).localeCompare(s(b.Name));

/** Part 2.1: every product rule explained in plain English. */
export function productRuleTable(ctx: ReportContext, max = 150): string {
  const { catalog, items } = ctx;
  const approach = new Map(items.map((i) => [i.id, i]));
  const rules = [...catalog.rules.productRules].sort(ruleSort);
  if (!rules.length) return '*No product rules.*';
  const rows = rules.slice(0, max).map((r) => [
    `**${s(r.Name)}**`,
    `${s(r.SBQQ__Type__c) || '-'}${isFalse(r.SBQQ__Active__c) ? ' (inactive)' : ''}`,
    explainProductRule(catalog, r),
    approach.get(r.Id)?.approach ?? '-',
  ]);
  return (
    table(['Rule', 'Type', 'What it does (plain English)', 'Approach'], rows) +
    capNote(rows.length, rules.length, 'product rules') +
    '\n\n*Exact conditions and actions for each rule are listed in Appendix D.*'
  );
}

const priceRuleOrder = (a: SfRecord, b: SfRecord) =>
  Number(isFalse(a.SBQQ__Active__c)) - Number(isFalse(b.SBQQ__Active__c)) || Number(a.SBQQ__EvaluationOrder__c ?? 1e9) - Number(b.SBQQ__EvaluationOrder__c ?? 1e9) || s(a.Name).localeCompare(s(b.Name));

/**
 * Part 2.2: every price rule in one table: purpose (business purpose from the model when it
 * wrote one, else derived from the actions), trigger, conditions, actions and approach.
 */
export function priceRuleDetails(ctx: ReportContext, max = 150): string {
  const { catalog, items } = ctx;
  const approach = new Map(items.map((i) => [i.id, i]));
  const rules = [...catalog.rules.priceRules].sort(priceRuleOrder);
  if (!rules.length) return '*No price rules.*';
  const rows = rules.slice(0, max).map((r) => {
    const p = explainPriceRuleParts(catalog, r);
    const business = ctx.pricePurposes?.get(s(r.Name).trim().toLowerCase());
    return [
      `**${cell(r.Name, 80)}**${isFalse(r.SBQQ__Active__c) ? ' (inactive)' : ''}`,
      cell(business ? business.replace(/\s*\.?$/, '.') : p.purpose, 300),
      cell(p.trigger.replace(/\.$/, ''), 300),
      cell(p.conditions, 500),
      cell(p.actions.join(' '), 600),
      approach.get(r.Id)?.approach ?? '-',
    ];
  });
  return (
    table(['Price rule', 'Purpose', 'Trigger / evaluation event', 'Conditions', 'Actions', 'Approach'], rows) +
    capNote(rows.length, rules.length, 'price rules') +
    '\n\n*Field API names and raw formulas for each rule are listed in Appendix D.*'
  );
}

/** Compact one-row-per-rule version of the price rules (kept for exports and very large orgs). */
export function priceRuleTable(ctx: ReportContext, max = 150): string {
  const { catalog, items } = ctx;
  const approach = new Map(items.map((i) => [i.id, i]));
  const rules = [...catalog.rules.priceRules].sort(
    (a, b) => Number(isFalse(a.SBQQ__Active__c)) - Number(isFalse(b.SBQQ__Active__c)) || Number(a.SBQQ__EvaluationOrder__c ?? 1e9) - Number(b.SBQQ__EvaluationOrder__c ?? 1e9),
  );
  if (!rules.length) return '*No price rules.*';
  const rows = rules.slice(0, max).map((r) => [
    `**${s(r.Name)}**${isFalse(r.SBQQ__Active__c) ? ' (inactive)' : ''}`,
    explainPriceRule(catalog, r),
    approach.get(r.Id)?.approach ?? '-',
  ]);
  return (
    table(['Price rule', 'What it does (plain English)', 'Approach'], rows) +
    capNote(rows.length, rules.length, 'price rules') +
    '\n\n*Exact conditions, target fields and formulas for each rule are listed in Appendix D.*'
  );
}

export function supportingLogicTable({ catalog }: ReportContext): string {
  const rows: unknown[][] = [];
  for (const v of catalog.rules.summaryVariables) {
    const filter = s(v.SBQQ__FilterField__c) ? ` where ${s(v.SBQQ__FilterField__c)} ${op(v.SBQQ__Operator__c)} '${s(v.SBQQ__FilterValue__c)}'` : '';
    rows.push([v.Name, 'Summary variable', code(`${s(v.SBQQ__AggregateFunction__c)}(${s(v.SBQQ__AggregateField__c)}) over ${s(v.SBQQ__TargetObject__c)}${filter}`), 'Pricing Procedure aggregation']);
  }
  for (const d of catalog.pricing.discountSchedules.slice(0, 50)) {
    const tiers = arr(d.tiers).map((t) => `${s(t.SBQQ__LowerBound__c)}-${s(t.SBQQ__UpperBound__c) || '∞'}: ${s(t.SBQQ__Discount__c ?? t.SBQQ__DiscountAmount__c ?? t.SBQQ__Price__c)}`).join(', ');
    rows.push([d.Name, `Discount schedule (${s(d.SBQQ__Type__c)})`, tiers || '-', d.links?.account ? 'Account-specific price adjustment' : 'PriceAdjustmentSchedule']);
  }
  if (!rows.length) return '';
  return table(['Name', 'Kind', 'Definition', 'RCA target'], rows);
}

/** Custom (non-CPQ) fields referenced by rules/attributes: they must exist in the RCA context. */
export function fieldReferences({ catalog }: ReportContext): Array<{ field: string; usedBy: string[] }> {
  const map = new Map<string, Set<string>>();
  const add = (text: unknown, user: string) => {
    for (const m of s(text).matchAll(/\b([A-Za-z][A-Za-z0-9_]*__c)\b/g)) {
      const f = m[1];
      if (f.startsWith('SBQQ__') || f.startsWith('sbaa__')) continue;
      (map.get(f) ?? map.set(f, new Set()).get(f)!).add(user);
    }
  };
  for (const r of catalog.rules.productRules) {
    for (const c of arr(r.errorConditions)) [c.SBQQ__TestedField__c, c.SBQQ__FilterFormula__c, c.SBQQ__TestedFormula__c].forEach((t) => add(t, s(r.Name)));
    for (const a of arr(r.actions)) [a.SBQQ__FilterField__c, a.SBQQ__ValueField__c].forEach((t) => add(t, s(r.Name)));
    for (const q of arr(r.lookupQueries)) [q.SBQQ__TestedField__c, q.SBQQ__LookupField__c].forEach((t) => add(t, s(r.Name)));
  }
  for (const r of catalog.rules.priceRules) {
    for (const c of arr(r.conditions)) [c.SBQQ__Field__c, c.SBQQ__TestedFormula__c, c.SBQQ__FilterFormula__c].forEach((t) => add(t, s(r.Name)));
    for (const a of arr(r.actions)) [a.SBQQ__Field__c, a.SBQQ__Formula__c, a.SBQQ__SourceLookupField__c].forEach((t) => add(t, s(r.Name)));
    for (const q of arr(r.lookupQueries)) [q.SBQQ__TestedField__c, q.SBQQ__LookupField__c].forEach((t) => add(t, s(r.Name)));
  }
  for (const v of catalog.rules.summaryVariables) [v.SBQQ__AggregateField__c, v.SBQQ__FilterField__c].forEach((t) => add(t, s(v.Name)));
  for (const p of catalog.catalog.products) {
    for (const a of (p.bundle as Bundle | undefined)?.configurationAttributes ?? []) add(a.SBQQ__TargetField__c, label(p));
  }
  return [...map.entries()].map(([field, users]) => ({ field, usedBy: [...users].sort() })).sort((a, b) => b.usedBy.length - a.usedBy.length || a.field.localeCompare(b.field));
}

export function fieldReferenceTable(ctx: ReportContext): string {
  const refs = fieldReferences(ctx);
  if (!refs.length) return '*No custom fields are referenced by CPQ rules or attributes.*';
  return (
    'These fields must exist in RCA (on Quote / Quote Line Item or in the context definition) for migrated rules to work.\n\n' +
    table(['Field', 'Used by'], refs.slice(0, 200).map((r) => [code(r.field), r.usedBy.slice(0, 12).join(', ') + (r.usedBy.length > 12 ? ` +${r.usedBy.length - 12} more` : '')]))
  );
}

export function inventoryTable({ catalog }: ReportContext): string {
  return table(
    ['CPQ object', 'Category', 'Records', 'Suggested RCA target'],
    catalog.discovery.objects.map((o) => [code(o.name), o.category, o.present ? `${n(o.recordCount)}${o.truncated ? ' (capped)' : ''}${o.error ? ' (read error)' : ''}` : 'Not in org', o.rcaTarget]),
  );
}

export function flagsTable({ catalog }: ReportContext): string {
  const c = catalog.summary.complexity;
  if (!c.flags.length) return '*No complexity indicators.*';
  return table(
    ['Severity', 'Indicator', 'Count', 'RCA guidance'],
    c.flags.map((f) => [f.severity.charAt(0).toUpperCase() + f.severity.slice(1), `**${f.title}**: ${f.detail}`, n(f.count), f.rcaGuidance]),
  );
}

// ------------------------------------------------------------------ placeholders

export interface Placeholder {
  key: string;
  part: 1 | 2 | 3;
  /** Short description given to the model. */
  hint: string;
  render: (ctx: ReportContext) => string;
  /** Heading added when the model left out this placeholder (and its heading). */
  heading?: string;
}

export const PLACEHOLDERS: Placeholder[] = [
  { key: 'FOOTPRINT', part: 1, hint: 'catalog footprint & effort table', render: footprintTable },
  { key: 'KEY_FINDINGS', part: 1, hint: 'key findings table', render: keyFindingsTable },
  { key: 'BUNDLE_TABLE', part: 1, hint: 'bundle inventory table', render: (c) => bundleTable(c) },
  { key: 'BUNDLE_STRUCTURE', part: 1, hint: 'feature/option outline of the main bundles', render: (c) => bundleStructure(c) },
  { key: 'PRODUCT_RULE_TABLE', part: 2, hint: 'every product rule explained in plain English', render: (c) => productRuleTable(c) },
  { key: 'PRICE_RULE_TABLE', part: 2, hint: 'price rule table: purpose, trigger, conditions, actions', render: (c) => priceRuleDetails(c) },
  { key: 'SUPPORTING_LOGIC', part: 2, hint: 'summary variables & discount schedules', render: supportingLogicTable },
  { key: 'APPROACH_SUMMARY', part: 3, hint: 'migration approach & effort by area', render: approachTable },
  { key: 'CUTOVER_VOLUMES', part: 3, hint: 'transactional volumes for cut-over', render: cutoverTable },
  { key: 'BLIND_SPOTS', part: 3, hint: 'scope outside the catalog extraction', render: blindSpotsTable, heading: '## 3.6 Dependencies outside the CPQ catalog' },
];

const PART_HEADING = (part: number) => new RegExp(`^#\\s+Part\\s+${part}\\b.*$`, 'im');

/**
 * Replaces {{KEY}} markers with generated tables. Markers the model forgot are inserted
 * at the end of their part, so no fact table is ever lost. Unknown markers are removed.
 */
/**
 * Pulls the model's "- **Rule name**: purpose" bullets out of section 2.2 so each purpose is
 * shown inside its rule's block instead of as a second list of the same rules.
 */
export function extractPricePurposes(markdown: string, ctx: ReportContext): { markdown: string; purposes: Map<string, string> } {
  const purposes = new Map<string, string>();
  const names = new Set(ctx.catalog.rules.priceRules.map((r) => s(r.Name).trim().toLowerCase()));
  const start = markdown.search(/^##\s+2\.2\b.*$/m);
  if (start < 0 || !names.size) return { markdown, purposes };
  const bodyStart = markdown.indexOf('\n', start) + 1 || markdown.length;
  const nextHeading = markdown.slice(bodyStart).search(/^#{1,2}\s/m);
  const end = nextHeading < 0 ? markdown.length : bodyStart + nextHeading;
  const section = markdown
    .slice(start, end)
    .split('\n')
    .filter((line) => {
      const m = /^\s*[-*]\s+\*\*(.+?)\*\*\s*(?:\(inactive\))?\s*[:\u2013\u2014-]\s*(.+)$/.exec(line);
      const key = m?.[1].replace(/:$/, '').trim().toLowerCase();
      if (!m || !key || !names.has(key)) return true;
      purposes.set(key, m[2].trim());
      return false;
    })
    .join('\n');
  return { markdown: markdown.slice(0, start) + section + markdown.slice(end), purposes };
}

export function expandReport(markdown: string, baseCtx: ReportContext): string {
  const extracted = extractPricePurposes(markdown.replace(/\r\n/g, '\n'), baseCtx);
  const ctx: ReportContext = { ...baseCtx, pricePurposes: extracted.purposes };
  let md = extracted.markdown;
  for (const ph of PLACEHOLDERS) {
    const re = new RegExp(`\\{\\{\\s*${ph.key}\\s*\\}\\}`, 'g');
    const rendered = ph.render(ctx).trim();
    if (re.test(md)) {
      let first = true;
      md = md.replace(re, () => {
        const out = first ? rendered : '';
        first = false;
        return out;
      });
    } else if (rendered) {
      const next = md.search(PART_HEADING(ph.part + 1));
      const heading = ph.heading && !md.includes(ph.heading) ? `${ph.heading}\n\n` : '';
      const block = `\n\n${heading}${rendered}\n`;
      md = next >= 0 ? `${md.slice(0, next).trimEnd()}${block}\n${md.slice(next)}` : `${md.trimEnd()}${block}`;
    }
  }
  md = md.replace(/\{\{\s*[A-Z_]+\s*\}\}/g, '');
  return md.replace(/\n{3,}/g, '\n\n');
}

/** Deterministic appendices appended after the AI narrative. */
export function appendices(ctx: ReportContext): string {
  return [
    '# Appendices',
    '',
    '*Generated directly from the catalog extraction (not by the AI model). They are the source of truth for counts.*',
    '',
    '## Appendix A. Custom fields referenced by CPQ logic',
    '',
    fieldReferenceTable(ctx),
    '',
    '## Appendix B. Extracted record inventory',
    '',
    inventoryTable(ctx),
    '',
    '## Appendix C. Migration complexity indicators',
    '',
    `Overall: **${ctx.catalog.summary.complexity.level}** (${ctx.catalog.summary.complexity.score}/100).`,
    '',
    flagsTable(ctx),
    '',
    '## Appendix D. Rule logic (technical detail)',
    '',
    'Exact conditions and actions behind the plain-English explanations in Part 2, using Salesforce field API names.',
    '',
    '### D.1 Product rules',
    '',
    productRuleLogicTable(ctx),
    '',
    '### D.2 Price rules',
    '',
    priceRuleLogicTable(ctx),
    '',
    '## Appendix E. Org scope scan (outside the CPQ catalog)',
    '',
    scopeAppendix(ctx),
  ].join('\n');
}

/** Final Markdown stored on the report: version marker + expanded AI text + appendices. */
const LATEX: Record<string, string> = { le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', times: '×', rightarrow: '→', to: '→', approx: '≈', pm: '±' };

/** Removes LaTeX-style math the model sometimes emits, e.g. "$\\le$ 100" → "≤ 100". */
export function cleanAiMarkdown(md: string): string {
  return md
    .replace(/\$\s*\\([a-z]+)\s*\$/gi, (m, cmd: string) => LATEX[cmd.toLowerCase()] ?? m)
    .replace(/\\(le|leq|ge|geq|neq|times|rightarrow)\b/g, (_m, cmd: string) => LATEX[cmd]);
}

export function assembleReport(aiMarkdown: string, catalog: CpqCatalog): string {
  const ctx = buildContext(catalog);
  const body = expandReport(cleanAiMarkdown(aiMarkdown), ctx).trim();
  return `${REPORT_VERSION_MARKER}\n\n${body}\n\n${appendices(ctx)}\n`;
}
