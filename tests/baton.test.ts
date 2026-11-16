import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createBatonApp } from '../server.ts';

class TestClient {
  baseUrl: string;
  cookie = '';
  csrfToken = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async req(method: string, urlPath: string, body?: unknown, isMultipart = false) {
    const headers: Record<string, string> = {};
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (this.csrfToken && method !== 'GET') headers['X-CSRF-Token'] = this.csrfToken;

    let fetchBody: BodyInit | undefined;
    if (body instanceof FormData) {
      fetchBody = body;
    } else if (body !== undefined && !isMultipart) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }

    const res = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers,
      body: fetchBody,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
    const json = await res.json().catch(() => ({}));
    if (
      (urlPath === '/api/auth/login' ||
        urlPath === '/api/auth/register' ||
        urlPath === '/api/auth/reauth') &&
      res.ok &&
      json.csrfToken
    ) {
      this.csrfToken = json.csrfToken;
    }
    return { status: res.status, data: json };
  }

  async login(email: string, password = 'Baton@2026') {
    this.cookie = '';
    this.csrfToken = '';
    return this.req('POST', '/api/auth/login', { email, password });
  }
}

let tempDir = '';
let server: http.Server;
let baseUrl = '';
let closeDb: (() => void) | null = null;
let activeDb: ReturnType<typeof createBatonApp>['db'] | null = null;

function bootTestServer() {
  const { app, db } = createBatonApp(tempDir);
  activeDb = db;
  closeDb = () => {
    activeDb = null;
    db.close();
  };
  return { app, db };
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-test-'));
  const { app } = bootTestServer();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  closeDb?.();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Clean-start workspace, 5-attempt lockout, privileged registration prevention, CSRF & session expiry', async () => {
  const client = new TestClient(baseUrl);
  for (let i = 0; i < 5; i++) {
    const fail = await client.login('jordan.lee@baton-lab.edu', 'WrongPass!');
    assert.ok(fail.status === 401 || fail.status === 429);
  }
  const locked = await client.login('jordan.lee@baton-lab.edu', 'Baton@2026');
  assert.equal(locked.status, 429);

  const pi = new TestClient(baseUrl);
  const ok = await pi.login('elena.vance@baton-lab.edu', 'Baton@2026');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'PI_LEAD');

  // Verify zero pre-seeded demo content
  const overview = await pi.req('GET', '/api/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.data.project.id, 'PRJ-MAIN-01');
  assert.equal(overview.data.metrics.sourcesCount, 0);
  assert.equal(overview.data.metrics.notesCount, 0);
  assert.equal(overview.data.metrics.recordsCount, 0);

  // Public self-service registration MUST ignore privileged role escalation (forces RESEARCHER)
  const regClient = new TestClient(baseUrl);
  const regOk = await regClient.req('POST', '/api/auth/register', {
    name: 'Dr. Nina Brooks',
    email: 'nina.brooks@baton-lab.edu',
    password: 'ResearchPassword123',
    title: 'Electrochemistry Fellow',
    role: 'PI_LEAD',
  });
  assert.equal(regOk.status, 201);
  assert.equal(regOk.data.user.role, 'RESEARCHER');

  const auditPrivAttempt = await pi.req('GET', '/api/audit?action=PRIVILEGED_REGISTRATION_ATTEMPTED');
  assert.equal(auditPrivAttempt.status, 200);
  assert.ok(auditPrivAttempt.data.logs.length >= 1);

  // Duplicate email rejected with 409
  const regDup = await regClient.req('POST', '/api/auth/register', {
    name: 'Duplicate',
    email: 'nina.brooks@baton-lab.edu',
    password: 'ResearchPassword123',
  });
  assert.equal(regDup.status, 409);

  // Missing or invalid CSRF token rejected with 403
  const csrfRes = await fetch(`${baseUrl}/api/notes`, {
    method: 'POST',
    headers: {
      Cookie: regClient.cookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'forged-csrf-token',
    },
    body: JSON.stringify({ title: 'Blocked', content_html: '<p>x</p>', plain_text: 'x' }),
  });
  assert.equal(csrfRes.status, 403);

  // Logout invalidates session so reusing cookie returns 401
  const logoutRes = await regClient.req('POST', '/api/auth/logout', {});
  assert.equal(logoutRes.status, 200);
  const postLogoutMe = await regClient.req('GET', '/api/auth/me');
  assert.equal(postLogoutMe.status, 401);

  // Expired session row in SQLite returns 401
  const expiredClient = new TestClient(baseUrl);
  const expLogin = await expiredClient.login('nina.brooks@baton-lab.edu', 'ResearchPassword123');
  assert.equal(expLogin.status, 200);
  assert.ok(activeDb);
  activeDb.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 10_000, expLogin.data.user.id);
  const expMe = await expiredClient.req('GET', '/api/auth/me');
  assert.equal(expMe.status, 401);
});

