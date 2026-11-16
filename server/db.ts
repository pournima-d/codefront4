import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DbPaths {
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  tmpDir: string;
  backupsDir: string;
}

export function resolveDbPaths(customDataDir?: string): DbPaths {
  const dataDir = path.resolve(customDataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  return {
    dataDir,
    dbPath: path.join(dataDir, 'baton.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    tmpDir: path.join(dataDir, 'tmp'),
    backupsDir: path.join(dataDir, 'backups'),
  };
}

export function ensureDirectories(paths: DbPaths): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.uploadsDir, { recursive: true });
  fs.mkdirSync(paths.tmpDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
}

export function writeFileAtomic(tmpDir: string, finalPath: string, data: Buffer): void {
  const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.upload.tmp`);
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close error
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function initDatabase(customDataDir?: string): { db: Database.Database; paths: DbPaths } {
  const paths = resolveDbPaths(customDataDir);
  ensureDirectories(paths);

  const db = new Database(paths.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return { db, paths };
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('PI_LEAD','RESEARCHER','REVIEWER','INCOMING_MEMBER','AUDITOR')),
      password_hash TEXT NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER,
      title TEXT NOT NULL DEFAULT '',
      departing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      camera_verified INTEGER NOT NULL DEFAULT 0,
      reauth_until INTEGER,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS presence (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      current_route TEXT,
      current_record_id TEXT,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      stage_current TEXT NOT NULL DEFAULT '03',
      sensitive_patterns_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('PI_LEAD','RESEARCHER','REVIEWER','INCOMING_MEMBER','AUDITOR')),
      added_by TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      visibility_level TEXT NOT NULL CHECK(visibility_level IN ('PROJECT_SHARED','RESTRICTED_PI_ONLY','PRIVATE_OWNER')),
      exclude_from_ai INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('PARSED','NEEDS_OCR','ERROR')),
      raw_text TEXT NOT NULL DEFAULT '',
      uploaded_by TEXT NOT NULL,
      uploaded_by_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(project_id, sha256)
    );

    CREATE TABLE IF NOT EXISTS source_spans (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      locator TEXT NOT NULL,
      content TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      owner_name TEXT,
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
      source_file TEXT NOT NULL,
      locator TEXT NOT NULL,
      span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL,
      evidence_state TEXT NOT NULL CHECK(evidence_state IN ('SUPPORTED','CONFLICTING','UNSUPPORTED','STALE','NEEDS_REVIEW','NOT_ESTABLISHED')),
      approval_state TEXT NOT NULL CHECK(approval_state IN ('APPROVED','NEEDS_REVISION','REJECTED','NEEDS_REVIEW')),
      approved_version INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      visibility_level TEXT NOT NULL CHECK(visibility_level IN ('PROJECT_SHARED','RESTRICTED_PI_ONLY','PRIVATE_OWNER')),
      exclude_from_ai INTEGER NOT NULL DEFAULT 0,
      excerpt TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '02',
      last_updated TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS record_edges (
      id TEXT PRIMARY KEY,
      from_record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      to_record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      relation TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      record_version INTEGER NOT NULL,
      reviewer_id TEXT NOT NULL REFERENCES users(id),
      reviewer_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('APPROVE','REJECT','REQUEST_CHANGES','FLAG_GAP')),
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS handovers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED')),
      summary_md TEXT NOT NULL,
      extractor_mode TEXT NOT NULL DEFAULT 'rule-based',
      created_by TEXT NOT NULL,
      published_by TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS handover_items (
      id TEXT PRIMARY KEY,
      handover_id TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      section TEXT NOT NULL,
      rendered_text TEXT NOT NULL,
      source_file TEXT NOT NULL,
      locator TEXT NOT NULL,
      evidence_state TEXT NOT NULL,
      approval_state TEXT NOT NULL,
      owner_name TEXT,
      version_at_inclusion INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS handover_acknowledgements (
      id TEXT PRIMARY KEY,
      handover_id TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      user_name TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      acknowledged_at TEXT NOT NULL,
      UNIQUE(handover_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS radar_findings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      priority_points INTEGER NOT NULL,
      band TEXT NOT NULL CHECK(band IN ('HIGH','MEDIUM','LOW')),
      reasons_json TEXT NOT NULL,
      suggested_followup TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coldstart_runs (
      id TEXT PRIMARY KEY,
      handover_id TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
      handover_version INTEGER NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      user_name TEXT NOT NULL,
      total_questions INTEGER NOT NULL,
      answerable_questions INTEGER NOT NULL,
      questions_json TEXT NOT NULL,
      coverage_gaps_json TEXT NOT NULL,
      untested_records_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redaction_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK(target_type IN ('SOURCE','RECORD')),
      target_id TEXT NOT NULL,
      span_id TEXT,
      category TEXT NOT NULL CHECK(category IN ('EMAIL','PHONE','SECRET','ID_NUMBER','RESTRICTED_KEYWORD')),
      matched_text TEXT NOT NULL,
      context_snippet TEXT NOT NULL,
      replacement TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PROPOSED','CONFIRMED','REJECTED')),
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      draft_key TEXT NOT NULL,
      content_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor_user_id TEXT,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      ip TEXT
    );

    CREATE TABLE IF NOT EXISTS record_versions (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      evidence_state TEXT NOT NULL,
      approval_state TEXT NOT NULL,
      owner_name TEXT,
      locator TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      edited_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      author_role TEXT NOT NULL,
      title TEXT NOT NULL,
      content_html TEXT NOT NULL DEFAULT '',
      plain_text TEXT NOT NULL DEFAULT '',
      font_family TEXT NOT NULL DEFAULT 'DM Sans',
      visibility_level TEXT NOT NULL CHECK(visibility_level IN ('PROJECT_SHARED','PRIVATE_OWNER')),
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'audit_logs is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'audit_logs is append-only');
    END;
  `);

  // Safe additive column migrations (never drops data)
  const ensureColumn = (table: string, col: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };

  ensureColumn('projects', 'sensitive_patterns_json', "sensitive_patterns_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('records', 'rationale', "rationale TEXT NOT NULL DEFAULT ''");
  ensureColumn('handover_items', 'recipient_checked', 'recipient_checked INTEGER NOT NULL DEFAULT 0');
  ensureColumn('handover_items', 'source_visibility', "source_visibility TEXT NOT NULL DEFAULT 'PROJECT_SHARED'");
  ensureColumn('handovers', 'recipient_name', 'recipient_name TEXT');
  ensureColumn('handover_acknowledgements', 'handover_version', 'handover_version INTEGER NOT NULL DEFAULT 1');
  ensureColumn('sources', 'uploaded_by_id', "uploaded_by_id TEXT NOT NULL DEFAULT ''");
  ensureColumn('notes', 'version', 'version INTEGER NOT NULL DEFAULT 1');
  ensureColumn('audit_logs', 'project_id', 'project_id TEXT');

  // Round 3 Radar additive columns
  ensureColumn('radar_findings', 'risk_category', "risk_category TEXT NOT NULL DEFAULT 'CONTINUITY_DEBT'");
  ensureColumn('radar_findings', 'owner_name', 'owner_name TEXT');
  ensureColumn('radar_findings', 'evidence_snapshot_json', "evidence_snapshot_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('radar_findings', 'created_at', 'created_at TEXT');
  ensureColumn('radar_findings', 'resolved_at', 'resolved_at TEXT');
  ensureColumn('radar_findings', 'resolved_by', 'resolved_by TEXT');
  ensureColumn('radar_findings', 'inactive', 'inactive INTEGER NOT NULL DEFAULT 0');

  // Round 3 Cold-Start additive columns
  ensureColumn('coldstart_runs', 'evaluation_mode', "evaluation_mode TEXT NOT NULL DEFAULT 'deterministic-concept-matcher'");
  ensureColumn('coldstart_runs', 'coverage_summary_json', "coverage_summary_json TEXT NOT NULL DEFAULT '{}'");

  // Round 3 Redaction additive columns
  ensureColumn('redaction_proposals', 'fingerprint', 'fingerprint TEXT');
  ensureColumn('redaction_proposals', 'locator', "locator TEXT NOT NULL DEFAULT ''");
  ensureColumn('redaction_proposals', 'confidence_label', "confidence_label TEXT NOT NULL DEFAULT 'MEDIUM'");
  ensureColumn('redaction_proposals', 'confidence_reason', "confidence_reason TEXT NOT NULL DEFAULT ''");
  ensureColumn('redaction_proposals', 'source_hash', 'source_hash TEXT');
  ensureColumn('redaction_proposals', 'history_json', "history_json TEXT NOT NULL DEFAULT '[]'");

  // Indexes for query speed & foreign key lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);
    CREATE INDEX IF NOT EXISTS idx_spans_source ON source_spans(source_id);
    CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id);
    CREATE INDEX IF NOT EXISTS idx_records_source ON records(source_id);
    CREATE INDEX IF NOT EXISTS idx_record_versions_rec ON record_versions(record_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_rec ON reviews(record_id);
    CREATE INDEX IF NOT EXISTS idx_handovers_project ON handovers(project_id);
    CREATE INDEX IF NOT EXISTS idx_handover_items_ho ON handover_items(handover_id);
    CREATE INDEX IF NOT EXISTS idx_radar_project ON radar_findings(project_id, inactive, resolved);
    CREATE INDEX IF NOT EXISTS idx_redactions_project ON redaction_proposals(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_redactions_fingerprint ON redaction_proposals(project_id, fingerprint);
    CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id);
  `);

  // Safe non-destructive backfill for pre-existing databases without project_members rows
  const memberCount = (db.prepare('SELECT COUNT(*) AS cnt FROM project_members').get() as { cnt: number }).cnt;
  const userCount = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
  const projCount = (db.prepare('SELECT COUNT(*) AS cnt FROM projects').get() as { cnt: number }).cnt;
  if (memberCount === 0 && userCount > 0 && projCount > 0) {
    const existingUsers = db.prepare('SELECT id, role FROM users').all() as Array<{ id: string; role: string }>;
    const existingProjects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
    const nowIso = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by, created_at)
       VALUES (?, ?, ?, 'system-migration', ?)`
    );
    const tx = db.transaction(() => {
      for (const p of existingProjects) {
        for (const u of existingUsers) {
          stmt.run(p.id, u.id, u.role, nowIso);
        }
      }
    });
    tx();
  }
}

