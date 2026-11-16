# Architecture Overview — BATON

This document reflects the actual implemented architecture of BATON across frontend, backend, database, API, security, and all continuity engines.

---

## 1. High-Level System Architecture

```
Browser (React 19 + TypeScript + Tailwind v4, Hash Router #/...)
   │  HttpOnly Cookie (`baton_session`) + `X-Baton-Session` fallback
   │  `X-CSRF-Token` on all non-GET/HEAD/OPTIONS requests
   ▼
Express 4 Server (`server.ts`, trust proxy=1, CSP & CORS headers)
   ├─► Auth & Rate-Limit Layer (`server/auth.ts`, `server/rateLimit.ts`)
   ├─► Project Membership & RBAC Layer (`server/authz.ts`)
   ├─► Request Validation & HTML Sanitization (`server/validation.ts`)
   ├─► API Route Handlers (`server/routes.ts`)
   ├─► Extraction, Radar, Cold-Start, Redaction & Handover Engines (`server/engine.ts`)
   └─► Storage Layer (`server/db.ts`)
         ├─ SQLite WAL Database (`DATA_DIR/baton.db`)
         ├─ Uploaded Source Artifacts (`DATA_DIR/uploads/`)
         ├─ Atomic Temp Staging (`DATA_DIR/tmp/`)
         └─ Daily Online Backups (`DATA_DIR/backups/`)
```

---

## 2. Frontend Architecture
- **Entry & Routing**: `src/App.tsx` manages authenticated state (`GET /api/auth/me`), active project context (`localStorage` + `baton-project` selector), hash navigation (`#/overview`, `#/sources`, `#/notes`, `#/map`, `#/records`, `#/review`, `#/handover`, `#/team`, `#/radar`, `#/coldstart`, `#/redaction`, `#/audit`), `baton:session-expired` event handling on `401`, and grouped responsive navigation (mobile drawer with `Escape` key closing).
- **API Client (`src/lib/api.ts`)**: Wraps `fetch`, attaches `X-Baton-Session`, `X-CSRF-Token`, and `?projectId=...`, performs safe JSON parsing, and dispatches `baton:session-expired` on expired/invalidated `401` responses.
- **Pre-Login Experience (`src/components/LoginScreen.tsx`)**: Presents BATON overview, workflow diagram, Sign In, Create Account (researcher-only self-registration with password strength check), and explicit demo evaluation sign-in helpers without any passwordless camera login bypass.
- **Sensitive Action Gate (`src/components/SensitiveAuthModal.tsx`)**: Enforces password-only verification (`POST /api/auth/reauth`), refreshing the rotated CSRF token and session token returned by the backend.
- **Tabs (`src/components/tabs/*`)**: Each workflow module maintains explicit loading states, empty states, error banners with Retry actions, and inline feedback.

---

## 3. Backend & Database Architecture (`server/db.ts`)
- **SQLite Pragmas**: `journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON`, `busy_timeout = 5000`.
- **Non-Destructive Additive Migrations**: `initDatabase()` creates base tables cleanly and uses `ensureColumn()` (`PRAGMA table_info`) to add columns without dropping existing data, followed by index creation and `project_members` backfill when upgrading older databases.
- **Atomic File Writes**: `writeFileAtomic()` writes upload buffers into `DATA_DIR/tmp/<uuid>.upload.tmp`, calls `fs.fsyncSync()`, and atomically renames into `DATA_DIR/uploads/`. If SQLite insertion throws, the handler unlinks the file so disk and DB never diverge.
- **Immutable Audit Ledger**: `audit_logs` enforces append-only behavior via SQLite triggers `audit_logs_no_update` and `audit_logs_no_delete` (`RAISE(ABORT, 'audit_logs is append-only')`). `redactAuditDetail()` strips secret/password/token keys before persistence.
- **Daily Online Backups**: `ensureDailyBackup()` uses `better-sqlite3`'s online `db.backup()` API to snapshot `DATA_DIR/backups/baton-YYYY-MM-DD.db` on startup and every 6 hours.

---

## 4. Authentication & Authorization
- **Authentication (`server/auth.ts`)**:
  - Passwords hashed with random 16-byte salt + `crypto.scryptSync(..., 64)` and checked via `crypto.timingSafeEqual`.
  - 5 consecutive failed logins trigger a 15-minute lockout (`locked_until`, HTTP `429`).
  - Successful login resets lockout counters, invalidates any prior presented session (fixation guard), creates a new 256-bit `sessions` row + 192-bit `csrf_token`, and updates `presence`.
  - `POST /api/auth/register` ignores privileged role requests (`PI_LEAD`, `REVIEWER`, `AUDITOR`), assigns `RESEARCHER`, and logs `PRIVILEGED_REGISTRATION_ATTEMPTED` when attempted.
  - `POST /api/auth/camera-login` always returns `403` and logs `CAMERA_LOGIN_REJECTED`.
