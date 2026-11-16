import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Filter,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import type { RadarFinding, Role } from '../../types';
import { EvidenceBadge } from '../StatusChip';

interface AssignableUser {
  id: string;
  name: string;
  role: string;
  departing: number;
}

interface RadarTabProps {
  role?: Role;
  onOpenRecord: (recordId: string) => void;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function RadarTab({ role, onOpenRecord, onToast }: RadarTabProps) {
  const [findings, setFindings] = useState<RadarFinding[]>([]);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmRescan, setConfirmRescan] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [selectedOwner, setSelectedOwner] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'OPEN' | 'RESOLVED'>('ALL');
  const [bandFilter, setBandFilter] = useState<'ALL' | 'HIGH' | 'MEDIUM' | 'LOW'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [ownerFilter, setOwnerFilter] = useState<string>('ALL');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');

  const canDelete = !role || role === 'PI_LEAD' || role === 'RESEARCHER';

  const loadRadar = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{
        findings: RadarFinding[];
        assignableUsers: AssignableUser[];
        lastScannedAt?: string | null;
      }>('/api/radar');
      setFindings(res.findings);
      setUsers(res.assignableUsers);
      setLastScannedAt(res.lastScannedAt ?? null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load Knowledge-Debt Radar';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void loadRadar();
  }, [loadRadar]);

  const executeRescan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await apiFetch<{ count: number }>('/api/radar/scan', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setConfirmRescan(false);
      await loadRadar();
      onToast(`Knowledge-Debt Radar scanned ${res.count} continuity risks.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Scan failed', 'error');
    } finally {
      setScanning(false);
    }
  };

  const handleRescanClick = () => {
    if (findings.some((f) => f.resolved) && !confirmRescan) {
      setConfirmRescan(true);
      return;
    }
    void executeRescan();
  };

  const handleAssignOwner = async (recordId: string) => {
    const newOwner = selectedOwner[recordId];
    if (!newOwner) {
      onToast('Select an owner first.', 'info');
      return;
    }
    setAssigningId(recordId);
    try {
      await apiFetch(`/api/records/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ owner_name: newOwner }),
      });
      await loadRadar();
      onToast(`Assigned ${recordId} to ${newOwner}. Priority points recalculated.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Owner assignment failed', 'error');
    } finally {
      setAssigningId(null);
    }
  };

  const handleToggleResolve = async (finding: RadarFinding) => {
    if (resolvingId) return;
    setResolvingId(finding.id);
    const nextResolved = !finding.resolved;
    try {
      await apiFetch(`/api/radar/findings/${finding.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolved: nextResolved }),
      });
      await loadRadar();
      onToast(
        nextResolved
          ? `Marked ${finding.record_id} finding as resolved.`
          : `Reopened ${finding.record_id} finding for triage.`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to update finding status', 'error');
    } finally {
      setResolvingId(null);
    }
  };

  const handleDeleteRecord = async (recordId: string) => {
    if (deletingId || !canDelete) return;
    setDeletingId(recordId);
    try {
      await apiFetch(`/api/records/${recordId}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      await loadRadar();
      onToast(`Deleted record ${recordId}.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete record', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const bandStyle = (band: 'HIGH' | 'MEDIUM' | 'LOW') => {
    if (band === 'HIGH') return { bg: 'bg-[#DC2626]/10', text: 'text-[#DC2626]', bar: '#DC2626' };
    if (band === 'MEDIUM') return { bg: 'bg-[#D97706]/12', text: 'text-[#B45309]', bar: '#D97706' };
    return { bg: 'bg-[#2563EB]/10', text: 'text-[#2563EB]', bar: '#2563EB' };
  };

  const categories = useMemo(
    () => Array.from(new Set(findings.map((f) => f.risk_category || 'GENERAL_CONTINUITY_RISK'))),
    [findings]
  );
  const owners = useMemo(
    () => Array.from(new Set(findings.map((f) => f.owner_name || f.record?.owner_name || 'UNASSIGNED'))),
    [findings]
  );
  const recordTypes = useMemo(
    () => Array.from(new Set(findings.map((f) => f.record?.type).filter((x): x is string => Boolean(x)))),
    [findings]
  );

  const filteredFindings = useMemo(() => {
    return findings.filter((f) => {
      if (statusFilter === 'OPEN' && f.resolved) return false;
      if (statusFilter === 'RESOLVED' && !f.resolved) return false;
      if (bandFilter !== 'ALL' && f.band !== bandFilter) return false;
      const cat = f.risk_category || 'GENERAL_CONTINUITY_RISK';
      if (categoryFilter !== 'ALL' && cat !== categoryFilter) return false;
      const own = f.owner_name || f.record?.owner_name || 'UNASSIGNED';
      if (ownerFilter !== 'ALL' && own !== ownerFilter) return false;
      if (typeFilter !== 'ALL' && f.record?.type !== typeFilter) return false;
      return true;
    });
  }, [findings, statusFilter, bandFilter, categoryFilter, ownerFilter, typeFilter]);

  const openFindings = findings.filter((f) => !f.resolved);
  const openHighCount = openFindings.filter((f) => f.band === 'HIGH').length;
  const overallExposure =
    openHighCount >= 2 ? 'Elevated exposure' : openHighCount === 1 ? 'Moderate exposure' : 'Controlled';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-2xl font-bold text-[#0F172A]">Knowledge-Debt Radar</h1>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                openHighCount > 0 ? 'bg-[#DC2626]/10 text-[#DC2626]' : 'bg-[#059669]/10 text-[#059669]'
              }`}
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{overallExposure}</span>
            </span>
          </div>
          <p className="text-sm text-[#64748B]">
            Deterministic follow-up priority index (not a truth score): Departing owner +40 · Unassigned/UNKNOWN +25 · Weak/stale/conflicting evidence +20 · Open gap/risk/recurring problem +15 · Stale draft +15 · Unverified +10.
          </p>
          {lastScannedAt && (
            <p className="text-xs font-mono text-[#64748B]">
              Last scanned: {lastScannedAt.slice(0, 19).replace('T', ' ')} UTC
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {confirmRescan ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-[#D97706]/40 bg-[#FFFBEB] px-3 py-1.5">
              <span className="text-xs font-medium text-[#B45309]">
                Re-scan active records?
              </span>
              <button
                type="button"
                disabled={scanning}
                onClick={() => void executeRescan()}
                className="rounded-full bg-[#0F172A] px-3 py-1 text-xs font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
              >
                {scanning ? 'Scanning…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRescan(false)}
                className="text-xs font-medium text-[#64748B] hover:text-[#0F172A]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleRescanClick}
              disabled={scanning}
              className="inline-flex items-center gap-2 rounded-full bg-[#0F172A] px-5 py-2 text-xs font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{scanning ? 'Scanning…' : 'Rescan radar'}</span>
            </button>
          )}
        </div>
      </div>

      {loadError && (
        <div role="alert" className="rounded-2xl border border-[#DC2626]/30 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium text-[#DC2626]">{loadError}</p>
          <button
            type="button"
            onClick={() => void loadRadar()}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-4 py-1.5 text-xs font-semibold text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Band Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="rounded-xl border border-[#E2E8F0] bg-white px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748B]">Open High (≥60 pts)</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-[#DC2626] mt-0.5">
              {openHighCount}
            </p>
          </div>
          <span className="text-xs font-semibold text-[#DC2626]">Immediate</span>
        </div>
        <div className="rounded-xl border border-[#E2E8F0] bg-white px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748B]">Open Medium (30–59)</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-[#D97706] mt-0.5">
              {openFindings.filter((f) => f.band === 'MEDIUM').length}
            </p>
          </div>
          <span className="text-xs font-semibold text-[#B45309]">Schedule</span>
        </div>
        <div className="rounded-xl border border-[#E2E8F0] bg-white px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748B]">Open Low (&lt;30)</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-[#2563EB] mt-0.5">
              {openFindings.filter((f) => f.band === 'LOW').length}
            </p>
          </div>
          <span className="text-xs font-semibold text-[#2563EB]">Monitor</span>
        </div>
        <div className="rounded-xl border border-[#E2E8F0] bg-white px-5 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748B]">Resolved findings</p>
            <p className="font-mono text-2xl font-bold tabular-nums text-[#059669] mt-0.5">
              {findings.filter((f) => f.resolved).length}
            </p>
          </div>
          <span className="text-xs font-semibold text-[#059669]">Triaged</span>
        </div>
      </div>

      {/* Filters Toolbar */}
      {findings.length > 0 && (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white p-4 flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold text-[#0F172A]">
            <Filter className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
            <span>Filters:</span>
          </span>

          <div className="inline-flex rounded-full border border-[#E2E8F0] bg-[#F8FAFC] p-0.5">
            {(['ALL', 'OPEN', 'RESOLVED'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-full px-3 py-1 font-semibold transition-colors ${
                  statusFilter === s ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
                }`}
              >
                {s === 'ALL' ? `All (${findings.length})` : s === 'OPEN' ? `Open (${openFindings.length})` : `Resolved (${findings.length - openFindings.length})`}
              </button>
            ))}
          </div>

          <select
            aria-label="Filter by severity band"
            value={bandFilter}
            onChange={(e) => setBandFilter(e.target.value as 'ALL' | 'HIGH' | 'MEDIUM' | 'LOW')}
            className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
          >
            <option value="ALL">All bands</option>
            <option value="HIGH">HIGH band</option>
            <option value="MEDIUM">MEDIUM band</option>
            <option value="LOW">LOW band</option>
          </select>

          <select
            aria-label="Filter by risk category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
          >
            <option value="ALL">All risk categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by owner"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
          >
            <option value="ALL">All owners</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by record type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
          >
            <option value="ALL">All record types</option>
            {recordTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Ranked Heat List */}
      {loading ? (
        <div className="h-56 rounded-2xl border border-[#E2E8F0] bg-white animate-pulse" />
      ) : findings.length === 0 ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white p-8 text-center text-sm text-[#64748B]">
          No knowledge-debt risks detected. Click &ldquo;Rescan radar&rdquo; after adding records.
        </div>
      ) : filteredFindings.length === 0 ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white p-8 text-center text-sm text-[#64748B]">
          No findings match the active filter combination.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredFindings.map((f) => {
            const st = bandStyle(f.band);
            const isExpanded = expandedId === f.id;
            return (
              <article
                key={f.id}
                className={`rounded-2xl border bg-white p-5 space-y-4 ${
                  f.resolved ? 'border-[#059669]/30 bg-[#F0FDF4]/30' : 'border-[#E2E8F0]'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
                  <div className="flex items-start gap-4 flex-1">
                    {/* Follow-up Priority Meter */}
                    <div className="w-28 shrink-0 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-center space-y-1">
                      <span className="block text-[10px] font-medium text-[#64748B]">Follow-up priority</span>
                      <span className={`block font-mono text-2xl font-extrabold tabular-nums ${st.text}`}>
                        {f.priority_points}
                      </span>
                      <div className="h-1.5 w-full rounded-full bg-[#E2E8F0] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(100, f.priority_points)}%`, backgroundColor: st.bar }}
                        />
                      </div>
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${st.bg} ${st.text}`}>
                        {f.band}
                      </span>
                    </div>

                    <div className="space-y-2 flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => onOpenRecord(f.record_id)}
                          className="inline-flex items-center gap-1 font-mono font-bold text-[#2563EB] hover:underline text-left"
                        >
                          <span>{f.record_id}</span>
                          <span className="text-[#64748B]">·</span>
                          <span className="font-sans font-semibold text-[#0F172A]">{f.record?.title}</span>
                        </button>
                        {f.record && <EvidenceBadge state={f.record.evidence_state} />}
                        {f.risk_category && (
                          <span className="rounded bg-[#F1F5F9] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#475569]">
                            {f.risk_category}
                          </span>
                        )}
                        {f.resolved && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#059669]/12 px-2.5 py-0.5 text-[10px] font-bold text-[#059669]">
                            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                            <span>RESOLVED</span>
                          </span>
                        )}
                      </div>

                      <ul className="space-y-0.5 text-xs text-[#475569]">
                        {f.reasons.map((reason, idx) => (
                          <li key={idx}>• {reason}</li>
                        ))}
                      </ul>

                      <div className="text-xs text-[#64748B] space-y-1 pt-1">
                        <p>
                          <span className="font-medium text-[#0F172A]">Suggested follow-up: </span>
                          <span>{f.suggested_followup}</span>
                        </p>
                        <p className="font-mono text-[11px] text-[#475569]">
                          <span className="font-sans font-medium text-[#0F172A]">Owner: </span>
                          {f.owner_name || f.record?.owner_name || 'UNASSIGNED'}
                          <span className="mx-1.5 text-[#CBD5E1]">|</span>
                          <span className="font-sans font-medium text-[#0F172A]">Source: </span>
                          {f.record?.source_file} ({f.record?.locator})
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Inline Actions */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <select
                        aria-label={`Assign owner for ${f.record_id}`}
                        value={selectedOwner[f.record_id] ?? (f.record?.owner_name || '')}
                        onChange={(e) =>
                          setSelectedOwner((prev) => ({ ...prev, [f.record_id]: e.target.value }))
                        }
                        className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
                      >
                        <option value="">Select owner…</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.name}>
                            {u.name} {u.departing ? '(departing)' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={assigningId === f.record_id}
                        onClick={() => void handleAssignOwner(f.record_id)}
                        className="inline-flex items-center gap-1 rounded-full bg-[#2563EB] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
                      >
                        <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Assign owner</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={resolvingId === f.id}
                      onClick={() => void handleToggleResolve(f)}
                      className={`inline-flex items-center gap-1 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60 ${
                        f.resolved
                          ? 'border border-[#D97706]/40 bg-white text-[#B45309] hover:bg-[#FFFBEB]'
                          : 'bg-[#059669] text-white hover:bg-[#047857]'
                      }`}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{f.resolved ? 'Reopen' : 'Resolve'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : f.id)}
                      className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#475569] hover:bg-[#F8FAFC]"
                    >
                      <span>Details</span>
                      {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenRecord(f.record_id)}
                      className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-white px-3.5 py-1.5 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
                    >
                      <span>Open record</span>
                      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>

                    {canDelete && (
                      confirmDeleteId === f.record_id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={deletingId === f.record_id}
                            onClick={() => void handleDeleteRecord(f.record_id)}
                            className="rounded-full bg-[#DC2626] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                          >
                            {deletingId === f.record_id ? 'Deleting…' : 'Confirm delete'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-full border border-[#E2E8F0] px-2.5 py-1.5 text-xs text-[#64748B]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(f.record_id)}
                          aria-label={`Delete ${f.record_id}`}
                          title="Delete record"
                          className="rounded-full border border-[#E2E8F0] bg-white p-1.5 text-[#64748B] hover:border-[#DC2626]/40 hover:text-[#DC2626]"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-4 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[#64748B]">
                      <span>
                        <strong className="text-[#0F172A]">Created:</strong>{' '}
                        {(f.created_at || f.scanned_at).slice(0, 19).replace('T', ' ')} UTC
                      </span>
                      {f.resolved && f.resolved_at && (
                        <span className="text-[#059669]">
                          <strong>Resolved:</strong> {f.resolved_at.slice(0, 19).replace('T', ' ')} UTC
                          {f.resolved_by ? ` by ${f.resolved_by}` : ''}
                        </span>
                      )}
                    </div>
                    {f.record?.span_content && (
                      <p className="text-[#334155]">
                        <strong className="text-[#0F172A]">Linked span excerpt: </strong>
                        <span className="font-mono">&ldquo;{f.record.span_content}&rdquo;</span>
                      </p>
                    )}
                    {f.evidence_snapshot && Object.keys(f.evidence_snapshot).length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {Object.entries(f.evidence_snapshot).map(([k, v]) => (
                          <span
                            key={k}
                            className="rounded-lg border border-[#E2E8F0] bg-white px-2.5 py-1 font-mono text-[11px] text-[#334155]"
                          >
                            {k}: {String(v)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
