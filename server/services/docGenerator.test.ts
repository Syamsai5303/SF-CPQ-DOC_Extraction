import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendixBlocks, markdownToBlocks, readImageInfo, renderDocx, renderPdf } from './docGenerator.ts';
import type { AssessmentDocInput } from './docGenerator.ts';
import { SAMPLE_MARKDOWN } from './testing/sampleAssessment.ts';

const LOGO = path.resolve(import.meta.dirname, '../../client/public/logo.png');


const input = (logo = true): AssessmentDocInput => ({
  title: 'RCA Migration Assessment',
  subtitle: 'Acme UAT (Sandbox)',
  generatedAt: new Date('2026-11-12T10:00:00Z'),
  markdown: SAMPLE_MARKDOWN,
  logo: logo ? readImageInfo(fs.readFileSync(LOGO)) : null,
  modelNote: 'AI-generated with gemini-2.5-flash. Review before distribution.',
  appendix: {
    kpis: { totalProducts: 3000, activeBundles: 280, standaloneSkus: 2500 },
    complexity: { score: 72, level: 'Very High', flags: [{ severity: 'high', title: 'QCP', count: 1, detail: '1 script', rcaGuidance: 'Rewrite as Pricing Procedure' }] },
    inventory: [{ name: 'Product2', category: 'Catalog & Products', present: true, recordCount: 3000, rcaTarget: 'Product' }],
  },
});

test('reads PNG dimensions of the company logo', () => {
  const info = readImageInfo(fs.readFileSync(LOGO))!;
  assert.equal(info.type, 'png');
  assert.equal(info.width, 480);
  assert.equal(info.height, 112);
});

test('parses markdown into headings, tables, nested lists, quotes and code', () => {
  const blocks = markdownToBlocks(SAMPLE_MARKDOWN);
  const kinds = blocks.map((b) => b.kind);
  for (const k of ['heading', 'paragraph', 'table', 'list', 'quote', 'code', 'hr']) assert.ok(kinds.includes(k as never), `missing ${k}`);
  const para = blocks.find((b) => b.kind === 'paragraph')!;
  assert.ok(para.kind === 'paragraph' && para.runs.some((r) => r.bold && r.text === 'mature CPQ'));
  const list = blocks.find((b) => b.kind === 'list' && !b.ordered)!;
  assert.ok(list.kind === 'list' && list.items[1].children[0].kind === 'list', 'nested list kept');
  assert.equal(appendixBlocks(input()).filter((b) => b.kind === 'table').length, 3);
});

test('renders a DOCX (zip) with logo', async () => {
  const buf = await renderDocx(input());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.ok(buf.length > 20_000, 'contains the embedded logo');
  if (process.env.DOC_SAMPLE_DIR) fs.writeFileSync(path.join(process.env.DOC_SAMPLE_DIR, 'sample.docx'), buf);
});

test('renders a PDF with logo, without logo, and with unicode text', async () => {
  const buf = await renderPdf(input());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  if (process.env.DOC_SAMPLE_DIR) fs.writeFileSync(path.join(process.env.DOC_SAMPLE_DIR, 'sample.pdf'), buf);
  const noLogo = await renderPdf(input(false));
  assert.ok(noLogo.length < buf.length);
});

test('PDF table rows break across pages and repeat the header', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => `| Rule ${i} | ${'long text '.repeat(i % 7)} | Pricing Procedure |`).join('\n');
  const md = `# Big table\n\n| Rule | Detail | RCA |\n| --- | --- | --- |\n${rows}\n`;
  const buf = await renderPdf({ ...input(), markdown: md, appendix: undefined });
  const pages = (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages >= 4, `expected multiple pages, got ${pages}`);
});
