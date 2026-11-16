# Data Flow Documentation — BATON

## 1. End-to-End Five-Stage Pipeline Data Flow

```
[Stage 01: Connect]
  User uploads file (.pdf/.md/.txt/.csv/.json) or writes Note
       │
       ├─► File Validation & SHA-256 Check (`validation.ts`)
       ├─► Atomic Write (`DATA_DIR/tmp/<uuid>` -> fsync -> `DATA_DIR/uploads/`)
       ├─► SQLite `sources` + `source_spans` commit (or `NEEDS_OCR` if scanned PDF)
       └─► Automatic `scanSensitiveContentForProject()` (skipped for `PRIVATE_OWNER` by default)
       │
[Stage 02: Reconstruct]
  PI_LEAD / RESEARCHER triggers Reconstruction (`POST /api/map/reconstruct`)
       │
       ├─► SQL Pre-Filter: `WHERE project_id = ? AND visibility_level = 'PROJECT_SHARED' AND exclude_from_ai = 0`
       ├─► Logs `AI_CONTEXT_FILTERED` (included vs filtered count, masking private titles)
       ├─► Deterministic Extractor (`baton-deterministic-extractor`) OR optional Gemini (`<<<UNTRUSTED_SPAN>>>`)
       └─► Inserts candidate `records` (`stage = '02'`, `approval_state = 'NEEDS_REVIEW'`, version `1`)
       │
[Stage 03: Verify]
  Researcher / Reviewer edits excerpt or runs `/api/records/:id/verify`
       │
       ├─► Rejects any `confidence_score` / `truth_score` (`422`)
       ├─► Verbatim check (`verifyVerbatimInSpan`) -> `SUPPORTED` or `UNSUPPORTED`
       └─► On Edit: `version++`, writes `record_versions` snapshot, resets `approval_state = 'NEEDS_REVIEW'`
       │
[Stage 04: Review, Redaction & Knowledge-Debt Radar]
  ├─► REVIEWER / PI_LEAD submits `/api/records/:id/review` (min 3-char rationale -> `APPROVED` / `REJECTED` / `REQUEST_CHANGES` / `FLAG_GAP`)
  ├─► Radar (`runRadarScan`) evaluates ownership, evidence state, missing spans & dates -> non-destructive upsert preserving valid `resolved = 1`
  └─► Redaction (`resolve`) confirms or rejects proposals (`REJECTED` persists on rescan; `CONFIRMED` masks outputs)
       │
[Stage 05: Handover & Cold-Start Verification]
  ├─► Draft excludes `PRIVATE_OWNER`, `RESTRICTED_PI_ONLY`, `exclude_from_ai = 1`, and `REJECTED` records
  ├─► Server applies `applyConfirmedRedactions()` dynamically across `title`, `summary_md`, and `handover_items`
  ├─► PI_LEAD password `reauth` unlocks `POST /api/handovers/:id/publish`
  ├─► INCOMING_MEMBER inspects published brief, checks items, acknowledges version (`handover_acknowledgements`)
  └─► Cold-Start generates authorized questions strictly from published `PROJECT_SHARED` handover -> deterministic evaluation + private run storage
```

## 2. Privacy Boundary Enforcement Points
1. **Private Sources (`PRIVATE_OWNER`)**: Excluded in SQL from other users' `/api/sources`, `/api/map`, `/api/redactions` (unless scoped explicitly to the owner), `getAuthorizedAiSpans()`, `applyConfirmedRedactions()`, and `createHandoverDraft()`.
2. **PI-Restricted Sources & Records (`RESTRICTED_PI_ONLY`)**: Visible only to `PI_LEAD`; marked `exclude_from_ai = 1`; excluded from `getAuthorizedAiSpans()`, `createHandoverDraft()`, `GET /api/handovers`, and `buildColdStartQuestions()`.
3. **Cold-Start Run Privacy**: Stored with `user_id`; `GET /api/coldstart` and `GET /api/coldstart/runs/:id` restrict `INCOMING_MEMBER` queries strictly to `run.user_id === req.auth.user.id`.
