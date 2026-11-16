import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'x'.repeat(32);
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';

const { extractCpqCatalog } = await import('./cpqCatalogExtractor.ts');
const { createFakeCpqOrg } = await import('./testing/fakeCpqOrg.ts');
const rm = await import('./reportModel.ts');
const { buildAssessmentDigest, buildAssessmentPrompt, PROMPT_PLACEHOLDERS } = await import('./geminiService.ts');
const { markdownToBlocks } = await import('./docGenerator.ts');

const catalog = await extractCpqCatalog(createFakeCpqOrg({ products: 600, bundles: 60 }), {
  connectionName: 'Acme UAT',
  environmentType: 'UAT',
  orgId: '00D',
  instanceUrl: null,
  apiVersion: '62.0',
});
const ctx = rm.buildContext(catalog);

test('orphaned options/features are counted, not silently dropped', () => {
  assert.equal(catalog.catalog.orphans.options, 3);
  assert.equal(catalog.catalog.orphans.features, 1);
  assert.equal(catalog.summary.kpis.orphanOptions, 3);
  assert.ok(catalog.summary.complexity.flags.some((f) => f.id === 'orphaned-configuration'));
  assert.match(rm.footprintTable(ctx), /\(1 \/ 3 orphaned\)/);
});

test('summary table names record totals explicitly and never leaves a count blank', () => {
  const t = rm.footprintTable(ctx);
  assert.ok(!t.includes('Configuration items assessed'));
  const total = catalog.discovery.objects.filter((o) => o.present).reduce((x, o) => x + o.recordCount, 0);
  assert.match(t, new RegExp(`\\| Total CPQ configuration records \\(all extracted objects, Appendix B\\) \\| ${total.toLocaleString('en-US')} \\|`));
  assert.match(t, /\| Items assessed for migration \| \d[\d,]* \(\d+ bundles · \d+ product rules & summary variables · \d+ price rules/);
  for (const line of t.split('\n').slice(2)) assert.doesNotMatch(line, /\|\s*\|/, `empty cell in: ${line}`);
});

test('price rules are one table: purpose, trigger, conditions, actions, approach', () => {
  const md = rm.priceRuleDetails(ctx);
  assert.match(md, /\| Price rule \| Purpose \| Trigger \/ evaluation event \| Conditions \| Actions \| Approach \|/);
  assert.match(md, /Quote calculator: On Calculate/);
  assert.match(md, /Automatically calculates the quote line's Special Price with a formula/);
  assert.ok(!/SBQQ__\w+__c/.test(md.replace(/Appendix D\./, '')), 'no API names in the business view');
  const t = markdownToBlocks(md).find((b) => b.kind === 'table');
  assert.ok(t && t.kind === 'table' && t.rows.length === catalog.rules.priceRules.length && t.rows.every((r) => r.length === 6));
});

test("the model's purpose bullets become the Purpose cell of each price rule", () => {
  const ai = ['# Part 2. Rules', '## 2.2 Price rules', 'Flow overview.', '- **Price Rule 1**: Gives hardware a fixed promotional price.', '- **Not a rule**: stays', '{{PRICE_RULE_TABLE}}', '## 2.3 Supporting logic', '# Part 3. C'].join('\n');
  const out = rm.expandReport(ai, ctx);
  assert.match(out, /\| \*\*Price Rule 1\*\* \| Gives hardware a fixed promotional price\. \|/);
  assert.ok(!out.includes('- **Price Rule 1**:'), 'bullet removed from the narrative');
  assert.ok(out.includes('- **Not a rule**: stays'));
});

test('CPQ-packaged custom actions are not migration items', () => {
  assert.equal(catalog.summary.kpis.customActions, 1);
  assert.equal(catalog.summary.kpis.packagedCustomActions, 2);
  assert.ok(!ctx.items.some((i) => i.name === 'Renew Subscriptions' || i.name === 'Calculate'));
  assert.ok(ctx.items.some((i) => i.name === 'Add Favorites'));
  assert.match(rm.footprintTable(ctx), /Custom actions \(org-built\) \| 1 · 1 \(2 CPQ-packaged actions excluded\)/);
});

test('blind-spot section reports what the org scope scan found', () => {
  const md = rm.blindSpotsTable(ctx);
  assert.match(md, /\| Area \| Found in this org \| Why it matters \|/);
  for (const area of ['Flows, Apex triggers and validation rules', 'Twin fields', 'Quote templates', 'Advanced Approvals', 'Salesforce Billing, multi-currency', 'Integrations', 'permission sets and training', 'RCA licensing', 'in-flight subscriptions']) assert.ok(md.includes(area), area);
  assert.match(md, /2 active flows on quoting objects \(Quote sync to opportunity on SBQQ__Quote__c/);
  assert.match(md, /1 Apex trigger \(QuoteLineTrigger on SBQQ__QuoteLine__c\)/, 'custom-object IDs resolved to API names');
  assert.match(md, /2 validation rules/);
  assert.match(md, /1 twin field \(Billing_Frequency__c\)/);
  assert.match(md, /2 quote templates \(Standard Proposal, Renewal Quote\)/);
  assert.match(md, /\*\*Installed\*\*: 1 approval rule, 1 approval chain/);
  assert.match(md, /multi-currency \*\*on\*\* \(EUR, USD; corporate USD\)/);
  assert.match(md, /2 Apex classes reference CPQ objects, 1 with external callouts \(QuoteToErpSync\)/);
  assert.match(md, /1 report on CPQ objects\/fields .*1 dashboard built on them/);
  assert.match(md, /48 active users; SBQQ licences 42\/50 used/);
  assert.match(md, /7 active subscriptions \(2 renewals due in 90 days\)/);
  const appendix = rm.scopeAppendix(ctx);
  for (const h of ['E.1 Flows', 'E.2 Apex triggers', 'E.3 Validation rules', 'E.4 Custom fields', 'E.5 Installed packages', 'E.6 Apex classes', 'E.7 Reports', 'E.8 Named credentials', 'E.9 CPQ permission sets']) assert.ok(appendix.includes(h), h);
  // inserted with its heading even when the model leaves it out
  const out = rm.expandReport('# Part 1. A\n# Part 2. B\n# Part 3. C\ntext', ctx);
  assert.ok(out.includes('## 3.6 Dependencies outside the CPQ catalog'));
});

test('a probe that fails is reported as not checked, not as zero', () => {
  const broken = structuredClone(catalog);
  broken.discovery.orgScope!.automation.validationRules = { status: 'unavailable', reason: 'INSUFFICIENT_ACCESS no Tooling API' };
  const md = rm.blindSpotsTable(rm.buildContext(broken));
  assert.match(md, /Could not be checked: INSUFFICIENT_ACCESS no Tooling API/);
});

test('LaTeX math from the model is turned into symbols', () => {
  assert.equal(rm.cleanAiMarkdown('count is $\\le$ 100 and $\\ge$ 5'), 'count is ≤ 100 and ≥ 5');
});

test('cut-over volumes are counted (never extracted)', () => {
  const v = Object.fromEntries(catalog.discovery.cutoverVolumes.map((x) => [x.name, x.recordCount]));
  assert.equal(v.SBQQ__Quote__c, 43); // 1 base quote + 42 added by the fake org
  assert.equal(v.SBQQ__Subscription__c, 9);
  assert.match(rm.cutoverTable(ctx), /\| Quote \| 43 \|/);
  assert.match(rm.keyFindingsTable(ctx), /subscription\/asset record\(s\) in flight/);
});

test('classifies items with the CPQ Configuration Document approach rules', () => {
  const by = (name: string) => ctx.items.find((i) => i.name === name)!;
  assert.equal(by('Product Rule 0').approach, 'Retire'); // inactive (r % 9 === 0)
  assert.equal(by('Product Rule 7').approach, 'Adapt'); // custom condition logic
  assert.equal(by('Product Rule 1').approach, 'Direct');
  assert.equal(by('MyQCP').approach, 'Redesign');
  assert.equal(by('Volume 9').approach, 'Adapt'); // account-specific schedule
  const { rows, total } = rm.approachSummary(ctx.items);
  assert.equal(total.items, rows.reduce((n, r) => n + r.items, 0));
  assert.equal(total.hours, ctx.items.reduce((h, i) => h + rm.EFFORT_HOURS[i.approach], 0));
});

test('rule tables describe conditions, actions, formulas and lookups', () => {
  const pr = rm.productRuleLogicTable(ctx);
  assert.match(pr, /Product Option\.SBQQ__Quantity__c > '1'/);
  assert.match(pr, /\[Total Hardware Qty\]/, 'summary variable conditions are named');
  const price = rm.priceRuleLogicTable(ctx);
  assert.match(price, /SBQQ__ListPrice__c \* 0\.9/);
  assert.match(price, /Price_Lookup__c \(1 query\)/);
  assert.match(rm.supportingLogicTable(ctx), /Sum\(Quantity\) over Quote Line/);
});

test('Part 2 tables explain every rule in plain English; technical detail moves to Appendix D', () => {
  const pr = rm.productRuleTable(ctx);
  assert.match(pr, /What it does \(plain English\)/);
  assert.match(pr, /Blocks the user from saving for Bundle 4 \(P-4\) when Quantity is greater than 1, showing: "Quantity must not exceed 1 for this bundle\."/);
  assert.match(pr, /Warns the user \(they can still continue\)/);
  assert.match(pr, /removes SKU \d+ \(P-\d+\) and prevents it from being selected again/);
  assert.match(pr, /limits the products a rep can pick for Bundle \d+ \(P-\d+\) to those whose Product Family is 'Hardware'/);
  assert.ok(!pr.includes('SBQQ__Quantity__c'), 'no API names in the plain-English table');
  const price = rm.priceRuleTable(ctx);
  assert.match(price, /sets the quote line's Special Price to the formula List Price \* 0\.9/);
  assert.match(price, /looked up from Price_Lookup__c \(row where Code is equals the Product Code\)|looked up from Price_Lookup__c/);
  const md = rm.assembleReport('# Part 1. A\n# Part 2. B\n# Part 3. C', catalog);
  assert.ok(md.includes('## Appendix D. Rule logic (technical detail)'));
  assert.ok(md.indexOf('### D.1 Product rules') > md.indexOf('## Appendix C.'));
});

test('custom fields referenced by logic are listed (CPQ fields excluded)', () => {
  const fields = rm.fieldReferences(ctx).map((f) => f.field);
  assert.ok(fields.includes('Code__c'));
  assert.ok(fields.includes('Color__c'));
  assert.ok(!fields.some((f) => f.startsWith('SBQQ__')));
});

test('expandReport replaces placeholders once, inserts missing ones in the right part, drops unknown ones', () => {
  const ai = ['# Part 1. Executive Summary', 'Intro', '{{FOOTPRINT}}', '{{FOOTPRINT}}', '{{BOGUS}}', '# Part 2. Rules', 'Text', '# Part 3. Mapping', 'More'].join('\n');
  const out = rm.expandReport(ai, ctx);
  assert.equal(out.match(/Overall migration complexity/g)?.length, 1);
  assert.ok(!out.includes('{{'));
  // PRODUCT_RULE_TABLE was not in the AI text: it must land inside Part 2 (before Part 3).
  const p2 = out.indexOf('# Part 2');
  const p3 = out.indexOf('# Part 3');
  const ruleTable = out.indexOf('| Rule | Type |');
  assert.ok(ruleTable > p2 && ruleTable < p3, 'missing table inserted in its part');
  // APPROACH_SUMMARY belongs to Part 3 (end of document).
  assert.ok(out.indexOf('| Area | Items |') > p3);
});

test('table cells escape pipes and newlines', () => {
  assert.equal(rm.cell('a|b\nc'), 'a\\|b c');
  const blocks = markdownToBlocks(`| A | B |\n| --- | --- |\n| ${rm.cell('x|y')} | z |`);
  const t = blocks.find((b) => b.kind === 'table');
  assert.ok(t && t.kind === 'table' && t.rows[0].length === 2);
});

test('assembled report has the 3-part structure, marker and appendices', () => {
  const ai = ['# Part 1. Executive Summary & Current CPQ Architecture', '{{FOOTPRINT}}', '# Part 2. Price Rules & Product Rules Breakdown', '# Part 3. CPQ-to-RCA Mapping Matrix & Migration Strategy'].join('\n');
  const md = rm.assembleReport(ai, catalog);
  assert.ok(md.startsWith(rm.REPORT_VERSION_MARKER));
  for (const h of ['# Part 1.', '# Part 2.', '# Part 3.', '# Appendices', '## Appendix A.', '## Appendix B.', '## Appendix C.']) assert.ok(md.includes(h), h);
  const tables = markdownToBlocks(md).filter((b) => b.kind === 'table').length;
  assert.ok(tables >= 10, `expected many tables, got ${tables}`);
});

test('the prompt asks for every placeholder the renderer knows, and stays compact', () => {
  const prompt = buildAssessmentPrompt(buildAssessmentDigest(catalog), 'Acme (UAT)');
  for (const key of PROMPT_PLACEHOLDERS) assert.ok(prompt.includes(`{{${key}}}`), key);
  for (const h of ['# Part 1. Executive Summary & Current CPQ Architecture', '# Part 2. Price Rules & Product Rules Breakdown', '# Part 3. CPQ-to-RCA Mapping Matrix & Migration Strategy']) {
    assert.ok(prompt.includes(h), h);
  }
  const instructions = prompt.slice(0, prompt.indexOf('Digest (JSON):'));
  assert.ok(instructions.length < 3_500, `instructions are ${instructions.length} chars`);
});

test('reports generated before the rename get the new 3.6 heading when rendered', () => {
  const old = '# Part 3. X\n## 3.6 Missing coverage & migration blind spots\ntext';
  assert.equal(rm.normalizeHeadings(old), '# Part 3. X\n## 3.6 Dependencies outside the CPQ catalog\ntext');
});
