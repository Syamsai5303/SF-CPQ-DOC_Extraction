import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Alert, Spinner } from '../ui.jsx';
import { fmt } from './Overview.jsx';

const PAGE = 40;

function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const Chip = ({ children, tone = 'slate', title }) => {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    brand: 'bg-brand-50 text-brand-700',
    amber: 'bg-amber-50 text-amber-800',
    red: 'bg-red-50 text-red-700',
    green: 'bg-emerald-50 text-emerald-700',
    violet: 'bg-violet-50 text-violet-700',
  };
  return (
    <span title={title} className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
};

const Caret = ({ open }) => (
  <svg className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${open ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.17 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
  </svg>
);

/** Collapsible node row. */
function Branch({ label, children, defaultOpen = false, depth }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasChildren = Boolean(children);
  return (
    <li>
      <div className="flex items-start gap-1" style={{ paddingLeft: depth * 16 }}>
        {hasChildren ? (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-1 rounded p-0.5 hover:bg-slate-100" aria-label={open ? 'Collapse' : 'Expand'}>
            <Caret open={open} />
          </button>
        ) : (
          <span className="w-[22px] shrink-0" />
        )}
        <div className="min-w-0 flex-1 py-0.5">{label}</div>
      </div>
      {hasChildren && open && <ul>{children}</ul>}
    </li>
  );
}

function ProductLabel({ node, onOpenBundle }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-sm">
      <span className={`font-medium ${node.missing ? 'italic text-slate-400' : 'text-slate-800'}`}>{node.name}</span>
      {node.productCode && <span className="font-mono text-[11px] text-slate-400">{String(node.productCode)}</span>}
      {node.isBundle && <Chip tone="brand">Bundle{node.levels ? ` · ${node.levels} tiers` : ''}</Chip>}
      {node.active === false && <Chip>Inactive</Chip>}
      {node.cycle && <Chip tone="red">Circular reference</Chip>}
      {node.ref && (
        <button type="button" onClick={() => onOpenBundle(node.productId)} className="text-xs font-semibold text-brand-600 hover:underline">
          Open bundle →
        </button>
      )}
    </span>
  );
}

function OptionBranch({ option, depth, onOpenBundle }) {
  const p = option.product;
  const expandable = p.isBundle && !p.ref && !p.cycle;
  return (
    <Branch
      depth={depth}
      label={
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs tabular-nums text-slate-400">#{option.number ?? '–'}</span>
          <ProductLabel node={p} onOpenBundle={onOpenBundle} />
          {option.type && <Chip tone={option.type === 'Component' ? 'slate' : 'violet'}>{String(option.type)}</Chip>}
          {option.required && <Chip tone="amber">Required</Chip>}
          {option.selected && <Chip tone="green">Default</Chip>}
          {option.bundled && <Chip>Bundled</Chip>}
          {option.quantity != null && <span className="text-xs text-slate-500">qty {String(option.quantity)}</span>}
        </span>
      }
    >
      {expandable ? <ProductChildren node={p} depth={depth + 1} onOpenBundle={onOpenBundle} /> : null}
    </Branch>
  );
}

function ProductChildren({ node, depth, onOpenBundle }) {
  return (
    <>
      {node.features?.map((f) => (
        <Branch
          key={f.featureId}
          depth={depth}
          defaultOpen={depth < 2}
          label={
            <span className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-semibold text-slate-700">{String(f.name)}</span>
              <span className="text-xs text-slate-400">Feature</span>
              {f.selectionMethod && <Chip tone={/dynamic/i.test(String(f.selectionMethod)) ? 'amber' : 'slate'}>{String(f.selectionMethod)}</Chip>}
              {(f.minOptions != null || f.maxOptions != null) && (
                <span className="text-xs text-slate-500">
                  select {f.minOptions ?? 0}–{f.maxOptions ?? '∞'}
                </span>
              )}
              <span className="text-xs text-slate-400">{f.options.length} options</span>
            </span>
          }
        >
          {f.options.length ? f.options.map((o) => <OptionBranch key={o.optionId} option={o} depth={depth + 1} onOpenBundle={onOpenBundle} />) : null}
        </Branch>
      ))}
      {node.ungroupedOptions?.length > 0 && (
        <Branch depth={depth} defaultOpen={depth < 2} label={<span className="text-sm font-semibold text-slate-500">Options without a feature ({node.ungroupedOptions.length})</span>}>
          {node.ungroupedOptions.map((o) => (
            <OptionBranch key={o.optionId} option={o} depth={depth + 1} onOpenBundle={onOpenBundle} />
          ))}
        </Branch>
      )}
    </>
  );
}

