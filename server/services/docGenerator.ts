/**
 * Turns the AI assessment (Markdown) into an executive-ready DOCX or PDF.
 *
 * Markdown is parsed once (marked lexer) into a small block model, which is rendered by
 * either backend. Both include: logo + title page header, page numbers, a cover block,
 * the AI report, and deterministic appendices (KPIs, complexity flags, object inventory)
 * generated from the extraction itself, so key numbers never depend on the model.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { marked } from 'marked';
import type { Token, Tokens } from 'marked';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Tab,
  TabStopPosition,
  TabStopType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import PDFDocument from 'pdfkit';

// ------------------------------------------------------------------ model

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Array<{ runs: Run[]; children: Block[] }> }
  | { kind: 'table'; header: Run[][]; rows: Run[][][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'hr' }
  | { kind: 'pagebreak' };

export interface LogoImage {
  data: Buffer;
  type: 'png' | 'jpg';
  width: number;
  height: number;
}

export interface AssessmentDocInput {
  title: string;
  subtitle: string;
  generatedAt: Date;
  markdown: string;
  logo: LogoImage | null;
  modelNote?: string;
  /** Cover-page facts, e.g. [['Org ID', '00D…'], ['Prepared by', 'Streamforce Solutions']]. */
  meta?: Array<[string, string]>;
  /** Footer text before the page number. */
  footerText?: string;
  /** Contents page + each top-level (H1) section on a new page (merged report layout). */
  toc?: boolean;
  appendix?: {
    kpis?: Record<string, number>;
    complexity?: { score: number; level: string; flags: Array<{ severity: string; title: string; count: number; detail: string; rcaGuidance: string }> };
    inventory?: Array<{ name: string; category: string; present: boolean; recordCount: number; rcaTarget: string }>;
  };
}

const BRAND = { primary: '0B5CAB', dark: '0F172A', muted: '64748B', headerFill: '0B5CAB', zebra: 'F1F5F9', border: 'CBD5E1' };

/** Colour for status-like table cells (severity / risk / migration approach). */
const STATUS_COLORS: Record<string, string> = {
  high: 'B91C1C',
  critical: 'B91C1C',
  medium: 'C2410C',
  low: '64748B',
  direct: '15803D',
  adapt: '0B5CAB',
  redesign: 'B91C1C',
  retire: '64748B',
};
export const statusColor = (text: string): string | undefined => STATUS_COLORS[text.trim().replace(/[*.]/g, '').toLowerCase()];

// ------------------------------------------------------------------ image helpers

