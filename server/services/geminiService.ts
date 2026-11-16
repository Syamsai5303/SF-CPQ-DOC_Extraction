/**
 * Google Gemini integration for the RCA Migration Assessment.
 *
 * - buildAssessmentDigest(): compresses a (possibly very large) CPQ catalog into a
 *   bounded, information-dense JSON digest: full KPIs/flags/inventory, plus the most
 *   complex bundles, rules with their conditions/actions, schedules and QCP excerpts.
 * - generateAssessment(): counts tokens first, then streams the report from Gemini,
 *   reporting progress as text arrives.
 */
import '../config.js'; // loads .env before GEMINI_* are read
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { ThinkingConfig } from '@google/genai';
import type { CpqCatalog, SfRecord } from './cpqCatalogExtractor.ts';
import { isPackagedCustomAction } from './cpqAnalysis.ts';
import { approachSummary, classifyItems, fieldReferences, PLACEHOLDERS } from './reportModel.ts';

/**
 * Model selection. Google retires model versions for new API keys over time (e.g.
 * gemini-2.5-flash now returns 404 "no longer available to new users"), and popular
 * models can be temporarily overloaded (503). So generation tries, in order:
 *   1. GEMINI_MODEL
 *   2. GEMINI_FALLBACK_MODELS (comma-separated)
 *   3. the newest "gemini-<version>-flash" model the key can list
 * The model that actually produced the report is stored on it.
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.5-flash,gemini-3.8-flash,gemini-3.1-flash-lite')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
/** No output within this window = the model is stuck/overloaded; try the next one. */
const FIRST_CHUNK_TIMEOUT_MS = Number(process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS) || 120_000;
/** Max silence between streamed chunks once output has started. */
const IDLE_TIMEOUT_MS = Number(process.env.GEMINI_IDLE_TIMEOUT_MS) || 120_000;
const MAX_INPUT_TOKENS = Number(process.env.GEMINI_MAX_INPUT_TOKENS) || 400_000;
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 32_768;
const DIGEST_CHAR_BUDGET = 600_000;

export const isGeminiConfigured = () => Boolean(process.env.GEMINI_API_KEY?.trim());

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

/** Google API errors arrive as JSON in `message`; pull out code/status/message. */
export function parseGeminiError(err: unknown): { code: number | null; status: string; message: string } {
  const raw = String((err as Error)?.message ?? err);
  try {
    const parsed = JSON.parse(raw.slice(raw.indexOf('{')));
    const e = parsed.error ?? parsed;
    return { code: Number(e.code) || null, status: String(e.status ?? ''), message: String(e.message ?? raw) };
  } catch {
    const code = Number((err as { status?: number })?.status) || Number(/\b(4\d\d|5\d\d)\b/.exec(raw)?.[1]) || null;
    return { code, status: '', message: raw };
  }
}

/** Errors where another model may succeed: retired/unknown model, overload, timeout, per-model quota. */
export function isModelSwitchable(err: unknown): boolean {
  const { code, status, message } = parseGeminiError(err);
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(message + status)) return false;
  return (
    code === 404 ||
    code === 429 ||
    code === 500 ||
    code === 503 ||
    code === 504 ||
    /NOT_FOUND|UNAVAILABLE|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|no longer available|high demand|timed out/i.test(message + status)
  );
}

/** One-line, user-facing explanation that keeps Google's own wording. */
export function describeGeminiError(err: unknown, model?: string): string {
  const { code, message } = parseGeminiError(err);
  const m = model ? ` (${model})` : '';
  if (/API key not valid|API_KEY_INVALID/i.test(message)) return 'Gemini rejected the API key. Check GEMINI_API_KEY.';
  if (/no longer available|not found|NOT_FOUND/i.test(message) && /model/i.test(message)) return `Model${m} is not available to this API key: ${message}`;
  if (code === 503 || /high demand|UNAVAILABLE/i.test(message)) return `Gemini${m} is overloaded right now: ${message}`;
  if (code === 504 || /DEADLINE_EXCEEDED|timed out/i.test(message)) return `Gemini${m} did not respond in time.`;
  if (code === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) return `Gemini quota or rate limit exceeded${m}: ${message}`;
  return message.slice(0, 600);
}