function BundleTree({ tree, onOpenBundle }) {
  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold">{tree.name}</h3>
          {tree.productCode && <span className="font-mono text-xs text-slate-400">{String(tree.productCode)}</span>}
          {tree.levels && <Chip tone={tree.levels >= 3 ? 'amber' : 'brand'}>{tree.levels} tiers</Chip>}
          {tree.configurationType && <Chip>{String(tree.configurationType)}</Chip>}
          {tree.active === false && <Chip>Inactive</Chip>}
        </div>
      </div>

      <ul className="rounded-lg border border-slate-200 p-2">
        <ProductChildren node={tree} depth={0} onOpenBundle={onOpenBundle} />
      </ul>

      {tree.constraints?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Option constraints ({tree.constraints.length})</h4>
          <ul className="mt-2 space-y-1 text-sm">
            {tree.constraints.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-1.5">
                <Chip tone={/exclu/i.test(String(c.type)) ? 'red' : 'violet'}>{String(c.type ?? 'Constraint')}</Chip>
                <span className="text-slate-700">{String(c.constrainingProduct ?? '?')}</span>
                <span className="text-slate-400">{/exclu/i.test(String(c.type)) ? 'excludes' : 'requires'}</span>
                <span className="text-slate-700">{String(c.constrainedProduct ?? '?')}</span>
                {c.active === false && <Chip>Inactive</Chip>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tree.configurationRules?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Product rules applied ({tree.configurationRules.length})</h4>
          <ul className="mt-2 flex flex-wrap gap-1.5 text-sm">
            {tree.configurationRules.map((r) => (
              <li key={r.id} className="rounded-md bg-white px-2 py-0.5 ring-1 ring-slate-200">
                {String(r.ruleName ?? r.ruleId ?? 'Rule')}
                {r.ruleType && <span className="text-xs text-slate-400"> · {String(r.ruleType)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tree.configurationAttributes?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Configuration attributes ({tree.configurationAttributes.length})</h4>
          <ul className="mt-2 flex flex-wrap gap-1.5 text-sm">
            {tree.configurationAttributes.map((a) => (
              <li key={a.id} className="rounded-md bg-white px-2 py-0.5 ring-1 ring-slate-200">
                {String(a.name ?? a.id)}
                {a.targetField && <span className="font-mono text-xs text-slate-400"> → {String(a.targetField)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function BundleExplorer({ extractionId, totalBundles }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('levels');
  const query = useDebounced(q);
  const [list, setList] = useState({ total: 0, bundles: [] });
  const [listLoading, setListLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [tree, setTree] = useState(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(
    async (offset = 0) => {
      setListLoading(true);
      try {
        const d = await api(`/cpq/extractions/${extractionId}/bundles?q=${encodeURIComponent(query)}&sort=${sort}&limit=${PAGE}&offset=${offset}`);
        setList((prev) => ({ total: d.total, bundles: offset ? [...prev.bundles, ...d.bundles] : d.bundles }));
        if (!offset && d.bundles[0]) setSelected((s) => s ?? d.bundles[0].productId);
      } catch (err) {
        setError(err.message);
      } finally {
        setListLoading(false);
      }
    },
    [extractionId, query, sort],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  useEffect(() => {
    setSelected(null);
    setTree(null);
  }, [extractionId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setTreeLoading(true);
    api(`/cpq/extractions/${extractionId}/bundles/${selected}`)
      .then((d) => !cancelled && setTree(d.tree))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setTreeLoading(false));
    return () => {
      cancelled = true;
    };
  }, [extractionId, selected]);

  if (!totalBundles) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">Bundle architecture explorer</h2>
        <p className="mt-2 text-sm text-slate-500">No bundles (products with features or options) were found in this org.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-5">
        <h2 className="text-base font-semibold">Bundle architecture explorer</h2>
        <p className="mt-0.5 text-sm text-slate-500">Product → Features → Options → child products, with constraints and rules</p>
      </div>
      {error && (
        <div className="p-4">
          <Alert type="error">{error}</Alert>
        </div>
      )}
      <div className="grid md:grid-cols-[minmax(240px,320px)_1fr]">
        <div className="border-b border-slate-100 md:border-r md:border-b-0">
          <div className="flex gap-2 p-3">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${fmt(totalBundles)} bundles…`}
              aria-label="Search bundles"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort bundles" className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
              <option value="levels">Deepest</option>
              <option value="options">Most options</option>
              <option value="name">Name</option>
            </select>
          </div>
          <ul className="max-h-[32rem] overflow-y-auto pb-2">
            {list.bundles.map((b) => (
              <li key={b.productId}>
                <button
                  type="button"
                  onClick={() => setSelected(b.productId)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${selected === b.productId ? 'bg-brand-50 text-brand-800' : 'hover:bg-slate-50'}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{String(b.name)}</span>
                    <span className="block text-xs text-slate-500">
                      {b.features} features · {b.options} options{b.constraints ? ` · ${b.constraints} constraints` : ''}
                    </span>
                  </span>
                  {b.circularReference && <Chip tone="red">Cycle</Chip>}
                  <Chip tone={b.levels >= 3 ? 'amber' : 'slate'}>{b.levels}T</Chip>
                </button>
              </li>
            ))}
            {!listLoading && !list.bundles.length && <li className="px-3 py-4 text-sm text-slate-500">No bundles match.</li>}
            {list.bundles.length < list.total && (
              <li className="px-3 py-2">
                <button type="button" onClick={() => load(list.bundles.length)} className="text-sm font-semibold text-brand-600 hover:underline" disabled={listLoading}>
                  {listLoading ? 'Loading…' : `Show more (${fmt(list.total - list.bundles.length)} left)`}
                </button>
              </li>
            )}
          </ul>
        </div>
        <div className="min-w-0 overflow-x-auto p-5">
          {treeLoading && !tree ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner /> Loading bundle…
            </div>
          ) : tree ? (
            <div className={treeLoading ? 'opacity-60' : ''}>
              <BundleTree tree={tree} onOpenBundle={setSelected} />
            </div>
          ) : (
            <p className="text-sm text-slate-500">Select a bundle to explore its structure.</p>
          )}
        </div>
      </div>
    </section>
  );
}
