# Database Schema — BATON (`better-sqlite3`)

SQLite database path: `DATA_DIR/baton.db` (default `./data/baton.db`).

## Engine Configuration (on every connection open)
- `PRAGMA journal_mode = WAL` — concurrent readers with durable write-ahead logging.
- `PRAGMA synchronous = FULL` — fsync-backed durability across power-loss events.
- `PRAGMA foreign_keys = ON` — strict referential integrity and `ON DELETE CASCADE` cleanup.
- `PRAGMA busy_timeout = 5000` — prevents spurious `SQLITE_BUSY` failures under concurrent requests.

---

## Core Tables (`server/db.ts`)

### Identity, Sessions & Authorization
- **`users`**: `id PK`, `email UNIQUE`, `name`, `role`, `password_hash` (`salt:scrypt_hex`), `failed_attempts`, `locked_until`, `title`, `departing`, `created_at`.
- **`sessions`**: `id PK`, `user_id FK -> users(id) ON DELETE CASCADE`, `csrf_token`, `camera_verified`, `reauth_until`, `expires_at`, `created_at`.
- **`presence`**: `user_id PK FK -> users(id) ON DELETE CASCADE`, `current_route`, `current_record_id`, `last_seen_at`.
- **`rate_limits`**: `key PK`, `count`, `window_start`, `reset_at`.
- **`projects`**: `id PK`, `slug UNIQUE`, `name`, `description`, `stage_current`, `sensitive_patterns_json`, `created_at`.
- **`project_members`**: `(project_id, user_id) PK`, `project_id FK -> projects(id) ON DELETE CASCADE`, `user_id FK -> users(id) ON DELETE CASCADE`, `role`, `added_by`, `created_at`.

### Research Artifacts, Claims & Notes
- **`sources`**: `id PK`, `project_id FK -> projects(id) ON DELETE CASCADE`, `title`, `filename`, `file_type`, `file_size`, `sha256`, `storage_path`, `visibility_level`, `exclude_from_ai`, `status` (`PARSED`|`NEEDS_OCR`|`ERROR`), `raw_text`, `uploaded_by`, `uploaded_by_id`, `created_at`. `UNIQUE(project_id, sha256)`.
- **`source_spans`**: `id PK`, `source_id FK -> sources(id) ON DELETE CASCADE`, `locator`, `content`, `line_start`, `line_end`, `created_at`.
- **`notes`**: `id PK`, `project_id FK -> projects(id) ON DELETE CASCADE`, `author_id FK -> users(id) ON DELETE CASCADE`, `author_name`, `author_role`, `title`, `content_html`, `plain_text`, `font_family`, `visibility_level` (`PROJECT_SHARED`|`PRIVATE_OWNER`), `word_count`, `version` (additive col, optimistic lock), `created_at`, `updated_at`.
- **`records`**: `id PK`, `project_id FK -> projects(id) ON DELETE CASCADE`, `type`, `title`, `owner_name`, `owner_user_id FK -> users(id) ON DELETE SET NULL`, `source_id FK -> sources(id) ON DELETE SET NULL`, `source_file`, `locator`, `span_id FK -> source_spans(id) ON DELETE SET NULL`, `evidence_state`, `approval_state`, `approved_version`, `version`, `visibility_level`, `exclude_from_ai`, `excerpt`, `rationale` (additive col), `stage`, `last_updated`, `created_at`.
- **`record_edges`**: `id PK`, `from_record_id FK -> records(id) ON DELETE CASCADE`, `to_record_id FK -> records(id) ON DELETE CASCADE`, `relation`.
- **`record_versions`**: `id PK`, `record_id FK -> records(id) ON DELETE CASCADE`, `version`, `title`, `excerpt`, `evidence_state`, `approval_state`, `owner_name`, `locator`, `reason`, `edited_by`, `created_at`.
- **`reviews`**: `id PK`, `record_id FK -> records(id) ON DELETE CASCADE`, `record_version`, `reviewer_id FK -> users(id)`, `reviewer_name`, `action` (`APPROVE`|`REJECT`|`REQUEST_CHANGES`|`FLAG_GAP`), `comment`, `created_at`.

