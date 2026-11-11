import { useState } from 'react';
import { api } from '../api.js';
import { ENVIRONMENTS } from '../org.jsx';
import { Alert, Button, TextField } from './ui.jsx';

const TABS = [
  { id: 'USERNAME_PASSWORD', label: 'Username & Password', blurb: 'Username + Password + Security Token' },
  { id: 'OAUTH_CLIENT_CREDENTIALS', label: 'Connected App (OAuth)', blurb: 'Client Credentials flow' },
];

const LOGIN_URL_PRESETS = [
  { label: 'Production', value: 'https://login.salesforce.com' },
  { label: 'Sandbox', value: 'https://test.salesforce.com' },
];

function initialForms(c) {
  return {
    USERNAME_PASSWORD: {
      loginUrl: c?.authType === 'USERNAME_PASSWORD' ? c.loginUrl : c?.environmentType === 'PRODUCTION' || !c ? 'https://login.salesforce.com' : 'https://test.salesforce.com',
      username: c?.authType === 'USERNAME_PASSWORD' ? c.sfUsername ?? '' : '',
      password: '',
      securityToken: '',
    },
    OAUTH_CLIENT_CREDENTIALS: {
      tokenUrl: c?.authType === 'OAUTH_CLIENT_CREDENTIALS' ? c.tokenUrl ?? '' : '',
      clientId: c?.authType === 'OAUTH_CLIENT_CREDENTIALS' ? c.clientId ?? '' : '',
      clientSecret: '',
    },
  };
}

function describe(c) {
  if (!c) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5">
      <dt className="opacity-70">User</dt>
      <dd className="break-all">{c.displayName ? `${c.displayName} (${c.sfUsername})` : c.sfUsername}</dd>
      <dt className="opacity-70">Org ID</dt>
      <dd className="font-mono">{c.orgId}</dd>
      <dt className="opacity-70">Instance</dt>
      <dd className="break-all">{c.instanceUrl}</dd>
    </dl>
  );
}

function SecretField({ saved, hint, ...props }) {
  return (
    <TextField
      {...props}
      type="password"
      autoComplete="new-password"
      placeholder={saved ? '•••••••• saved' : ''}
      hint={saved ? 'Stored encrypted. Leave blank to keep the saved value.' : hint}
    />
  );
}

/**
 * Create / edit a Salesforce connection. "Save & Test" validates against Salesforce
 * first; credentials are only stored (AES-256-GCM encrypted) when the test passes.
 */
