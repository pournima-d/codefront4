# BATON — Research Continuity Platform

**BATON** is a full-stack collaborative research continuity platform designed to capture, verify, govern, and hand over laboratory and research project state from authorized project sources without fabricating confidence metrics or leaking private or restricted materials.

---

## 1. Project Name
**BATON** — Collaborative Research Continuity Platform.

## 2. Problem Statement
When key researchers depart, transition, or rotate across multi-phase laboratory projects, critical institutional knowledge is scattered across notebooks, CSV logs, meeting notes, and unreviewed drafts. Outgoing team members face heavy handover friction, incoming members cannot verify what is established versus unverified, single-owner bottlenecks create silent bus-factor risk, and sensitive credentials or intellectual property can accidentally leak into shared summaries.

## 3. Solution Overview
BATON solves research continuity by organizing project state around a **clean-start, evidence-bound five-stage pipeline** backed by SQLite (`better-sqlite3`), Express, and React 19:
- Every structured claim links back to a verbatim source span and explicit locator.
- Truthfulness rules reject fabricated numeric confidence scores (`confidence_score` / `truth_score` return HTTP `422`), separate evidence status from human approval, and invalidate prior approvals whenever a record is edited.
- Pre-AI and pre-handover SQL boundaries enforce visibility isolation (`PROJECT_SHARED`, `PRIVATE_OWNER`, `RESTRICTED_PI_ONLY`).
- Three dedicated continuity safeguards — **Knowledge-Debt Radar**, **Cold-Start Handover Test**, and **Sensitive-Content Redaction** — measure handover readiness, surface single-owner/stale knowledge debt, and prevent unintended leakage.

## 4. Product Features
- **Files & Vault (`#/sources`)**: Drag-and-drop and paste-text ingestion (`.pdf`, `.md`, `.txt`, `.csv`, `.json`, max `2 MB`) with SHA-256 deduplication, atomic temp-to-final disk writes, strict file validation, `NEEDS_OCR` detection + manual text recovery, and Private/Public/PI-Restricted visibility controls.
- **Word-Style Notes Studio (`#/notes`)**: Rich-text collaborative notebook with formatting controls, HTML sanitization (client & server), optimistic locking (`version` + `expected_version` `409` protection), 3-second debounced autosave, Private/Public scope toggle, and `.doc`/`.html` export.
- **Knowledge Map & Records (`#/map`, `#/records`)**: Deterministic (`baton-deterministic-extractor`) and optional Gemini-augmented claim reconstruction from strictly filtered `PROJECT_SHARED` (`exclude_from_ai = 0`) spans, verbatim span checking, immutable `record_versions` history, and citation flagging.
- **Review Queue (`#/review`)**: Peer reviewer sign-off (`APPROVE`, `REQUEST_CHANGES`, `REJECT`, `FLAG_GAP`) with mandatory reviewer rationale (`>= 3` chars), rapid duplicate guard (`409`), and automatic approval invalidation on edit.
- **Handover Builder (`#/handover`)**: Role-filtered continuity dossier generator from verified/shared records with server-side confirmed redaction masking, recipient checklist, password re-authentication gate for publishing, and version-bound recipient receipt acknowledgement.
- **Knowledge-Debt Radar (`#/radar`)**: Transparent, explainable priority point scorer surfacing single-owner bottlenecks, concentration risk, `UNKNOWN` owners, unresolved dependencies, missing spans, and stale/invalid/future dates, with non-destructive resolution persistence across rescans.
- **Cold-Start Handover Test (`#/coldstart`)**: Incoming-member readiness evaluation generated strictly from the published `PROJECT_SHARED` handover, evaluating answers against expected concepts (supporting `CORRECT`, `PARTIAL`, `INCORRECT`, `UNANSWERED` states), reporting knowledge coverage gaps, and enforcing per-user evaluation privacy.
- **Sensitive-Content Redaction (`#/redaction`)**: Multi-rule detector for emails, phone numbers, secrets/API keys/JWTs/PEM keys, IDs, restricted IP keywords, and PI-configured custom project patterns, featuring masked previews, decision history, rejection persistence across rescans, non-destructive handover overlays (`[REDACTED:...]`), and PI-only original reveal behind password re-auth.
- **Team & Work Tracker (`#/team`)**: Project-scoped workflow swimlanes, 15-second heartbeat + Server-Sent Events (`/api/presence/stream`), session-aware `ONLINE`/`AWAY`/`OFFLINE` status, and work attribution counts.
- **Immutable Audit Ledger (`#/audit`)**: Project-scoped audit log protected at the SQLite engine level by `BEFORE UPDATE` and `BEFORE DELETE` triggers (`audit_logs is append-only`).

