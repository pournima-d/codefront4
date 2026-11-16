import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import {
  EVIDENCE_STATES,
  type ApprovalState,
  type EvidenceState,
  type HandoverDoc,
  type ResearchRecord,
  type Role,
  type TeamMemberStatus,
  type VisibilityLevel,
} from '../src/types.ts';
import {
  attemptLogin,
  createAuthMiddleware,
  getClientIp,
  grantPasswordReauth,
  hashPassword,
  requireRole,
  requireSensitiveAuth,
  SESSION_COOKIE_NAME,
  type AuthedRequest,
} from './auth.ts';
import {
  canUserAccessNote,
  canUserAccessRecord,
  canUserAccessSource,
  checkMembershipAndRole,
  DEFAULT_PROJECT_ID,
  resolveAuthorizedProject,
  sanitizeFsPathWithinDir,
} from './authz.ts';
import { appendAudit, type DbPaths, verifyDatabaseIntegrity, writeFileAtomic } from './db.ts';
import {
  applyConfirmedRedactions,
  buildColdStartQuestions,
  createHandoverDraft,
  evaluateColdStartRun,
  maskSensitiveMatch,
  parseUploadedSource,
  reconstructFromSource,
  reconstructFromSources,
  runRadarScan,
  scanSensitiveContentForProject,
  verifyVerbatimInSpan,
} from './engine.ts';
import { checkRateLimit } from './rateLimit.ts';
import {
  ALLOWED_STAGES,
  isPlainObject,
  isValidEmail,
  isValidId,
  isValidRole,
  isValidVisibility,
  MAX_UPLOAD_BYTES,
  sanitizeFilename,
  sanitizeNoteHtml,
  validatePagination,
  validateStrictIsoDate,
  validateUploadedFileContent,
} from './validation.ts';

function isHttpsRequest(req: Request): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  if (req.secure || req.protocol === 'https') return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.startsWith('https://')) {
    return true;
  }
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.startsWith('https://')) {
    return true;
  }
  return false;
}

function setSessionCookie(req: Request, res: Response, sessionId: string): void {
  const isHttps = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    `Max-Age=${12 * 60 * 60}`,
    'HttpOnly',
  ];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = isHttpsRequest(req);
  const parts = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly'];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

