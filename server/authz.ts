import type Database from 'better-sqlite3';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { AuthUser, Role } from '../src/types.ts';
import { getClientIp, type AuthedRequest } from './auth.ts';
import { appendAudit } from './db.ts';
import { isValidId } from './validation.ts';

export const DEFAULT_PROJECT_ID = 'PRJ-MAIN-01';

export interface ProjectContext {
  projectId: string;
  memberRole: Role;
}

/**
 * Resolves projectId STRICTLY.
 * - If no projectId is supplied in query or body, selects DEFAULT_PROJECT_ID (or first project user belongs to).
 * - If an explicit projectId is supplied and is invalid or nonexistent, NEVER silently falls back — responds 400/404.
 * - Verifies explicit membership in `project_members`; denies non-members with 403 and appends `ACCESS_DENIED`.
 */
export function resolveAuthorizedProject(
  db: Database.Database,
  req: AuthedRequest,
  res: Response,
  allowedRoles?: Role[],
  explicitId?: string
): ProjectContext | null {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }

  const queryPid = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : undefined;
  const bodyPid =
    req.body && typeof req.body === 'object' && typeof (req.body as Record<string, unknown>).projectId === 'string'
      ? ((req.body as Record<string, unknown>).projectId as string).trim()
      : undefined;

  const supplied = explicitId ?? (queryPid && queryPid.length > 0 ? queryPid : bodyPid && bodyPid.length > 0 ? bodyPid : undefined);

  if (supplied !== undefined) {
    if (!isValidId(supplied)) {
      res.status(400).json({ error: 'Invalid project identifier format.' });
      return null;
    }
    const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(supplied) as { id: string } | undefined;
    if (!proj) {
      res.status(404).json({ error: `Project "${supplied}" not found.` });
      return null;
    }
    return checkMembershipAndRole(db, req, res, proj.id, auth.user, allowedRoles);
  }

  // No projectId explicitly specified: use DEFAULT_PROJECT_ID if user is a member, else first project user belongs to
  const defaultMember = db
    .prepare('SELECT project_id, role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(DEFAULT_PROJECT_ID, auth.user.id) as { project_id: string; role: Role } | undefined;

  if (defaultMember) {
    return enforceRoleList(db, req, res, defaultMember.project_id, defaultMember.role, auth.user, allowedRoles);
  }

  const firstMember = db
    .prepare(
      `SELECT pm.project_id, pm.role
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       WHERE pm.user_id = ?
       ORDER BY p.created_at ASC
       LIMIT 1`
    )
    .get(auth.user.id) as { project_id: string; role: Role } | undefined;

  if (!firstMember) {
    appendAudit(db, {
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      actorRole: auth.user.role,
      action: 'ACCESS_DENIED',
      targetType: 'PROJECT',
      targetId: DEFAULT_PROJECT_ID,
      detail: { reason: 'User has no project memberships' },
      ip: getClientIp(req),
    });
    res.status(403).json({ error: 'You are not a member of any workspace project.' });
    return null;
  }

  return enforceRoleList(db, req, res, firstMember.project_id, firstMember.role, auth.user, allowedRoles);
}

export function checkMembershipAndRole(
  db: Database.Database,
  req: Request,
  res: Response,
  projectId: string,
  user: AuthUser,
  allowedRoles?: Role[]
): ProjectContext | null {
  const membership = db
    .prepare('SELECT project_id, role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, user.id) as { project_id: string; role: Role } | undefined;

  if (!membership) {
    appendAudit(db, {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'ACCESS_DENIED',
      targetType: 'PROJECT',
      targetId: projectId,
      projectId,
      detail: { reason: 'User is not a member of this project', endpoint: req.originalUrl },
      ip: getClientIp(req),
    });
    res.status(403).json({ error: 'Access denied: you are not a member of this project.' });
    return null;
  }

  return enforceRoleList(db, req, res, projectId, membership.role, user, allowedRoles);
}

function enforceRoleList(
  db: Database.Database,
  req: Request,
  res: Response,
  projectId: string,
  memberRole: Role,
  user: AuthUser,
  allowedRoles?: Role[]
): ProjectContext | null {
  if (allowedRoles && !allowedRoles.includes(memberRole)) {
    appendAudit(db, {
      actorUserId: user.id,
      actorEmail: user.email,
      actorRole: memberRole,
      action: 'ACCESS_DENIED',
      targetType: 'ENDPOINT',
      targetId: req.originalUrl,
      projectId,
      detail: { allowedRoles, memberRole, method: req.method },
      ip: getClientIp(req),
    });
    res.status(403).json({ error: 'Access denied for your role in this project.' });
    return null;
  }
  return { projectId, memberRole };
}

export function canUserAccessSource(
  source: { visibility_level: string; uploaded_by_id?: string; uploaded_by?: string },
  user: { id: string; email: string; role: Role },
  memberRole: Role = user.role
): boolean {
  if (source.visibility_level === 'PROJECT_SHARED') return true;
  if (source.visibility_level === 'PRIVATE_OWNER') {
    return source.uploaded_by_id === user.id || source.uploaded_by === user.email;
  }
  if (source.visibility_level === 'RESTRICTED_PI_ONLY') {
    return memberRole === 'PI_LEAD';
  }
  return false;
}

export function canUserAccessRecord(
  record: { visibility_level: string; owner_user_id?: string | null },
  userId: string,
  memberRole: Role
): boolean {
  if (record.visibility_level === 'PROJECT_SHARED') {
    return memberRole !== 'INCOMING_MEMBER';
  }
  if (record.visibility_level === 'PRIVATE_OWNER') {
    return Boolean(record.owner_user_id && record.owner_user_id === userId);
  }
  if (record.visibility_level === 'RESTRICTED_PI_ONLY') {
    return memberRole === 'PI_LEAD';
  }
  return false;
}

export function canUserAccessNote(
  note: { visibility_level: string; author_id: string },
  userId: string,
  memberRole: Role,
  mode: 'READ' | 'WRITE'
): boolean {
  if (mode === 'READ') {
    if (note.visibility_level === 'PROJECT_SHARED') return true;
    return note.author_id === userId;
  }
  // AUDITOR is strictly read-only
  if (memberRole === 'AUDITOR') return false;
  if (note.visibility_level === 'PRIVATE_OWNER') {
    return note.author_id === userId;
  }
  return note.author_id === userId || memberRole === 'PI_LEAD';
}

export function sanitizeFsPathWithinDir(candidatePath: string, allowedDir: string): string | null {
  const resolvedBase = path.resolve(allowedDir);
  const resolvedTarget = path.resolve(candidatePath);
  if (resolvedTarget !== resolvedBase && resolvedTarget.startsWith(resolvedBase + path.sep)) {
    return resolvedTarget;
  }
  return null;
}
