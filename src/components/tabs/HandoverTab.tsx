import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, FileDown, FilePlus2, Maximize2, Minimize2, PackagePlus, Send, Trash2, X } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import type { EvidenceState, ApprovalState, HandoverDoc, Role } from '../../types';
import { ApprovalBadge, EvidenceBadge } from '../StatusChip';

interface EligibleRecord {
  id: string;
  type: string;
  title: string;
  owner_name: string | null;
  evidence_state: EvidenceState;
  approval_state: ApprovalState;
  version: number;
}

interface RecipientOption {
  id: string;
  name: string;
  email: string;
  role: Role;
}

interface HandoverTabProps {
  role: Role;
  currentUserEmail?: string;
  hasSensitiveAuth: boolean;
  onRequestSensitiveAuth: (label: string, onSuccess: () => void) => void;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function HandoverTab({
  role,
  currentUserEmail,
  hasSensitiveAuth,
  onRequestSensitiveAuth,
  onToast,
}: HandoverTabProps) {
  const [handovers, setHandovers] = useState<HandoverDoc[]>([]);
  const [eligibleApprovedRecords, setEligibleApprovedRecords] = useState<EligibleRecord[]>([]);
  const [recipients, setRecipients] = useState<RecipientOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [geminiAvailable, setGeminiAvailable] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackNote, setAckNote] = useState('');

  // Custom package assembly state
  const [assembleOpen, setAssembleOpen] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [customRecipient, setCustomRecipient] = useState('');
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
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

  const loadHandovers = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{
        handovers: HandoverDoc[];
        geminiAvailable: boolean;
        eligibleApprovedRecords?: EligibleRecord[];
        recipients?: RecipientOption[];
      }>('/api/handovers');
      setHandovers(res.handovers);
      setGeminiAvailable(res.geminiAvailable);
      const elig = res.eligibleApprovedRecords || [];
      setEligibleApprovedRecords(elig);
      setSelectedRecordIds((prev) => (prev.length > 0 ? prev : elig.map((r) => r.id)));
      const recs = res.recipients || [];
      setRecipients(recs);
      if (recs.length > 0 && !customRecipient) {
        const incoming = recs.find((u) => u.role === 'INCOMING_MEMBER') || recs[0];
        setCustomRecipient(incoming.name);
      }
      if (res.handovers.length > 0 && (!selectedId || !res.handovers.some((h) => h.id === selectedId))) {
        setSelectedId(res.handovers[0].id);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load handovers';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast, selectedId, customRecipient]);

  useEffect(() => {
    void loadHandovers();
  }, [loadHandovers]);

  const handleGenerateDraft = async (customOpts?: {
    title?: string;
    recipientName?: string;
    recordIds?: string[];
  }) => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await apiFetch<{ handoverId: string; version: number; extractorMode: string }>(
        '/api/handovers/generate',
        {
          method: 'POST',
          body: JSON.stringify({
            useAi,
            ...(customOpts || {}),
          }),
        }
      );
      setAssembleOpen(false);
      setCustomTitle('');
      await loadHandovers();
      setSelectedId(created.handoverId);
      onToast(
        `Generated Handover Draft v${created.version} (${created.extractorMode}).`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to generate draft', 'error');
    } finally {
      setBusy(false);
    }
  };