/** Newest plain "gemini-X.Y-flash" models the key can use (no lite/image/preview variants). */
async function discoverFlashModels(ai: GoogleGenAI): Promise<string[]> {
  const found: Array<{ name: string; version: number[] }> = [];
  try {
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    for await (const m of pager) {
      const name = (m.name ?? '').replace(/^models\//, '');
      const match = /^gemini-(\d+(?:\.\d+)*)-flash$/.exec(name);
      if (match && (m.supportedActions ?? ['generateContent']).includes('generateContent')) {
        found.push({ name, version: match[1].split('.').map(Number) });
      }
    }
  } catch {
    return [];
  }
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    return 0;
  };
  return found.sort((a, b) => cmp(a.version, b.version)).map((f) => f.name);
}

/** Gemini 3+ uses thinking levels; 2.x uses a token budget. */
function thinkingConfigFor(model: string): ThinkingConfig {
  if (/^gemini-[3-9]/.test(model)) {
    const level = (process.env.GEMINI_THINKING_LEVEL || 'LOW').toUpperCase() as keyof typeof ThinkingLevel;
    return { thinkingLevel: ThinkingLevel[level] ?? ThinkingLevel.LOW };
  }
  return { thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 4096) };
}

/** Model last seen working in this process; tried first next time. */
let lastGoodModel: string | null = null;

// ------------------------------------------------------------------ digest

const str = (v: unknown) => (v == null ? undefined : String(v));
const compact = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)));

const QCP_METHODS = ['onInit', 'onBeforeCalculate', 'onBeforePriceRules', 'onAfterPriceRules', 'onAfterCalculate', 'isFieldVisible', 'isFieldEditable', 'isFieldVisibleForLine', 'isFieldEditableForObject'];

export interface DigestLimits {
  bundles: number;
  optionsPerFeature: number;
  rules: number;
  conditionsPerRule: number;
  schedules: number;
  scriptChars: number;
}

const DEFAULT_LIMITS: DigestLimits = { bundles: 40, optionsPerFeature: 12, rules: 250, conditionsPerRule: 8, schedules: 60, scriptChars: 6_000 };

/** Counts-only view of the org scope scan for the prompt (lists stay in Appendix E). */
function scopeDigest(catalog: CpqCatalog) {
  const o = catalog.discovery.orgScope;
  if (!o) return null;
  const v = <T, R>(p: { status: string; data?: T }, f: (d: T) => R) => (p.status === 'ok' && p.data !== undefined ? f(p.data) : 'not checked');
  return {
    flowsOnQuotingObjects: v(o.automation.flows, (d) => d.map((f) => `${f.label} (${f.object})`).slice(0, 10)),
    apexTriggers: v(o.automation.apexTriggers, (d) => d.map((t) => `${t.name} (${t.object})`).slice(0, 10)),
    validationRules: v(o.automation.validationRules, (d) => d.length),
    quoteCustomFields: v(o.quoteFields, (d) => ({ quote: d.quote.length, quoteLine: d.quoteLine.length, twinFields: d.twins.map((t) => t.field).slice(0, 10) })),
    quoteTemplates: v(o.documents, (d) => d.templates.length),
    packages: v(o.packages, (d) => d.map((p) => `${p.name} ${p.version}`)),
    advancedApprovals: v(o.approvals, (d) => (d.installed ? { rules: d.rules, chains: d.chains } : 'not installed')),
    billingInstalled: o.billing.installed,
    currency: v(o.currency, (d) => (d.multiCurrency ? d.currencies : 'single')),
    apexClassesReferencingCpq: v(o.integrations.apexClasses, (d) => ({ count: d.referencingCpq.length, withCallouts: d.withCallouts.length })),
    reportsOnCpq: v(o.integrations.reports, (d) => d.referencingCpq.length),
    namedCredentials: v(o.integrations.namedCredentials, (d) => d.length),
    activeUsers: v(o.users.activeUsers, (d) => d),
    cpqPermissionSetAssignments: v(o.users.permissionSets, (d) => d.reduce((t, p) => t + p.assignees, 0)),
    rcaObjectsPresent: o.rca.objectsPresent,
    inFlight: v(o.subscriptions, (d) => d),
  };
}

