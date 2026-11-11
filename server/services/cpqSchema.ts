/**
 * Salesforce CPQ (SBQQ) setup-object registry used by the catalog extractor.
 *
 * Scope: configuration metadata and catalog setup data needed to plan a move to
 * Revenue Cloud Advanced (RCA). Transactional records (quotes, quote lines,
 * subscriptions, orders, ...) are deliberately excluded.
 *
 * Relationship fields are listed as *candidates*: the extractor resolves each one
 * against the org's live describe() metadata, so differences between CPQ package
 * versions (or a field that a given org doesn't have) degrade gracefully instead of
 * breaking the SOQL. When no candidate exists, a reference field pointing at the
 * expected target object is used if exactly one unambiguous match is found.
 */

export type Category =
  | 'Catalog & Products'
  | 'Bundle & Configuration'
  | 'Rules & Constraints'
  | 'Pricing Engine & Schedules'
  | 'Custom Options & QCP';

export interface RelationSpec {
  candidates: string[];
  target: string;
}

export interface ObjectSpec {
  name: string;
  /** Property name in the extracted data set. */
  key: string;
  category: Category;
  /** Why this object matters for RCA (shown in the discovery inventory). */
  rcaTarget: string;
  /** Logical parent links used to assemble the hierarchy. */
  relations?: Record<string, RelationSpec>;
  /** 'all' = every non-system field from describe(); 'curated' = `fields` + custom fields. */
  fieldMode: 'all' | 'curated';
  fields?: string[];
  /** Field names never extracted (in addition to system/audit fields). */
  excludeFields?: string[];
  /** Fields that hold an "active" flag; used when includeInactive = false. */
  activeField?: string;
  /** Count only; individual records are not extracted (volume or data-sensitivity). */
  countOnly?: boolean;
  /** Extract custom-setting style objects that are not normal sObjects. */
  optional?: boolean;
}

const P = 'Product2';