  const executePublish = async (handoverId: string) => {
    setBusy(true);
    try {
      await apiFetch(`/api/handovers/${handoverId}/publish`, { method: 'POST', body: JSON.stringify({}) });
      await loadHandovers();
      onToast('Handover published and locked for incoming members.', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SENSITIVE_AUTH_REQUIRED') {
        onRequestSensitiveAuth('publish this handover', () => {
          void executePublish(handoverId);
        });
      } else {
        onToast(err instanceof ApiError ? err.message : 'Publish failed', 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = (handoverId: string) => {
    if (!hasSensitiveAuth) {
      onRequestSensitiveAuth('publish this handover', () => {
        void executePublish(handoverId);
      });
      return;
    }
    void executePublish(handoverId);
  };

  const handleAcknowledge = async (handoverId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/handovers/${handoverId}/acknowledge`, {
        method: 'POST',
        body: JSON.stringify({ note: ackNote || 'Receipt acknowledged (not agreement).' }),
      });
      setAckNote('');
      await loadHandovers();
      onToast('Handover receipt acknowledged.', 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Acknowledgement failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleChecklistItem = async (handoverId: string, itemId: string, checked: boolean) => {
    try {
      await apiFetch(`/api/handovers/${handoverId}/items/${itemId}/check`, {
        method: 'POST',
        body: JSON.stringify({ checked }),
      });
      setHandovers((prev) =>
        prev.map((ho) =>
          ho.id === handoverId
            ? {
                ...ho,
                items: ho.items.map((it) =>
                  it.id === itemId ? { ...it, recipient_checked: checked ? 1 : 0 } : it
                ),
              }
            : ho
        )
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to update checklist item', 'error');
    }
  };

  const current = handovers.find((h) => h.id === selectedId) || null;
  const sections = current
    ? Array.from(new Set(current.items.map((i) => i.section)))
    : [];

  const canGenerate = role === 'PI_LEAD' || role === 'RESEARCHER';
  const canPublish = role === 'PI_LEAD';
  const canAck = role === 'INCOMING_MEMBER' || role === 'PI_LEAD';
  const canDeleteCurrent =
    Boolean(current) &&
    (role === 'PI_LEAD' ||
      (role === 'RESEARCHER' &&
        current!.status === 'DRAFT' &&
        (!currentUserEmail || current!.created_by === currentUserEmail)));

  const handleDeleteHandover = async (ho: HandoverDoc) => {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/handovers/${ho.id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      const remaining = handovers.filter((h) => h.id !== ho.id);
      setHandovers(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      onToast(`Deleted Handover v${ho.version} (${ho.status}).`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete handover', 'error');
    } finally {
      setBusy(false);
    }
  };

  const checkedCount = current ? current.items.filter((i) => i.recipient_checked === 1).length : 0;

  const exportMarkdown = () => {
    if (!current) return;
    const lines = [
      `# ${current.title}`,
      `Status: ${current.status} | Extractor: ${current.extractor_mode} | Version: v${current.version}${current.recipient_name ? ` | Recipient: ${current.recipient_name}` : ''}`,
      '',
      current.summary_md,
      '',
      ...sections.flatMap((sec) => [
        `## ${sec}`,
        ...current.items
          .filter((i) => i.section === sec)
          .map(
            (i) =>
              `- **${i.record_id}** (${i.evidence_state} / ${i.approval_state} · Owner: ${i.owner_name || 'UNKNOWN'}): ${i.rendered_text} [${i.source_file}, ${i.locator}]`
          ),
        '',
      ]),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `baton-handover-v${current.version}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
            ? 'fixed inset-2 sm:inset-4 z-50 rounded-2xl border border-[#CBD5E1] bg-[#F8FAFC] p-4 sm:p-6 shadow-2xl overflow-y-auto space-y-6'
            : 'space-y-6'
        }
      >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">05. Role-Filtered Handover Brief</h1>
          <p className="text-sm text-[#64748B]">
            RESTRICTED_PI_ONLY sources and rejected credentials are dropped; confirmed redactions render as [REDACTED:type].
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {canGenerate && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-[#64748B] cursor-pointer">
                <input
                  type="checkbox"
                  checked={useAi}
                  disabled={!geminiAvailable}
                  onChange={(e) => setUseAi(e.target.checked)}
                  className="rounded border-[#CBD5E1]"
                />
                <span>{geminiAvailable ? 'Use optional Gemini summary' : 'Deterministic rule-based mode'}</span>
              </label>
              <button
                type="button"
                onClick={() => setAssembleOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
              >
                {assembleOpen ? <X className="h-3.5 w-3.5" aria-hidden="true" /> : <PackagePlus className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />}
                <span>{assembleOpen ? 'Close custom builder' : 'Assemble custom package'}</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleGenerateDraft()}
                className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
              >
                <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{busy ? 'Generating…' : 'Generate new draft'}</span>
              </button>
            </>
          )}

          {current && (
            <button
              type="button"
              onClick={exportMarkdown}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
            >
              <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Export Markdown</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsMaximized((v) => !v)}
            aria-label={isMaximized ? 'Exit full screen' : 'Maximise Handover Brief'}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-semibold transition-colors ${
              isMaximized
                ? 'border-[#0F172A] bg-[#0F172A] text-white hover:bg-[#1E293B]'
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
            onClick={() => void loadHandovers()}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      {/* Custom Handover Package Builder */}
      {assembleOpen && canGenerate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleGenerateDraft({
              title: customTitle.trim() || undefined,
              recipientName: customRecipient || undefined,
              recordIds: selectedRecordIds,
            });
          }}
          className="rounded-2xl border border-[#2563EB]/30 bg-white p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-bold text-[#0F172A]">Assemble Custom Handover Package</h2>
              <p className="text-xs text-[#64748B]">
                Choose a recipient and curate specific APPROVED records to include alongside open-loop warnings.
              </p>
            </div>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setSelectedRecordIds(eligibleApprovedRecords.map((r) => r.id))}
                className="text-[#2563EB] hover:underline font-medium"
              >
                Select all approved
              </button>
              <span className="text-[#CBD5E1]">·</span>
              <button
                type="button"
                onClick={() => setSelectedRecordIds([])}
                className="text-[#64748B] hover:underline font-medium"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Custom package title</label>
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="e.g., Onboarding Handover Brief — Synthesis & EIS"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Designated recipient</label>
              <select
                value={customRecipient}
                onChange={(e) => setCustomRecipient(e.target.value)}
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs"
              >
                {recipients.map((u) => (
                  <option key={u.id} value={u.name}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {eligibleApprovedRecords.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-[#0F172A]">
                Eligible APPROVED records ({selectedRecordIds.length}/{eligibleApprovedRecords.length} selected)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-48 overflow-y-auto">
                {eligibleApprovedRecords.map((rec) => {
                  const checked = selectedRecordIds.includes(rec.id);
                  return (
                    <label
                      key={rec.id}
                      className={`flex items-start gap-2 rounded-xl border p-2.5 text-xs cursor-pointer ${
                        checked ? 'border-[#2563EB] bg-[#2563EB]/5' : 'border-[#E2E8F0] bg-[#F8FAFC]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedRecordIds((prev) => [...prev, rec.id]);
                          } else {
                            setSelectedRecordIds((prev) => prev.filter((id) => id !== rec.id));
                          }
                        }}
                        className="mt-0.5 rounded border-[#CBD5E1]"
                      />
                      <div className="min-w-0">
                        <p className="font-mono font-bold text-[#2563EB]">
                          {rec.id} · {rec.type}
                        </p>
                        <p className="font-medium text-[#0F172A] truncate">{rec.title}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setAssembleOpen(false)}
              className="rounded-full border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#0F172A]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-full bg-[#2563EB] px-5 py-1.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              {busy ? 'Assembling…' : 'Assemble draft'}
            </button>
          </div>
        </form>
      )}