/** Reads PNG / JPEG dimensions from the file header (no image library needed). */
export function readImageInfo(buf: Buffer): LogoImage | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { data: buf, type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { data: buf, type: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

const fitHeight = (img: LogoImage, height: number) => ({ width: Math.round((img.width / img.height) * height), height });

// ------------------------------------------------------------------ markdown -> blocks

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);

function inlineRuns(tokens: Token[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...inlineRuns((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inlineRuns((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...inlineRuns((t as Tokens.Del).tokens, style));
        break;
      case 'codespan':
        out.push({ ...style, code: true, text: decode((t as Tokens.Codespan).text) });
        break;
      case 'link':
        out.push(...inlineRuns((t as Tokens.Link).tokens, { ...style, link: (t as Tokens.Link).href }));
        break;
      case 'br':
        out.push({ ...style, text: '\n' });
        break;
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineRuns(tt.tokens, style));
        else out.push({ ...style, text: decode(tt.text) });
        break;
      }
      case 'html':
        out.push({ ...style, text: decode((t as Tokens.HTML).text.replace(/<[^>]+>/g, '')) });
        break;
      default:
        if ('text' in t && typeof t.text === 'string') out.push({ ...style, text: decode(t.text) });
    }
  }
  return out;
}

function toBlocks(tokens: Token[]): Block[] {
  const blocks: Block[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        blocks.push({ kind: 'heading', level: (t as Tokens.Heading).depth, runs: inlineRuns((t as Tokens.Heading).tokens) });
        break;
      case 'paragraph':
        blocks.push({ kind: 'paragraph', runs: inlineRuns((t as Tokens.Paragraph).tokens) });
        break;
      case 'text':
        blocks.push({ kind: 'paragraph', runs: inlineRuns((t as Tokens.Text).tokens ?? [t]) });
        break;
      case 'list': {
        const l = t as Tokens.List;
        blocks.push({
          kind: 'list',
          ordered: l.ordered,
          start: typeof l.start === 'number' ? l.start : 1,
          items: l.items.map((item) => {
            const runs: Run[] = [];
            const children: Block[] = [];
            for (const sub of item.tokens) {
              if ((sub.type === 'text' || sub.type === 'paragraph') && !runs.length) {
                runs.push(...inlineRuns((sub as Tokens.Text).tokens ?? [sub]));
              } else children.push(...toBlocks([sub]));
            }
            if (item.task) runs.unshift({ text: item.checked ? '☑ ' : '☐ ' });
            return { runs, children };
          }),
        });
        break;
      }
      case 'table': {
        const tb = t as Tokens.Table;
        blocks.push({ kind: 'table', header: tb.header.map((c) => inlineRuns(c.tokens)), rows: tb.rows.map((r) => r.map((c) => inlineRuns(c.tokens))) });
        break;
      }
      case 'code':
        blocks.push({ kind: 'code', text: (t as Tokens.Code).text });
        break;
      case 'blockquote':
        blocks.push({ kind: 'quote', blocks: toBlocks((t as Tokens.Blockquote).tokens) });
        break;
      case 'hr':
        blocks.push({ kind: 'hr' });
        break;
      default:
        break; // space, html blocks, etc.
    }
  }
  return blocks;
}

export function markdownToBlocks(markdown: string): Block[] {
  return toBlocks(marked.lexer(markdown, { gfm: true }));
}

const plain = (runs: Run[]) => runs.map((r) => r.text).join('');

/** Report body: markdown blocks (+ legacy appendix), with page breaks before H1 sections. */
export function prepareBlocks(input: AssessmentDocInput): Block[] {
  const blocks = [...markdownToBlocks(input.markdown), ...appendixBlocks(input)];
  if (!input.toc) return blocks;
  const out: Block[] = [];
  let seenH1 = false;
  for (const b of blocks) {
    if (b.kind === 'heading' && b.level === 1) {
      if (seenH1 && out[out.length - 1]?.kind !== 'pagebreak') out.push({ kind: 'pagebreak' });
      seenH1 = true;
    }
    out.push(b);
  }
  return out;
}

/** H1/H2 headings for the contents page. */
export function tocEntries(blocks: Block[]): Array<{ level: number; text: string }> {
  return blocks.filter((b): b is Extract<Block, { kind: 'heading' }> => b.kind === 'heading' && b.level <= 2).map((b) => ({ level: b.level, text: plain(b.runs) }));
}

/** Relative column widths from (capped) average content length; shared by DOCX and PDF. */
export function columnWeights(b: Extract<Block, { kind: 'table' }>): number[] {
  const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length));
  const cells = (c: number) => [b.header[c], ...b.rows.map((r) => r[c])].map((cell) => plain(cell ?? []));
  const longestWord = (c: number) => Math.min(16, Math.max(0, ...cells(c).flatMap((t) => t.split(/\s+/).map((w) => w.length))));
  const weights = Array.from({ length: cols }, (_, c) => {
    const lens = cells(c).map((t) => Math.min(60, t.length));
    const avg = lens.reduce((s, n) => s + n, 0) / lens.length;
    // At least as wide as the longest word (+ padding), so "Redesign" / "Medium" never break mid-word.
    return Math.max(8, avg, longestWord(c) * 1.25 + 2);
  });
  const total = weights.reduce((s, n) => s + n, 0);
  // Absolute floor per column: its longest word must fit on one line (~1.35% of the
  // content width per bold character + padding), then the rest is shared proportionally.
  const floors = Array.from({ length: cols }, (_, c) => Math.min(0.3, longestWord(c) * 0.0135 + 0.02));
  let fr = weights.map((w, c) => Math.max(floors[c], w / total));
  for (let i = 0; i < 4; i++) {
    const excess = fr.reduce((s, n) => s + n, 0) - 1;
    if (excess <= 1e-6) break;
    const flexible = fr.map((f, c) => (f > floors[c] ? f - floors[c] : 0));
    const room = flexible.reduce((s, n) => s + n, 0);
    if (room <= 0) break;
    fr = fr.map((f, c) => f - (flexible[c] / room) * Math.min(excess, room));
  }
  const sum = fr.reduce((s, n) => s + n, 0);
  return fr.map((f) => f / sum);
}
const label = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/Skus/, 'SKUs');