export const CPQ_OBJECTS: ObjectSpec[] = [
  // ---------------- Catalog & Products ----------------
  {
    name: 'Product2',
    key: 'products',
    category: 'Catalog & Products',
    rcaTarget: 'Product Catalog Management: Product, Product Classification, Product Selling Model',
    fieldMode: 'all',
    activeField: 'IsActive',
    relations: { discountSchedule: { candidates: ['SBQQ__DiscountSchedule__c'], target: 'SBQQ__DiscountSchedule__c' } },
  },
  {
    name: 'Pricebook2',
    key: 'pricebooks',
    category: 'Catalog & Products',
    rcaTarget: 'Price Books (reused by RCA Salesforce Pricing)',
    fieldMode: 'all',
    activeField: 'IsActive',
  },
  {
    name: 'PricebookEntry',
    key: 'pricebookEntries',
    category: 'Catalog & Products',
    rcaTarget: 'Price Book Entries + Product Selling Model Options',
    fieldMode: 'curated',
    fields: ['Id', 'Name', 'Pricebook2Id', 'Product2Id', 'UnitPrice', 'IsActive', 'UseStandardPrice', 'ProductCode', 'CurrencyIsoCode', 'ProductSellingModelId'],
    activeField: 'IsActive',
    relations: {
      product: { candidates: ['Product2Id'], target: P },
      pricebook: { candidates: ['Pricebook2Id'], target: 'Pricebook2' },
    },
  },

  // ---------------- Bundle & Configuration ----------------
  {
    name: 'SBQQ__ProductFeature__c',
    key: 'features',
    category: 'Bundle & Configuration',
    rcaTarget: 'Product Component Groups',
    fieldMode: 'all',
    relations: { bundle: { candidates: ['SBQQ__ConfiguredSKU__c'], target: P } },
  },
  {
    name: 'SBQQ__ProductOption__c',
    key: 'options',
    category: 'Bundle & Configuration',
    rcaTarget: 'Product Related Components (bundle structure)',
    fieldMode: 'all',
    relations: {
      bundle: { candidates: ['SBQQ__ConfiguredSKU__c'], target: P },
      product: { candidates: ['SBQQ__OptionalSKU__c'], target: P },
      feature: { candidates: ['SBQQ__Feature__c'], target: 'SBQQ__ProductFeature__c' },
      discountSchedule: { candidates: ['SBQQ__DiscountSchedule__c'], target: 'SBQQ__DiscountSchedule__c' },
    },
  },
  {
    name: 'SBQQ__OptionConstraint__c',
    key: 'optionConstraints',
    category: 'Bundle & Configuration',
    rcaTarget: 'Product Configurator constraint rules (Constraint Modeling Language)',
    fieldMode: 'all',
    activeField: 'SBQQ__Active__c',
    relations: {
      bundle: { candidates: ['SBQQ__ConfiguredSKU__c'], target: P },
      constrainingOption: { candidates: ['SBQQ__ConstrainingOption__c', 'SBQQ__ControllingOption__c'], target: 'SBQQ__ProductOption__c' },
      constrainedOption: { candidates: ['SBQQ__ConstrainedOption__c'], target: 'SBQQ__ProductOption__c' },
    },
  },
  {
    name: 'SBQQ__ConfigurationAttribute__c',
    key: 'configurationAttributes',
    category: 'Bundle & Configuration',
    rcaTarget: 'Product Attributes / Attribute Categories (attribute-based configuration & pricing)',
    fieldMode: 'all',
    relations: {
      bundle: { candidates: ['SBQQ__Product__c'], target: P },
      feature: { candidates: ['SBQQ__Feature__c'], target: 'SBQQ__ProductFeature__c' },
    },
  },
  {
    name: 'SBQQ__Dimension__c',
    key: 'priceDimensions',
    category: 'Bundle & Configuration',
    rcaTarget: 'Ramp deals / term-based selling models (MDQ replacement)',
    fieldMode: 'all',
    relations: { product: { candidates: ['SBQQ__Product__c'], target: P } },
  },

  // ---------------- Rules & Constraints ----------------
  {
    name: 'SBQQ__ProductRule__c',
    key: 'productRules',
    category: 'Rules & Constraints',
    rcaTarget: 'Product Configurator rules (CML) / Business Rules Engine',
    fieldMode: 'all',
    activeField: 'SBQQ__Active__c',
  },
  {
    name: 'SBQQ__ErrorCondition__c',
    key: 'errorConditions',
    category: 'Rules & Constraints',
    rcaTarget: 'Constraint rule conditions',
    fieldMode: 'all',
    relations: {
      rule: { candidates: ['SBQQ__Rule__c'], target: 'SBQQ__ProductRule__c' },
      testedVariable: { candidates: ['SBQQ__TestedVariable__c'], target: 'SBQQ__SummaryVariable__c' },
    },
  },
  {
    name: 'SBQQ__ProductAction__c',
    key: 'productActions',
    category: 'Rules & Constraints',
    rcaTarget: 'Constraint rule actions (require / exclude / recommend)',
    fieldMode: 'all',
    relations: {
      rule: { candidates: ['SBQQ__Rule__c'], target: 'SBQQ__ProductRule__c' },
      product: { candidates: ['SBQQ__Product__c'], target: P },
    },
  },
  {
    name: 'SBQQ__ConfigurationRule__c',
    key: 'configurationRules',
    category: 'Rules & Constraints',
    rcaTarget: 'Rule-to-bundle scoping in the RCA configurator',
    fieldMode: 'all',
    activeField: 'SBQQ__Active__c',
    relations: {
      bundle: { candidates: ['SBQQ__Product__c'], target: P },
      rule: { candidates: ['SBQQ__ProductRule__c'], target: 'SBQQ__ProductRule__c' },
      feature: { candidates: ['SBQQ__ProductFeature__c'], target: 'SBQQ__ProductFeature__c' },
    },
  },
  {
    name: 'SBQQ__LookupQuery__c',
    key: 'lookupQueries',
    category: 'Rules & Constraints',
    rcaTarget: 'Decision Tables',
    fieldMode: 'all',
    relations: {
      priceRule: { candidates: ['SBQQ__PriceRule2__c', 'SBQQ__PriceRule__c'], target: 'SBQQ__PriceRule__c' },
      productRule: { candidates: ['SBQQ__ProductRule__c'], target: 'SBQQ__ProductRule__c' },
    },
  },
  {
    name: 'SBQQ__SummaryVariable__c',
    key: 'summaryVariables',
    category: 'Rules & Constraints',
    rcaTarget: 'Pricing Procedure aggregate / rollup elements',
    fieldMode: 'all',
    relations: { combineWith: { candidates: ['SBQQ__CombineWith__c'], target: 'SBQQ__SummaryVariable__c' } },
  },

  // ---------------- Pricing Engine & Schedules ----------------
  {
    name: 'SBQQ__PriceRule__c',
    key: 'priceRules',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Pricing Procedures + Expression Sets + Decision Tables',
    fieldMode: 'all',
    activeField: 'SBQQ__Active__c',
    relations: { product: { candidates: ['SBQQ__Product__c'], target: P } },
  },
  {
    name: 'SBQQ__PriceCondition__c',
    key: 'priceConditions',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Expression Set conditions',
    fieldMode: 'all',
    relations: {
      rule: { candidates: ['SBQQ__Rule__c'], target: 'SBQQ__PriceRule__c' },
      testedVariable: { candidates: ['SBQQ__TestedVariable__c'], target: 'SBQQ__SummaryVariable__c' },
      filterVariable: { candidates: ['SBQQ__FilterVariable__c'], target: 'SBQQ__SummaryVariable__c' },
    },
  },
  {
    name: 'SBQQ__PriceAction__c',
    key: 'priceActions',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Expression Set assignments / Pricing Procedure elements',
    fieldMode: 'all',
    relations: {
      rule: { candidates: ['SBQQ__Rule__c'], target: 'SBQQ__PriceRule__c' },
      sourceVariable: { candidates: ['SBQQ__SourceVariable__c'], target: 'SBQQ__SummaryVariable__c' },
    },
  },
  {
    name: 'SBQQ__DiscountSchedule__c',
    key: 'discountSchedules',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Volume / Tier price adjustment schedules',
    fieldMode: 'all',
    relations: {
      product: { candidates: ['SBQQ__Product__c'], target: P },
      pricebook: { candidates: ['SBQQ__Pricebook__c', 'SBQQ__PriceBook__c'], target: 'Pricebook2' },
      account: { candidates: ['SBQQ__Account__c'], target: 'Account' },
    },
  },
  {
    name: 'SBQQ__DiscountTier__c',
    key: 'discountTiers',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Price adjustment tiers',
    fieldMode: 'all',
    relations: { schedule: { candidates: ['SBQQ__Schedule__c'], target: 'SBQQ__DiscountSchedule__c' } },
  },
  {
    name: 'SBQQ__BlockPrice__c',
    key: 'blockPrices',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Block / tiered price adjustments',
    fieldMode: 'all',
    relations: {
      product: { candidates: ['SBQQ__Product__c'], target: P },
      pricebook: { candidates: ['SBQQ__PriceBook__c', 'SBQQ__Pricebook__c'], target: 'Pricebook2' },
    },
  },
  {
    name: 'SBQQ__Cost__c',
    key: 'costs',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Cost book / cost-plus pricing elements',
    fieldMode: 'all',
    activeField: 'SBQQ__Active__c',
    relations: { product: { candidates: ['SBQQ__Product__c'], target: P } },
  },
  {
    name: 'SBQQ__ContractedPrice__c',
    key: 'contractedPrices',
    category: 'Pricing Engine & Schedules',
    rcaTarget: 'Negotiated / contract pricing (account-specific; counted only)',
    fieldMode: 'all',
    countOnly: true,
  },

  // ---------------- Custom Options & QCP ----------------
  {
    name: 'SBQQ__CustomScript__c',
    key: 'customScripts',
    category: 'Custom Options & QCP',
    rcaTarget: 'Pricing Procedures, Expression Sets or Apex/Function hooks (manual rewrite)',
    fieldMode: 'all',
    excludeFields: ['SBQQ__TranspiledCode__c'],
  },
  {
    name: 'SBQQ__Plugins__c',
    key: 'pluginSettings',
    category: 'Custom Options & QCP',
    rcaTarget: 'Package plugin settings (identifies the active Quote Calculator Plugin)',
    fieldMode: 'all',
    optional: true,
  },
  {
    name: 'SBQQ__CustomAction__c',
    key: 'customActions',
    category: 'Custom Options & QCP',
    rcaTarget: 'Transaction Line Editor / Lightning actions',
    fieldMode: 'all',
    activeField: 'SBQQ__Active__c',
  },
  {
    name: 'SBQQ__CustomActionCondition__c',
    key: 'customActionConditions',
    category: 'Custom Options & QCP',
    rcaTarget: 'Action visibility rules',
    fieldMode: 'all',
    relations: { action: { candidates: ['SBQQ__CustomAction__c'], target: 'SBQQ__CustomAction__c' } },
  },
  {
    name: 'SBQQ__SearchFilter__c',
    key: 'searchFilters',
    category: 'Custom Options & QCP',
    rcaTarget: 'Product discovery / catalog search filters',
    fieldMode: 'all',
    relations: { action: { candidates: ['SBQQ__Action__c'], target: 'SBQQ__CustomAction__c' } },
  },
  {
    name: 'SBQQ__QuoteProcess__c',
    key: 'guidedSellingProcesses',
    category: 'Custom Options & QCP',
    rcaTarget: 'Guided Selling (Product Discovery qualification / OmniStudio)',
    fieldMode: 'all',
  },
  {
    name: 'SBQQ__ProcessInput__c',
    key: 'guidedSellingInputs',
    category: 'Custom Options & QCP',
    rcaTarget: 'Guided Selling inputs',
    fieldMode: 'all',
    relations: { process: { candidates: ['SBQQ__QuoteProcess__c'], target: 'SBQQ__QuoteProcess__c' } },
  },
];

