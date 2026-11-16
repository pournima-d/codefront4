import React, { useCallback, useEffect, useState } from 'react';
import { Check, Flag, RotateCcw, X } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import type { ResearchRecord } from '../../types';
import { ApprovalBadge, EvidenceBadge } from '../StatusChip';

interface ReviewLogItem {
  id: string;
  record_id: string;
  record_version: number;
  reviewer_name: string;
  action: string;
  comment: string;
  created_at: string;
}

interface ReviewTabProps {
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function ReviewTab({ onToast }: ReviewTabProps) {
  const [queue, setQueue] = useState<ResearchRecord[]>([]);
  const [history, setHistory] = useState<ReviewLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [commentErrors, setCommentErrors] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'PENDING' | 'ALL'>('PENDING');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{ queue: ResearchRecord[]; history: ReviewLogItem[] }>('/api/reviews');
      setQueue(res.queue);
      setHistory(res.history);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load review queue';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Restore draft review comments
  useEffect(() => {
    apiFetch<{ content: Record<string, string> | null }>('/api/drafts/review_comments')
      .then((res) => {
        if (res.content) {
          setComments(res.content);
          return;
        }
        const local = localStorage.getItem('baton_draft_review_comments');
        if (local) setComments(JSON.parse(local));
      })
      .catch(() => {});
  }, []);

  // Autosave review comments every 3s
  useEffect(() => {
    if (Object.keys(comments).length === 0) return;
    try {
      localStorage.setItem('baton_draft_review_comments', JSON.stringify(comments));
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      apiFetch('/api/drafts/review_comments', {
        method: 'PUT',
        body: JSON.stringify({ content: comments }),
      }).catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, [comments]);

  const submitReview = async (
    recordId: string,
    action: 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT' | 'FLAG_GAP'
  ) => {
    if (submittingId) return;
    const rationale = (comments[recordId] || '').trim();
    if (rationale.length < 3) {
      const msg = 'Enter a mandatory reviewer rationale (minimum 3 characters) before submitting.';
      setCommentErrors((prev) => ({ ...prev, [recordId]: msg }));
      onToast(msg, 'error');
      return;
    }
    setCommentErrors((prev) => {
      const next = { ...prev };
      delete next[recordId];
      return next;
    });
    setSubmittingId(recordId);
    try {
      await apiFetch(`/api/records/${recordId}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, comment: rationale }),
      });
      setComments((prev) => {
        const next = { ...prev };
        delete next[recordId];
        return next;
      });
      await loadQueue();
      onToast(`Recorded ${action} for ${recordId}.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Review action failed', 'error');
    } finally {
      setSubmittingId(null);
    }
  };

  const visibleQueue =
    filter === 'PENDING'
      ? queue.filter((r) => r.approval_state !== 'APPROVED')
      : queue;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">04. Reviewer Decision Queue</h1>
          <p className="text-sm text-[#64748B]">
            Approve, request changes, reject, or flag gaps per exact record version (mandatory rationale required).
          </p>
        </div>
        <div className="inline-flex rounded-full border border-[#E2E8F0] bg-white p-1">
          <button
            type="button"
            onClick={() => setFilter('PENDING')}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              filter === 'PENDING' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            Needs decision ({queue.filter((r) => r.approval_state !== 'APPROVED').length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('ALL')}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
              filter === 'ALL' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
            }`}
          >
            All records ({queue.length})
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
            onClick={() => void loadQueue()}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 space-y-4">
          {loading ? (
            <div className="h-44 rounded-2xl border border-[#E2E8F0] bg-white animate-pulse" />
          ) : visibleQueue.length === 0 ? (
            <div className="rounded-2xl border border-[#E2E8F0] bg-white p-8 text-center space-y-2">
              <p className="text-sm font-semibold text-[#0F172A]">All visible records are currently approved.</p>
              <p className="text-xs text-[#64748B]">
                Switch to &ldquo;All records&rdquo; to inspect past approvals or flag newly discovered gaps.
              </p>
            </div>
          ) : (
            visibleQueue.map((item) => (
              <article
                key={item.id}
                className="rounded-2xl border border-[#E2E8F0] bg-white p-6 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
                      <span className="font-mono font-bold text-[#2563EB]">{item.id}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{item.type}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">v{item.version}</span>
                      <span aria-hidden="true">·</span>
                      <span>Owner: {item.owner_name || 'UNKNOWN'}</span>
                    </div>
                    <h2 className="font-display text-lg font-bold text-[#0F172A] mt-1">{item.title}</h2>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <EvidenceBadge state={item.evidence_state} />
                    <ApprovalBadge state={item.approval_state} />
                  </div>
                </div>

                {/* Claim vs Span Side-by-Side */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 space-y-1">
                    <span className="text-[11px] font-semibold text-[#64748B]">Claim excerpt</span>
                    <p className="text-xs text-[#0F172A] leading-relaxed">{item.excerpt}</p>
                  </div>
                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-[#64748B]">
                        {item.source_file} ({item.locator})
                      </span>
                      <span className={item.verbatim_match ? 'text-[#059669] font-semibold' : 'text-[#D97706] font-semibold'}>
                        {item.verbatim_match ? 'Verbatim match' : 'Mismatch'}
                      </span>
                    </div>
                    <p className="text-xs text-[#475569] leading-relaxed">
                      {item.span_content || 'No linked span content'}
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                    <input
                      type="text"
                      aria-label={`Mandatory reviewer rationale for ${item.id}`}
                      value={comments[item.id] || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setComments((prev) => ({ ...prev, [item.id]: val }));
                        if (val.trim().length >= 3 && commentErrors[item.id]) {
                          setCommentErrors((prev) => {
                            const next = { ...prev };
                            delete next[item.id];
                            return next;
                          });
                        }
                      }}
                      placeholder="Mandatory reviewer rationale (min 3 chars, autosaved)…"
                      className={`flex-1 rounded-full border bg-[#F8FAFC] px-4 py-2 text-xs text-[#0F172A] focus:border-[#2563EB] focus:bg-white focus:outline-none ${
                        commentErrors[item.id] ? 'border-[#DC2626]' : 'border-[#E2E8F0]'
                      }`}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={submittingId === item.id}
                        onClick={() => submitReview(item.id, 'APPROVE')}
                        className="inline-flex items-center gap-1 rounded-full bg-[#059669] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#047857] disabled:opacity-60"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Approve</span>
                      </button>
                      <button
                        type="button"
                        disabled={submittingId === item.id}
                        onClick={() => submitReview(item.id, 'REQUEST_CHANGES')}
                        className="inline-flex items-center gap-1 rounded-full bg-[#D97706] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#B45309] disabled:opacity-60"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Request changes</span>
                      </button>
                      <button
                        type="button"
                        disabled={submittingId === item.id}
                        onClick={() => submitReview(item.id, 'FLAG_GAP')}
                        className="inline-flex items-center gap-1 rounded-full border border-[#D97706] bg-white px-3.5 py-1.5 text-xs font-semibold text-[#B45309] hover:bg-[#FFFBEB] disabled:opacity-60"
                      >
                        <Flag className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Flag gap</span>
                      </button>
                      <button
                        type="button"
                        disabled={submittingId === item.id}
                        onClick={() => submitReview(item.id, 'REJECT')}
                        className="inline-flex items-center gap-1 rounded-full bg-[#DC2626] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Reject</span>
                      </button>
                    </div>
                  </div>
                  {commentErrors[item.id] && (
                    <p role="alert" className="text-xs text-[#DC2626] font-medium px-2">
                      {commentErrors[item.id]}
                    </p>
                  )}
                </div>
              </article>
            ))
          )}
        </div>

        {/* Review History Rail */}
        <aside className="lg:col-span-4 rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-4">
          <h2 className="font-display text-base font-bold text-[#0F172A]">Recent review log</h2>
          <div className="space-y-3 max-h-[560px] overflow-y-auto">
            {history.length === 0 ? (
              <p className="text-xs text-[#64748B]">No review decisions recorded yet.</p>
            ) : (
              history.map((h) => (
                <div key={h.id} className="border-b border-[#E2E8F0] pb-3 last:border-b-0 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-[#2563EB]">
                      {h.record_id} (v{h.record_version})
                    </span>
                    <span className="font-mono text-[11px] text-[#64748B] tabular-nums">
                      {h.created_at.slice(0, 10)}
                    </span>
                  </div>
                  <p className="text-xs font-semibold text-[#0F172A]">
                    {h.action} · {h.reviewer_name}
                  </p>
                  {h.comment && <p className="text-xs text-[#64748B]">{h.comment}</p>}
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
