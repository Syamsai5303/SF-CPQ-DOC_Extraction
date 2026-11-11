import { useMemo, useState } from 'react';

export const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

// ------------------------------------------------------------------ extraction progress

const OBJ_STATUS = {
  pending: { label: 'Pending', cls: 'bg-slate-100 text-slate-500' },
  running: { label: 'Extracting', cls: 'bg-brand-50 text-brand-700' },
  done: { label: 'Done', cls: 'bg-emerald-50 text-emerald-700' },
  counted: { label: 'Counted', cls: 'bg-emerald-50 text-emerald-700' },
  missing: { label: 'Not in org', cls: 'bg-slate-100 text-slate-400' },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-700' },
};

export function ExtractionProgress({ extraction }) {
  const p = extraction.progress ?? {};
  const objects = p.objects ?? [];
  const finished = objects.filter((o) => !['pending', 'running'].includes(o.status)).length;
  const pct = p.stage === 'building' || p.stage === 'done' ? 100 : objects.length ? Math.round((finished / objects.length) * 100) : 3;
  const records = objects.reduce((n, o) => n + (o.fetched || 0), 0);
  const elapsed = extraction.startedAt ? Math.max(0, Math.round((Date.now() - new Date(extraction.startedAt)) / 1000)) : 0;

  return (
    <section className="rounded-xl border border-brand-500/30 bg-white p-6 shadow-sm" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Extracting CPQ configuration…</h2>
        <span className="text-sm tabular-nums text-slate-500">
          {fmt(records)} records · {elapsed}s
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600">{p.message || 'Starting…'}</p>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-brand-600 transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      {objects.length > 0 && (
        <ul className="mt-5 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {objects.map((o) => {
            const s = OBJ_STATUS[o.status] ?? OBJ_STATUS.pending;
            return (
              <li key={o.name} className="flex items-center justify-between gap-2 border-b border-slate-50 py-1">
                <span className="truncate font-mono text-xs text-slate-700" title={o.error || o.name}>
                  {o.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {o.status === 'running' && o.total != null && (
                    <span className="text-xs tabular-nums text-slate-500">
                      {fmt(o.fetched)}/{fmt(o.total)}
                    </span>
                  )}
                  {(o.status === 'done' || o.status === 'counted') && <span className="text-xs tabular-nums text-slate-500">{fmt(o.status === 'counted' ? o.total : o.fetched)}</span>}
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${s.cls}`}>{s.label}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ KPIs

const PRIMARY_KPIS = [
  { key: 'totalProducts', label: 'Total Products', sub: (k) => `${fmt(k.activeProducts)} active` },
  { key: 'activeBundles', label: 'Active Bundles', sub: (k) => `${fmt(k.totalBundles)} total · up to ${k.maxBundleLevels || 1} tiers` },
  { key: 'standaloneSkus', label: 'Standalone SKUs', sub: (k) => `${fmt(k.optionOnlyProducts)} option-only` },
  { key: 'pricingRules', label: 'Pricing Rules', sub: (k) => `${fmt(k.activePricingRules)} active` },
  { key: 'productRules', label: 'Product Rules', sub: (k) => `${fmt(k.activeProductRules)} active` },
  { key: 'discountSchedules', label: 'Discount Schedules', sub: () => 'volume / term tiers' },
];

const SECONDARY_KPIS = [
  ['features', 'Features'],
  ['options', 'Options'],
  ['optionConstraints', 'Option constraints'],
  ['configurationAttributes', 'Config attributes'],
  ['pricebookEntries', 'Price book entries'],
  ['summaryVariables', 'Summary variables'],
  ['customScripts', 'QCP / custom scripts'],
];

export function KpiGrid({ kpis }) {
  return (
    <section aria-label="Catalog KPIs">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {PRIMARY_KPIS.map((k) => (
          <div key={k.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{k.label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-slate-900">{fmt(kpis[k.key])}</p>
            <p className="mt-1 truncate text-xs text-slate-500">{k.sub(kpis)}</p>
          </div>
        ))}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
        {SECONDARY_KPIS.map(([key, label]) => (
          <div key={key} className="flex items-baseline gap-1.5">
            <dt className="text-slate-500">{label}</dt>
            <dd className="font-semibold tabular-nums text-slate-800">{fmt(kpis[key])}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ------------------------------------------------------------------ distributions

const DIST_LABELS = {
  configurationType: 'Bundle configuration type',
  pricingMethod: 'Pricing method',
  productRuleType: 'Product rule types',
  optionType: 'Option types',
  priceRuleEvaluationEvent: 'Price rule events',
  productFamily: 'Product families',
};

export function Distributions({ distributions }) {
  const entries = Object.entries(DIST_LABELS)
    .map(([k, label]) => [label, Object.entries(distributions?.[k] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6)])
    .filter(([, v]) => v.length);
  if (!entries.length) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Configuration patterns</h2>
      <div className="mt-4 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map(([label, values]) => {
          const max = Math.max(...values.map(([, n]) => n));
          return (
            <div key={label}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</h3>
              <ul className="mt-2 space-y-1.5">
                {values.map(([name, n]) => (
                  <li key={name} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="truncate text-slate-700" title={name}>
                        {name}
                      </span>
                      <span className="tabular-nums text-slate-500">{fmt(n)}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-brand-500/70" style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ complexity

const SEV = {
  high: { label: 'High', cls: 'bg-red-50 text-red-700 ring-red-600/20', bar: 'bg-red-500' },
  medium: { label: 'Medium', cls: 'bg-amber-50 text-amber-800 ring-amber-600/20', bar: 'bg-amber-500' },
  low: { label: 'Low', cls: 'bg-slate-100 text-slate-600 ring-slate-500/20', bar: 'bg-slate-400' },
};
const LEVEL_COLOR = { Low: 'text-emerald-600', Medium: 'text-amber-600', High: 'text-orange-600', 'Very High': 'text-red-600' };
const LEVEL_BAR = { Low: 'bg-emerald-500', Medium: 'bg-amber-500', High: 'bg-orange-500', 'Very High': 'bg-red-500' };

export function ComplexityPanel({ complexity }) {
  const [open, setOpen] = useState(() => new Set());
  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 };
    complexity.flags.forEach((f) => (c[f.severity] += 1));
    return c;
  }, [complexity]);
  const toggle = (id) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-slate-100 p-5">
        <div>
          <h2 className="text-base font-semibold">Migration complexity</h2>
          <p className="mt-0.5 text-sm text-slate-500">Patterns that need redesign or manual conversion in RCA</p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <div className="text-right">
            <p className={`text-xl font-semibold ${LEVEL_COLOR[complexity.level]}`}>{complexity.level}</p>
            <p className="text-xs tabular-nums text-slate-500">score {complexity.score}/100</p>
          </div>
          <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <div className={`h-full rounded-full ${LEVEL_BAR[complexity.level]}`} style={{ width: `${complexity.score}%` }} />
          </div>
        </div>
        <div className="flex w-full gap-2 text-xs">
          {['high', 'medium', 'low'].map((s) => (
            <span key={s} className={`rounded-full px-2 py-0.5 font-semibold ring-1 ring-inset ${SEV[s].cls}`}>
              {counts[s]} {SEV[s].label.toLowerCase()}
            </span>
          ))}
        </div>
      </div>
      {complexity.flags.length === 0 ? (
        <p className="p-5 text-sm text-slate-500">No complexity indicators found: the catalog maps cleanly to standard RCA constructs.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {complexity.flags.map((f) => {
            const isOpen = open.has(f.id);
            return (
              <li key={f.id}>
                <button type="button" onClick={() => toggle(f.id)} aria-expanded={isOpen} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-slate-50">
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset ${SEV[f.severity].cls}`}>{SEV[f.severity].label}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800">{f.title}</span>
                    <span className="block text-sm text-slate-500">{f.detail}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700">{fmt(f.count)}</span>
                  <span className={`shrink-0 text-slate-400 transition ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true">
                    ›
                  </span>
                </button>
                {isOpen && (
                  <div className="space-y-2 bg-slate-50/60 px-5 pb-4 pl-[4.25rem] text-sm">
                    <p>
                      <span className="font-semibold text-slate-700">RCA approach: </span>
                      <span className="text-slate-600">{f.rcaGuidance}</span>
                    </p>
                    {f.examples?.length > 0 && (
                      <div>
                        <p className="font-semibold text-slate-700">Examples</p>
                        <ul className="mt-1 flex flex-wrap gap-1.5">
                          {f.examples.map((e) => (
                            <li key={e.id} className="rounded-md bg-white px-2 py-0.5 text-xs text-slate-700 ring-1 ring-slate-200" title={e.id}>
                              {e.name}
                              {e.info && <span className="text-slate-400"> · {e.info}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ inventory

export function InventoryTable({ inventory, otherCpqObjects, excluded, notes }) {
  const [open, setOpen] = useState(false);
  const present = inventory.filter((o) => o.present).length;
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-4 p-5 text-left">
        <span>
          <span className="block text-base font-semibold">Schema discovery</span>
          <span className="block text-sm text-slate-500">
            {present} of {inventory.length} CPQ setup objects found · {otherCpqObjects?.length ?? 0} other SBQQ objects · quotes excluded
          </span>
        </span>
        <span className={`text-slate-400 transition ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <div className="border-t border-slate-100">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-medium">Object</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 text-right font-medium">Records</th>
                  <th className="px-3 py-2 text-right font-medium">Fields</th>
                  <th className="px-5 py-2 font-medium">RCA target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {inventory.map((o) => (
                  <tr key={o.name} className={o.present ? '' : 'text-slate-400'}>
                    <td className="px-5 py-2 font-mono text-xs">
                      {o.name}
                      {o.truncated && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700">capped</span>}
                      {o.error && (
                        <span className="ml-1 rounded bg-red-50 px-1 text-[10px] text-red-700" title={o.error}>
                          error
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{o.category}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.present ? fmt(o.recordCount) : 'Not in org'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.present ? fmt(o.fieldCount) : ''}</td>
                    <td className="px-5 py-2 text-xs text-slate-600">{o.rcaTarget}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-4 border-t border-slate-100 p-5 text-sm md:grid-cols-2">
            {otherCpqObjects?.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Other SBQQ setup objects (counted)</h3>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {otherCpqObjects.map((o) => (
                    <li key={o.name} className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-600">
                      {o.name} <span className="text-slate-400">{o.recordCount == null ? '?' : fmt(o.recordCount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Excluded transactional objects</h3>
              <p className="mt-2 font-mono text-xs leading-relaxed text-slate-500">{excluded?.join(', ')}</p>
            </div>
            {notes?.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500 md:col-span-2">
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