      {/* Version selector bar */}
      {handovers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {handovers.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => setSelectedId(h.id)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold border transition-colors ${
                h.id === selectedId
                  ? 'border-[#2563EB] bg-[#2563EB] text-white'
                  : 'border-[#E2E8F0] bg-white text-[#0F172A] hover:border-[#94A3B8]'
              }`}
            >
              v{h.version} · {h.status}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="h-64 rounded-2xl border border-[#E2E8F0] bg-white animate-pulse" />
      ) : !current ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white p-8 text-center text-sm text-[#64748B]">
          No handover packages available for your role yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Document TOC + Actions */}
          <aside className="lg:col-span-3 rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-5">
            <div>
              <span className="text-xs font-semibold text-[#64748B]">Document sections</span>
              <ul className="mt-2 space-y-1.5 text-xs">
                {sections.map((sec) => (
                  <li key={sec}>
                    <a
                      href={`#ho-sec-${sec.replace(/\W+/g, '-')}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document
                          .getElementById(`ho-sec-${sec.replace(/\W+/g, '-')}`)
                          ?.scrollIntoView({ behavior: 'smooth' });
                      }}
                      className="text-[#2563EB] hover:underline font-medium"
                    >
                      {sec}
                    </a>
                  </li>
                ))}
                <li>
                  <a
                    href="#ho-sec-provenance-checklist"
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById('ho-sec-provenance-checklist')?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    className="text-[#2563EB] hover:underline font-medium"
                  >
                    5. Provenance Verification Checklist
                  </a>
                </li>
              </ul>
            </div>

            {canPublish && current.status === 'DRAFT' && (
              <div className="pt-4 border-t border-[#E2E8F0] space-y-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handlePublish(current.id)}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-[#059669] px-4 py-2 text-xs font-semibold text-white hover:bg-[#047857] disabled:opacity-60"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Publish Handover v{current.version}</span>
                </button>
                <p className="text-[11px] text-[#64748B]">
                  Publishing requires password re-authentication (valid for 15 minutes).
                </p>
              </div>
            )}

            {canAck && current.status === 'PUBLISHED' && (
              <div className="pt-4 border-t border-[#E2E8F0] space-y-2.5">
                <p className="text-xs font-semibold text-[#0F172A]">Incoming member receipt</p>
                <p className="text-[11px] text-[#64748B]">
                  Acknowledgement records receipt only, not agreement with unverified claims.
                </p>
                <input
                  type="text"
                  value={ackNote}
                  onChange={(e) => setAckNote(e.target.value)}
                  placeholder="Optional receipt note…"
                  className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleAcknowledge(current.id)}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2563EB] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Acknowledge receipt</span>
                </button>
              </div>
            )}

            {current.acknowledgements.length > 0 && (
              <div className="pt-4 border-t border-[#E2E8F0] space-y-2">
                <span className="text-xs font-semibold text-[#0F172A]">Recorded acknowledgements</span>
                {current.acknowledgements.map((ack) => (
                  <div key={ack.id} className="text-xs text-[#475569]">
                    <p className="font-semibold text-[#0F172A]">{ack.user_name}</p>
                    <p className="text-[11px] text-[#64748B]">{ack.note}</p>
                    <p className="font-mono text-[10px] text-[#64748B] tabular-nums">
                      {ack.acknowledged_at.slice(0, 16)}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {canDeleteCurrent && (
              <div className="pt-4 border-t border-[#E2E8F0] space-y-2">
                {confirmDeleteId === current.id ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDeleteHandover(current)}
                      className="flex-1 rounded-full bg-[#DC2626] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                    >
                      {busy ? 'Deleting…' : 'Confirm delete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-full border border-[#E2E8F0] px-3 py-1.5 text-xs text-[#64748B]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(current.id)}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-full border border-[#DC2626]/30 bg-white px-4 py-2 text-xs font-semibold text-[#DC2626] hover:bg-[#DC2626]/5"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{current.status === 'DRAFT' ? `Delete Draft v${current.version}` : `Delete Handover v${current.version}`}</span>
                  </button>
                )}
              </div>
            )}
          </aside>

          {/* Main Document Body */}
          <article className="lg:col-span-9 rounded-2xl border border-[#E2E8F0] bg-white p-7 lg:p-9 space-y-7">
            <header className="border-b border-[#E2E8F0] pb-5 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                <span className="font-mono font-bold text-[#2563EB]">v{current.version}</span>
                <span aria-hidden="true">·</span>
                <span className={current.status === 'PUBLISHED' ? 'text-[#059669] font-semibold' : 'text-[#D97706] font-semibold'}>
                  {current.status}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{current.extractor_mode}</span>
                {current.recipient_name && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Recipient: {current.recipient_name}</span>
                  </>
                )}
                {current.published_at && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">Published {current.published_at.slice(0, 10)}</span>
                  </>
                )}
              </div>
              <h2 className="font-display text-2xl font-extrabold text-[#0F172A]">{current.title}</h2>
              <p className="text-sm text-[#475569] leading-relaxed">{current.summary_md}</p>
            </header>

            {sections.map((sec) => (
              <section
                key={sec}
                id={`ho-sec-${sec.replace(/\W+/g, '-')}`}
                className="space-y-3"
              >
                <h3 className="font-display text-lg font-bold text-[#0F172A]">{sec}</h3>
                <div className="divide-y divide-[#E2E8F0] border border-[#E2E8F0] rounded-xl">
                  {current.items
                    .filter((i) => i.section === sec)
                    .map((item) => (
                      <div key={item.id} className="p-4 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-mono font-bold text-[#2563EB]">{item.record_id}</span>
                            <span className="text-[#64748B]">·</span>
                            <span className="text-[#475569]">Owner: {item.owner_name || 'UNKNOWN'}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <EvidenceBadge state={item.evidence_state} />
                            <ApprovalBadge state={item.approval_state} />
                          </div>
                        </div>
                        <p className="text-sm text-[#0F172A] leading-relaxed">{item.rendered_text}</p>
                        <p className="text-xs font-mono text-[#64748B]">
                          Source: {item.source_file} ({item.locator}) · v{item.version_at_inclusion}
                        </p>
                      </div>
                    ))}
                </div>
              </section>
            ))}

            {/* Section 5: Owners, Contacts & Provenance Verification Checklist */}
            <section id="ho-sec-provenance-checklist" className="pt-4 border-t border-[#E2E8F0] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-[#2563EB]" aria-hidden="true" />
                  <h3 className="font-display text-lg font-bold text-[#0F172A]">
                    5. Owners, Contacts &amp; Provenance Verification Checklist
                  </h3>
                </div>
                <span className="font-mono text-xs font-semibold tabular-nums text-[#059669]">
                  {checkedCount} / {current.items.length} checked
                </span>
              </div>
              <p className="text-xs text-[#64748B]">
                Incoming members and PI leads confirm each cited claim owner, locator, and source provenance step-by-step.
              </p>
              <div className="overflow-x-auto border border-[#E2E8F0] rounded-xl">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]">
                      <th className="py-2.5 px-3.5 w-10">Done</th>
                      <th className="py-2.5 px-3.5">Record</th>
                      <th className="py-2.5 px-3.5">Owner</th>
                      <th className="py-2.5 px-3.5">Source &amp; Locator</th>
                      <th className="py-2.5 px-3.5">Evidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E2E8F0]">
                    {current.items.map((item) => {
                      const isChecked = item.recipient_checked === 1;
                      return (
                        <tr key={`chk-${item.id}`} className="hover:bg-[#F8FAFC]">
                          <td className="py-2.5 px-3.5">
                            <input
                              type="checkbox"
                              aria-label={`Verify provenance for ${item.record_id}`}
                              disabled={!canAck}
                              checked={isChecked}
                              onChange={(e) =>
                                void handleToggleChecklistItem(current.id, item.id, e.target.checked)
                              }
                              className="rounded border-[#CBD5E1] text-[#059669] focus:ring-[#059669] disabled:opacity-60"
                            />
                          </td>
                          <td className="py-2.5 px-3.5 font-mono font-bold text-[#2563EB]">
                            {item.record_id}
                          </td>
                          <td className="py-2.5 px-3.5 text-[#0F172A]">
                            {item.owner_name || <span className="font-mono text-[#D97706]">UNKNOWN</span>}
                          </td>
                          <td className="py-2.5 px-3.5 font-mono text-[#475569]">
                            {item.source_file} · {item.locator}
                          </td>
                          <td className="py-2.5 px-3.5">
                            <EvidenceBadge state={item.evidence_state} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </article>
        </div>
      )}
      </div>
    </>
  );
}
