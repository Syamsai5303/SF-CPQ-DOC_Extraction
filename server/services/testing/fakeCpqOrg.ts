/**
 * In-memory fake of a CPQ org implementing SfConnectionLike. Used by tests and the
 * local demo/benchmark script: supports describeGlobal, describe, COUNT(), simple
 * `WHERE <field> = true` filters and query/queryMore pagination.
 */
import type { DescribeField, QueryPage, SfConnectionLike } from '../cpqCatalogExtractor.ts';

type Rec = Record<string, unknown> & { Id: string };

export interface FakeOrgOptions {
  products?: number;
  bundles?: number;
  pageSize?: number;
  /** Objects to leave out of describeGlobal (simulates older package versions). */
  omitObjects?: string[];
}

const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(15 - prefix.length, '0')}`;

export function createFakeCpqOrg(opts: FakeOrgOptions = {}) {
  const nProducts = opts.products ?? 2_000;
  const nBundles = Math.min(opts.bundles ?? 300, Math.floor(nProducts / 4));
  const pageSize = opts.pageSize ?? 2_000;
  const tables: Record<string, Rec[]> = {};
  const put = (obj: string, r: Rec) => (tables[obj] ??= []).push(r);
  const audit = { CreatedDate: '2024-01-01T00:00:00.000+0000', LastModifiedById: '005000000000001', SystemModstamp: '2024-01-01T00:00:00.000+0000', OwnerId: '005000000000001' };

  // ---- catalog
  put('Pricebook2', { Id: id('01s', 1), Name: 'Standard Price Book', IsActive: true, IsStandard: true, ...audit });
  put('Pricebook2', { Id: id('01s', 2), Name: 'Partner', IsActive: true, IsStandard: false, ...audit });
  for (let i = 0; i < nProducts; i++) {
    const isBundle = i < nBundles;
    put('Product2', {
      Id: id('01t', i),
      Name: isBundle ? `Bundle ${i}` : `SKU ${i}`,
      ProductCode: `P-${i}`,
      IsActive: i % 17 !== 0,
      Family: ['Hardware', 'Software', 'Services'][i % 3],
      Description: null,
      SBQQ__ConfigurationType__c: isBundle ? 'Allowed' : null,
      SBQQ__PricingMethod__c: i % 97 === 0 ? 'Block' : i % 89 === 0 ? 'Cost' : i % 83 === 0 ? 'Percent Of Total' : 'List',
      SBQQ__SubscriptionPricing__c: i % 3 === 1 ? 'Fixed Price' : null,
      SBQQ__ExternallyConfigurable__c: i === 5,
      Custom_Attribute__c: `attr-${i % 5}`,
      ...audit,
    });
    for (let pb = 1; pb <= 2; pb++) {
      put('PricebookEntry', { Id: id('01u', i * 2 + pb), Pricebook2Id: id('01s', pb), Product2Id: id('01t', i), UnitPrice: 100 + i, IsActive: true, UseStandardPrice: false, ...audit });
    }
  }

  // ---- bundles: 2 features x 3 options each; some options are themselves bundles
  let optN = 0;
  let featN = 0;
  for (let b = 0; b < nBundles; b++) {
    const bundleId = id('01t', b);
    for (let f = 0; f < 2; f++) {
      const featureId = id('a0F', featN++);
      put('SBQQ__ProductFeature__c', { Id: featureId, Name: `Feature ${f + 1}`, SBQQ__ConfiguredSKU__c: bundleId, SBQQ__Number__c: (f + 1) * 10, SBQQ__MinOptionCount__c: f === 0 ? 1 : null, SBQQ__OptionSelectionMethod__c: b % 50 === 0 && f === 1 ? 'Dynamic' : 'Click', ...audit });
      for (let o = 0; o < 3; o++) {
        // b < 30: first option of feature 1 points to the next bundle -> nesting chains
        const nested = f === 0 && o === 0 && b < 30 && b % 3 !== 2;
        const child = nested ? b + 1 : nBundles + ((b * 6 + f * 3 + o) % (nProducts - nBundles));
        put('SBQQ__ProductOption__c', {
          Id: id('a0O', optN++),
          SBQQ__ConfiguredSKU__c: bundleId,
          SBQQ__OptionalSKU__c: id('01t', child),
          SBQQ__Feature__c: featureId,
          SBQQ__Number__c: o + 1,
          SBQQ__Type__c: o === 2 ? 'Accessory' : 'Component',
          SBQQ__Required__c: o === 0,
          SBQQ__Selected__c: o === 0,
          SBQQ__Quantity__c: 1,
          ...audit,
        });
      }
    }
    if (b % 10 === 0) {
      put('SBQQ__OptionConstraint__c', { Id: id('a0C', b), SBQQ__ConfiguredSKU__c: bundleId, SBQQ__ConstrainingOption__c: id('a0O', optN - 6), SBQQ__ConstrainedOption__c: id('a0O', optN - 5), SBQQ__Type__c: b % 20 ? 'Dependency' : 'Exclusion', SBQQ__Active__c: true, ...audit });
      put('SBQQ__ConfigurationAttribute__c', { Id: id('a0A', b), Name: 'Color', SBQQ__Product__c: bundleId, SBQQ__TargetField__c: 'Color__c', ...audit });
    }
  }
  // circular reference: bundle 40 -> 41 -> 40
  if (nBundles > 41) {
    put('SBQQ__ProductOption__c', { Id: id('a0O', optN++), SBQQ__ConfiguredSKU__c: id('01t', 40), SBQQ__OptionalSKU__c: id('01t', 41), SBQQ__Number__c: 99, SBQQ__Type__c: 'Component' });
    put('SBQQ__ProductOption__c', { Id: id('a0O', optN++), SBQQ__ConfiguredSKU__c: id('01t', 41), SBQQ__OptionalSKU__c: id('01t', 40), SBQQ__Number__c: 99, SBQQ__Type__c: 'Component' });
  }

  // ---- rules
  put('SBQQ__SummaryVariable__c', { Id: id('a0S', 1), Name: 'Total Hardware Qty', SBQQ__AggregateFunction__c: 'Sum', SBQQ__AggregateField__c: 'Quantity', SBQQ__TargetObject__c: 'Quote Line' });
  for (let r = 0; r < 50; r++) {
    const ruleId = id('a0R', r);
    put('SBQQ__ProductRule__c', { Id: ruleId, Name: `Product Rule ${r}`, SBQQ__Type__c: ['Validation', 'Alert', 'Selection', 'Filter'][r % 4], SBQQ__Active__c: r % 9 !== 0, SBQQ__EvaluationEvent__c: 'Load;Edit;Save', SBQQ__ConditionsMet__c: r % 7 === 0 ? 'Custom' : 'All', SBQQ__AdvancedCondition__c: r % 7 === 0 ? '1 AND (2 OR 3)' : null, SBQQ__LookupObject__c: r % 11 === 0 ? 'Lookup_Data__c' : null, SBQQ__ErrorMessage__c: r % 4 === 0 ? 'Quantity must not exceed 1 for this bundle.' : r % 4 === 1 ? 'Consider adding the support package.' : null, ...audit });
    const nCond = r % 13 === 0 ? 7 : 2;
    for (let c = 0; c < nCond; c++) put('SBQQ__ErrorCondition__c', { Id: id('a0E', r * 10 + c), SBQQ__Rule__c: ruleId, SBQQ__TestedObject__c: 'Product Option', SBQQ__TestedField__c: 'SBQQ__Quantity__c', SBQQ__Operator__c: 'greater than', SBQQ__FilterValue__c: '1', SBQQ__TestedVariable__c: c === 0 && r === 0 ? id('a0S', 1) : null });
    const ruleType = ['Validation', 'Alert', 'Selection', 'Filter'][r % 4];
    if (ruleType === 'Selection') {
      put('SBQQ__ProductAction__c', { Id: id('a0P', r), SBQQ__Rule__c: ruleId, SBQQ__Product__c: id('01t', nBundles + r), SBQQ__Type__c: r % 8 === 2 ? 'Add' : 'Disable & Remove', SBQQ__Required__c: true });
    } else if (ruleType === 'Filter') {
      put('SBQQ__ProductAction__c', { Id: id('a0P', r), SBQQ__Rule__c: ruleId, SBQQ__FilterField__c: 'Family', SBQQ__Operator__c: 'equals', SBQQ__FilterValue__c: 'Hardware' });
    }
    if (r < nBundles) put('SBQQ__ConfigurationRule__c', { Id: id('a0G', r), SBQQ__Product__c: id('01t', r), SBQQ__ProductRule__c: ruleId, SBQQ__Active__c: true });
  }
  for (let r = 0; r < 40; r++) {
    const ruleId = id('a0Q', r);
    put('SBQQ__PriceRule__c', { Id: ruleId, Name: `Price Rule ${r}`, SBQQ__Active__c: r % 10 !== 0, SBQQ__EvaluationEvent__c: 'On Calculate', SBQQ__EvaluationOrder__c: r, SBQQ__ConditionsMet__c: 'All', SBQQ__LookupObject__c: r % 8 === 0 ? 'Price_Lookup__c' : null, ...audit });
    const nCond = r % 9 === 0 ? 6 : 1;
    for (let c = 0; c < nCond; c++) put('SBQQ__PriceCondition__c', { Id: id('a0K', r * 10 + c), SBQQ__Rule__c: ruleId, SBQQ__Object__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__ProductFamily__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'Hardware' });
    put('SBQQ__PriceAction__c', { Id: id('a0X', r), SBQQ__Rule__c: ruleId, SBQQ__TargetObject__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__SpecialPrice__c', SBQQ__Formula__c: r % 5 === 0 ? 'SBQQ__ListPrice__c * 0.9' : null, SBQQ__Value__c: r % 5 ? '10' : null });
    if (r % 8 === 0) put('SBQQ__LookupQuery__c', { Id: id('a0L', r), SBQQ__PriceRule2__c: ruleId, SBQQ__TestedField__c: 'SBQQ__ProductCode__c', SBQQ__LookupField__c: 'Code__c', SBQQ__Operator__c: 'equals' });
  }

  // ---- pricing
  for (let s = 0; s < 10; s++) {
    const sid = id('a0D', s);
    put('SBQQ__DiscountSchedule__c', { Id: sid, Name: `Volume ${s}`, SBQQ__Type__c: s % 2 ? 'Slab' : 'Range', SBQQ__DiscountUnit__c: 'Percent', SBQQ__Account__c: s === 9 ? id('001', 1) : null, ...audit });
    for (let t = 0; t < 3; t++) put('SBQQ__DiscountTier__c', { Id: id('a0T', s * 10 + t), Name: `Tier ${t + 1}`, SBQQ__Schedule__c: sid, SBQQ__LowerBound__c: t * 10 + 1, SBQQ__UpperBound__c: t < 2 ? (t + 1) * 10 + 1 : null, SBQQ__Discount__c: (t + 1) * 5 });
  }
  for (let i = 0; i < nProducts; i += 97) put('SBQQ__BlockPrice__c', { Id: id('a0B', i), Name: 'Block 1-10', SBQQ__Product__c: id('01t', i), SBQQ__LowerBound__c: 1, SBQQ__UpperBound__c: 11, SBQQ__Price__c: 500 });
  for (let i = 0; i < nProducts; i += 89) put('SBQQ__Cost__c', { Id: id('a0Z', i), SBQQ__Product__c: id('01t', i), SBQQ__UnitCost__c: 40, SBQQ__Active__c: true });
  for (let i = 0; i < 500; i++) put('SBQQ__ContractedPrice__c', { Id: id('a0W', i), SBQQ__Price__c: 10 });

  // ---- customizations
  put('SBQQ__CustomScript__c', { Id: id('a0J', 1), Name: 'MyQCP', SBQQ__Code__c: 'export function onBeforeCalculate(quote, lines, conn) {\n  return Promise.resolve();\n}\n', SBQQ__TranspiledCode__c: 'var x=1;', SBQQ__QuoteLineFields__c: 'SBQQ__ListPrice__c' });
  put('SBQQ__Plugins__c', { Id: id('a0Y', 1), SBQQ__QuoteCalculator__c: 'MyQCP', SetupOwnerId: id('00D', 1) });
  put('SBQQ__CustomAction__c', { Id: id('a0M', 1), Name: 'Add Favorites', SBQQ__Active__c: true, SBQQ__Location__c: 'Quote', SBQQ__Action__c: null, SBQQ__URL__c: '/apex/FavoritesPicker' });
  put('SBQQ__CustomAction__c', { Id: id('a0M', 2), Name: 'Renew Subscriptions', SBQQ__Active__c: true, SBQQ__Location__c: 'Quote', SBQQ__Action__c: 'Renew Subscriptions', SBQQ__URL__c: null });
  put('SBQQ__CustomAction__c', { Id: id('a0M', 3), Name: 'Calculate', SBQQ__Active__c: true, SBQQ__Location__c: 'Quote', SBQQ__Action__c: null, SBQQ__URL__c: '/apex/SBQQ__sb' });
  put('SBQQ__CustomActionCondition__c', { Id: id('a0N', 1), SBQQ__CustomAction__c: id('a0M', 1), SBQQ__Field__c: 'SBQQ__Status__c' });
  put('SBQQ__Theme__c', { Id: id('a0H', 1), Name: 'Default' });
  // Options/features whose bundle product no longer exists (orphans), as seen in real orgs.
  put('SBQQ__ProductFeature__c', { Id: id('a0F', 900_000), Name: 'Orphan feature', SBQQ__ConfiguredSKU__c: id('01t', 9_999_999), SBQQ__Number__c: 10 });
  for (let i = 0; i < 3; i++) put('SBQQ__ProductOption__c', { Id: id('a0O', 900_000 + i), SBQQ__ConfiguredSKU__c: id('01t', 9_999_999), SBQQ__OptionalSKU__c: id('01t', nBundles), SBQQ__Number__c: i + 1 });
  // Transactional objects: only ever COUNT()-ed by the extractor.
  for (let i = 0; i < 42; i++) put('SBQQ__Quote__c', { Id: id('a0q', 100 + i), Name: `Q-${i}` });
  for (let i = 0; i < 9; i++) put('SBQQ__Subscription__c', { Id: id('a0s', i), Name: `SUB-${i}` });
  for (let i = 0; i < 6; i++) put('Contract', { Id: id('800', i), ContractNumber: `${i}` });
  put('SBQQ__Quote__c', { Id: id('a0q', 1), Name: 'Q-0001', Region__c: 'EMEA' });
  // Quote customisation, templates and Advanced Approvals (scope signals, never extracted).
  put('SBQQ__QuoteLine__c', { Id: id('a0l', 1), Name: 'QL-1', Billing_Frequency__c: 'Annual', Margin_Band__c: 'A' });
  put('OpportunityLineItem', { Id: id('00k', 1), Billing_Frequency__c: 'Annual' });
  put('SBQQ__QuoteTemplate__c', { Id: id('a0T', 1), Name: 'Standard Proposal' });
  put('SBQQ__QuoteTemplate__c', { Id: id('a0T', 2), Name: 'Renewal Quote' });
  put('sbaa__ApprovalRule__c', { Id: id('a0A', 1), Name: 'Discount > 20%' });
  put('sbaa__ApprovalChain__c', { Id: id('a0B', 1), Name: 'Finance chain' });
  put('SBQQ__TemplateSection__c', { Id: id('a0U', 1), Name: 'Line items' });
  put('SBQQ__QuoteTerm__c', { Id: id('a0V', 1), Name: 'Payment terms' });
  put('SBQQ__Localization__c', { Id: id('a0W', 1), Name: 'fr: Starter' });
  put('CurrencyType', { Id: id('01L', 1), IsoCode: 'USD', IsCorporate: true, IsActive: true });
  put('CurrencyType', { Id: id('01L', 2), IsoCode: 'EUR', IsCorporate: false, IsActive: true });
  put('ProductSellingModel', { Id: id('0jP', 1), Name: 'Term Monthly' });

  const omit = new Set(opts.omitObjects ?? ['SBQQ__Dimension__c', 'SBQQ__QuoteProcess__c', 'SBQQ__ProcessInput__c', 'SBQQ__SearchFilter__c']);
  const objectNames = [...new Set([...Object.keys(tables), 'SBQQ__ProductRule__c'])].filter((n) => !omit.has(n));

  const fieldsOf = (obj: string): DescribeField[] => {
    const names = new Set<string>(['Id']);
    for (const r of tables[obj] ?? []) Object.keys(r).forEach((k) => names.add(k));
    names.add('IsDeleted');
    return [...names].map((name) => {
      const sample = (tables[obj] ?? []).find((r) => r[name] != null)?.[name];
      const isRef = typeof sample === 'string' && /^[0-9a-zA-Z]{15}$/.test(sample) && name !== 'Id' && name !== 'Name';
      return {
        name,
        type: name === 'Id' ? 'id' : isRef ? 'reference' : typeof sample === 'boolean' ? 'boolean' : typeof sample === 'number' ? 'double' : 'string',
        referenceTo: isRef ? [refTarget(sample as string)] : [],
      };
    });
  };
  const refTarget = (v: string) =>
    ({ '01t': 'Product2', '01s': 'Pricebook2', a0F: 'SBQQ__ProductFeature__c', a0O: 'SBQQ__ProductOption__c', a0R: 'SBQQ__ProductRule__c', a0Q: 'SBQQ__PriceRule__c', a0D: 'SBQQ__DiscountSchedule__c', a0S: 'SBQQ__SummaryVariable__c', a0M: 'SBQQ__CustomAction__c', '001': 'Account' })[v.slice(0, 3)] ?? 'Unknown';

  const cursors = new Map<string, { rows: Rec[]; fields: string[]; offset: number }>();
  let cursorSeq = 0;
  const stats = { queries: 0, queryMores: 0, describes: 0, maxPageRecords: 0 };

  const page = (key: string): QueryPage => {
    const c = cursors.get(key)!;
    const slice = c.rows.slice(c.offset, c.offset + pageSize).map((r) => {
      const out: Record<string, unknown> = { attributes: { type: 'x' } };
      for (const f of c.fields) out[f] = r[f] ?? null;
      return out;
    });
    stats.maxPageRecords = Math.max(stats.maxPageRecords, slice.length);
    c.offset += slice.length;
    const done = c.offset >= c.rows.length;
    if (done) cursors.delete(key);
    return { records: slice, done, nextRecordsUrl: done ? undefined : `/services/data/v62.0/query/${key}-${c.offset}`, totalSize: c.rows.length };
  };

  /** Canned answers for the org scope scan (metadata the fake doesn't model as tables). */
  const SCOPE: Array<[RegExp, Rec[] | number]> = [
    [/FROM FlowDefinitionView/, [
      { Id: 'f1', ApiName: 'Quote_Sync_To_Opportunity', Label: 'Quote sync to opportunity', ProcessType: 'AutoLaunchedFlow', TriggerType: 'RecordAfterSave', TriggerObjectOrEventId: 'SBQQ__Quote__c', NamespacePrefix: null },
      { Id: 'f2', ApiName: 'Order_Activation', Label: 'Order activation', ProcessType: 'AutoLaunchedFlow', TriggerType: 'RecordAfterSave', TriggerObjectOrEventId: 'Order', NamespacePrefix: null },
      { Id: 'f3', ApiName: 'Case_Routing', Label: 'Case routing', ProcessType: 'AutoLaunchedFlow', TriggerType: 'RecordBeforeSave', TriggerObjectOrEventId: 'Case', NamespacePrefix: null },
    ]],
    [/FROM ApexTrigger/, [
      { Id: 't1', Name: 'QuoteLineTrigger', TableEnumOrId: '01I000000000001', NamespacePrefix: null },
      { Id: 't2', Name: 'AccountTrigger', TableEnumOrId: 'Account', NamespacePrefix: null },
    ]],
    [/FROM NamedCredential/, [{ Id: 'n1', DeveloperName: 'ERP_Orders', Endpoint: 'https://erp.example.com' }]],
    [/FROM ConnectedApplication/, [{ Id: 'c1', Name: 'Billing Middleware' }]],
    [/FROM ApexClass/, [
      { Id: 'a1', Name: 'QuoteToErpSync', Body: 'public class QuoteToErpSync { void run(SBQQ__Quote__c q){ HttpRequest r = new HttpRequest(); } }' },
      { Id: 'a2', Name: 'QuoteLineHelper', Body: 'public class QuoteLineHelper { SBQQ__QuoteLine__c l; }' },
      { Id: 'a3', Name: 'Utils', Body: 'public class Utils {}' },
    ]],
    [/FROM Report /, [
      { Id: '00O1', Name: 'Quotes by rep', FolderName: 'Sales' },
      { Id: '00O2', Name: 'Pipeline', FolderName: 'Sales' },
    ]],
    [/COUNT\(\) FROM Dashboard$/, 7],
    [/FROM DashboardComponent/, [{ Id: 'd1', DashboardId: '01Z1', CustomReportId: '00O1' }]],
    [/COUNT\(\) FROM User WHERE/, 48],
    [/GROUP BY LanguageLocaleKey/, [{ Id: 'g1', LanguageLocaleKey: 'en_US', users: 40 }, { Id: 'g2', LanguageLocaleKey: 'fr', users: 8 }]],
    [/FROM Organization/, [{ Id: '00D', LanguageLocaleKey: 'en_US' }]],
    [/FROM PackageLicense/, [{ Id: 'l1', NamespacePrefix: 'SBQQ', AllowedLicenses: 50, UsedLicenses: 42 }]],
    [/FROM PermissionSet WHERE/, [
      { Id: '0PS1', Name: 'SalesforceCPQ_CPQStandardPerm', Label: 'Salesforce CPQ User', NamespacePrefix: 'SBQQ' },
      { Id: '0PS2', Name: 'SalesforceCPQ_CPQAdminPerm', Label: 'Salesforce CPQ Admin', NamespacePrefix: 'SBQQ' },
    ]],
    [/FROM PermissionSetAssignment/, [{ Id: 'g3', PermissionSetId: '0PS1', n: 40 }, { Id: 'g4', PermissionSetId: '0PS2', n: 3 }]],
    [/FROM PermissionSetLicense/, [{ Id: 'p1', MasterLabel: 'Salesforce CPQ License', TotalLicenses: 50, UsedLicenses: 42 }, { Id: 'p2', MasterLabel: 'Sales Cloud', TotalLicenses: 100, UsedLicenses: 60 }]],
    [/SBQQ__EndDate__c >= TODAY/, 7],
    [/SBQQ__EndDate__c = NEXT_N_DAYS:90/, 2],
    [/EndDate >= TODAY/, 5],
    [/EndDate = NEXT_N_DAYS:180/, 2],
    [/SBQQ__Evergreen__c/, 1],
    [/GROUP BY SBQQ__Type__c/, [{ Id: 'g5', SBQQ__Type__c: 'Quote', n: 30 }, { Id: 'g6', SBQQ__Type__c: 'Renewal', n: 8 }, { Id: 'g7', SBQQ__Type__c: 'Amendment', n: 5 }]],
  ];
  const TOOLING: Array<[RegExp, Rec[]]> = [
    [/FROM ValidationRule/, [
      { Id: 'v1', ValidationName: 'Discount_Requires_Reason', EntityDefinitionId: '01I000000000002', ErrorMessage: 'Enter a discount reason', NamespacePrefix: null },
      { Id: 'v2', ValidationName: 'Close_Date_Required', EntityDefinitionId: 'Opportunity', ErrorMessage: 'Close date required', NamespacePrefix: null },
    ]],
    [/FROM InstalledSubscriberPackage/, [
      { Id: 'i1', SubscriberPackage: { NamespacePrefix: 'SBQQ', Name: 'Salesforce CPQ' }, SubscriberPackageVersion: { MajorVersion: 252, MinorVersion: 4, PatchVersion: 0 } },
      { Id: 'i2', SubscriberPackage: { NamespacePrefix: 'sbaa', Name: 'Advanced Approvals' }, SubscriberPackageVersion: { MajorVersion: 232, MinorVersion: 1, PatchVersion: 0 } },
    ]],
  ];
  const ENTITY_IDS: Record<string, string> = { '01I000000000001': 'SBQQ__QuoteLine__c', '01I000000000002': 'SBQQ__Quote__c' };
  const answer = (rows: Rec[] | number) => (typeof rows === 'number' ? { records: [], done: true, totalSize: rows } : { records: rows, done: true, totalSize: rows.length });
  const scopeAnswer = (soql: string) => {
    if (/FROM EntityDefinition/.test(soql)) {
      return answer(Object.entries(ENTITY_IDS).filter(([k]) => soql.includes(k)).map(([DurableId, QualifiedApiName]) => ({ Id: DurableId, DurableId, QualifiedApiName })));
    }
    const hit = SCOPE.find(([re]) => re.test(soql));
    return hit ? answer(hit[1]) : null;
  };

  const conn: SfConnectionLike & { stats: typeof stats } = {
    stats,
    async describeGlobal() {
      return { sobjects: objectNames.map((name) => ({ name, label: name.replace(/^SBQQ__|__c$/g, ''), queryable: true })) };
    },
    async describe(name: string) {
      stats.describes++;
      if (!objectNames.includes(name)) throw new Error(`INVALID_TYPE: ${name}`);
      return { name, label: name, fields: fieldsOf(name) };
    },
    async query(soql: string) {
      stats.queries++;
      const scripted = scopeAnswer(soql);
      if (scripted) return scripted;
      const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (\w+) = true)?$/.exec(soql);
      if (!m) throw new Error(`MALFORMED_QUERY: ${soql}`);
      const [, select, obj, activeField] = m;
      if (!objectNames.includes(obj)) throw new Error(`INVALID_TYPE: ${obj}`);
      let rows = tables[obj] ?? [];
      if (activeField) rows = rows.filter((r) => r[activeField] === true);
      if (select === 'COUNT()') return { records: [], done: true, totalSize: rows.length };
      const fields = select.split(',').map((s) => s.trim());
      const known = new Set(fieldsOf(obj).map((f) => f.name));
      const bad = fields.find((f) => !known.has(f));
      if (bad) throw new Error(`INVALID_FIELD: No such column '${bad}' on entity '${obj}'`);
      const key = `c${++cursorSeq}`;
      cursors.set(key, { rows, fields, offset: 0 });
      return page(key);
    },
    tooling: {
      async query(soql: string) {
        const hit = TOOLING.find(([re]) => re.test(soql));
        if (!hit) throw new Error(`INVALID_TYPE: ${soql}`);
        return answer(hit[1]);
      },
    },
    version: '62.0',
    async request(url: string) {
      const reportId = /reports\/(\w+)\/describe/.exec(url)?.[1];
      return reportId === '00O1'
        ? { reportMetadata: { reportType: { type: 'SBQQ__Quote__c', label: 'Quotes' }, detailColumns: ['SBQQ__Quote__c.SBQQ__NetAmount__c'] } }
        : { reportMetadata: { reportType: { type: 'Opportunity', label: 'Opportunities' }, detailColumns: ['AMOUNT'] } };
    },
    async queryMore(locator: string) {
      stats.queryMores++;
      const key = /query\/(c\d+)-/.exec(locator)?.[1];
      if (!key || !cursors.has(key)) throw new Error('INVALID_QUERY_LOCATOR');
      return page(key);
    },
  };
  return conn;
}
