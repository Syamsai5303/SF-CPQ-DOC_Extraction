/**
 * Plain-English explanations of CPQ product rules and price rules.
 *
 * Deterministic (no AI): built from the rule, its conditions and actions, so every rule
 * gets an exact sentence, e.g.
 *   "Blocks the user from saving Starter PKG-START when Employee Count is greater than
 *    100, showing: "Starter package supports a maximum of 100 employees.""
 *   "During quote calculation (on calculate), when Product Code is 'SUB-PRO', sets the
 *    quote line's Discount (%) to 0.1 if Quote Subscription Term ≥ 12, otherwise 0.05."
 */
import type { CpqCatalog, SfRecord } from './cpqCatalogExtractor.ts';

const s = (v: unknown) => (v == null ? '' : String(v)).trim();
const arr = (v: unknown) => (Array.isArray(v) ? (v as SfRecord[]) : []);

// ------------------------------------------------------------------ labels

/** Friendly names for common CPQ fields (others are derived from the API name). */
const FIELD_LABELS: Record<string, string> = {
  SBQQ__Discount__c: 'Discount (%)',
  SBQQ__AdditionalDiscount__c: 'Additional Discount',
  SBQQ__AdditionalDiscountAmount__c: 'Additional Discount Amount',
  SBQQ__ListPrice__c: 'List Price',
  SBQQ__SpecialPrice__c: 'Special Price',
  SBQQ__CustomerPrice__c: 'Customer Price',
  SBQQ__NetPrice__c: 'Net Price',
  SBQQ__RegularPrice__c: 'Regular Price',
  SBQQ__PartnerPrice__c: 'Partner Price',
  SBQQ__UnitCost__c: 'Unit Cost',
  SBQQ__Quantity__c: 'Quantity',
  SBQQ__ProductCode__c: 'Product Code',
  SBQQ__ProductFamily__c: 'Product Family',
  SBQQ__ProductName__c: 'Product Name',
  SBQQ__SubscriptionTerm__c: 'Subscription Term',
  SBQQ__MarkupRate__c: 'Markup (%)',
  SBQQ__MarkupAmount__c: 'Markup Amount',
  SBQQ__OptionLevel__c: 'Option Level',
  SBQQ__Bundled__c: 'Bundled',
  ProductCode: 'Product Code',
  Family: 'Product Family',
  Name: 'Name',
};

/** "SBQQ__ProductFamily__c" → "Product Family"; "Employee_Count__c" → "Employee Count". */
export function humanField(api: unknown): string {
  const name = s(api);
  if (!name) return '';
  if (FIELD_LABELS[name]) return FIELD_LABELS[name];
  return name
    .replace(/^SBQQ__|^sbaa__/, '')
    .replace(/__(c|r)$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turns field references inside a formula into readable names: SBQQ__Quote__r.SBQQ__SubscriptionTerm__c → Quote Subscription Term. */
export function humanizeFormulaRefs(formula: string): string {
  return formula
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g, (chain) => chain.split('.').map(humanField).join(' '))
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*__c\b/g, (field) => humanField(field));
}

const OPERATOR_TEXT: Record<string, string> = {
  equals: 'is',
  'not equals': 'is not',
  'less than': 'is less than',
  'less or equals': 'is at most',
  'greater than': 'is greater than',
  'greater or equals': 'is at least',
  'starts with': 'starts with',
  'ends with': 'ends with',
  contains: 'contains',
  'does not contain': 'does not contain',
};
const opText = (v: unknown) => OPERATOR_TEXT[s(v).toLowerCase()] ?? (s(v) || 'is');

const quoteValue = (v: unknown) => {
  const t = s(v);
  if (t === '') return 'blank';
  if (/^-?\d+(\.\d+)?$/.test(t) || /^(true|false)$/i.test(t)) return t;
  return `'${t}'`;
};

function variableName(catalog: CpqCatalog, id?: string) {
  return id ? s(catalog.rules.summaryVariables.find((v) => v.Id === id)?.Name) || 'a summary variable' : '';
}

