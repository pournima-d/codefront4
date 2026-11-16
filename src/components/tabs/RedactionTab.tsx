import React, { useCallback, useEffect, useState } from 'react';
import { Check, Eye, History, RefreshCw, RotateCcw, Settings2, Shield, Trash2, X } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import type { ProjectInfo, RedactionProposal, Role } from '../../types';

interface RedactionTabProps {
  role: Role;
  activeProjectId?: string;
  hasSensitiveAuth: boolean;
  onRequestSensitiveAuth: (label: string, onSuccess: () => void) => void;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function RedactionTab({
  role,
  activeProjectId,
  hasSensitiveAuth,
  onRequestSensitiveAuth,
  onToast,
}: RedactionTabProps) {
  const [proposals, setProposals] = useState<RedactionProposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealedMap, setRevealedMap] = useState<Record<string, { text: string; snippet: string }>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanScope, setScanScope] = useState<'SHARED' | 'PRIVATE' | 'RESTRICTED' | 'ALL'>('SHARED');
  const [decisionNote, setDecisionNote] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // PI_LEAD custom sensitive patterns
  const [projectId, setProjectId] = useState<string>(activeProjectId || 'PRJ-MAIN-01');
  const [patternsText, setPatternsText] = useState('');
  const [savingPatterns, setSavingPatterns] = useState(false);

  const loadProposals = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{ proposals: RedactionProposal[] }>('/api/redactions');
      setProposals(res.proposals);
      setSelectedId((prev) =>
        prev && res.proposals.some((p) => p.id === prev) ? prev : res.proposals[0]?.id ?? null
      );

      if (role === 'PI_LEAD') {
        try {
          const ov = await apiFetch<{ project: ProjectInfo }>('/api/overview');
          if (ov.project?.id) {
            setProjectId(ov.project.id);
            setPatternsText((ov.project.sensitive_patterns || []).join(', '));
          }
        } catch {
          // non-fatal
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load redaction proposals';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [role, onToast]);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals, activeProjectId]);

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await apiFetch<{ created: number }>('/api/redactions/scan', {
        method: 'POST',
        body: JSON.stringify({ scope: scanScope }),
      });
      await loadProposals();
      onToast(`Sensitive-content scan finished (${res.created} new proposals).`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Scan failed', 'error');
    } finally {
      setScanning(false);
    }
  };

  const handleResolve = async (id: string, decision: 'CONFIRMED' | 'REJECTED' | 'PROPOSED') => {
    if (busyId) return;
    setBusyId(id);
    try {
      await apiFetch(`/api/redactions/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          note: decisionNote.trim() || undefined,
        }),
      });
      setDecisionNote('');
      await loadProposals();
      onToast(
        decision === 'CONFIRMED'
          ? 'Redaction overlay confirmed and applied to shared previews & handover output.'
          : decision === 'REJECTED'
            ? 'Proposal rejected; original text remains unredacted.'
            : 'Proposal reopened for review.',
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Resolution failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteProposal = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await apiFetch(`/api/redactions/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      const remaining = proposals.filter((p) => p.id !== id);
      setProposals(remaining);
      if (selectedId === id) {
        setSelectedId(remaining[0]?.id ?? null);
      }
      onToast('Removed redaction proposal.', 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete proposal', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSavePatterns = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingPatterns || role !== 'PI_LEAD') return;
    setSavingPatterns(true);
    try {
      const patterns = patternsText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 3);
      const res = await apiFetch<{ sensitive_patterns: string[]; newRedactionProposals: number }>(
        `/api/projects/${projectId}/settings`,
        {
          method: 'PATCH',
          body: JSON.stringify({ sensitive_patterns: patterns }),
        }
      );
      setPatternsText(res.sensitive_patterns.join(', '));
      await loadProposals();
      onToast(
        `Saved ${res.sensitive_patterns.length} custom patterns (${res.newRedactionProposals} new proposals flagged).`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to save custom patterns', 'error');
    } finally {
      setSavingPatterns(false);
    }
  };

  const executeReveal = async (id: string) => {
    setBusyId(id);
    try {
      const res = await apiFetch<{ original_matched_text: string; original_context_snippet: string }>(
        `/api/redactions/${id}/reveal`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      setRevealedMap((prev) => ({
        ...prev,
        [id]: { text: res.original_matched_text, snippet: res.original_context_snippet },
      }));
      onToast('Original text revealed (audited).', 'info');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SENSITIVE_AUTH_REQUIRED') {
        onRequestSensitiveAuth('reveal unredacted source text', () => {
          void executeReveal(id);
        });
      } else {
        onToast(err instanceof ApiError ? err.message : 'Reveal denied', 'error');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleReveal = (id: string) => {
    if (role !== 'PI_LEAD') {
      onToast('Only PI_LEAD may reveal unredacted original text.', 'error');
      return;
    }
    if (!hasSensitiveAuth) {
      onRequestSensitiveAuth('reveal unredacted source text', () => {
        void executeReveal(id);
      });
      return;
    }
    void executeReveal(id);
  };

  const confidenceBadge = (label?: 'HIGH' | 'MEDIUM' | 'LOW') => {
    const val = label || 'MEDIUM';
    if (val === 'HIGH') return 'bg-[#059669]/12 text-[#059669]';
    if (val === 'LOW') return 'bg-[#F1F5F9] text-[#64748B]';
    return 'bg-[#D97706]/12 text-[#B45309]';
  };

  const selected = proposals.find((p) => p.id === selectedId) || null;
  const revealed = selected ? revealedMap[selected.id] : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 max-w-3xl">
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">Sensitive-Content Detection &amp; Redaction</h1>
          <p className="text-sm text-[#64748B]">
            Non-destructive overlay model: uploaded original files remain intact for evidence provenance while confirmed overlays render <code className="font-mono">[REDACTED:type]</code> in shared previews and published handovers. Only a password-reauthenticated PI Lead may reveal originals.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Sensitive scan scope"
            value={scanScope}
            onChange={(e) => setScanScope(e.target.value as 'SHARED' | 'PRIVATE' | 'RESTRICTED' | 'ALL')}
            className="rounded-full border border-[#E2E8F0] bg-white px-3.5 py-2 text-xs font-medium text-[#0F172A]"
          >
            <option value="SHARED">Scope: Shared sources &amp; records</option>
            <option value="PRIVATE">Scope: My private sources</option>
            {role === 'PI_LEAD' && <option value="RESTRICTED">Scope: Restricted PI sources</option>}
            {role === 'PI_LEAD' && <option value="ALL">Scope: Shared + Restricted</option>}
          </select>

          <button
            type="button"
            onClick={handleScan}
            disabled={scanning}
            className="inline-flex items-center gap-2 rounded-full bg-[#0F172A] px-5 py-2 text-xs font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{scanning ? 'Scanning…' : 'Scan sources & records'}</span>
          </button>
        </div>
      </div>

      {/* PI_LEAD Custom Sensitive Patterns Editor */}
      {role === 'PI_LEAD' && (
        <form onSubmit={handleSavePatterns} className="rounded-2xl border border-[#E2E8F0] bg-white p-5 flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1 space-y-1">
            <label htmlFor="custom-sensitive-patterns" className="flex items-center gap-1.5 text-xs font-semibold text-[#0F172A]">
              <Settings2 className="h-3.5 w-3.5 text-[#7C3AED]" aria-hidden="true" />
              <span>Project Custom Sensitive Keywords (comma-separated, min 3 chars each)</span>
            </label>
            <input
              id="custom-sensitive-patterns"
              type="text"
              value={patternsText}
              onChange={(e) => setPatternsText(e.target.value)}
              placeholder="e.g., proprietary_reagent, donor_id_alpha, patent_draft"
              className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2 text-xs text-[#0F172A]"
            />
          </div>
          <button
            type="submit"
            disabled={savingPatterns}
            className="rounded-full bg-[#7C3AED] px-4 py-2 text-xs font-semibold text-white hover:bg-[#6D28D9] disabled:opacity-60 shrink-0"
          >
            {savingPatterns ? 'Saving & scanning…' : 'Save patterns & rescan'}
          </button>
        </form>
      )}

      {loadError && (
        <div role="alert" className="rounded-2xl border border-[#DC2626]/30 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium text-[#DC2626]">{loadError}</p>
          <button
            type="button"
            onClick={() => void loadProposals()}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-4 py-1.5 text-xs font-semibold text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {loading ? (
        <div className="h-64 rounded-2xl border border-[#E2E8F0] bg-white animate-pulse" />
      ) : proposals.length === 0 ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white p-8 text-center text-sm text-[#64748B]">
          No sensitive-content proposals detected in the visible scope.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Proposal Queue */}
          <section className="lg:col-span-5 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
              <h2 className="font-display text-sm font-bold text-[#0F172A]">Detected proposals</h2>
              <span className="font-mono text-xs tabular-nums text-[#64748B]">
                {proposals.filter((p) => p.status === 'PROPOSED').length} pending
              </span>
            </div>
            <ul className="divide-y divide-[#E2E8F0] max-h-[600px] overflow-y-auto">
              {proposals.map((p) => {
                const isSel = p.id === selectedId;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      className={`w-full text-left px-5 py-3.5 transition-colors ${
                        isSel ? 'bg-[#7C3AED]/8' : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-bold text-[#7C3AED]">{p.category}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${confidenceBadge(p.confidence_label)}`}>
                            {p.confidence_label || 'MEDIUM'}
                          </span>
                        </div>
                        <span
                          className={`font-semibold ${
                            p.status === 'CONFIRMED'
                              ? 'text-[#059669]'
                              : p.status === 'REJECTED'
                                ? 'text-[#64748B]'
                                : 'text-[#D97706]'
                          }`}
                        >
                          {p.status}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-[#0F172A] mt-1 truncate">
                        {p.target_label || p.target_id}
                      </p>
                      <p className="font-mono text-xs text-[#64748B] mt-0.5 truncate">{p.masked_preview}</p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Side-by-Side Original vs Redacted Diff */}
          <section className="lg:col-span-7 rounded-2xl border border-[#E2E8F0] bg-white p-6 space-y-5">
            {selected ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#64748B]">
                      <span className="font-bold text-[#7C3AED]">{selected.id}</span>
                      <span>·</span>
                      <span>{selected.target_type}</span>
                      <span>·</span>
                      <span>{selected.category}</span>
                      {selected.locator && (
                        <>
                          <span>·</span>
                          <span>{selected.locator}</span>
                        </>
                      )}
                      <span className={`font-sans rounded-full px-2 py-0.5 text-[10px] font-bold ${confidenceBadge(selected.confidence_label)}`}>
                        Confidence: {selected.confidence_label || 'MEDIUM'}
                      </span>
                    </div>
                    <h2 className="font-display text-lg font-bold text-[#0F172A] mt-1">
                      {selected.target_label || selected.target_id}
                    </h2>
                    {selected.confidence_reason && (
                      <p className="text-xs text-[#64748B] mt-0.5">{selected.confidence_reason}</p>
                    )}
                  </div>

                  {role === 'PI_LEAD' && (
                    <button
                      type="button"
                      disabled={busyId === selected.id}
                      onClick={() => handleReveal(selected.id)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] px-3.5 py-1.5 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{revealed ? 'Revealed (PI-only)' : 'Reveal original (PI-only)'}</span>
                    </button>
                  )}
                </div>

                {/* Side-by-Side Comparison */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#0F172A]">Original span context</span>
                      <span className="font-mono text-[11px] text-[#64748B]">
                        {revealed ? 'Unredacted' : 'Masked preview'}
                      </span>
                    </div>
                    <p className="text-xs text-[#475569] leading-relaxed font-mono">
                      {(() => {
                        const snippet = revealed ? revealed.snippet : selected.context_snippet;
                        const token = revealed ? revealed.text : selected.masked_preview;
                        const idx = token ? snippet.indexOf(token) : -1;
                        if (idx === -1) return snippet;
                        return (
                          <>
                            {snippet.slice(0, idx)}
                            <mark className="rounded bg-[#DC2626]/15 px-1 py-0.5 text-[#DC2626] font-semibold">
                              {token}
                            </mark>
                            {snippet.slice(idx + token.length)}
                          </>
                        );
                      })()}
                    </p>
                    <p className="text-xs font-mono text-[#DC2626] bg-[#DC2626]/8 rounded px-2 py-1 inline-block">
                      Match: {revealed ? revealed.text : selected.masked_preview}
                    </p>
                  </div>

                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#0F172A]">Handover output preview</span>
                      <span className="font-mono text-[11px] text-[#059669]">{selected.replacement}</span>
                    </div>
                    <p className="text-xs text-[#0F172A] leading-relaxed font-mono">
                      {(() => {
                        const rendered = selected.context_snippet
                          .split(selected.masked_preview)
                          .join(selected.replacement);
                        const idx = rendered.indexOf(selected.replacement);
                        if (idx === -1) return rendered;
                        return (
                          <>
                            {rendered.slice(0, idx)}
                            <mark className="rounded bg-[#059669]/15 px-1 py-0.5 text-[#059669] font-semibold">
                              {selected.replacement}
                            </mark>
                            {rendered.slice(idx + selected.replacement.length)}
                          </>
                        );
                      })()}
                    </p>
                  </div>
                </div>

                {/* Decision Note + Confirmation Buttons */}
                <div className="space-y-3 pt-2 border-t border-[#E2E8F0]">
                  <input
                    type="text"
                    aria-label="Optional resolution note"
                    value={decisionNote}
                    onChange={(e) => setDecisionNote(e.target.value)}
                    placeholder="Optional audit note for this redaction decision…"
                    className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2 text-xs text-[#0F172A]"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-xs text-[#64748B] flex items-center gap-1.5">
                      <Shield className="h-3.5 w-3.5 text-[#7C3AED]" aria-hidden="true" />
                      <span>Status: {selected.status}{selected.reviewed_by ? ` by ${selected.reviewed_by}` : ''}</span>
                    </span>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busyId === selected.id}
                        onClick={() => void handleResolve(selected.id, 'CONFIRMED')}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[#059669] px-4 py-2 text-xs font-semibold text-white hover:bg-[#047857] disabled:opacity-60"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Confirm redaction</span>
                      </button>
                      <button
                        type="button"
                        disabled={busyId === selected.id}
                        onClick={() => void handleResolve(selected.id, 'REJECTED')}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-60"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Reject proposal</span>
                      </button>
                      {selected.status !== 'PROPOSED' && (
                        <button
                          type="button"
                          disabled={busyId === selected.id}
                          onClick={() => void handleResolve(selected.id, 'PROPOSED')}
                          className="inline-flex items-center gap-1.5 rounded-full border border-[#D97706]/40 bg-white px-3.5 py-2 text-xs font-semibold text-[#B45309] hover:bg-[#FFFBEB] disabled:opacity-60"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Revisit</span>
                        </button>
                      )}
                      {confirmDeleteId === selected.id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={busyId === selected.id}
                            onClick={() => void handleDeleteProposal(selected.id)}
                            className="rounded-full bg-[#DC2626] px-3 py-2 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                          >
                            {busyId === selected.id ? 'Removing…' : 'Confirm remove'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-full border border-[#E2E8F0] px-2.5 py-2 text-xs text-[#64748B]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(selected.id)}
                          aria-label="Remove proposal"
                          title="Remove proposal"
                          className="rounded-full border border-[#E2E8F0] p-2 text-[#64748B] hover:border-[#DC2626]/40 hover:text-[#DC2626]"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Proposal Decision History */}
                {selected.history && selected.history.length > 0 && (
                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 space-y-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-bold text-[#0F172A]">
                      <History className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
                      <span>Decision History</span>
                    </h3>
                    <ul className="space-y-1.5 text-xs">
                      {selected.history.map((h, i) => (
                        <li key={i} className="flex flex-wrap items-center justify-between gap-2 text-[#475569]">
                          <span>
                            <strong className="font-mono text-[#0F172A]">{h.action}</strong> by {h.actor}
                            {h.note ? ` — "${h.note}"` : ''}
                          </span>
                          <span className="font-mono text-[11px] text-[#64748B]">
                            {h.at?.slice(0, 16).replace('T', ' ')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-[#64748B]">Select a proposal to review side-by-side.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
