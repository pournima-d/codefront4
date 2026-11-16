import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  History,
  Maximize2,
  Minimize2,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import {
  EVIDENCE_STATES,
  type EvidenceState,
  type RecordVersionEntry,
  type ResearchRecord,
  type Role,
  type SourceItem,
  type SourceSpan,
  type WorkflowStageId,
} from '../../types';
import { ApprovalBadge, EvidenceBadge } from '../StatusChip';

interface RecordsTabProps {
  role: Role;
  initialRecordId?: string | null;
  onSelectRecordId?: (id: string | null) => void;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function RecordsTab({
  role,
  initialRecordId,
  onSelectRecordId,
  onToast,
}: RecordsTabProps) {
  const [records, setRecords] = useState<ResearchRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialRecordId || null);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [evidenceFilter, setEvidenceFilter] = useState<string>('ALL');
  const [approvalFilter, setApprovalFilter] = useState<string>('ALL');

  // Editor form state
  const [title, setTitle] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [rationale, setRationale] = useState('');
  const [editReason, setEditReason] = useState('');
  const [locator, setLocator] = useState('');
  const [evidenceState, setEvidenceState] = useState<EvidenceState>('NEEDS_REVIEW');
  const [stage, setStage] = useState<WorkflowStageId>('02');
  const [dirty, setDirty] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Flag broken citation inline flow
  const [flaggingOpen, setFlaggingOpen] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [flaggingBusy, setFlaggingBusy] = useState(false);

  // Delete record inline confirmation state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isMaximized) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMaximized(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isMaximized]);

  // Immutable record version history
  const [versions, setVersions] = useState<RecordVersionEntry[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  // New claim creation state
  const [creating, setCreating] = useState(false);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [sourceSpans, setSourceSpans] = useState<SourceSpan[]>([]);
  const [newType, setNewType] = useState('RESULT');
  const [newTitle, setNewTitle] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [newSourceId, setNewSourceId] = useState('');
  const [newSpanId, setNewSpanId] = useState('');
  const [newExcerpt, setNewExcerpt] = useState('');
  const [newRationale, setNewRationale] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);