export function buildAssessmentDigest(catalog: CpqCatalog, limits: DigestLimits = DEFAULT_LIMITS) {
  const productsById = new Map(catalog.catalog.products.map((p) => [p.Id, p]));
  const pname = (id?: string) => (id ? str(productsById.get(id)?.Name) ?? id : undefined);
  type B = { features: SfRecord[]; options: SfRecord[]; optionConstraints: SfRecord[]; configurationAttributes: SfRecord[]; configurationRules: SfRecord[]; levels?: number; circularReference?: boolean };

  const bundles = catalog.catalog.products
    .filter((p) => p.bundle)
    .sort((a, b) => {
      const ba = a.bundle as B;
      const bb = b.bundle as B;
      return (bb.levels ?? 0) - (ba.levels ?? 0) || bb.options.length - ba.options.length;
    });

  const sampleBundles = bundles.slice(0, limits.bundles).map((p) => {
    const b = p.bundle as B;
    const optionsById = new Map(b.options.map((o) => [o.Id, o]));
    return compact({
      name: p.Name,
      productCode: p.ProductCode,
      active: p.IsActive,
      configurationType: p.SBQQ__ConfigurationType__c,
      configurationEvent: p.SBQQ__ConfigurationEvent__c,
      tiers: b.levels,
      circularReference: b.circularReference,
      features: b.features.map((f) =>
        compact({
          name: f.Name,
          selectionMethod: f.SBQQ__OptionSelectionMethod__c,
          min: f.SBQQ__MinOptionCount__c,
          max: f.SBQQ__MaxOptionCount__c,
          optionCount: (f.optionIds as string[]).length,
          options: (f.optionIds as string[]).slice(0, limits.optionsPerFeature).map((id) => {
            const o = optionsById.get(id)!;
            const child = productsById.get(o?.links?.product ?? '');
            return compact({ product: str(child?.Name), childIsBundle: Boolean(child?.bundle) || undefined, type: o?.SBQQ__Type__c, required: o?.SBQQ__Required__c || undefined, qty: o?.SBQQ__Quantity__c });
          }),
        }),
      ),
      ungroupedOptions: b.options.filter((o) => !o.links?.feature).length || undefined,
      constraints: b.optionConstraints.length || undefined,
      configurationAttributes: b.configurationAttributes.map((a) => str(a.Name)),
      configurationRules: b.configurationRules.length || undefined,
    });
  });

  const cond = (c: SfRecord) =>
    compact({
      object: c.SBQQ__Object__c ?? c.SBQQ__TestedObject__c,
      field: c.SBQQ__Field__c ?? c.SBQQ__TestedField__c,
      operator: c.SBQQ__Operator__c,
      filterType: c.SBQQ__FilterType__c,
      value: c.SBQQ__Value__c ?? c.SBQQ__FilterValue__c,
      formula: c.SBQQ__TestedFormula__c,
      variable: c.links?.testedVariable ? 'summary variable' : undefined,
    });

  const priceRules = catalog.rules.priceRules.slice(0, limits.rules).map((r) =>
    compact({
      name: r.Name,
      active: r.SBQQ__Active__c,
      event: r.SBQQ__EvaluationEvent__c,
      configuratorEvent: r.SBQQ__ConfiguratorEvaluationEvent__c,
      order: r.SBQQ__EvaluationOrder__c,
      conditionsMet: r.SBQQ__ConditionsMet__c,
      advancedCondition: r.SBQQ__AdvancedCondition__c,
      targetObject: r.SBQQ__TargetObject__c,
      lookupObject: r.SBQQ__LookupObject__c,
      product: pname(r.links?.product),
      conditionCount: (r.conditions as SfRecord[]).length,
      conditions: (r.conditions as SfRecord[]).slice(0, limits.conditionsPerRule).map(cond),
      actions: (r.actions as SfRecord[]).slice(0, limits.conditionsPerRule).map((a) =>
        compact({ target: a.SBQQ__TargetObject__c, field: a.SBQQ__Field__c, value: a.SBQQ__Value__c, formula: a.SBQQ__Formula__c, sourceLookupField: a.SBQQ__SourceLookupField__c, fromVariable: a.links?.sourceVariable ? true : undefined }),
      ),
      lookupQueries: (r.lookupQueries as SfRecord[]).length || undefined,
    }),
  );

  const productRules = catalog.rules.productRules.slice(0, limits.rules).map((r) =>
    compact({
      name: r.Name,
      type: r.SBQQ__Type__c,
      active: r.SBQQ__Active__c,
      scope: r.SBQQ__Scope__c,
      event: r.SBQQ__EvaluationEvent__c,
      conditionsMet: r.SBQQ__ConditionsMet__c,
      advancedCondition: r.SBQQ__AdvancedCondition__c,
      lookupObject: r.SBQQ__LookupObject__c,
      message: typeof r.SBQQ__ErrorMessage__c === 'string' ? r.SBQQ__ErrorMessage__c.slice(0, 160) : undefined,
      conditions: (r.errorConditions as SfRecord[]).slice(0, limits.conditionsPerRule).map(cond),
      actions: (r.actions as SfRecord[]).slice(0, limits.conditionsPerRule).map((a) => compact({ type: a.SBQQ__Type__c, product: pname(a.links?.product), required: a.SBQQ__Required__c })),
      bundles: (r.appliesToBundleIds as string[] | undefined)?.length || undefined,
    }),
  );

  const scripts = catalog.customizations.customScripts.map((s) => {
    const code = str(s.SBQQ__Code__c) ?? '';
    return compact({
      name: s.Name,
      lines: code ? code.split('\n').length : 0,
      implementsMethods: QCP_METHODS.filter((m) => new RegExp(`\\b${m}\\b`).test(code)),
      quoteFields: s.SBQQ__QuoteFields__c,
      quoteLineFields: s.SBQQ__QuoteLineFields__c,
      usesConnection: /\bconn\./.test(code) || undefined,
      codeExcerpt: code.slice(0, limits.scriptChars) + (code.length > limits.scriptChars ? '\n/* …truncated… */' : ''),
    });
  });

  const digest = {
    source: catalog.source,
    extractionOptions: catalog.options,
    objectInventory: catalog.discovery.objects.map((o) =>
      compact({ object: o.name, category: o.category, present: o.present, records: o.recordCount, rcaTarget: o.rcaTarget, truncated: o.truncated || undefined, error: o.error }),
    ),
    otherCpqObjects: catalog.discovery.otherCpqObjects,
    kpis: catalog.summary.kpis,
    distributions: catalog.summary.distributions,
    complexity: catalog.summary.complexity,
    mostComplexBundles: { shown: sampleBundles.length, total: bundles.length, bundles: sampleBundles },
    priceRules: { shown: priceRules.length, total: catalog.rules.priceRules.length, rules: priceRules },
    productRules: { shown: productRules.length, total: catalog.rules.productRules.length, rules: productRules },
    summaryVariables: catalog.rules.summaryVariables.slice(0, 100).map((v) =>
      compact({ name: v.Name, function: v.SBQQ__AggregateFunction__c, field: v.SBQQ__AggregateField__c, target: v.SBQQ__TargetObject__c, filterField: v.SBQQ__FilterField__c }),
    ),
    discountSchedules: catalog.pricing.discountSchedules.slice(0, limits.schedules).map((s) =>
      compact({ name: s.Name, type: s.SBQQ__Type__c, unit: s.SBQQ__DiscountUnit__c, accountSpecific: Boolean(s.links?.account) || undefined, tiers: (s.tiers as SfRecord[]).map((t) => [t.SBQQ__LowerBound__c, t.SBQQ__UpperBound__c ?? null, t.SBQQ__Discount__c ?? t.SBQQ__DiscountAmount__c ?? t.SBQQ__Price__c]) }),
    ),
    contractedPriceRecords: catalog.pricing.contractedPriceCount,
    customScripts: scripts,
    pluginSettings: catalog.customizations.pluginSettings.map((p) => compact(Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith('SBQQ__'))))),
    customActions: catalog.customizations.customActions.filter((a) => !isPackagedCustomAction(a)).map((a) => compact({ name: a.Name, location: a.SBQQ__Location__c, type: a.SBQQ__Type__c, active: a.SBQQ__Active__c })),
    guidedSellingProcesses: catalog.customizations.guidedSelling.length,
    orphanedRecords: catalog.catalog.orphans,
    cutoverVolumes: (catalog.discovery.cutoverVolumes ?? []).map((v) => ({ object: v.label, records: v.recordCount })),
    orgScope: scopeDigest(catalog),
    // Same classification the report tables use, so narrative and tables agree.
    migrationApproach: (() => {
      const items = classifyItems(catalog);
      const summary = approachSummary(items);
      return {
        byArea: summary.rows,
        total: { ...summary.total, personDays: summary.personDays },
        nonDirectItems: items
          .filter((i) => i.approach !== 'Direct')
          .slice(0, 80)
          .map((i) => ({ item: i.name, type: i.type, approach: i.approach, reason: i.reason })),
      };
    })(),
    customFieldsUsedByLogic: fieldReferences({ catalog, items: [] })
      .slice(0, 40)
      .map((r) => ({ field: r.field, usedBy: r.usedBy.length })),
  };

  // Shrink progressively if a huge catalog still exceeds the character budget.
  const size = JSON.stringify(digest).length;
  if (size > DIGEST_CHAR_BUDGET && limits.rules > 20) {
    return buildAssessmentDigest(catalog, {
      bundles: Math.max(10, Math.floor(limits.bundles / 2)),
      optionsPerFeature: Math.max(4, Math.floor(limits.optionsPerFeature / 2)),
      rules: Math.floor(limits.rules / 2),
      conditionsPerRule: Math.max(3, limits.conditionsPerRule - 2),
      schedules: Math.floor(limits.schedules / 2),
      scriptChars: Math.floor(limits.scriptChars / 2),
    });
  }
  return digest;
}

