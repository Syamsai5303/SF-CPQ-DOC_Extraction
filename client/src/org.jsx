import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

/** Multi-org state: the user's Salesforce connections and the active org (persisted server-side). */
const OrgContext = createContext(null);

export const ENVIRONMENTS = [
  { value: 'PRODUCTION', label: 'Production' },
  { value: 'SANDBOX', label: 'Sandbox' },
  { value: 'UAT', label: 'UAT' },
  { value: 'DEVELOPER', label: 'Developer' },
  { value: 'OTHER', label: 'Other' },
];
export const envLabel = (v) => ENVIRONMENTS.find((e) => e.value === v)?.label ?? v;

export const ENV_STYLES = {
  PRODUCTION: 'bg-red-50 text-red-700 ring-red-600/20',
  SANDBOX: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  UAT: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  DEVELOPER: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  OTHER: 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

export function OrgProvider({ children }) {
  const [connections, setConnections] = useState([]);
  const [activeConnectionId, setActiveConnectionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const apply = useCallback((d) => {
    if (d?.connections) setConnections(d.connections);
    if (d && 'activeConnectionId' in d) setActiveConnectionId(d.activeConnectionId);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api('/salesforce/connections'));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activate = useCallback(async (id) => apply(await api(`/salesforce/connections/${id}/activate`, { method: 'POST', body: {} })), [apply]);

  const value = useMemo(
    () => ({
      connections,
      activeConnectionId,
      active: connections.find((c) => c.id === activeConnectionId) ?? null,
      loading,
      error,
      refresh,
      activate,
      apply,
    }),
    [connections, activeConnectionId, loading, error, refresh, activate, apply],
  );
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export const useOrgs = () => useContext(OrgContext);

export function EnvBadge({ env, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${ENV_STYLES[env] ?? ENV_STYLES.OTHER} ${className}`}>
      {envLabel(env)}
    </span>
  );
}

const STATUS_DOT = { ACTIVE: 'bg-emerald-500', FAILED: 'bg-red-500', UNVERIFIED: 'bg-amber-500' };
export function StatusDot({ status, className = '' }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status] ?? 'bg-slate-400'} ${className}`} aria-label={status} />;
}
