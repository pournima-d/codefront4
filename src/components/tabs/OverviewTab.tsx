import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Compass,
  EyeOff,
  FolderPlus,
  HelpCircle,
  Radar,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { apiFetch, ApiError, setActiveProjectId } from '../../lib/api';
import {
  ROLE_TABS,
  WORKFLOW_STAGES,
  type ProjectInfo,
  type ProjectMemberInfo,
  type Role,
  type TabKey,
} from '../../types';

interface OverviewData {
  project: ProjectInfo;
  projects?: ProjectInfo[];
  metrics: {
    sourcesCount: number;
    notesCount?: number;
    recordsCount: number;
    supportedCount: number;
    approvedCount: number;
    needsReviewCount: number;
    openLoopsCount: number;
    highDebtCount: number;
    pendingRedactions: number;
  };
  stageCounts: Record<string, number>;
  evidenceCounts: Record<string, number>;
  publishedHandover: {
    id: string;
    version: number;
    title: string;
    published_at: string;
    extractor_mode: string;
  } | null;
  recentActivity?: Array<{
    id: number;
    timestamp: string;
    actor_email: string;
    actor_role: string;
    action: string;
    target_type: string;
    target_id: string;
  }>;
  teamMembers?: Array<{
    id: string;
    name: string;
    email: string;
    role: Role;
    title: string;
    departing: number;
  }>;
}

interface OverviewTabProps {
  role: Role;
  activeProjectId?: string;
  onNavigate: (tab: TabKey) => void;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

const ALL_ROLES: Role[] = ['PI_LEAD', 'RESEARCHER', 'REVIEWER', 'INCOMING_MEMBER', 'AUDITOR'];

export function OverviewTab({ role, activeProjectId, onNavigate, onToast }: OverviewTabProps) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [confirmDeleteProj, setConfirmDeleteProj] = useState(false);
  const [deletingProj, setDeletingProj] = useState(false);
  const [confirmResetProj, setConfirmResetProj] = useState(false);
  const [resettingProj, setResettingProj] = useState(false);

  // Project Members Management (PI_LEAD only)
  const [members, setMembers] = useState<ProjectMemberInfo[]>([]);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<Role>('RESEARCHER');
  const [memberBusy, setMemberBusy] = useState(false);

