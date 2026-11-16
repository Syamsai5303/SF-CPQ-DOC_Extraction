import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainCondition, explainFormula, explainPriceRule, explainPriceRuleParts, explainProductRule, humanField } from './ruleExplainer.ts';
import type { CpqCatalog } from './cpqCatalogExtractor.ts';

// Rules modelled on the "CPQ Configuration Document" examples.
const catalog = {
  catalog: {
    products: [
      { Id: 'p1', Name: 'Starter PKG-START', ProductCode: 'PKG-START' },
      { Id: 'p2', Name: 'IMPL-SETUP Implementation Setup', ProductCode: 'IMPL-SETUP' },
      { Id: 'p3', Name: 'Professional PKG-PRO', ProductCode: 'PKG-PRO' },
    ],
  },
  rules: { summaryVariables: [{ Id: 'v1', Name: 'Professional PKG-PRO Count' }, { Id: 'v2', Name: 'IMPL-SETUP Implementation Setup Count' }] },
} as unknown as CpqCatalog;

test('field names become readable labels', () => {
  assert.equal(humanField('SBQQ__ProductFamily__c'), 'Product Family');
  assert.equal(humanField('SBQQ__Discount__c'), 'Discount (%)');
  assert.equal(humanField('Employee_Count__c'), 'Employee Count');
  assert.equal(humanField('SBQQ__Quote__r'), 'Quote');
});

test('IF formulas are explained as "a if cond, otherwise b"', () => {
  assert.equal(explainFormula('IF(\n SBQQ__Quote__r.SBQQ__SubscriptionTerm__c >= 12,\n 0.1,\n 0.05\n)'), '0.1 if Quote Subscription Term ≥ 12, otherwise 0.05');
  assert.equal(explainFormula('IF(A__c > 1, 2, IF(B__c > 1, 3, 4))'), '2 if A > 1, otherwise 3 if B > 1, otherwise 4');
  assert.equal(explainFormula('SBQQ__ListPrice__c * 0.9'), 'the formula List Price * 0.9');
});

test('conditions read naturally, including summary variables', () => {
  assert.equal(explainCondition(catalog, { Id: 'c', SBQQ__TestedObject__c: 'Configuration Attributes', SBQQ__TestedField__c: 'Employee_Count__c', SBQQ__Operator__c: 'greater than', SBQQ__FilterValue__c: '100' }), 'Configuration Attributes Employee Count is greater than 100');
  assert.equal(explainCondition(catalog, { Id: 'c', links: { testedVariable: 'v1' }, SBQQ__Operator__c: 'equals', SBQQ__FilterValue__c: '1' }), "the summary variable 'Professional PKG-PRO Count' is 1");
  assert.equal(explainCondition(catalog, { Id: 'c', SBQQ__Object__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__ProductCode__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'SUB-PRO' }), "Product Code is 'SUB-PRO'");
});

test('validation rule', () => {
  const text = explainProductRule(catalog, {
    Id: 'r1',
    SBQQ__Type__c: 'Validation',
    SBQQ__EvaluationEvent__c: 'Edit',
    SBQQ__ConditionsMet__c: 'All',
    SBQQ__ErrorMessage__c: 'Starter package supports a maximum of 100 employees.',
    appliesToBundleIds: ['p1'],
    errorConditions: [{ Id: 'c', SBQQ__TestedObject__c: 'Configuration Attributes', SBQQ__TestedField__c: 'Employee_Count__c', SBQQ__Operator__c: 'greater than', SBQQ__FilterValue__c: '100' }],
    actions: [],
  });
  assert.equal(
    text,
    'Blocks the user from saving for Starter PKG-START (PKG-START) when Configuration Attributes Employee Count is greater than 100, showing: "Starter package supports a maximum of 100 employees." Runs whenever the configuration is edited.',
  );
});

test('selection rule with summary-variable validation pair', () => {
  const select = explainProductRule(catalog, {
    Id: 'r2',
    SBQQ__Type__c: 'Selection',
    SBQQ__EvaluationEvent__c: 'Load;Edit;Save',
    appliesToBundleIds: ['p1', 'p3'],
    errorConditions: [{ Id: 'c', SBQQ__TestedObject__c: 'Configuration Attributes', SBQQ__TestedField__c: 'Data_Migration_Required__c', SBQQ__Operator__c: 'equals', SBQQ__FilterValue__c: 'Yes' }],
    actions: [{ Id: 'a', SBQQ__Type__c: 'Add', links: { product: 'p2' } }],
  });
  assert.equal(
    select,
    "When Configuration Attributes Data Migration Required is 'Yes', the configurator for Starter PKG-START (PKG-START) and Professional PKG-PRO (PKG-PRO) automatically adds IMPL-SETUP Implementation Setup (IMPL-SETUP) (the user cannot deselect it). Runs whenever the configuration is loaded, edited or saved.",
  );
  const custom = explainProductRule(catalog, {
    Id: 'r3',
    SBQQ__Type__c: 'Alert',
    SBQQ__ConditionsMet__c: 'Custom',
    SBQQ__AdvancedCondition__c: '1 AND 2',
    errorConditions: [
      { Id: 'c1', links: { testedVariable: 'v1' }, SBQQ__Operator__c: 'equals', SBQQ__FilterValue__c: '1' },
      { Id: 'c2', links: { testedVariable: 'v2' }, SBQQ__Operator__c: 'equals', SBQQ__FilterValue__c: '0' },
    ],
    actions: [],
    SBQQ__Active__c: false,
  });
  assert.match(custom, /^Warns the user \(they can still continue\) when the custom logic 1 AND 2 holds over: \(1\) the summary variable 'Professional PKG-PRO Count' is 1; \(2\) the summary variable 'IMPL-SETUP Implementation Setup Count' is 0\./);
  assert.match(custom, /\(Currently inactive\.\)$/);
});