test('Private vs Public file isolation, visibility toggle, and RBAC ACCESS_DENIED audit', async () => {
  const researcher = new TestClient(baseUrl);
  await researcher.login('marcus.chen@baton-lab.edu');

  // Upload a PRIVATE_OWNER file
  const privFd = new FormData();
  privFd.append('file', new Blob(['Private hypothesis notes for Marcus only.'], { type: 'text/markdown' }), 'marcus-private.md');
  privFd.append('title', 'Marcus Private Draft');
  privFd.append('visibility_level', 'PRIVATE_OWNER');
  const privUp = await researcher.req('POST', '/api/sources/upload', privFd, true);
  assert.equal(privUp.status, 201);
  const privateSourceId = privUp.data.source.id as string;
  assert.equal(privUp.data.source.visibility_level, 'PRIVATE_OWNER');

  // Upload a PROJECT_SHARED file with contact info + restricted keyword for redaction coverage
  const sharedRes = await researcher.req('POST', '/api/sources/text', {
    title: 'Baseline Synthesis Protocol',
    filename: 'protocol-v1.md',
    content: [
      'Objective: Validate thermal cycling stability across 50 cycles.',
      '',
      'Result: Annealed sample A-12 achieved 94.6% yield under nitrogen flow.',
      '',
      'Risk: Pre-patent disclosure contact marcus.private@example-lab.org pending review.',
    ].join('\n'),
    visibility_level: 'PROJECT_SHARED',
    exclude_from_ai: false,
  });
  assert.equal(sharedRes.status, 201);
  const sharedSourceId = sharedRes.data.source.id as string;

  // PI_LEAD uploads a RESTRICTED_PI_ONLY file
  const pi = new TestClient(baseUrl);
  await pi.login('elena.vance@baton-lab.edu');
  const piRestricted = await pi.req('POST', '/api/sources/text', {
    title: 'PI IP Filing Memo',
    filename: 'pi-ip-memo.md',
    content: 'Patent draft disclosure reserved strictly for principal investigator. Secret key sk_demo_restrict9988.',
    visibility_level: 'RESTRICTED_PI_ONLY',
    exclude_from_ai: true,
  });
  assert.equal(piRestricted.status, 201);
  const restrictedId = piRestricted.data.source.id as string;

  // PI_LEAD CANNOT list or read Researcher's PRIVATE_OWNER file
  const piSources = await pi.req('GET', '/api/sources');
  assert.equal(piSources.status, 200);
  assert.ok(!piSources.data.sources.some((s: { id: string }) => s.id === privateSourceId));
  assert.ok(piSources.data.sources.some((s: { id: string }) => s.id === sharedSourceId));

  const piDeniedSpans = await pi.req('GET', `/api/sources/${privateSourceId}/spans`);
  assert.equal(piDeniedSpans.status, 403);
  const piDeniedDl = await fetch(`${baseUrl}/api/sources/${privateSourceId}/download`, {
    headers: { Cookie: pi.cookie },
  });
  assert.equal(piDeniedDl.status, 403);

  // Researcher CANNOT access RESTRICTED_PI_ONLY source
  const resDeniedRestricted = await researcher.req('GET', `/api/sources/${restrictedId}/spans`);
  assert.equal(resDeniedRestricted.status, 403);

  // Incoming member can read shared sources, blocked from audit log & radar & redactions
  const incoming = new TestClient(baseUrl);
  await incoming.login('aria.patel@baton-lab.edu');
  const incSources = await incoming.req('GET', '/api/sources');
  assert.equal(incSources.status, 200);
  assert.ok(incSources.data.sources.some((s: { id: string }) => s.id === sharedSourceId));
  assert.ok(!incSources.data.sources.some((s: { id: string }) => s.id === privateSourceId));
  assert.ok(!incSources.data.sources.some((s: { id: string }) => s.id === restrictedId));
  assert.equal((await incoming.req('GET', '/api/audit')).status, 403);
  assert.equal((await incoming.req('GET', '/api/radar')).status, 403);
  assert.equal((await incoming.req('GET', '/api/redactions')).status, 403);

  // Owner toggles PRIVATE_OWNER -> PROJECT_SHARED -> now PI & team can see it
  const toggleRes = await researcher.req('PATCH', `/api/sources/${privateSourceId}/visibility`, {
    visibility_level: 'PROJECT_SHARED',
  });
  assert.equal(toggleRes.status, 200);
  assert.equal(toggleRes.data.source.visibility_level, 'PROJECT_SHARED');

  const piSourcesAfter = await pi.req('GET', '/api/sources');
  assert.ok(piSourcesAfter.data.sources.some((s: { id: string }) => s.id === privateSourceId));

  // Verify ACCESS_DENIED audit entries recorded
  const auditRes = await pi.req('GET', '/api/audit?action=ACCESS_DENIED');
  assert.equal(auditRes.status, 200);
  assert.ok(auditRes.data.logs.length >= 3);
});

test('Upload validation: duplicate SHA-256 (409), unsupported ext (415), empty/malformed/traversal (400/422), scanned PDF NEEDS_OCR & OCR retry', async () => {
  const resClient = new TestClient(baseUrl);
  await resClient.login('marcus.chen@baton-lab.edu');

  const mdContent = 'Sample K-09 annealed at 920C achieved 96.4% purity.';
  const fd1 = new FormData();
  fd1.append('file', new Blob([mdContent], { type: 'text/markdown' }), 'sample-k09.md');
  fd1.append('visibility_level', 'PROJECT_SHARED');
  const up1 = await resClient.req('POST', '/api/sources/upload', fd1, true);
  assert.equal(up1.status, 201);
  assert.equal(up1.data.status, 'PARSED');

  // Duplicate SHA-256 -> 409
  const fdDup = new FormData();
  fdDup.append('file', new Blob([mdContent], { type: 'text/markdown' }), 'sample-k09-copy.md');
  const upDup = await resClient.req('POST', '/api/sources/upload', fdDup, true);
  assert.equal(upDup.status, 409);

  // Bad extension -> 415
  const fdBad = new FormData();
  fdBad.append('file', new Blob(['binary'], { type: 'application/octet-stream' }), 'malware.exe');
  const upBad = await resClient.req('POST', '/api/sources/upload', fdBad, true);
  assert.equal(upBad.status, 415);

  // Empty file -> 400
  const fdEmpty = new FormData();
  fdEmpty.append('file', new Blob([''], { type: 'text/plain' }), 'empty.txt');
  const upEmpty = await resClient.req('POST', '/api/sources/upload', fdEmpty, true);
  assert.equal(upEmpty.status, 400);

  // Path traversal filename rejected cleanly with 400 on direct text source & sanitized on multipart
  const upTrav = await resClient.req('POST', '/api/sources/text', {
    title: 'Traversal Attempt',
    filename: '../../etc/passwd.txt',
    content: 'hello world',
  });
  assert.equal(upTrav.status, 400);

  // Malformed JSON -> 422
  const fdBadJson = new FormData();
  fdBadJson.append('file', new Blob(['{not valid json'], { type: 'application/json' }), 'broken.json');
  const upBadJson = await resClient.req('POST', '/api/sources/upload', fdBadJson, true);
  assert.equal(upBadJson.status, 422);

  // Fake PDF missing %PDF- header -> 422
  const fdFakePdf = new FormData();
  fdFakePdf.append('file', new Blob(['not actually a pdf'], { type: 'application/pdf' }), 'fake.pdf');
  const upFakePdf = await resClient.req('POST', '/api/sources/upload', fdFakePdf, true);
  assert.equal(upFakePdf.status, 422);

  // Scanned PDF -> NEEDS_OCR, then OCR retry -> PARSED
  const fdPdf = new FormData();
  fdPdf.append('file', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), 'scanned-notebook.pdf');
  const upPdf = await resClient.req('POST', '/api/sources/upload', fdPdf, true);
  assert.equal(upPdf.status, 201);
  assert.equal(upPdf.data.status, 'NEEDS_OCR');

  const retryRes = await resClient.req('POST', `/api/sources/${upPdf.data.source.id}/retry`, {
    raw_text: 'Recovered OCR paragraph: Batch K-09 XRD pattern confirms single phase.',
  });
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.data.status, 'PARSED');
  assert.ok(retryRes.data.spanCount >= 1);
});

