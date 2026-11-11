import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.jsx';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', username: '', password: '', confirm: '' });
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
      await register({ email: form.email, username: form.username, password: form.password });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const f = error?.fields || {};
  return (
    <AuthLayout
      title="Create your account"
      subtitle="Then connect your Salesforce org"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-brand-600 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && !Object.keys(f).length && <Alert type="error">{error.message}</Alert>}
        <TextField label="Email" name="email" type="email" autoComplete="email" value={form.email} onChange={onChange} error={f.email} required autoFocus />
        <TextField label="Username" name="username" autoComplete="username" value={form.username} onChange={onChange} error={f.username} hint="Letters, numbers, dot, dash, underscore" required />
        <TextField label="Password" name="password" type="password" autoComplete="new-password" value={form.password} onChange={onChange} error={f.password} hint="At least 8 characters" required />
        <TextField label="Confirm password" name="confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={onChange} error={f.confirm} required />
        <Button type="submit" loading={busy} className="w-full">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