## 5. Five-Stage Workflow
1. **`01 Connect`**: Upload authorized files or write formatted notes; choose `PROJECT_SHARED`, `PRIVATE_OWNER`, or `RESTRICTED_PI_ONLY`.
2. **`02 Reconstruct`**: Extract typed continuity records (`OBJECTIVE`, `EXPERIMENT`, `DECISION`, `RESULT`, `RISK`, `GAP`, `TASK`, `DEPENDENCY`, `RECURRING_PROBLEM`, `CONTACT`) tied to exact source spans.
3. **`03 Verify`**: Check verbatim excerpt alignment and classify each record into one of six canonical evidence states (`SUPPORTED`, `CONFLICTING`, `UNSUPPORTED`, `STALE`, `NEEDS_REVIEW`, `NOT_ESTABLISHED`).
4. **`04 Review`**: Conduct human peer review, confirm/reject sensitive redaction proposals, and triage Knowledge-Debt Radar findings.
5. **`05 Handover`**: Build handover draft, re-authenticate with password (`PI_LEAD`) to publish, acknowledge receipt (`INCOMING_MEMBER`), and validate continuity with the Cold-Start Test.

## 6. User Roles
Roles are enforced per project via the `project_members` table:
- **`PI_LEAD`**: Full project governance — upload/manage files, reconstruct, edit/verify records, review, publish handovers (with password re-auth), reveal unredacted text, configure project custom sensitive patterns, manage project members & roles, reset/delete projects, inspect audit logs.
- **`RESEARCHER`**: Upload files (`PROJECT_SHARED`/`PRIVATE_OWNER`), write notes, reconstruct and edit/verify records, draft handovers, inspect/triage Radar findings and shared Redactions.
- **`REVIEWER`**: Read shared workspace content, verify spans, approve/reject/request-changes/flag-gap in Review Queue, inspect record versions.
- **`INCOMING_MEMBER`**: Read published handovers, check onboarding items, acknowledge handover receipt, take the Cold-Start Test, view team presence, and manage own shared/private notes/sources where allowed.
- **`AUDITOR`**: Strict read-only compliance observer — inspect shared records, published/draft handovers, team activity, and the append-only audit log (`403` on all content mutations).

## 7. Technology Stack
- **Frontend**: React 19, TypeScript, Vite 8, Tailwind CSS v4 (`@tailwindcss/vite`), `lucide-react` icons, `motion`.
- **Backend**: Node.js, Express 4, `cookie-parser`, `multer` (memory storage upload handling), `pdf-parse`, `tsx`.
- **Database**: SQLite via `better-sqlite3` (WAL mode, `synchronous = FULL`, `foreign_keys = ON`, append-only triggers).
- **Optional AI SDK**: `@google/genai` (server-side only; completely optional — defaults to deterministic extraction when `GEMINI_API_KEY` is unset).

## 8. Architecture
BATON runs as a single Node/Express process serving REST endpoints under `/api/*` alongside Vite middleware in development (`npm run dev`) or pre-built static assets in production (`dist/`). All state persists inside `DATA_DIR` (`baton.db`, `uploads/`, `tmp/`, `backups/`). See `ARCHITECTURE.md` and `docs/` for detailed diagrams and schemas.

## 9. Installation
```bash
git clone <your-repo-url>
cd <repo-dir>
npm install
```
Requirements: Node.js `>= 22.14` (with native TypeScript strip-types or `tsx`) and npm.

## 10. Environment Variables
Copy `.env.example` to `.env` if customization is needed:
- `PORT`: HTTP listen port (default `3000`).
- `DATA_DIR`: Directory for SQLite database (`baton.db`), uploaded files, staging `tmp/`, and daily backups (default `./data`).
- `GEMINI_API_KEY`: **Optional**. Leave unset or `"MY_GEMINI_API_KEY"` to use strictly deterministic local extraction (`baton-deterministic-extractor`).
- `APP_URL`: Optional explicit allowed CORS origin for hosted deployments.

## 11. Database Setup
No manual database migrations are needed. On boot, `initDatabase()` initializes `DATA_DIR/baton.db`, sets `WAL`, `synchronous = FULL`, `foreign_keys = ON`, `busy_timeout = 5000`, executes additive `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` schema migrations, creates append-only audit triggers, and runs `seedIfEmpty()` only when `users` is empty (creating the 5 demo accounts and a **clean empty project** `PRJ-MAIN-01` — *"My Research Workspace"* — with zero sample research files, notes, or records).

## 12. Development Commands
```bash
npm run dev      # Starts Express + Vite HMR/middleware on port 3000 (npx tsx server.ts)
npm run lint     # Runs TypeScript type-checking (tsc --noEmit)
```

## 13. Production Commands
```bash
npm run build                    # Builds frontend bundle into dist/
NODE_ENV=production npm start    # Starts Express serving dist/ and /api/* (node server.ts)
```
Verify server health at `GET /api/health` (returns `{ ok: true, dbIntegrity: true, ... }`).

