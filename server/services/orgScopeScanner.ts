/**
 * Org scope scan: everything a CPQ → RCA migration depends on that is NOT part of the CPQ
 * catalog (automation, quote customisation, documents, approvals, packages, currency,
 * integrations and reporting, users and licences, RCA readiness, in-flight contracts).
 *
 * Every probe is independent and read-only. A probe that fails (missing permission, object
 * not in the org, API not enabled) is recorded as `unavailable` with the reason, so the
 * report can say "could not be checked" instead of silently showing nothing.
 */
import type { QueryPage, SfConnectionLike } from './cpqCatalogExtractor.ts';

type Row = Record<string, unknown>;

export interface Probe<T> {
  status: 'ok' | 'unavailable';
  reason?: string;
  data?: T;
}

export interface OrgScope {
  scannedAt: string;
  automation: {
    flows: Probe<Array<{ name: string; label: string; type: string; trigger: string; object: string }>>;
    otherActiveFlows: Probe<number>;
    apexTriggers: Probe<Array<{ name: string; object: string }>>;
    validationRules: Probe<Array<{ name: string; object: string; message: string }>>;
  };
  quoteFields: Probe<{
    quote: string[];
    quoteLine: string[];
    twins: Array<{ field: string; objects: string[] }>;
  }>;
  documents: Probe<{ templates: string[]; templateSections: number | null; templateContent: number | null; quoteTerms: number | null; generatedDocuments: number | null }>;
  packages: Probe<Array<{ namespace: string; name: string; version: string }>>;
  approvals: Probe<{ installed: boolean; rules: number | null; chains: number | null; approvers: number | null }>;
  billing: { installed: boolean };
  currency: Probe<{ multiCurrency: boolean; currencies: string[]; corporate: string | null; datedRates: boolean }>;
  translations: Probe<{ orgLanguage: string | null; userLanguages: Array<{ language: string; users: number }>; cpqLocalizations: number | null }>;
  integrations: {
    namedCredentials: Probe<string[]>;
    connectedApps: Probe<string[]>;
    apexClasses: Probe<{ scanned: number; referencingCpq: string[]; withCallouts: string[] }>;
    reports: Probe<{ scanned: number; referencingCpq: Array<{ name: string; folder: string; reportType: string }> }>;
    dashboards: Probe<{ total: number; usingCpqReports: number | null }>;
  };
  users: {
    activeUsers: Probe<number>;
    packageLicenses: Probe<Array<{ namespace: string; allowed: number; used: number }>>;
    permissionSets: Probe<Array<{ name: string; label: string; assignees: number }>>;
  };
  rca: {
    objectsPresent: string[];
    objectsMissing: string[];
    licenses: Probe<Array<{ name: string; total: number; used: number }>>;
  };
  subscriptions: Probe<{
    activeSubscriptions: number | null;
    subscriptionsEndingIn90Days: number | null;
    activeContracts: number | null;
    contractsEndingIn180Days: number | null;
    evergreenContracts: number | null;
    quotesByType: Array<{ type: string; count: number }>;
  }>;
}

/** Objects whose automation affects quoting. */
export const QUOTING_OBJECTS = ['Opportunity', 'OpportunityLineItem', 'Order', 'OrderItem', 'Contract', 'Asset', 'Product2', 'PricebookEntry', 'Quote', 'QuoteLineItem'];
const isQuotingObject = (name: string) => name.startsWith('SBQQ__') || QUOTING_OBJECTS.includes(name);

/** RCA objects that exist once Revenue Cloud is provisioned. */
export const RCA_OBJECTS = [
  'ProductCatalog',
  'ProductCategory',
  'ProductSellingModel',
  'ProductComponentGroup',
  'ProductRelatedComponent',
  'AttributeDefinition',
  'PriceAdjustmentSchedule',
  'ExpressionSet',
  'AssetStatePeriod',
  'AssetActionSource',
];

const TWIN_OBJECTS = ['OpportunityLineItem', 'OrderItem', 'SBQQ__Subscription__c', 'Asset'];
const isOrgCustomField = (name: string) => name.endsWith('__c') && !/^(SBQQ|sbaa|blng)__/.test(name);
const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

