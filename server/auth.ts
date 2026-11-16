import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthUser, Role } from '../src/types.ts';
import { appendAudit } from './db.ts';

export const SESSION_COOKIE_NAME = 'baton_session';
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REAUTH_WINDOW_MS = 15 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Resolves the client IP using Express's `trust proxy` setting (`req.ip`)
 * instead of parsing untrusted client X-Forwarded-For headers directly.
 */
export function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

export interface AuthenticatedSession {
  sessionId: string;
  csrfToken: string;
  cameraVerified: boolean;
  reauthUntil: number | null;
  hasSensitiveAuth: boolean;
  user: AuthUser;
}

export interface AuthedRequest extends Request {
  auth?: AuthenticatedSession;
}

interface SessionJoinRow {
  session_id: string;
  csrf_token: string;
  camera_verified: number;
  reauth_until: number | null;
  expires_at: number;
  user_id: string;
  email: string;
  name: string;
  role: Role;
  title: string;
  departing: number;
}

export function loadSessionFromRequest(db: Database.Database, req: Request): AuthenticatedSession | null {
  const cookieSid = req.cookies?.[SESSION_COOKIE_NAME];
  const headerSid = req.headers['x-baton-session'];
  const sessionId =
    typeof cookieSid === 'string' && cookieSid
      ? cookieSid
      : typeof headerSid === 'string' && headerSid
        ? headerSid
        : null;
  if (!sessionId || sessionId.length > 128) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.csrf_token, s.camera_verified, s.reauth_until, s.expires_at,
              u.id AS user_id, u.email, u.name, u.role, u.title, u.departing
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(sessionId) as SessionJoinRow | undefined;

  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }

  // SECURITY: Sensitive actions ALWAYS require password-verified re-authentication.
  // Camera presence check is strictly informational local preview and NEVER satisfies sensitive auth.
  const hasSensitiveAuth = row.reauth_until !== null && row.reauth_until > now;

  return {
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    cameraVerified: row.camera_verified === 1,
    reauthUntil: row.reauth_until,
    hasSensitiveAuth,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      title: row.title,
      departing: row.departing === 1,
    },
  };
}

export function createAuthMiddleware(db: Database.Database) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const auth = loadSessionFromRequest(db, req);
    if (!auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    req.auth = auth;

    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const providedCsrf = req.headers['x-csrf-token'];
      if (
        typeof providedCsrf !== 'string' ||
        providedCsrf.length !== auth.csrfToken.length ||
        !crypto.timingSafeEqual(Buffer.from(providedCsrf), Buffer.from(auth.csrfToken))
      ) {
        appendAudit(db, {
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          actorRole: auth.user.role,
          action: 'CSRF_REJECTED',
          targetType: 'ENDPOINT',
          targetId: req.originalUrl,
          detail: { method },
          ip: getClientIp(req),
        });
        res.status(403).json({ error: 'Invalid or missing CSRF token.' });
        return;
      }
    }

    next();
  };
}

export function requireRole(db: Database.Database, allowedRoles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowedRoles.includes(auth.user.role)) {
      appendAudit(db, {
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'ACCESS_DENIED',
        targetType: 'ENDPOINT',
        targetId: req.originalUrl,
        detail: { allowedRoles, method: req.method },
        ip: getClientIp(req),
      });
      res.status(403).json({ error: 'Access denied for your role.' });
      return;
    }
    next();
  };
}

export function requireSensitiveAuth(db: Database.Database) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!auth.hasSensitiveAuth) {
      appendAudit(db, {
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        actorRole: auth.user.role,
        action: 'SENSITIVE_AUTH_REQUIRED',
        targetType: 'ENDPOINT',
        targetId: req.originalUrl,
        detail: { reason: 'Password re-authentication required for sensitive action' },
        ip: getClientIp(req),
      });
      res.status(403).json({
        error: 'Sensitive action requires password re-entry within the last 15 minutes.',
        code: 'SENSITIVE_AUTH_REQUIRED',
      });
      return;
    }
    next();
  };
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  failed_attempts: number;
  locked_until: number | null;
  title: string;
  departing: number;
}

