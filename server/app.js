import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config } from './config.js';
import { prisma } from './db.js';
import authRoutes from './routes/auth.routes.js';
import salesforceRoutes from './routes/salesforce.routes.js';
import cpqRoutes from './routes/cpq.routes.js';
import brandingRoutes from './routes/branding.routes.js';
import { errorHandler, notFoundApi } from './middleware/error.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');

export async function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      // Vite dev server injects inline scripts for HMR; enforce CSP only for built assets.
      contentSecurityPolicy: config.isDev ? false : undefined,
      hsts: config.cookieSecure,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Health check for App Runner / ECS / ALB target groups.
  app.get('/healthz', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/salesforce', salesforceRoutes);
  app.use('/api/cpq', cpqRoutes);
  app.use('/api/branding', brandingRoutes);
  app.use('/api', notFoundApi);

  if (config.isDev) {
    // Single-port dev: Vite runs as Express middleware with HMR.
    const { createServer } = await import('vite');
    const vite = await createServer({
      configFile: path.join(ROOT, 'vite.config.js'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
    // SPA fallback: any non-API GET serves index.html
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  } else {
    console.warn('[app] client/dist not found — run `npm run build` to serve the UI');
  }

  app.use(errorHandler);
  return app;
}