  const canEdit = role === 'PI_LEAD' || role === 'RESEARCHER';
  const canVerify = role === 'PI_LEAD' || role === 'RESEARCHER' || role === 'REVIEWER';

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{ records: ResearchRecord[] }>('/api/records');
      setRecords(res.records);
      if (initialRecordId && res.records.some((r) => r.id === initialRecordId)) {
        setSelectedId(initialRecordId);
      } else if (res.records.length > 0 && (!selectedId || !res.records.some((r) => r.id === selectedId))) {
        setSelectedId(res.records[0].id);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load records';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [initialRecordId, onToast, selectedId]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    if (initialRecordId) {
      setSelectedId(initialRecordId);
    }
  }, [initialRecordId]);

  const selected = records.find((r) => r.id === selectedId) || null;

  const loadVersions = useCallback(async (recordId: string) => {
    setVersionsLoading(true);
    try {
      const res = await apiFetch<{ versions: RecordVersionEntry[] }>(`/api/records/${recordId}/versions`);
      setVersions(res.versions);
    } catch {
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  // Populate editor, fetch version history & restore any unsaved draft on record change
  useEffect(() => {
    if (!selected) {
      setVersions([]);
      return;
    }
    onSelectRecordId?.(selected.id);
    setDirty(false);
    setAutosaveStatus(null);
    setEditReason('');
    setFlaggingOpen(false);
    setFlagReason('');
    void loadVersions(selected.id);

    const draftKey = `record:${selected.id}`;
    const applyValues = (vals: {
      title?: string;
      ownerName?: string;
      excerpt?: string;
      rationale?: string;
      locator?: string;
      evidenceState?: EvidenceState;
      stage?: WorkflowStageId;
    }) => {
      setTitle(vals.title ?? selected.title);
      setOwnerName(vals.ownerName ?? (selected.owner_name || ''));
      setExcerpt(vals.excerpt ?? selected.excerpt);
      setRationale(vals.rationale ?? (selected.rationale || ''));
      setLocator(vals.locator ?? selected.locator);
      setEvidenceState(vals.evidenceState ?? selected.evidence_state);
      setStage(vals.stage ?? selected.stage);
    };

    applyValues({});

    let active = true;
    apiFetch<{ content: Record<string, string> | null; updatedAt: string | null }>(`/api/drafts/${encodeURIComponent(draftKey)}`)
      .then((res) => {
        if (!active) return;
        if (res.content && Object.keys(res.content).length > 0) {
          applyValues(res.content);
          setDirty(true);
          setAutosaveStatus(`Restored unsaved draft (${res.updatedAt?.slice(11, 19) || 'saved'})`);
          return;
        }
        const localRaw = localStorage.getItem(`baton_draft_${draftKey}`);
        if (localRaw) {
          const parsed = JSON.parse(localRaw);
          applyValues(parsed);
          setDirty(true);
          setAutosaveStatus('Restored local draft backup');
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave every 3s when dirty
  useEffect(() => {
    if (!selected || !dirty || !canEdit) return;
    const draftKey = `record:${selected.id}`;
    const payload = { title, ownerName, excerpt, rationale, locator, evidenceState, stage };
    try {
      localStorage.setItem(`baton_draft_${draftKey}`, JSON.stringify(payload));
    } catch {
      // ignore storage quota
    }

    const timer = setTimeout(() => {
      apiFetch(`/api/drafts/${encodeURIComponent(draftKey)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: payload }),
      })
        .then(() => {
          setAutosaveStatus(`Autosaved at ${new Date().toLocaleTimeString()}`);
        })
        .catch(() => {});
    }, 3000);

    return () => clearTimeout(timer);
  }, [selected, dirty, canEdit, title, ownerName, excerpt, rationale, locator, evidenceState, stage]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || saving || !canEdit) return;
    setSaving(true);
    try {
      await apiFetch(`/api/records/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title,
          owner_name: ownerName.trim() || null,
          excerpt,
          rationale,
          edit_reason: editReason.trim() || undefined,
          locator,
          evidence_state: evidenceState,
          stage,
        }),
      });
      const draftKey = `record:${selected.id}`;
      localStorage.removeItem(`baton_draft_${draftKey}`);
      await apiFetch(`/api/drafts/${encodeURIComponent(draftKey)}`, { method: 'DELETE' }).catch(() => {});
      setDirty(false);
      setAutosaveStatus(null);
      setEditReason('');
      await loadRecords();
      await loadVersions(selected.id);
      onToast(
        selected.approval_state === 'APPROVED'
          ? `${selected.id} saved — version incremented & approval reset to NEEDS_REVIEW.`
          : `${selected.id} updated (new immutable version recorded).`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyVerbatim = async () => {
    if (!selected || verifying || !canVerify) return;
    setVerifying(true);
    try {
      const res = await apiFetch<{ verbatimMatch: boolean; evidence_state: EvidenceState }>(
        `/api/records/${selected.id}/verify`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      await loadRecords();
      setEvidenceState(res.evidence_state);
      onToast(
        res.verbatimMatch
          ? `Verbatim match confirmed in cited span -> ${res.evidence_state}.`
          : `Excerpt not found verbatim in span -> marked ${res.evidence_state}.`,
        res.verbatimMatch ? 'success' : 'info'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Verification failed', 'error');
    } finally {
      setVerifying(false);
    }
  };

  const handleFlagCitation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || flaggingBusy || !canVerify) return;
    setFlaggingBusy(true);
    try {
      await apiFetch(`/api/records/${selected.id}/flag-citation`, {
        method: 'POST',
        body: JSON.stringify({ reason: flagReason.trim() || 'Broken or mismatched source citation flagged.' }),
      });
      setFlaggingOpen(false);
      setFlagReason('');
      setEvidenceState('UNSUPPORTED');
      await loadRecords();
      onToast(`Citation flagged on ${selected.id} -> evidence state set to UNSUPPORTED.`, 'info');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to flag citation', 'error');
    } finally {
      setFlaggingBusy(false);
    }
  };

  const handleDeleteRecord = async (rec: ResearchRecord) => {
    if (deletingId || !canEdit) return;
    setDeletingId(rec.id);
    try {
      await apiFetch(`/api/records/${rec.id}`, { method: 'DELETE' });
      const draftKey = `record:${rec.id}`;
      localStorage.removeItem(`baton_draft_${draftKey}`);
      setConfirmDeleteId(null);
      const remaining = records.filter((r) => r.id !== rec.id);
      setRecords(remaining);
      if (selectedId === rec.id) {
        const nextId = remaining[0]?.id ?? null;
        setSelectedId(nextId);
        onSelectRecordId?.(nextId);
      }
      onToast(`Deleted record ${rec.id} ("${rec.title}").`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete record', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const handleClearAllRecords = async () => {
    if (clearingAll || !canEdit) return;
    setClearingAll(true);
    try {
      const res = await apiFetch<{ deletedCount: number }>('/api/records', { method: 'DELETE' });
      for (const r of records) {
        localStorage.removeItem(`baton_draft_record:${r.id}`);
      }
      setConfirmClearAll(false);
      setRecords([]);
      setSelectedId(null);
      onSelectRecordId?.(null);
      onToast(`Cleared ${res.deletedCount} records from this project.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to clear records', 'error');
    } finally {
      setClearingAll(false);
    }
  };

  useEffect(() => {
    if (!creating || !canEdit) return;
    apiFetch<{ sources: SourceItem[] }>('/api/sources')
      .then((res) => {
        setSources(res.sources);
        if (res.sources.length > 0 && !newSourceId) {
          setNewSourceId(res.sources[0].id);
        }
      })
      .catch(() => {});
  }, [creating, canEdit, newSourceId]);

  useEffect(() => {
    if (!creating || !newSourceId) {
      setSourceSpans([]);
      return;
    }
    apiFetch<{ spans: SourceSpan[] }>(`/api/sources/${newSourceId}/spans`)
      .then((res) => {
        setSourceSpans(res.spans);
        if (res.spans.length > 0) {
          setNewSpanId(res.spans[0].id);
        } else {
          setNewSpanId('');
        }
      })
      .catch(() => setSourceSpans([]));
  }, [creating, newSourceId]);

  const handleCreateRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingBusy || !canEdit) return;
    setCreatingBusy(true);
    try {
      const res = await apiFetch<{ record: ResearchRecord }>('/api/records', {
        method: 'POST',
        body: JSON.stringify({
          type: newType,
          title: newTitle,
          owner_name: newOwner.trim() || null,
          source_id: newSourceId || null,
          span_id: newSpanId || null,
          excerpt: newExcerpt,
          rationale: newRationale,
          evidence_state: 'NEEDS_REVIEW',
        }),
      });
      setCreating(false);
      setNewTitle('');
      setNewOwner('');
      setNewExcerpt('');
      setNewRationale('');
      await loadRecords();
      if (res.record?.id) {
        setSelectedId(res.record.id);
      }
      onToast(`Created claim ${res.record?.id || ''} (linked to span).`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to create record', 'error');
    } finally {
      setCreatingBusy(false);
    }
  };

  const uniqueTypes = Array.from(new Set(records.map((r) => r.type))).sort();

  const filtered = records.filter((r) => {
    if (typeFilter !== 'ALL' && r.type !== typeFilter) return false;
    if (evidenceFilter !== 'ALL' && r.evidence_state !== evidenceFilter) return false;
    if (approvalFilter !== 'ALL' && r.approval_state !== approvalFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        r.id.toLowerCase().includes(q) ||
        r.title.toLowerCase().includes(q) ||
        r.excerpt.toLowerCase().includes(q) ||
        (r.owner_name || 'UNKNOWN').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const activeNewSpan = sourceSpans.find((sp) => sp.id === newSpanId) || null;

  return (
    <>
      {isMaximized && (
        <div
          aria-hidden="true"
          onClick={() => setIsMaximized(false)}
          className="fixed inset-0 z-40 bg-[#0F172A]/45 backdrop-blur-[2px]"
        />
      )}
      <div
        className={
          isMaximized
            ? 'fixed inset-2 sm:inset-4 z-50 rounded-2xl border border-[#CBD5E1] bg-[#F8FAFC] p-4 sm:p-5 shadow-2xl flex flex-col gap-3 overflow-y-auto'
            : 'space-y-4'
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className={`font-display font-bold text-[#0F172A] ${isMaximized ? 'text-xl' : 'text-2xl'}`}>
              Records &amp; Evidence Inspector
            </h1>
            {!isMaximized && (
              <p className="text-sm text-[#64748B]">
                Six canonical evidence states only; editing an approved record invalidates prior approval.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && records.length > 0 && (
              confirmClearAll ? (
                <div className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={clearingAll}
                    onClick={() => void handleClearAllRecords()}
                    className="rounded-full bg-[#DC2626] px-4 py-2 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                  >
                    {clearingAll ? 'Clearing…' : `Confirm clear all (${records.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearAll(false)}
                    className="rounded-full border border-[#E2E8F0] bg-white px-3 py-2 text-xs text-[#64748B]"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearAll(true)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#DC2626]/30 bg-white px-4 py-2 text-xs font-semibold text-[#DC2626] hover:bg-[#DC2626]/5"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Clear all records</span>
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => setIsMaximized((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-semibold transition-colors ${
                isMaximized
                  ? 'border-[#0F172A] bg-[#0F172A] text-white'
                  : 'border-[#E2E8F0] bg-white text-[#0F172A] hover:border-[#2563EB]'
              }`}
            >
              {isMaximized ? (
                <>
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Exit full screen (Esc)</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                  <span>Maximise screen</span>
                </>
              )}
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => setCreating((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E293B]"
              >
                {creating ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                <span>{creating ? 'Close form' : 'New claim'}</span>
              </button>
            )}
          </div>
        </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-xl border border-[#DC2626]/30 bg-[#DC2626]/5 px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#991B1B]"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadRecords()}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      {creating && canEdit && (
        <form onSubmit={handleCreateRecord} className="rounded-2xl border border-[#2563EB]/30 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-bold text-[#0F172A]">Add typed claim linked to source span</h2>
            <span className="text-xs text-[#64748B]">Starts as NEEDS_REVIEW · blank owner stays UNKNOWN</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Type</label>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
              >
                {['OBJECTIVE', 'EXPERIMENT', 'RESULT', 'DECISION', 'RISK', 'RECURRING_PROBLEM', 'GAP', 'TASK', 'DEPENDENCY', 'CONTACT'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Claim title</label>
              <input
                type="text"
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g., SSE-05 pellet density benchmark"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Owner (optional)</label>
              <input
                type="text"
                value={newOwner}
                onChange={(e) => setNewOwner(e.target.value)}
                placeholder="UNKNOWN"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Authorized source</label>
              <select
                value={newSourceId}
                onChange={(e) => setNewSourceId(e.target.value)}
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.title} ({s.visibility_level})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Cited span locator</label>
              <select
                value={newSpanId}
                onChange={(e) => setNewSpanId(e.target.value)}
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-mono"
              >
                {sourceSpans.map((sp) => (
                  <option key={sp.id} value={sp.id}>
                    {sp.locator} — {sp.content.slice(0, 60)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-[#0F172A]">Verbatim excerpt</label>
              {activeNewSpan && (
                <button
                  type="button"
                  onClick={() => setNewExcerpt(activeNewSpan.content)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[#2563EB] hover:underline"
                >
                  <ClipboardCopy className="h-3 w-3" aria-hidden="true" />
                  <span>Copy selected span text</span>
                </button>
              )}
            </div>
            <textarea
              rows={2}
              required
              value={newExcerpt}
              onChange={(e) => setNewExcerpt(e.target.value)}
              placeholder="Paste exact claim text from the selected source span…"
              className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#0F172A] mb-1">Continuity rationale (optional)</label>
            <input
              type="text"
              value={newRationale}
              onChange={(e) => setNewRationale(e.target.value)}
              placeholder="Why this claim matters for the incoming researcher…"
              className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="rounded-full border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#0F172A]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creatingBusy}
              className="rounded-full bg-[#2563EB] px-5 py-1.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              {creatingBusy ? 'Saving…' : 'Create claim'}
            </button>
          </div>
        </form>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="h-4 w-4 text-[#64748B] absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by ID, claim, or owner…"
            className="w-full rounded-full border border-[#E2E8F0] bg-white pl-9 pr-4 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
          />
        </div>
        <select
          aria-label="Filter by record type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-medium text-[#0F172A]"
        >
          <option value="ALL">All types</option>
          {uniqueTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by evidence state"
          value={evidenceFilter}
          onChange={(e) => setEvidenceFilter(e.target.value)}
          className="rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-medium text-[#0F172A]"
        >
          <option value="ALL">All evidence states ({records.length})</option>
          {EVIDENCE_STATES.map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by approval state"
          value={approvalFilter}
          onChange={(e) => setApprovalFilter(e.target.value)}
          className="rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-medium text-[#0F172A]"
        >
          <option value="ALL">All approval states</option>
          <option value="APPROVED">APPROVED</option>
          <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
          <option value="NEEDS_REVISION">NEEDS_REVISION</option>
          <option value="REJECTED">REJECTED</option>
        </select>
      </div>

      {/* Split Table + Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
          {loading ? (
            <div className="p-8 text-sm text-[#64748B]">Loading records…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#64748B]">No matching records found.</div>
          ) : (
            <div className="overflow-x-auto max-h-[680px]">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[#F8FAFC] border-b border-[#E2E8F0] text-xs font-semibold text-[#64748B]">
                  <tr>
                    <th className="py-2.5 px-3.5">ID</th>
                    <th className="py-2.5 px-3.5">Claim</th>
                    <th className="py-2.5 px-3.5">Owner</th>
                    <th className="py-2.5 px-3.5">Evidence</th>
                    <th className="py-2.5 px-3.5">Approval</th>
                    {canEdit && <th className="py-2.5 px-3 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0] text-xs">
                  {filtered.map((r) => {
                    const isSel = r.id === selectedId;
                    const isConfirming = confirmDeleteId === r.id;
                    return (
                      <tr
                        key={r.id}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          setSelectedId(r.id);
                        }}
                        className={`cursor-pointer transition-colors ${
                          isSel ? 'bg-[#2563EB]/8' : 'hover:bg-[#F8FAFC]'
                        }`}
                      >
                        <td className="py-2.5 px-3.5 font-mono font-semibold text-[#2563EB] whitespace-nowrap">
                          {r.id}
                          <span className="block text-[10px] font-normal text-[#64748B]">{r.type}</span>
                        </td>
                        <td className="py-2.5 px-3.5 text-sm font-medium text-[#0F172A] max-w-[220px]">
                          <div className="truncate">{r.title}</div>
                          <div className="text-[11px] text-[#64748B] font-mono truncate">
                            {r.source_file} · {r.locator}
                          </div>
                        </td>
                        <td className="py-2.5 px-3.5 whitespace-nowrap text-[#475569]">
                          {r.owner_name || <span className="font-mono text-[#D97706]">UNKNOWN</span>}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <EvidenceBadge state={r.evidence_state} />
                        </td>
                        <td className="py-2.5 px-3.5">
                          <ApprovalBadge state={r.approval_state} />
                        </td>
                        {canEdit && (
                          <td
                            className="py-2.5 px-3 text-right whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {isConfirming ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={deletingId === r.id}
                                  onClick={() => void handleDeleteRecord(r)}
                                  className="rounded-full bg-[#DC2626] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                                >
                                  {deletingId === r.id ? 'Deleting…' : 'Confirm'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="rounded-full border border-[#E2E8F0] bg-white px-2 py-1 text-[11px] text-[#64748B]"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(r.id)}
                                aria-label={`Delete ${r.id}`}
                                title="Delete record"
                                className="rounded-full border border-[#E2E8F0] bg-white p-1.5 text-[#64748B] hover:border-[#DC2626]/40 hover:text-[#DC2626]"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Inspector & Editor */}
        <aside className="lg:col-span-5 rounded-2xl border border-[#E2E8F0] bg-white p-6 space-y-5">
          {selected ? (
            <>
              <form onSubmit={handleSave} className="space-y-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 font-mono text-xs text-[#64748B] tabular-nums">
                      <span className="font-bold text-[#2563EB]">{selected.id}</span>
                      <span>·</span>
                      <span>v{selected.version}</span>
                      <span>·</span>
                      <span>{selected.visibility_level}</span>
                    </div>
                    <h2 className="font-display text-lg font-bold text-[#0F172A] mt-0.5">{selected.title}</h2>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <ApprovalBadge state={selected.approval_state} />
                    {canEdit && (
                      confirmDeleteId === selected.id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={deletingId === selected.id}
                            onClick={() => void handleDeleteRecord(selected)}
                            className="rounded-full bg-[#DC2626] px-3 py-1 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                          >
                            {deletingId === selected.id ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-full border border-[#E2E8F0] px-2.5 py-1 text-xs text-[#64748B]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(selected.id)}
                          aria-label="Delete selected record"
                          title="Delete record"
                          className="rounded-full border border-[#E2E8F0] p-1.5 text-[#64748B] hover:border-[#DC2626]/40 hover:text-[#DC2626]"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Cited Verbatim Span */}
                <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[#0F172A]">
                      Cited span ({selected.source_file} · {selected.locator})
                    </span>
                    <span className={`font-mono text-[11px] ${selected.verbatim_match ? 'text-[#059669]' : 'text-[#D97706]'}`}>
                      {selected.verbatim_match ? 'Verbatim match' : 'Not verbatim'}
                    </span>
                  </div>
                  <p className="text-xs text-[#475569] leading-relaxed">
                    {selected.span_content || 'No linked source span content.'}
                  </p>
                  {canVerify && (
                    <div className="flex flex-wrap items-center gap-4 pt-1">
                      <button
                        type="button"
                        onClick={handleVerifyVerbatim}
                        disabled={verifying}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] hover:underline"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{verifying ? 'Checking…' : 'Verify verbatim against span'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setFlaggingOpen((v) => !v)}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#DC2626] hover:underline"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Flag broken citation</span>
                      </button>
                    </div>
                  )}
                </div>

                {flaggingOpen && canVerify && (
                  <div className="rounded-xl border border-[#DC2626]/30 bg-[#DC2626]/5 p-3 space-y-2">
                    <label className="block text-xs font-semibold text-[#991B1B]">
                      Reason for flagging broken citation
                    </label>
                    <input
                      type="text"
                      value={flagReason}
                      onChange={(e) => setFlagReason(e.target.value)}
                      placeholder="e.g., Locator points to wrong table row / excerpt altered"
                      className="w-full rounded-lg border border-[#DC2626]/30 bg-white px-3 py-1.5 text-xs text-[#0F172A]"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setFlaggingOpen(false)}
                        className="rounded-full border border-[#E2E8F0] bg-white px-3 py-1 text-xs font-medium text-[#475569]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={flaggingBusy}
                        onClick={handleFlagCitation}
                        className="rounded-full bg-[#DC2626] px-3.5 py-1 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                      >
                        {flaggingBusy ? 'Flagging…' : 'Confirm UNSUPPORTED'}
                      </button>
                    </div>
                  </div>
                )}

                {autosaveStatus && (
                  <p className="text-xs text-[#2563EB] font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{autosaveStatus}</span>
                  </p>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-[#0F172A] mb-1">Title</label>
                    <input
                      type="text"
                      disabled={!canEdit}
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setDirty(true);
                      }}
                      className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm disabled:opacity-75"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-[#0F172A] mb-1">
                        Owner (blank = UNKNOWN)
                      </label>
                      <input
                        type="text"
                        disabled={!canEdit}
                        value={ownerName}
                        placeholder="UNKNOWN"
                        onChange={(e) => {
                          setOwnerName(e.target.value);
                          setDirty(true);
                        }}
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm disabled:opacity-75"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#0F172A] mb-1">Evidence state</label>
                      <select
                        disabled={!canEdit}
                        value={evidenceState}
                        onChange={(e) => {
                          setEvidenceState(e.target.value as EvidenceState);
                          setDirty(true);
                        }}
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-medium disabled:opacity-75"
                      >
                        {EVIDENCE_STATES.map((st) => (
                          <option key={st} value={st}>
                            {st}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-[#0F172A] mb-1">Locator</label>
                      <input
                        type="text"
                        disabled={!canEdit}
                        value={locator}
                        onChange={(e) => {
                          setLocator(e.target.value);
                          setDirty(true);
                        }}
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-mono disabled:opacity-75"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#0F172A] mb-1">Workflow stage</label>
                      <select
                        disabled={!canEdit}
                        value={stage}
                        onChange={(e) => {
                          setStage(e.target.value as WorkflowStageId);
                          setDirty(true);
                        }}
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-mono disabled:opacity-75"
                      >
                        <option value="01">01 Connect</option>
                        <option value="02">02 Reconstruct</option>
                        <option value="03">03 Verify</option>
                        <option value="04">04 Review</option>
                        <option value="05">05 Handover</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[#0F172A] mb-1">Claim excerpt</label>
                    <textarea
                      rows={3}
                      disabled={!canEdit}
                      value={excerpt}
                      onChange={(e) => {
                        setExcerpt(e.target.value);
                        setDirty(true);
                      }}
                      className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm disabled:opacity-75"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[#0F172A] mb-1">Continuity rationale</label>
                    <textarea
                      rows={2}
                      disabled={!canEdit}
                      value={rationale}
                      placeholder="Why this claim matters for handover continuity…"
                      onChange={(e) => {
                        setRationale(e.target.value);
                        setDirty(true);
                      }}
                      className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs disabled:opacity-75"
                    />
                  </div>

                  {canEdit && (
                    <div>
                      <label className="block text-xs font-medium text-[#0F172A] mb-1">Edit reason (for version log)</label>
                      <input
                        type="text"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        placeholder="e.g., Updated owner and cited span after calibration check"
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
                      />
                    </div>
                  )}
                </div>

                {canEdit && (
                  <div className="pt-2 space-y-2">
                    {selected.approval_state === 'APPROVED' && dirty && (
                      <p className="text-xs text-[#B45309]">
                        Note: saving edits increments version to v{selected.version + 1} and resets approval to NEEDS_REVIEW.
                      </p>
                    )}
                    <button
                      type="submit"
                      disabled={saving}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-[#2563EB] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
                    >
                      <Save className="h-4 w-4" aria-hidden="true" />
                      <span>{saving ? 'Saving…' : 'Save new record version'}</span>
                    </button>
                  </div>
                )}
              </form>

              {/* Immutable Record Version History */}
              <div className="pt-4 border-t border-[#E2E8F0] space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0F172A]">
                    <History className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
                    <span>Immutable version history ({versions.length})</span>
                  </span>
                </div>
                {versionsLoading ? (
                  <p className="text-xs text-[#64748B]">Loading version history…</p>
                ) : (
                  <ul className="space-y-2 max-h-48 overflow-y-auto">
                    {versions.map((v) => (
                      <li key={v.id} className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-2.5 text-xs space-y-1">
                        <div className="flex items-center justify-between font-mono">
                          <span className="font-bold text-[#2563EB]">v{v.version}</span>
                          <span className="text-[11px] text-[#64748B]">
                            {v.evidence_state} · {v.approval_state}
                          </span>
                        </div>
                        <p className="text-[#0F172A] font-medium">{v.reason}</p>
                        <p className="font-mono text-[10px] text-[#64748B]">
                          {v.edited_by} · {v.created_at.slice(0, 16).replace('T', ' ')}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-[#64748B]">Select a record from the table to inspect or edit.</p>
          )}
        </aside>
      </div>
      </div>
    </>
  );
}