### Continuity Safeguards & Handover
- **`handovers`**: `id PK`, `project_id FK -> projects(id) ON DELETE CASCADE`, `version`, `title`, `status` (`DRAFT`|`PUBLISHED`), `summary_md`, `extractor_mode`, `created_by`, `recipient_name` (additive), `published_by`, `published_at`, `created_at`.
- **`handover_items`**: `id PK`, `handover_id FK -> handovers(id) ON DELETE CASCADE`, `record_id FK -> records(id) ON DELETE CASCADE`, `section`, `rendered_text`, `source_file`, `locator`, `evidence_state`, `approval_state`, `owner_name`, `version_at_inclusion`, `recipient_checked` (additive), `source_visibility` (additive).
- **`handover_acknowledgements`**: `id PK`, `handover_id FK -> handovers(id) ON DELETE CASCADE`, `handover_version` (additive), `user_id FK -> users(id)`, `user_name`, `note`, `acknowledged_at`. `UNIQUE(handover_id, user_id)`.
- **`radar_findings`**: `id PK`, `project_id FK -> projects(id) ON DELETE CASCADE`, `record_id FK -> records(id) ON DELETE CASCADE`, `priority_points`, `band` (`HIGH`|`MEDIUM`|`LOW`), `reasons_json`, `suggested_followup`, `resolved`, `scanned_at`, plus additive columns: `risk_category`, `owner_name`, `evidence_snapshot_json`, `created_at`, `resolved_at`, `resolved_by`, `inactive`.
- **`coldstart_runs`**: `id PK`, `handover_id FK -> handovers(id) ON DELETE CASCADE`, `handover_version`, `user_id FK -> users(id)`, `user_name`, `total_questions`, `answerable_questions`, `evaluation_mode` (additive), `coverage_summary_json` (additive), `questions_json`, `coverage_gaps_json`, `untested_records_json`, `created_at`.
- **`redaction_proposals`**: `id PK`, `project_id FK -> projects(id) ON DELETE CASCADE`, `target_type` (`SOURCE`|`RECORD`), `target_id`, `span_id`, `category`, `matched_text`, `context_snippet`, `replacement`, `status` (`PROPOSED`|`CONFIRMED`|`REJECTED`), `reviewed_by`, `reviewed_at`, `created_at`, plus additive columns: `fingerprint`, `locator`, `confidence_label`, `confidence_reason`, `source_hash`, `history_json`.
- **`drafts`**: `id PK`, `user_id FK -> users(id) ON DELETE CASCADE`, `draft_key`, `content_json`, `updated_at`.
- **`audit_logs`**: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `timestamp`, `actor_user_id`, `actor_email`, `actor_role`, `action`, `target_type`, `target_id`, `project_id` (additive), `detail_json`, `ip`.

---

## Triggers & Indexes
- **Append-Only Triggers**:
  - `audit_logs_no_update`: `BEFORE UPDATE ON audit_logs` -> `RAISE(ABORT, 'audit_logs is append-only')`
  - `audit_logs_no_delete`: `BEFORE DELETE ON audit_logs` -> `RAISE(ABORT, 'audit_logs is append-only')`
- **Indexes**: Created via `CREATE INDEX IF NOT EXISTS` on `sessions(user_id, expires_at)`, `project_members(user_id)`, `sources(project_id)`, `source_spans(source_id)`, `records(project_id, source_id)`, `record_versions(record_id)`, `reviews(record_id)`, `handovers(project_id)`, `handover_items(handover_id)`, `radar_findings(project_id, inactive, resolved)`, `redaction_proposals(project_id, status, fingerprint)`, `notes(project_id)`, and `audit_logs(action, project_id)`.