/** Transactional objects: never extracted. Listed in the output so the exclusion is explicit. */
export const EXCLUDED_TRANSACTIONAL = [
  'SBQQ__Quote__c',
  'SBQQ__QuoteLine__c',
  'SBQQ__QuoteLineGroup__c',
  'SBQQ__QuoteDocument__c',
  'SBQQ__Subscription__c',
  'SBQQ__SubscribedAsset__c',
  'SBQQ__SubscribedQuoteLine__c',
  'SBQQ__WebQuote__c',
  'SBQQ__WebQuoteLine__c',
  'SBQQ__RecordJob__c',
  'SBQQ__QuoteLineConsumptionSchedule__c',
  'SBQQ__QuoteLineConsumptionRate__c',
  'SBQQ__QuoteLinePricingGuidance__c',
];

/**
 * Other SBQQ objects matching this are transactional/runtime data and are skipped by
 * discovery. (Registry objects such as SBQQ__QuoteProcess__c are matched before this.)
 */
export const TRANSACTIONAL_PATTERN = /(Quote|Subscri|Order|Contract|Invoice|Asset|Approval|RecordJob|Job__c$|Log__c$|Batch|Usage|Consumption)/i;

/** System / audit fields omitted from every object. */
export const SYSTEM_FIELDS = new Set([
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
  'LastViewedDate',
  'LastReferencedDate',
  'LastActivityDate',
  'IsDeleted',
  'OwnerId',
  'ConnectionReceivedId',
  'ConnectionSentId',
  'IsLocked',
  'MayEdit',
  'UserRecordAccessId',
  'SetupOwnerId',
]);

/** Field types that cannot or should not be selected (binary, compound geo/address). */
export const SKIPPED_FIELD_TYPES = new Set(['base64', 'address', 'location']);
