import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import AppShell from '../components/AppShell.jsx';
import ConnectionForm from '../components/ConnectionForm.jsx';
import { Alert, Button, Spinner } from '../components/ui.jsx';
import { EnvBadge, StatusDot, useOrgs } from '../org.jsx';

const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');
const STATUS_LABEL = { ACTIVE: 'Active', FAILED: 'Connection failing', UNVERIFIED: 'Unverified' };

/** /connections, /connections/new, /connections/:id/edit */
export default function Connections({ mode }) {
  const { connections, activeConnectionId, loading, error, apply, activate } = useOrgs();
  const { id } = useParams();
  const navigate = useNavigate();
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);

  const editing = mode === 'edit' ? connections.find((c) => c.id === id) : null;

  const onSaved = (d) => {
    apply(d);
    setNotice({ type: 'success', title: mode === 'edit' ? 'Connection updated' : 'Connection added', body: `${d.connection.name} verified and saved securely.` });
    navigate('/connections');
  };

  async function retest(c) {
    setBusy(`test:${c.id}`);
    setNotice(null);
    try {
      await api(`/salesforce/connections/${c.id}/test`, { method: 'POST', body: {} });
      setNotice({ type: 'success', title: `${c.name}: connection is working` });
    } catch (err) {
      setNotice({ type: 'error', title: `${c.name}: connection failed`, body: err.message });
    } finally {
      apply(await api('/salesforce/connections'));
      setBusy(null);
    }
  }

  async function remove(c) {
    if (!window.confirm(`Delete "${c.name}"? Its saved credentials, extractions and assessments will be removed.`)) return;
    setBusy(`del:${c.id}`);
    try {
      apply(await api(`/salesforce/connections/${c.id}`, { method: 'DELETE' }));
      setNotice({ type: 'info', title: `Deleted ${c.name}` });
    } catch (err) {
      setNotice({ type: 'error', title: 'Delete failed', body: err.message });
    } finally {
      setBusy(null);
    }
  }

  if (mode === 'new' || mode === 'edit') {
    return (
      <AppShell>
        <div className="mx-auto max-w-3xl">
          <Link to="/connections" className="text-sm font-medium text-brand-600 hover:underline">
            ← All connections
          </Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">{mode === 'edit' ? `Edit ${editing?.name ?? 'connection'}` : 'Add a Salesforce org'}</h1>
          <p className="mt-1 text-sm text-slate-500">Credentials are tested against Salesforce, then encrypted with AES-256-GCM before they are stored.</p>
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            {mode === 'edit' && loading ? (
              <Spinner />
            ) : mode === 'edit' && !editing ? (
              <Alert type="error">Connection not found.</Alert>
            ) : (
              <ConnectionForm key={editing?.id ?? 'new'} connection={editing} onSaved={onSaved} onCancel={() => navigate('/connections')} />
            )}
          </section>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Salesforce connections</h1>
          <p className="mt-1 text-sm text-slate-500">Store several orgs (Sandbox, UAT, Production…) and switch between them from the header.</p>
        </div>
        <Link to="/connections/new">
          <Button>+ Add connection</Button>
        </Link>
      </div>

      <div className="mt-6 space-y-4">
        {notice && (
          <Alert type={notice.type} title={notice.title}>
            {notice.body}
          </Alert>
        )}
        {error && <Alert type="error">{error}</Alert>}
        {loading ? (
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
            <Spinner /> Loading connections…
          </div>
        ) : !connections.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="font-medium text-slate-800">No Salesforce orgs connected yet</p>
            <p className="mt-1 text-sm text-slate-500">Add your CPQ org to start the RCA migration assessment.</p>
            <Link to="/connections/new" className="mt-4 inline-block">
              <Button>Add your first connection</Button>
            </Link>
          </div>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {connections.map((c) => {
              const isActive = c.id === activeConnectionId;
              return (
                <li key={c.id} className={`rounded-xl border bg-white p-5 shadow-sm ${isActive ? 'border-brand-500/50 ring-1 ring-brand-500/30' : 'border-slate-200'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold">{c.name}</h2>
                        <EnvBadge env={c.environmentType} />
                        {isActive && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">Active org</span>}
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-600">
                        <StatusDot status={c.status} /> {STATUS_LABEL[c.status] ?? c.status}
                      </p>
                    </div>
                    {!isActive && (
                      <Button variant="secondary" className="shrink-0 py-1.5" onClick={() => activate(c.id)}>
                        Set active
                      </Button>
                    )}
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <Meta label="Method" value={c.authType === 'USERNAME_PASSWORD' ? 'Username & Password' : 'Connected App (OAuth)'} />
                    <Meta label="Salesforce user" value={c.sfUsername} />
                    <Meta label="Org ID" value={c.orgId} mono />
                    <Meta label="Last verified" value={fmtDate(c.lastVerified)} />
                    <Meta label="Instance" value={c.instanceUrl} className="col-span-2" />
                  </dl>
                  {c.credentialsReadable === false ? (
                    <div className="mt-3">
                      <Alert type="error" title="Credentials need to be re-entered">
                        {c.lastError}
                        <Link to={`/connections/${c.id}/edit`} className="mt-2 block font-semibold underline">
                          Re-enter credentials →
                        </Link>
                      </Alert>
                    </div>
                  ) : (
                    c.status === 'FAILED' &&
                    c.lastError && (
                      <div className="mt-3">
                        <Alert type="error">{c.lastError}</Alert>
                      </div>
                    )
                  )}
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    <Button variant="secondary" className="py-1.5" onClick={() => retest(c)} loading={busy === `test:${c.id}`} disabled={Boolean(busy)}>
                      Re-test
                    </Button>
                    <Link to={`/connections/${c.id}/edit`}>
                      <Button variant="secondary" className="py-1.5">
                        Edit
                      </Button>
                    </Link>
                    <Button variant="danger" className="ml-auto py-1.5" onClick={() => remove(c)} loading={busy === `del:${c.id}`} disabled={Boolean(busy)}>
                      Delete
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

function Meta({ label, value, mono, className = '' }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`mt-0.5 truncate text-slate-800 ${mono ? 'font-mono text-xs' : ''}`} title={value || undefined}>
        {value || '—'}
      </dd>
    </div>
  );
}
