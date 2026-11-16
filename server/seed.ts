import type Database from 'better-sqlite3';
import { hashPassword } from './auth.ts';
import { appendAudit, type DbPaths } from './db.ts';

export function seedIfEmpty(db: Database.Database, _paths: DbPaths): void {
  const userCount = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
  if (userCount > 0) return;

  const nowIso = new Date().toISOString();
  const demoPassHash = hashPassword('Baton@2026');

  const users = [
    {
      id: 'U-ELENA',
      email: 'elena.vance@baton-lab.edu',
      name: 'Elena Vance',
      role: 'PI_LEAD',
      title: 'Principal Investigator',
      departing: 0,
    },
    {
      id: 'U-MARCUS',
      email: 'marcus.chen@baton-lab.edu',
      name: 'Marcus Chen',
      role: 'RESEARCHER',
      title: 'Lead Researcher',
      departing: 0,
    },
    {
      id: 'U-PRIYA',
      email: 'priya.nair@baton-lab.edu',
      name: 'Priya Nair',
      role: 'REVIEWER',
      title: 'Quality & Peer Reviewer',
      departing: 0,
    },
    {
      id: 'U-ARIA',
      email: 'aria.patel@baton-lab.edu',
      name: 'Aria Patel',
      role: 'INCOMING_MEMBER',
      title: 'Research Associate',
      departing: 0,
    },
    {
      id: 'U-JORDAN',
      email: 'jordan.lee@baton-lab.edu',
      name: 'Jordan Lee',
      role: 'AUDITOR',
      title: 'Compliance & Audit Reviewer',
      departing: 0,
    },
  ];

  const projectId = 'PRJ-MAIN-01';

  const tx = db.transaction(() => {
    const uStmt = db.prepare(
      `INSERT INTO users (id, email, name, role, password_hash, failed_attempts, locked_until, title, departing, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`
    );
    const pStmt = db.prepare(
      `INSERT INTO presence (user_id, current_route, current_record_id, last_seen_at) VALUES (?, ?, ?, ?)`
    );
    const pmStmt = db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, added_by, created_at)
       VALUES (?, ?, ?, 'seed', ?)`
    );

    db.prepare(
      `INSERT INTO projects (id, slug, name, description, stage_current, sensitive_patterns_json, created_at)
       VALUES (?, ?, ?, ?, '01', '[]', ?)`
    ).run(
      projectId,
      'main-research-workspace',
      'My Research Workspace',
      'Upload public or private files, write formatted rich-text notes, verify structured claims, and monitor live team work.',
      nowIso
    );

    // Start all accounts offline until they actually sign in
    const offlineTimestamp = Date.now() - 20 * 60_000;
    users.forEach((u) => {
      uStmt.run(u.id, u.email, u.name, u.role, demoPassHash, u.title, u.departing, nowIso);
      pStmt.run(u.id, '#/overview', null, offlineTimestamp);
      pmStmt.run(projectId, u.id, u.role, nowIso);
    });

    appendAudit(db, {
      actorUserId: 'U-ELENA',
      actorEmail: 'elena.vance@baton-lab.edu',
      actorRole: 'PI_LEAD',
      action: 'PROJECT_INITIALIZED',
      targetType: 'PROJECT',
      targetId: projectId,
      projectId,
      detail: { mode: 'clean-workspace' },
    });
  });

  tx();
}