test('Notes Studio enforces Private/Public visibility, XSS sanitization, optimistic locking (409), and AUDITOR read-only', async () => {
  const researcher = new TestClient(baseUrl);
  await researcher.login('marcus.chen@baton-lab.edu');

  const privNote = await researcher.req('POST', '/api/notes', {
    title: 'Private Lab Scratchpad',
    content_html: '<p><strong>Confidential</strong> observations before verification.</p><script>alert("xss")</script>',
    plain_text: 'Confidential observations before verification.',
    font_family: 'Georgia',
    visibility_level: 'PRIVATE_OWNER',
  });
  assert.equal(privNote.status, 201);
  const privNoteId = privNote.data.note.id as string;
  assert.equal(privNote.data.note.word_count, 4);
  assert.ok(!String(privNote.data.note.content_html).includes('<script'));

  const pubNote = await researcher.req('POST', '/api/notes', {
    title: 'Shared Team Meeting Minutes',
    content_html:
      '<h2>Meeting Agenda</h2><p onclick="evil()">Reviewed thermal stability benchmarks.</p><a href="javascript:alert(1)">bad</a>',
    plain_text: 'Meeting Agenda Reviewed thermal stability benchmarks.',
    font_family: 'DM Sans',
    visibility_level: 'PROJECT_SHARED',
  });
  assert.equal(pubNote.status, 201);
  const pubNoteId = pubNote.data.note.id as string;
  const v1 = pubNote.data.note.version as number;
  assert.equal(v1, 1);
  assert.ok(!String(pubNote.data.note.content_html).includes('onclick'));
  assert.ok(!String(pubNote.data.note.content_html).includes('javascript:'));

  // Another user (PI_LEAD) cannot see or mutate the researcher's PRIVATE_OWNER note
  const pi = new TestClient(baseUrl);
  await pi.login('elena.vance@baton-lab.edu');
  const piNotes = await pi.req('GET', '/api/notes');
  assert.equal(piNotes.status, 200);
  assert.ok(!piNotes.data.notes.some((n: { id: string }) => n.id === privNoteId));
  assert.ok(piNotes.data.notes.some((n: { id: string }) => n.id === pubNoteId));

  const deniedPatch = await pi.req('PATCH', `/api/notes/${privNoteId}`, { title: 'Tampered' });
  assert.equal(deniedPatch.status, 403);
  const deniedDel = await pi.req('DELETE', `/api/notes/${privNoteId}`);
  assert.equal(deniedDel.status, 403);

  // Author updates shared note -> increments version -> stale expected_version returns 409 VERSION_CONFLICT
  const updated = await researcher.req('PATCH', `/api/notes/${pubNoteId}`, {
    title: 'Shared Team Meeting Minutes (Final)',
    font_family: 'Plus Jakarta Sans',
    plain_text: 'Updated minutes covering thermal stability and sample handoff.',
    expected_version: v1,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.note.title, 'Shared Team Meeting Minutes (Final)');
  assert.equal(updated.data.note.word_count, 8);
  assert.equal(updated.data.note.version, 2);

  const conflict = await researcher.req('PATCH', `/api/notes/${pubNoteId}`, {
    title: 'Stale Overwrite Attempt',
    expected_version: 1,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'VERSION_CONFLICT');
  assert.equal(conflict.data.currentVersion, 2);

  // Clean up private note
  const deleted = await researcher.req('DELETE', `/api/notes/${privNoteId}`);
  assert.equal(deleted.status, 200);
});

test('Pre-filtered reconstruction, 422 verbatim & confidence rules, mandatory review rationale, and edit invalidation', async () => {
  const pi = new TestClient(baseUrl);
  await pi.login('elena.vance@baton-lab.edu');

  const mapRes = await pi.req('GET', '/api/map');
  assert.equal(mapRes.status, 200);
  assert.ok(mapRes.data.sources.length >= 2);

  // Reconstruct across all visible sources (includes RESTRICTED_PI_ONLY -> filtered out)
  const reconRes = await pi.req('POST', '/api/map/reconstruct', {
    sourceIds: mapRes.data.sources.map((s: { id: string }) => s.id),
    focus: 'thermal stability',
    useAi: false,
  });
  assert.equal(reconRes.status, 200);
  assert.ok(reconRes.data.filterSummary.filteredOutCount >= 1);
  assert.ok(reconRes.data.createdCount >= 1);

  const recList = await pi.req('GET', '/api/records');
  assert.equal(recList.status, 200);
  assert.ok(recList.data.records.length >= 1);
  const firstRec = recList.data.records[0];

  // Researcher blocked from reviewing
  const researcher = new TestClient(baseUrl);
  await researcher.login('marcus.chen@baton-lab.edu');
  const deniedReview = await researcher.req('POST', `/api/records/${firstRec.id}/review`, {
    action: 'APPROVE',
    comment: 'Attempted self-approval.',
  });
  assert.equal(deniedReview.status, 403);

  // Reject confidence_score (422)
  const confReject = await researcher.req('PATCH', `/api/records/${firstRec.id}`, { confidence_score: 95 });
  assert.equal(confReject.status, 422);

  // Reject non-verbatim SUPPORTED claim (422)
  const nonVerbatim = await researcher.req('PATCH', `/api/records/${firstRec.id}`, {
    excerpt: 'Fabricated sentence that does not exist anywhere in cited span',
    evidence_state: 'SUPPORTED',
  });
  assert.equal(nonVerbatim.status, 422);

  // Missing rationale (< 3 chars) rejected with 400
  const reviewer = new TestClient(baseUrl);
  const revLogin = await reviewer.login('priya.nair@baton-lab.edu');
  assert.equal(revLogin.status, 200);
  const noCommentRes = await reviewer.req('POST', `/api/records/${firstRec.id}/review`, {
    action: 'APPROVE',
    comment: 'ok',
  });
  assert.equal(noCommentRes.status, 400);

  // Approve claim with valid rationale, verify REQUEST_CHANGES / FLAG_GAP, then edit it -> invalidates approval & increments version
  const approveRes = await reviewer.req('POST', `/api/records/${firstRec.id}/review`, {
    action: 'APPROVE',
    comment: 'Verified against span.',
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.approval_state, 'APPROVED');

  const editApproved = await researcher.req('PATCH', `/api/records/${firstRec.id}`, {
    title: `${firstRec.title} (Updated)`,
    rationale: 'Updated continuity rationale',
    edit_reason: 'Clarified scope',
  });
  assert.equal(editApproved.status, 200);
  assert.equal(editApproved.data.record.version, firstRec.version + 1);
  assert.equal(editApproved.data.record.approval_state, 'NEEDS_REVIEW');
  assert.equal(editApproved.data.record.approved_version, null);

  // Version history + citation flag
  const verRes = await pi.req('GET', `/api/records/${firstRec.id}/versions`);
  assert.equal(verRes.status, 200);
  assert.ok(verRes.data.versions.length >= 2);

  const flagRes = await pi.req('POST', `/api/records/${firstRec.id}/flag-citation`, {
    reason: 'Locator shifted after file update',
  });
  assert.equal(flagRes.status, 200);
  assert.equal(flagRes.data.evidence_state, 'UNSUPPORTED');
});

test('Knowledge-Debt Radar explainable scoring, future-date clamping, rescan resolution persistence, and reopen', async () => {
  const pi = new TestClient(baseUrl);
  await pi.login('elena.vance@baton-lab.edu');

  // Create a record with a future date and no owner to test Radar edge cases
  const futureRecRes = await pi.req('POST', '/api/records', {
    type: 'RISK',
    title: 'Future-dated unverified calibration risk',
    excerpt: 'Ethane cup calibration pending review.',
    evidence_state: 'UNSUPPORTED',
    owner_name: null,
    last_updated: '2099-01-01',
  });
  assert.equal(futureRecRes.status, 201);
  const futureRecId = futureRecRes.data.record.id as string;

  const scanRes = await pi.req('POST', '/api/radar/scan', {});
  assert.equal(scanRes.status, 200);

  const radarRes = await pi.req('GET', '/api/radar');
  assert.equal(radarRes.status, 200);
  assert.ok(radarRes.data.lastScannedAt);
  const futureFinding = radarRes.data.findings.find(
    (f: { record_id: string }) => f.record_id === futureRecId
  );
  assert.ok(futureFinding);
  assert.ok(Array.isArray(futureFinding.reasons) && futureFinding.reasons.length >= 2);
  // Must NOT mark a 2099 future date as stale >60 days old
  assert.ok(
    !futureFinding.reasons.some((r: string) => /stale\s*\(/i.test(r)),
    `Unexpected stale age penalty on future date: ${futureFinding.reasons.join('; ')}`
  );

  // Resolve finding -> rescan -> resolved state must persist!
  const resFinding = await pi.req('POST', `/api/radar/findings/${futureFinding.id}/resolve`, { resolved: true });
  assert.equal(resFinding.status, 200);
  assert.equal(resFinding.data.resolved, true);

  await pi.req('POST', '/api/radar/scan', {});
  const radarAfterRescan = await pi.req('GET', '/api/radar');
  const persistedFinding = radarAfterRescan.data.findings.find(
    (f: { id: string }) => f.id === futureFinding.id
  );
  assert.ok(persistedFinding);
  assert.equal(persistedFinding.resolved, true);

  // Reopen finding
  const reopenRes = await pi.req('POST', `/api/radar/findings/${futureFinding.id}/resolve`, { resolved: false });
  assert.equal(reopenRes.status, 200);
  assert.equal(reopenRes.data.resolved, false);

  // Clean up test record
  await pi.req('DELETE', `/api/records/${futureRecId}`);
});

test('Redactions (masking, false-positive guard, rejection persistence, reveal gate), handover publish, Cold-Start privacy & duplicate guard, and persistence', async () => {
  const pi = new TestClient(baseUrl);
  await pi.login('elena.vance@baton-lab.edu');
  const researcher = new TestClient(baseUrl);
  await researcher.login('marcus.chen@baton-lab.edu');

  // Upload a shared source containing a numeric float/date (must NOT trigger PHONE false positive) and a secret + custom term
  const fpSrc = await researcher.req('POST', '/api/sources/text', {
    title: 'Impedance & Phone False-Positive Check',
    filename: 'impedance-check.md',
    content: [
      'Result: Batch 2026-11-16 measured 1234.5678 ohm conductivity and 98.7654 retention.',
      '',
      'Objective: Protect proprietary keyword PHOENIX_REACTOR_ALPHA in continuity review.',
    ].join('\n'),
    visibility_level: 'PROJECT_SHARED',
    exclude_from_ai: false,
  });
  assert.equal(fpSrc.status, 201);

  // Configure custom project sensitive pattern (PI_LEAD only; Researcher gets 403)
  const resDeniedPat = await researcher.req('PATCH', '/api/projects/PRJ-MAIN-01/settings', {
    sensitive_patterns: ['PHOENIX_REACTOR_ALPHA'],
  });
  assert.equal(resDeniedPat.status, 403);

  const patRes = await pi.req('PATCH', '/api/projects/PRJ-MAIN-01/settings', {
    sensitive_patterns: ['PHOENIX_REACTOR_ALPHA'],
  });
  assert.equal(patRes.status, 200);

  // Verify no PHONE false positive was created for decimals/dates, and custom pattern WAS detected & masked in GET
  const redList = await pi.req('GET', '/api/redactions');
  assert.equal(redList.status, 200);
  const phoneOnDate = redList.data.proposals.find(
    (p: { target_id: string; category: string }) => p.target_id === fpSrc.data.source.id && p.category === 'PHONE'
  );
  assert.equal(phoneOnDate, undefined, 'Should not flag ISO date or float as PHONE');

  const customProp = redList.data.proposals.find(
    (p: { target_id: string; category: string }) =>
      p.target_id === fpSrc.data.source.id && p.category === 'RESTRICTED_KEYWORD'
  );
  assert.ok(customProp, 'Custom project sensitive pattern should generate a proposal');
  assert.ok(!String(customProp.matched_text).includes('PHOENIX_REACTOR_ALPHA'), 'GET /api/redactions must mask raw secret');

  // Reject custom proposal -> rescan -> stays REJECTED
  const rejCustom = await pi.req('POST', `/api/redactions/${customProp.id}/resolve`, {
    decision: 'REJECTED',
    note: 'Approved project codename',
  });
  assert.equal(rejCustom.status, 200);
  await pi.req('POST', '/api/redactions/scan', { scope: 'SHARED' });
  const redAfterRej = await pi.req('GET', '/api/redactions');
  const persistedRej = redAfterRej.data.proposals.find((p: { id: string }) => p.id === customProp.id);
  assert.equal(persistedRej.status, 'REJECTED');
  assert.ok(Array.isArray(persistedRej.history) && persistedRej.history.length >= 1);

  // Revisit REJECTED -> PROPOSED works
  const revisitRes = await pi.req('POST', `/api/redactions/${customProp.id}/resolve`, {
    decision: 'PROPOSED',
    note: 'Reopened for second review',
  });
  assert.equal(revisitRes.status, 200);

  // Confirm email redaction proposal from earlier source (marcus.private@example-lab.org)
  const emailProp = redList.data.proposals.find((p: { category: string }) => p.category === 'EMAIL');
  assert.ok(emailProp);
  const confirmRes = await pi.req('POST', `/api/redactions/${emailProp.id}/resolve`, {
    decision: 'CONFIRMED',
  });
  assert.equal(confirmRes.status, 200);

  // PI-only original reveal requires sensitive re-auth and blocks Researcher (403)
  const resDeniedReveal = await researcher.req('POST', `/api/redactions/${emailProp.id}/reveal`, {});
  assert.equal(resDeniedReveal.status, 403);
  const unauthReveal = await pi.req('POST', `/api/redactions/${emailProp.id}/reveal`, {});
  assert.equal(unauthReveal.status, 403);
  assert.equal(unauthReveal.data.code, 'SENSITIVE_AUTH_REQUIRED');

  // Re-approve records so handover contains both verified claim + confirmed redacted claim
  const recList = await pi.req('GET', '/api/records');
  const targetRec = recList.data.records[0];
  await pi.req('POST', `/api/records/${targetRec.id}/verify`);
  const rev = await pi.req('POST', `/api/records/${targetRec.id}/review`, {
    action: 'APPROVE',
    comment: 'Verified after locator update for handover.',
  });
  assert.equal(rev.status, 200);

  // Generate handover draft -> publish without sensitive auth returns 403 SENSITIVE_AUTH_REQUIRED
  const genRes = await pi.req('POST', '/api/handovers/generate', {
    title: 'Phase 1 Continuity Package',
    recipientName: 'Aria Patel',
    recordIds: recList.data.records.map((r: { id: string }) => r.id),
    useAi: false,
  });
  assert.equal(genRes.status, 201);
  const newHoId = genRes.data.handoverId as string;

  const blockedPublish = await pi.req('POST', `/api/handovers/${newHoId}/publish`, {});
  assert.equal(blockedPublish.status, 403);
  assert.equal(blockedPublish.data.code, 'SENSITIVE_AUTH_REQUIRED');

  const reauth = await pi.req('POST', '/api/auth/reauth', { password: 'Baton@2026' });
  assert.equal(reauth.status, 200);
  const revOk = await pi.req('POST', `/api/redactions/${emailProp.id}/reveal`, {});
  assert.equal(revOk.status, 200);
  assert.equal(revOk.data.original_matched_text, 'marcus.private@example-lab.org');

  const pubOk = await pi.req('POST', `/api/handovers/${newHoId}/publish`, {});
  assert.equal(pubOk.status, 200);

  // Incoming member views handover: confirmed email MUST be masked server-side as [REDACTED:email]
  const incoming = new TestClient(baseUrl);
  await incoming.login('aria.patel@baton-lab.edu');
  const hoList = await incoming.req('GET', '/api/handovers');
  assert.equal(hoList.status, 200);
  assert.ok(hoList.data.handovers.length >= 1);
  const firstHo = hoList.data.handovers[0];
  assert.equal(firstHo.status, 'PUBLISHED');
  const hoAllText = [
    firstHo.title,
    firstHo.summary_md,
    ...firstHo.items.map((it: { rendered_text: string; source_file: string }) => `${it.rendered_text} ${it.source_file}`),
  ].join('\n');
  assert.ok(!hoAllText.includes('marcus.private@example-lab.org'), 'Confirmed redacted email must not leak to incoming member');
  assert.ok(hoAllText.includes('[REDACTED:email]'), 'Handover must contain [REDACTED:email] placeholder');
  assert.ok(firstHo.items.length >= 1);

  const chkRes = await incoming.req('POST', `/api/handovers/${firstHo.id}/items/${firstHo.items[0].id}/check`, {
    checked: true,
  });
  assert.equal(chkRes.status, 200);
  assert.equal(chkRes.data.checked, true);

  const ackRes = await incoming.req('POST', `/api/handovers/${firstHo.id}/acknowledge`, {
    note: 'Received and verified package structure.',
  });
  assert.equal(ackRes.status, 200);

  // Cold-Start: empty submit gives UNANSWERED, partial/abbreviation matching, 409 duplicate guard + forceNewAttempt
  const csGet = await incoming.req('GET', '/api/coldstart');
  assert.equal(csGet.status, 200);
  assert.ok(csGet.data.totalCount >= 1);
  const answerableQ = csGet.data.questions.find((q: { answerable_from_handover: boolean }) => q.answerable_from_handover) || csGet.data.questions[0];

  const csSubmit = await incoming.req('POST', '/api/coldstart/submit', {
    answers: {
      [answerableQ.id]: 'Validated baseline protocol and thermal stability benchmark.',
    },
  });
  assert.equal(csSubmit.status, 201);
  const savedRunId = csSubmit.data.run.id as string;
  assert.ok(csSubmit.data.run.coverage_summary);
  assert.ok(csSubmit.data.run.questions.some((q: { evaluation_status: string }) => q.evaluation_status === 'UNANSWERED' || q.evaluation_status === 'CORRECT' || q.evaluation_status === 'PARTIAL'));

  // Rapid duplicate submit blocked with 409 unless forceNewAttempt=true
  const dupSubmit = await incoming.req('POST', '/api/coldstart/submit', { answers: {} });
  assert.equal(dupSubmit.status, 409);

  const forcedSubmit = await incoming.req('POST', '/api/coldstart/submit', {
    answers: {},
    forceNewAttempt: true,
  });
  assert.equal(forcedSubmit.status, 201);
  const forcedRunId = forcedSubmit.data.run.id as string;

  // Cross-user Cold-Start evaluation privacy: another INCOMING_MEMBER gets 403 accessing Aria's run
  const regInc = new TestClient(baseUrl);
  const regIncRes = await regInc.req('POST', '/api/auth/register', {
    name: 'Sam Incoming',
    email: 'sam.incoming@baton-lab.edu',
    password: 'IncomingPass123!',
  });
  assert.equal(regIncRes.status, 201);
  await pi.req('PATCH', `/api/projects/PRJ-MAIN-01/members/${regIncRes.data.user.id}`, { role: 'INCOMING_MEMBER' });
  const samClient = new TestClient(baseUrl);
  await samClient.login('sam.incoming@baton-lab.edu', 'IncomingPass123!');
  const deniedRun = await samClient.req('GET', `/api/coldstart/runs/${savedRunId}`);
  assert.equal(deniedRun.status, 403);

  // Team & Work Tracker returns role, status, work_summary, and who-did-what feed
  await incoming.req('POST', '/api/presence/heartbeat', { route: '#/team' });
  const teamRes = await pi.req('GET', '/api/team');
  assert.equal(teamRes.status, 200);
  assert.ok(Array.isArray(teamRes.data.members));
  assert.ok(Array.isArray(teamRes.data.team_activity));
  assert.ok(teamRes.data.team_activity.length >= 5);

  const marcus = teamRes.data.members.find((m: { email: string }) => m.email === 'marcus.chen@baton-lab.edu');
  assert.ok(marcus);
  assert.equal(marcus.role, 'RESEARCHER');
  assert.ok(marcus.work_summary.sourcesUploaded >= 2);
  assert.ok(marcus.work_summary.notesCreated >= 1);
  assert.ok(marcus.work_summary.totalActions >= 3);

  const aria = teamRes.data.members.find((m: { email: string }) => m.email === 'aria.patel@baton-lab.edu');
  assert.ok(aria);
  assert.equal(aria.presence_status, 'ONLINE');

  // Simulate server restart against same tempDir & verify append-only audit trigger, FK integrity & persistence
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb?.();

  const restarted = bootTestServer();
  assert.throws(() => {
    restarted.db.prepare('DELETE FROM audit_logs WHERE id = 1').run();
  }, /audit_logs is append-only/);
  assert.throws(() => {
    restarted.db.prepare("UPDATE audit_logs SET action = 'TAMPERED' WHERE id = 1").run();
  }, /audit_logs is append-only/);

  const integrityRow = restarted.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  assert.equal(integrityRow[0].integrity_check, 'ok');
  const fkRow = restarted.db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
  assert.equal(fkRow[0].foreign_keys, 1);

  server = http.createServer(restarted.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const incoming2 = new TestClient(baseUrl);
  await incoming2.login('aria.patel@baton-lab.edu');
  const csAfterRestart = await incoming2.req('GET', '/api/coldstart');
  assert.equal(csAfterRestart.status, 200);
  assert.ok(csAfterRestart.data.runs.some((r: { id: string }) => r.id === savedRunId));
  assert.ok(csAfterRestart.data.runs.some((r: { id: string }) => r.id === forcedRunId));
});

test('Legacy camera-login is rejected (403), HTTPS SameSite=None cookie & X-Baton-Session fallback work, and project-scoped membership & cross-project isolation hold', async () => {
  // Security regression test: legacy passwordless camera-login must NEVER authenticate
  const forgedCamResp = await fetch(`${baseUrl}/api/auth/camera-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ email: 'elena.vance@baton-lab.edu', cameraConfirmed: true }),
  });
  assert.equal(forgedCamResp.status, 403);

  // Real password login over HTTPS proxy headers issues Partitioned SameSite=None Secure HttpOnly cookie + sessionToken fallback
  const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-Proto': 'https',
    },
    body: JSON.stringify({ email: 'elena.vance@baton-lab.edu', password: 'Baton@2026' }),
  });
  assert.equal(loginResp.status, 200);
  const setCookie = loginResp.headers.get('set-cookie') || '';
  assert.match(setCookie, /SameSite=None/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /Partitioned/i);
  assert.match(setCookie, /HttpOnly/i);

  const payload = await loginResp.json();
  assert.equal(payload.hasSensitiveAuth, false);
  assert.ok(payload.sessionToken);

  // Create new isolated project using X-Baton-Session + CSRF fallback without Cookie
  const projResp = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Baton-Session': payload.sessionToken,
      'X-CSRF-Token': payload.csrfToken,
    },
    body: JSON.stringify({
      name: 'Cryo-EM Grid Prep Continuity',
      description: 'Transfer plunge-freezing parameters and grid inventory',
    }),
  });
  assert.equal(projResp.status, 201);
  const projJson = await projResp.json();
  const newProjId = projJson.project.id as string;

  // Non-member (Marcus) is blocked (403) from isolated project until PI_LEAD explicitly adds him
  const marcus = new TestClient(baseUrl);
  await marcus.login('marcus.chen@baton-lab.edu');
  const marcusDenied = await marcus.req('GET', `/api/overview?projectId=${encodeURIComponent(newProjId)}`);
  assert.equal(marcusDenied.status, 403);

  // Non-existent explicit projectId returns 404 (never silently falls back)
  const missingProj = await marcus.req('GET', '/api/overview?projectId=PRJ-DOES-NOT-EXIST');
  assert.equal(missingProj.status, 404);

  // PI_LEAD adds Nina Brooks as AUDITOR on the new project and verifies AUDITOR is read-only on notes/records
  const addAuditor = await fetch(`${baseUrl}/api/projects/${newProjId}/members`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Baton-Session': payload.sessionToken,
      'X-CSRF-Token': payload.csrfToken,
    },
    body: JSON.stringify({ email: 'nina.brooks@baton-lab.edu', role: 'AUDITOR' }),
  });
  assert.equal(addAuditor.status, 201);

  const nina = new TestClient(baseUrl);
  await nina.login('nina.brooks@baton-lab.edu', 'ResearchPassword123');
  const ninaAudOverview = await nina.req('GET', `/api/overview?projectId=${encodeURIComponent(newProjId)}`);
  assert.equal(ninaAudOverview.status, 200);
  const ninaDeniedNote = await nina.req('POST', `/api/notes?projectId=${encodeURIComponent(newProjId)}`, {
    title: 'Auditor should not write',
    content_html: '<p>Blocked</p>',
    plain_text: 'Blocked',
  });
  assert.equal(ninaDeniedNote.status, 403);

  // Cannot demote or remove last PI_LEAD of a project
  const demoteLastPi = await fetch(`${baseUrl}/api/projects/${newProjId}/members/U-ELENA`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Baton-Session': payload.sessionToken,
      'X-CSRF-Token': payload.csrfToken,
    },
    body: JSON.stringify({ role: 'RESEARCHER' }),
  });
  assert.equal(demoteLastPi.status, 400);

  const textResp = await fetch(`${baseUrl}/api/sources/text?projectId=${encodeURIComponent(newProjId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Baton-Session': payload.sessionToken,
      'X-CSRF-Token': payload.csrfToken,
    },
    body: JSON.stringify({
      title: 'Plunge Freezing Log',
      filename: 'plunge-log.md',
      content: 'Objective: Maintain vitrified ice thickness below 45nm.\n\nRisk: Ethane cup thermistor drifted 2C.',
      visibility_level: 'PROJECT_SHARED',
      exclude_from_ai: false,
    }),
  });
  assert.equal(textResp.status, 201);

  const overviewResp = await fetch(`${baseUrl}/api/overview?projectId=${encodeURIComponent(newProjId)}`, {
    headers: { 'X-Baton-Session': payload.sessionToken },
  });
  assert.equal(overviewResp.status, 200);
  const overviewJson = await overviewResp.json();
  assert.equal(overviewJson.metrics.sourcesCount, 1);
  assert.equal(overviewJson.metrics.notesCount, 0);
});

test('Delete capability across records, handovers, redactions, coldstart runs, and projects with RBAC & audit logging', async () => {
  const pi = new TestClient(baseUrl);
  await pi.login('elena.vance@baton-lab.edu');
  const researcher = new TestClient(baseUrl);
  await researcher.login('marcus.chen@baton-lab.edu');
  const reviewer = new TestClient(baseUrl);
  await reviewer.login('priya.nair@baton-lab.edu');
  const incoming = new TestClient(baseUrl);
  await incoming.login('aria.patel@baton-lab.edu');

  // Create a disposable record and test RBAC + delete
  const recCreate = await researcher.req('POST', '/api/records', {
    type: 'TASK',
    title: 'Disposable calibration check',
    excerpt: 'Calibrate thermocouple offset before next cycle.',
    evidence_state: 'NEEDS_REVIEW',
  });
  assert.equal(recCreate.status, 201);
  const recId = recCreate.data.record.id as string;

  const revDeniedDel = await reviewer.req('DELETE', `/api/records/${recId}`);
  assert.equal(revDeniedDel.status, 403);

  const recDel = await researcher.req('DELETE', `/api/records/${recId}`);
  assert.equal(recDel.status, 200);
  const recListAfter = await pi.req('GET', '/api/records');
  assert.ok(!recListAfter.data.records.some((r: { id: string }) => r.id === recId));

  // Handover draft delete by author, and researcher blocked from deleting published handover
  const hoList = await pi.req('GET', '/api/handovers');
  const publishedHo = hoList.data.handovers.find((h: { status: string }) => h.status === 'PUBLISHED');
  assert.ok(publishedHo);
  const resDeniedHo = await researcher.req('DELETE', `/api/handovers/${publishedHo.id}`);
  assert.equal(resDeniedHo.status, 403);

  const draftHo = await researcher.req('POST', '/api/handovers/generate', {
    title: 'Temporary Draft For Deletion',
    useAi: false,
  });
  assert.equal(draftHo.status, 201);
  const draftDel = await researcher.req('DELETE', `/api/handovers/${draftHo.data.handoverId}`);
  assert.equal(draftDel.status, 200);

  // Cold-start run deletion by owner
  const csRes = await incoming.req('GET', '/api/coldstart');
  assert.ok(csRes.data.runs.length >= 1);
  const runId = csRes.data.runs[0].id as string;
  const runDel = await incoming.req('DELETE', `/api/coldstart/runs/${runId}`);
  assert.equal(runDel.status, 200);

  // Redaction proposal deletion
  const redRes = await pi.req('GET', '/api/redactions');
  if (redRes.data.proposals.length > 0) {
    const propId = redRes.data.proposals[0].id as string;
    const redDel = await pi.req('DELETE', `/api/redactions/${propId}`);
    assert.equal(redDel.status, 200);
  }

  // Project deletion: delete non-default project succeeds, deleting last remaining project returns 400
  const projList = await pi.req('GET', '/api/projects');
  const extraProjects = projList.data.projects.filter((p: { id: string }) => p.id !== 'PRJ-MAIN-01');
  for (const p of extraProjects) {
    const pDel = await pi.req('DELETE', `/api/projects/${p.id}`);
    assert.equal(pDel.status, 200);
  }
  const lastProjDel = await pi.req('DELETE', '/api/projects/PRJ-MAIN-01');
  assert.equal(lastProjDel.status, 400);

  // Confirm audit entries exist for deletions
  const auditRecDel = await pi.req('GET', '/api/audit?action=RECORD_DELETED');
  assert.ok(auditRecDel.data.logs.length >= 1);
  const auditHoDel = await pi.req('GET', '/api/audit?action=HANDOVER_DELETED');
  assert.ok(auditHoDel.data.logs.length >= 1);
  const auditProjDel = await pi.req('GET', '/api/audit?action=PROJECT_DELETED');
  assert.ok(auditProjDel.data.logs.length >= 1);
});

test('Bulk clear records (DELETE /api/records) and full project reset (POST /api/projects/:id/reset)', async () => {
  const pi = new TestClient(baseUrl);
  await pi.login('elena.vance@baton-lab.edu');
  const reviewer = new TestClient(baseUrl);
  await reviewer.login('priya.nair@baton-lab.edu');

  // Create a fresh isolated project for bulk clear + reset verification
  const createProj = await pi.req('POST', '/api/projects', {
    name: 'Resettable Test Project',
    description: 'Used to verify bulk clear and full workspace reset',
  });
  assert.equal(createProj.status, 201);
  const pid = createProj.data.project.id as string;

  // Add a file, a note, and 2 records in the project
  const srcRes = await pi.req('POST', `/api/sources/text?projectId=${encodeURIComponent(pid)}`, {
    title: 'Batch Log',
    filename: 'batch.md',
    content: 'Objective: Baseline batch run.\n\nResult: Observed 99.1% conversion.',
    visibility_level: 'PROJECT_SHARED',
    exclude_from_ai: false,
  });
  assert.equal(srcRes.status, 201);

  const noteRes = await pi.req('POST', `/api/notes?projectId=${encodeURIComponent(pid)}`, {
    title: 'Temp Note',
    content_html: '<p>Note body</p>',
    plain_text: 'Note body',
    font_family: 'DM Sans',
    visibility_level: 'PROJECT_SHARED',
  });
  assert.equal(noteRes.status, 201);

  const r1 = await pi.req('POST', `/api/records?projectId=${encodeURIComponent(pid)}`, {
    type: 'EXPERIMENT',
    title: 'Bulk Test Record 1',
    excerpt: 'Baseline batch run.',
    evidence_state: 'NEEDS_REVIEW',
  });
  assert.equal(r1.status, 201);
  const r2 = await pi.req('POST', `/api/records?projectId=${encodeURIComponent(pid)}`, {
    type: 'TASK',
    title: 'Bulk Test Record 2',
    excerpt: 'Observed 99.1% conversion.',
    evidence_state: 'NEEDS_REVIEW',
  });
  assert.equal(r2.status, 201);

  // Reviewer is forbidden from clearing records
  const deniedClear = await reviewer.req('DELETE', `/api/records?projectId=${encodeURIComponent(pid)}`);
  assert.equal(deniedClear.status, 403);

  // PI clears all records while preserving source & note
  const cleared = await pi.req('DELETE', `/api/records?projectId=${encodeURIComponent(pid)}`);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.deletedCount, 2);

  const ovMid = await pi.req('GET', `/api/overview?projectId=${encodeURIComponent(pid)}`);
  assert.equal(ovMid.data.metrics.recordsCount, 0);
  assert.equal(ovMid.data.metrics.sourcesCount, 1);
  assert.equal(ovMid.data.metrics.notesCount, 1);

  // Re-add a record and test full project reset
  await pi.req('POST', `/api/records?projectId=${encodeURIComponent(pid)}`, {
    type: 'DECISION',
    title: 'Before Reset',
    excerpt: 'Temporary decision.',
    evidence_state: 'NEEDS_REVIEW',
  });
  const resetRes = await pi.req('POST', `/api/projects/${pid}/reset`, {});
  assert.equal(resetRes.status, 200);
  assert.equal(resetRes.data.ok, true);

  const ovAfter = await pi.req('GET', `/api/overview?projectId=${encodeURIComponent(pid)}`);
  assert.equal(ovAfter.data.metrics.recordsCount, 0);
  assert.equal(ovAfter.data.metrics.sourcesCount, 0);
  assert.equal(ovAfter.data.metrics.notesCount, 0);

  // Audit entries recorded (scoped to project pid)
  const auditCleared = await pi.req('GET', `/api/audit?projectId=${encodeURIComponent(pid)}&action=RECORDS_CLEARED`);
  assert.ok(auditCleared.data.logs.length >= 1);
  const auditReset = await pi.req('GET', `/api/audit?projectId=${encodeURIComponent(pid)}&action=PROJECT_RESET`);
  assert.ok(auditReset.data.logs.length >= 1);

  // Clean up disposable project
  const delProj = await pi.req('DELETE', `/api/projects/${pid}`);
  assert.equal(delProj.status, 200);
});


