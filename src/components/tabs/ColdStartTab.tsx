import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  MessageSquare,
  RotateCcw,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import type { ColdStartQuestion, ColdStartRun, Role } from '../../types';

interface ColdStartResponse {
  handover: { id: string; version: number; title: string; published_at: string } | null;
  questions: ColdStartQuestion[];
  coverageGaps: Array<{ record_id: string; question: string; reason: string }>;
  untestedRecords: Array<{ id: string; title: string; type: string }>;
  answerableCount: number;
  totalCount: number;
  runs: ColdStartRun[];
}

interface ColdStartTabProps {
  role?: Role;
  currentUserId?: string;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function ColdStartTab({ role, currentUserId, onToast }: ColdStartTabProps) {
  const [data, setData] = useState<ColdStartResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [latestRun, setLatestRun] = useState<ColdStartRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [duplicateGuardPrompt, setDuplicateGuardPrompt] = useState(false);
  const [confirmDeleteRunId, setConfirmDeleteRunId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<ColdStartResponse>('/api/coldstart');
      setData(res);
      if (res.runs.length > 0) {
        setLatestRun(res.runs[0]);
      } else {
        setLatestRun(null);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load Cold-Start Test';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Restore autosaved answers
  useEffect(() => {
    apiFetch<{ content: Record<string, string> | null }>('/api/drafts/coldstart_answers')
      .then((res) => {
        if (res.content) {
          setAnswers(res.content);
          return;
        }
        const local = localStorage.getItem('baton_draft_coldstart_answers');
        if (local) setAnswers(JSON.parse(local));
      })
      .catch(() => {});
  }, []);

  // Autosave answers every 3s
  useEffect(() => {
    if (Object.keys(answers).length === 0) return;
    try {
      localStorage.setItem('baton_draft_coldstart_answers', JSON.stringify(answers));
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      apiFetch('/api/drafts/coldstart_answers', {
        method: 'PUT',
        body: JSON.stringify({ content: answers }),
      }).catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, [answers]);

  const submitEvaluation = async (forceNewAttempt = false) => {
    if (submitting) return;
    setSubmitting(true);
    setDuplicateGuardPrompt(false);
    try {
      const res = await apiFetch<{ run: ColdStartRun }>('/api/coldstart/submit', {
        method: 'POST',
        body: JSON.stringify({ answers, forceNewAttempt }),
      });
      setLatestRun(res.run);
      await loadData();
      onToast(
        `Cold-Start evaluation saved for Handover v${res.run.handover_version}.`,
        'success'
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDuplicateGuardPrompt(true);
        onToast(err.message, 'info');
      } else {
        onToast(err instanceof ApiError ? err.message : 'Evaluation failed', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitEvaluation(false);
  };

  const handleDeleteRun = async (runId: string) => {
    if (deletingRunId) return;
    setDeletingRunId(runId);
    try {
      await apiFetch(`/api/coldstart/runs/${runId}`, { method: 'DELETE' });
      setConfirmDeleteRunId(null);
      if (latestRun?.id === runId) {
        setLatestRun(null);
      }
      await loadData();
      onToast('Deleted Cold-Start evaluation run.', 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete evaluation run', 'error');
    } finally {
      setDeletingRunId(null);
    }
  };

  const renderStatusPill = (status?: ColdStartQuestion['evaluation_status']) => {
    if (!status) return null;
    if (status === 'CORRECT') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#059669]/12 px-2.5 py-0.5 text-[11px] font-bold text-[#059669]">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          <span>CORRECT</span>
        </span>
      );
    }
    if (status === 'PARTIAL') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#D97706]/12 px-2.5 py-0.5 text-[11px] font-bold text-[#B45309]">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          <span>PARTIAL</span>
        </span>
      );
    }
    if (status === 'INCORRECT') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-[#DC2626]/12 px-2.5 py-0.5 text-[11px] font-bold text-[#DC2626]">
          <XCircle className="h-3 w-3" aria-hidden="true" />
          <span>INCORRECT</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#F1F5F9] px-2.5 py-0.5 text-[11px] font-bold text-[#64748B]">
        <HelpCircle className="h-3 w-3" aria-hidden="true" />
        <span>UNANSWERED</span>
      </span>
    );
  };

  if (loading) {
    return <div className="h-72 rounded-2xl border border-[#E2E8F0] bg-white animate-pulse" />;
  }

  if (loadError && !data) {
    return (
      <div className="rounded-2xl border border-[#DC2626]/30 bg-white p-8 text-center space-y-3">
        <p className="text-sm font-medium text-[#DC2626]">{loadError}</p>
        <button
          type="button"
          onClick={() => void loadData()}
          className="inline-flex items-center gap-2 rounded-full bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Retry</span>
        </button>
      </div>
    );
  }

  if (!data?.handover) {
    return (
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-8 text-center space-y-2">
        <p className="text-sm font-semibold text-[#0F172A]">No published handover available yet.</p>
        <p className="text-xs text-[#64748B]">
          A PI Lead must publish a handover version before running the Cold-Start Test.
        </p>
      </div>
    );
  }

  const displayedQuestions = latestRun?.questions || data.questions;
  const summary = latestRun?.coverage_summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">Cold-Start Handover Test</h1>
          <p className="text-sm text-[#64748B]">
            Generated from published Handover v{data.handover.version}. Measures handover brief coverage across 10 research continuity categories—not human competence.
          </p>
        </div>

        <div className="rounded-2xl border border-[#E2E8F0] bg-white px-5 py-3 text-right space-y-0.5">
          <p className="font-mono text-sm font-extrabold tabular-nums text-[#0F172A]">
            Brief coverage: {data.answerableCount} of {data.totalCount} questions answerable
          </p>
          {summary && (
            <p className="text-xs font-mono text-[#2563EB]">
              Last run coverage: {summary.knowledgeCoveragePct}% ({summary.evaluationMode})
            </p>
          )}
        </div>
      </div>

      {/* Knowledge Coverage Indicator Card */}
      {summary && (
        <section className="rounded-2xl border border-[#2563EB]/25 bg-white p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-bold text-[#0F172A]">
                Knowledge Coverage Indicator (Latest Run)
              </h2>
              <p className="text-xs text-[#64748B]">{summary.disclaimer}</p>
            </div>
            <span className="font-mono text-xl font-extrabold text-[#2563EB]">
              {summary.knowledgeCoveragePct}%
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="rounded-xl bg-[#ECFDF5] border border-[#059669]/20 px-3 py-2">
              <p className="text-[#059669] font-semibold">Correct</p>
              <p className="font-mono text-lg font-bold text-[#0F172A]">{summary.correctCount}</p>
            </div>
            <div className="rounded-xl bg-[#FFFBEB] border border-[#D97706]/20 px-3 py-2">
              <p className="text-[#B45309] font-semibold">Partial</p>
              <p className="font-mono text-lg font-bold text-[#0F172A]">{summary.partialCount}</p>
            </div>
            <div className="rounded-xl bg-[#FEF2F2] border border-[#DC2626]/20 px-3 py-2">
              <p className="text-[#DC2626] font-semibold">Incorrect</p>
              <p className="font-mono text-lg font-bold text-[#0F172A]">{summary.incorrectCount}</p>
            </div>
            <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-2">
              <p className="text-[#64748B] font-semibold">Unanswered</p>
              <p className="font-mono text-lg font-bold text-[#0F172A]">{summary.unansweredCount}</p>
            </div>
          </div>
        </section>
      )}

      {duplicateGuardPrompt && (
        <div role="alert" className="rounded-2xl border border-[#D97706]/40 bg-[#FFFBEB] p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium text-[#B45309]">
            A Cold-Start run was just saved seconds ago. If you intentionally want to record another attempt right away, confirm below.
          </p>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submitEvaluation(true)}
            className="rounded-full bg-[#0F172A] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
          >
            Start Intentional New Attempt
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Quiz Stream */}
        <form onSubmit={handleSubmit} className="lg:col-span-8 space-y-4">
          {displayedQuestions.length === 0 ? (
            <div className="rounded-2xl border border-[#E2E8F0] bg-white p-8 text-center text-sm text-[#64748B]">
              No Cold-Start questions generated for this published handover yet.
            </div>
          ) : (
            <div className="rounded-2xl border border-[#E2E8F0] bg-white p-6 space-y-5">
              {displayedQuestions.map((q, idx) => (
                <div key={q.id} className="space-y-2.5 pb-5 border-b border-[#E2E8F0] last:border-b-0 last:pb-0">
                  <div className="flex items-start gap-3">
                    <div className="rounded-full bg-[#2563EB]/10 p-2 text-[#2563EB] shrink-0">
                      <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="space-y-1.5 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-mono font-bold text-[#2563EB]">
                          Q{idx + 1} · {q.record_id}
                        </span>
                        <span className="text-[#64748B]">({q.record_type})</span>
                        {q.category && (
                          <span className="rounded bg-[#EFF6FF] px-2 py-0.5 text-[11px] font-semibold text-[#1D4ED8]">
                            {q.category}
                          </span>
                        )}
                        {q.related_section && (
                          <span className="rounded bg-[#F1F5F9] px-2 py-0.5 text-[11px] text-[#475569]">
                            {q.related_section}
                          </span>
                        )}
                        {q.source_ref && (
                          <span className="font-mono text-[11px] text-[#64748B]">
                            {q.source_ref}
                          </span>
                        )}
                        {!q.answerable_from_handover && (
                          <span className="text-[#D97706] font-semibold">Coverage gap flagged</span>
                        )}
                        {latestRun && renderStatusPill(q.evaluation_status)}
                      </div>
                      <p className="text-sm font-semibold text-[#0F172A]">{q.question}</p>
                    </div>
                  </div>

                  <div className="pl-11 space-y-2">
                    <textarea
                      aria-label={`Answer for Q${idx + 1}: ${q.question}`}
                      rows={2}
                      value={answers[q.id] ?? q.user_answer ?? ''}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder="Type what you learned from the handover brief (autosaves every 3s)…"
                      className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2 text-sm text-[#0F172A] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                    />
                    {latestRun && q.feedback && (
                      <div className="space-y-1.5">
                        <p
                          className={`text-xs flex items-center gap-1.5 ${
                            q.evaluation_status === 'CORRECT' || q.matched
                              ? 'text-[#059669]'
                              : q.evaluation_status === 'PARTIAL' || !q.answerable_from_handover
                                ? 'text-[#B45309]'
                                : 'text-[#64748B]'
                          }`}
                        >
                          {q.evaluation_status === 'CORRECT' || q.matched ? (
                            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          ) : !q.answerable_from_handover || q.evaluation_status === 'PARTIAL' ? (
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          ) : null}
                          <span>{q.feedback}</span>
                        </p>
                        {(q.addressed_concepts?.length || q.missing_concepts?.length) ? (
                          <div className="flex flex-wrap gap-1.5 text-[11px]">
                            {q.addressed_concepts?.slice(0, 6).map((c) => (
                              <span key={c} className="rounded bg-[#ECFDF5] px-2 py-0.5 font-mono text-[#059669]">
                                ✓ {c}
                              </span>
                            ))}
                            {q.missing_concepts?.slice(0, 6).map((c) => (
                              <span key={c} className="rounded bg-[#FEF2F2] px-2 py-0.5 font-mono text-[#DC2626]">
                                missing: {c}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              <div className="pt-2 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-[#64748B]">
                  Disclaimer: Evaluates handover completeness, not a person&apos;s competence.
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {latestRun && (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void submitEvaluation(true)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC] disabled:opacity-60"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Start Intentional New Attempt</span>
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex items-center gap-2 rounded-full bg-[#2563EB] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
                  >
                    <Send className="h-4 w-4" aria-hidden="true" />
                    <span>{submitting ? 'Evaluating…' : 'Submit Cold-Start evaluation'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </form>

        {/* Coverage Gaps & Saved Runs Panel */}
        <aside className="lg:col-span-4 space-y-5">
          <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-3">
            <h2 className="font-display text-base font-bold text-[#0F172A]">
              Handover coverage gaps ({data.coverageGaps.length})
            </h2>
            <p className="text-xs text-[#64748B]">
              Questions the approved handover cannot definitively answer yet:
            </p>
            {data.coverageGaps.length === 0 ? (
              <p className="text-xs text-[#059669] font-medium">No unresolved coverage gaps detected.</p>
            ) : (
              <div className="space-y-2.5">
                {data.coverageGaps.map((gap) => (
                  <div key={gap.record_id} className="rounded-xl border border-[#D97706]/30 bg-[#D97706]/6 p-3 space-y-1">
                    <span className="font-mono text-xs font-bold text-[#B45309]">{gap.record_id}</span>
                    <p className="text-xs font-medium text-[#0F172A]">{gap.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-3">
            <h2 className="font-display text-base font-bold text-[#0F172A]">
              Approved records never asked about ({data.untestedRecords.length})
            </h2>
            {data.untestedRecords.length === 0 ? (
              <p className="text-xs text-[#64748B]">All approved handover records are covered by questions.</p>
            ) : (
              <ul className="space-y-1.5 text-xs text-[#475569]">
                {data.untestedRecords.map((rec) => (
                  <li key={rec.id} className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-[#2563EB]">{rec.id}</span>
                    <span className="truncate">{rec.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-3">
            <h2 className="font-display text-base font-bold text-[#0F172A]">
              Saved evaluation runs ({data.runs.length})
            </h2>
            {data.runs.length === 0 ? (
              <p className="text-xs text-[#64748B]">No Cold-Start test runs saved yet.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {data.runs.map((run) => {
                  const canDelRun = !role || role === 'PI_LEAD' || (currentUserId && run.user_id === currentUserId);
                  return (
                    <li key={run.id} className="border-b border-[#E2E8F0] pb-2 last:border-b-0">
                      <div className="flex justify-between font-mono tabular-nums">
                        <button
                          type="button"
                          onClick={() => setLatestRun(run)}
                          className="font-semibold text-[#0F172A] hover:text-[#2563EB] hover:underline"
                        >
                          Handover v{run.handover_version}
                        </button>
                        <span className="text-[#2563EB]">
                          {run.coverage_summary
                            ? `${run.coverage_summary.knowledgeCoveragePct}% coverage`
                            : `${run.answerable_questions}/${run.total_questions} answerable`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-1">
                        <p className="text-[#64748B]">
                          {run.user_name} · {run.created_at.slice(0, 16)}
                        </p>
                        {canDelRun && (
                          confirmDeleteRunId === run.id ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                disabled={deletingRunId === run.id}
                                onClick={() => void handleDeleteRun(run.id)}
                                className="rounded-full bg-[#DC2626] px-2 py-0.5 text-[11px] font-semibold text-white"
                              >
                                {deletingRunId === run.id ? 'Deleting…' : 'Confirm'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteRunId(null)}
                                className="rounded-full border border-[#E2E8F0] px-2 py-0.5 text-[11px] text-[#64748B]"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteRunId(run.id)}
                              aria-label={`Delete run ${run.id}`}
                              className="rounded-full border border-[#E2E8F0] p-1 text-[#64748B] hover:border-[#DC2626]/40 hover:text-[#DC2626]"
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                            </button>
                          )
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
