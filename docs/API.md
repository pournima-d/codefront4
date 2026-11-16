# API Reference — BATON

All authenticated endpoints require either a valid `baton_session` cookie or an `X-Baton-Session` header, and all non-`GET` endpoints (except `/api/auth/login`, `/api/auth/register`, and rejected `/api/auth/camera-login`) require a matching `X-CSRF-Token` header.

Project-scoped routes accept `?projectId=<id>` (or `body.projectId`). When omitted, requests resolve to `PRJ-MAIN-01` (or the user's earliest joined project). Unknown `projectId` values return `404`; unauthorized projects return `403`.

---

## Health & Authentication
| Method & Path | Auth | Summary |
| :--- | :--- | :--- |
| `GET /api/health` | Public | Returns `{ ok, dbIntegrity, timestamp }`. Returns `503` if `PRAGMA integrity_check` fails. |
| `POST /api/auth/login` | Public | Email/password login (`scrypt`), 5-attempt lockout (`429`), rate-limited, returns `{ user, csrfToken, sessionToken, hasSensitiveAuth }`. |
| `POST /api/auth/register` | Public | Self-service account creation (`RESEARCHER` role enforced; client-supplied privileged roles ignored & audited). |
| `POST /api/auth/camera-login` | Public | **Permanently disabled** (`403`, audited as `CAMERA_LOGIN_REJECTED`). |
| `GET /api/auth/me` | Session | Returns current authenticated user, CSRF token, and sensitive re-auth status. |
| `POST /api/auth/camera-check` | Session + CSRF | Records informational on-device camera preview status (`completed`/`skipped`) only; never grants sensitive auth. |
| `POST /api/auth/reauth` | Session + CSRF | Verifies password, rotates session + CSRF tokens, grants 15-minute `hasSensitiveAuth` window. |
| `POST /api/auth/logout` | Session + CSRF | Deletes session row, clears cookie, and marks user offline. |

## Presence & Drafts
| Method & Path | Auth | Summary |
| :--- | :--- | :--- |
| `POST /api/presence/heartbeat` | Session + CSRF | Updates active route, record ID, and `last_seen_at`. |
| `GET /api/presence/stream` | Session | Server-Sent Events (`text/event-stream`) streaming team presence updates every 4s. |
| `GET /api/drafts/:key` | Session | Loads user's saved autosave JSON draft for `:key`. |
| `PUT /api/drafts/:key` | Session + CSRF | Upserts autosave draft JSON (max payload guarded). |
| `DELETE /api/drafts/:key` | Session + CSRF | Removes autosave draft after successful form submission. |

## Projects, Members & Overview
| Method & Path | Roles | Summary |
| :--- | :--- | :--- |
| `GET /api/projects` | Any member | Lists projects the authenticated user belongs to alongside `member_role`. |
| `POST /api/projects` | Authenticated | Creates an isolated project and assigns creator as `PI_LEAD`. |
| `GET /api/projects/:id/members` | Any project member | Lists project members and their project-scoped roles. |
| `POST /api/projects/:id/members` | `PI_LEAD` | Adds or updates a registered user's membership and role in the project. |
| `PATCH /api/projects/:id/members/:userId` | `PI_LEAD` | Changes a member's project role (prevents demoting last `PI_LEAD`). Invalidates target's active sessions. |
| `DELETE /api/projects/:id/members/:userId` | `PI_LEAD` | Removes member from project (prevents removing last `PI_LEAD`). |
| `PATCH /api/projects/:id/settings` | `PI_LEAD` | Updates custom project sensitive patterns (`sensitive_patterns`) and runs redaction scan. |
| `DELETE /api/projects/:id` | `PI_LEAD` | Deletes project, cascading DB rows & unlinking files (`400` if last remaining project). |
| `POST /api/projects/:id/reset` | `PI_LEAD` | Clears files, notes, records, handovers, radar, and redactions in the project while preserving project & members. |
| `GET /api/overview` | Any project member | Returns project metrics, workflow stage counts, evidence distribution, published handover, and recent activity. |

## Sources & Spans (`Files & Vault`)
| Method & Path | Roles | Summary |
| :--- | :--- | :--- |
| `GET /api/sources` | Any project member | Lists `PROJECT_SHARED`, owner's `PRIVATE_OWNER`, and (`PI_LEAD` only) `RESTRICTED_PI_ONLY` sources. |
| `GET /api/sources/:id/spans` | Authorized viewer | Lists parsed verbatim spans (`403` on private/restricted denial). |
| `GET /api/sources/:id/download` | Authorized viewer | Sends stored artifact safely (`X-Content-Type-Options: nosniff`). |
| `POST /api/sources/upload` | `PI_LEAD`, `RESEARCHER`, `INCOMING_MEMBER` | Multipart upload (`.pdf`, `.md`, `.txt`, `.csv`, `.json`; max `2 MB`; SHA-256 dedup `409`). |
| `POST /api/sources/text` | `PI_LEAD`, `RESEARCHER`, `INCOMING_MEMBER` | Direct text ingestion for `.md`, `.txt`, `.csv`, `.json` (`400` on path traversal filename). |
| `PATCH /api/sources/:id/visibility` | Source owner | Toggles source between `PRIVATE_OWNER` and `PROJECT_SHARED`. |
| `DELETE /api/sources/:id` | Owner or `PI_LEAD` | Deletes source and unlinks file from `DATA_DIR/uploads/`. |
| `POST /api/sources/:id/retry` | Owner, `PI_LEAD`, `RESEARCHER` | Submits OCR transcript text for `NEEDS_OCR` PDFs and re-parses spans. |
| `POST /api/sources/:id/reconstruct` | `PI_LEAD`, `RESEARCHER` | Reconstructs claims from a single shared source (`exclude_from_ai = 0`). |

## Notes Studio
| Method & Path | Roles | Summary |
| :--- | :--- | :--- |
| `GET /api/notes` | Any project member | Lists `PROJECT_SHARED` notes and user's own `PRIVATE_OWNER` notes. |
| `POST /api/notes` | Non-`AUDITOR` | Creates sanitized HTML note (`version = 1`). `AUDITOR` receives `403`. |
| `PATCH /api/notes/:id` | Author or `PI_LEAD` (shared only) | Updates sanitized note with optional `expected_version` optimistic locking (`409 VERSION_CONFLICT`). |
| `DELETE /api/notes/:id` | Author or `PI_LEAD` (shared only) | Deletes note (`PRIVATE_OWNER` strictly author-only). |

## Knowledge Map, Records & Review Queue
| Method & Path | Roles | Summary |
| :--- | :--- | :--- |
| `GET /api/records` | `PI_LEAD`, `RESEARCHER`, `REVIEWER`, `AUDITOR` | Lists authorized records with verbatim status and confirmed redactions applied. |
| `GET /api/map` | `PI_LEAD`, `RESEARCHER`, `REVIEWER`, `AUDITOR` | Returns eligible sources, records, edges, and workflow filter status. |
| `POST /api/map/reconstruct` | `PI_LEAD`, `RESEARCHER` | Runs SQL pre-filtered multi-source extraction (`PROJECT_SHARED` & `exclude_from_ai = 0`) + Radar scan. |
| `POST /api/records` | `PI_LEAD`, `RESEARCHER` | Creates manual record; rejects `confidence_score` (`422`), cross-project spans (`422`), non-verbatim `SUPPORTED` (`422`). |
| `GET /api/records/:id/versions` | `PI_LEAD`, `RESEARCHER`, `REVIEWER`, `AUDITOR` | Returns immutable revision history (`record_versions`) with confirmed redactions applied. |
| `POST /api/records/:id/flag-citation` | `PI_LEAD`, `RESEARCHER`, `REVIEWER` | Flags broken citation and transitions `evidence_state` to `UNSUPPORTED`. |
| `PATCH /api/records/:id` | `PI_LEAD`, `RESEARCHER` | Edits record, checks verbatim rules, increments `version`, resets `APPROVED` -> `NEEDS_REVIEW`, logs `record_versions`. |
| `POST /api/records/:id/verify` | `PI_LEAD`, `RESEARCHER`, `REVIEWER` | Checks excerpt verbatim against cited span -> updates `evidence_state` (`SUPPORTED` or `UNSUPPORTED`). |
| `DELETE /api/records` | `PI_LEAD`, `RESEARCHER` | Bulk-deletes authorized records in project while keeping files/notes intact. |
| `DELETE /api/records/:id` | `PI_LEAD`, `RESEARCHER` | Deletes single record (`REVIEWER`/`AUDITOR`/`INCOMING_MEMBER` blocked `403`). |
| `GET /api/reviews` | `PI_LEAD`, `REVIEWER` | Lists records with attached cited span text and past review entries. |
| `POST /api/records/:id/review` | `PI_LEAD`, `REVIEWER` | Submits `APPROVE`, `REJECT`, `REQUEST_CHANGES`, or `FLAG_GAP` with mandatory rationale (`>= 3` chars, `400` otherwise; `409` on rapid duplicate). |

## Handover, Team, Radar, Cold-Start, Redactions & Audit
| Method & Path | Roles | Summary |
| :--- | :--- | :--- |
| `GET /api/handovers` | Any project member | `INCOMING_MEMBER` sees strictly `PUBLISHED`; confirmed redactions applied server-side. |
| `POST /api/handovers/generate` | `PI_LEAD`, `RESEARCHER` | Builds a new handover draft excluding private, restricted, and rejected records. |
| `POST /api/handovers/:id/items/:itemId/check` | `INCOMING_MEMBER`, `PI_LEAD` | Toggles recipient item checklist verification. |
| `POST /api/handovers/:id/publish` | `PI_LEAD` + `reauth` | Publishes draft handover (`403 SENSITIVE_AUTH_REQUIRED` without active 15m password re-auth). |
| `POST /api/handovers/:id/acknowledge` | `INCOMING_MEMBER`, `PI_LEAD` | Records version-bound receipt acknowledgement. |
| `DELETE /api/handovers/:id` | `PI_LEAD` or draft author | Deletes handover (`RESEARCHER` blocked `403` on published handovers). |
| `GET /api/team` | Any project member | Returns member statuses, session-aware presence, `work_summary`, and activity feed. |
| `PATCH /api/team/members/:id` | `PI_LEAD` | Updates `departing` flag or project role and refreshes Radar scan. |
| `GET /api/radar` | `PI_LEAD`, `RESEARCHER` | Lists non-inactive Radar findings with score reasons, `lastScannedAt`, and assignable users. |
| `POST /api/radar/scan` | `PI_LEAD`, `RESEARCHER` | Runs `runRadarScan` preserving valid resolved findings. |
| `POST /api/radar/findings/:id/resolve` | `PI_LEAD`, `RESEARCHER` | Marks finding resolved (`{ resolved: true }`) or reopens (`{ resolved: false }`). |
| `GET /api/coldstart` | `PI_LEAD`, `INCOMING_MEMBER` | Generates questions from latest published `PROJECT_SHARED` handover and lists runs (private to owner for `INCOMING_MEMBER`). |
| `GET /api/coldstart/runs/:id` | `PI_LEAD` or run owner | Fetches specific run (`403` if another `INCOMING_MEMBER` requests it). |
| `POST /api/coldstart/submit` | `PI_LEAD`, `INCOMING_MEMBER` | Evaluates submitted answers (`CORRECT`/`PARTIAL`/`INCORRECT`/`UNANSWERED`); `409` on rapid repeat unless `forceNewAttempt: true`. |
| `DELETE /api/coldstart/runs/:id` | `PI_LEAD` or run owner | Deletes saved Cold-Start run. |
| `GET /api/redactions` | `PI_LEAD`, `RESEARCHER` | Returns masked redaction proposals with confidence reason, locator, and decision history. |
| `POST /api/redactions/scan` | `PI_LEAD`, `RESEARCHER` | Scans shared (`RESTRICTED` / `ALL` require `PI_LEAD`; `PRIVATE` scans caller's private items). |
| `POST /api/redactions/:id/resolve` | `PI_LEAD`, `RESEARCHER` | Confirms, rejects, or reopens (`PROPOSED`) proposal while recording history. |
| `POST /api/redactions/:id/reveal` | `PI_LEAD` + `reauth` | Reveals unmasked `original_matched_text` and context behind password re-auth and audit log. |
| `DELETE /api/redactions/:id` | `PI_LEAD`, `RESEARCHER` | Deletes proposal (enforces target visibility ownership). |
| `GET /api/audit` | `PI_LEAD`, `AUDITOR` | Paginated (`limit`, `offset`, `action`) project-scoped immutable audit log viewer. |
