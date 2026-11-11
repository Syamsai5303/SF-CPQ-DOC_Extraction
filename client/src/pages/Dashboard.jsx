import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import AppShell from '../components/AppShell.jsx';
import AssessmentPanel from '../components/cpq/AssessmentPanel.jsx';
import BundleExplorer from '../components/cpq/BundleExplorer.jsx';
import { ComplexityPanel, Distributions, ExtractionProgress, fmt, InventoryTable, KpiGrid } from '../components/cpq/Overview.jsx';
import { Alert, Button, Spinner } from '../components/ui.jsx';
import { EnvBadge, StatusDot, useOrgs } from '../org.jsx';

const isRunning = (e) => e && ['QUEUED', 'RUNNING'].includes(e.status);
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');
const mb = (b) => (b ? `${(b / 1024 / 1024).toFixed(1)} MB` : '');

export default function Dashboard() {
  const { connections, active, loading: orgsLoading } = useOrgs();

  return (
    <AppShell>
      {orgsLoading ? (
        <div className="flex items-center gap-3 text-sm text-slate-500">
          <Spinner /> Loading…
        </div>
      ) : !connections.length ? (
        <div className="mx-auto max-w-xl rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <h1 className="text-xl font-semibold">Connect your Salesforce CPQ org</h1>
          <p className="mt-2 text-sm text-slate-500">
            Add a Sandbox, UAT or Production org. The assessment reads CPQ setup and catalog data only; quotes and quote lines are never extracted.
          </p>
          <Link to="/connections/new" className="mt-5 inline-block">
            <Button>Add connection</Button>
          </Link>
        </div>
      ) : !active ? (
        <Alert type="info" title="Choose an org">
          Pick the org to assess from the switcher at the top of the page.
        </Alert>
      ) : (
        <Workspace key={active.id} connection={active} />
      )}
    </AppShell>
  );
}