// ------------------------------------------------------------------ prompt

export const SYSTEM_INSTRUCTION = `You are a principal Salesforce architect writing a CPQ Assessment & RCA Migration Report: current-state Salesforce CPQ (SBQQ) first, then the move to Revenue Cloud Advanced (Product Catalog Management, Pricing Procedures, Expression Sets, Decision Tables, Advanced Configurator with CML, Product Discovery, Transaction Line Editor).
Rules:
- Use only facts from the JSON digest; quote record names exactly. If something is unknown, say so under open questions.
- The system inserts fact tables at each {{PLACEHOLDER}}: put each placeholder on its own line exactly where the skeleton shows it and do not repeat its numbers in tables of your own.
- Use the digest's migrationApproach labels (Direct/Adapt/Redesign/Retire) consistently.
- GitHub-flavoured Markdown only (headings, short paragraphs, bullets, pipe tables). No HTML, no LaTeX or $…$ math (write ≤, ≥, ×), no code fences around the document, table cells under 25 words.
- Write for business stakeholders: plain business terms first, field API names only where essential.
- Be specific and concise: an expert reader, no filler.`;

/** Report skeleton. Headings are fixed; <…> are writing instructions for the model. */
export function buildAssessmentPrompt(digest: ReturnType<typeof buildAssessmentDigest>, orgLabel: string) {
  const { level, score } = digest.complexity;
  return `Write the report for "${orgLabel}". Output exactly this skeleton, keeping headings verbatim and replacing each <…> with content:

# Part 1. Executive Summary & Current CPQ Architecture
## 1.1 Executive summary
<2 short paragraphs: readiness (complexity ${level}, ${score}/100), its main drivers, and the headline recommendation.>
{{FOOTPRINT}}
## 1.2 Key findings
{{KEY_FINDINGS}}
## 1.3 Catalog structure
<How the current catalog is organised: product families, standalone SKUs vs bundles, multi-level nesting, features/options patterns, attributes, pricing methods. 1-2 paragraphs and up to 5 bullets.>
{{BUNDLE_TABLE}}
{{BUNDLE_STRUCTURE}}

# Part 2. Price Rules & Product Rules Breakdown
## 2.1 Product rules
<Overview of the configuration business logic by rule type (Validation, Selection, Alert, Filter; skip absent types): what each group enforces and how the rules interact. The table below explains every rule individually, so do not restate rules one by one.>
{{PRODUCT_RULE_TABLE}}
## 2.2 Price rules
<1 short paragraph on the pricing flow in evaluation-event order (On Initialization → Before Calculate → On Calculate → After Calculate) and how the rules combine. Then one bullet per price rule: "- **<exact rule name>**: <the pricing behaviour it automates, in business terms (who benefits and why), max 25 words>". The system moves each bullet into that rule's block, which already lists trigger, conditions and actions, so give no raw metadata.>
{{PRICE_RULE_TABLE}}
## 2.3 Supporting logic & dependencies
<Summary variables, discount schedules, option constraints, rule chains and shared custom fields, QCP methods, custom actions. Call out items that must migrate together.>
{{SUPPORTING_LOGIC}}

# Part 3. CPQ-to-RCA Mapping Matrix & Migration Strategy
## 3.1 Mapping matrix
<Table: CPQ Construct | Volume | RCA Equivalent | Approach | Risk. One row per construct present in this org, then one sentence listing constructs not used.>
## 3.2 Migration approach & effort
{{APPROACH_SUMMARY}}
<2-4 sentences interpreting where the effort sits.>
## 3.3 Gap analysis
<Table: Gap | CPQ pattern (named examples) | RCA workaround | Risk, highest risk first. Then a short "Retire / simplify" bullet list.>
## 3.4 Phased migration roadmap
<Table: Phase | Scope | Key activities | Exit criteria for: Design; Catalog foundation; Configuration rules; Pricing; Custom logic & UI; Data migration & cut-over; Testing & hypercare. Then 3 bullets on test strategy: quote parity, rule regression, performance.>
{{CUTOVER_VOLUMES}}
## 3.5 Risks, assumptions & open questions
<Risk table (Risk | Impact | Mitigation), at most 9 rows. It must include: change management & user training (use digest.orgScope.activeUsers); RCA licensing & org prerequisites; running CPQ and RCA side by side during cut-over; renewals/amendments of in-flight subscriptions; hidden automation (flows/triggers/validation rules) and integrations/reports on SBQQ fields when digest.orgScope shows any. Then short bullet lists of assumptions and questions for the customer.>
## 3.6 Dependencies outside the CPQ catalog
{{BLIND_SPOTS}}

Digest (JSON):
${JSON.stringify(digest)}`;
}