const reasonOf = (err: unknown) => {
  const e = err as { errorCode?: string; name?: string; message?: string };
  const msg = `${e?.errorCode ?? e?.name ?? ''} ${e?.message ?? String(err)}`.trim();
  return msg.length > 200 ? `${msg.slice(0, 199)}…` : msg;
};

async function probe<T>(fn: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { status: 'ok', data: await fn() };
  } catch (err) {
    return { status: 'unavailable', reason: reasonOf(err) };
  }
}

async function all(q: (soql: string) => PromiseLike<QueryPage>, more: ((l: string) => PromiseLike<QueryPage>) | undefined, soql: string, cap = 5_000): Promise<Row[]> {
  let page = await q(soql);
  const rows: Row[] = [...(page.records as Row[])];
  while (!page.done && page.nextRecordsUrl && more && rows.length < cap) {
    page = await more(page.nextRecordsUrl);
    rows.push(...(page.records as Row[]));
  }
  return rows.slice(0, cap);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export interface ScanOptions {
  /** Most recently run reports to inspect for CPQ fields (one API call each). */
  maxReports?: number;
  /** Apex classes whose source is scanned for CPQ references. */
  maxApexClasses?: number;
}

export async function scanOrgScope(conn: SfConnectionLike, sobjects: Array<{ name: string; queryable?: boolean }>, opts: ScanOptions = {}): Promise<OrgScope> {
  const available = new Set(sobjects.filter((o) => o.queryable !== false).map((o) => o.name));
  const query = (soql: string) => all((s) => conn.query(s), (l) => conn.queryMore(l), soql);
  const count = async (soql: string) => (await conn.query(soql)).totalSize;
  const countIf = async (object: string, where = '') => (available.has(object) ? count(`SELECT COUNT() FROM ${object}${where ? ` WHERE ${where}` : ''}`).catch(() => null) : null);
  const tooling = conn.tooling ? (soql: string) => all((s) => conn.tooling!.query(s), conn.tooling!.queryMore ? (l) => conn.tooling!.queryMore!(l) : undefined, soql) : null;
  const needTooling = () => {
    if (!tooling) throw new Error('Tooling API not available on this connection');
    return tooling;
  };

  // Custom objects are referenced by ID (01I…) in some metadata; resolve them to API names.
  const entityNames = new Map<string, string>();
  const resolveEntities = async (ids: string[]) => {
    const unknown = [...new Set(ids.filter((id) => /^01I/.test(id) && !entityNames.has(id)))];
    for (let i = 0; i < unknown.length; i += 100) {
      const list = unknown.slice(i, i + 100).map((id) => `'${id}'`).join(',');
      try {
        for (const r of await query(`SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${list})`)) entityNames.set(str(r.DurableId), str(r.QualifiedApiName));
      } catch {
        /* keep IDs */
      }
    }
  };
  const entity = (v: unknown) => entityNames.get(str(v)) ?? str(v);

  // ---------------------------------------------------------------- automation
  const flowRows = await probe(() =>
    query("SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventLabel, TriggerObjectOrEventId, NamespacePrefix FROM FlowDefinitionView WHERE IsActive = true"),
  );
  const flowObject = (r: Row) => str(r.TriggerObjectOrEventId) || str(r.TriggerObjectOrEventLabel);
  if (flowRows.data) await resolveEntities(flowRows.data.map(flowObject));
  const ownFlows = flowRows.data?.filter((r) => !r.NamespacePrefix);
  const flows: OrgScope['automation']['flows'] = flowRows.data
    ? {
        status: 'ok',
        data: ownFlows!
          .filter((r) => isQuotingObject(entity(flowObject(r))) || /quote|cpq|sbqq/i.test(`${str(r.ApiName)} ${str(r.Label)}`))
          .map((r) => ({ name: str(r.ApiName), label: str(r.Label), type: str(r.ProcessType), trigger: str(r.TriggerType) || 'Not record-triggered', object: entity(flowObject(r)) || '-' })),
      }
    : { status: 'unavailable', reason: flowRows.reason };
  const otherActiveFlows: Probe<number> = flows.data ? { status: 'ok', data: ownFlows!.length - flows.data.length } : { status: 'unavailable', reason: flows.reason };

  const apexTriggers = await probe(async () => {
    const rows = await query("SELECT Name, TableEnumOrId, NamespacePrefix FROM ApexTrigger WHERE Status = 'Active'");
    await resolveEntities(rows.map((r) => str(r.TableEnumOrId)));
    return rows.filter((r) => !r.NamespacePrefix && isQuotingObject(entity(r.TableEnumOrId))).map((r) => ({ name: str(r.Name), object: entity(r.TableEnumOrId) }));
  });

  const validationRules = await probe(async () => {
    const rows = await needTooling()("SELECT ValidationName, EntityDefinitionId, ErrorMessage, NamespacePrefix FROM ValidationRule WHERE Active = true");
    await resolveEntities(rows.map((r) => str(r.EntityDefinitionId)));
    return rows
      .filter((r) => !r.NamespacePrefix && isQuotingObject(entity(r.EntityDefinitionId)))
      .map((r) => ({ name: str(r.ValidationName), object: entity(r.EntityDefinitionId), message: str(r.ErrorMessage) }));
  });

  // ---------------------------------------------------------------- quote fields & twins
  const customFields = async (name: string) => (available.has(name) ? (await conn.describe(name)).fields.map((f) => f.name).filter(isOrgCustomField) : []);
  const quoteFields = await probe(async () => {
    const quote = await customFields('SBQQ__Quote__c');
    const quoteLine = await customFields('SBQQ__QuoteLine__c');
    const lineSet = new Set(quoteLine);
    const twins = new Map<string, string[]>();
    for (const target of TWIN_OBJECTS) {
      const fields = await customFields(target).catch(() => [] as string[]);
      for (const f of fields) if (lineSet.has(f)) twins.set(f, [...(twins.get(f) ?? []), target]);
    }
    return { quote: quote.sort(), quoteLine: quoteLine.sort(), twins: [...twins].map(([field, objects]) => ({ field, objects })).sort((a, b) => a.field.localeCompare(b.field)) };
  });

  // ---------------------------------------------------------------- documents
  const documents = await probe(async () => {
    const templates = available.has('SBQQ__QuoteTemplate__c') ? (await query('SELECT Name FROM SBQQ__QuoteTemplate__c')).map((r) => str(r.Name)) : [];
    return {
      templates,
      templateSections: await countIf('SBQQ__TemplateSection__c'),
      templateContent: await countIf('SBQQ__TemplateContent__c'),
      quoteTerms: await countIf('SBQQ__QuoteTerm__c'),
      generatedDocuments: await countIf('SBQQ__QuoteDocument__c'),
    };
  });

  // ---------------------------------------------------------------- packages
  const packages = await probe(async () => {
    const rows = await needTooling()(
      'SELECT SubscriberPackage.NamespacePrefix, SubscriberPackage.Name, SubscriberPackageVersion.MajorVersion, SubscriberPackageVersion.MinorVersion, SubscriberPackageVersion.PatchVersion FROM InstalledSubscriberPackage',
    );
    return rows.map((r) => {
      const p = (r.SubscriberPackage ?? {}) as Row;
      const v = (r.SubscriberPackageVersion ?? {}) as Row;
      return { namespace: str(p.NamespacePrefix), name: str(p.Name), version: [v.MajorVersion, v.MinorVersion, v.PatchVersion].filter((x) => x != null).join('.') };
    });
  });
  const hasNs = (ns: string) => [...available].some((n) => n.startsWith(`${ns}__`)) || Boolean(packages.data?.some((p) => p.namespace === ns));

  const approvals = await probe(async () => ({
    installed: hasNs('sbaa'),
    rules: await countIf('sbaa__ApprovalRule__c'),
    chains: await countIf('sbaa__ApprovalChain__c'),
    approvers: await countIf('sbaa__Approver__c'),
  }));

  // ---------------------------------------------------------------- currency & translations
  const currency = await probe(async () => {
    if (!available.has('CurrencyType')) return { multiCurrency: false, currencies: [], corporate: null, datedRates: false };
    const rows = await query('SELECT IsoCode, IsCorporate FROM CurrencyType WHERE IsActive = true');
    return {
      multiCurrency: true,
      currencies: rows.map((r) => str(r.IsoCode)).sort(),
      corporate: str(rows.find((r) => r.IsCorporate === true)?.IsoCode) || null,
      datedRates: ((await countIf('DatedConversionRate')) ?? 0) > 0,
    };
  });

  const translations = await probe(async () => {
    const org = (await query('SELECT LanguageLocaleKey FROM Organization LIMIT 1'))[0];
    const langs = await query("SELECT LanguageLocaleKey, COUNT(Id) users FROM User WHERE IsActive = true GROUP BY LanguageLocaleKey").catch(() => [] as Row[]);
    return {
      orgLanguage: org ? str(org.LanguageLocaleKey) : null,
      userLanguages: langs.map((r) => ({ language: str(r.LanguageLocaleKey), users: num(r.users ?? r.expr0) })).sort((a, b) => b.users - a.users),
      cpqLocalizations: await countIf('SBQQ__Localization__c'),
    };
  });

  // ---------------------------------------------------------------- integrations & reporting
  const namedCredentials = await probe(async () => (await query('SELECT DeveloperName, Endpoint FROM NamedCredential')).map((r) => `${str(r.DeveloperName)}${r.Endpoint ? ` (${str(r.Endpoint)})` : ''}`));
  const connectedApps = await probe(async () => (await query('SELECT Name FROM ConnectedApplication')).map((r) => str(r.Name)));

  const apexClasses = await probe(async () => {
    const rows = await all((s) => conn.query(s), (l) => conn.queryMore(l), 'SELECT Name, Body FROM ApexClass WHERE NamespacePrefix = null', opts.maxApexClasses ?? 3_000);
    const cpq = rows.filter((r) => /SBQQ__|SBQQ\./.test(str(r.Body)));
    return {
      scanned: rows.length,
      referencingCpq: cpq.map((r) => str(r.Name)).sort(),
      withCallouts: cpq.filter((r) => /HttpRequest|WebServiceCallout|callout:/i.test(str(r.Body))).map((r) => str(r.Name)).sort(),
    };
  });

  const reportIdsUsingCpq = new Set<string>();
  const reports = await probe(async () => {
    if (!conn.request) throw new Error('Analytics API not available on this connection');
    const rows = await query(`SELECT Id, Name, FolderName FROM Report WHERE LastRunDate != null ORDER BY LastRunDate DESC LIMIT ${opts.maxReports ?? 150}`);
    const version = conn.version ?? '62.0';
    const hits = await mapLimit(rows, 5, async (r) => {
      try {
        const d = (await conn.request!(`/services/data/v${version}/analytics/reports/${str(r.Id)}/describe`)) as { reportMetadata?: { reportType?: { type?: string; label?: string }; detailColumns?: string[]; groupingsDown?: Array<{ name?: string }> } };
        const m = d.reportMetadata ?? {};
        const text = [m.reportType?.type, ...(m.detailColumns ?? []), ...(m.groupingsDown ?? []).map((g) => g.name)].join(' ');
        if (!/SBQQ__/i.test(text)) return null;
        reportIdsUsingCpq.add(str(r.Id));
        return { name: str(r.Name), folder: str(r.FolderName), reportType: str(m.reportType?.label ?? m.reportType?.type) };
      } catch {
        return null;
      }
    });
    return { scanned: rows.length, referencingCpq: hits.filter((h): h is NonNullable<typeof h> => Boolean(h)) };
  });

  const dashboards = await probe(async () => {
    const total = await count('SELECT COUNT() FROM Dashboard');
    let usingCpqReports: number | null = null;
    if (reportIdsUsingCpq.size) {
      try {
        const rows = await query(`SELECT DashboardId, CustomReportId FROM DashboardComponent WHERE CustomReportId IN (${[...reportIdsUsingCpq].map((id) => `'${id}'`).join(',')})`);
        usingCpqReports = new Set(rows.map((r) => str(r.DashboardId))).size;
      } catch {
        usingCpqReports = null;
      }
    } else if (reports.status === 'ok') usingCpqReports = 0;
    return { total, usingCpqReports };
  });

  // ---------------------------------------------------------------- users & licences
  const activeUsers = await probe(() => count("SELECT COUNT() FROM User WHERE IsActive = true AND UserType = 'Standard'"));
  const packageLicenses = await probe(async () =>
    (await query("SELECT NamespacePrefix, AllowedLicenses, UsedLicenses FROM PackageLicense WHERE NamespacePrefix IN ('SBQQ','sbaa','blng')")).map((r) => ({
      namespace: str(r.NamespacePrefix),
      allowed: num(r.AllowedLicenses),
      used: num(r.UsedLicenses),
    })),
  );
  const permissionSets = await probe(async () => {
    const sets = await query("SELECT Id, Name, Label, NamespacePrefix FROM PermissionSet WHERE IsOwnedByProfile = false AND (NamespacePrefix IN ('SBQQ','sbaa','blng') OR Name LIKE '%CPQ%' OR Label LIKE '%CPQ%')");
    if (!sets.length) return [];
    const ids = sets.map((s) => `'${str(s.Id)}'`).join(',');
    const counts = await query(`SELECT PermissionSetId, COUNT(Id) n FROM PermissionSetAssignment WHERE PermissionSetId IN (${ids}) GROUP BY PermissionSetId`).catch(() => [] as Row[]);
    const by = new Map(counts.map((c) => [str(c.PermissionSetId), num(c.n ?? c.expr0)]));
    return sets.map((s) => ({ name: str(s.Name), label: str(s.Label), assignees: by.get(str(s.Id)) ?? 0 })).sort((a, b) => b.assignees - a.assignees);
  });

  // ---------------------------------------------------------------- RCA readiness
  const licenses = await probe(async () =>
    (await query('SELECT MasterLabel, TotalLicenses, UsedLicenses FROM PermissionSetLicense'))
      .filter((r) => /revenue|pricing|product catalog|configurator|rev lifecycle|billing|salesforce cpq/i.test(str(r.MasterLabel)))
      .map((r) => ({ name: str(r.MasterLabel), total: num(r.TotalLicenses), used: num(r.UsedLicenses) })),
  );

  // ---------------------------------------------------------------- in-flight subscriptions
  const subscriptions = await probe(async () => {
    const quotesByType = available.has('SBQQ__Quote__c')
      ? (await query('SELECT SBQQ__Type__c, COUNT(Id) n FROM SBQQ__Quote__c GROUP BY SBQQ__Type__c').catch(() => [] as Row[])).map((r) => ({ type: str(r.SBQQ__Type__c) || 'Unspecified', count: num(r.n ?? r.expr0) }))
      : [];
    return {
      activeSubscriptions: await countIf('SBQQ__Subscription__c', 'SBQQ__EndDate__c >= TODAY'),
      subscriptionsEndingIn90Days: await countIf('SBQQ__Subscription__c', 'SBQQ__EndDate__c = NEXT_N_DAYS:90'),
      activeContracts: await countIf('Contract', "Status = 'Activated' AND EndDate >= TODAY"),
      contractsEndingIn180Days: await countIf('Contract', "Status = 'Activated' AND EndDate = NEXT_N_DAYS:180"),
      evergreenContracts: await countIf('Contract', 'SBQQ__Evergreen__c = true'),
      quotesByType,
    };
  });

  return {
    scannedAt: new Date().toISOString(),
    automation: { flows, otherActiveFlows, apexTriggers, validationRules },
    quoteFields,
    documents,
    packages,
    approvals,
    billing: { installed: hasNs('blng') },
    currency,
    translations,
    integrations: { namedCredentials, connectedApps, apexClasses, reports, dashboards },
    users: { activeUsers, packageLicenses, permissionSets },
    rca: { objectsPresent: RCA_OBJECTS.filter((o) => available.has(o)), objectsMissing: RCA_OBJECTS.filter((o) => !available.has(o)), licenses },
    subscriptions,
  };
}
