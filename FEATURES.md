# Feature Inventory — BATON

Features are categorized as **Completed & Verified** (implemented and verified in automated tests/checks) or **Partial / Optional Scope** (intentionally bounded or requiring external configuration).

---

## Completed Features

### 1. Authentication, Sessions & Security Hardening
- `scrypt` salted password hashing (`crypto.scryptSync` + `crypto.timingSafeEqual`).
- 5-failed-attempt / 15-minute account lockout with generic non-enumerating errors (`401`/`429`).
- Persistent SQLite-backed fixed-window rate limits (login per-IP & per-account, registration, upload, sensitive actions) with `Retry-After` headers.
- Server-stored sessions with `HttpOnly`, `SameSite=None; Secure; Partitioned` (HTTPS proxy) cookies plus `X-Baton-Session` header fallback for iframe contexts and `X-CSRF-Token` verification on all mutating calls.
- Public registration restricted strictly to `RESEARCHER` (ignores privileged role escalation attempts and audits `PRIVILEGED_REGISTRATION_ATTEMPTED`).
- Password-only re-authentication (`POST /api/auth/reauth`) with session/CSRF rotation granting a 15-minute sensitive action window. Legacy passwordless `/api/auth/camera-login` is permanently rejected (`403`).

### 2. Multi-Project Isolation & Per-Project RBAC
- Create, switch, reset, and delete isolated projects (`GET/POST/DELETE /api/projects`, `POST /api/projects/:id/reset`).
- Explicit per-project memberships and role assignment (`GET/POST/PATCH/DELETE /api/projects/:id/members`) restricted to project `PI_LEAD`, with last-`PI_LEAD` demotion/removal protection (`400`).
- Strict `projectId` validation (`400` malformed, `404` nonexistent, `403` non-member with `ACCESS_DENIED` logging).
- Role-specific tab filtering and server route enforcement across `PI_LEAD`, `RESEARCHER`, `REVIEWER`, `INCOMING_MEMBER`, and read-only `AUDITOR`.

### 3. Clean-Start Files & Vault (`#/sources`)
- Multi-file upload (`.pdf`, `.md`, `.txt`, `.csv`, `.json`; `2 MB` max) and direct text ingestion (`POST /api/sources/text`).
- Validation blocking empty files (`400`), path traversal (`400`), oversized files (`413`), unsupported types/MIME (`415`), malformed JSON/PDF (`422`), and duplicate SHA-256 hashes per project (`409`).
- Atomic disk persistence (`tmp` → `fsync` → `rename`) with transactional cleanup on failure.
- Line/paragraph/row/page span extraction, scanned/textless PDF `NEEDS_OCR` flagging with inline text recovery (`POST /api/sources/:id/retry`), per-source download (`X-Content-Type-Options: nosniff`), delete, and owner visibility toggles (`PROJECT_SHARED` ↔ `PRIVATE_OWNER`).

### 4. Word-Style Rich-Text Notes Studio (`#/notes`)
- Formatting toolbar (font family, font size, block headings/quote/code, bold/italic/underline/strike/sub/sup, colors/highlights, alignment, lists, indent, checklist, table insert, divider, link insertion with URL-scheme validation, undo/redo, clear formatting).
- Client (`DOMParser`) and server (`sanitizeNoteHtml`) XSS sanitization stripping scripts, iframes, SVGs, forms, event handlers, and scriptable URIs.
- Optimistic concurrency control (`version` + `expected_version` returning `409 VERSION_CONFLICT`), 3-second debounced autosave on saved notes, Private/Public visibility isolation, read-only enforcement for `AUDITOR`, live word/character counter, and `.doc`/`.html` export.

### 5. Pre-Filtered Reconstruction, Verbatim Evidence & Review Queue (`#/map`, `#/records`, `#/review`)
- SQL pre-filtering (`visibility_level = 'PROJECT_SHARED' AND exclude_from_ai = 0`) logged via `AI_CONTEXT_FILTERED`.
- Deterministic extraction (`baton-deterministic-extractor`) + optional Gemini augmentation with prompt-injection delimiters (`<<<UNTRUSTED_SPAN>>>`).
- Strict prohibition of fabricated numeric confidence fields (`422`), verbatim verification required for `SUPPORTED` (`422`), cross-project span citation rejection (`422`), citation mismatch flagging (`POST /api/records/:id/flag-citation`), immutable `record_versions`, and approval invalidation (`APPROVED` → `NEEDS_REVIEW`) upon editing.
- Review actions (`APPROVE`, `REQUEST_CHANGES`, `REJECT`, `FLAG_GAP`) requiring `>= 3`-char rationale (`400` if omitted) and duplicate submission protection (`409`).

### 6. Knowledge-Debt Radar (`#/radar`)
- Explainable point breakdown (`0–100`), `HIGH`/`MEDIUM`/`LOW` severity bands, departing-owner & ownership-concentration detection, `UNKNOWN` owner/date handling, future-date clamping, `issueSignature` resolution persistence across rescans, manual Resolve/Reopen (`POST /api/radar/findings/:id/resolve`), inline record owner assignment, and project exposure summary.

### 7. Cold-Start Handover Test (`#/coldstart`)
- Authorized question generation across 10 continuity categories from published `PROJECT_SHARED` handover items only.
- Deterministic concept-coverage evaluator supporting `CORRECT`, `PARTIAL`, `INCORRECT`, and `UNANSWERED` states, abbreviation equivalence, keyword-stuffing rejection, explicit non-competence disclaimer, rapid duplicate submit guard (`409`) with intentional retry (`forceNewAttempt: true`), and `INCOMING_MEMBER` run privacy (`403` on other users' runs).

### 8. Sensitive-Content Redaction (`#/redaction`)
- Detection across `EMAIL`, `PHONE`, `SECRET`, `ID_NUMBER`, `RESTRICTED_KEYWORD`, and PI-configured project custom terms (`PATCH /api/projects/:id/settings`).
- Date/decimal false-positive filtering on phone patterns, masked previews in `GET /api/redactions`, non-destructive overlays (`[REDACTED:...]`) applied server-side in published handovers/records/versions/radar/Cold-Start, decision timeline history, Confirm/Reject/Revisit (`PROPOSED`) with rejection persistence across rescans, and `PI_LEAD`-only `/reveal` protected by password re-auth.

### 9. Team Presence, Handovers & Immutable Audit Ledger (`#/team`, `#/handover`, `#/audit`)
- Live team presence via heartbeat + SSE (`/api/presence/stream`), accurate `OFFLINE` status after logout/expiry, project-scoped `work_summary` and activity feed.
- Custom handover package drafting, server-redacted rendering, `PI_LEAD` password re-auth publish gate, recipient checklist toggles, and version-bound receipt acknowledgement.
- SQLite trigger-enforced append-only `audit_logs` (`BEFORE UPDATE` / `BEFORE DELETE` aborts), server-side draft autosave, and daily online `db.backup()` snapshots.

---

## Partial / Bounded Scope Items
- **Scanned PDF OCR**: Textless PDFs are detected and marked `NEEDS_OCR`, with manual text paste recovery built in; automatic raster OCR (e.g., Tesseract binary execution) is intentionally omitted to avoid native binary deployment dependencies.
- **Optional Gemini Augmentation**: Runs only if `GEMINI_API_KEY` is provided in server env and falls back to `baton-deterministic-extractor` without failing user workflows; default evaluation mode operates offline deterministically.
- **Real-Time Collaborative Multi-Cursor Editing**: Notes Studio prevents silent overwrites via optimistic locking (`409 VERSION_CONFLICT`) rather than CRDT/OT live character merging.
