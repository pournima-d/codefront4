import React, { useCallback, useEffect, useState } from 'react';
import { Activity, FileText, NotebookPen, UserCheck, UserMinus } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { WORKFLOW_STAGES, type MemberActionLog, type Role, type TeamMemberStatus } from '../../types';
import { EvidenceBadge } from '../StatusChip';

interface TeamTabProps {
  role: Role;
  onOpenRecord: (recordId: string) => void;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function TeamTab({ role, onOpenRecord, onToast }: TeamTabProps) {
  const [members, setMembers] = useState<TeamMemberStatus[]>([]);
  const [teamActivity, setTeamActivity] = useState<MemberActionLog[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadTeam = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const res = await apiFetch<{
          members: TeamMemberStatus[];
          team_activity?: MemberActionLog[];
        }>('/api/team');
        setMembers(res.members);
        setTeamActivity(res.team_activity || []);
        setSelectedId((prev) => prev || res.members[0]?.id || null);
        setLoadError(null);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Failed to load team';
        if (!silent) {
          setLoadError(msg);
          onToast(msg, 'error');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [onToast]
  );

  useEffect(() => {
    void loadTeam(false);
    const poll = setInterval(() => {
      void loadTeam(true);
    }, 6000);

    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/presence/stream', { withCredentials: true });
      es.onmessage = () => {
        void loadTeam(true);
      };
    } catch {
      // fallback polling handles updates
    }

    return () => {
      clearInterval(poll);
      es?.close();
    };
  }, [loadTeam]);

  const toggleDeparting = async (member: TeamMemberStatus) => {
    if (role !== 'PI_LEAD') return;
    try {
      await apiFetch(`/api/team/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ departing: !member.departing }),
      });
      await loadTeam(true);
      onToast(
        `${member.name} marked as ${!member.departing ? 'departing' : 'active'}.`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Update failed', 'error');
    }
  };

  const selected = members.find((m) => m.id === selectedId) || null;

  const presenceColor = (st: 'ONLINE' | 'AWAY' | 'OFFLINE') => {
    if (st === 'ONLINE') return '#059669';
    if (st === 'AWAY') return '#D97706';
    return '#94A3B8';
  };

  const onlineCount = members.filter((m) => m.presence_status === 'ONLINE').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">Team Presence, Roles &amp; Work Tracker</h1>
          <p className="text-sm text-[#64748B]">
            See who is Online, Away, or Offline right now, their role, total work completed, and a live feed of who did what.
          </p>
        </div>
        <div className="text-xs font-mono tabular-nums text-[#475569]">
          <span className="font-semibold text-[#059669]">{onlineCount} online</span>
          <span className="mx-2 text-[#CBD5E1]">·</span>
          <span>{members.length} team members</span>
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
            onClick={() => void loadTeam(false)}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="h-72 rounded-2xl border border-[#E2E8F0] bg-white animate-pulse" />
      ) : (
        <>
          {/* Member Directory + Work Volume Ledger */}
          <section className="rounded-2xl border border-[#E2E8F0] bg-white overflow-x-auto">
            <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
              <h2 className="font-display text-sm font-bold text-[#0F172A]">
                Member status, role &amp; work completed
              </h2>
              <span className="text-xs text-[#64748B]">Select a member to view detailed contributions</span>
            </div>
            <table className="w-full text-left border-collapse min-w-[760px]">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-semibold text-[#64748B]">
                  <th className="py-3 px-4">Member</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4 text-right">Files</th>
                  <th className="py-3 px-4 text-right">Notes</th>
                  <th className="py-3 px-4 text-right">Claims</th>
                  <th className="py-3 px-4 text-right">Reviews</th>
                  <th className="py-3 px-4 text-right">Handovers</th>
                  <th className="py-3 px-4 text-right">Total work</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0] text-xs">
                {members.map((m) => {
                  const isSel = m.id === selectedId;
                  const ws = m.work_summary || {
                    sourcesUploaded: 0,
                    notesCreated: 0,
                    claimsWorked: 0,
                    reviewsCompleted: 0,
                    handoversCreated: 0,
                    totalActions: 0,
                  };
                  return (
                    <tr
                      key={m.id}
                      onClick={() => setSelectedId(m.id)}
                      className={`cursor-pointer transition-colors ${
                        isSel ? 'bg-[#2563EB]/6' : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <td className="py-3 px-4">
                        <p className="font-semibold text-[#0F172A]">{m.name}</p>
                        <p className="text-[11px] text-[#64748B]">{m.title}</p>
                      </td>
                      <td className="py-3 px-4">
                        <div className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: presenceColor(m.presence_status) }}
                            aria-hidden="true"
                          />
                          <span
                            style={{
                              color:
                                m.presence_status === 'ONLINE'
                                  ? '#059669'
                                  : m.presence_status === 'AWAY'
                                    ? '#B45309'
                                    : '#64748B',
                            }}
                          >
                            {m.presence_status}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-[#2563EB] font-semibold">
                        {m.role}
                        {m.departing && <span className="ml-2 text-[#DC2626]">· DEPARTING</span>}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#0F172A]">
                        {ws.sourcesUploaded}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#0F172A]">
                        {ws.notesCreated}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#0F172A]">
                        {ws.claimsWorked}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#0F172A]">
                        {ws.reviewsCompleted}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#0F172A]">
                        {ws.handoversCreated}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-[#0F172A]">
                        {ws.totalActions}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Selected Member Inspector + Work Breakdown */}
            <aside className="lg:col-span-5 rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-4">
              {selected ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-mono">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: presenceColor(selected.presence_status) }}
                          aria-hidden="true"
                        />
                        <span className="font-bold text-[#0F172A]">{selected.presence_status}</span>
                        <span className="text-[#64748B]">· {selected.role}</span>
                      </div>
                      <h2 className="font-display text-lg font-bold text-[#0F172A] mt-1">{selected.name}</h2>
                      <p className="text-xs text-[#64748B]">{selected.title} · {selected.email}</p>
                    </div>
                    {role === 'PI_LEAD' && (
                      <button
                        type="button"
                        onClick={() => toggleDeparting(selected)}
                        className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] px-3 py-1 text-[11px] font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
                      >
                        {selected.departing ? (
                          <>
                            <UserCheck className="h-3 w-3 text-[#059669]" />
                            <span>Mark active</span>
                          </>
                        ) : (
                          <>
                            <UserMinus className="h-3 w-3 text-[#DC2626]" />
                            <span>Mark departing</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  <dl className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 text-xs grid grid-cols-2 gap-3">
                    <div>
                      <dt className="text-[#64748B]">Current tab</dt>
                      <dd className="font-mono font-semibold text-[#0F172A] mt-0.5">
                        {selected.current_route || '#/overview'}
                        {selected.current_record_id ? ` · ${selected.current_record_id}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[#64748B]">Last active</dt>
                      <dd className="font-mono tabular-nums text-[#0F172A] mt-0.5">
                        {selected.last_seen_at ? new Date(selected.last_seen_at).toLocaleString() : 'Never'}
                      </dd>
                    </div>
                  </dl>

                  {selected.work_summary && (
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-xl border border-[#E2E8F0] p-2.5">
                        <FileText className="h-3.5 w-3.5 mx-auto text-[#2563EB]" aria-hidden="true" />
                        <p className="font-mono text-base font-bold tabular-nums text-[#0F172A] mt-1">
                          {selected.work_summary.sourcesUploaded}
                        </p>
                        <p className="text-[11px] text-[#64748B]">Files</p>
                      </div>
                      <div className="rounded-xl border border-[#E2E8F0] p-2.5">
                        <NotebookPen className="h-3.5 w-3.5 mx-auto text-[#7C3AED]" aria-hidden="true" />
                        <p className="font-mono text-base font-bold tabular-nums text-[#0F172A] mt-1">
                          {selected.work_summary.notesCreated}
                        </p>
                        <p className="text-[11px] text-[#64748B]">Notes</p>
                      </div>
                      <div className="rounded-xl border border-[#E2E8F0] p-2.5">
                        <Activity className="h-3.5 w-3.5 mx-auto text-[#059669]" aria-hidden="true" />
                        <p className="font-mono text-base font-bold tabular-nums text-[#0F172A] mt-1">
                          {selected.work_summary.totalActions}
                        </p>
                        <p className="text-[11px] text-[#64748B]">Total actions</p>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-[#0F172A]">
                      Recent work by {selected.name}
                    </h3>
                    {!selected.recent_actions || selected.recent_actions.length === 0 ? (
                      <p className="text-xs text-[#64748B]">No recent actions recorded yet.</p>
                    ) : (
                      <ul className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0]">
                        {selected.recent_actions.map((act) => (
                          <li key={act.id} className="px-3 py-2 flex items-center justify-between gap-2 text-xs">
                            <span className="font-mono font-semibold text-[#0F172A] truncate">
                              {act.action} · {act.target_type}:{act.target_id}
                            </span>
                            <span className="font-mono text-[10px] tabular-nums text-[#64748B] shrink-0">
                              {act.timestamp.slice(0, 16).replace('T', ' ')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {selected.open_records.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold text-[#0F172A]">
                        Assigned claims ({selected.open_records.length})
                      </h3>
                      <div className="space-y-2 max-h-48 overflow-y-auto">
                        {selected.open_records.map((rec) => (
                          <button
                            key={rec.id}
                            type="button"
                            onClick={() => onOpenRecord(rec.id)}
                            className="w-full text-left rounded-xl border border-[#E2E8F0] hover:border-[#2563EB] p-2.5 space-y-1 transition-colors"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs font-bold text-[#2563EB]">{rec.id}</span>
                              <EvidenceBadge state={rec.evidence_state} />
                            </div>
                            <p className="text-xs font-medium text-[#0F172A]">{rec.title}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-[#64748B]">Click a team member to view live status and work history.</p>
              )}
            </aside>

            {/* Right: Who Has Done What Feed + Workflow Swimlanes */}
            <div className="lg:col-span-7 space-y-6">
              <section className="rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
                <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
                  <h2 className="font-display text-sm font-bold text-[#0F172A]">
                    Who has done what (live team work feed)
                  </h2>
                  <span className="font-mono text-xs tabular-nums text-[#64748B]">
                    {teamActivity.length} events
                  </span>
                </div>
                {teamActivity.length === 0 ? (
                  <div className="p-6 text-xs text-[#64748B]">
                    No work recorded yet. Upload a file, create a note, or extract claims to populate this feed.
                  </div>
                ) : (
                  <ul className="divide-y divide-[#E2E8F0] max-h-80 overflow-y-auto">
                    {teamActivity.map((ev) => (
                      <li key={ev.id} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-[#0F172A]">
                              {ev.actor_name || ev.actor_email}
                            </span>
                            <span className="font-mono text-[10px] text-[#2563EB]">{ev.actor_role}</span>
                            <span className="text-[#94A3B8]">·</span>
                            <span className="font-mono font-semibold text-[#0F172A]">{ev.action}</span>
                          </div>
                          <p className="font-mono text-[11px] text-[#64748B] truncate mt-0.5">
                            {ev.target_type} · {ev.target_id}
                          </p>
                        </div>
                        <span className="font-mono text-[11px] tabular-nums text-[#64748B] shrink-0">
                          {ev.timestamp.replace('T', ' ').slice(0, 16)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Stage Swimlane Matrix */}
              <section className="rounded-2xl border border-[#E2E8F0] bg-white overflow-x-auto">
                <div className="px-5 py-3 border-b border-[#E2E8F0]">
                  <h2 className="font-display text-sm font-bold text-[#0F172A]">
                    Workflow ownership across stages 01–05
                  </h2>
                </div>
                <div className="min-w-[640px]">
                  <div className="grid grid-cols-12 border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] font-semibold text-[#64748B]">
                    <div className="col-span-2 px-3 py-2.5">Member</div>
                    {WORKFLOW_STAGES.map((st) => (
                      <div key={st.id} className="col-span-2 px-2.5 py-2.5 border-l border-[#E2E8F0]">
                        <span className="font-mono text-[#2563EB] mr-1">{st.num}</span>
                        <span>{st.name}</span>
                      </div>
                    ))}
                  </div>
                  <div className="divide-y divide-[#E2E8F0]">
                    {members.map((m) => (
                      <div
                        key={m.id}
                        onClick={() => setSelectedId(m.id)}
                        className={`grid grid-cols-12 cursor-pointer text-[11px] ${
                          m.id === selectedId ? 'bg-[#2563EB]/5' : 'hover:bg-[#F8FAFC]'
                        }`}
                      >
                        <div className="col-span-2 px-3 py-2.5 font-semibold text-[#0F172A] truncate">
                          {m.name}
                        </div>
                        {WORKFLOW_STAGES.map((st) => {
                          const laneItems = m.open_records.filter((r) => r.stage === st.id);
                          return (
                            <div
                              key={st.id}
                              className="col-span-2 px-2 py-2 border-l border-[#E2E8F0] flex flex-col gap-1"
                            >
                              {laneItems.map((rec) => (
                                <button
                                  key={rec.id}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenRecord(rec.id);
                                  }}
                                  className="text-left rounded-md border border-[#E2E8F0] bg-white hover:border-[#2563EB] px-1.5 py-1"
                                >
                                  <span className="font-mono font-bold text-[#2563EB]">{rec.id}</span>
                                </button>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
