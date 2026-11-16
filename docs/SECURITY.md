# Security Architecture & Controls — BATON

## 1. Password & Credential Storage
- Passwords hashed using Node's `crypto.scryptSync(password, salt, 64)` with per-user 16-byte CSPRNG salts stored as `<saltHex>:<derivedHex>`.
- Verification uses `crypto.timingSafeEqual` to eliminate timing side-channels.
- Account lockout trips at **5 consecutive failed login attempts** (`locked_until = now + 15 minutes`, HTTP `429`), emitting generic messages so account existence is not enumerated.

## 2. Sessions, Cookies & CSRF Protection
- Session IDs are 256-bit CSPRNG hex tokens stored server-side in SQLite `sessions` with a 12-hour TTL (`expires_at`).
- Login rotates/clears any pre-existing session ID (preventing session fixation) and purges expired sessions.
- Cookie attributes dynamically adapt to transport:
  - HTTPS or reverse proxy (`req.secure` / `X-Forwarded-Proto: https`): `HttpOnly; Secure; SameSite=None; Partitioned` (CHIPS-compatible for embedded iframe previews).
  - Plain localhost HTTP: `HttpOnly; SameSite=Lax`.
  - Session header fallback `X-Baton-Session` supported when third-party cookies are blocked in embedded frames.
- Every state-changing request (`POST`, `PATCH`, `PUT`, `DELETE`) requires `X-CSRF-Token` verified via `crypto.timingSafeEqual` against the session's `csrf_token`. Failures log `CSRF_REJECTED` and return `403`.

## 3. Sensitive Re-Authentication (`POST /api/auth/reauth`)
- High-risk operations (`POST /api/handovers/:id/publish`, `POST /api/redactions/:id/reveal`) require active password re-authentication within the past **15 minutes** (`reauth_until`).
- Successful re-auth rotates both the session ID and CSRF token (`rotateUserSession`).
- Passwordless `POST /api/auth/camera-login` is permanently disabled (`403`, audited as `CAMERA_LOGIN_REJECTED`). Local camera preview (`POST /api/auth/camera-check`) is informational only and never authorizes sensitive operations.

## 4. Privilege Escalation & Cross-Project Guards
- `POST /api/auth/register` unconditionally sets `role = 'RESEARCHER'` and writes `PRIVILEGED_REGISTRATION_ATTEMPTED` if a client attempts to supply another role.
- `resolveAuthorizedProject` rejects malformed `projectId` (`400`), missing `projectId` (`404`), and non-member access (`403`), never falling back to a default project when an explicit project ID fails.
- Role changes on a project invalidate the target user's active sessions in SQLite so elevated or revoked privileges take effect immediately.

## 5. Persistent Rate Limiting
- Rate limits are stored in SQLite (`rate_limits` table via `checkRateLimit` in `server/rateLimit.ts`) and derive client IPs strictly from `req.ip` (`app.set('trust proxy', 1)`).
- No public request header or query flag can disable rate limiting. Exceeded windows return HTTP `429` with standard `Retry-After` headers.

## 6. File Upload, Path Traversal & XSS Controls
- Uploads restricted to `.pdf`, `.md`, `.txt`, `.csv`, `.json` up to `2 MB`, with forbidden binary/HTML/script MIME rejection, null-byte checks, JSON syntax validation, and `%PDF-` header checks.
- Path traversal sequences (`..`, `/`, `\`) are rejected (`400` in text upload) and sanitized (`sanitizeFilename` + `sanitizeFsPathWithinDir`) before disk I/O.
- Downloads set `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- Rich-text HTML in Notes Studio passes through both client-side `DOMParser` sanitization and server-side `sanitizeNoteHtml()` stripping `<script>`, `<iframe>`, `<object>`, `<embed>`, `<svg>`, `<form>`, HTML comments, `on*` event attributes, and `javascript:`/`vbscript:`/`data:` URIs.

## 7. Audit Log & Sensitive Data Masking
- `audit_logs` is protected by SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers (`audit_logs is append-only`), and `redactAuditDetail()` strips keys like `password`, `csrfToken`, `sessionToken`, `apiKey`, and `matched_text`.
- `GET /api/redactions` returns masked previews (`maskSensitiveMatch`) rather than raw credentials/emails; unmasked values are only revealed to `PI_LEAD` via `POST /api/redactions/:id/reveal` behind password re-auth and audit logging.