## 14. Testing Commands
```bash
npm test         # Runs all automated HTTP + SQLite integration tests via tsx --test tests/*.test.ts
```
See `TESTING.md` for full test categories and exact observed pass/fail counts.

## 15. Synthetic Demo Accounts (Evaluation Convenience)
When starting with an empty database, BATON seeds 5 synthetic evaluation user accounts (all sharing demo password **`Baton@2026`**) assigned to `PRJ-MAIN-01`:
- `elena.vance@baton-lab.edu` — `PI_LEAD` (Principal Investigator)
- `marcus.chen@baton-lab.edu` — `RESEARCHER` (Lead Researcher)
- `priya.nair@baton-lab.edu` — `REVIEWER` (Quality & Peer Reviewer)
- `aria.patel@baton-lab.edu` — `INCOMING_MEMBER` (Research Associate)
- `jordan.lee@baton-lab.edu` — `AUDITOR` (Compliance & Audit Reviewer)

> **Security Note**: Public registration (`POST /api/auth/register`) always assigns `RESEARCHER` regardless of any client-supplied role; only an existing project `PI_LEAD` can promote or assign project roles via `/api/projects/:id/members`.

## 16. Deployment Instructions
1. Set `NODE_ENV=production` and configure persistent storage mounted at `DATA_DIR` (ephemeral container disks lose SQLite files and uploads on redeploy unless backed by a persistent volume).
2. Run `npm install && npm run build`.
3. Ensure Node version supports TypeScript execution (`Node >= 22.18` native strip-types used by `node server.ts`, or invoke `npx tsx server.ts` on older Node releases).
4. Start with `npm start` behind an HTTPS reverse proxy forwarding `X-Forwarded-Proto: https` (required for `SameSite=None; Secure; Partitioned` cookies inside embedded iframes).
5. Poll `GET /api/health` for readiness checks.

## 17. Security Model
- **Password Hashing**: Per-user 16-byte random salt + `scryptSync(password, salt, 64)` verified with `crypto.timingSafeEqual`.
- **Sessions & Cookies**: Cryptographically random 256-bit session IDs stored in SQLite (`12h` TTL), delivered via `HttpOnly` cookie (`SameSite=None; Secure; Partitioned` over HTTPS proxy, `SameSite=Lax` over localhost HTTP) plus an `X-Baton-Session` header fallback for third-party cookie-restricted iframes.
- **Sensitive Re-Authentication**: Publishing handovers or revealing unredacted text requires `POST /api/auth/reauth` (verifies password, rotates session + CSRF token, grants `15m` window). Legacy passwordless `/api/auth/camera-login` is permanently disabled (`403`).
- **CSRF & Rate Limiting**: All mutating API routes verify timing-safe `X-CSRF-Token`. Login, re-auth, uploads, registration, and sensitive actions use persistent SQLite-backed fixed-window rate limiters (cannot be bypassed via client headers) plus 5-attempt / 15-minute account lockouts.
- **Privacy & Isolation**: Project membership checked on every endpoint; explicit unknown `projectId` returns `404`; `PRIVATE_OWNER` files and notes are visible strictly to their owner; `RESTRICTED_PI_ONLY` is isolated from non-PI endpoints, AI extraction, handovers, and Cold-Start tests.

## 18. Known Limitations
- **Scanned PDFs (Image-Only)**: No built-in binary OCR engine (e.g., Tesseract); textless PDFs are marked `NEEDS_OCR` for manual text recovery via `/api/sources/:id/retry`.
- **Deterministic Extraction & Concept Matching**: Without `GEMINI_API_KEY`, claim extraction and Cold-Start answer evaluation rely on deterministic keyword, line, CSV, and domain-equivalence rules rather than deep semantic NLU.
- **Rich-Text HTML Sanitizer**: Custom regex/allowlist server sanitizer + DOMParser client sanitizer (not an external DOMPurify C-library dependency) protects against script/event injection on Notes Studio content.
- **Single-Node SQLite**: Uses `better-sqlite3` local WAL storage; multi-instance horizontal scaling would require migrating to a shared client-server RDBMS.

## 19. Troubleshooting
See `docs/TROUBLESHOOTING.md` for step-by-step resolution of lockouts, `403 CSRF`, iframe session issues, `NEEDS_OCR` uploads, `409 VERSION_CONFLICT` notes, and `DATA_DIR` permissions.

## 20. AI Disclosure
BATON was built with software-engineering assistance and uses an optional `@google/genai` integration (`gemini-4-hydrogen`) strictly when `GEMINI_API_KEY` is configured for optional summary/reconstruction synthesis. Core extraction, verbatim matching, Radar scoring, Cold-Start evaluation, and sensitive-pattern detection are deterministic, human-reviewable algorithms. See `DISCLOSURES.md` for full details.