function sendRateLimit429(res: Response, retryAfterSec: number, message: string): void {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({
    error: `${message} Retry in ${retryAfterSec}s.`,
    retryAfterSec,
  });
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function registerApiRoutes(app: express.Express, db: Database.Database, paths: DbPaths): void {
  const sseClients = new Set<Response>();

  const broadcastPresence = () => {
    const payload = JSON.stringify({ type: 'presence_update', ts: Date.now() });
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  // Unauthenticated Health Endpoint (verifies DB connectivity & integrity without exposing internals)
  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      const okPing = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      const integrity = verifyDatabaseIntegrity(db);
      if (okPing?.ok === 1 && integrity) {
        res.json({ ok: true, service: 'baton', database: 'ok' });
        return;
      }
      res.status(503).json({ ok: false, service: 'baton', database: 'degraded' });
    } catch {
      res.status(503).json({ ok: false, service: 'baton', database: 'unavailable' });
    }
  });

  // Unauthenticated Login (Email + Password)
  app.post('/api/auth/login', (req: Request, res: Response) => {
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    const { email, password } = req.body as { email?: unknown; password?: unknown };
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password ||
      email.trim().length > 254 ||
      password.length > 512
    ) {
      res.status(400).json({ error: 'Valid email and password are required.' });
      return;
    }

    const clientIp = getClientIp(req);
    const normalizedEmail = email.trim().toLowerCase();

    const perAcctRl = checkRateLimit(db, `login:acct:${clientIp}:${normalizedEmail}`, 12, 5 * 60 * 1000);
    if (!perAcctRl.allowed) {
      sendRateLimit429(res, perAcctRl.retryAfterSec, 'Too many login attempts for this account.');
      return;
    }

    const perIpRl = checkRateLimit(db, `login:ip:${clientIp}`, 120, 15 * 60 * 1000);
    if (!perIpRl.allowed) {
      sendRateLimit429(res, perIpRl.retryAfterSec, 'Too many authentication requests from this client.');
      return;
    }

    const existingSid =
      typeof req.cookies?.[SESSION_COOKIE_NAME] === 'string'
        ? req.cookies[SESSION_COOKIE_NAME]
        : typeof req.headers['x-baton-session'] === 'string'
          ? req.headers['x-baton-session']
          : null;

    const result = attemptLogin(db, normalizedEmail, password, clientIp, existingSid);
    if (!result.ok || !result.sessionId || !result.user || !result.csrfToken) {
      res.status(result.status).json({ error: result.error || 'Authentication failed.' });
      return;
    }

    setSessionCookie(req, res, result.sessionId);
    broadcastPresence();

    res.json({
      user: result.user,
      csrfToken: result.csrfToken,
      sessionToken: result.sessionId,
      cameraVerified: false,
      hasSensitiveAuth: false,
    });
  });

  // Disabled / Blocked Camera Login Endpoint (prevents biometric/client boolean forgery)
  app.post('/api/auth/camera-login', (req: Request, res: Response) => {
    const emailRaw = isPlainObject(req.body) && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : 'unknown';
    appendAudit(db, {
      actorEmail: emailRaw.slice(0, 120) || 'unknown',
      actorRole: 'ANONYMOUS',
      action: 'CAMERA_LOGIN_REJECTED',
      targetType: 'AUTH',
      targetId: emailRaw.slice(0, 120) || 'unknown',
      detail: { reason: 'Camera presence is local-only and cannot authenticate sessions' },
      ip: getClientIp(req),
    });
    res.status(403).json({
      error: 'Camera presence is an optional local-only preview and cannot authenticate sessions. Sign in with email and password.',
    });
  });

  // Unauthenticated User Registration (ALWAYS assigns RESEARCHER role; ignores privileged role escalation)
  app.post('/api/auth/register', (req: Request, res: Response) => {
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const clientIp = getClientIp(req);
    const rl = checkRateLimit(db, `register:ip:${clientIp}`, 20, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Too many registration requests.');
      return;
    }

    const body = req.body as {
      name?: unknown;
      email?: unknown;
      password?: unknown;
      title?: unknown;
      role?: unknown;
    };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const title =
      typeof body.title === 'string' && body.title.trim()
        ? body.title.trim().slice(0, 100)
        : 'Workspace Collaborator';

    if (!name || name.length < 2 || name.length > 100) {
      res.status(400).json({ error: 'Name must be between 2 and 100 characters.' });
      return;
    }
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'A valid email address is required.' });
      return;
    }
    if (password.length < 6 || password.length > 200) {
      res.status(400).json({ error: 'Password must be between 6 and 200 characters.' });
      return;
    }

    // Security rule: public registration ALWAYS creates RESEARCHER; client role escalation is ignored and logged.
    const assignedRole: Role = 'RESEARCHER';
    const requestedRole = typeof body.role === 'string' ? body.role.trim().toUpperCase() : undefined;
    if (requestedRole && requestedRole !== 'RESEARCHER') {
      appendAudit(db, {
        actorEmail: email,
        actorRole: 'ANONYMOUS',
        action: 'PRIVILEGED_REGISTRATION_ATTEMPTED',
        targetType: 'AUTH',
        targetId: email,
        detail: { requestedRole, enforcedRole: assignedRole },
        ip: clientIp,
      });
    }

    const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email) as { id: string } | undefined;
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const userId = `U-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const passHash = hashPassword(password);
    const nowIso = new Date().toISOString();

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, email, name, role, password_hash, failed_attempts, locked_until, title, departing, created_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, 0, ?)`
      ).run(userId, email, name, assignedRole, passHash, title, nowIso);

      const defaultProj = db.prepare('SELECT id FROM projects WHERE id = ?').get(DEFAULT_PROJECT_ID) as
        | { id: string }
        | undefined;
      if (defaultProj) {
        db.prepare(
          `INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by, created_at)
           VALUES (?, ?, ?, 'system:register', ?)`
        ).run(defaultProj.id, userId, assignedRole, nowIso);
      }
    });
    tx();

    appendAudit(db, {
      actorUserId: userId,
      actorEmail: email,
      actorRole: assignedRole,
      action: 'USER_REGISTERED',
      targetType: 'USER',
      targetId: userId,
      projectId: DEFAULT_PROJECT_ID,
      detail: { name, role: assignedRole, title },
      ip: clientIp,
    });

    const loginRes = attemptLogin(db, email, password, clientIp);
    if (!loginRes.ok || !loginRes.sessionId || !loginRes.user || !loginRes.csrfToken) {
      res.status(500).json({ error: 'Account created, but automatic sign-in failed.' });
      return;
    }

    setSessionCookie(req, res, loginRes.sessionId);
    broadcastPresence();

    res.status(201).json({
      user: loginRes.user,
      csrfToken: loginRes.csrfToken,
      sessionToken: loginRes.sessionId,
      cameraVerified: false,
      hasSensitiveAuth: false,
    });
  });

  // Protected API middleware
  const authMw = createAuthMiddleware(db);
  app.use('/api', (req, res, next) => {
    if (
      req.path === '/auth/login' ||
      req.path === '/auth/register' ||
      req.path === '/auth/camera-login' ||
      req.path === '/health'
    ) {
      next();
      return;
    }
    authMw(req as AuthedRequest, res, next);
  });

  app.get('/api/auth/me', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    res.json({
      user: auth.user,
      csrfToken: auth.csrfToken,
      sessionToken: auth.sessionId,
      cameraVerified: auth.cameraVerified,
      hasSensitiveAuth: auth.hasSensitiveAuth,
    });
  });

  // Optional local-only presence camera check (strictly informational, NEVER grants sensitive auth)
  app.post('/api/auth/camera-check', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    const skipped = Boolean(isPlainObject(req.body) && req.body.skipped);
    if (skipped) {
      appendAudit(db, {
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'CAMERA_CHECK_SKIPPED',
        targetType: 'SESSION',
        targetId: auth.sessionId.slice(0, 12),
        ip: getClientIp(req),
      });
      res.json({ cameraVerified: auth.cameraVerified, hasSensitiveAuth: auth.hasSensitiveAuth });
      return;
    }

    db.prepare('UPDATE sessions SET camera_verified = 1 WHERE id = ?').run(auth.sessionId);
    appendAudit(db, {
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      actorRole: auth.user.role,
      action: 'CAMERA_CHECK_COMPLETED',
      targetType: 'SESSION',
      targetId: auth.sessionId.slice(0, 12),
      detail: { mode: 'local-presence-preview-only', mediaStored: false, sensitiveAuthGranted: false },
      ip: getClientIp(req),
    });
    res.json({ cameraVerified: true, hasSensitiveAuth: auth.hasSensitiveAuth });
  });

  app.post('/api/auth/reauth', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    const clientIp = getClientIp(req);
    const rl = checkRateLimit(db, `reauth:${auth.user.id}:${clientIp}`, 10, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Too many password re-authentication attempts.');
      return;
    }

    const password = isPlainObject(req.body) && typeof req.body.password === 'string' ? req.body.password : '';
    if (!password || password.length > 512) {
      res.status(400).json({ error: 'Password is required for re-authentication.' });
      return;
    }

    const reauthRes = grantPasswordReauth(db, auth, password, clientIp);
    if (!reauthRes.ok || !reauthRes.sessionId || !reauthRes.csrfToken) {
      res.status(401).json({ error: 'Password verification failed.' });
      return;
    }

    setSessionCookie(req, res, reauthRes.sessionId);
    res.json({
      hasSensitiveAuth: true,
      csrfToken: reauthRes.csrfToken,
      sessionToken: reauthRes.sessionId,
    });
  });

  app.post('/api/auth/logout', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    db.prepare('DELETE FROM sessions WHERE id = ?').run(auth.sessionId);
    db.prepare('UPDATE presence SET last_seen_at = ? WHERE user_id = ?').run(
      Date.now() - 10 * 60 * 1000,
      auth.user.id
    );
    appendAudit(db, {
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      actorRole: auth.user.role,
      action: 'LOGOUT',
      targetType: 'SESSION',
      targetId: auth.sessionId.slice(0, 12),
      ip: getClientIp(req),
    });
    clearSessionCookie(req, res);
    broadcastPresence();
    res.json({ ok: true });
  });

  // Presence heartbeat & SSE
  app.post('/api/presence/heartbeat', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    const route = isPlainObject(req.body) && typeof req.body.route === 'string' ? req.body.route.slice(0, 120) : '#/overview';
    const recordId =
      isPlainObject(req.body) && typeof req.body.recordId === 'string' && isValidId(req.body.recordId)
        ? req.body.recordId
        : null;
    const now = Date.now();
    db.prepare(
      `INSERT INTO presence (user_id, current_route, current_record_id, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         current_route = excluded.current_route,
         current_record_id = excluded.current_record_id,
         last_seen_at = excluded.last_seen_at`
    ).run(auth.user.id, route, recordId, now);
    broadcastPresence();
    res.json({ ok: true, ts: now });
  });

  app.get('/api/presence/stream', (req: AuthedRequest, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
    sseClients.add(res);

    const timer = setInterval(() => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`);
      } catch {
        clearInterval(timer);
        sseClients.delete(res);
      }
    }, 15000);
    timer.unref();

    req.on('close', () => {
      clearInterval(timer);
      sseClients.delete(res);
    });
  });

  // Draft Autosave
  app.get('/api/drafts/:key', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    const key = String(req.params.key).slice(0, 120);
    const id = `${auth.user.id}:${key}`;
    const row = db.prepare('SELECT content_json, updated_at FROM drafts WHERE id = ?').get(id) as
      | { content_json: string; updated_at: string }
      | undefined;
    if (!row) {
      res.json({ content: null, updatedAt: null });
      return;
    }
    res.json({ content: parseJsonSafe(row.content_json, {}), updatedAt: row.updated_at });
  });

  app.put('/api/drafts/:key', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    const key = String(req.params.key).slice(0, 120);
    const id = `${auth.user.id}:${key}`;
    const nowIso = new Date().toISOString();
    const contentPayload = isPlainObject(req.body) ? req.body.content ?? {} : {};
    db.prepare(
      `INSERT INTO drafts (id, user_id, draft_key, content_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content_json = excluded.content_json, updated_at = excluded.updated_at`
    ).run(id, auth.user.id, key, JSON.stringify(contentPayload).slice(0, 100_000), nowIso);
    res.json({ ok: true, updatedAt: nowIso });
  });

  app.delete('/api/drafts/:key', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    const key = String(req.params.key).slice(0, 120);
    db.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').run(`${auth.user.id}:${key}`, auth.user.id);
    res.json({ ok: true });
  });

  // Projects (membership-scoped)
  app.get('/api/projects', (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare(
        `SELECT p.id, p.slug, p.name, p.description, p.stage_current, p.sensitive_patterns_json, p.created_at, pm.role AS member_role
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = ?
         ORDER BY p.created_at ASC`
      )
      .all(req.auth!.user.id) as Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      stage_current: string;
      sensitive_patterns_json: string;
      created_at: string;
      member_role: Role;
    }>;

    res.json({
      projects: rows.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,
        stage_current: p.stage_current,
        member_role: p.member_role,
        sensitive_patterns: parseJsonSafe<string[]>(p.sensitive_patterns_json, []),
        created_at: p.created_at,
      })),
    });
  });

  app.post(
    '/api/projects',
    requireRole(db, ['PI_LEAD', 'RESEARCHER']),
    (req: AuthedRequest, res: Response) => {
      if (!isPlainObject(req.body)) {
        res.status(400).json({ error: 'Invalid request body.' });
        return;
      }
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
      if (name.length < 2 || name.length > 120 || description.length < 2 || description.length > 1000) {
        res.status(400).json({ error: 'Project name (2-120 chars) and scope description (2-1000 chars) are required.' });
        return;
      }
      const id = `PRJ-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const baseSlug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'continuity-project';
      const slug = `${baseSlug}-${id.slice(-4).toLowerCase()}`;
      const nowIso = new Date().toISOString();

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO projects (id, slug, name, description, stage_current, sensitive_patterns_json, created_at)
           VALUES (?, ?, ?, ?, '01', '[]', ?)`
        ).run(id, slug, name, description, nowIso);

        db.prepare(
          `INSERT INTO project_members (project_id, user_id, role, added_by, created_at)
           VALUES (?, ?, 'PI_LEAD', ?, ?)`
        ).run(id, req.auth!.user.id, req.auth!.user.email, nowIso);
      });
      tx();

      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: req.auth!.user.role,
        action: 'PROJECT_CREATED',
        targetType: 'PROJECT',
        targetId: id,
        projectId: id,
        detail: { name, slug },
        ip: getClientIp(req),
      });

      const project = db.prepare('SELECT id, slug, name, description, stage_current, created_at FROM projects WHERE id = ?').get(id);
      res.status(201).json({ project: { ...(project as object), member_role: 'PI_LEAD', sensitive_patterns: [] } });
    }
  );

  // Project Members Management (PI_LEAD on project)
  app.get('/api/projects/:id/members', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, undefined, req.params.id);
    if (!ctx) return;

    const members = db
      .prepare(
        `SELECT pm.project_id, pm.user_id, pm.role, pm.added_by, pm.created_at,
                u.name, u.email, u.title, u.departing
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ?
         ORDER BY u.created_at ASC`
      )
      .all(ctx.projectId) as Array<{
      project_id: string;
      user_id: string;
      role: Role;
      added_by: string | null;
      created_at: string;
      name: string;
      email: string;
      title: string;
      departing: number;
    }>;

    res.json({
      members: members.map((m) => ({
        ...m,
        departing: m.departing === 1,
      })),
    });
  });

  app.post('/api/projects/:id/members', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD'], req.params.id);
    if (!ctx) return;
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const userIdParam = typeof req.body.userId === 'string' ? req.body.userId.trim() : '';
    const roleRaw = req.body.role;
    if (!isValidRole(roleRaw)) {
      res.status(400).json({ error: 'Valid role is required.' });
      return;
    }

    const userRow = userIdParam
      ? (db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(userIdParam) as
          | { id: string; email: string; name: string; role: Role }
          | undefined)
      : email
        ? (db.prepare('SELECT id, email, name, role FROM users WHERE lower(email) = ?').get(email) as
            | { id: string; email: string; name: string; role: Role }
            | undefined)
        : undefined;

    if (!userRow) {
      res.status(404).json({ error: 'Target user account not found.' });
      return;
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, added_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
    ).run(ctx.projectId, userRow.id, roleRaw, req.auth!.user.email, nowIso);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'PROJECT_MEMBER_ADDED',
      targetType: 'PROJECT_MEMBER',
      targetId: `${ctx.projectId}:${userRow.id}`,
      projectId: ctx.projectId,
      detail: { targetEmail: userRow.email, role: roleRaw },
      ip: getClientIp(req),
    });

    res.status(201).json({ ok: true, projectId: ctx.projectId, userId: userRow.id, role: roleRaw });
  });

  app.patch('/api/projects/:id/members/:userId', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD'], req.params.id);
    if (!ctx) return;
    if (!isValidId(req.params.userId)) {
      res.status(400).json({ error: 'Invalid user ID.' });
      return;
    }
    if (!isPlainObject(req.body) || !isValidRole(req.body.role)) {
      res.status(400).json({ error: 'Valid role is required.' });
      return;
    }
    const nextRole = req.body.role;

    const existing = db
      .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(ctx.projectId, req.params.userId) as { role: Role } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'User is not a member of this project.' });
      return;
    }

    if (existing.role === 'PI_LEAD' && nextRole !== 'PI_LEAD') {
      const piCount = (
        db
          .prepare("SELECT COUNT(*) AS cnt FROM project_members WHERE project_id = ? AND role = 'PI_LEAD'")
          .get(ctx.projectId) as { cnt: number }
      ).cnt;
      if (piCount <= 1) {
        res.status(400).json({ error: 'Cannot demote the last PI Lead of this project.' });
        return;
      }
    }

    const tx = db.transaction(() => {
      db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(
        nextRole,
        ctx.projectId,
        req.params.userId
      );
      if (ctx.projectId === DEFAULT_PROJECT_ID) {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextRole, req.params.userId);
      }
      // Security: invalidate active sessions of the user whose role changed so privilege elevation/demotion requires fresh session state
      if (req.params.userId !== req.auth!.user.id) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.userId);
      }
    });
    tx();

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'PROJECT_ROLE_CHANGED',
      targetType: 'PROJECT_MEMBER',
      targetId: `${ctx.projectId}:${req.params.userId}`,
      projectId: ctx.projectId,
      detail: { previousRole: existing.role, nextRole },
      ip: getClientIp(req),
    });

    res.json({ ok: true, userId: req.params.userId, role: nextRole });
  });

  app.delete('/api/projects/:id/members/:userId', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD'], req.params.id);
    if (!ctx) return;
    if (!isValidId(req.params.userId)) {
      res.status(400).json({ error: 'Invalid user ID.' });
      return;
    }

    const existing = db
      .prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(ctx.projectId, req.params.userId) as { role: Role } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Member not found in this project.' });
      return;
    }
    if (existing.role === 'PI_LEAD') {
      const piCount = (
        db
          .prepare("SELECT COUNT(*) AS cnt FROM project_members WHERE project_id = ? AND role = 'PI_LEAD'")
          .get(ctx.projectId) as { cnt: number }
      ).cnt;
      if (piCount <= 1) {
        res.status(400).json({ error: 'Cannot remove the last PI Lead from the project.' });
        return;
      }
    }

    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(
      ctx.projectId,
      req.params.userId
    );
    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'PROJECT_MEMBER_REMOVED',
      targetType: 'PROJECT_MEMBER',
      targetId: `${ctx.projectId}:${req.params.userId}`,
      projectId: ctx.projectId,
      detail: { previousRole: existing.role },
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  });

  app.patch('/api/projects/:id/settings', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD'], req.params.id);
    if (!ctx) return;
    if (!isPlainObject(req.body) || !Array.isArray(req.body.sensitive_patterns)) {
      res.status(400).json({ error: 'sensitive_patterns array is required.' });
      return;
    }

    const patterns = Array.from(
      new Set(
        req.body.sensitive_patterns
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length >= 3 && s.length <= 80)
      )
    ).slice(0, 30);

    db.prepare('UPDATE projects SET sensitive_patterns_json = ? WHERE id = ?').run(
      JSON.stringify(patterns),
      ctx.projectId
    );

    const newProposals = scanSensitiveContentForProject(db, ctx.projectId, {
      actor: { ...req.auth!.user, role: ctx.memberRole },
      includeRestricted: true,
    });

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'PROJECT_SETTINGS_UPDATED',
      targetType: 'PROJECT',
      targetId: ctx.projectId,
      projectId: ctx.projectId,
      detail: { patternCount: patterns.length, newRedactionProposals: newProposals },
      ip: getClientIp(req),
    });

    res.json({ ok: true, sensitive_patterns: patterns, newRedactionProposals: newProposals });
  });

  app.delete('/api/projects/:id', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD'], req.params.id);
    if (!ctx) return;

    const rl = checkRateLimit(db, `sensitive:${req.auth!.user.id}:${getClientIp(req)}`, 40, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Rate limit exceeded for sensitive project actions.');
      return;
    }

    const project = db.prepare('SELECT id, name, slug FROM projects WHERE id = ?').get(ctx.projectId) as
      | { id: string; name: string; slug: string }
      | undefined;
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM projects').get() as { cnt: number };
    if (countRow.cnt <= 1) {
      res.status(400).json({ error: 'Cannot delete the last remaining workspace project.' });
      return;
    }

    const sourceFiles = db
      .prepare('SELECT storage_path FROM sources WHERE project_id = ?')
      .all(project.id) as Array<{ storage_path: string }>;

    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    for (const f of sourceFiles) {
      try {
        const safePath = f.storage_path ? sanitizeFsPathWithinDir(f.storage_path, paths.uploadsDir) : null;
        if (safePath && fs.existsSync(safePath)) {
          fs.unlinkSync(safePath);
        }
      } catch {
        // ignore disk cleanup error
      }
    }

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'PROJECT_DELETED',
      targetType: 'PROJECT',
      targetId: project.id,
      detail: { name: project.name, slug: project.slug },
      ip: getClientIp(req),
    });

    const nextProj = db
      .prepare(
        `SELECT p.id FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = ? ORDER BY p.created_at ASC LIMIT 1`
      )
      .get(req.auth!.user.id) as { id: string } | undefined;
    res.json({ ok: true, deletedId: project.id, fallbackProjectId: nextProj?.id || DEFAULT_PROJECT_ID });
  });

  app.post('/api/projects/:id/reset', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD'], req.params.id);
    if (!ctx) return;

    const rl = checkRateLimit(db, `sensitive:${req.auth!.user.id}:${getClientIp(req)}`, 40, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Rate limit exceeded for sensitive project actions.');
      return;
    }

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(ctx.projectId) as
      | { id: string; name: string }
      | undefined;
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const sourceFiles = db
      .prepare('SELECT storage_path FROM sources WHERE project_id = ?')
      .all(project.id) as Array<{ storage_path: string }>;

    const recordIds = (
      db.prepare('SELECT id FROM records WHERE project_id = ?').all(project.id) as Array<{ id: string }>
    ).map((r) => r.id);

    const tx = db.transaction(() => {
      for (const rid of recordIds) {
        db.prepare('DELETE FROM drafts WHERE draft_key = ?').run(`record:${rid}`);
      }
      db.prepare('DELETE FROM redaction_proposals WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM radar_findings WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM handovers WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM records WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM sources WHERE project_id = ?').run(project.id);
      db.prepare('DELETE FROM notes WHERE project_id = ?').run(project.id);
      db.prepare("UPDATE projects SET stage_current = '01' WHERE id = ?").run(project.id);
    });
    tx();

    for (const f of sourceFiles) {
      try {
        const safePath = f.storage_path ? sanitizeFsPathWithinDir(f.storage_path, paths.uploadsDir) : null;
        if (safePath && fs.existsSync(safePath)) {
          fs.unlinkSync(safePath);
        }
      } catch {
        // ignore disk cleanup error
      }
    }

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'PROJECT_RESET',
      targetType: 'PROJECT',
      targetId: project.id,
      projectId: project.id,
      detail: { clearedRecords: recordIds.length, clearedFiles: sourceFiles.length },
      ip: getClientIp(req),
    });

    res.json({ ok: true, clearedRecords: recordIds.length, clearedFiles: sourceFiles.length });
  });

  // Overview
  app.get('/api/overview', (req: AuthedRequest, res: Response) => {
    const auth = req.auth!;
    const ctx = resolveAuthorizedProject(db, req, res, [
      'PI_LEAD',
      'RESEARCHER',
      'REVIEWER',
      'INCOMING_MEMBER',
      'AUDITOR',
    ]);
    if (!ctx) return;
    const isPi = ctx.memberRole === 'PI_LEAD';
    const projectId = ctx.projectId;

    const project = db
      .prepare('SELECT id, slug, name, description, stage_current, sensitive_patterns_json, created_at FROM projects WHERE id = ?')
      .get(projectId) as {
      id: string;
      slug: string;
      name: string;
      description: string;
      stage_current: string;
      sensitive_patterns_json: string;
      created_at: string;
    };

    const projects = db
      .prepare(
        `SELECT p.id, p.slug, p.name, p.description, p.stage_current, p.created_at, pm.role AS member_role
         FROM projects p JOIN project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = ? ORDER BY p.created_at ASC`
      )
      .all(auth.user.id);

    const visFilter = isPi
      ? "AND (visibility_level != 'PRIVATE_OWNER' OR owner_user_id = ?)"
      : "AND visibility_level = 'PROJECT_SHARED'";
    const records = (
      isPi
        ? db.prepare(`SELECT * FROM records WHERE project_id = ? ${visFilter}`).all(projectId, auth.user.id)
        : db.prepare(`SELECT * FROM records WHERE project_id = ? ${visFilter}`).all(projectId)
    ) as ResearchRecord[];

    const srcVisFilter = isPi
      ? "AND (visibility_level != 'PRIVATE_OWNER' OR uploaded_by_id = ? OR uploaded_by = ?)"
      : "AND (visibility_level = 'PROJECT_SHARED' OR (visibility_level = 'PRIVATE_OWNER' AND (uploaded_by_id = ? OR uploaded_by = ?)))";
    const sourcesCount = (
      db
        .prepare(`SELECT COUNT(*) AS cnt FROM sources WHERE project_id = ? ${srcVisFilter}`)
        .get(projectId, auth.user.id, auth.user.email) as { cnt: number }
    ).cnt;

    const notesCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM notes
           WHERE project_id = ? AND (visibility_level = 'PROJECT_SHARED' OR (visibility_level = 'PRIVATE_OWNER' AND author_id = ?))`
        )
        .get(projectId, auth.user.id) as { cnt: number }
    ).cnt;

    const stageCounts: Record<string, number> = { '01': 0, '02': 0, '03': 0, '04': 0, '05': 0 };
    const evidenceCounts: Record<string, number> = {};
    for (const r of records) {
      stageCounts[r.stage] = (stageCounts[r.stage] || 0) + 1;
      evidenceCounts[r.evidence_state] = (evidenceCounts[r.evidence_state] || 0) + 1;
    }

    const publishedHandover = db
      .prepare(
        `SELECT id, version, title, status, published_at, extractor_mode
         FROM handovers WHERE project_id = ? AND status = 'PUBLISHED' ORDER BY version DESC LIMIT 1`
      )
      .get(projectId);

    const highDebtCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM radar_findings rf
           JOIN records r ON r.id = rf.record_id
           WHERE rf.project_id = ? AND rf.band = 'HIGH' AND rf.resolved = 0 AND rf.inactive = 0
             ${isPi ? "AND r.visibility_level != 'PRIVATE_OWNER'" : "AND r.visibility_level = 'PROJECT_SHARED'"}`
        )
        .get(projectId) as { cnt: number }
    ).cnt;

    const pendingRedactions = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM redaction_proposals rp
           LEFT JOIN sources s ON rp.target_type = 'SOURCE' AND s.id = rp.target_id
           LEFT JOIN records r ON rp.target_type = 'RECORD' AND r.id = rp.target_id
           WHERE rp.project_id = ? AND rp.status = 'PROPOSED'
             AND (s.id IS NULL OR s.visibility_level != 'PRIVATE_OWNER')
             AND (r.id IS NULL OR r.visibility_level != 'PRIVATE_OWNER')
             ${isPi ? '' : "AND (s.id IS NULL OR s.visibility_level != 'RESTRICTED_PI_ONLY') AND (r.id IS NULL OR r.visibility_level != 'RESTRICTED_PI_ONLY')"}`
        )
        .get(projectId) as { cnt: number }
    ).cnt;

    const openLoopsCount = records.filter(
      (r) =>
        ['GAP', 'RISK', 'TASK', 'DEPENDENCY', 'RECURRING_PROBLEM'].includes(r.type) &&
        r.approval_state !== 'REJECTED' &&
        (r.evidence_state !== 'SUPPORTED' || r.approval_state !== 'APPROVED')
    ).length;

    const recentActivity = db
      .prepare(
        `SELECT id, timestamp, actor_email, actor_role, action, target_type, target_id
         FROM audit_logs
         WHERE (project_id = ? OR project_id IS NULL)
           AND action NOT IN ('LOGIN_FAILED','LOGIN_LOCKED','ACCOUNT_LOCKED_OUT','REAUTH_FAILED','REDACTION_ORIGINAL_REVEALED','ACCESS_DENIED','CSRF_REJECTED')
         ORDER BY id DESC LIMIT 8`
      )
      .all(projectId);

    const teamMembers = db
      .prepare(
        `SELECT u.id, u.name, u.email, pm.role, u.title, u.departing
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ?
         ORDER BY u.created_at ASC`
      )
      .all(projectId);

    res.json({
      project: {
        ...project,
        member_role: ctx.memberRole,
        sensitive_patterns: parseJsonSafe<string[]>(project.sensitive_patterns_json, []),
      },
      projects,
      metrics: {
        sourcesCount,
        notesCount,
        recordsCount: records.length,
        supportedCount: records.filter((r) => r.evidence_state === 'SUPPORTED').length,
        approvedCount: records.filter((r) => r.approval_state === 'APPROVED').length,
        needsReviewCount: records.filter(
          (r) => r.approval_state === 'NEEDS_REVIEW' || r.approval_state === 'NEEDS_REVISION'
        ).length,
        openLoopsCount,
        highDebtCount,
        pendingRedactions: ctx.memberRole === 'PI_LEAD' || ctx.memberRole === 'RESEARCHER' ? pendingRedactions : 0,
      },
      stageCounts,
      evidenceCounts,
      publishedHandover: publishedHandover || null,
      recentActivity,
      teamMembers,
    });
  });

  // Sources & Spans
  app.get('/api/sources', (req: AuthedRequest, res: Response) => {
    const user = req.auth!.user;
    const ctx = resolveAuthorizedProject(db, req, res);
    if (!ctx) return;

    const isPi = ctx.memberRole === 'PI_LEAD';
    const visClause = isPi
      ? "AND (s.visibility_level IN ('PROJECT_SHARED','RESTRICTED_PI_ONLY') OR (s.visibility_level = 'PRIVATE_OWNER' AND (s.uploaded_by_id = ? OR s.uploaded_by = ?)))"
      : "AND (s.visibility_level = 'PROJECT_SHARED' OR (s.visibility_level = 'PRIVATE_OWNER' AND (s.uploaded_by_id = ? OR s.uploaded_by = ?)))";

    const rows = db
      .prepare(
        `SELECT s.id, s.project_id, s.title, s.filename, s.file_type, s.file_size, s.sha256,
                s.visibility_level, s.exclude_from_ai, s.status, s.uploaded_by, s.uploaded_by_id, s.created_at,
                (SELECT COUNT(*) FROM source_spans sp WHERE sp.source_id = s.id) AS span_count
         FROM sources s
         WHERE s.project_id = ? ${visClause}
         ORDER BY s.created_at DESC`
      )
      .all(ctx.projectId, user.id, user.email);
    res.json({ sources: rows });
  });

  app.get('/api/sources/:id/spans', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid source ID.' });
      return;
    }
    const source = db
      .prepare('SELECT id, project_id, title, visibility_level, status, uploaded_by, uploaded_by_id FROM sources WHERE id = ?')
      .get(req.params.id) as
      | {
          id: string;
          project_id: string;
          title: string;
          visibility_level: string;
          status: string;
          uploaded_by: string;
          uploaded_by_id: string;
        }
      | undefined;
    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, source.project_id, req.auth!.user);
    if (!ctx) return;

    if (!canUserAccessSource(source, req.auth!.user, ctx.memberRole)) {
      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'ACCESS_DENIED',
        targetType: 'SOURCE',
        targetId: source.id,
        projectId: source.project_id,
        detail: { reason: `${source.visibility_level} source requested by unauthorized user` },
        ip: getClientIp(req),
      });
      res.status(403).json({
        error:
          source.visibility_level === 'PRIVATE_OWNER'
            ? 'This is a private file accessible only to its authenticated owner.'
            : 'Restricted PI-only source.',
      });
      return;
    }
    const spans = db
      .prepare('SELECT id, source_id, locator, content, line_start, line_end FROM source_spans WHERE source_id = ? ORDER BY rowid ASC')
      .all(source.id);
    res.json({ source, spans });
  });

  app.get('/api/sources/:id/download', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid source ID.' });
      return;
    }
    const source = db
      .prepare('SELECT id, project_id, filename, file_type, storage_path, visibility_level, uploaded_by, uploaded_by_id FROM sources WHERE id = ?')
      .get(req.params.id) as
      | {
          id: string;
          project_id: string;
          filename: string;
          file_type: string;
          storage_path: string;
          visibility_level: string;
          uploaded_by: string;
          uploaded_by_id: string;
        }
      | undefined;
    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, source.project_id, req.auth!.user);
    if (!ctx) return;

    if (!canUserAccessSource(source, req.auth!.user, ctx.memberRole)) {
      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'ACCESS_DENIED',
        targetType: 'SOURCE',
        targetId: source.id,
        projectId: source.project_id,
        detail: { reason: `Download denied for ${source.visibility_level}` },
        ip: getClientIp(req),
      });
      res.status(403).json({ error: 'You do not have permission to download this private file.' });
      return;
    }

    const safeStoragePath = sanitizeFsPathWithinDir(source.storage_path, paths.uploadsDir);
    if (!safeStoragePath || !fs.existsSync(safeStoragePath)) {
      res.status(404).json({ error: 'Stored source file missing on disk.' });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(source.filename)}"`);
    res.setHeader('Content-Type', source.file_type || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(safeStoragePath);
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });

  app.post('/api/sources/upload', (req: AuthedRequest, res: Response) => {
    const rl = checkRateLimit(db, `upload:${req.auth!.user.id}:${getClientIp(req)}`, 60, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Too many upload requests.');
      return;
    }

    upload.single('file')(req, res, async (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'File exceeds the 2 MB maximum upload size.' });
          return;
        }
        res.status(400).json({ error: 'Upload failed.' });
        return;
      }

      const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER', 'INCOMING_MEMBER']);
      if (!ctx) return;

      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file attached.' });
        return;
      }

      const validation = validateUploadedFileContent(file.originalname, file.mimetype, file.buffer);
      if (validation.ok === false) {
        res.status(validation.status).json({ error: validation.error });
        return;
      }
      const ext = validation.ext;

      const projectId = ctx.projectId;
      const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const duplicate = db
        .prepare('SELECT id, title FROM sources WHERE project_id = ? AND sha256 = ?')
        .get(projectId, sha256) as { id: string; title: string } | undefined;

      if (duplicate) {
        res.status(409).json({
          error: `Duplicate upload: identical SHA-256 already exists as "${duplicate.title}" (${duplicate.id}).`,
        });
        return;
      }

      const rawVis = req.body?.visibility_level;
      if (rawVis !== undefined && rawVis !== '' && !isValidVisibility(rawVis)) {
        res.status(400).json({ error: 'Invalid visibility_level.' });
        return;
      }
      const requestedVis: VisibilityLevel = isValidVisibility(rawVis) ? rawVis : 'PROJECT_SHARED';
      if (requestedVis === 'RESTRICTED_PI_ONLY' && ctx.memberRole !== 'PI_LEAD') {
        res.status(403).json({ error: 'Only a PI Lead can upload RESTRICTED_PI_ONLY files.' });
        return;
      }

      const excludeFromAi =
        requestedVis === 'PRIVATE_OWNER' ||
        requestedVis === 'RESTRICTED_PI_ONLY' ||
        req.body?.exclude_from_ai === 'true' ||
        req.body?.exclude_from_ai === '1'
          ? 1
          : 0;
      const safeOrigName = sanitizeFilename(file.originalname);
      const customTitle =
        typeof req.body?.title === 'string' && req.body.title.trim()
          ? req.body.title.trim().slice(0, 140)
          : path.basename(safeOrigName, ext);

      let parsed: Awaited<ReturnType<typeof parseUploadedSource>>;
      try {
        parsed = await parseUploadedSource(safeOrigName, file.buffer);
      } catch (e) {
        const msg = e instanceof Error && e.message === 'MALFORMED_JSON' ? 'Malformed JSON file.' : 'Failed to parse source content.';
        res.status(422).json({ error: msg });
        return;
      }

      const sourceId = `SRC-${crypto.randomUUID().slice(0, 8)}`;
      const finalPath = path.join(paths.uploadsDir, `${sourceId}-${safeOrigName}`);

      try {
        writeFileAtomic(paths.tmpDir, finalPath, file.buffer);
      } catch {
        res.status(500).json({ error: 'Failed to persist uploaded file to storage.' });
        return;
      }

      const nowIso = new Date().toISOString();
      const spanIds: Array<{ id: string; locator: string; content: string }> = [];

      try {
        const tx = db.transaction(() => {
          db.prepare(
            `INSERT INTO sources
              (id, project_id, title, filename, file_type, file_size, sha256, storage_path, visibility_level, exclude_from_ai, status, raw_text, uploaded_by, uploaded_by_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            sourceId,
            projectId,
            customTitle,
            safeOrigName,
            file.mimetype || ext,
            file.size,
            sha256,
            finalPath,
            requestedVis,
            excludeFromAi,
            parsed.status,
            parsed.rawText,
            req.auth!.user.email,
            req.auth!.user.id,
            nowIso
          );

          const spStmt = db.prepare(
            `INSERT INTO source_spans (id, source_id, locator, content, line_start, line_end, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
          parsed.spans.forEach((sp, idx) => {
            const spId = `SP-${sourceId.slice(4)}-${idx + 1}`;
            spStmt.run(spId, sourceId, sp.locator, sp.content, sp.lineStart, sp.lineEnd, nowIso);
            spanIds.push({ id: spId, locator: sp.locator, content: sp.content });
          });
        });
        tx();
      } catch (dbErr) {
        try {
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        } catch {
          // ignore cleanup failure
        }
        throw dbErr;
      }

      const newRedactions =
        requestedVis === 'PRIVATE_OWNER'
          ? 0
          : scanSensitiveContentForProject(db, projectId, {
              actor: { ...req.auth!.user, role: ctx.memberRole },
              includeRestricted: ctx.memberRole === 'PI_LEAD',
            });

      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'SOURCE_UPLOADED',
        targetType: 'SOURCE',
        targetId: sourceId,
        projectId,
        detail: {
          filename: requestedVis === 'PRIVATE_OWNER' ? '[private-file]' : safeOrigName,
          status: parsed.status,
          visibility: requestedVis,
          excludeFromAi,
          spanCount: spanIds.length,
          newRedactionProposals: newRedactions,
        },
        ip: getClientIp(req),
      });

      res.status(201).json({
        source: db
          .prepare(
            `SELECT id, project_id, title, filename, file_type, file_size, sha256, visibility_level, exclude_from_ai, status, uploaded_by, uploaded_by_id, created_at
             FROM sources WHERE id = ?`
          )
          .get(sourceId),
        spans: spanIds,
        status: parsed.status,
        newRedactionProposals: newRedactions,
      });
    });
  });

  // Direct text source ingestion (Paste Note / CSV / JSON / MD)
  app.post('/api/sources/text', async (req: AuthedRequest, res: Response) => {
    const rl = checkRateLimit(db, `upload:${req.auth!.user.id}:${getClientIp(req)}`, 60, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Too many upload requests.');
      return;
    }

    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER', 'INCOMING_MEMBER']);
    if (!ctx) return;
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const body = req.body as {
      title?: unknown;
      filename?: unknown;
      content?: unknown;
      visibility_level?: unknown;
      exclude_from_ai?: unknown;
    };
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 140) : '';
    const rawFilename = typeof body.filename === 'string' ? body.filename.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!title || !rawFilename || !content.trim()) {
      res.status(400).json({ error: 'Title, filename, and non-empty source content are required.' });
      return;
    }

    const buf = Buffer.from(content, 'utf8');
    const validation = validateUploadedFileContent(rawFilename, undefined, buf);
    if (validation.ok === false) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }
    const ext = validation.ext;
    if (ext === '.pdf') {
      res.status(415).json({ error: 'Text upload supports .md, .txt, .csv, or .json filename extensions.' });
      return;
    }

    const projectId = ctx.projectId;
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const duplicate = db
      .prepare('SELECT id, title FROM sources WHERE project_id = ? AND sha256 = ?')
      .get(projectId, sha256) as { id: string; title: string } | undefined;

    if (duplicate) {
      res.status(409).json({
        error: `Duplicate source: identical SHA-256 already exists as "${duplicate.title}" (${duplicate.id}).`,
      });
      return;
    }

    if (body.visibility_level !== undefined && body.visibility_level !== '' && !isValidVisibility(body.visibility_level)) {
      res.status(400).json({ error: 'Invalid visibility_level.' });
      return;
    }
    const requestedVis: VisibilityLevel = isValidVisibility(body.visibility_level)
      ? body.visibility_level
      : 'PROJECT_SHARED';
    if (requestedVis === 'RESTRICTED_PI_ONLY' && ctx.memberRole !== 'PI_LEAD') {
      res.status(403).json({ error: 'Only a PI Lead can create RESTRICTED_PI_ONLY sources.' });
      return;
    }

    const excludeFromAi =
      requestedVis === 'PRIVATE_OWNER' || requestedVis === 'RESTRICTED_PI_ONLY' || Boolean(body.exclude_from_ai) ? 1 : 0;

    const safeFilename = sanitizeFilename(rawFilename);
    let parsed: Awaited<ReturnType<typeof parseUploadedSource>>;
    try {
      parsed = await parseUploadedSource(safeFilename, buf);
    } catch (e) {
      const msg = e instanceof Error && e.message === 'MALFORMED_JSON' ? 'Malformed JSON content.' : 'Failed to parse source content.';
      res.status(422).json({ error: msg });
      return;
    }

    const sourceId = `SRC-${crypto.randomUUID().slice(0, 8)}`;
    const finalPath = path.join(paths.uploadsDir, `${sourceId}-${safeFilename}`);
    writeFileAtomic(paths.tmpDir, finalPath, buf);

    const nowIso = new Date().toISOString();
    const spanIds: Array<{ id: string; locator: string; content: string }> = [];

    try {
      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO sources
            (id, project_id, title, filename, file_type, file_size, sha256, storage_path, visibility_level, exclude_from_ai, status, raw_text, uploaded_by, uploaded_by_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          sourceId,
          projectId,
          title,
          safeFilename,
          ext === '.csv' ? 'text/csv' : ext === '.json' ? 'application/json' : 'text/markdown',
          buf.length,
          sha256,
          finalPath,
          requestedVis,
          excludeFromAi,
          parsed.status,
          parsed.rawText,
          req.auth!.user.email,
          req.auth!.user.id,
          nowIso
        );

        const spStmt = db.prepare(
          `INSERT INTO source_spans (id, source_id, locator, content, line_start, line_end, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        parsed.spans.forEach((sp, idx) => {
          const spId = `SP-${sourceId.slice(4)}-${idx + 1}`;
          spStmt.run(spId, sourceId, sp.locator, sp.content, sp.lineStart, sp.lineEnd, nowIso);
          spanIds.push({ id: spId, locator: sp.locator, content: sp.content });
        });
      });
      tx();
    } catch (dbErr) {
      try {
        if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      } catch {
        // ignore cleanup failure
      }
      throw dbErr;
    }

    const newRedactions =
      requestedVis === 'PRIVATE_OWNER'
        ? 0
        : scanSensitiveContentForProject(db, projectId, {
            actor: { ...req.auth!.user, role: ctx.memberRole },
            includeRestricted: ctx.memberRole === 'PI_LEAD',
          });

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'SOURCE_UPLOADED',
      targetType: 'SOURCE',
      targetId: sourceId,
      projectId,
      detail: {
        filename: requestedVis === 'PRIVATE_OWNER' ? '[private-file]' : safeFilename,
        status: parsed.status,
        visibility: requestedVis,
        excludeFromAi,
        spanCount: spanIds.length,
      },
      ip: getClientIp(req),
    });

    res.status(201).json({
      source: db
        .prepare(
          `SELECT id, project_id, title, filename, file_type, file_size, sha256, visibility_level, exclude_from_ai, status, uploaded_by, uploaded_by_id, created_at
           FROM sources WHERE id = ?`
        )
        .get(sourceId),
      spans: spanIds,
      status: parsed.status,
      newRedactionProposals: newRedactions,
    });
  });

  // Toggle Private <-> Public visibility on a source
  app.patch('/api/sources/:id/visibility', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid source ID.' });
      return;
    }
    const source = db
      .prepare('SELECT id, project_id, visibility_level, uploaded_by, uploaded_by_id FROM sources WHERE id = ?')
      .get(req.params.id) as
      | { id: string; project_id: string; visibility_level: string; uploaded_by: string; uploaded_by_id: string }
      | undefined;
    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, source.project_id, req.auth!.user, [
      'PI_LEAD',
      'RESEARCHER',
      'INCOMING_MEMBER',
    ]);
    if (!ctx) return;

    const isOwner = source.uploaded_by_id === req.auth!.user.id || source.uploaded_by === req.auth!.user.email;
    const canModify =
      source.visibility_level === 'PRIVATE_OWNER'
        ? isOwner
        : source.visibility_level === 'RESTRICTED_PI_ONLY'
          ? ctx.memberRole === 'PI_LEAD'
          : isOwner || ctx.memberRole === 'PI_LEAD';
    if (!canModify) {
      res.status(403).json({ error: 'Only the file owner or authorized PI Lead can change this file visibility.' });
      return;
    }

    const nextVis = isPlainObject(req.body) ? req.body.visibility_level : undefined;
    if (!isValidVisibility(nextVis)) {
      res.status(400).json({ error: 'Invalid visibility_level.' });
      return;
    }
    if (nextVis === 'RESTRICTED_PI_ONLY' && ctx.memberRole !== 'PI_LEAD') {
      res.status(403).json({ error: 'Only a PI Lead can mark a source RESTRICTED_PI_ONLY.' });
      return;
    }

    const nextExclude = nextVis === 'PRIVATE_OWNER' || nextVis === 'RESTRICTED_PI_ONLY' ? 1 : 0;
    db.prepare('UPDATE sources SET visibility_level = ?, exclude_from_ai = ? WHERE id = ?').run(
      nextVis,
      nextExclude,
      source.id
    );

    if (nextVis === 'PROJECT_SHARED') {
      scanSensitiveContentForProject(db, source.project_id, {
        actor: { ...req.auth!.user, role: ctx.memberRole },
        includeRestricted: ctx.memberRole === 'PI_LEAD',
      });
    }

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'SOURCE_VISIBILITY_CHANGED',
      targetType: 'SOURCE',
      targetId: source.id,
      projectId: source.project_id,
      detail: { previous: source.visibility_level, next: nextVis },
      ip: getClientIp(req),
    });

    res.json({
      source: db
        .prepare(
          `SELECT id, project_id, title, filename, file_type, file_size, sha256, visibility_level, exclude_from_ai, status, uploaded_by, uploaded_by_id, created_at,
                  (SELECT COUNT(*) FROM source_spans sp WHERE sp.source_id = sources.id) AS span_count
           FROM sources WHERE id = ?`
        )
        .get(source.id),
    });
  });

  app.delete('/api/sources/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid source ID.' });
      return;
    }
    const source = db
      .prepare('SELECT id, project_id, visibility_level, uploaded_by, uploaded_by_id, storage_path FROM sources WHERE id = ?')
      .get(req.params.id) as
      | {
          id: string;
          project_id: string;
          visibility_level: string;
          uploaded_by: string;
          uploaded_by_id: string;
          storage_path: string;
        }
      | undefined;
    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, source.project_id, req.auth!.user, [
      'PI_LEAD',
      'RESEARCHER',
      'INCOMING_MEMBER',
    ]);
    if (!ctx) return;

    const isOwner = source.uploaded_by_id === req.auth!.user.id || source.uploaded_by === req.auth!.user.email;
    const canDelete =
      source.visibility_level === 'PRIVATE_OWNER'
        ? isOwner
        : source.visibility_level === 'RESTRICTED_PI_ONLY'
          ? ctx.memberRole === 'PI_LEAD'
          : isOwner || ctx.memberRole === 'PI_LEAD';
    if (!canDelete) {
      res.status(403).json({ error: 'Only the file owner can delete this file.' });
      return;
    }

    db.prepare('DELETE FROM sources WHERE id = ?').run(source.id);
    try {
      const safePath = source.storage_path ? sanitizeFsPathWithinDir(source.storage_path, paths.uploadsDir) : null;
      if (safePath && fs.existsSync(safePath)) {
        fs.unlinkSync(safePath);
      }
    } catch {
      // ignore disk cleanup error
    }

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'SOURCE_DELETED',
      targetType: 'SOURCE',
      targetId: source.id,
      projectId: source.project_id,
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  });

  app.post('/api/sources/:id/retry', async (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid source ID.' });
      return;
    }
    const source = db
      .prepare('SELECT id, project_id, filename, storage_path, status, visibility_level, uploaded_by, uploaded_by_id FROM sources WHERE id = ?')
      .get(req.params.id) as
      | {
          id: string;
          project_id: string;
          filename: string;
          storage_path: string;
          status: string;
          visibility_level: string;
          uploaded_by: string;
          uploaded_by_id: string;
        }
      | undefined;
    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, source.project_id, req.auth!.user, [
      'PI_LEAD',
      'RESEARCHER',
      'INCOMING_MEMBER',
    ]);
    if (!ctx) return;

    if (!canUserAccessSource(source, req.auth!.user, ctx.memberRole)) {
      res.status(403).json({ error: 'Access denied for this file.' });
      return;
    }

    const ocrText = isPlainObject(req.body) && typeof req.body.raw_text === 'string' ? req.body.raw_text.trim() : '';
    let parsed: Awaited<ReturnType<typeof parseUploadedSource>>;
    if (ocrText.length > 0) {
      parsed = await parseUploadedSource(`${sanitizeFilename(source.filename)}.txt`, Buffer.from(ocrText, 'utf8'));
    } else {
      const safePath = sanitizeFsPathWithinDir(source.storage_path, paths.uploadsDir);
      if (!safePath || !fs.existsSync(safePath)) {
        res.status(404).json({ error: 'Stored source file missing on disk.' });
        return;
      }
      parsed = await parseUploadedSource(sanitizeFilename(source.filename), fs.readFileSync(safePath));
    }

    const nowIso = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE sources SET status = ?, raw_text = ? WHERE id = ?').run(parsed.status, parsed.rawText, source.id);
      if (parsed.spans.length > 0) {
        db.prepare('DELETE FROM source_spans WHERE source_id = ?').run(source.id);
        const spStmt = db.prepare(
          `INSERT INTO source_spans (id, source_id, locator, content, line_start, line_end, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        parsed.spans.forEach((sp, idx) => {
          spStmt.run(`SP-${source.id.slice(4)}-${idx + 1}`, source.id, sp.locator, sp.content, sp.lineStart, sp.lineEnd, nowIso);
        });
      }
    });
    tx();

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'SOURCE_RETRIED',
      targetType: 'SOURCE',
      targetId: source.id,
      projectId: source.project_id,
      detail: { status: parsed.status, spanCount: parsed.spans.length },
      ip: getClientIp(req),
    });

    res.json({ status: parsed.status, spanCount: parsed.spans.length });
  });

  app.post('/api/sources/:id/reconstruct', async (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid source ID.' });
      return;
    }
    const source = db
      .prepare('SELECT id, project_id, visibility_level, exclude_from_ai, status FROM sources WHERE id = ?')
      .get(req.params.id) as
      | { id: string; project_id: string; visibility_level: string; exclude_from_ai: number; status: string }
      | undefined;
    if (!source) {
      res.status(404).json({ error: 'Source not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, source.project_id, req.auth!.user, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    if (source.status === 'NEEDS_OCR') {
      res.status(422).json({ error: 'Source requires OCR before reconstruction.' });
      return;
    }
    if (source.visibility_level !== 'PROJECT_SHARED' || source.exclude_from_ai === 1) {
      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'AI_CONTEXT_FILTERED',
        targetType: 'SOURCE',
        targetId: source.id,
        projectId: source.project_id,
        detail: { reason: `Excluded by visibility (${source.visibility_level}) or exclude_from_ai=1` },
        ip: getClientIp(req),
      });
      res.status(422).json({
        error:
          source.visibility_level === 'PRIVATE_OWNER'
            ? 'This file is Private (only visible to you). Switch it to Public (PROJECT_SHARED) before reconstructing shared claims.'
            : 'Source is marked RESTRICTED_PI_ONLY or exclude_from_ai=1 and was excluded by pre-AI SQL filter.',
      });
      return;
    }

    const preferAi = Boolean(isPlainObject(req.body) && req.body.useAi);
    const result = await reconstructFromSource(db, source.project_id, source.id, req.auth!.user, preferAi);
    scanSensitiveContentForProject(db, source.project_id, {
      actor: { ...req.auth!.user, role: ctx.memberRole },
      includeRestricted: ctx.memberRole === 'PI_LEAD',
    });
    runRadarScan(db, source.project_id);
    res.json(result);
  });

  // Word-style Notes Studio CRUD (XSS sanitized, AUDITOR strictly read-only, optimistic version concurrency)
  app.get('/api/notes', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res);
    if (!ctx) return;

    const userId = req.auth!.user.id;
    const rows = db
      .prepare(
        `SELECT * FROM notes
         WHERE project_id = ?
           AND (visibility_level = 'PROJECT_SHARED' OR (visibility_level = 'PRIVATE_OWNER' AND author_id = ?))
         ORDER BY updated_at DESC`
      )
      .all(ctx.projectId, userId);
    res.json({ notes: rows });
  });

  app.post('/api/notes', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER', 'REVIEWER', 'INCOMING_MEMBER']);
    if (!ctx) return;
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const user = req.auth!.user;
    const body = req.body as {
      title?: unknown;
      content_html?: unknown;
      plain_text?: unknown;
      font_family?: unknown;
      visibility_level?: unknown;
    };
    const title =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 180) : 'Untitled Research Note';
    const rawHtml = typeof body.content_html === 'string' ? body.content_html : '<p></p>';
    const contentHtml = sanitizeNoteHtml(rawHtml);
    const plainText = typeof body.plain_text === 'string' ? body.plain_text.slice(0, 200_000) : '';
    const fontFamily =
      typeof body.font_family === 'string' && body.font_family.trim()
        ? body.font_family.trim().slice(0, 60)
        : 'DM Sans';
    if (body.visibility_level !== undefined && body.visibility_level !== 'PROJECT_SHARED' && body.visibility_level !== 'PRIVATE_OWNER') {
      res.status(400).json({ error: 'Note visibility_level must be PROJECT_SHARED or PRIVATE_OWNER.' });
      return;
    }
    const visibility = body.visibility_level === 'PRIVATE_OWNER' ? 'PRIVATE_OWNER' : 'PROJECT_SHARED';
    const words = plainText.trim() ? plainText.trim().split(/\s+/).length : 0;
    const nowIso = new Date().toISOString();
    const id = `NOTE-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    db.prepare(
      `INSERT INTO notes
        (id, project_id, author_id, author_name, author_role, title, content_html, plain_text, font_family, visibility_level, word_count, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, ctx.projectId, user.id, user.name, ctx.memberRole, title, contentHtml, plainText, fontFamily, visibility, words, nowIso, nowIso);

    appendAudit(db, {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: ctx.memberRole,
      action: 'NOTE_CREATED',
      targetType: 'NOTE',
      targetId: id,
      projectId: ctx.projectId,
      detail: { visibility, wordCount: words },
      ip: getClientIp(req),
    });

    res.status(201).json({ note: db.prepare('SELECT * FROM notes WHERE id = ?').get(id) });
  });

  app.patch('/api/notes/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid note ID.' });
      return;
    }
    const user = req.auth!.user;
    const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          project_id: string;
          author_id: string;
          title: string;
          content_html: string;
          plain_text: string;
          font_family: string;
          visibility_level: string;
          version: number;
        }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Note not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, existing.project_id, user, [
      'PI_LEAD',
      'RESEARCHER',
      'REVIEWER',
      'INCOMING_MEMBER',
    ]);
    if (!ctx) return;

    if (!canUserAccessNote(existing, user.id, ctx.memberRole, 'WRITE')) {
      res.status(403).json({ error: 'Only the note author (or PI Lead on shared notes) can edit this note.' });
      return;
    }

    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    const body = req.body as {
      title?: unknown;
      content_html?: unknown;
      plain_text?: unknown;
      font_family?: unknown;
      visibility_level?: unknown;
      expected_version?: unknown;
    };

    if (typeof body.expected_version === 'number' && body.expected_version !== (existing.version || 1)) {
      res.status(409).json({
        error: 'Note was modified by a newer save. Reload the latest version before saving to avoid overwriting changes.',
        code: 'VERSION_CONFLICT',
        currentVersion: existing.version || 1,
      });
      return;
    }

    const nextTitle =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 180) : existing.title;
    const nextHtml =
      typeof body.content_html === 'string' ? sanitizeNoteHtml(body.content_html) : existing.content_html;
    const nextPlain =
      typeof body.plain_text === 'string' ? body.plain_text.slice(0, 200_000) : existing.plain_text;
    const nextFont =
      typeof body.font_family === 'string' && body.font_family.trim()
        ? body.font_family.trim().slice(0, 60)
        : existing.font_family;
    const nextVis =
      body.visibility_level === 'PRIVATE_OWNER' || body.visibility_level === 'PROJECT_SHARED'
        ? body.visibility_level
        : existing.visibility_level;
    const words = nextPlain.trim() ? nextPlain.trim().split(/\s+/).length : 0;
    const nowIso = new Date().toISOString();
    const nextVersion = (existing.version || 1) + 1;

    db.prepare(
      `UPDATE notes
       SET title = ?, content_html = ?, plain_text = ?, font_family = ?, visibility_level = ?, word_count = ?, version = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextTitle, nextHtml, nextPlain, nextFont, nextVis, words, nextVersion, nowIso, existing.id);

    appendAudit(db, {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: ctx.memberRole,
      action: nextVis !== existing.visibility_level ? 'NOTE_VISIBILITY_CHANGED' : 'NOTE_UPDATED',
      targetType: 'NOTE',
      targetId: existing.id,
      projectId: existing.project_id,
      detail: { visibility: nextVis, wordCount: words, version: nextVersion },
      ip: getClientIp(req),
    });

    res.json({ note: db.prepare('SELECT * FROM notes WHERE id = ?').get(existing.id) });
  });

  app.delete('/api/notes/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid note ID.' });
      return;
    }
    const user = req.auth!.user;
    const existing = db.prepare('SELECT id, project_id, author_id, visibility_level FROM notes WHERE id = ?').get(req.params.id) as
      | { id: string; project_id: string; author_id: string; visibility_level: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Note not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, existing.project_id, user, [
      'PI_LEAD',
      'RESEARCHER',
      'REVIEWER',
      'INCOMING_MEMBER',
    ]);
    if (!ctx) return;

    if (!canUserAccessNote(existing, user.id, ctx.memberRole, 'WRITE')) {
      res.status(403).json({ error: 'Only the note author can delete this note.' });
      return;
    }

    db.prepare('DELETE FROM notes WHERE id = ?').run(existing.id);
    appendAudit(db, {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: ctx.memberRole,
      action: 'NOTE_DELETED',
      targetType: 'NOTE',
      targetId: existing.id,
      projectId: existing.project_id,
      ip: getClientIp(req),
    });
    res.json({ ok: true });
  });

  // Knowledge Map & Records (server-side confirmed redaction preview enforcement & strict project membership)
  app.get('/api/records', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER', 'REVIEWER', 'AUDITOR']);
    if (!ctx) return;
    const isPi = ctx.memberRole === 'PI_LEAD';

    const rows = db
      .prepare(
        `SELECT r.*, sp.content AS span_content
         FROM records r
         LEFT JOIN source_spans sp ON sp.id = r.span_id
         WHERE r.project_id = ? ${isPi ? "AND r.visibility_level != 'PRIVATE_OWNER'" : "AND r.visibility_level = 'PROJECT_SHARED'"}
         ORDER BY r.id ASC`
      )
      .all(ctx.projectId) as Array<ResearchRecord & { span_content: string | null }>;

    const enriched = rows.map((r) => ({
      ...r,
      excerpt: applyConfirmedRedactions(db, ctx.projectId, r.excerpt),
      span_content: r.span_content ? applyConfirmedRedactions(db, ctx.projectId, r.span_content) : null,
      verbatim_match: verifyVerbatimInSpan(r.excerpt, r.span_content),
    }));
    res.json({ records: enriched });
  });

  app.get('/api/map', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER', 'REVIEWER', 'AUDITOR']);
    if (!ctx) return;
    const isPi = ctx.memberRole === 'PI_LEAD';

    const nodes = db
      .prepare(
        `SELECT id, type, title, owner_name, evidence_state, approval_state, visibility_level, stage, source_id, source_file, locator
         FROM records
         WHERE project_id = ? ${isPi ? "AND visibility_level != 'PRIVATE_OWNER'" : "AND visibility_level = 'PROJECT_SHARED'"}
         ORDER BY id ASC`
      )
      .all(ctx.projectId) as Array<{ id: string }>;

    const visibleIds = new Set(nodes.map((n) => n.id));
    const allEdges = db.prepare('SELECT * FROM record_edges').all() as Array<{
      id: string;
      from_record_id: string;
      to_record_id: string;
      relation: string;
    }>;
    const edges = allEdges.filter((e) => visibleIds.has(e.from_record_id) && visibleIds.has(e.to_record_id));
    const sources = db
      .prepare(
        `SELECT id, title, filename, visibility_level, exclude_from_ai, status
         FROM sources
         WHERE project_id = ? AND (visibility_level != 'PRIVATE_OWNER' OR uploaded_by_id = ? OR uploaded_by = ?)
           ${isPi ? '' : "AND visibility_level != 'RESTRICTED_PI_ONLY'"}
         ORDER BY created_at DESC`
      )
      .all(ctx.projectId, req.auth!.user.id, req.auth!.user.email);
    res.json({ nodes, edges, sources });
  });

  app.post('/api/map/reconstruct', async (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    const sourceIds =
      isPlainObject(req.body) && Array.isArray(req.body.sourceIds)
        ? (req.body.sourceIds as unknown[]).filter((s): s is string => typeof s === 'string' && isValidId(s))
        : [];
    const focus =
      isPlainObject(req.body) && typeof req.body.focus === 'string' ? req.body.focus.trim().slice(0, 200) : undefined;
    const preferAi = Boolean(isPlainObject(req.body) && req.body.useAi);

    const result = await reconstructFromSources(
      db,
      ctx.projectId,
      sourceIds,
      { ...req.auth!.user, role: ctx.memberRole },
      preferAi,
      focus
    );
    scanSensitiveContentForProject(db, ctx.projectId, {
      actor: { ...req.auth!.user, role: ctx.memberRole },
      includeRestricted: ctx.memberRole === 'PI_LEAD',
    });
    runRadarScan(db, ctx.projectId);
    res.json(result);
  });

  app.post('/api/records', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    if ('confidence_score' in body || 'truth_score' in body) {
      res.status(422).json({ error: 'Confidence or truth percentages are prohibited by BATON policy.' });
      return;
    }

    const evidenceState = (body.evidence_state as EvidenceState) || 'NEEDS_REVIEW';
    if (!EVIDENCE_STATES.includes(evidenceState)) {
      res.status(422).json({ error: `Invalid evidence_state. Allowed: ${EVIDENCE_STATES.join(', ')}.` });
      return;
    }

    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 180) : '';
    const excerpt = typeof body.excerpt === 'string' ? body.excerpt.trim().slice(0, 2000) : '';
    const type = typeof body.type === 'string' ? body.type.trim().toUpperCase() : 'RESULT';
    if (!title || !excerpt) {
      res.status(400).json({ error: 'Title and excerpt are required.' });
      return;
    }

    const visibility = body.visibility_level === 'RESTRICTED_PI_ONLY' ? 'RESTRICTED_PI_ONLY' : 'PROJECT_SHARED';
    if (visibility === 'RESTRICTED_PI_ONLY' && ctx.memberRole !== 'PI_LEAD') {
      res.status(403).json({ error: 'Only a PI Lead can create RESTRICTED_PI_ONLY records.' });
      return;
    }

    let sourceId = typeof body.source_id === 'string' && body.source_id.trim() ? body.source_id.trim() : null;
    const spanId = typeof body.span_id === 'string' && body.span_id.trim() ? body.span_id.trim() : null;
    if (sourceId && !isValidId(sourceId)) {
      res.status(400).json({ error: 'Invalid source_id.' });
      return;
    }
    if (spanId && !isValidId(spanId)) {
      res.status(400).json({ error: 'Invalid span_id.' });
      return;
    }

    const dateValidation = validateStrictIsoDate(body.last_updated);
    if (dateValidation.ok === false) {
      res.status(400).json({ error: dateValidation.error });
      return;
    }

    const ownerName =
      typeof body.owner_name === 'string' && body.owner_name.trim() && body.owner_name !== 'UNKNOWN'
        ? body.owner_name.trim().slice(0, 100)
        : null;

    let sourceFile = typeof body.source_file === 'string' ? body.source_file.slice(0, 180) : 'Unlinked Source';
    let locator = typeof body.locator === 'string' ? body.locator.slice(0, 120) : 'Unlocated';
    let spanContent: string | null = null;

    if (sourceId) {
      const srcRow = db
        .prepare('SELECT id, project_id, visibility_level, uploaded_by, uploaded_by_id, title FROM sources WHERE id = ?')
        .get(sourceId) as
        | {
            id: string;
            project_id: string;
            visibility_level: string;
            uploaded_by: string;
            uploaded_by_id: string;
            title: string;
          }
        | undefined;
      if (!srcRow) {
        res.status(404).json({ error: 'Cited source_id not found.' });
        return;
      }
      if (srcRow.project_id !== ctx.projectId) {
        res.status(422).json({ error: 'Cross-project citations are prohibited: source belongs to another project.' });
        return;
      }
      if (!canUserAccessSource(srcRow, req.auth!.user, ctx.memberRole) || srcRow.visibility_level === 'PRIVATE_OWNER') {
        res.status(403).json({ error: 'Cannot link shared record to a private or unauthorized source.' });
        return;
      }
      sourceFile = srcRow.title;
    }

    if (spanId) {
      const sp = db
        .prepare(
          `SELECT sp.content, sp.locator, s.title AS source_title, s.id AS source_id, s.project_id,
                  s.visibility_level, s.uploaded_by, s.uploaded_by_id
           FROM source_spans sp JOIN sources s ON s.id = sp.source_id WHERE sp.id = ?`
        )
        .get(spanId) as
        | {
            content: string;
            locator: string;
            source_title: string;
            source_id: string;
            project_id: string;
            visibility_level: string;
            uploaded_by: string;
            uploaded_by_id: string;
          }
        | undefined;
      if (!sp) {
        res.status(404).json({ error: 'Cited span_id not found.' });
        return;
      }
      if (sp.project_id !== ctx.projectId) {
        res.status(422).json({ error: 'Cross-project citations are prohibited: span belongs to another project.' });
        return;
      }
      if (!canUserAccessSource(sp, req.auth!.user, ctx.memberRole) || sp.visibility_level === 'PRIVATE_OWNER') {
        res.status(403).json({ error: 'Cannot cite a span from a private or unauthorized source.' });
        return;
      }
      spanContent = sp.content;
      locator = sp.locator;
      sourceFile = sp.source_title;
      sourceId = sp.source_id;
    }

    if (evidenceState === 'SUPPORTED' && !verifyVerbatimInSpan(excerpt, spanContent)) {
      res.status(422).json({
        error: 'Evidence state SUPPORTED requires the excerpt to appear verbatim in the cited source span.',
      });
      return;
    }

    const id = `R-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const nowIso = new Date().toISOString();
    const lastUpdatedVal = dateValidation.value ?? nowIso.slice(0, 10);
    const rationale = typeof body.rationale === 'string' ? body.rationale.trim().slice(0, 1000) : '';

    const createTx = db.transaction(() => {
      db.prepare(
        `INSERT INTO records
          (id, project_id, type, title, owner_name, owner_user_id, source_id, source_file, locator, span_id,
           evidence_state, approval_state, approved_version, version, visibility_level, exclude_from_ai, excerpt, rationale, stage, last_updated, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'NEEDS_REVIEW', NULL, 1, ?, ?, ?, ?, '02', ?, ?)`
      ).run(
        id,
        ctx.projectId,
        type,
        title,
        ownerName,
        sourceId,
        sourceFile,
        locator,
        spanId,
        evidenceState,
        visibility,
        visibility === 'RESTRICTED_PI_ONLY' ? 1 : 0,
        excerpt,
        rationale,
        lastUpdatedVal,
        nowIso
      );

      db.prepare(
        `INSERT INTO record_versions
          (id, record_id, version, title, excerpt, evidence_state, approval_state, owner_name, locator, reason, edited_by, created_at)
         VALUES (?, ?, 1, ?, ?, ?, 'NEEDS_REVIEW', ?, ?, 'Initial claim created', ?, ?)`
      ).run(
        `RV-${crypto.randomUUID().slice(0, 8)}`,
        id,
        title,
        excerpt,
        evidenceState,
        ownerName,
        locator,
        req.auth!.user.email,
        nowIso
      );
    });
    createTx();

    scanSensitiveContentForProject(db, ctx.projectId, {
      actor: { ...req.auth!.user, role: ctx.memberRole },
      includeRestricted: ctx.memberRole === 'PI_LEAD',
    });
    runRadarScan(db, ctx.projectId);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'RECORD_CREATED',
      targetType: 'RECORD',
      targetId: id,
      projectId: ctx.projectId,
      detail: { type, evidenceState },
      ip: getClientIp(req),
    });

    res.status(201).json({ record: db.prepare('SELECT * FROM records WHERE id = ?').get(id) });
  });

  app.get('/api/records/:id/versions', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }
    const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id) as ResearchRecord | undefined;
    if (!rec) {
      res.status(404).json({ error: 'Record not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, rec.project_id, req.auth!.user, [
      'PI_LEAD',
      'RESEARCHER',
      'REVIEWER',
      'AUDITOR',
    ]);
    if (!ctx) return;

    if (!canUserAccessRecord(rec, req.auth!.user.id, ctx.memberRole)) {
      res.status(403).json({ error: 'Restricted record.' });
      return;
    }

    const versions = db
      .prepare('SELECT * FROM record_versions WHERE record_id = ? ORDER BY version DESC')
      .all(rec.id) as Array<{ excerpt: string } & Record<string, unknown>>;
    if (versions.length === 0) {
      versions.push({
        id: `RV-BASE-${rec.id}`,
        record_id: rec.id,
        version: rec.version,
        title: rec.title,
        excerpt: rec.excerpt,
        evidence_state: rec.evidence_state,
        approval_state: rec.approval_state,
        owner_name: rec.owner_name,
        locator: rec.locator,
        reason: 'Initial baseline record',
        edited_by: rec.owner_name || 'system',
        created_at: rec.created_at,
      });
    }
    res.json({
      versions: versions.map((v) => ({
        ...v,
        excerpt: applyConfirmedRedactions(db, rec.project_id, v.excerpt),
      })),
    });
  });

  app.post('/api/records/:id/flag-citation', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }
    const rec = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id) as ResearchRecord | undefined;
    if (!rec) {
      res.status(404).json({ error: 'Record not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, rec.project_id, req.auth!.user, [
      'PI_LEAD',
      'RESEARCHER',
      'REVIEWER',
    ]);
    if (!ctx) return;
    if (!canUserAccessRecord(rec, req.auth!.user.id, ctx.memberRole)) {
      res.status(403).json({ error: 'Access denied for this record.' });
      return;
    }

    const reason =
      isPlainObject(req.body) && typeof req.body.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 500)
        : 'Broken or mismatched source citation flagged in inspector.';

    db.prepare("UPDATE records SET evidence_state = 'UNSUPPORTED', last_updated = ? WHERE id = ?").run(
      new Date().toISOString().slice(0, 10),
      rec.id
    );
    runRadarScan(db, rec.project_id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'CITATION_FLAGGED',
      targetType: 'RECORD',
      targetId: rec.id,
      projectId: rec.project_id,
      detail: { reason, previousEvidenceState: rec.evidence_state },
      ip: getClientIp(req),
    });

    res.json({ ok: true, evidence_state: 'UNSUPPORTED' });
  });

  app.patch('/api/records/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }
    const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id) as ResearchRecord | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Record not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, existing.project_id, req.auth!.user, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    if (!canUserAccessRecord(existing, req.auth!.user.id, ctx.memberRole)) {
      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'ACCESS_DENIED',
        targetType: 'RECORD',
        targetId: existing.id,
        projectId: existing.project_id,
        ip: getClientIp(req),
      });
      res.status(403).json({ error: 'Access denied.' });
      return;
    }

    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if ('confidence_score' in body || 'truth_score' in body) {
      res.status(422).json({ error: 'Confidence or truth percentages are prohibited by BATON policy.' });
      return;
    }

    const nextEvidence = (body.evidence_state as EvidenceState | undefined) ?? existing.evidence_state;
    if (!EVIDENCE_STATES.includes(nextEvidence)) {
      res.status(422).json({ error: `Invalid evidence_state. Allowed: ${EVIDENCE_STATES.join(', ')}.` });
      return;
    }

    const nextTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 180) : existing.title;
    const nextExcerpt =
      typeof body.excerpt === 'string' && body.excerpt.trim() ? body.excerpt.trim().slice(0, 2000) : existing.excerpt;
    const nextRationale =
      typeof body.rationale === 'string' ? body.rationale.trim().slice(0, 1000) : existing.rationale || '';
    const editReason =
      typeof body.edit_reason === 'string' && body.edit_reason.trim()
        ? body.edit_reason.trim().slice(0, 400)
        : 'Record updated in inspector';
    const nextOwner =
      body.owner_name === null || body.owner_name === '' || body.owner_name === 'UNKNOWN'
        ? null
        : typeof body.owner_name === 'string'
          ? body.owner_name.trim().slice(0, 100)
          : existing.owner_name;
    let nextLocator = typeof body.locator === 'string' ? body.locator.trim().slice(0, 120) : existing.locator;
    const nextSpanId = typeof body.span_id === 'string' ? body.span_id.trim() : existing.span_id;
    let nextSourceId = existing.source_id;

    if (nextSpanId && !isValidId(nextSpanId)) {
      res.status(400).json({ error: 'Invalid span_id.' });
      return;
    }

    const nextStage =
      typeof body.stage === 'string' && (ALLOWED_STAGES as string[]).includes(body.stage)
        ? body.stage
        : existing.stage;

    const spanRow = nextSpanId
      ? (db
          .prepare(
            `SELECT sp.content, sp.locator, s.id AS source_id, s.project_id, s.visibility_level, s.uploaded_by, s.uploaded_by_id
             FROM source_spans sp JOIN sources s ON s.id = sp.source_id WHERE sp.id = ?`
          )
          .get(nextSpanId) as
          | {
              content: string;
              locator: string;
              source_id: string;
              project_id: string;
              visibility_level: string;
              uploaded_by: string;
              uploaded_by_id: string;
            }
          | undefined)
      : undefined;

    if (nextSpanId && !spanRow) {
      res.status(404).json({ error: 'Cited span_id not found.' });
      return;
    }
    if (spanRow) {
      if (spanRow.project_id !== existing.project_id) {
        res.status(422).json({ error: 'Cross-project citations are prohibited: span belongs to another project.' });
        return;
      }
      if (!canUserAccessSource(spanRow, req.auth!.user, ctx.memberRole) || spanRow.visibility_level === 'PRIVATE_OWNER') {
        res.status(403).json({ error: 'Cannot cite a private or unauthorized source span.' });
        return;
      }
      nextSourceId = spanRow.source_id;
      if (body.span_id !== undefined && body.locator === undefined) {
        nextLocator = spanRow.locator;
      }
    }

    if (nextEvidence === 'SUPPORTED' && !verifyVerbatimInSpan(nextExcerpt, spanRow?.content)) {
      res.status(422).json({
        error: 'Cannot set evidence_state to SUPPORTED: excerpt is not found verbatim in the cited span.',
      });
      return;
    }

    let lastUpdatedDate = new Date().toISOString().slice(0, 10);
    if (body.last_updated !== undefined) {
      const dateValidation = validateStrictIsoDate(body.last_updated);
      if (dateValidation.ok === false) {
        res.status(400).json({ error: dateValidation.error });
        return;
      }
      lastUpdatedDate = dateValidation.value ?? lastUpdatedDate;
    }

    const ownerUser = nextOwner
      ? (db.prepare('SELECT id FROM users WHERE name = ?').get(nextOwner) as { id: string } | undefined)
      : undefined;

    const nextVersion = existing.version + 1;
    const wasApproved = existing.approval_state === 'APPROVED';
    const nowIso = new Date().toISOString();

    const updateTx = db.transaction(() => {
      const existingVerCount = (
        db.prepare('SELECT COUNT(*) AS cnt FROM record_versions WHERE record_id = ?').get(existing.id) as { cnt: number }
      ).cnt;
      if (existingVerCount === 0) {
        db.prepare(
          `INSERT INTO record_versions
            (id, record_id, version, title, excerpt, evidence_state, approval_state, owner_name, locator, reason, edited_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Baseline prior to edit', ?, ?)`
        ).run(
          `RV-${crypto.randomUUID().slice(0, 8)}`,
          existing.id,
          existing.version,
          existing.title,
          existing.excerpt,
          existing.evidence_state,
          existing.approval_state,
          existing.owner_name,
          existing.locator,
          existing.owner_name || 'seed',
          existing.created_at
        );
      }

      db.prepare(
        `UPDATE records
         SET title = ?, excerpt = ?, rationale = ?, owner_name = ?, owner_user_id = ?, source_id = ?, locator = ?, span_id = ?,
             evidence_state = ?, stage = ?, version = ?, approval_state = 'NEEDS_REVIEW', approved_version = NULL, last_updated = ?
         WHERE id = ?`
      ).run(
        nextTitle,
        nextExcerpt,
        nextRationale,
        nextOwner,
        ownerUser?.id ?? null,
        nextSourceId,
        nextLocator,
        nextSpanId,
        nextEvidence,
        nextStage,
        nextVersion,
        lastUpdatedDate,
        existing.id
      );

      db.prepare(
        `INSERT INTO record_versions
          (id, record_id, version, title, excerpt, evidence_state, approval_state, owner_name, locator, reason, edited_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'NEEDS_REVIEW', ?, ?, ?, ?, ?)`
      ).run(
        `RV-${crypto.randomUUID().slice(0, 8)}`,
        existing.id,
        nextVersion,
        nextTitle,
        nextExcerpt,
        nextEvidence,
        nextOwner,
        nextLocator,
        editReason,
        req.auth!.user.email,
        nowIso
      );
    });
    updateTx();

    scanSensitiveContentForProject(db, existing.project_id, {
      actor: { ...req.auth!.user, role: ctx.memberRole },
      includeRestricted: ctx.memberRole === 'PI_LEAD',
    });
    runRadarScan(db, existing.project_id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: wasApproved ? 'APPROVAL_INVALIDATED_ON_EDIT' : 'RECORD_UPDATED',
      targetType: 'RECORD',
      targetId: existing.id,
      projectId: existing.project_id,
      detail: { previousVersion: existing.version, newVersion: nextVersion, evidenceState: nextEvidence, editReason },
      ip: getClientIp(req),
    });

    const updated = db
      .prepare(
        `SELECT r.*, sp.content AS span_content FROM records r
         LEFT JOIN source_spans sp ON sp.id = r.span_id WHERE r.id = ?`
      )
      .get(existing.id) as ResearchRecord & { span_content: string | null };

    res.json({
      record: {
        ...updated,
        verbatim_match: verifyVerbatimInSpan(updated.excerpt, updated.span_content),
      },
    });
  });

  app.post('/api/records/:id/verify', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }
    const record = db
      .prepare(
        `SELECT r.*, sp.content AS span_content FROM records r
         LEFT JOIN source_spans sp ON sp.id = r.span_id WHERE r.id = ?`
      )
      .get(req.params.id) as (ResearchRecord & { span_content: string | null }) | undefined;

    if (!record) {
      res.status(404).json({ error: 'Record not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, record.project_id, req.auth!.user, [
      'PI_LEAD',
      'RESEARCHER',
      'REVIEWER',
    ]);
    if (!ctx) return;
    if (!canUserAccessRecord(record, req.auth!.user.id, ctx.memberRole)) {
      res.status(403).json({ error: 'Access denied for this record.' });
      return;
    }

    const verbatim = verifyVerbatimInSpan(record.excerpt, record.span_content);
    const nextState: EvidenceState = verbatim ? 'SUPPORTED' : 'UNSUPPORTED';

    db.prepare('UPDATE records SET evidence_state = ?, last_updated = ? WHERE id = ?').run(
      nextState,
      new Date().toISOString().slice(0, 10),
      record.id
    );
    runRadarScan(db, record.project_id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'EVIDENCE_VERIFIED',
      targetType: 'RECORD',
      targetId: record.id,
      projectId: record.project_id,
      detail: { verbatimMatch: verbatim, resultingState: nextState },
      ip: getClientIp(req),
    });

    res.json({ recordId: record.id, verbatimMatch: verbatim, evidence_state: nextState });
  });

  app.delete('/api/records', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;
    const isPi = ctx.memberRole === 'PI_LEAD';

    const matching = db
      .prepare(
        `SELECT id FROM records
         WHERE project_id = ? ${isPi ? "AND visibility_level != 'PRIVATE_OWNER'" : "AND visibility_level = 'PROJECT_SHARED'"}`
      )
      .all(ctx.projectId) as Array<{ id: string }>;

    const tx = db.transaction(() => {
      for (const r of matching) {
        db.prepare("DELETE FROM redaction_proposals WHERE target_type = 'RECORD' AND target_id = ?").run(r.id);
        db.prepare('DELETE FROM drafts WHERE draft_key = ?').run(`record:${r.id}`);
        db.prepare('DELETE FROM records WHERE id = ?').run(r.id);
      }
    });
    tx();

    runRadarScan(db, ctx.projectId);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'RECORDS_CLEARED',
      targetType: 'PROJECT',
      targetId: ctx.projectId,
      projectId: ctx.projectId,
      detail: { deletedCount: matching.length },
      ip: getClientIp(req),
    });

    res.json({ ok: true, deletedCount: matching.length });
  });

  app.delete('/api/records/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }
    const record = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id) as ResearchRecord | undefined;
    if (!record) {
      res.status(404).json({ error: 'Record not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, record.project_id, req.auth!.user, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    if (!canUserAccessRecord(record, req.auth!.user.id, ctx.memberRole)) {
      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'ACCESS_DENIED',
        targetType: 'RECORD',
        targetId: record.id,
        projectId: record.project_id,
        ip: getClientIp(req),
      });
      res.status(403).json({ error: 'You do not have permission to delete this record.' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM redaction_proposals WHERE target_type = 'RECORD' AND target_id = ?").run(record.id);
      db.prepare('DELETE FROM drafts WHERE draft_key = ?').run(`record:${record.id}`);
      db.prepare('DELETE FROM records WHERE id = ?').run(record.id);
    });
    tx();

    runRadarScan(db, record.project_id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'RECORD_DELETED',
      targetType: 'RECORD',
      targetId: record.id,
      projectId: record.project_id,
      detail: { title: record.title, type: record.type, projectId: record.project_id },
      ip: getClientIp(req),
    });

    res.json({ ok: true, deletedId: record.id });
  });

  // Review Queue
  app.get('/api/reviews', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'REVIEWER']);
    if (!ctx) return;
    const isPi = ctx.memberRole === 'PI_LEAD';

    const records = db
      .prepare(
        `SELECT r.*, sp.content AS span_content
         FROM records r
         LEFT JOIN source_spans sp ON sp.id = r.span_id
         WHERE r.project_id = ? ${isPi ? "AND r.visibility_level != 'PRIVATE_OWNER'" : "AND r.visibility_level = 'PROJECT_SHARED'"}
         ORDER BY CASE r.approval_state
           WHEN 'NEEDS_REVIEW' THEN 1
           WHEN 'NEEDS_REVISION' THEN 2
           WHEN 'REJECTED' THEN 3
           ELSE 4 END, r.id ASC`
      )
      .all(ctx.projectId) as Array<ResearchRecord & { span_content: string | null }>;

    const history = db
      .prepare(
        `SELECT rv.* FROM reviews rv
         JOIN records r ON r.id = rv.record_id
         WHERE r.project_id = ? ${isPi ? "AND r.visibility_level != 'PRIVATE_OWNER'" : "AND r.visibility_level = 'PROJECT_SHARED'"}
         ORDER BY rv.created_at DESC LIMIT 40`
      )
      .all(ctx.projectId);

    res.json({
      queue: records.map((r) => ({
        ...r,
        excerpt: applyConfirmedRedactions(db, ctx.projectId, r.excerpt),
        span_content: r.span_content ? applyConfirmedRedactions(db, ctx.projectId, r.span_content) : null,
        verbatim_match: verifyVerbatimInSpan(r.excerpt, r.span_content),
      })),
      history,
    });
  });

  app.post('/api/records/:id/review', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid record ID.' });
      return;
    }
    const record = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id) as ResearchRecord | undefined;
    if (!record) {
      res.status(404).json({ error: 'Record not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, record.project_id, req.auth!.user, ['PI_LEAD', 'REVIEWER']);
    if (!ctx) return;

    if (!canUserAccessRecord(record, req.auth!.user.id, ctx.memberRole)) {
      res.status(403).json({ error: 'Restricted record.' });
      return;
    }

    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    const { action, comment } = req.body as {
      action?: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES' | 'FLAG_GAP';
      comment?: unknown;
    };
    if (!action || !['APPROVE', 'REJECT', 'REQUEST_CHANGES', 'FLAG_GAP'].includes(action)) {
      res.status(400).json({ error: 'Valid review action required.' });
      return;
    }
    const rationaleText = typeof comment === 'string' ? comment.trim() : '';
    if (rationaleText.length < 3 || rationaleText.length > 1000) {
      res.status(400).json({
        error: 'A reviewer rationale comment (minimum 3 characters) is mandatory for every review decision.',
      });
      return;
    }

    // Prevent accidental rapid duplicate review submission on the same record version and action
    const lastRev = db
      .prepare(
        `SELECT id, action, record_version, reviewer_id, created_at
         FROM reviews
         WHERE record_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(record.id) as
      | { id: string; action: string; record_version: number; reviewer_id: string; created_at: string }
      | undefined;

    if (
      lastRev &&
      lastRev.reviewer_id === req.auth!.user.id &&
      lastRev.record_version === record.version &&
      lastRev.action === action &&
      Date.now() - Date.parse(lastRev.created_at) < 5000
    ) {
      res.status(409).json({
        error: 'Duplicate review submission blocked: this decision was already recorded for this version moments ago.',
        reviewId: lastRev.id,
      });
      return;
    }

    let nextApproval: ApprovalState = 'NEEDS_REVISION';
    let approvedVersion: number | null = null;
    let nextEvidence = record.evidence_state;

    if (action === 'APPROVE') {
      nextApproval = 'APPROVED';
      approvedVersion = record.version;
    } else if (action === 'REJECT') {
      nextApproval = 'REJECTED';
    } else if (action === 'FLAG_GAP') {
      nextApproval = 'NEEDS_REVISION';
      nextEvidence = 'NOT_ESTABLISHED';
    }

    const nowIso = new Date().toISOString();
    const reviewId = `REV-${crypto.randomUUID().slice(0, 8)}`;

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE records
         SET approval_state = ?, approved_version = ?, evidence_state = ?, stage = '04'
         WHERE id = ?`
      ).run(nextApproval, approvedVersion, nextEvidence, record.id);

      db.prepare(
        `INSERT INTO reviews (id, record_id, record_version, reviewer_id, reviewer_name, action, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        reviewId,
        record.id,
        record.version,
        req.auth!.user.id,
        req.auth!.user.name,
        action,
        rationaleText,
        nowIso
      );
    });
    tx();

    runRadarScan(db, record.project_id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: `REVIEW_${action}`,
      targetType: 'RECORD',
      targetId: record.id,
      projectId: record.project_id,
      detail: { recordVersion: record.version, nextApproval, comment: rationaleText },
      ip: getClientIp(req),
    });

    res.json({
      reviewId,
      approval_state: nextApproval,
      approved_version: approvedVersion,
      evidence_state: nextEvidence,
    });
  });

  // Handover Routes
  app.get('/api/handovers', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res);
    if (!ctx) return;

    const role = ctx.memberRole;
    const projectId = ctx.projectId;
    const onlyPublished = role === 'INCOMING_MEMBER';
    const handovers = db
      .prepare(
        `SELECT * FROM handovers WHERE project_id = ? ${onlyPublished ? "AND status = 'PUBLISHED'" : ''}
         ORDER BY version DESC`
      )
      .all(projectId) as Array<Omit<HandoverDoc, 'items' | 'acknowledgements'>>;

    const result: HandoverDoc[] = handovers.map((h) => {
      const items = db
        .prepare(
          `SELECT hi.* FROM handover_items hi
           JOIN records r ON r.id = hi.record_id
           LEFT JOIN sources s ON s.id = r.source_id
           LEFT JOIN source_spans sp ON sp.id = r.span_id
           LEFT JOIN sources s2 ON s2.id = sp.source_id
           WHERE hi.handover_id = ?
             AND r.visibility_level = 'PROJECT_SHARED'
             AND r.approval_state != 'REJECTED'
             AND (s.id IS NULL OR s.visibility_level = 'PROJECT_SHARED')
             AND (s2.id IS NULL OR s2.visibility_level = 'PROJECT_SHARED')
           ORDER BY hi.record_id ASC`
        )
        .all(h.id) as HandoverDoc['items'];

      const redactedItems = items.map((item) => ({
        ...item,
        rendered_text: applyConfirmedRedactions(db, projectId, item.rendered_text),
        source_file: applyConfirmedRedactions(db, projectId, item.source_file),
      }));

      const acknowledgements = db
        .prepare(
          'SELECT id, user_id, user_name, note, acknowledged_at, handover_version FROM handover_acknowledgements WHERE handover_id = ? ORDER BY acknowledged_at DESC'
        )
        .all(h.id) as HandoverDoc['acknowledgements'];

      return {
        ...h,
        title: applyConfirmedRedactions(db, projectId, h.title),
        summary_md: applyConfirmedRedactions(db, projectId, h.summary_md),
        items: redactedItems,
        acknowledgements,
      };
    });

    const geminiAvailable = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    );

    const eligibleApprovedRecords =
      role === 'PI_LEAD' || role === 'RESEARCHER'
        ? db
            .prepare(
              `SELECT r.id, r.type, r.title, r.owner_name, r.evidence_state, r.approval_state, r.version
               FROM records r
               LEFT JOIN sources s ON s.id = r.source_id
               WHERE r.project_id = ?
                 AND r.visibility_level = 'PROJECT_SHARED'
                 AND r.exclude_from_ai = 0
                 AND r.approval_state = 'APPROVED'
                 AND (s.id IS NULL OR s.visibility_level = 'PROJECT_SHARED')
               ORDER BY r.id ASC`
            )
            .all(projectId)
        : [];

    const recipients = db
      .prepare(
        `SELECT u.id, u.name, u.email, pm.role
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ? AND pm.role IN ('INCOMING_MEMBER', 'RESEARCHER', 'PI_LEAD')
         ORDER BY u.name ASC`
      )
      .all(projectId);

    res.json({ handovers: result, geminiAvailable, eligibleApprovedRecords, recipients });
  });

  app.post('/api/handovers/generate', async (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    if (isPlainObject(req.body) && ('confidence_score' in req.body || 'truth_score' in req.body)) {
      res.status(422).json({ error: 'Confidence or truth scores are prohibited.' });
      return;
    }

    const preferAi = Boolean(isPlainObject(req.body) && req.body.useAi);
    const title = isPlainObject(req.body) && typeof req.body.title === 'string' ? req.body.title.slice(0, 180) : undefined;
    const recipientName =
      isPlainObject(req.body) && typeof req.body.recipientName === 'string'
        ? req.body.recipientName.slice(0, 120)
        : undefined;
    const recordIds =
      isPlainObject(req.body) && Array.isArray(req.body.recordIds)
        ? (req.body.recordIds as unknown[]).filter((x): x is string => typeof x === 'string' && isValidId(x))
        : undefined;

    const created = await createHandoverDraft(
      db,
      ctx.projectId,
      { ...req.auth!.user, role: ctx.memberRole },
      preferAi,
      { title, recipientName, recordIds }
    );
    res.status(201).json(created);
  });

  app.post('/api/handovers/:id/items/:itemId/check', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id) || !isValidId(req.params.itemId)) {
      res.status(400).json({ error: 'Invalid handover or item ID.' });
      return;
    }
    const item = db
      .prepare(
        `SELECT hi.id, hi.handover_id, hi.record_id, h.project_id
         FROM handover_items hi
         JOIN handovers h ON h.id = hi.handover_id
         WHERE hi.id = ? AND hi.handover_id = ?`
      )
      .get(req.params.itemId, req.params.id) as
      | { id: string; handover_id: string; record_id: string; project_id: string }
      | undefined;
    if (!item) {
      res.status(404).json({ error: 'Handover checklist item not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, item.project_id, req.auth!.user, ['INCOMING_MEMBER', 'PI_LEAD']);
    if (!ctx) return;

    const checked = isPlainObject(req.body) && req.body.checked ? 1 : 0;
    db.prepare('UPDATE handover_items SET recipient_checked = ? WHERE id = ?').run(checked, item.id);
    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'HANDOVER_ITEM_CHECKED',
      targetType: 'HANDOVER_ITEM',
      targetId: item.id,
      projectId: item.project_id,
      detail: { handoverId: item.handover_id, recordId: item.record_id, checked: checked === 1 },
      ip: getClientIp(req),
    });
    res.json({ ok: true, checked: checked === 1 });
  });

  app.post('/api/handovers/:id/publish', requireSensitiveAuth(db), (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid handover ID.' });
      return;
    }
    const rl = checkRateLimit(db, `sensitive:${req.auth!.user.id}:${getClientIp(req)}`, 40, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Rate limit exceeded for sensitive actions.');
      return;
    }

    const ho = db.prepare('SELECT id, project_id, status, version FROM handovers WHERE id = ?').get(req.params.id) as
      | { id: string; project_id: string; status: string; version: number }
      | undefined;
    if (!ho) {
      res.status(404).json({ error: 'Handover not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, ho.project_id, req.auth!.user, ['PI_LEAD']);
    if (!ctx) return;

    if (ho.status === 'PUBLISHED') {
      res.json({ ok: true, id: ho.id, status: 'PUBLISHED', alreadyPublished: true });
      return;
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE handovers SET status = 'PUBLISHED', published_by = ?, published_at = ? WHERE id = ?`
    ).run(req.auth!.user.email, nowIso, ho.id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'HANDOVER_PUBLISHED',
      targetType: 'HANDOVER',
      targetId: ho.id,
      projectId: ho.project_id,
      detail: { version: ho.version },
      ip: getClientIp(req),
    });

    res.json({ ok: true, id: ho.id, status: 'PUBLISHED', publishedAt: nowIso });
  });

  app.post('/api/handovers/:id/acknowledge', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid handover ID.' });
      return;
    }
    const ho = db.prepare('SELECT id, project_id, status, version FROM handovers WHERE id = ?').get(req.params.id) as
      | { id: string; project_id: string; status: string; version: number }
      | undefined;
    if (!ho || ho.status !== 'PUBLISHED') {
      res.status(404).json({ error: 'Published handover not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, ho.project_id, req.auth!.user, ['INCOMING_MEMBER', 'PI_LEAD']);
    if (!ctx) return;

    const note =
      isPlainObject(req.body) && typeof req.body.note === 'string' && req.body.note.trim()
        ? req.body.note.trim().slice(0, 500)
        : 'Receipt acknowledged (not agreement).';
    const nowIso = new Date().toISOString();
    const ackId = `ACK-${crypto.randomUUID().slice(0, 8)}`;

    db.prepare(
      `INSERT INTO handover_acknowledgements (id, handover_id, handover_version, user_id, user_name, note, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(handover_id, user_id) DO UPDATE SET
         note = excluded.note,
         handover_version = excluded.handover_version,
         acknowledged_at = excluded.acknowledged_at`
    ).run(ackId, ho.id, ho.version, req.auth!.user.id, req.auth!.user.name, note, nowIso);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'HANDOVER_RECEIPT_ACKNOWLEDGED',
      targetType: 'HANDOVER',
      targetId: ho.id,
      projectId: ho.project_id,
      detail: { version: ho.version, note },
      ip: getClientIp(req),
    });

    res.json({ ok: true, handoverVersion: ho.version, acknowledgedAt: nowIso });
  });

  app.delete('/api/handovers/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid handover ID.' });
      return;
    }
    const ho = db
      .prepare('SELECT id, project_id, version, title, status, created_by FROM handovers WHERE id = ?')
      .get(req.params.id) as
      | { id: string; project_id: string; version: number; title: string; status: string; created_by: string }
      | undefined;
    if (!ho) {
      res.status(404).json({ error: 'Handover not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, ho.project_id, req.auth!.user, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    const isPi = ctx.memberRole === 'PI_LEAD';
    const isDraftAuthor = ho.status === 'DRAFT' && ho.created_by === req.auth!.user.email;
    if (!isPi && !isDraftAuthor) {
      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'ACCESS_DENIED',
        targetType: 'HANDOVER',
        targetId: ho.id,
        projectId: ho.project_id,
        detail: { reason: 'Only PI Lead or draft author may delete this handover' },
        ip: getClientIp(req),
      });
      res.status(403).json({
        error: 'Only a PI Lead or the draft author (for unpublished drafts) can delete this handover.',
      });
      return;
    }

    db.prepare('DELETE FROM handovers WHERE id = ?').run(ho.id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'HANDOVER_DELETED',
      targetType: 'HANDOVER',
      targetId: ho.id,
      projectId: ho.project_id,
      detail: { version: ho.version, status: ho.status, title: ho.title },
      ip: getClientIp(req),
    });

    res.json({ ok: true, deletedId: ho.id });
  });

  // Team Workflow Chart, Session-Aware Presence & Project-Scoped Work Tracker
  app.get('/api/team', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res);
    if (!ctx) return;
    const isPi = ctx.memberRole === 'PI_LEAD';
    const projectId = ctx.projectId;
    const now = Date.now();

    const users = db
      .prepare(
        `SELECT u.id, u.name, u.email, pm.role, u.title, u.departing,
                p.current_route, p.current_record_id, p.last_seen_at,
                EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS has_active_session
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         LEFT JOIN presence p ON p.user_id = u.id
         WHERE pm.project_id = ?
         ORDER BY u.created_at ASC`
      )
      .all(now, projectId) as Array<{
      id: string;
      name: string;
      email: string;
      role: Role;
      title: string;
      departing: number;
      current_route: string | null;
      current_record_id: string | null;
      last_seen_at: number | null;
      has_active_session: number;
    }>;

    const records = db
      .prepare(
        `SELECT * FROM records WHERE project_id = ? ${isPi ? "AND visibility_level != 'PRIVATE_OWNER'" : "AND visibility_level = 'PROJECT_SHARED'"}
         ORDER BY id ASC`
      )
      .all(projectId) as ResearchRecord[];

    const userByEmail = new Map(users.map((u) => [u.email, u]));
    const members: TeamMemberStatus[] = users.map((u) => {
      const diff = u.last_seen_at ? now - u.last_seen_at : Infinity;
      // Presence accuracy: expired or logged-out users NEVER show as ONLINE/AWAY
      const presenceStatus: 'ONLINE' | 'AWAY' | 'OFFLINE' =
        u.has_active_session === 1 ? (diff < 30_000 ? 'ONLINE' : diff < 5 * 60_000 ? 'AWAY' : 'OFFLINE') : 'OFFLINE';

      const memberRecords = records.filter(
        (r) =>
          r.owner_user_id === u.id ||
          r.owner_name === u.name ||
          (u.role === 'REVIEWER' && (r.approval_state === 'NEEDS_REVIEW' || r.approval_state === 'NEEDS_REVISION')) ||
          (u.role === 'INCOMING_MEMBER' && r.stage === '05')
      );

      const sourcesUploaded = (
        db
          .prepare('SELECT COUNT(*) AS cnt FROM sources WHERE project_id = ? AND (uploaded_by_id = ? OR uploaded_by = ?)')
          .get(projectId, u.id, u.email) as { cnt: number }
      ).cnt;

      const notesCreated = (
        db
          .prepare('SELECT COUNT(*) AS cnt FROM notes WHERE project_id = ? AND author_id = ?')
          .get(projectId, u.id) as { cnt: number }
      ).cnt;

      const claimsEdited = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT rv.record_id) AS cnt
             FROM record_versions rv
             JOIN records r ON r.id = rv.record_id
             WHERE r.project_id = ? AND rv.edited_by = ?`
          )
          .get(projectId, u.email) as { cnt: number }
      ).cnt;

      const reviewsCompleted = (
        db
          .prepare(
            `SELECT COUNT(*) AS cnt
             FROM reviews rv
             JOIN records r ON r.id = rv.record_id
             WHERE r.project_id = ? AND rv.reviewer_id = ?`
          )
          .get(projectId, u.id) as { cnt: number }
      ).cnt;

      const handoversCreated = (
        db
          .prepare('SELECT COUNT(*) AS cnt FROM handovers WHERE project_id = ? AND created_by = ?')
          .get(projectId, u.email) as { cnt: number }
      ).cnt;

      const workAuditRows = db
        .prepare(
          `SELECT id, timestamp, action, target_type, target_id, actor_email, actor_role
           FROM audit_logs
           WHERE actor_email = ?
             AND (project_id = ? OR project_id IS NULL)
             AND action NOT IN ('LOGIN_SUCCESS','LOGIN_FAILED','LOGIN_LOCKED','ACCOUNT_LOCKED_OUT','LOGOUT','CAMERA_LOGIN_REJECTED','CAMERA_CHECK_COMPLETED','CAMERA_CHECK_SKIPPED','REAUTH_SUCCESS','REAUTH_FAILED','REDACTION_ORIGINAL_REVEALED','ACCESS_DENIED','CSRF_REJECTED','PRIVILEGED_REGISTRATION_ATTEMPTED')
           ORDER BY id DESC LIMIT 6`
        )
        .all(u.email, projectId) as Array<{
        id: number;
        timestamp: string;
        action: string;
        target_type: string;
        target_id: string;
        actor_email: string;
        actor_role: string;
      }>;

      const claimsWorked = Math.max(memberRecords.length, claimsEdited);
      const totalActions = sourcesUploaded + notesCreated + claimsWorked + reviewsCompleted + handoversCreated;

      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        title: u.title,
        departing: u.departing === 1,
        presence_status: presenceStatus,
        current_route: presenceStatus === 'OFFLINE' ? null : u.current_route,
        current_record_id: presenceStatus === 'OFFLINE' ? null : u.current_record_id,
        last_seen_at: u.last_seen_at ? new Date(u.last_seen_at).toISOString() : null,
        open_records: memberRecords,
        work_summary: {
          sourcesUploaded,
          notesCreated,
          claimsWorked,
          reviewsCompleted,
          handoversCreated,
          totalActions,
        },
        recent_actions: workAuditRows.map((a) => ({
          ...a,
          actor_name: u.name,
        })),
      };
    });

    const teamActivityRows = db
      .prepare(
        `SELECT id, timestamp, actor_email, actor_role, action, target_type, target_id
         FROM audit_logs
         WHERE (project_id = ? OR project_id IS NULL)
           AND action NOT IN ('LOGIN_FAILED','LOGIN_LOCKED','ACCOUNT_LOCKED_OUT','REAUTH_FAILED','REDACTION_ORIGINAL_REVEALED','CAMERA_LOGIN_REJECTED','PRIVILEGED_REGISTRATION_ATTEMPTED')
         ORDER BY id DESC LIMIT 30`
      )
      .all(projectId) as Array<{
      id: number;
      timestamp: string;
      actor_email: string;
      actor_role: string;
      action: string;
      target_type: string;
      target_id: string;
    }>;

    const team_activity = teamActivityRows.map((row) => ({
      ...row,
      actor_name: userByEmail.get(row.actor_email)?.name || row.actor_email,
    }));

    res.json({ members, team_activity });
  });

  app.patch('/api/team/members/:id', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD']);
    if (!ctx) return;
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid user ID.' });
      return;
    }
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const { departing, role } = req.body as { departing?: unknown; role?: unknown };
    const target = db
      .prepare(
        `SELECT u.id, pm.role, u.departing
         FROM users u JOIN project_members pm ON pm.user_id = u.id
         WHERE u.id = ? AND pm.project_id = ?`
      )
      .get(req.params.id, ctx.projectId) as { id: string; role: Role; departing: number } | undefined;
    if (!target) {
      res.status(404).json({ error: 'Member not found in this project.' });
      return;
    }

    if (role !== undefined && !isValidRole(role)) {
      res.status(400).json({ error: 'Invalid role value.' });
      return;
    }
    const nextRole = role !== undefined ? (role as Role) : target.role;
    const nextDeparting = typeof departing === 'boolean' ? (departing ? 1 : 0) : target.departing;

    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET departing = ? WHERE id = ?').run(nextDeparting, target.id);
      db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(
        nextRole,
        ctx.projectId,
        target.id
      );
      if (ctx.projectId === DEFAULT_PROJECT_ID) {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextRole, target.id);
      }
      if (nextRole !== target.role && target.id !== req.auth!.user.id) {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      }
    });
    tx();

    runRadarScan(db, ctx.projectId);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'MEMBER_UPDATED',
      targetType: 'USER',
      targetId: target.id,
      projectId: ctx.projectId,
      detail: { nextRole, departing: nextDeparting === 1 },
      ip: getClientIp(req),
    });

    res.json({ ok: true });
  });

  // Knowledge-Debt Radar (non-destructive resolution & rich metadata)
  app.get('/api/radar', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;
    const isPi = ctx.memberRole === 'PI_LEAD';

    const rows = db
      .prepare(
        `SELECT rf.*, r.type, r.title, r.owner_name AS rec_owner_name, r.source_file, r.locator, r.evidence_state, r.approval_state, r.excerpt, r.visibility_level,
                sp.content AS span_content
         FROM radar_findings rf
         JOIN records r ON r.id = rf.record_id
         LEFT JOIN source_spans sp ON sp.id = r.span_id
         WHERE rf.project_id = ? AND rf.inactive = 0 ${isPi ? "AND r.visibility_level != 'PRIVATE_OWNER'" : "AND r.visibility_level = 'PROJECT_SHARED'"}
         ORDER BY rf.resolved ASC, rf.priority_points DESC, rf.record_id ASC`
      )
      .all(ctx.projectId) as Array<{
      id: string;
      project_id: string;
      record_id: string;
      priority_points: number;
      band: 'HIGH' | 'MEDIUM' | 'LOW';
      reasons_json: string;
      suggested_followup: string;
      resolved: number;
      scanned_at: string;
      risk_category: string;
      owner_name: string | null;
      evidence_snapshot_json: string | null;
      created_at: string | null;
      resolved_at: string | null;
      resolved_by: string | null;
      inactive: number;
      type: string;
      title: string;
      rec_owner_name: string | null;
      source_file: string;
      locator: string;
      evidence_state: EvidenceState;
      approval_state: ApprovalState;
      excerpt: string;
      visibility_level: VisibilityLevel;
      span_content: string | null;
    }>;

    const findings = rows.map((row) => ({
      id: row.id,
      project_id: row.project_id,
      record_id: row.record_id,
      priority_points: row.priority_points,
      band: row.band,
      reasons: parseJsonSafe<string[]>(row.reasons_json, []),
      suggested_followup: row.suggested_followup,
      resolved: row.resolved === 1,
      scanned_at: row.scanned_at,
      risk_category: row.risk_category,
      owner_name: row.owner_name ?? row.rec_owner_name,
      evidence_snapshot: parseJsonSafe<Record<string, unknown>>(row.evidence_snapshot_json, {}),
      created_at: row.created_at,
      resolved_at: row.resolved_at,
      resolved_by: row.resolved_by,
      inactive: row.inactive === 1,
      record: {
        id: row.record_id,
        type: row.type,
        title: row.title,
        owner_name: row.rec_owner_name,
        source_file: row.source_file,
        locator: row.locator,
        evidence_state: row.evidence_state,
        approval_state: row.approval_state,
        excerpt: applyConfirmedRedactions(db, ctx.projectId, row.excerpt),
        visibility_level: row.visibility_level,
        span_content: row.span_content ? applyConfirmedRedactions(db, ctx.projectId, row.span_content) : null,
      },
    }));

    const assignableUsers = db
      .prepare(
        `SELECT u.id, u.name, pm.role, u.departing
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ? ORDER BY u.name ASC`
      )
      .all(ctx.projectId);

    const lastScannedAt = findings.length > 0 ? findings[0].scanned_at : null;
    res.json({ findings, assignableUsers, lastScannedAt });
  });

  app.post('/api/radar/scan', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;
    const count = runRadarScan(db, ctx.projectId, { ...req.auth!.user, role: ctx.memberRole });
    res.json({ ok: true, count });
  });

  app.post('/api/radar/findings/:id/resolve', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid finding ID.' });
      return;
    }
    const finding = db
      .prepare(
        `SELECT rf.id, rf.project_id, rf.record_id, rf.resolved, r.visibility_level
         FROM radar_findings rf
         JOIN records r ON r.id = rf.record_id
         WHERE rf.id = ?`
      )
      .get(req.params.id) as
      | { id: string; project_id: string; record_id: string; resolved: number; visibility_level: string }
      | undefined;
    if (!finding) {
      res.status(404).json({ error: 'Radar finding not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, finding.project_id, req.auth!.user, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    if (finding.visibility_level === 'RESTRICTED_PI_ONLY' && ctx.memberRole !== 'PI_LEAD') {
      res.status(403).json({ error: 'Restricted finding.' });
      return;
    }

    const nextResolved = isPlainObject(req.body) && req.body.resolved === false ? 0 : 1;
    const nowIso = new Date().toISOString();

    db.prepare(
      `UPDATE radar_findings
       SET resolved = ?, resolved_at = ?, resolved_by = ?
       WHERE id = ?`
    ).run(nextResolved, nextResolved === 1 ? nowIso : null, nextResolved === 1 ? req.auth!.user.email : null, finding.id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: nextResolved === 1 ? 'RADAR_FINDING_RESOLVED' : 'RADAR_FINDING_REOPENED',
      targetType: 'RADAR_FINDING',
      targetId: finding.id,
      projectId: finding.project_id,
      detail: { recordId: finding.record_id, resolved: nextResolved === 1 },
      ip: getClientIp(req),
    });

    res.json({ ok: true, resolved: nextResolved === 1, resolvedAt: nextResolved === 1 ? nowIso : null });
  });

  // Cold-Start Handover Test (evaluation privacy, 10 categories, concept matcher, run ownership)
  app.get('/api/coldstart', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'INCOMING_MEMBER']);
    if (!ctx) return;

    const latestPublished = db
      .prepare(
        `SELECT id, version, title, published_at FROM handovers
         WHERE project_id = ? AND status = 'PUBLISHED' ORDER BY version DESC LIMIT 1`
      )
      .get(ctx.projectId) as { id: string; version: number; title: string; published_at: string } | undefined;

    if (!latestPublished) {
      res.json({ handover: null, questions: [], coverageGaps: [], untestedRecords: [], runs: [] });
      return;
    }

    const built = buildColdStartQuestions(db, ctx.projectId, latestPublished.id);

    // Evaluation Privacy:
    // INCOMING_MEMBER sees strictly their own runs; PI_LEAD sees runs for project governance.
    const runs = (
      ctx.memberRole === 'PI_LEAD'
        ? db
            .prepare(
              `SELECT * FROM coldstart_runs
               WHERE handover_id IN (SELECT id FROM handovers WHERE project_id = ?)
               ORDER BY created_at DESC LIMIT 20`
            )
            .all(ctx.projectId)
        : db
            .prepare(
              `SELECT * FROM coldstart_runs
               WHERE handover_id IN (SELECT id FROM handovers WHERE project_id = ?) AND user_id = ?
               ORDER BY created_at DESC LIMIT 20`
            )
            .all(ctx.projectId, req.auth!.user.id)
    ) as Array<{
      id: string;
      handover_id: string;
      handover_version: number;
      user_id: string;
      user_name: string;
      total_questions: number;
      answerable_questions: number;
      evaluation_mode?: string;
      coverage_summary_json?: string;
      questions_json: string;
      coverage_gaps_json: string;
      untested_records_json: string;
      created_at: string;
    }>;

    res.json({
      handover: latestPublished,
      questions: built.questions,
      coverageGaps: built.coverageGaps,
      untestedRecords: built.untestedRecords,
      answerableCount: built.questions.filter((q) => q.answerable_from_handover).length,
      totalCount: built.questions.length,
      runs: runs.map((r) => ({
        id: r.id,
        handover_id: r.handover_id,
        handover_version: r.handover_version,
        user_id: r.user_id,
        user_name: r.user_name,
        total_questions: r.total_questions,
        answerable_questions: r.answerable_questions,
        evaluation_mode: r.evaluation_mode || 'deterministic-concept-matcher',
        coverage_summary: parseJsonSafe(r.coverage_summary_json, undefined),
        questions: parseJsonSafe(r.questions_json, []),
        coverage_gaps: parseJsonSafe(r.coverage_gaps_json, []),
        untested_records: parseJsonSafe(r.untested_records_json, []),
        created_at: r.created_at,
      })),
    });
  });

  app.get('/api/coldstart/runs/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid Cold-Start run ID.' });
      return;
    }
    const run = db
      .prepare(
        `SELECT cr.*, h.project_id
         FROM coldstart_runs cr
         JOIN handovers h ON h.id = cr.handover_id
         WHERE cr.id = ?`
      )
      .get(req.params.id) as
      | ({
          id: string;
          handover_id: string;
          handover_version: number;
          user_id: string;
          user_name: string;
          total_questions: number;
          answerable_questions: number;
          evaluation_mode?: string;
          coverage_summary_json?: string;
          questions_json: string;
          coverage_gaps_json: string;
          untested_records_json: string;
          created_at: string;
          project_id: string;
        })
      | undefined;

    if (!run) {
      res.status(404).json({ error: 'Cold-Start evaluation run not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, run.project_id, req.auth!.user, ['PI_LEAD', 'INCOMING_MEMBER']);
    if (!ctx) return;

    if (ctx.memberRole !== 'PI_LEAD' && run.user_id !== req.auth!.user.id) {
      appendAudit(db, {
        actorUserId: req.auth!.user.id,
        actorEmail: req.auth!.user.email,
        actorRole: ctx.memberRole,
        action: 'ACCESS_DENIED',
        targetType: 'COLDSTART_RUN',
        targetId: run.id,
        projectId: run.project_id,
        detail: { reason: 'Cross-user private Cold-Start run access blocked' },
        ip: getClientIp(req),
      });
      res.status(403).json({ error: 'Access denied: you may only retrieve your own Cold-Start runs.' });
      return;
    }

    res.json({
      run: {
        id: run.id,
        handover_id: run.handover_id,
        handover_version: run.handover_version,
        user_id: run.user_id,
        user_name: run.user_name,
        total_questions: run.total_questions,
        answerable_questions: run.answerable_questions,
        evaluation_mode: run.evaluation_mode || 'deterministic-concept-matcher',
        coverage_summary: parseJsonSafe(run.coverage_summary_json, undefined),
        questions: parseJsonSafe(run.questions_json, []),
        coverage_gaps: parseJsonSafe(run.coverage_gaps_json, []),
        untested_records: parseJsonSafe(run.untested_records_json, []),
        created_at: run.created_at,
      },
    });
  });

  app.post('/api/coldstart/submit', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'INCOMING_MEMBER']);
    if (!ctx) return;

    const latestPublished = db
      .prepare(
        `SELECT id, version FROM handovers
         WHERE project_id = ? AND status = 'PUBLISHED' ORDER BY version DESC LIMIT 1`
      )
      .get(ctx.projectId) as { id: string; version: number } | undefined;

    if (!latestPublished) {
      res.status(404).json({ error: 'No published handover available for Cold-Start test.' });
      return;
    }

    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }

    const rawAnswers = req.body.answers;
    if (rawAnswers !== undefined && !isPlainObject(rawAnswers)) {
      res.status(400).json({ error: 'answers must be an object mapping question IDs to strings.' });
      return;
    }
    const answers: Record<string, string> = {};
    if (isPlainObject(rawAnswers)) {
      for (const [k, v] of Object.entries(rawAnswers)) {
        if (typeof v === 'string') answers[k] = v.slice(0, 4000);
      }
    }

    const forceNewAttempt = Boolean(req.body.forceNewAttempt);

    // Prevent accidental rapid duplicate runs unless explicitly requested as a new attempt
    if (!forceNewAttempt) {
      const recentRun = db
        .prepare(
          `SELECT id, created_at FROM coldstart_runs
           WHERE handover_id = ? AND user_id = ?
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(latestPublished.id, req.auth!.user.id) as { id: string; created_at: string } | undefined;
      if (recentRun && Date.now() - Date.parse(recentRun.created_at) < 4000) {
        res.status(409).json({
          error: 'Duplicate Cold-Start submission prevented. Wait a moment or choose "Start Intentional New Attempt".',
          existingRunId: recentRun.id,
        });
        return;
      }
    }

    const evaluated = evaluateColdStartRun(db, ctx.projectId, latestPublished.id, answers);
    const runId = `CSR-${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO coldstart_runs
        (id, handover_id, handover_version, user_id, user_name, total_questions, answerable_questions,
         evaluation_mode, coverage_summary_json, questions_json, coverage_gaps_json, untested_records_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      latestPublished.id,
      latestPublished.version,
      req.auth!.user.id,
      req.auth!.user.name,
      evaluated.totalCount,
      evaluated.answerableCount,
      evaluated.summary.evaluationMode,
      JSON.stringify(evaluated.summary),
      JSON.stringify(evaluated.questions),
      JSON.stringify(evaluated.coverageGaps),
      JSON.stringify(evaluated.untestedRecords),
      nowIso
    );

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'COLDSTART_RUN_SAVED',
      targetType: 'HANDOVER',
      targetId: latestPublished.id,
      projectId: ctx.projectId,
      detail: {
        runId,
        handoverVersion: latestPublished.version,
        answerable: evaluated.answerableCount,
        total: evaluated.totalCount,
        knowledgeCoveragePct: evaluated.summary.knowledgeCoveragePct,
      },
      ip: getClientIp(req),
    });

    res.status(201).json({
      run: {
        id: runId,
        handover_id: latestPublished.id,
        handover_version: latestPublished.version,
        user_id: req.auth!.user.id,
        user_name: req.auth!.user.name,
        total_questions: evaluated.totalCount,
        answerable_questions: evaluated.answerableCount,
        evaluation_mode: evaluated.summary.evaluationMode,
        coverage_summary: evaluated.summary,
        questions: evaluated.questions,
        coverage_gaps: evaluated.coverageGaps,
        untested_records: evaluated.untestedRecords,
        created_at: nowIso,
      },
    });
  });

  app.delete('/api/coldstart/runs/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid Cold-Start run ID.' });
      return;
    }
    const run = db
      .prepare(
        `SELECT cr.id, cr.handover_id, cr.handover_version, cr.user_id, h.project_id
         FROM coldstart_runs cr JOIN handovers h ON h.id = cr.handover_id
         WHERE cr.id = ?`
      )
      .get(req.params.id) as
      | { id: string; handover_id: string; handover_version: number; user_id: string; project_id: string }
      | undefined;
    if (!run) {
      res.status(404).json({ error: 'Cold-Start evaluation run not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, run.project_id, req.auth!.user, ['PI_LEAD', 'INCOMING_MEMBER']);
    if (!ctx) return;

    if (ctx.memberRole !== 'PI_LEAD' && run.user_id !== req.auth!.user.id) {
      res.status(403).json({ error: 'You can only delete your own Cold-Start evaluation runs.' });
      return;
    }

    db.prepare('DELETE FROM coldstart_runs WHERE id = ?').run(run.id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'COLDSTART_RUN_DELETED',
      targetType: 'COLDSTART_RUN',
      targetId: run.id,
      projectId: run.project_id,
      detail: { handoverId: run.handover_id, handoverVersion: run.handover_version },
      ip: getClientIp(req),
    });

    res.json({ ok: true, deletedId: run.id });
  });

  // Helper to verify access to a redaction proposal's underlying target within a project
  function checkRedactionTargetAccess(
    prop: { project_id: string; target_type: string; target_id: string },
    user: { id: string; email: string; role: Role },
    memberRole: Role
  ): { ok: true; visibility: string; label: string } | { ok: false; status: number; error: string } {
    if (prop.target_type === 'SOURCE') {
      const src = db
        .prepare('SELECT title, visibility_level, uploaded_by, uploaded_by_id FROM sources WHERE id = ? AND project_id = ?')
        .get(prop.target_id, prop.project_id) as
        | { title: string; visibility_level: string; uploaded_by: string; uploaded_by_id: string }
        | undefined;
      if (!src) {
        return { ok: false, status: 404, error: 'Target source for this redaction proposal no longer exists.' };
      }
      if (!canUserAccessSource(src, user, memberRole)) {
        return { ok: false, status: 403, error: 'Restricted or private redaction proposal.' };
      }
      return { ok: true, visibility: src.visibility_level, label: src.title };
    }

    const rec = db
      .prepare('SELECT title, visibility_level, owner_user_id FROM records WHERE id = ? AND project_id = ?')
      .get(prop.target_id, prop.project_id) as
      | { title: string; visibility_level: string; owner_user_id: string | null }
      | undefined;
    if (!rec) {
      return { ok: false, status: 404, error: 'Target record for this redaction proposal no longer exists.' };
    }
    if (!canUserAccessRecord(rec, user.id, memberRole)) {
      return { ok: false, status: 403, error: 'Restricted or private redaction proposal.' };
    }
    return { ok: true, visibility: rec.visibility_level, label: `${prop.target_id}: ${rec.title}` };
  }

  // Sensitive Content & Redactions
  app.get('/api/redactions', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    const rows = db
      .prepare('SELECT * FROM redaction_proposals WHERE project_id = ? ORDER BY status ASC, created_at DESC')
      .all(ctx.projectId) as Array<{
      id: string;
      project_id: string;
      target_type: 'SOURCE' | 'RECORD';
      target_id: string;
      span_id: string | null;
      category: 'EMAIL' | 'PHONE' | 'SECRET' | 'ID_NUMBER' | 'RESTRICTED_KEYWORD';
      matched_text: string;
      context_snippet: string;
      replacement: string;
      status: 'PROPOSED' | 'CONFIRMED' | 'REJECTED';
      reviewed_by: string | null;
      reviewed_at: string | null;
      created_at: string;
      locator?: string;
      confidence_label?: 'HIGH' | 'MEDIUM' | 'LOW';
      confidence_reason?: string;
      history_json?: string;
    }>;

    const proposals = [];
    for (const r of rows) {
      const access = checkRedactionTargetAccess(r, req.auth!.user, ctx.memberRole);
      if (access.ok === false) continue;

      const masked = maskSensitiveMatch(r.matched_text, r.category);
      const maskedSnippet = r.context_snippet.split(r.matched_text).join(masked);
      proposals.push({
        id: r.id,
        project_id: r.project_id,
        target_type: r.target_type,
        target_id: r.target_id,
        span_id: r.span_id,
        category: r.category,
        matched_text: masked,
        masked_preview: masked,
        context_snippet: maskedSnippet,
        replacement: r.replacement,
        status: r.status,
        reviewed_by: r.reviewed_by,
        reviewed_at: r.reviewed_at,
        created_at: r.created_at,
        target_label: access.label,
        locator: r.locator || '',
        confidence_label: r.confidence_label || 'MEDIUM',
        confidence_reason: r.confidence_reason || '',
        history: parseJsonSafe(r.history_json, []),
      });
    }

    res.json({ proposals });
  });

  app.post('/api/redactions/scan', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    const scope = isPlainObject(req.body) && typeof req.body.scope === 'string' ? req.body.scope : 'SHARED';
    if (scope === 'RESTRICTED' && ctx.memberRole !== 'PI_LEAD') {
      res.status(403).json({ error: 'Only a PI Lead can run restricted source redaction scanning.' });
      return;
    }

    const created = scanSensitiveContentForProject(db, ctx.projectId, {
      actor: { ...req.auth!.user, role: ctx.memberRole },
      includeRestricted: ctx.memberRole === 'PI_LEAD' && (scope === 'ALL' || scope === 'RESTRICTED'),
      includePrivateForUserId: scope === 'PRIVATE' ? req.auth!.user.id : undefined,
    });

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'REDACTION_SCAN_RUN',
      targetType: 'PROJECT',
      targetId: ctx.projectId,
      projectId: ctx.projectId,
      detail: { newProposals: created, scope },
      ip: getClientIp(req),
    });
    res.json({ ok: true, created });
  });

  app.post('/api/redactions/:id/resolve', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid proposal ID.' });
      return;
    }
    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: 'Invalid request body.' });
      return;
    }
    const { decision, note } = req.body as { decision?: unknown; note?: unknown };
    if (decision !== 'CONFIRMED' && decision !== 'REJECTED' && decision !== 'PROPOSED') {
      res.status(400).json({ error: 'Decision must be CONFIRMED, REJECTED, or PROPOSED.' });
      return;
    }

    const prop = db.prepare('SELECT * FROM redaction_proposals WHERE id = ?').get(req.params.id) as
      | {
          id: string;
          project_id: string;
          target_type: 'SOURCE' | 'RECORD';
          target_id: string;
          category: string;
          status: string;
          history_json?: string;
        }
      | undefined;
    if (!prop) {
      res.status(404).json({ error: 'Redaction proposal not found.' });
      return;
    }

    const ctx = checkMembershipAndRole(db, req, res, prop.project_id, req.auth!.user, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    const access = checkRedactionTargetAccess(prop, req.auth!.user, ctx.memberRole);
    if (access.ok === false) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const nowIso = new Date().toISOString();
    const prevHistory = parseJsonSafe<Array<Record<string, unknown>>>(prop.history_json, []);
    const nextHistory = [
      ...prevHistory,
      {
        action: decision,
        previousStatus: prop.status,
        actor: req.auth!.user.email,
        at: nowIso,
        note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 240) : undefined,
      },
    ];

    db.prepare(
      'UPDATE redaction_proposals SET status = ?, reviewed_by = ?, reviewed_at = ?, history_json = ? WHERE id = ?'
    ).run(decision, req.auth!.user.email, nowIso, JSON.stringify(nextHistory), prop.id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action:
        decision === 'CONFIRMED'
          ? 'REDACTION_CONFIRMED'
          : decision === 'REJECTED'
            ? 'REDACTION_REJECTED'
            : 'REDACTION_REOPENED',
      targetType: 'REDACTION',
      targetId: prop.id,
      projectId: prop.project_id,
      detail: { category: prop.category, targetId: prop.target_id, previousStatus: prop.status, nextStatus: decision },
      ip: getClientIp(req),
    });

    res.json({ ok: true, status: decision });
  });

  app.post('/api/redactions/:id/reveal', requireSensitiveAuth(db), (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid proposal ID.' });
      return;
    }
    const rl = checkRateLimit(db, `sensitive:${req.auth!.user.id}:${getClientIp(req)}`, 40, 15 * 60 * 1000);
    if (!rl.allowed) {
      sendRateLimit429(res, rl.retryAfterSec, 'Rate limit exceeded for sensitive reveal actions.');
      return;
    }

    const prop = db
      .prepare('SELECT id, project_id, target_type, target_id, matched_text, context_snippet FROM redaction_proposals WHERE id = ?')
      .get(req.params.id) as
      | {
          id: string;
          project_id: string;
          target_type: 'SOURCE' | 'RECORD';
          target_id: string;
          matched_text: string;
          context_snippet: string;
        }
      | undefined;
    if (!prop) {
      res.status(404).json({ error: 'Redaction proposal not found.' });
      return;
    }

    const ctx = checkMembershipAndRole(db, req, res, prop.project_id, req.auth!.user, ['PI_LEAD']);
    if (!ctx) return;

    const access = checkRedactionTargetAccess(prop, req.auth!.user, ctx.memberRole);
    if (access.ok === false) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'REDACTION_ORIGINAL_REVEALED',
      targetType: 'REDACTION',
      targetId: prop.id,
      projectId: prop.project_id,
      ip: getClientIp(req),
    });

    res.json({
      id: prop.id,
      original_matched_text: prop.matched_text,
      original_context_snippet: prop.context_snippet,
    });
  });

  app.delete('/api/redactions/:id', (req: AuthedRequest, res: Response) => {
    if (!isValidId(req.params.id)) {
      res.status(400).json({ error: 'Invalid proposal ID.' });
      return;
    }
    const prop = db
      .prepare('SELECT id, project_id, target_type, target_id, category FROM redaction_proposals WHERE id = ?')
      .get(req.params.id) as
      | { id: string; project_id: string; target_type: string; target_id: string; category: string }
      | undefined;
    if (!prop) {
      res.status(404).json({ error: 'Redaction proposal not found.' });
      return;
    }
    const ctx = checkMembershipAndRole(db, req, res, prop.project_id, req.auth!.user, ['PI_LEAD', 'RESEARCHER']);
    if (!ctx) return;

    const access = checkRedactionTargetAccess(prop, req.auth!.user, ctx.memberRole);
    if (access.ok === false && access.status === 403) {
      res.status(403).json({ error: 'Restricted proposal.' });
      return;
    }

    db.prepare('DELETE FROM redaction_proposals WHERE id = ?').run(prop.id);

    appendAudit(db, {
      actorUserId: req.auth!.user.id,
      actorEmail: req.auth!.user.email,
      actorRole: ctx.memberRole,
      action: 'REDACTION_DELETED',
      targetType: 'REDACTION',
      targetId: prop.id,
      projectId: prop.project_id,
      detail: { category: prop.category, targetType: prop.target_type, targetId: prop.target_id },
      ip: getClientIp(req),
    });

    res.json({ ok: true, deletedId: prop.id });
  });

  // Audit Log (project-scoped, paginated, strict membership & role checks)
  app.get('/api/audit', (req: AuthedRequest, res: Response) => {
    const ctx = resolveAuthorizedProject(db, req, res, ['PI_LEAD', 'AUDITOR']);
    if (!ctx) return;

    const pag = validatePagination(req.query.limit, req.query.offset, 250);
    if (pag.ok === false) {
      res.status(400).json({ error: pag.error });
      return;
    }

    const actionFilter =
      typeof req.query.action === 'string' && req.query.action.trim() ? req.query.action.trim().slice(0, 80) : null;

    const rows = (
      actionFilter
        ? db
            .prepare(
              `SELECT * FROM audit_logs
               WHERE (project_id = ? OR project_id IS NULL) AND action = ?
               ORDER BY id DESC LIMIT ? OFFSET ?`
            )
            .all(ctx.projectId, actionFilter, pag.limit, pag.offset)
        : db
            .prepare(
              `SELECT * FROM audit_logs
               WHERE (project_id = ? OR project_id IS NULL)
               ORDER BY id DESC LIMIT ? OFFSET ?`
            )
            .all(ctx.projectId, pag.limit, pag.offset)
    ) as Array<{
      id: number;
      timestamp: string;
      actor_user_id: string | null;
      actor_email: string;
      actor_role: string;
      action: string;
      target_type: string;
      target_id: string;
      detail_json: string;
      ip: string | null;
    }>;

    res.json({
      logs: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        actor_user_id: r.actor_user_id,
        actor_email: r.actor_email,
        actor_role: r.actor_role,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        detail: parseJsonSafe(r.detail_json, {}),
        ip: r.ip,
      })),
    });
  });
}