/** Deterministic appendix sections built from extraction data. */
export function appendixBlocks(input: AssessmentDocInput): Block[] {
  const a = input.appendix;
  if (!a) return [];
  const t = (s: unknown): Run[] => [{ text: String(s ?? '') }];
  const blocks: Block[] = [{ kind: 'pagebreak' }, { kind: 'heading', level: 1, runs: t('Appendix: Extracted CPQ Data') }];
  blocks.push({ kind: 'paragraph', runs: [{ text: 'The tables below are generated directly from the catalog extraction (not by the AI model) and are the source of truth for all counts.', italic: true }] });
  if (a.kpis) {
    blocks.push({ kind: 'heading', level: 2, runs: t('A. Catalog KPIs') });
    blocks.push({ kind: 'table', header: [t('Metric'), t('Value')], rows: Object.entries(a.kpis).map(([k, v]) => [t(label(k)), t(Number(v).toLocaleString('en-US'))]) });
  }
  if (a.complexity) {
    blocks.push({ kind: 'heading', level: 2, runs: t(`B. Migration Complexity Indicators (${a.complexity.level}, score ${a.complexity.score}/100)`) });
    blocks.push({
      kind: 'table',
      header: [t('Severity'), t('Indicator'), t('Count'), t('RCA guidance')],
      rows: a.complexity.flags.map((f) => [t(f.severity.toUpperCase()), [{ text: f.title, bold: true }, { text: ` ${f.detail}` }], t(f.count.toLocaleString('en-US')), t(f.rcaGuidance)]),
    });
  }
  if (a.inventory) {
    blocks.push({ kind: 'heading', level: 2, runs: t('C. Extracted Object Inventory') });
    blocks.push({
      kind: 'table',
      header: [t('Object'), t('Category'), t('Records'), t('RCA target')],
      rows: a.inventory.map((o) => [[{ text: o.name, code: true }], t(o.category), t(o.present ? o.recordCount.toLocaleString('en-US') : 'Not in org'), t(o.rcaTarget)]),
    });
  }
  return blocks;
}

// ------------------------------------------------------------------ DOCX

function docxRuns(runs: Run[], base: { bold?: boolean; color?: string; size?: number } = {}): TextRun[] {
  return runs.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold || base.bold,
        italics: r.italic,
        font: r.code ? 'Consolas' : undefined,
        color: r.link ? BRAND.primary : base.color,
        underline: r.link ? {} : undefined,
        size: base.size,
        shading: r.code ? { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF2F7' } : undefined,
      }),
  );
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

const DOCX_CONTENT_WIDTH = 9700; // twips: A4 (11906) minus 1100 left/right margins