  const canCreateProject = role === 'PI_LEAD' || role === 'RESEARCHER';
  const allowedTabs = ROLE_TABS[role];

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<OverviewData>('/api/overview');
      setData(res);
      if (role === 'PI_LEAD' && res.project?.id) {
        try {
          const memRes = await apiFetch<{ members: ProjectMemberInfo[] }>(
            `/api/projects/${res.project.id}/members`
          );
          setMembers(memRes.members);
        } catch {
          // fallback silently if member endpoint unavailable
        }
      } else {
        setMembers([]);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load overview';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [role, onToast]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, activeProjectId]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingBusy) return;
    setCreatingBusy(true);
    try {
      const res = await apiFetch<{ project: ProjectInfo }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: newProjName,
          description: newProjDesc,
        }),
      });
      setActiveProjectId(res.project.id);
      setCreatingProject(false);
      setNewProjName('');
      setNewProjDesc('');
      window.dispatchEvent(new CustomEvent('baton:projects-changed', { detail: res.project.id }));
      onToast(`Created continuity project "${res.project.name}".`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to create project', 'error');
    } finally {
      setCreatingBusy(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!data || deletingProj || !canCreateProject) return;
    setDeletingProj(true);
    try {
      const res = await apiFetch<{ ok: boolean; fallbackProjectId: string }>(
        `/api/projects/${data.project.id}`,
        { method: 'DELETE' }
      );
      setConfirmDeleteProj(false);
      setActiveProjectId(res.fallbackProjectId);
      window.dispatchEvent(new CustomEvent('baton:projects-changed', { detail: res.fallbackProjectId }));
      onToast(`Deleted project "${data.project.name}".`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete project', 'error');
    } finally {
      setDeletingProj(false);
    }
  };

  const handleResetProject = async () => {
    if (!data || resettingProj || !canCreateProject) return;
    setResettingProj(true);
    try {
      const res = await apiFetch<{ ok: boolean; clearedRecords: number; clearedFiles: number }>(
        `/api/projects/${data.project.id}/reset`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      setConfirmResetProj(false);
      window.dispatchEvent(new CustomEvent('baton:projects-changed', { detail: data.project.id }));
      onToast(
        `Workspace cleared (${res.clearedFiles} files and ${res.clearedRecords} records removed).`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to reset workspace', 'error');
    } finally {
      setResettingProj(false);
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data || memberBusy || !memberEmail.trim()) return;
    setMemberBusy(true);
    try {
      await apiFetch(`/api/projects/${data.project.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email: memberEmail.trim(), role: memberRole }),
      });
      setMemberEmail('');
      await loadOverview();
      onToast('Collaborator added to project.', 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to add collaborator', 'error');
    } finally {
      setMemberBusy(false);
    }
  };

  const handleUpdateMemberRole = async (userId: string, nextRole: Role) => {
    if (!data || memberBusy) return;
    setMemberBusy(true);
    try {
      await apiFetch(`/api/projects/${data.project.id}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      });
      await loadOverview();
      window.dispatchEvent(new CustomEvent('baton:projects-changed', { detail: data.project.id }));
      onToast(`Updated project role to ${nextRole}.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to update role', 'error');
    } finally {
      setMemberBusy(false);
    }
  };

  const handleRemoveMember = async (userId: string, name: string) => {
    if (!data || memberBusy) return;
    setMemberBusy(true);
    try {
      await apiFetch(`/api/projects/${data.project.id}/members/${userId}`, {
        method: 'DELETE',
      });
      await loadOverview();
      onToast(`Removed ${name} from project.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to remove member', 'error');
    } finally {
      setMemberBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-44 rounded-2xl bg-white border border-[#E2E8F0]" />
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-white border border-[#E2E8F0]" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-2xl border border-[#DC2626]/30 bg-white p-8 text-center space-y-3">
        <p className="text-sm font-medium text-[#DC2626]">
          {loadError || 'Unable to load project overview.'}
        </p>
        <button
          type="button"
          onClick={() => void loadOverview()}
          className="inline-flex items-center gap-2 rounded-full bg-[#0F172A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E293B]"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Retry</span>
        </button>
      </div>
    );
  }

  const stageNavMap: Record<string, TabKey> = {
    '01': role === 'REVIEWER' || role === 'AUDITOR' ? 'records' : 'sources',
    '02': 'records',
    '03': 'records',
    '04': role === 'RESEARCHER' ? 'radar' : role === 'AUDITOR' ? 'audit' : 'review',
    '05': 'handover',
  };

  const evidenceOrder = [
    { key: 'SUPPORTED', label: 'Supported', color: '#059669' },
    { key: 'NEEDS_REVIEW', label: 'Needs review', color: '#2563EB' },
    { key: 'NOT_ESTABLISHED', label: 'Not established / Weak', color: '#D97706' },
    { key: 'CONFLICTING', label: 'Conflicting', color: '#D97706' },
    { key: 'STALE', label: 'Stale', color: '#64748B' },
    { key: 'UNSUPPORTED', label: 'Unsupported', color: '#DC2626' },
  ];

  return (
    <div className="space-y-8">
      {/* Asymmetric Project Hero */}
      <section className="rounded-2xl border border-[#E2E8F0] bg-white p-7 lg:p-9 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        <div className="lg:col-span-8 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#64748B]">
            <span className="font-mono">{data.project.slug}</span>
            <span aria-hidden="true">·</span>
            <span>Active continuity dossier</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono font-semibold text-[#2563EB]">Role: {role}</span>
          </div>
          <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0F172A] text-balance">
            {data.project.name}
          </h1>
          <p className="text-sm sm:text-base text-[#475569] max-w-2xl leading-relaxed">
            {data.project.description}
          </p>
          <div className="pt-2 flex flex-wrap gap-3">
            {allowedTabs.includes('records') || allowedTabs.includes('review') ? (
              <button
                type="button"
                onClick={() => onNavigate(role === 'REVIEWER' ? 'review' : 'records')}
                className="inline-flex items-center gap-2 rounded-full bg-[#2563EB] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1D4ED8] transition-colors"
              >
                <span>{role === 'REVIEWER' ? 'Open review queue' : 'Inspect records'}</span>
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onNavigate('handover')}
              className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-5 py-2.5 text-sm font-semibold text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
            >
              <Compass className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
              <span>View handover v{data.publishedHandover?.version ?? 1}</span>
            </button>
            {canCreateProject && (
              <button
                type="button"
                onClick={() => setCreatingProject((v) => !v)}
                className="inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-white px-4 py-2.5 text-sm font-semibold text-[#0F172A] hover:bg-[#F8FAFC] transition-colors"
              >
                {creatingProject ? <X className="h-4 w-4" aria-hidden="true" /> : <FolderPlus className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />}
                <span>{creatingProject ? 'Close project form' : 'New continuity project'}</span>
              </button>
            )}
            {role === 'PI_LEAD' && (data.metrics.sourcesCount > 0 || data.metrics.recordsCount > 0 || (data.metrics.notesCount ?? 0) > 0) && (
              confirmResetProj ? (
                <div className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={resettingProj}
                    onClick={() => void handleResetProject()}
                    className="rounded-full bg-[#DC2626] px-4 py-2 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                  >
                    {resettingProj ? 'Clearing…' : 'Confirm clear all data'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmResetProj(false)}
                    className="rounded-full border border-[#E2E8F0] bg-white px-3 py-2 text-xs text-[#64748B]"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmResetProj(true)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#D97706]/40 bg-white px-4 py-2.5 text-sm font-semibold text-[#B45309] hover:bg-[#FFFBEB] transition-colors"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  <span>Reset workspace fresh</span>
                </button>
              )
            )}
            {role === 'PI_LEAD' && (data.projects?.length ?? 0) > 1 && (
              confirmDeleteProj ? (
                <div className="inline-flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={deletingProj}
                    onClick={() => void handleDeleteProject()}
                    className="rounded-full bg-[#DC2626] px-4 py-2 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                  >
                    {deletingProj ? 'Deleting…' : 'Confirm delete project'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteProj(false)}
                    className="rounded-full border border-[#E2E8F0] bg-white px-3 py-2 text-xs text-[#64748B]"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteProj(true)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[#DC2626]/30 bg-white px-4 py-2.5 text-sm font-semibold text-[#DC2626] hover:bg-[#DC2626]/5 transition-colors"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span>Delete project</span>
                </button>
              )
            )}
          </div>
        </div>

        <div className="lg:col-span-4 border-t lg:border-t-0 lg:border-l border-[#E2E8F0] pt-6 lg:pt-0 lg:pl-8 space-y-4">
          <div>
            <p className="text-xs font-medium text-[#64748B]">Latest published brief</p>
            <p className="text-base font-bold text-[#0F172A] mt-0.5">
              {data.publishedHandover ? `Version ${data.publishedHandover.version}` : 'Draft only'}
            </p>
            {data.publishedHandover && (
              <p className="text-xs text-[#64748B] font-mono tabular-nums mt-0.5">
                {data.publishedHandover.published_at.slice(0, 10)} · {data.publishedHandover.extractor_mode}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-[#E2E8F0]">
            <div>
              <p className="text-xs text-[#64748B]">Files</p>
              <p className="font-mono text-2xl font-bold tabular-nums text-[#0F172A]">
                {data.metrics.sourcesCount}
              </p>
            </div>
            <div>
              <p className="text-xs text-[#64748B]">Notes</p>
              <p className="font-mono text-2xl font-bold tabular-nums text-[#0F172A]">
                {data.metrics.notesCount ?? 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-[#64748B]">Claims</p>
              <p className="font-mono text-2xl font-bold tabular-nums text-[#0F172A]">
                {data.metrics.recordsCount}
              </p>
            </div>
            <div>
              <p className="text-xs text-[#64748B]">Open loops</p>
              <p
                className={`font-mono text-2xl font-bold tabular-nums ${
                  data.metrics.openLoopsCount > 0 ? 'text-[#D97706]' : 'text-[#059669]'
                }`}
              >
                {data.metrics.openLoopsCount}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Evaluator & Round 3 Quick Discovery Strip */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {allowedTabs.includes('radar') && (
          <button
            type="button"
            onClick={() => onNavigate('radar')}
            className="text-left rounded-2xl border border-[#E2E8F0] bg-white hover:border-[#DC2626]/50 p-5 space-y-1.5 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#DC2626]">
                <Radar className="h-4 w-4" aria-hidden="true" />
                <span>Knowledge-Debt Radar</span>
              </span>
              <span className="font-mono text-xs font-bold text-[#DC2626]">
                {data.metrics.highDebtCount} high
              </span>
            </div>
            <p className="text-xs text-[#475569]">
              Inspect departing-owner exposure, unverified claims, filter risks by category, and resolve or reopen findings.
            </p>
          </button>
        )}

        {allowedTabs.includes('coldstart') && (
          <button
            type="button"
            onClick={() => onNavigate('coldstart')}
            className="text-left rounded-2xl border border-[#E2E8F0] bg-white hover:border-[#2563EB]/50 p-5 space-y-1.5 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#2563EB]">
                <HelpCircle className="h-4 w-4" aria-hidden="true" />
                <span>Cold-Start Handover Test</span>
              </span>
              <span className="font-mono text-xs font-semibold text-[#2563EB]">10 categories</span>
            </div>
            <p className="text-xs text-[#475569]">
              Verify whether a published handover answers key continuity questions without measuring personal competence.
            </p>
          </button>
        )}

        {allowedTabs.includes('redaction') && (
          <button
            type="button"
            onClick={() => onNavigate('redaction')}
            className="text-left rounded-2xl border border-[#E2E8F0] bg-white hover:border-[#7C3AED]/50 p-5 space-y-1.5 transition-colors"
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#7C3AED]">
                <EyeOff className="h-4 w-4" aria-hidden="true" />
                <span>Sensitive Redaction Queue</span>
              </span>
              <span className="font-mono text-xs font-bold text-[#7C3AED]">
                {data.metrics.pendingRedactions} pending
              </span>
            </div>
            <p className="text-xs text-[#475569]">
              Review confidence-scored PII/secret overlays, configure project sensitive patterns, and mask shared outputs.
            </p>
          </button>
        )}
      </section>

      {/* Clean-Start Onboarding Card when workspace has no files/notes/records yet */}
      {data.metrics.sourcesCount === 0 && (data.metrics.notesCount ?? 0) === 0 && data.metrics.recordsCount === 0 && (
        <section className="rounded-2xl border border-[#2563EB]/25 bg-white p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-bold text-[#0F172A]">
                Ready for your own research data
              </h2>
              <p className="text-xs text-[#64748B]">
                This workspace starts clean. Add your own files, notes, or collaborators below.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => onNavigate('sources')}
              className="text-left rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#2563EB] p-4 space-y-1 transition-colors"
            >
              <p className="text-xs font-mono font-semibold text-[#2563EB]">Step 01</p>
              <p className="text-sm font-bold text-[#0F172A]">Upload Private or Public Files</p>
              <p className="text-xs text-[#64748B]">
                Choose whether each file is Private (only you) or Public (shared) before uploading PDF, MD, TXT, CSV, or JSON.
              </p>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('notes')}
              className="text-left rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#2563EB] p-4 space-y-1 transition-colors"
            >
              <p className="text-xs font-mono font-semibold text-[#7C3AED]">Step 02</p>
              <p className="text-sm font-bold text-[#0F172A]">Write in Notes Studio</p>
              <p className="text-xs text-[#64748B]">
                Use Word-style fonts, sizes, headings, tables, highlights, checklists, and export to .doc.
              </p>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('team')}
              className="text-left rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#2563EB] p-4 space-y-1 transition-colors"
            >
              <p className="text-xs font-mono font-semibold text-[#059669]">Step 03</p>
              <p className="text-sm font-bold text-[#0F172A]">Track Team Online Status &amp; Work</p>
              <p className="text-xs text-[#64748B]">
                See who is online or offline, inspect member roles, and view who completed each action.
              </p>
            </button>
          </div>
        </section>
      )}

      {/* Create New Continuity Project Drawer */}
      {creatingProject && canCreateProject && (
        <form
          onSubmit={handleCreateProject}
          className="rounded-2xl border border-[#2563EB]/30 bg-white p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-bold text-[#0F172A]">Create New Continuity Project</h2>
              <p className="text-xs text-[#64748B]">
                Start an isolated continuity workspace for another lab transition, thesis cohort, or instrument line.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="new-proj-name" className="block text-xs font-medium text-[#0F172A] mb-1">Project name</label>
              <input
                id="new-proj-name"
                type="text"
                required
                value={newProjName}
                onChange={(e) => setNewProjName(e.target.value)}
                placeholder="e.g., Cryo-EM Single Particle Pipeline Transition"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2 text-sm text-[#0F172A]"
              />
            </div>
            <div>
              <label htmlFor="new-proj-desc" className="block text-xs font-medium text-[#0F172A] mb-1">Research scope &amp; handover goal</label>
              <input
                id="new-proj-desc"
                type="text"
                required
                value={newProjDesc}
                onChange={(e) => setNewProjDesc(e.target.value)}
                placeholder="e.g., Transfer sample prep protocols, calibration logs, and open anomalies"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2 text-sm text-[#0F172A]"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreatingProject(false)}
              className="rounded-full border border-[#E2E8F0] px-4 py-1.5 text-xs font-semibold text-[#0F172A]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creatingBusy}
              className="rounded-full bg-[#2563EB] px-5 py-1.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              {creatingBusy ? 'Creating…' : 'Create & switch workspace'}
            </button>
          </div>
        </form>
      )}

      {/* 5-Stage Workflow Pipeline Tiles */}
      <section aria-labelledby="pipeline-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="pipeline-heading" className="font-display text-lg font-bold text-[#0F172A]">
            Five-stage continuity workflow
          </h2>
          <span className="text-xs text-[#64748B]">Click a stage to jump directly to its workspace</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {WORKFLOW_STAGES.map((st) => {
            const count = data.stageCounts[st.id] ?? 0;
            const isCurrent = data.project.stage_current === st.id;
            const targetTab = stageNavMap[st.id];
            const canNav = allowedTabs.includes(targetTab);
            return (
              <button
                key={st.id}
                type="button"
                disabled={!canNav}
                onClick={() => canNav && onNavigate(targetTab)}
                className={`text-left rounded-xl border p-4 transition-colors ${
                  isCurrent
                    ? 'border-[#2563EB] bg-white'
                    : 'border-[#E2E8F0] bg-white hover:border-[#94A3B8]'
                } disabled:opacity-60`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-semibold tabular-nums text-[#2563EB]">
                    {st.num}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-[#64748B]">{count} items</span>
                </div>
                <p className="font-display text-base font-bold text-[#0F172A] mt-2">{st.name}</p>
                <p className="text-xs text-[#64748B] mt-1 leading-relaxed">{st.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Bottom 3-column Analytical Strip */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="rounded-xl border border-[#E2E8F0] bg-white p-6 space-y-4">
          <h3 className="font-display text-base font-bold text-[#0F172A]">Evidence verification ledger</h3>
          <div className="space-y-2.5">
            {evidenceOrder.map((ev) => {
              const count = data.evidenceCounts[ev.key] || 0;
              const pct = data.metrics.recordsCount > 0 ? Math.round((count / data.metrics.recordsCount) * 100) : 0;
              return (
                <div key={ev.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-[#0F172A]">{ev.label}</span>
                    <span className="font-mono tabular-nums text-[#64748B]">{count}</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-[#F1F5F9] overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: ev.color }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-[#E2E8F0] bg-white p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-2">
            <h3 className="font-display text-base font-bold text-[#0F172A]">Human approval axis</h3>
            <p className="text-xs text-[#64748B]">
              Approval is separate from evidence state and bound to one exact record version.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div>
              <p className="text-xs text-[#64748B]">Approved</p>
              <p className="font-mono text-3xl font-bold tabular-nums text-[#059669]">
                {data.metrics.approvedCount}
              </p>
            </div>
            <div>
              <p className="text-xs text-[#64748B]">Pending / Revision</p>
              <p className="font-mono text-3xl font-bold tabular-nums text-[#D97706]">
                {data.metrics.needsReviewCount}
              </p>
            </div>
          </div>
          {role === 'PI_LEAD' || role === 'REVIEWER' ? (
            <button
              type="button"
              onClick={() => onNavigate('review')}
              className="text-left text-xs font-semibold text-[#2563EB] hover:underline"
            >
              Go to review decision queue →
            </button>
          ) : (
            <span className="text-xs text-[#64748B]">Read-only summary for your role</span>
          )}
        </div>

        <div className="rounded-xl border border-[#E2E8F0] bg-white p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-2">
            <h3 className="font-display text-base font-bold text-[#0F172A]">Continuity safeguards</h3>
            <p className="text-xs text-[#64748B]">
              Priority follow-ups from Knowledge-Debt Radar and unconfirmed sensitive-content overlays.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div>
              <p className="text-xs text-[#64748B]">High-priority debt</p>
              <p className="font-mono text-3xl font-bold tabular-nums text-[#DC2626]">
                {data.metrics.highDebtCount}
              </p>
            </div>
            <div>
              <p className="text-xs text-[#64748B]">Pending redactions</p>
              <p className="font-mono text-3xl font-bold tabular-nums text-[#7C3AED]">
                {data.metrics.pendingRedactions}
              </p>
            </div>
          </div>
          {(role === 'PI_LEAD' || role === 'RESEARCHER') && (
            <button
              type="button"
              onClick={() => onNavigate('radar')}
              className="text-left text-xs font-semibold text-[#2563EB] hover:underline"
            >
              Triage high-priority knowledge debt →
            </button>
          )}
        </div>
      </section>

      {/* PI_LEAD Project Member & Role Management */}
      {role === 'PI_LEAD' && (
        <section className="rounded-2xl border border-[#E2E8F0] bg-white p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-xl bg-[#EFF6FF] text-[#2563EB] flex items-center justify-center">
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 className="font-display text-base font-bold text-[#0F172A]">
                  Project Members &amp; Role Assignment
                </h2>
                <p className="text-xs text-[#64748B]">
                  Add existing registered collaborators to this project or change their project-scoped RBAC role. Role changes take effect cleanly per project.
                </p>
              </div>
            </div>
          </div>

          <form onSubmit={handleAddMember} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-4">
            <div className="sm:col-span-6">
              <label htmlFor="add-member-email" className="block text-xs font-semibold text-[#0F172A] mb-1">
                Collaborator email
              </label>
              <input
                id="add-member-email"
                type="email"
                required
                value={memberEmail}
                onChange={(e) => setMemberEmail(e.target.value)}
                placeholder="collaborator@baton-lab.edu"
                className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-xs text-[#0F172A]"
              />
            </div>
            <div className="sm:col-span-4">
              <label htmlFor="add-member-role" className="block text-xs font-semibold text-[#0F172A] mb-1">
                Project role
              </label>
              <select
                id="add-member-role"
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value as Role)}
                className="w-full rounded-xl border border-[#E2E8F0] bg-white px-3 py-2 text-xs text-[#0F172A]"
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={memberBusy}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-full bg-[#2563EB] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
              >
                <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Add</span>
              </button>
            </div>
          </form>

          {members.length > 0 && (
            <div className="divide-y divide-[#E2E8F0] border border-[#E2E8F0] rounded-xl overflow-hidden">
              {members.map((m) => (
                <div key={m.user_id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 bg-white text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#0F172A]">{m.name}</span>
                      {m.departing && (
                        <span className="rounded-full bg-[#FEF3C7] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#B45309]">
                          DEPARTING
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#64748B] truncate">
                      {m.email} · {m.title}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Project role for ${m.name}`}
                      disabled={memberBusy}
                      value={m.role}
                      onChange={(e) => void handleUpdateMemberRole(m.user_id, e.target.value as Role)}
                      className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1 text-xs font-mono font-semibold text-[#0F172A]"
                    >
                      {ALL_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={memberBusy}
                      onClick={() => void handleRemoveMember(m.user_id, m.name)}
                      aria-label={`Remove ${m.name} from project`}
                      title="Remove from project"
                      className="rounded-full border border-[#E2E8F0] p-1.5 text-[#64748B] hover:border-[#DC2626]/40 hover:text-[#DC2626] disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Recent Project Activity + Team Roster */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-[#E2E8F0] bg-white p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-bold text-[#0F172A]">Recent continuity activity</h3>
            {(role === 'PI_LEAD' || role === 'AUDITOR') && (
              <button
                type="button"
                onClick={() => onNavigate('audit')}
                className="text-xs font-semibold text-[#2563EB] hover:underline"
              >
                Full audit log →
              </button>
            )}
          </div>
          {!data.recentActivity || data.recentActivity.length === 0 ? (
            <p className="text-xs text-[#64748B]">No recent actions recorded yet.</p>
          ) : (
            <ul className="divide-y divide-[#E2E8F0]">
              {data.recentActivity.map((act) => (
                <li key={act.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <span className="font-mono font-semibold text-[#0F172A]">{act.action}</span>
                    <span className="text-[#64748B]"> · {act.target_type} </span>
                    <span className="font-mono text-[#2563EB]">{act.target_id}</span>
                    <p className="text-[11px] text-[#64748B] truncate">
                      {act.actor_email} ({act.actor_role})
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-[#64748B] tabular-nums shrink-0">
                    {act.timestamp.slice(0, 16).replace('T', ' ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-[#E2E8F0] bg-white p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-bold text-[#0F172A] flex items-center gap-2">
              <Users className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
              <span>Team roster &amp; transition roles</span>
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('team')}
              className="text-xs font-semibold text-[#2563EB] hover:underline"
            >
              Presence &amp; swimlanes →
            </button>
          </div>
          {!data.teamMembers || data.teamMembers.length === 0 ? (
            <p className="text-xs text-[#64748B]">No members registered.</p>
          ) : (
            <ul className="divide-y divide-[#E2E8F0]">
              {data.teamMembers.map((m) => (
                <li key={m.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[#0F172A]">{m.name}</span>
                      {m.departing === 1 && (
                        <span className="font-mono text-[10px] font-semibold text-[#D97706]">DEPARTING</span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#64748B] truncate">{m.title}</p>
                  </div>
                  <span className="font-mono text-[11px] font-semibold text-[#2563EB] shrink-0">{m.role}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