export default function ConnectionForm({ connection, onSaved, onCancel }) {
  const editing = Boolean(connection);
  const [name, setName] = useState(connection?.name ?? '');
  const [environmentType, setEnvironmentType] = useState(connection?.environmentType ?? 'SANDBOX');
  const [tab, setTab] = useState(connection?.authType ?? 'USERNAME_PASSWORD');
  const [forms, setForms] = useState(() => initialForms(connection));
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const savedSameType = editing && connection.authType === tab;
  const form = forms[tab];
  const setField = (e) => setForms((f) => ({ ...f, [tab]: { ...f[tab], [e.target.name]: e.target.value } }));
  const payload = () => ({ name, environmentType, authType: tab, ...form });

  async function run(kind, fn) {
    setBusy(kind);
    setResult(null);
    setFieldErrors({});
    try {
      await fn();
    } catch (err) {
      setFieldErrors(err.fields || {});
      setResult({ type: 'error', title: kind === 'save' ? 'Not saved: connection failed' : 'Connection failed', body: err.message });
    } finally {
      setBusy(null);
    }
  }

  const onTest = () =>
    run('test', async () => {
      const d = await api('/salesforce/test', { method: 'POST', body: { ...payload(), ...(editing ? { connectionId: connection.id } : {}) } });
      setResult({ type: 'success', title: 'Connection successful', body: describe(d.testResult) });
    });

  const onSave = () =>
    run('save', async () => {
      const d = editing
        ? await api(`/salesforce/connections/${connection.id}`, { method: 'PUT', body: payload() })
        : await api('/salesforce/connections', { method: 'POST', body: payload() });
      onSaved?.(d);
    });

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      {editing && connection.credentialsReadable === false && (
        <Alert type="info" title="Saved secrets can no longer be read">
          Enter the {connection.authType === 'USERNAME_PASSWORD' ? 'password and security token' : 'client secret'} again, then click Save &amp; Test Connection. They will be
          encrypted with the server's current key.
        </Alert>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Connection name"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
          placeholder="e.g. Acme UAT"
          hint="A label for the org switcher"
          autoFocus={!editing}
        />
        <div>
          <label htmlFor="environmentType" className="mb-1.5 block text-sm font-medium text-slate-700">
            Environment
          </label>
          <select
            id="environmentType"
            value={environmentType}
            onChange={(e) => {
              const v = e.target.value;
              setEnvironmentType(v);
              // Convenience: keep the login URL in step with production vs sandbox unless it is a My Domain.
              setForms((f) => {
                const cur = f.USERNAME_PASSWORD.loginUrl;
                if (!LOGIN_URL_PRESETS.some((p) => p.value === cur)) return f;
                return { ...f, USERNAME_PASSWORD: { ...f.USERNAME_PASSWORD, loginUrl: v === 'PRODUCTION' || v === 'DEVELOPER' ? LOGIN_URL_PRESETS[0].value : LOGIN_URL_PRESETS[1].value } };
              });
            }}
            className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-xs outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {ENVIRONMENTS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
          {fieldErrors.environmentType && <p className="mt-1.5 text-xs text-red-600">{fieldErrors.environmentType}</p>}
        </div>
      </div>

      <div>
        <div role="tablist" aria-label="Authentication method" className="flex gap-1 overflow-x-auto border-b border-slate-200">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setFieldErrors({});
                setResult(null);
              }}
              className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                tab === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {t.label}
              <span className="ml-2 hidden text-xs font-normal text-slate-400 lg:inline">{t.blurb}</span>
            </button>
          ))}
        </div>

        <div className="pt-5">
          {tab === 'USERNAME_PASSWORD' ? (
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <TextField
                  label="Login URL"
                  name="loginUrl"
                  value={form.loginUrl}
                  onChange={setField}
                  error={fieldErrors.loginUrl}
                  hint="Production, sandbox, or your My Domain URL (https://<domain>.my.salesforce.com)"
                  placeholder="https://login.salesforce.com"
                />
                <div className="mt-2 flex gap-2">
                  {LOGIN_URL_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setForms((f) => ({ ...f, USERNAME_PASSWORD: { ...f.USERNAME_PASSWORD, loginUrl: p.value } }))}
                      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition ${
                        form.loginUrl === p.value ? 'bg-brand-50 text-brand-700 ring-brand-500/40' : 'text-slate-600 ring-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <TextField label="Salesforce username" name="username" autoComplete="off" value={form.username} onChange={setField} error={fieldErrors.username} placeholder="admin@acme.com" className="sm:col-span-2" />
              <SecretField label="Password" name="password" value={form.password} onChange={setField} error={fieldErrors.password} saved={savedSameType && connection.hasPassword} />
              <SecretField
                label="Security token"
                name="securityToken"
                value={form.securityToken}
                onChange={setField}
                error={fieldErrors.securityToken}
                saved={savedSameType && connection.hasSecurityToken}
                hint="Optional if your IP range is trusted in Salesforce"
              />
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label="Auth / Token URL"
                name="tokenUrl"
                value={form.tokenUrl}
                onChange={setField}
                error={fieldErrors.tokenUrl}
                placeholder="https://acme.my.salesforce.com/services/oauth2/token"
                hint="Your My Domain URL; /services/oauth2/token is added if omitted"
                className="sm:col-span-2"
              />
              <TextField label="Client ID (Consumer Key)" name="clientId" autoComplete="off" value={form.clientId} onChange={setField} error={fieldErrors.clientId} />
              <SecretField label="Client Secret (Consumer Secret)" name="clientSecret" value={form.clientSecret} onChange={setField} error={fieldErrors.clientSecret} saved={savedSameType && connection.hasClientSecret} />
              <p className="text-xs text-slate-500 sm:col-span-2">
                Uses the OAuth 2.0 Client Credentials flow. In Salesforce, enable “Client Credentials Flow” on the Connected App and set a Run-As user.
              </p>
            </div>
          )}
        </div>
      </div>

      {result && (
        <Alert type={result.type} title={result.title}>
          {result.body}
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={Boolean(busy)}>
            Cancel
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onTest} loading={busy === 'test'} disabled={Boolean(busy)}>
          Test Connection
        </Button>
        <Button type="submit" loading={busy === 'save'} disabled={Boolean(busy)}>
          Save &amp; Test Connection
        </Button>
      </div>
    </form>
  );
}