function docxTable(b: Extract<Block, { kind: 'table' }>): Table {
  const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length));
  const widths = columnWeights(b).map((w) => Math.round(w * DOCX_CONTENT_WIDTH));
  const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: BRAND.border };
  const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
  const size = cols >= 6 ? 17 : 19;
  const cell = (runs: Run[], col: number, header: boolean, zebra: boolean) => {
    const status = header ? undefined : statusColor(plain(runs));
    return new TableCell({
      borders,
      width: { size: widths[col], type: WidthType.DXA },
      shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: BRAND.headerFill } : zebra ? { type: ShadingType.CLEAR, color: 'auto', fill: BRAND.zebra } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [
        new Paragraph({
          spacing: { after: 0, line: 252 },
          // keepNext on the header keeps it on the same page as the first data row.
          keepNext: header,
          keepLines: true,
          children: docxRuns(runs, header ? { bold: true, color: 'FFFFFF', size } : status ? { bold: true, color: status, size } : { size }),
        }),
      ],
    });
  };
  const pad = (row: Run[][]) => [...row, ...Array.from({ length: cols - row.length }, () => [] as Run[])];
  return new Table({
    width: { size: DOCX_CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: pad(b.header).map((c, i) => cell(c, i, true, false)) }),
      ...b.rows.map((r, ri) => new TableRow({ cantSplit: true, children: pad(r).map((c, i) => cell(c, i, false, ri % 2 === 1)) })),
    ],
  });
}

function docxBlocks(blocks: Block[], state: { listInstance: number }, depth = 0): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[Math.min(b.level, 6) - 1], keepNext: true, children: docxRuns(b.runs) }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: docxRuns(b.runs) }));
        break;
      case 'list': {
        const instance = ++state.listInstance;
        for (const item of b.items) {
          out.push(
            new Paragraph({
              ...(b.ordered ? { numbering: { reference: 'ordered', level: Math.min(depth, 2), instance } } : { bullet: { level: Math.min(depth, 2) } }),
              spacing: { after: 60 },
              children: docxRuns(item.runs),
            }),
          );
          out.push(...docxBlocks(item.children, state, depth + 1));
        }
        break;
      }
      case 'table':
        out.push(docxTable(b), new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      case 'code':
        for (const line of b.text.split('\n')) {
          out.push(new Paragraph({ spacing: { after: 0 }, shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F9' }, children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 17 })] }));
        }
        break;
      case 'quote':
        // Shaded callout (like the "Example" boxes in the CPQ Configuration Document).
        for (const inner of b.blocks) {
          if (inner.kind === 'paragraph') {
            out.push(
              new Paragraph({
                shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'E8F2FB' },
                border: { left: { style: BorderStyle.SINGLE, size: 18, color: BRAND.primary, space: 6 } },
                indent: { left: 120 },
                children: docxRuns(inner.runs.map((r) => ({ ...r, italic: true }))),
              }),
            );
          } else out.push(...docxBlocks([inner], state, depth));
        }
        break;
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRAND.border, space: 1 } }, children: [] }));
        break;
      case 'pagebreak':
        out.push(new Paragraph({ pageBreakBefore: true, children: [] }));
        break;
    }
  }
  return out;
}

