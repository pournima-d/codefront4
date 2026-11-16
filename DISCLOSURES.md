# Disclosures — BATON

## 1. AI Development Tools
- AI coding assistance was used during scaffolding, refactoring, test generation, and documentation review. Every generated security rule, database migration, and test assertion was verified against the live codebase.

## 2. Optional Model Integration (`@google/genai`)
- BATON includes an **optional** server-side `@google/genai` integration (`gemini-4-hydrogen`) used solely when `GEMINI_API_KEY` is explicitly configured in the server environment (and `useAi: true` is passed by the caller) for claim reconstruction (`server/engine.ts`) or handover narrative summary synthesis.
- When `GEMINI_API_KEY` is unset, placeholder (`MY_GEMINI_API_KEY`), offline, or times out (9-second abort controller), BATON falls back automatically to its deterministic rule-based extractor (`baton-deterministic-extractor`).
- **Untrusted Content Framing & Pre-SQL Isolation**: Only spans matching `visibility_level = 'PROJECT_SHARED' AND exclude_from_ai = 0` are ever eligible for extraction, delimited as `<<<UNTRUSTED_SPAN>>>` / `<<<RECORD>>>` blocks, and checked afterward with deterministic verbatim span matching.

## 3. Deterministic Algorithms (No LLM Dependency)
- **Claim Extraction & CSV Parsing**: Regex and structural span parsers (`parseUploadedSource`, `reconstructFromSource`).
- **Verbatim Citation Verification**: Case/whitespace-normalized substring & quoted-phrase verification (`verifyVerbatimInSpan`).
- **Knowledge-Debt Radar (`runRadarScan`)**: Rule-weighted point accumulation (`0–100` cap) based on owner concentration, departing flags, evidence states, span provenance, and age/date checks (`Date.now()`).
- **Cold-Start Handover Evaluation (`evaluateColdStartRun`)**: Token normalization, explicit domain synonym/abbreviation equivalence (`EQUIVALENT_TERMS`), repetition/keyword-stuffing detection, and coverage calculation (`CORRECT` / `PARTIAL` / `INCORRECT` / `UNANSWERED`).
- **Sensitive Content Scanner (`detectSensitiveInText`)**: Regular expressions + surrounding context/false-positive filters + PI-configured exact-term patterns.

## 4. External Libraries
- **Frontend**: `react`, `react-dom`, `lucide-react`, `motion`, `tailwindcss`, `@tailwindcss/vite`, `vite`.
- **Backend & Storage**: `express`, `better-sqlite3`, `cookie-parser`, `multer`, `pdf-parse`, `dotenv`, `@google/genai`.
- **Tooling**: `typescript`, `tsx`, `esbuild`.

## 5. Limitations & Human-Review Requirements
- **Human Review Required**: Automated extraction, Radar prioritization, sensitive-pattern proposals, and Cold-Start concept checks are triage aids only. Human reviewers (`REVIEWER` / `PI_LEAD`) must inspect cited source spans before approving records, confirming/rejecting redactions, or publishing handovers.
- **Cold-Start Disclaimer**: Cold-Start Knowledge Coverage evaluates alignment against the published handover brief only — **never** a newcomer's intelligence, competence, or suitability.
- **No Built-In Image OCR Engine**: Textless scanned PDFs are flagged `NEEDS_OCR` for manual transcript submission.
- **Custom HTML Sanitizer**: Rich-text Notes Studio HTML is filtered with a client `DOMParser` allowlist + server `sanitizeNoteHtml` sanitizer rather than an external sanitizer binary.

## 6. Synthetic Seed Data
- Fresh databases seed strictly 5 synthetic evaluation user accounts (`elena.vance@baton-lab.edu`, `marcus.chen@baton-lab.edu`, `priya.nair@baton-lab.edu`, `aria.patel@baton-lab.edu`, `jordan.lee@baton-lab.edu`) and one clean empty project (`PRJ-MAIN-01`, *"My Research Workspace"*). All evaluation accounts, test emails, and test tokens in automated tests are 100% synthetic.
- BATON does **not** use camera biometrics for authentication; `/api/auth/camera-login` is permanently disabled (`403`), and sensitive operations require password re-authentication.