test('price rules: formula discount and lookup-table list price', () => {
  const discount = explainPriceRule(catalog, {
    Id: 'q1',
    SBQQ__EvaluationEvent__c: 'On Initialization;Before Calculate;On Calculate;After Calculate',
    SBQQ__ConditionsMet__c: 'All',
    conditions: [{ Id: 'c', SBQQ__Object__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__ProductCode__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'SUB-PRO' }],
    actions: [{ Id: 'a', SBQQ__TargetObject__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__Discount__c', SBQQ__Formula__c: 'IF(SBQQ__Quote__r.SBQQ__SubscriptionTerm__c >= 12, 0.1, 0.05)' }],
    lookupQueries: [],
  });
  assert.equal(
    discount,
    "During quote calculation (on initialization, before calculation, on calculation and after calculation), when Product Code is 'SUB-PRO', sets the quote line's Discount (%) to 0.1 if Quote Subscription Term ≥ 12, otherwise 0.05.",
  );
  const lookup = explainPriceRule(catalog, {
    Id: 'q2',
    SBQQ__EvaluationEvent__c: 'On Calculate',
    SBQQ__EvaluationOrder__c: 50,
    SBQQ__ConditionsMet__c: 'Any',
    SBQQ__LookupObject__c: 'SBQQ__LookupData__c',
    conditions: [
      { Id: 'c1', SBQQ__Object__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__ProductCode__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'SUB-START' },
      { Id: 'c2', SBQQ__Object__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__ProductCode__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'SUB-PRO' },
    ],
    actions: [{ Id: 'a', SBQQ__TargetObject__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__ListPrice__c', SBQQ__SourceLookupField__c: 'SBQQ__Value__c' }],
    lookupQueries: [{ Id: 'l', SBQQ__LookupField__c: 'Min_Employees__c', SBQQ__Operator__c: 'less or equals', SBQQ__TestedField__c: 'Employee_Count__c' }],
  });
  assert.equal(
    lookup,
    "During quote calculation (on calculation), evaluation order 50, when any of these is true: Product Code is 'SUB-START' or Product Code is 'SUB-PRO', sets the quote line's List Price to the Value looked up from SBQQ__LookupData__c (row where Min Employees is at most the Employee Count).",
  );
});

test('add + disable on the same product reads as one locked selection', () => {
  const text = explainProductRule(catalog, {
    Id: 'r5',
    SBQQ__Type__c: 'Selection',
    errorConditions: [],
    actions: [
      { Id: 'a1', SBQQ__Type__c: 'Add', links: { product: 'p2' } },
      { Id: 'a2', SBQQ__Type__c: 'Disable', links: { product: 'p2' } },
    ],
  });
  assert.match(text, /automatically adds IMPL-SETUP Implementation Setup \(IMPL-SETUP\) and locks it so the user cannot change it\./);
  assert.ok(!text.includes('prevents'));
});

test('price rule parts: purpose, trigger, conditions and actions', () => {
  const p = explainPriceRuleParts(catalog, {
    Id: 'q1',
    SBQQ__EvaluationEvent__c: 'On Initialization;Before Calculate;On Calculate;After Calculate',
    SBQQ__ConfiguratorEvaluationEvent__c: 'Edit',
    SBQQ__EvaluationOrder__c: 100,
    conditions: [{ Id: 'c', SBQQ__Object__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__ProductCode__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'SUB-START' }],
    actions: [{ Id: 'a', SBQQ__TargetObject__c: 'Quote Line', SBQQ__Field__c: 'SBQQ__Discount__c', SBQQ__Formula__c: 'IF(SBQQ__Quote__r.SBQQ__SubscriptionTerm__c >= 12, 0.08, 0.05)' }],
  });
  assert.equal(p.purpose, "Automatically calculates the quote line's Discount (%) with a formula.");
  assert.equal(p.trigger, 'Quote calculator: On Initialization → Before Calculate → On Calculate → After Calculate; product configurator: Edit; evaluation order 100.');
  assert.equal(p.conditions, "Applies when Product Code is 'SUB-START'.");
  assert.deepEqual(p.actions, ["Sets the quote line's Discount (%) to 0.08 if Quote Subscription Term ≥ 12, otherwise 0.05."]);
});

test('custom logic keeps every numbered condition, even duplicates', () => {
  const text = explainProductRule(catalog, {
    Id: 'r9',
    SBQQ__Type__c: 'Validation',
    SBQQ__ConditionsMet__c: 'Custom',
    SBQQ__AdvancedCondition__c: '1 AND (2 OR 3)',
    errorConditions: [1, 2, 3].map((i) => ({ Id: `c${i}`, SBQQ__Index__c: i, SBQQ__TestedField__c: 'SBQQ__Quantity__c', SBQQ__Operator__c: 'greater than', SBQQ__FilterValue__c: '1' })),
    actions: [],
  });
  assert.match(text, /\(1\) Quantity is greater than 1; \(2\) Quantity is greater than 1; \(3\) Quantity is greater than 1/);
});

test('duplicate conditions are collapsed and a rule without actions says so', () => {
  const text = explainPriceRule(catalog, {
    Id: 'q3',
    SBQQ__EvaluationEvent__c: 'On Calculate',
    conditions: [
      { Id: 'c1', SBQQ__Field__c: 'SBQQ__ProductFamily__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'Hardware' },
      { Id: 'c2', SBQQ__Field__c: 'SBQQ__ProductFamily__c', SBQQ__Operator__c: 'equals', SBQQ__Value__c: 'Hardware' },
    ],
    actions: [],
  });
  assert.equal(text, "During quote calculation (on calculation), when Product Family is 'Hardware', makes no price change (no actions configured).");
});