export async function renderDocx(input: AssessmentDocInput): Promise<Buffer> {
  const blocks = prepareBlocks(input);
  const logo = input.logo;
  const headerChildren: Array<ImageRun | TextRun> = [];
  if (logo) headerChildren.push(new ImageRun({ type: logo.type, data: logo.data, transformation: fitHeight(logo, 36) }));
  headerChildren.push(new TextRun({ children: [new Tab(), input.title], color: BRAND.muted, size: 17 }));

  const dateStr = input.generatedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const cover: Paragraph[] = [];
  if (logo) cover.push(new Paragraph({ spacing: { before: 600, after: 400 }, children: [new ImageRun({ type: logo.type, data: logo.data, transformation: fitHeight(logo, 72) })] }));
  cover.push(
    new Paragraph({ spacing: { before: logo ? 0 : 1200, after: 120 }, children: [new TextRun({ text: input.title, bold: true, size: 52, color: BRAND.dark })] }),
    new Paragraph({
      spacing: { after: 360 },
      border: input.meta ? { top: { style: BorderStyle.SINGLE, size: 8, color: BRAND.primary, space: 8 } } : undefined,
      children: [new TextRun({ text: input.subtitle, size: 26, color: BRAND.primary })],
    }),
  );
  if (input.meta?.length) {
    for (const [k, v] of input.meta) {
      cover.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${k}: `, bold: true, color: BRAND.primary, size: 20 }), new TextRun({ text: v, size: 20 })] }));
    }
  } else {
    cover.push(new Paragraph({ children: [new TextRun({ text: `Prepared ${dateStr}`, color: BRAND.muted })] }));
  }
  if (input.appendix?.complexity) {
    cover.push(new Paragraph({ children: [new TextRun({ text: `Migration complexity: ${input.appendix.complexity.level} (${input.appendix.complexity.score}/100)`, bold: true, color: BRAND.dark })] }));
  }
  if (input.modelNote) cover.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: input.modelNote, italics: true, color: BRAND.muted, size: 18 })] }));

  const doc = new Document({
    creator: 'CPQ to RCA',
    title: input.title,
    description: input.subtitle,
    styles: {
      default: { document: { run: { font: 'Calibri', size: 21, color: '1E293B' }, paragraph: { spacing: { after: 120, line: 276 } } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 34, bold: true, color: BRAND.primary }, paragraph: { spacing: { before: 360, after: 160 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, color: BRAND.dark }, paragraph: { spacing: { before: 280, after: 120 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, color: BRAND.dark }, paragraph: { spacing: { before: 200, after: 100 } } },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: level === 1 ? LevelFormat.LOWER_LETTER : LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1300, bottom: 1100, left: 1100, right: 1100, header: 500, footer: 500 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRAND.border, space: 4 } },
                children: headerChildren,
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ children: [`${input.footerText ?? 'Confidential'}  |  Page `, PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], color: BRAND.muted, size: 16 }),
                ],
              }),
            ],
          }),
        },
        children: [
          ...cover,
          ...(input.toc
            ? [
                new Paragraph({ pageBreakBefore: true, spacing: { after: 240 }, children: [new TextRun({ text: 'Contents', bold: true, size: 34, color: BRAND.primary })] }),
                ...tocEntries(blocks).map(
                  (e) =>
                    new Paragraph({
                      indent: { left: e.level === 1 ? 0 : 400 },
                      spacing: { before: e.level === 1 ? 160 : 20, after: 20 },
                      children: [new TextRun({ text: e.text, bold: e.level === 1, color: e.level === 1 ? BRAND.dark : '334155', size: e.level === 1 ? 22 : 20 })],
                    }),
                ),
              ]
            : []),
          new Paragraph({ pageBreakBefore: true, children: [] }),
          ...docxBlocks(blocks, { listInstance: 0 }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------ PDF

const require = createRequire(import.meta.url);
const fontDir = () => path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');

export async function renderPdf(input: AssessmentDocInput): Promise<Buffer> {
  const blocks = prepareBlocks(input);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 78, bottom: 64, left: 56, right: 56 },
    bufferPages: true,
    info: { Title: input.title, Subject: input.subtitle, Author: 'CPQ to RCA', Creator: 'CPQ to RCA' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const dir = fontDir();
  doc.registerFont('body', path.join(dir, 'DejaVuSans.ttf'));
  doc.registerFont('bold', path.join(dir, 'DejaVuSans-Bold.ttf'));
  doc.registerFont('italic', path.join(dir, 'DejaVuSans-Oblique.ttf'));
  doc.registerFont('bolditalic', path.join(dir, 'DejaVuSans-BoldOblique.ttf'));
  doc.registerFont('mono', path.join(dir, 'DejaVuSansMono.ttf'));

  const hex = (c: string) => `#${c}`;
  const left = doc.page.margins.left;
  const contentWidth = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (h: number) => {
    if (doc.y + h > bottomLimit()) doc.addPage();
  };
  const usableHeight = () => bottomLimit() - doc.page.margins.top;
  const HEADING_SIZES = [18, 14, 12, 11, 10, 10];
  const headingHeight = (b: Extract<Block, { kind: 'heading' }>) => {
    const size = HEADING_SIZES[Math.min(b.level, 6) - 1];
    doc.font('bold').fontSize(size);
    return doc.heightOfString(plain(b.runs) || ' ', { width: contentWidth(), lineGap: 2 }) + size * (b.level === 1 ? 2.2 : 1.4);
  };
  /**
   * Space a heading needs so it is never left alone at the bottom of a page: the heading,
   * any headings directly below it, and the start of the first content block (a table's
   * header + first row, or the first lines of a paragraph/list).
   */
  const keepWithNextHeight = (list: Block[], i: number): number => {
    const b = list[i];
    if (!b) return 0;
    switch (b.kind) {
      case 'heading':
        return headingHeight(b) + keepWithNextHeight(list, i + 1);
      case 'table':
        return tableLead(b);
      case 'paragraph':
        doc.font('body').fontSize(10);
        return Math.min(doc.heightOfString(plain(b.runs) || ' ', { width: contentWidth(), lineGap: 2 }), 42) + 6;
      case 'list':
        return 34;
      case 'code':
      case 'quote':
        return 40;
      default:
        return 0;
    }
  };
  const fontFor = (r: Run, forceBold = false) => (r.code ? 'mono' : (r.bold || forceBold) && r.italic ? 'bolditalic' : r.bold || forceBold ? 'bold' : r.italic ? 'italic' : 'body');

  const writeRuns = (runs: Run[], opts: { size?: number; color?: string; bold?: boolean; indent?: number; width?: number; x?: number } = {}) => {
    const size = opts.size ?? 10;
    const parts = runs.filter((r) => r.text.length);
    if (!parts.length) parts.push({ text: ' ' });
    parts.forEach((r, i) => {
      doc
        .font(fontFor(r, opts.bold))
        .fontSize(r.code ? size - 1 : size)
        .fillColor(r.link ? hex(BRAND.primary) : hex(opts.color ?? '1E293B'));
      const options = { continued: i < parts.length - 1, width: opts.width ?? contentWidth() - (opts.indent ?? 0), lineGap: 2, link: r.link, underline: Boolean(r.link) };
      if (i === 0) doc.text(r.text, (opts.x ?? left) + (opts.indent ?? 0), doc.y, options);
      else doc.text(r.text, options);
    });
  };

  const tableMetrics = (b: Extract<Block, { kind: 'table' }>) => {
    const widths = columnWeights(b).map((w) => w * contentWidth());
    const pad = 4;
    const size = widths.length >= 6 ? 7.5 : 8.5;
    const rowHeight = (cells: Run[][], header: boolean) =>
      Math.max(
        ...widths.map((w, c) => {
          const runs = cells[c] ?? [];
          const text = plain(runs) || ' ';
          // Measure with the widest font used in the cell (mono > bold > regular) so text never clips.
          const font = runs.some((r) => r.code) ? 'mono' : header || runs.some((r) => r.bold) || statusColor(text) ? 'bold' : 'body';
          doc.font(font).fontSize(size);
          return doc.heightOfString(text, { width: w - pad * 2, lineGap: 1 });
        }),
      ) +
      pad * 2 +
      2;
    return { widths, pad, size, rowHeight };
  };

  /** Height of a table's header plus its first row: never split across pages. */
  const tableLead = (b: Extract<Block, { kind: 'table' }>) => {
    const { rowHeight } = tableMetrics(b);
    return rowHeight(b.header, true) + (b.rows[0] ? rowHeight(b.rows[0], false) : 0);
  };

  const drawTable = (b: Extract<Block, { kind: 'table' }>) => {
    const { widths, pad, size, rowHeight } = tableMetrics(b);

    const drawRow = (cells: Run[][], header: boolean, zebra: boolean) => {
      const h = rowHeight(cells, header);
      if (doc.y + h > bottomLimit()) {
        doc.addPage();
        if (!header) drawRow(b.header, true, false);
      }
      const y = doc.y;
      let x = left;
      widths.forEach((w, c) => {
        if (header) doc.rect(x, y, w, h).fill(hex(BRAND.headerFill));
        else if (zebra) doc.rect(x, y, w, h).fill(hex(BRAND.zebra));
        doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(hex(BRAND.border)).stroke();
        const runs = cells[c] ?? [];
        const parts = runs.length ? runs : [{ text: ' ' }];
        const status = header ? undefined : statusColor(plain(runs));
        parts.forEach((r, i) => {
          doc
            .font(fontFor(r, header || Boolean(status)))
            .fontSize(r.code ? size - 0.5 : size)
            .fillColor(header ? '#FFFFFF' : status ? hex(status) : hex('1E293B'));
          const o = { width: w - pad * 2, lineGap: 1, continued: i < parts.length - 1 };
          if (i === 0) doc.text(r.text || ' ', x + pad, y + pad, o);
          else doc.text(r.text, o);
        });
        x += w;
      });
      doc.x = left;
      doc.y = y + h;
    };

    // Keep the header with the first data row (no orphaned header at the foot of a page).
    ensure(Math.min(tableLead(b), usableHeight() * 0.8));
    drawRow(b.header, true, false);
    b.rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
    doc.moveDown(0.6);
  };

  const render = (list: Block[], depth = 0) => {
    for (const [index, b] of list.entries()) {
      switch (b.kind) {
        case 'heading': {
          const size = HEADING_SIZES[Math.min(b.level, 6) - 1];
          ensure(Math.min(keepWithNextHeight(list, index), usableHeight() * 0.6));
          doc.moveDown(b.level === 1 ? 0.8 : 0.5);
          writeRuns(b.runs, { size, bold: true, color: b.level === 1 ? BRAND.primary : BRAND.dark });
          if (b.level === 1) {
            doc.moveTo(left, doc.y + 2).lineTo(left + contentWidth(), doc.y + 2).lineWidth(1).strokeColor(hex(BRAND.primary)).stroke();
            doc.moveDown(0.4);
          }
          doc.moveDown(0.3);
          break;
        }
        case 'paragraph':
          ensure(24);
          writeRuns(b.runs, { indent: depth * 14 });
          doc.moveDown(0.5);
          break;
        case 'list':
          b.items.forEach((item, i) => {
            ensure(20);
            const marker = b.ordered ? `${b.start + i}.` : '•';
            const indent = depth * 16;
            const y = doc.y;
            doc.font('body').fontSize(10).fillColor(hex(BRAND.dark)).text(marker, left + indent, y, { width: 16 });
            doc.y = y;
            writeRuns(item.runs, { indent: indent + 16 });
            doc.moveDown(0.2);
            render(item.children, depth + 1);
          });
          doc.moveDown(0.3);
          break;
        case 'table':
          drawTable(b);
          break;
        case 'code': {
          doc.font('mono').fontSize(8);
          const h = doc.heightOfString(b.text, { width: contentWidth() - 16 }) + 12;
          ensure(Math.min(h, 200));
          const y = doc.y;
          if (y + h <= bottomLimit()) doc.rect(left, y, contentWidth(), h).fill('#F1F5F9');
          doc.fillColor(hex(BRAND.dark)).text(b.text, left + 8, y + 6, { width: contentWidth() - 16 });
          doc.moveDown(0.6);
          break;
        }
        case 'quote': {
          const startY = doc.y;
          const startPage = doc.bufferedPageRange().count;
          render(b.blocks.map((x) => (x.kind === 'paragraph' ? { ...x, runs: x.runs.map((r) => ({ ...r, italic: true })) } : x)), depth + 1);
          if (doc.bufferedPageRange().count === startPage) {
            doc.moveTo(left + 4, startY).lineTo(left + 4, doc.y - 6).lineWidth(2).strokeColor(hex(BRAND.primary)).stroke();
          }
          break;
        }
        case 'hr':
          ensure(16);
          doc.moveTo(left, doc.y).lineTo(left + contentWidth(), doc.y).lineWidth(0.5).strokeColor(hex(BRAND.border)).stroke();
          doc.moveDown(0.6);
          break;
        case 'pagebreak':
          doc.addPage();
          break;
      }
    }
  };

  // ---- cover page
  const dateStr = input.generatedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.y = 150;
  if (input.logo) {
    const { width, height } = fitHeight(input.logo, 64);
    doc.image(input.logo.data, left, doc.y, { width, height });
    doc.y += height + 40;
  }
  doc.font('bold').fontSize(28).fillColor(hex(BRAND.dark)).text(input.title, left, doc.y, { width: contentWidth() });
  doc.moveDown(0.4);
  if (input.meta) {
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(left + contentWidth(), doc.y).lineWidth(1).strokeColor(hex(BRAND.primary)).stroke();
    doc.moveDown(0.6);
  }
  doc.font('body').fontSize(input.meta ? 13 : 15).fillColor(hex(BRAND.primary)).text(input.subtitle, left, doc.y, { width: contentWidth() });
  doc.moveDown(1.5);
  if (input.meta?.length) {
    for (const [k, v] of input.meta) {
      doc.font('bold').fontSize(10).fillColor(hex(BRAND.primary)).text(`${k}: `, left, doc.y, { continued: true });
      doc.font('body').fillColor(hex(BRAND.dark)).text(v);
      doc.moveDown(0.25);
    }
  } else {
    doc.font('body').fontSize(11).fillColor(hex(BRAND.muted)).text(`Prepared ${dateStr}`);
  }
  if (input.appendix?.complexity) {
    doc.moveDown(0.4).font('bold').fillColor(hex(BRAND.dark)).text(`Migration complexity: ${input.appendix.complexity.level} (${input.appendix.complexity.score}/100)`);
  }
  if (input.modelNote) doc.moveDown(1).font('italic').fontSize(9).fillColor(hex(BRAND.muted)).text(input.modelNote, { width: contentWidth() });

  if (input.toc) {
    doc.addPage();
    doc.font('bold').fontSize(18).fillColor(hex(BRAND.primary)).text('Contents', left, doc.y);
    doc.moveDown(0.8);
    for (const e of tocEntries(blocks)) {
      if (e.level === 1) doc.moveDown(0.5);
      doc
        .font(e.level === 1 ? 'bold' : 'body')
        .fontSize(e.level === 1 ? 11 : 10)
        .fillColor(hex(e.level === 1 ? BRAND.dark : '334155'))
        .text(e.text, left + (e.level === 1 ? 0 : 18), doc.y, { width: contentWidth() - 18 });
      doc.moveDown(0.15);
    }
  }

  doc.addPage();
  render(blocks);

  // ---- header (logo + title) and footer (page x of y) on every page but the cover
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow drawing in the margin without auto page breaks
    if (i > range.start) {
      let titleX = left;
      if (input.logo) {
        const { width, height } = fitHeight(input.logo, 26);
        doc.image(input.logo.data, left, 30, { width, height });
        titleX = left + width + 12;
      }
      doc.font('body').fontSize(8).fillColor(hex(BRAND.muted)).text(input.title, titleX, 40, { width: doc.page.width - titleX - doc.page.margins.right, align: 'right', lineBreak: false });
      doc.moveTo(left, 62).lineTo(doc.page.width - doc.page.margins.right, 62).lineWidth(0.5).strokeColor(hex(BRAND.border)).stroke();
      doc
        .font('body')
        .fontSize(8)
        .fillColor(hex(BRAND.muted))
        .text(`${input.footerText ?? 'Confidential'}  |  Page ${i - range.start + 1} of ${range.count}`, left, doc.page.height - 40, { width: contentWidth(), align: 'center', lineBreak: false });
    }
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return done;
}

export function renderAssessmentDocument(format: 'docx' | 'pdf', input: AssessmentDocInput): Promise<Buffer> {
  return format === 'pdf' ? renderPdf(input) : renderDocx(input);
}
