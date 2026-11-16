# Troubleshooting Guide — BATON

## 1. Account Locked Out (`429: Invalid email or password, or account temporarily locked`)
- **Cause**: 5 consecutive incorrect password attempts triggered the 15-minute lockout (`locked_until`), or the fixed-window IP/account rate limiter triggered.
- **Resolution**: Wait for the `Retry-After` window (up to 15 minutes) to expire. For local development/testing resets on a throwaway DB, stop the server and remove `DATA_DIR` (`./data`) — **do not run this against real user data**.

## 2. `403 Invalid or missing CSRF token`
- **Cause**: Client state is stale after server restart, logout, or session rotation (`POST /api/auth/reauth`), or an external tool (`curl`) omitted `X-CSRF-Token`.
- **Resolution**: Refresh the page or sign in again so the frontend receives the fresh `csrfToken`. In automated scripts, capture `csrfToken` from `/api/auth/login`, `/api/auth/register`, and `/api/auth/reauth` and send it in `X-CSRF-Token` on all non-`GET` calls.

## 3. Session Immediately Drops Inside an Embedded `iframe`
- **Cause**: Third-party cookies require `SameSite=None; Secure; Partitioned`, which browsers only accept over HTTPS, or strict browser privacy shields block all third-party cookies.
- **Resolution**:
  - In production behind a TLS proxy, ensure `X-Forwarded-Proto: https` reaches Express (`trust proxy = 1`).
  - BATON's frontend (`src/lib/api.ts`) automatically falls back to sending `X-Baton-Session` via `sessionStorage` when cookies are blocked.

## 4. Uploaded PDF Marked `NEEDS_OCR`
- **Cause**: The uploaded `.pdf` is a scanned image or contains fewer than 20 alphanumeric extractable characters.
- **Resolution**: In `Files & Vault`, click **Submit OCR Text** on that source row (`POST /api/sources/:id/retry`) and paste the transcribed paragraph text to generate verbatim source spans.

## 5. `409 VERSION_CONFLICT` While Saving a Note
- **Cause**: Another session (or tab) saved a newer version of the shared note since your editor loaded it.
- **Resolution**: Copy any unsaved local changes you want to keep, click **Reload latest version** in the conflict banner (`Notes Studio`), and reapply edits cleanly.

## 6. `403 SENSITIVE_AUTH_REQUIRED` When Publishing Handover or Revealing Redactions
- **Cause**: Sensitive operations require password confirmation within the last 15 minutes (`hasSensitiveAuth`).
- **Resolution**: Complete the **Sensitive Action Password Verification** modal (enter your account password; on-device camera check alone never grants sensitive permission).

## 7. `422` Errors on Record Creation / Verification
- `"Confidence or truth scores are prohibited"`: Remove `confidence_score` / `truth_score` from payloads.
- `"Evidence state SUPPORTED requires the excerpt to appear verbatim in the cited source span"`: Copy an exact continuous substring (case/whitespace-insensitive) from the linked span, or save under `NEEDS_REVIEW` / `UNSUPPORTED`.
- `"Cross-project citations are prohibited"`: Link only spans belonging to sources within the same `projectId`.

## 8. Persistent Storage / Permission Errors (`SQLITE_READONLY` or `EACCES`)
- **Cause**: `DATA_DIR` points to a non-writable path or container ephemeral disk without write permissions.
- **Resolution**: Verify `DATA_DIR` is writable by the Node process (`chmod`/`chown`) and mounted on persistent storage in production. Check `GET /api/health` to confirm `dbIntegrity: true`.
