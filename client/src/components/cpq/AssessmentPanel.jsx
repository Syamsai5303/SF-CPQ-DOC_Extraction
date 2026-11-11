import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../api.js';
import { Alert, Button, Spinner } from '../ui.jsx';
import { fmt } from './Overview.jsx';

function LogoControl() {
  const [info, setInfo] = useState(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);

  const refresh = useCallback(() => {
    api('/branding/logo/info').then(setInfo).catch(() => setInfo({ source: 'none' }));
    setVersion((v) => v + 1);
  }, []);
  useEffect(refresh, [refresh]);

  async function upload(file) {
    setError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return setError('Choose a PNG or JPEG image.');
    if (file.size > 2 * 1024 * 1024) return setError('Logo must be 2 MB or smaller.');
    setBusy(true);
    try {
      const res = await fetch('/api/branding/logo', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Upload failed');
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await api('/branding/logo', { method: 'DELETE' });
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex h-12 w-40 items-center justify-center rounded-lg border border-slate-200 bg-white p-1.5">
        {info?.source !== 'none' ? <img src={`/api/branding/logo?v=${version}`} alt="Document logo" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-slate-400">No logo</span>}
      </div>
      <div className="text-sm">
        <p className="font-medium text-slate-700">Document logo</p>
        <p className="text-xs text-slate-500">{info?.source === 'custom' ? 'Custom upload' : 'Company default'} · PNG/JPEG up to 2 MB</p>
        <div className="mt-1 flex gap-3">
          <input ref={input} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className="text-xs font-semibold text-brand-600 hover:underline">
            {busy ? 'Saving…' : 'Upload logo'}
          </button>
          {info?.source === 'custom' && (
            <button type="button" onClick={reset} disabled={busy} className="text-xs font-semibold text-slate-500 hover:underline">
              Reset to default
            </button>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}

export default function AssessmentPanel({ extractionId }) {
  const [status, setStatus] = useState(null);
  const [assessment, setAssessment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    api('/cpq/status').then(setStatus).catch(() => setStatus({ geminiConfigured: false }));
  }, []);

  // Latest assessment for this extraction.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAssessment(null);
    setError(null);
    api(`/cpq/assessments?extractionId=${extractionId}`)
      .then(async (d) => {
        const latest = d.assessments[0];
        if (latest && !cancelled) setAssessment((await api(`/cpq/assessments/${latest.id}`)).assessment);
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [extractionId]);

  // Poll while generating.
  const running = assessment && ['QUEUED', 'RUNNING'].includes(assessment.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        setAssessment((await api(`/cpq/assessments/${assessment.id}`)).assessment);
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [running, assessment?.id]);

  async function generate() {
    setStarting(true);
    setError(null);
    try {
      const d = await api('/cpq/generate-assessment', { method: 'POST', body: { extractionId } });
      setAssessment(d.assessment);
      setShowPreview(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  const done = assessment?.status === 'SUCCEEDED';
  const configured = status?.geminiConfigured;
  const outputChars = assessment?.progress?.outputChars ?? 0;

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-5">
        <div>
          <h2 className="text-base font-semibold">RCA migration assessment</h2>
          <p className="mt-0.5 max-w-xl text-sm text-slate-500">
            Gemini ({status?.geminiModel ?? 'gemini'}) analyses the extracted catalog and writes an executive report: overview, RCA mapping matrix, gap analysis and phased
            migration plan.
          </p>
        </div>
        <LogoControl />
      </div>

      <div className="space-y-4 p-5">
        {status && !configured && (
          <Alert type="info" title="AI assessment is not configured">
            Set <code className="font-mono">GEMINI_API_KEY</code> in the server environment (.env) and restart to enable report generation.
          </Alert>
        )}
        {error && <Alert type="error">{error}</Alert>}
        {assessment?.status === 'FAILED' && (
          <Alert type="error" title="Generation failed">
            {assessment.error}
          </Alert>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading…
          </div>
        ) : running ? (
          <div aria-live="polite">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <Spinner className="h-4 w-4 text-brand-600" />
              {assessment.progress?.stage === 'generating'
                ? outputChars
                  ? `Writing report with ${assessment.model}… ${fmt(outputChars)} characters`
                  : `Waiting for ${assessment.model}…`
                : assessment.progress?.stage === 'counting'
                  ? 'Preparing catalog digest…'
                  : 'Starting…'}
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full animate-pulse rounded-full bg-brand-500" style={{ width: `${Math.min(95, 10 + outputChars / 400)}%` }} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              This usually takes 30–90 seconds. If a model is retired or overloaded, the next available Gemini model is tried automatically. You can leave this page; generation continues on the
              server.
            </p>
          </div>
        ) : done ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <span className="font-semibold">Report ready</span>
              <span className="text-emerald-700">
                {new Date(assessment.finishedAt).toLocaleString()} · {assessment.model}
                {assessment.outputTokens ? ` · ${fmt(assessment.outputTokens)} output tokens` : ''}
              </span>
            </div>
            <div className="flex flex-wrap gap-3">
              <a href={`/api/cpq/assessments/${assessment.id}/document?format=docx`} download>
                <Button>Download Document (DOCX)</Button>
              </a>
              <a href={`/api/cpq/assessments/${assessment.id}/document?format=pdf`} download>
                <Button variant="secondary">Download PDF</Button>
              </a>
              <Button variant="ghost" onClick={() => setShowPreview((s) => !s)} aria-expanded={showPreview}>
                {showPreview ? 'Hide preview' : 'Preview report'}
              </Button>
              <Button variant="ghost" onClick={generate} loading={starting} disabled={!configured}>
                Regenerate
              </Button>
            </div>
            {showPreview && (
              <article className="prose prose-sm prose-slate max-h-[40rem] max-w-none overflow-y-auto rounded-lg border border-slate-200 p-6 prose-headings:text-slate-900 prose-h1:text-xl prose-h2:text-lg prose-table:text-xs prose-th:bg-slate-50">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{assessment.markdown ?? ''}</ReactMarkdown>
              </article>
            )}
          </div>
        ) : (
          <div>
            <Button onClick={generate} loading={starting} disabled={!configured}>
              Generate Assessment Document
            </Button>
            <p className="mt-2 text-xs text-slate-500">A summarised digest of this catalog (no credentials) is sent to Google Gemini.</p>
          </div>
        )}
      </div>
    </section>
  );
}
