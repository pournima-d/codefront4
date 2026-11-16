# Role-Based Access Control (RBAC) Matrix — BATON

Authorization in BATON is enforced on the Express server (`server/authz.ts` & `server/routes.ts`) using each user's **project-scoped role** in `project_members(project_id, user_id, role)`. UI tab visibility (`ROLE_TABS`) mirrors these permissions but server checks are authoritative.

## Global & Project Membership Rules
- **Non-Members**: Blocked with HTTP `403` (`ACCESS_DENIED` logged to `audit_logs`) for any endpoint referencing a project they have not joined.
- **Public Registration (`POST /api/auth/register`)**: Always assigns `RESEARCHER`; client attempts to specify `PI_LEAD`, `REVIEWER`, or `AUDITOR` are ignored and audited (`PRIVILEGED_REGISTRATION_ATTEMPTED`).
- **Role Assignment (`/api/projects/:id/members`)**: Only `PI_LEAD` of that project can add, promote, demote, or remove members. Demoting or removing the last remaining `PI_LEAD` returns `400`. Changing another user's role invalidates their active sessions immediately.

## Permission Matrix by Capability

| Capability / Endpoint Group | `PI_LEAD` | `RESEARCHER` | `REVIEWER` | `INCOMING_MEMBER` | `AUDITOR` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Overview Dashboard** (`#/overview`) | Allow | Allow | Allow | Allow | Allow |
| **View Shared Sources / Download / Spans** | Allow | Allow | Allow | Allow | Allow |
| **Upload / Text-Ingest Shared Sources** | Allow | Allow | Deny (403) | Allow | Deny (403) |
| **Upload / View Own `PRIVATE_OWNER` Files** | Owner Only | Owner Only | Owner Only | Owner Only | Deny Write |
| **Upload / View `RESTRICTED_PI_ONLY` Files** | Allow | Deny (403) | Deny (403) | Deny (403) | Deny (403) |
| **Read Shared Notes & Own Private Notes** | Allow | Allow | Allow | Allow | Allow |
| **Create / Edit / Delete Notes (`#/notes`)** | Allow | Allow | Allow | Allow | **Deny (403)** |
| **View Knowledge Map & Shared Records** | Allow | Allow | Allow | Deny (403) | Allow |
| **Run AI/Rule Reconstruction (`/map/reconstruct`)** | Allow | Allow | Deny (403) | Deny (403) | Deny (403) |
| **Create / Edit / Bulk-Clear / Delete Records** | Allow | Allow | Deny (403) | Deny (403) | Deny (403) |
| **Verify Span Citation (`/records/:id/verify`)** | Allow | Allow | Allow | Deny (403) | Deny (403) |
| **Flag Broken Citation (`/flag-citation`)** | Allow | Allow | Allow | Deny (403) | Deny (403) |
| **Approve / Reject / Request Changes (`/review`)** | Allow | Deny (403) | Allow | Deny (403) | Deny (403) |
| **View Draft Handovers** | Allow | Allow | Allow | **Deny (Hidden)** | Allow |
| **View Published Handovers** | Allow | Allow | Allow | Allow (Redacted) | Allow |
| **Generate Handover Draft** | Allow | Allow | Deny (403) | Deny (403) | Deny (403) |
| **Publish Handover (`/handovers/:id/publish`)** | Allow + **Re-auth** | Deny (403) | Deny (403) | Deny (403) | Deny (403) |
| **Check Items & Acknowledge Receipt** | Allow | Deny (403) | Deny (403) | Allow | Deny (403) |
| **Team & Work Tracker (`#/team`)** | Allow | Allow | Allow | Allow | Allow |
| **Mark Departing / Update Team Member** | Allow | Deny (403) | Deny (403) | Deny (403) | Deny (403) |
| **Knowledge-Debt Radar (`#/radar`)** | Allow | Allow | Deny (403) | Deny (403) | Deny (403) |
| **Cold-Start Handover Test (`#/coldstart`)** | Allow (All Runs) | Deny (403) | Deny (403) | Allow (**Own Runs Only**) | Deny (403) |
| **Redaction Triage (`#/redaction`)** | Allow (All Non-Private) | Allow (Shared Only) | Deny (403) | Deny (403) | Deny (403) |
| **Reveal Unredacted Text (`/redactions/:id/reveal`)** | Allow + **Re-auth** | Deny (403) | Deny (403) | Deny (403) | Deny (403) |
| **Configure Project Custom Sensitive Patterns** | Allow | Deny (403) | Deny (403) | Deny (403) | Deny (403) |
| **Reset / Delete Project** | Allow | Deny (403) | Deny (403) | Deny (403) | Deny (403) |
| **Inspect Append-Only Audit Log (`#/audit`)** | Allow | Deny (403) | Deny (403) | Deny (403) | Allow |

## Row-Level Visibility Filters
1. **`PRIVATE_OWNER`**:
   - Sources: accessible strictly when `uploaded_by_id === user.id || uploaded_by === user.email`. Even `PI_LEAD` gets `403`.
   - Notes: accessible strictly when `author_id === user.id`.
   - Records: accessible strictly when `owner_user_id === user.id`.
   - Never exported to AI context, shared redactions, shared Radar, or Handovers.
2. **`RESTRICTED_PI_ONLY`**:
   - Accessible only to `PI_LEAD` in that project; excluded from AI extraction (`exclude_from_ai = 1`), Handover generation, and Cold-Start tests.
3. **`PROJECT_SHARED`**:
   - Visible to authorized project roles (`INCOMING_MEMBER` sees `PROJECT_SHARED` items once published in a handover or in shared Files/Notes, not unverified Map/Records/Radar).