/** Placeholder keys the prompt asks for (used by tests to keep prompt and renderer in sync). */
export const PROMPT_PLACEHOLDERS = PLACEHOLDERS.map((p) => p.key);

// ------------------------------------------------------------------ generation

export interface GenerationProgress {
  stage: 'counting' | 'generating' | 'done';
  outputChars: number;
  promptTokens?: number;
}

export interface GenerationResult {
  markdown: string;
  promptTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  model: string;
}

/** Removes a ```markdown fence if the model wrapped the whole document in one. */
export function cleanMarkdown(text: string): string {
  const t = text.trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(t);
  return (m ? m[1] : t).trim() + '\n';
}

export interface GenerationAttempt {
  model: string;
  error: string;
}

export async function generateAssessment(
  catalog: CpqCatalog,
  orgLabel: string,
  { onProgress, signal }: { onProgress?: (p: GenerationProgress & { model?: string }) => void | Promise<void>; signal?: AbortSignal } = {},
): Promise<GenerationResult & { attempts: GenerationAttempt[] }> {
  const ai = getClient();
  const digest = buildAssessmentDigest(catalog);
  const prompt = buildAssessmentPrompt(digest, orgLabel);
  const contents = [{ role: 'user', parts: [{ text: prompt }] }];

  await onProgress?.({ stage: 'counting', outputChars: 0 });

  const tried = new Set<string>();
  const attempts: GenerationAttempt[] = [];
  let discovered: string[] | null = null;
  const nextModel = async (): Promise<string | null> => {
    const ordered = [lastGoodModel, GEMINI_MODEL, ...FALLBACK_MODELS].filter(Boolean) as string[];
    const fresh = ordered.find((m) => !tried.has(m));
    if (fresh) return fresh;
    discovered ??= await discoverFlashModels(ai);
    return discovered.find((m) => !tried.has(m)) ?? null;
  };

  for (let model = await nextModel(); model; model = await nextModel()) {
    tried.add(model);
    if (signal?.aborted) throw new Error('Generation cancelled');
    try {
      const result = await generateWithModel(ai, model, contents, { onProgress, signal });
      if (model !== GEMINI_MODEL) console.warn(`[gemini] GEMINI_MODEL "${GEMINI_MODEL}" unavailable; report generated with "${model}"`);
      lastGoodModel = model;
      return { ...result, attempts };
    } catch (err) {
      if (signal?.aborted) throw new Error('Generation cancelled');
      const reason = describeGeminiError(err, model);
      attempts.push({ model, error: reason });
      console.warn(`[gemini] ${model} failed: ${reason}`);
      if (lastGoodModel === model) lastGoodModel = null;
      // Content-level / auth failures won't be fixed by another model; stop here.
      if (!isModelSwitchable(err) && !(err instanceof StreamTimeoutError && !err.afterOutput)) throw new Error(reason);
      if (err instanceof StreamTimeoutError && err.afterOutput) throw new Error(reason);
      if (attempts.length >= 6) break;
    }
  }
  throw new Error(
    attempts.length
      ? `No Gemini model could generate the report. Tried: ${attempts.map((a) => `${a.model} (${a.error})`).join('; ')}`
      : 'No Gemini model is available for this API key.',
  );
}