function productLabel(catalog: CpqCatalog, id?: string) {
  if (!id) return '';
  const p = catalog.catalog.products.find((x) => x.Id === id);
  if (!p) return 'a product';
  return p.ProductCode && s(p.ProductCode) !== s(p.Name) ? `${s(p.Name)} (${s(p.ProductCode)})` : s(p.Name);
}

/** Collapses whitespace and avoids a doubled full stop after a quoted message (…package.".). */
const tidy = (t: string) => t.replace(/\s+/g, ' ').replace(/([.!?])"\.$/, '$1"');

const listJoin = (items: string[], word = 'and') => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`);

// ------------------------------------------------------------------ formulas

function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of args) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Readable formula: a single top-level IF(cond, a, b) becomes "a if cond, otherwise b". */
export function explainFormula(formula: unknown): string {
  const f = s(formula).replace(/\s+/g, ' ');
  if (!f) return '';
  const m = /^IF\s*\((.*)\)$/i.exec(f);
  if (m) {
    const parts = splitTopLevel(m[1]);
    if (parts.length === 3) {
      const [cond, a, b] = parts.map((p) => humanizeFormulaRefs(p).replace(/>=/g, '≥').replace(/<=/g, '≤').replace(/!=|<>/g, '≠'));
      return `${a} if ${cond}, otherwise ${/^IF\s*\(/i.test(parts[2]) ? explainFormula(parts[2]) : b}`;
    }
  }
  return `the formula ${humanizeFormulaRefs(f)}`;
}

// ------------------------------------------------------------------ conditions

/** One condition in words, e.g. "Employee Count is greater than 100". */
export function explainCondition(catalog: CpqCatalog, c: SfRecord): string {
  let subject: string;
  if (c.links?.testedVariable) subject = `the summary variable '${variableName(catalog, c.links.testedVariable)}'`;
  else if (s(c.SBQQ__TestedFormula__c)) subject = `the result of ${explainFormula(c.SBQQ__TestedFormula__c)}`;
  else {
    const field = humanField(c.SBQQ__Field__c ?? c.SBQQ__TestedField__c);
    const obj = s(c.SBQQ__Object__c ?? c.SBQQ__TestedObject__c);
    subject = field ? (obj && !/^(quote line|product option)$/i.test(obj) ? `${obj} ${field}` : field) : obj || 'a value';
  }
  let value: string;
  if (c.links?.filterVariable) value = `the summary variable '${variableName(catalog, c.links.filterVariable)}'`;
  else if (s(c.SBQQ__FilterFormula__c)) value = explainFormula(c.SBQQ__FilterFormula__c);
  else value = quoteValue(c.SBQQ__Value__c ?? c.SBQQ__FilterValue__c);
  return `${subject} ${opText(c.SBQQ__Operator__c)} ${value}`;
}

function explainConditions(catalog: CpqCatalog, rule: SfRecord, conditions: SfRecord[]): string {
  if (!conditions.length) return '';
  const texts = conditions.map((c) => explainCondition(catalog, c));
  // Collapse identical conditions (common when rules repeat a test).
  const unique = [...new Set(texts)];
  const met = s(rule.SBQQ__ConditionsMet__c);
  const adv = s(rule.SBQQ__AdvancedCondition__c);
  // Custom logic refers to conditions by number, so keep every condition (no de-duplication).
  if (met === 'Custom' && adv) {
    const numbered = conditions.map((c, i) => `(${s(c.SBQQ__Index__c) || i + 1}) ${texts[i]}`);
    return `the custom logic ${adv} holds over: ${numbered.join('; ')}`;
  }
  if (unique.length === 1) return unique[0];
  return met === 'Any' ? `any of these is true: ${listJoin(unique, 'or')}` : listJoin(unique, 'and');
}

const EVENT_WORDS: Record<string, string> = { load: 'loaded', edit: 'edited', save: 'saved', always: 'changed' };
function productRuleWhen(r: SfRecord): string {
  const events = s(r.SBQQ__EvaluationEvent__c)
    .split(';')
    .map((e) => EVENT_WORDS[e.trim().toLowerCase()] ?? e.trim().toLowerCase())
    .filter(Boolean);
  const where = /quote/i.test(s(r.SBQQ__Scope__c)) ? 'the quote' : 'the configuration';
  return events.length ? `whenever ${where} is ${listJoin(events, 'or')}` : `when ${where} changes`;
}

function bundlesFor(catalog: CpqCatalog, r: SfRecord): string {
  const names = ((r.appliesToBundleIds as string[]) ?? []).map((id) => productLabel(catalog, id)).filter(Boolean);
  if (!names.length) return '';
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} other bundle(s)` : listJoin(names);
}

// ------------------------------------------------------------------ product rules

const ACTION_TEXT: Record<string, (p: string) => string> = {
  add: (p) => `automatically adds ${p} (the user cannot deselect it)`,
  remove: (p) => `automatically removes ${p}`,
  enable: (p) => `makes ${p} selectable`,
  disable: (p) => `prevents ${p} from being selected`,
  'enable & add': (p) => `adds ${p} and lets the user deselect it`,
  'disable & remove': (p) => `removes ${p} and prevents it from being selected again`,
  show: (p) => `shows ${p}`,
  hide: (p) => `hides ${p}`,
  'show & add': (p) => `shows and adds ${p}`,
  'hide & remove': (p) => `hides and removes ${p}`,
  default: (p) => `sets the default for ${p}`,
};

/** Action pairs on the same product that read better as one phrase. */
const ACTION_PAIRS: Array<[string, string, (p: string) => string]> = [
  ['add', 'disable', (p) => `automatically adds ${p} and locks it so the user cannot change it`],
  ['remove', 'enable', (p) => `automatically removes ${p} and makes it selectable again`],
  ['remove', 'disable', (p) => `removes ${p} and prevents it from being selected again`],
  ['add', 'enable', (p) => `adds ${p} and lets the user deselect it`],
];

function explainProductActions(catalog: CpqCatalog, actions: SfRecord[]): string[] {
  const used = new Set<SfRecord>();
  const out: string[] = [];
  for (const a of actions) {
    if (used.has(a)) continue;
    const type = s(a.SBQQ__Type__c).toLowerCase();
    const pid = a.links?.product;
    const pair = pid
      ? ACTION_PAIRS.map(([x, y, fn]) => {
          const other = type === x ? y : type === y ? x : null;
          const match = other && actions.find((b) => b !== a && !used.has(b) && b.links?.product === pid && s(b.SBQQ__Type__c).toLowerCase() === other);
          return match ? { match, fn } : null;
        }).find(Boolean)
      : null;
    used.add(a);
    if (pair) {
      used.add(pair.match);
      out.push(pair.fn(productLabel(catalog, pid)));
    } else out.push(explainProductAction(catalog, a));
  }
  return [...new Set(out)];
}

function explainProductAction(catalog: CpqCatalog, a: SfRecord): string {
  const product = productLabel(catalog, a.links?.product) || (s(a.SBQQ__FilterField__c) ? `options whose ${humanField(a.SBQQ__FilterField__c)} ${opText(a.SBQQ__Operator__c)} ${quoteValue(a.SBQQ__FilterValue__c)}` : 'the target product');
  const fn = ACTION_TEXT[s(a.SBQQ__Type__c).toLowerCase()];
  return fn ? fn(product) : `${s(a.SBQQ__Type__c).toLowerCase() || 'acts on'} ${product}`;
}

/** Plain-English explanation of a product rule. */
export function explainProductRule(catalog: CpqCatalog, r: SfRecord): string {
  const type = s(r.SBQQ__Type__c).toLowerCase();
  const conds = explainConditions(catalog, r, arr(r.errorConditions));
  const when = conds ? ` when ${conds}` : '';
  const bundles = bundlesFor(catalog, r);
  const scope = bundles ? ` for ${bundles}` : '';
  const msg = s(r.SBQQ__ErrorMessage__c);
  const message = msg ? `, showing: "${msg}"` : '';
  const lookup = s(r.SBQQ__LookupObject__c) ? ` Matching options are read from the lookup table ${s(r.SBQQ__LookupObject__c)}.` : '';
  const inactive = r.SBQQ__Active__c === false ? ' (Currently inactive.)' : '';
  const actions = explainProductActions(catalog, arr(r.actions));

  let text: string;
  if (type === 'validation') {
    text = `Blocks the user from saving${scope}${when}${message}.`;
  } else if (type === 'alert') {
    text = `Warns the user (they can still continue)${scope}${when}${message}.`;
  } else if (type === 'selection') {
    text = `${when ? `When ${conds}` : 'Always'}, the configurator${scope} ${actions.length ? listJoin(actions) : 'adjusts the selected options'}.`;
  } else if (type === 'filter') {
    const filters = arr(r.actions).filter((a) => s(a.SBQQ__FilterField__c)).map((a) => `${humanField(a.SBQQ__FilterField__c)} ${opText(a.SBQQ__Operator__c)} ${quoteValue(a.SBQQ__FilterValue__c)}`);
    const products = arr(r.actions).filter((a) => !s(a.SBQQ__FilterField__c) && a.links?.product).map((a) => productLabel(catalog, a.links?.product));
    const limit = filters.length ? ` to those whose ${listJoin(filters)}` : products.length ? ` to ${listJoin(products)}` : '';
    text = `${when ? `When ${conds}` : 'Always'}, limits the products a rep can pick${scope}${limit}.`;
  } else {
    text = `${s(r.SBQQ__Type__c) || 'Rule'}${scope}${when}${actions.length ? `: ${listJoin(actions)}` : ''}${message}.`;
  }
  const runs = ` Runs ${productRuleWhen(r)}.`;
  return `${tidy(text)}${runs}${lookup}${inactive}`;
}

// ------------------------------------------------------------------ price rules

const CALC_EVENTS: Record<string, string> = {
  'on initialization': 'on initialization',
  'before calculate': 'before calculation',
  'on calculate': 'on calculation',
  'after calculate': 'after calculation',
};

function priceRuleWhen(r: SfRecord): string {
  const events = s(r.SBQQ__EvaluationEvent__c)
    .split(';')
    .map((e) => CALC_EVENTS[e.trim().toLowerCase()] ?? e.trim())
    .filter(Boolean);
  const cfg = s(r.SBQQ__ConfiguratorEvaluationEvent__c);
  const parts = [];
  if (events.length) parts.push(`during quote calculation (${listJoin(events, 'and')})`);
  if (cfg) parts.push(`in the configurator (${cfg.replace(/;/g, ', ').toLowerCase()})`);
  const order = r.SBQQ__EvaluationOrder__c != null ? `, evaluation order ${s(r.SBQQ__EvaluationOrder__c)}` : '';
  return `${parts.join(' and ') || 'during quote calculation'}${order}`;
}

function explainPriceAction(catalog: CpqCatalog, rule: SfRecord, a: SfRecord): string {
  const obj = s(a.SBQQ__TargetObject__c) || 'quote line';
  const target = `the ${obj.toLowerCase()}'s ${humanField(a.SBQQ__Field__c) || 'target field'}`;
  let value: string;
  if (s(a.SBQQ__Formula__c)) value = explainFormula(a.SBQQ__Formula__c);
  else if (a.links?.sourceVariable) value = `the summary variable '${variableName(catalog, a.links.sourceVariable)}'`;
  else if (s(a.SBQQ__SourceLookupField__c) || s(rule.SBQQ__LookupObject__c)) {
    const queries = arr(rule.lookupQueries).map((q) => `${humanField(q.SBQQ__LookupField__c)} ${opText(q.SBQQ__Operator__c)} the ${humanField(q.SBQQ__TestedField__c)}`);
    value = `the ${humanField(a.SBQQ__SourceLookupField__c) || 'value'} looked up from ${s(rule.SBQQ__LookupObject__c) || 'the lookup table'}${queries.length ? ` (row where ${listJoin(queries)})` : ''}`;
  } else value = quoteValue(a.SBQQ__Value__c);
  return `sets ${target} to ${value}`;
}

const EVENT_LABEL: Record<string, string> = {
  'on initialization': 'On Initialization',
  'before calculate': 'Before Calculate',
  'on calculate': 'On Calculate',
  'after calculate': 'After Calculate',
};

function pricePurpose(catalog: CpqCatalog, rule: SfRecord, a: SfRecord): string {
  const field = humanField(a.SBQQ__Field__c) || 'a field';
  const obj = (s(a.SBQQ__TargetObject__c) || 'quote line').toLowerCase();
  if (s(a.SBQQ__Formula__c)) return `calculates the ${obj}'s ${field} with a formula`;
  if (a.links?.sourceVariable) return `sets the ${obj}'s ${field} from the summary variable '${variableName(catalog, a.links.sourceVariable)}'`;
  if (s(a.SBQQ__SourceLookupField__c) || s(rule.SBQQ__LookupObject__c)) return `looks up the ${obj}'s ${field} from the ${s(rule.SBQQ__LookupObject__c) || 'lookup'} table`;
  return `sets the ${obj}'s ${field} to a fixed value`;
}

export interface PriceRuleParts {
  /** The pricing behaviour the rule automates. */
  purpose: string;
  /** When it fires: calculator events, configurator events, evaluation order. */
  trigger: string;
  /** Which quote/line values are evaluated. */
  conditions: string;
  /** What is changed, one entry per action. */
  actions: string[];
}

/** Price rule broken into purpose / trigger / conditions / actions, in plain business terms. */
export function explainPriceRuleParts(catalog: CpqCatalog, r: SfRecord): PriceRuleParts {
  const actions = arr(r.actions);
  const purposes = [...new Set(actions.map((a) => pricePurpose(catalog, r, a)))];
  const product = r.links?.product ? ` for ${productLabel(catalog, r.links.product)}` : '';
  const purpose = purposes.length
    ? `Automatically ${listJoin(purposes)}${product}.`
    : 'Has no actions configured, so it does not change any price.';

  const events = s(r.SBQQ__EvaluationEvent__c).split(';').map((e) => EVENT_LABEL[e.trim().toLowerCase()] ?? e.trim()).filter(Boolean);
  const cfg = s(r.SBQQ__ConfiguratorEvaluationEvent__c).split(';').map((e) => e.trim()).filter(Boolean);
  const trigger = [
    events.length ? `Quote calculator: ${events.join(' → ')}` : 'Quote calculator (default events)',
    cfg.length ? `product configurator: ${cfg.join(', ')}` : '',
    r.SBQQ__EvaluationOrder__c != null ? `evaluation order ${s(r.SBQQ__EvaluationOrder__c)}` : '',
  ]
    .filter(Boolean)
    .join('; ');

  const conds = explainConditions(catalog, r, arr(r.conditions));
  const conditions = conds ? `Applies when ${conds}.` : 'No conditions: applies to every quote line in scope.';
  const steps = actions.map((a) => {
    const t = explainPriceAction(catalog, r, a);
    return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
  });
  return {
    purpose: tidy(purpose),
    trigger: `${trigger}.`,
    conditions: tidy(conditions),
    actions: steps.length ? steps.map(tidy) : ['None configured.'],
  };
}

/** Plain-English explanation of a price rule. */
export function explainPriceRule(catalog: CpqCatalog, r: SfRecord): string {
  const conds = explainConditions(catalog, r, arr(r.conditions));
  const actions = arr(r.actions).map((a) => explainPriceAction(catalog, r, a));
  const product = r.links?.product ? ` Applies only to ${productLabel(catalog, r.links.product)}.` : '';
  const inactive = r.SBQQ__Active__c === false ? ' (Currently inactive.)' : '';
  const when = priceRuleWhen(r);
  const body = actions.length ? listJoin(actions) : 'makes no price change (no actions configured)';
  const sentence = `${when.charAt(0).toUpperCase()}${when.slice(1)}${conds ? `, when ${conds}` : ', for every quote line'}, ${body}.`;
  return `${tidy(sentence)}${product}${inactive}`;
}
