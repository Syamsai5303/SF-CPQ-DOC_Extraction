import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.jsx';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  async function onSubmit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError({ message: 'Passwords do not match', fields: { confirm: 'Passwords do not match' } });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const d = await api('/auth/reset-password', { method: 'POST', body: { token, password: form.password } });
      if (user) await logout(); // all sessions were invalidated server-side
      navigate('/login', { replace: true, state: { notice: d.message } });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Invalid reset link">
        <Alert type="error">This link is missing its reset token.</Alert>
        <Link to="/forgot-password" className="mt-4 inline-block text-sm font-semibold text-brand-600 hover:underline">
          Request a new link
        </Link>
      </AuthLayout>
    );
  }

  const f = error?.fields || {};
  return (
    <AuthLayout title="Choose a new password" subtitle="This will sign you out of all other sessions.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && !f.password && !f.confirm && (
          <Alert type="error">
            {error.message}{' '}
            <Link to="/forgot-password" className="font-semibold underline">
              Request a new link
            </Link>
          </Alert>
        )}
        <TextField label="New password" name="password" type="password" autoComplete="new-password" value={form.password} onChange={onChange} error={f.password} hint="At least 8 characters" required autoFocus />
        <TextField label="Confirm new password" name="confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={onChange} error={f.confirm} required />
        <Button type="submit" loading={busy} className="w-full">
          Reset password
        </Button>
      </form>
    </AuthLayout>
  );
}