class StreamTimeoutError extends Error {
  afterOutput: boolean;
  constructor(message: string, afterOutput: boolean) {
    super(message);
    this.afterOutput = afterOutput;
  }
}

async function generateWithModel(
  ai: GoogleGenAI,
  model: string,
  contents: Array<{ role: string; parts: Array<{ text: string }> }>,
  { onProgress, signal }: { onProgress?: (p: GenerationProgress & { model?: string }) => void | Promise<void>; signal?: AbortSignal },
): Promise<GenerationResult> {
  // Token count is advisory, except that a 404 here tells us early the model is gone.
  let promptTokens: number | null = null;
  try {
    const counted = await ai.models.countTokens({ model, contents });
    promptTokens = counted.totalTokens ?? null;
  } catch (err) {
    if (parseGeminiError(err).code === 404) throw err;
  }
  if (promptTokens && promptTokens > MAX_INPUT_TOKENS) {
    throw new Error(`Catalog digest is too large for one request (${promptTokens.toLocaleString()} tokens > ${MAX_INPUT_TOKENS.toLocaleString()}).`);
  }

  // Our own abort controller drives the first-chunk / idle timeouts and forwards cancellation.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut: StreamTimeoutError | null = null;
  const arm = (ms: number, afterOutput: boolean) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = new StreamTimeoutError(afterOutput ? `${model} stopped streaming for ${ms / 1000}s` : `${model} produced no output within ${ms / 1000}s`, afterOutput);
      controller.abort();
    }, ms);
  };

  let text = '';
  let outputTokens: number | null = null;
  let finishReason: string | null = null;
  let lastReport = 0;
  try {
    arm(FIRST_CHUNK_TIMEOUT_MS, false);
    await onProgress?.({ stage: 'generating', outputChars: 0, promptTokens: promptTokens ?? undefined, model });
    const stream = await ai.models.generateContentStream({
      model,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.3,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: thinkingConfigFor(model),
        abortSignal: controller.signal,
      },
    });
    for await (const chunk of stream) {
      text += chunk.text ?? '';
      arm(IDLE_TIMEOUT_MS, text.length > 0);
      if (chunk.usageMetadata) {
        promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
      }
      finishReason = (chunk.candidates?.[0]?.finishReason as string | undefined) ?? finishReason;
      if (text.length - lastReport > 1_500) {
        lastReport = text.length;
        await onProgress?.({ stage: 'generating', outputChars: text.length, promptTokens: promptTokens ?? undefined, model });
      }
    }
  } catch (err) {
    if (timedOut) throw timedOut;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!text.trim()) throw new Error(`Gemini returned no content (finish reason: ${finishReason ?? 'unknown'})`);
  let markdown = cleanMarkdown(text);
  if (finishReason === 'MAX_TOKENS') {
    markdown += '\n> **Note:** the AI output reached its length limit; the final section may be incomplete. Regenerate or raise GEMINI_MAX_OUTPUT_TOKENS.\n';
  }
  await onProgress?.({ stage: 'done', outputChars: markdown.length, promptTokens: promptTokens ?? undefined, model });
  return { markdown, promptTokens, outputTokens, finishReason, model };
}
