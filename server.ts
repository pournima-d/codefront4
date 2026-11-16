import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDailyBackup, initDatabase } from './server/db.ts';
import { purgeExpiredRateLimits } from './server/rateLimit.ts';
import { registerApiRoutes } from './server/routes.ts';
import { seedIfEmpty } from './server/seed.ts';

dotenv.config();

export function createBatonApp(customDataDir?: string) {
  const { db, paths } = initDatabase(customDataDir);
  seedIfEmpty(db, paths);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Security headers compatible with AI Studio iframe embedding
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com;"
    );

    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store, private');
    }

    // Validate CORS strictly if an explicit cross-origin request arrives
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      const configuredUrl = process.env.APP_URL;
      const host = req.headers.host;
      const sameOriginHttp = host ? origin === `http://${host}` || origin === `https://${host}` : false;
      const configuredMatch = configuredUrl && configuredUrl !== 'MY_APP_URL' ? origin === configuredUrl.replace(/\/$/, '') : false;
      if (sameOriginHttp || configuredMatch) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, X-Baton-Session');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      } else if (req.method === 'OPTIONS') {
        res.status(403).json({ error: 'Cross-origin request blocked by CORS policy.' });
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  registerApiRoutes(app, db, paths);

  // Sanitized error handler: never return stack traces or internal DB details
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[BATON ERROR] ${req.method} ${req.path}:`, err);
    } else {
      console.error(`[BATON ERROR] ${req.method} ${req.path}`);
    }
    if (res.headersSent) return;
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON request body.' });
      return;
    }
    res.status(500).json({ error: 'Internal server error.' });
  });

  return { app, db, paths };
}

async function startServer() {
  const { app, db, paths } = createBatonApp();

  // Schedule daily backup copy + periodic rate-limit cleanup
  ensureDailyBackup(db, paths).catch((err) => {
    console.error('Daily DB backup check failed:', err);
  });
  const backupInterval = setInterval(() => {
    ensureDailyBackup(db, paths).catch(() => {});
    try {
      purgeExpiredRateLimits(db);
    } catch {
      // ignore cleanup error
    }
  }, 6 * 60 * 60 * 1000);
  backupInterval.unref();

  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve('dist', 'index.html'));

  if (isProd) {
    const distDir = path.resolve('dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`BATON server running on http://0.0.0.0:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().catch((err) => {
    console.error('Failed to start BATON server:', err);
    process.exit(1);
  });
}