function Workspace({ connection }) {
  const { refresh: refreshOrgs } = useOrgs();
  const [history, setHistory] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [extraction, setExtraction] = useState(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(true);
  const [error, setError] = useState(null);

  const loadHistory = useCallback(async () => {
    const d = await api(`/cpq/extractions?connectionId=${connection.id}`);
    setHistory(d.extractions);
    return d.extractions;
  }, [connection.id]);

  // Initial load: newest running or succeeded extraction.
  useEffect(() => {
    let cancelled = false;
    loadHistory()
      .then((list) => {
        if (cancelled) return;
        const pick = list.find((e) => isRunning(e)) ?? list.find((e) => e.status === 'SUCCEEDED') ?? list[0];
        setSelectedId(pick?.id ?? null);
        if (!pick) setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadHistory]);

  // Load the selected extraction (with summary).
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoading(true);
    api(`/cpq/extractions/${selectedId}`)
      .then((d) => !cancelled && setExtraction(d.extraction))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Poll while running; refresh history when it finishes.
  const running = isRunning(extraction);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const d = await api(`/cpq/extractions/${extraction.id}`);
        setExtraction(d.extraction);
        if (!isRunning(d.extraction)) loadHistory();
      } catch {
        /* keep polling */
      }
    }, 1200);
    return () => clearInterval(t);
  }, [running, extraction?.id, loadHistory]);

  async function startExtraction() {
    setStarting(true);
    setError(null);
    try {
      const d = await api('/cpq/extract-catalog', { method: 'POST', body: { connectionId: connection.id, includeInactive } });
      setExtraction(d.extraction);
      setSelectedId(d.extraction.id);
      loadHistory();
    } catch (err) {
      setError(err.message);
      if (err.code === 'CREDENTIALS_UNREADABLE') refreshOrgs(); // shows the re-enter prompt
    } finally {
      setStarting(false);
    }
  }

  const unreadable = connection.credentialsReadable === false;

  const summary = extraction?.status === 'SUCCEEDED' ? extraction.summary : null;

  return (
    <div className="space-y-6">
      {/* ---- header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500">CPQ → Revenue Cloud Advanced</p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
            <span className="truncate">{connection.name}</span>
            <EnvBadge env={connection.environmentType} />
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
            <StatusDot status={connection.status} />
            <span className="truncate">{connection.instanceUrl ?? 'Not verified'}</span>
            {connection.orgId && <span className="font-mono text-xs">· {connection.orgId}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} className="h-4 w-4 rounded border-slate-300 accent-brand-600" />
            Include inactive records
          </label>
          <Button onClick={startExtraction} loading={starting} disabled={running || unreadable}>
            {running ? 'Extraction running…' : history.length ? 'Run new extraction' : 'Extract CPQ catalog'}
          </Button>
        </div>
      </div>

      {unreadable ? (
        <Alert type="error" title="Re-enter this org's credentials">
          <p>Stored credentials could not be decrypted. Please re-enter and save your Salesforce connection.</p>
          <p className="mt-1 text-xs opacity-80">This happens when the server's ENCRYPTION_KEY changed after the credentials were saved.</p>
          <Link to={`/connections/${connection.id}/edit`} className="mt-3 inline-block">
            <Button className="py-1.5">Re-enter credentials</Button>
          </Link>
        </Alert>
      ) : (
        error && <Alert type="error">{error}</Alert>
      )}

      {/* ---- run selector + JSON export */}
      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
          <label htmlFor="run" className="font-medium text-slate-700">
            Extraction run
          </label>
          <select id="run" value={selectedId ?? ''} onChange={(e) => setSelectedId(e.target.value)} className="min-w-0 max-w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
            {history.map((e) => (
              <option key={e.id} value={e.id}>
                {fmtDate(e.createdAt)} · {e.status === 'SUCCEEDED' ? `${fmt(e.recordCount)} records` : e.status.toLowerCase()}
              </option>
            ))}
          </select>
          {summary && (
            <>
              <span className="text-slate-500">
                {summary.source?.cpqInstalled === false ? 'CPQ package not detected · ' : summary.source?.cpqPackageVersion ? `CPQ v${summary.source.cpqPackageVersion} · ` : ''}
                {summary.options?.includeInactive === false ? 'active records only · ' : ''}
                {mb(extraction.catalogBytes)} JSON
              </span>
              <a href={`/api/cpq/download-catalog-json?extractionId=${extraction.id}`} download className="ml-auto">
                <Button variant="secondary" className="py-1.5">
                  ⬇ Download Catalog JSON
                </Button>
              </a>
            </>
          )}
        </div>
      )}

      {/* ---- body */}
      {loading && !extraction ? (
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          <Spinner /> Loading extraction…
        </div>
      ) : !extraction ? (
        <EmptyState />
      ) : running ? (
        <ExtractionProgress extraction={extraction} />
      ) : extraction.status === 'FAILED' ? (
        <Alert type="error" title="Extraction failed">
          {extraction.error}
        </Alert>
      ) : summary ? (
        <>
          {summary.source?.cpqInstalled === false && (
            <Alert type="info" title="Salesforce CPQ (SBQQ) is not installed in this org">
              Only standard catalog objects (Product2, Pricebook2, PricebookEntry) were extracted.
            </Alert>
          )}
          <KpiGrid kpis={summary.kpis} />
          <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
            <ComplexityPanel complexity={summary.complexity} />
            <Distributions distributions={summary.distributions} />
          </div>
          <BundleExplorer extractionId={extraction.id} totalBundles={summary.kpis.totalBundles} />
          <InventoryTable inventory={summary.inventory} otherCpqObjects={summary.otherCpqObjects} excluded={summary.excludedTransactionalObjects} notes={summary.notes} />
          <AssessmentPanel extractionId={extraction.id} />
        </>
      ) : null}
    </div>
  );
}

function EmptyState() {
  const steps = [
    ['Discover', 'Inspects the org schema (describeGlobal / describe) and finds every CPQ setup object.'],
    ['Extract', 'Streams products, bundles, rules, pricing and QCP scripts page by page. Quotes are excluded.'],
    ['Assess', 'Builds the bundle hierarchy, KPIs and complexity flags, then Gemini drafts the RCA report.'],
  ];
  return (
    <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8">
      <h2 className="text-lg font-semibold">No extraction yet for this org</h2>
      <p className="mt-1 text-sm text-slate-500">Run an extraction to build the CPQ architecture dashboard.</p>
      <ol className="mt-6 grid gap-4 sm:grid-cols-3">
        {steps.map(([title, text], i) => (
          <li key={title} className="rounded-lg bg-slate-50 p-4">
            <span className="text-xs font-semibold text-brand-600">Step {i + 1}</span>
            <p className="mt-1 font-medium text-slate-800">{title}</p>
            <p className="mt-1 text-sm text-slate-500">{text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
