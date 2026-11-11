import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { EnvBadge, StatusDot, useOrgs } from '../org.jsx';
import Logo from './Logo.jsx';
import { Button, Spinner } from './ui.jsx';

/** Org switcher: pick the active Salesforce org or add a new connection. */
function OrgSwitcher() {
  const { connections, active, activate, loading } = useOrgs();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  async function choose(id) {
    setBusy(id);
    try {
      await activate(id);
      setOpen(false);
      navigate('/dashboard');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner className="h-4 w-4 text-slate-400" />;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm shadow-xs transition hover:border-slate-300 hover:bg-slate-50 sm:max-w-xs"
      >
        {active ? (
          <>
            <StatusDot status={active.status} />
            <span className="truncate font-medium text-slate-800">{active.name}</span>
            <EnvBadge env={active.environmentType} className="hidden sm:inline-flex" />
          </>
        ) : (
          <span className="font-medium text-slate-500">{connections.length ? 'Select an org' : 'No org connected'}</span>
        )}
        <svg className="h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <p className="border-b border-slate-100 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Salesforce orgs</p>
          <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
            {connections.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.id === active?.id}
                  onClick={() => choose(c.id)}
                  disabled={Boolean(busy)}
                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50 ${c.id === active?.id ? 'bg-brand-50/60' : ''}`}
                >
                  <StatusDot status={c.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-800">{c.name}</span>
                    <span className="block truncate text-xs text-slate-500">{c.sfUsername || c.instanceUrl || '—'}</span>
                  </span>
                  <EnvBadge env={c.environmentType} />
                  {busy === c.id ? <Spinner /> : c.id === active?.id && <span className="text-brand-600">✓</span>}
                </button>
              </li>
            ))}
            {!connections.length && <li className="px-4 py-3 text-sm text-slate-500">No connections yet.</li>}
          </ul>
          <div className="flex border-t border-slate-100">
            <Link to="/connections/new" onClick={() => setOpen(false)} className="flex-1 px-4 py-2.5 text-sm font-semibold text-brand-600 hover:bg-slate-50">
              + Add connection
            </Link>
            <Link to="/connections" onClick={() => setOpen(false)} className="px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Manage
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

const navClass = ({ isActive }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium transition ${isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-600 hover:text-slate-900'}`;

export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <Link to="/dashboard" className="shrink-0">
            <Logo />
          </Link>
          <OrgSwitcher />
          <nav className="hidden items-center gap-1 md:flex">
            <NavLink to="/dashboard" className={navClass}>
              Assessment
            </NavLink>
            <NavLink to="/connections" end className={navClass}>
              Connections
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-slate-600 lg:inline">{user.username}</span>
            <Button
              variant="secondary"
              className="py-1.5"
              onClick={async () => {
                await logout();
                navigate('/login', { replace: true });
              }}
            >
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