- **Authorization (`server/authz.ts`)**:
  - `resolveAuthorizedProject()` validates explicit `projectId` strictly (`400` malformed, `404` missing — zero silent fallback) and checks `project_members` (`403` + `ACCESS_DENIED` audit for non-members).
  - Row-level helpers `canUserAccessSource()`, `canUserAccessRecord()`, and `canUserAccessNote()` enforce `PROJECT_SHARED`, `PRIVATE_OWNER`, and `RESTRICTED_PI_ONLY` boundaries.
  - `AUDITOR` is strictly read-only across sources, notes, records, reviews, redactions, and handovers.

---

## 5. Continuity & Safeguard Engines (`server/engine.ts`)

### A. Pre-AI Isolation & Extraction
- `getAuthorizedAiSpans()` runs SQL `WHERE s.project_id = ? AND s.visibility_level = 'PROJECT_SHARED' AND s.exclude_from_ai = 0` and writes `AI_CONTEXT_FILTERED` to `audit_logs`.
- Rule-based extraction (`reconstructFromSource`) parses structured CSV rows and Markdown/PDF/JSON spans deterministically (`baton-deterministic-extractor`). When `GEMINI_API_KEY` is configured and `useAi` is requested, `gemini-4-hydrogen` receives untrusted-data-delimited spans with a 9s abort timeout and falls back silently to rule-based extraction on error.

### B. Evidence Verification & Approval Separation
- Records carry independent `evidence_state` (`SUPPORTED`, `CONFLICTING`, `UNSUPPORTED`, `STALE`, `NEEDS_REVIEW`, `NOT_ESTABLISHED`) and `approval_state` (`APPROVED`, `NEEDS_REVISION`, `REJECTED`, `NEEDS_REVIEW`).
- Numeric confidence scores (`confidence_score`, `truth_score`) are rejected with HTTP `422`.
- Setting `evidence_state = 'SUPPORTED'` requires `verifyVerbatimInSpan(excerpt, span.content)`.
- Updating a record increments `version`, writes an immutable `record_versions` snapshot, and resets `approval_state` to `NEEDS_REVIEW` (`approved_version = null`).

### C. Knowledge-Debt Radar (`runRadarScan`)
- Scans non-private, non-rejected project records using the server's real `Date.now()` timestamp.
- Scores points (`0–100` cap) across: departing single owner (`+40`), unresolved single owner (`+25`), ownership concentration `>=3 critical records & >=40% share` (`+20`), `UNKNOWN` owner (`+25`), unapproved dependency without backup (`+20`), weak/stale/unsupported/conflicting evidence (`+20`), missing span (`+15`) or single-source unapproved decision/result (`+10`), open gap/task/unapproved state (`+15`), age `>90d` (`+20`), `31–90d` (`+10`), invalid date (`+15`), or future date (`+10`, age clamped to `0`).
- Preserves previously `resolved = 1` findings across rescans whenever `issueSignature` is unchanged; marks cleared records `inactive = 1` without deleting history.

### D. Cold-Start Handover Test (`buildColdStartQuestions`, `evaluateColdStartRun`)
- Builds questions strictly from the latest `PUBLISHED` handover joined with `PROJECT_SHARED` non-rejected records (`PRIVATE_OWNER` and `RESTRICTED_PI_ONLY` excluded) across 10 question categories.
- Evaluates answers deterministically via token normalization, domain synonym/abbreviation expansion (`EQUIVALENT_TERMS`), and repetition/keyword-stuffing detection into `CORRECT`, `PARTIAL`, `INCORRECT`, and `UNANSWERED`.
- Prevents rapid duplicate saves within 4s (`409`) unless `forceNewAttempt: true`, and isolates `INCOMING_MEMBER` run history strictly to `user_id = req.auth.user.id`.

### E. Sensitive-Content Redaction (`detectSensitiveInText`, `applyConfirmedRedactions`)
- Detects emails, phones (with date/numeric false-positive suppression), secrets/tokens/keys/JWTs, government/subject IDs, restricted IP keywords, and project-configured `sensitive_patterns_json`.
- Masks `matched_text` and snippets in `GET /api/redactions`, preserves `CONFIRMED` and `REJECTED` triage decisions across rescans, appends history entries on every decision transition, applies confirmed project overlays server-side on handovers, records, versions, radar views, and Cold-Start hints, and gates `POST /api/redactions/:id/reveal` behind `PI_LEAD` + password `reauth`.