export function rotateUserSession(
  db: Database.Database,
  oldSessionId: string | null,
  userId: string,
  options?: { reauthUntil?: number | null; cameraVerified?: boolean }
): { sessionId: string; csrfToken: string } {
  const now = Date.now();
  const newSessionId = crypto.randomBytes(32).toString('hex');
  const newCsrfToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = now + SESSION_TTL_MS;
  const cameraVerified = options?.cameraVerified ? 1 : 0;
  const reauthUntil = options?.reauthUntil ?? null;

  const tx = db.transaction(() => {
    if (oldSessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(oldSessionId);
    }
    db.prepare(
      `INSERT INTO sessions (id, user_id, csrf_token, camera_verified, reauth_until, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(newSessionId, userId, newCsrfToken, cameraVerified, reauthUntil, expiresAt, new Date(now).toISOString());
  });
  tx();

  return { sessionId: newSessionId, csrfToken: newCsrfToken };
}

export function attemptLogin(
  db: Database.Database,
  emailRaw: string,
  password: string,
  ip: string,
  existingSessionId?: string | null
): {
  ok: boolean;
  status: number;
  error?: string;
  sessionId?: string;
  csrfToken?: string;
  user?: AuthUser;
} {
  const email = emailRaw.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email) as UserRow | undefined;
  const now = Date.now();

  if (!user) {
    appendAudit(db, {
      actorEmail: email || 'unknown',
      actorRole: 'ANONYMOUS',
      action: 'LOGIN_FAILED',
      targetType: 'AUTH',
      targetId: email || 'unknown',
      detail: { reason: 'bad_credentials' },
      ip,
    });
    return { ok: false, status: 401, error: 'Invalid email or password, or account temporarily locked.' };
  }

  if (user.locked_until !== null && user.locked_until > now) {
    appendAudit(db, {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'LOGIN_LOCKED',
      targetType: 'AUTH',
      targetId: user.id,
      detail: { lockedUntil: new Date(user.locked_until).toISOString() },
      ip,
    });
    return {
      ok: false,
      status: 429,
      error: 'Invalid email or password, or account temporarily locked.',
    };
  }

  const valid = verifyPassword(password, user.password_hash);
  if (!valid) {
    const nextAttempts = user.failed_attempts + 1;
    const lockedUntil = nextAttempts >= LOCKOUT_MAX_ATTEMPTS ? now + LOCKOUT_DURATION_MS : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(
      nextAttempts,
      lockedUntil,
      user.id
    );
    appendAudit(db, {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: lockedUntil ? 'ACCOUNT_LOCKED_OUT' : 'LOGIN_FAILED',
      targetType: 'AUTH',
      targetId: user.id,
      detail: { failedAttempts: nextAttempts },
      ip,
    });
    return {
      ok: false,
      status: lockedUntil ? 429 : 401,
      error: 'Invalid email or password, or account temporarily locked.',
    };
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = now + SESSION_TTL_MS;

  const tx = db.transaction(() => {
    // Session fixation protection: invalidate any pre-existing session presented during login
    if (existingSessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(existingSessionId);
    }
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    db.prepare(
      `INSERT INTO sessions (id, user_id, csrf_token, camera_verified, reauth_until, expires_at, created_at)
       VALUES (?, ?, ?, 0, NULL, ?, ?)`
    ).run(sessionId, user.id, csrfToken, expiresAt, new Date(now).toISOString());
    db.prepare(
      `INSERT INTO presence (user_id, current_route, current_record_id, last_seen_at)
       VALUES (?, '#/overview', NULL, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    ).run(user.id, now);
  });
  tx();

  appendAudit(db, {
    actorUserId: user.id,
    actorEmail: user.email,
    actorRole: user.role,
    action: 'LOGIN_SUCCESS',
    targetType: 'SESSION',
    targetId: sessionId.slice(0, 12),
    detail: { role: user.role },
    ip,
  });

  return {
    ok: true,
    status: 200,
    sessionId,
    csrfToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      title: user.title,
      departing: user.departing === 1,
    },
  };
}

export function grantPasswordReauth(
  db: Database.Database,
  session: AuthenticatedSession,
  password: string,
  ip: string
): { ok: boolean; sessionId?: string; csrfToken?: string } {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.user.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    appendAudit(db, {
      actorUserId: session.user.id,
      actorEmail: session.user.email,
      actorRole: session.user.role,
      action: 'REAUTH_FAILED',
      targetType: 'SESSION',
      targetId: session.sessionId.slice(0, 12),
      ip,
    });
    return { ok: false };
  }

  const reauthUntil = Date.now() + REAUTH_WINDOW_MS;
  // Rotate session identifier & CSRF token upon privilege elevation / sensitive re-authentication
  const rotated = rotateUserSession(db, session.sessionId, session.user.id, {
    reauthUntil,
    cameraVerified: session.cameraVerified,
  });

  appendAudit(db, {
    actorUserId: session.user.id,
    actorEmail: session.user.email,
    actorRole: session.user.role,
    action: 'REAUTH_SUCCESS',
    targetType: 'SESSION',
    targetId: rotated.sessionId.slice(0, 12),
    detail: { rotated: true },
    ip,
  });
  return { ok: true, sessionId: rotated.sessionId, csrfToken: rotated.csrfToken };
}
