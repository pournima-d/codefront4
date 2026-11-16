# Testing Documentation — BATON

## Automated Test Command

```bash
npm test
```

Runs `tsx --test tests/*.test.ts` (Node built-in test runner executing full-stack integration tests against live isolated HTTP servers and temporary SQLite `DATA_DIR` instances).

### Type-Check & Build Commands

```bash
npm run lint    # Runs `tsc --noEmit` across server and React/TypeScript frontend
npm run build   # Runs `vite build` to bundle production frontend into dist/
```

---

## Test Classification & Methodology
- **Automated Integration Tests (`tests/baton.test.ts`)**: End-to-end HTTP `fetch` requests exercising real Express middleware, authentication cookies, `X-Baton-Session`, `X-CSRF-Token`, multer uploads, SQLite WAL persistence, `server/engine.ts` pipelines, and server restarts across the same temporary `DATA_DIR`.
- **Direct Database Invariant Checks (inside `tests/baton.test.ts`)**: Direct SQLite assertions against `audit_logs` append-only triggers (`UPDATE` and `DELETE` abort), `PRAGMA integrity_check`, `PRAGMA foreign_keys`, and `sessions.expires_at` expiry.
- **Type-Check & Bundle Verification**: `npm run lint` (`tsc --noEmit`) and `npm run build` (`vite build`).
- **Standalone Browser / Cross-Browser Checks**: Not run with an automated headless browser (e.g., Playwright/Cypress) or across Safari/Firefox/Edge matrices in this environment; React components are verified through TypeScript static compilation, Vite bundling, and code inspection.

---

## Observed Automated Test Results (`tests/baton.test.ts`)

**Result Summary**: **10 / 10 integration tests passed, 0 failed, 0 skipped.**

| # | Test Suite Name | Key Scenarios Verified | Outcome |
| :--- | :--- | :--- | :--- |
| 1 | `Clean-start workspace, 5-attempt lockout, privileged registration prevention, CSRF & session expiry` | Empty seeded workspace (`0` files/notes/records), 5-attempt lockout (`429`), registration ignoring `role: 'PI_LEAD'` -> forces `RESEARCHER` & logs `PRIVILEGED_REGISTRATION_ATTEMPTED`, duplicate email (`409`), forged CSRF (`403`), post-logout cookie (`401`), expired session (`401`) | PASS |
| 2 | `Private vs Public file isolation, visibility toggle, and RBAC ACCESS_DENIED audit` | `PRIVATE_OWNER` hidden from `PI_LEAD` (listing/spans/download `403`), `RESTRICTED_PI_ONLY` hidden from non-PI (`403`), `INCOMING_MEMBER` blocked (`403`) from audit/radar/redactions, owner visibility toggle to `PROJECT_SHARED`, `ACCESS_DENIED` logs | PASS |
| 3 | `Upload validation: duplicate SHA-256 (409), unsupported ext (415), empty/malformed/traversal (400/422), scanned PDF NEEDS_OCR & OCR retry` | SHA-256 dedup (`409`), `.exe` rejected (`415`), empty file (`400`), path traversal (`400`), malformed JSON (`422`), fake PDF missing `%PDF-` (`422`), empty PDF -> `NEEDS_OCR` -> inline recovery -> `PARSED` | PASS |
| 4 | `Notes Studio enforces Private/Public visibility, XSS sanitization, optimistic locking (409), and AUDITOR read-only` | `<script>`/`onclick`/`javascript:` stripped, `PRIVATE_OWNER` isolated from `PI_LEAD` (`403`), version increment on update (`v1` -> `v2`), stale `expected_version` -> `409 VERSION_CONFLICT` | PASS |
| 5 | `Pre-filtered reconstruction, 422 verbatim & confidence rules, mandatory review rationale, and edit invalidation` | Pre-AI filtering (`RESTRICTED_PI_ONLY` excluded), researcher blocked from reviewing (`403`), `confidence_score` rejected (`422`), non-verbatim `SUPPORTED` rejected (`422`), `<3` char review comment rejected (`400`), valid approval -> edit invalidates approval (`NEEDS_REVIEW`, version++), `record_versions`, citation flag (`UNSUPPORTED`) | PASS |
| 6 | `Knowledge-Debt Radar explainable scoring, future-date clamping, rescan resolution persistence, and reopen` | `lastScannedAt` populated, multi-factor reasons array, `2099-01-01` date NOT inflated as stale >60d, resolve -> rescan preserves `resolved: true`, reopen `{ resolved: false }` works | PASS |
| 7 | `Redactions (masking, false-positive guard, rejection persistence, reveal gate), handover publish, Cold-Start privacy & duplicate guard, and persistence` | Date/float avoids `PHONE` false positive, PI custom sensitive pattern detection & masking in `GET /api/redactions`, `REJECTED` preserved across rescan, revisit `PROPOSED`, researcher blocked (`403`) & un-reauthenticated PI blocked (`403 SENSITIVE_AUTH_REQUIRED`) on `/reveal`, `reauth` rotates CSRF + unlocks reveal & publish, `[REDACTED:email]` verified on handover delivered to `INCOMING_MEMBER`, item check & ack, Cold-Start `UNANSWERED`/concept scoring + `409` duplicate guard + `forceNewAttempt` + cross-user `403`, Team `work_summary` + `ONLINE` presence, DB/server restart persistence, `audit_logs` `UPDATE`/`DELETE` trigger aborts, `PRAGMA integrity_check = ok` | PASS |
| 8 | `Legacy camera-login is rejected (403), HTTPS SameSite=None cookie & X-Baton-Session fallback work, and project-scoped membership & cross-project isolation hold` | `/api/auth/camera-login` rejected (`403`), HTTPS `X-Forwarded-Proto` issues `SameSite=None; Secure; Partitioned; HttpOnly`, `X-Baton-Session` project creation, non-member `403`, nonexistent project `404`, `PI_LEAD` assigns `AUDITOR` (`403` on note write), last `PI_LEAD` demotion rejected (`400`) | PASS |
| 9 | `Delete capability across records, handovers, redactions, coldstart runs, and projects with RBAC & audit logging` | Record delete + RBAC (`403`), published handover delete blocked for non-PI (`403`), draft handover delete, Cold-Start run delete, redaction delete, non-default project delete, last project delete blocked (`400`), delete audit entries verified | PASS |
| 10 | `Bulk clear records (DELETE /api/records) and full project reset (POST /api/projects/:id/reset)` | Non-PI clear blocked (`403`), bulk clear preserves files/notes, full reset clears project state, project-scoped `RECORDS_CLEARED` & `PROJECT_RESET` audit entries verified | PASS |
