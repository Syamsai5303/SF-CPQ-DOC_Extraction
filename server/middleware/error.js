import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';

export function notFoundApi(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    const fields = {};
    for (const issue of err.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
    return res.status(400).json({ error: 'Validation failed', fields });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      ...(err.code ? { code: err.code } : {}),
      ...(err.connectionId ? { connectionId: err.connectionId } : {}),
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
}