export function appendAudit(
  db: Database.Database,
  entry: {
    actorUserId?: string | null;
    actorEmail: string;
    actorRole: string;
    action: string;
    targetType: string;
    targetId: string;
    projectId?: string | null;
    detail?: Record<string, unknown>;
    ip?: string | null;
  }
): void {
  const sanitizedDetail = redactAuditDetail(entry.detail ?? {});
  db.prepare(
    `INSERT INTO audit_logs (timestamp, actor_user_id, actor_email, actor_role, action, target_type, target_id, project_id, detail_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    entry.actorUserId ?? null,
    entry.actorEmail,
    entry.actorRole,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.projectId ?? null,
    JSON.stringify(sanitizedDetail),
    entry.ip ?? null
  );
}

function redactAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = new Set([
    'password',
    'passwordHash',
    'password_hash',
    'sessionId',
    'sessionToken',
    'csrfToken',
    'apiKey',
    'token',
    'matchedText',
    'matched_text',
    'rawText',
  ]);
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (sensitiveKeys.has(k)) continue;
    clean[k] = v;
  }
  return clean;
}

export async function ensureDailyBackup(db: Database.Database, paths: DbPaths): Promise<string | null> {
  const dateTag = new Date().toISOString().slice(0, 10);
  const backupFile = path.join(paths.backupsDir, `baton-${dateTag}.db`);
  if (fs.existsSync(backupFile)) {
    return backupFile;
  }
  await db.backup(backupFile);
  return backupFile;
}

export function verifyDatabaseIntegrity(db: Database.Database): boolean {
  try {
    const row = db.prepare('PRAGMA integrity_check(1)').get() as { integrity_check?: string } | undefined;
    return row?.integrity_check === 'ok';
  } catch {
    return false;
  }
}
