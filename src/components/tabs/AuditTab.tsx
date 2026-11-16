import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import type { AuditEntry } from '../../types';

interface AuditTabProps {
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function AuditTab({ onToast }: AuditTabProps) {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = actionFilter ? `?action=${encodeURIComponent(actionFilter)}` : '';
      const res = await apiFetch<{ logs: AuditEntry[] }>(`/api/audit${qs}`);
      setLogs(res.logs);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load audit log';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [actionFilter, onToast]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const actionColor = (action: string) => {
    if (action.includes('DENIED') || action.includes('LOCKED') || action.includes('REJECT') || action.includes('DELETED') || action.includes('CLEARED') || action.includes('RESET')) {
      return 'text-[#DC2626]';
    }
    if (action.includes('REDACTION') || action.includes('AI_CONTEXT_FILTERED')) {
      return 'text-[#7C3AED]';
    }
    if (action.includes('APPROVE') || action.includes('PUBLISH') || action.includes('SUCCESS')) {
      return 'text-[#059669]';
    }
    return 'text-[#2563EB]';
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">Append-Only Audit Ledger</h1>
          <p className="text-sm text-[#64748B]">
            Protected by SQLite BEFORE UPDATE and BEFORE DELETE triggers; every role denial, AI filter, and redaction is recorded.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Filter by audit action"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-medium text-[#0F172A]"
          >
            <option value="">All events</option>
            <option value="ACCESS_DENIED">ACCESS_DENIED</option>
            <option value="AI_CONTEXT_FILTERED">AI_CONTEXT_FILTERED</option>
            <option value="APPROVAL_INVALIDATED_ON_EDIT">APPROVAL_INVALIDATED_ON_EDIT</option>
            <option value="CITATION_FLAGGED">CITATION_FLAGGED</option>
            <option value="RECORD_DELETED">RECORD_DELETED</option>
            <option value="RECORDS_CLEARED">RECORDS_CLEARED</option>
            <option value="REDACTION_CONFIRMED">REDACTION_CONFIRMED</option>
            <option value="REDACTION_REJECTED">REDACTION_REJECTED</option>
            <option value="REDACTION_REOPENED">REDACTION_REOPENED</option>
            <option value="REDACTION_ORIGINAL_REVEALED">REDACTION_ORIGINAL_REVEALED</option>
            <option value="REDACTION_DELETED">REDACTION_DELETED</option>
            <option value="RADAR_SCANNED">RADAR_SCANNED</option>
            <option value="RADAR_FINDING_RESOLVED">RADAR_FINDING_RESOLVED</option>
            <option value="RADAR_FINDING_REOPENED">RADAR_FINDING_REOPENED</option>
            <option value="HANDOVER_PUBLISHED">HANDOVER_PUBLISHED</option>
            <option value="HANDOVER_RECEIPT_ACKNOWLEDGED">HANDOVER_RECEIPT_ACKNOWLEDGED</option>
            <option value="HANDOVER_ITEM_CHECKED">HANDOVER_ITEM_CHECKED</option>
            <option value="HANDOVER_DELETED">HANDOVER_DELETED</option>
            <option value="COLDSTART_RUN_SAVED">COLDSTART_RUN_SAVED</option>
            <option value="COLDSTART_RUN_DELETED">COLDSTART_RUN_DELETED</option>
            <option value="SOURCE_UPLOADED">SOURCE_UPLOADED</option>
            <option value="SOURCE_VISIBILITY_CHANGED">SOURCE_VISIBILITY_CHANGED</option>
            <option value="SOURCE_DELETED">SOURCE_DELETED</option>
            <option value="SOURCE_RETRIED">SOURCE_RETRIED</option>
            <option value="NOTE_CREATED">NOTE_CREATED</option>
            <option value="NOTE_UPDATED">NOTE_UPDATED</option>
            <option value="NOTE_VISIBILITY_CHANGED">NOTE_VISIBILITY_CHANGED</option>
            <option value="NOTE_DELETED">NOTE_DELETED</option>
            <option value="PROJECT_CREATED">PROJECT_CREATED</option>
            <option value="PROJECT_MEMBER_ADDED">PROJECT_MEMBER_ADDED</option>
            <option value="PROJECT_MEMBER_ROLE_CHANGED">PROJECT_MEMBER_ROLE_CHANGED</option>
            <option value="PROJECT_MEMBER_REMOVED">PROJECT_MEMBER_REMOVED</option>
            <option value="PROJECT_SETTINGS_UPDATED">PROJECT_SETTINGS_UPDATED</option>
            <option value="PROJECT_RESET">PROJECT_RESET</option>
            <option value="PROJECT_DELETED">PROJECT_DELETED</option>
            <option value="USER_REGISTERED">USER_REGISTERED</option>
            <option value="PRIVILEGED_REGISTRATION_ATTEMPTED">PRIVILEGED_REGISTRATION_ATTEMPTED</option>
            <option value="LOGIN_SUCCESS">LOGIN_SUCCESS</option>
            <option value="LOGIN_FAILED">LOGIN_FAILED</option>
            <option value="REAUTH_SUCCESS">REAUTH_SUCCESS</option>
          </select>
          <button
            type="button"
            onClick={loadLogs}
            className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-4 py-2 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Refresh</span>
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
            onClick={() => void loadLogs()}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      <div className="rounded-2xl border border-[#E2E8F0] bg-white overflow-x-auto">
        {loading ? (
          <div className="p-8 text-sm text-[#64748B]">Loading audit trail…</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#64748B]">No audit entries match this filter.</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-semibold text-[#64748B]">
                <th className="py-3 px-4">ID</th>
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Actor</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">Target</th>
                <th className="py-3 px-4">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] text-xs">
              {logs.map((entry) => (
                <tr key={entry.id} className="hover:bg-[#F8FAFC]">
                  <td className="py-2.5 px-4 font-mono tabular-nums text-[#64748B]">#{entry.id}</td>
                  <td className="py-2.5 px-4 font-mono tabular-nums text-[#475569] whitespace-nowrap">
                    {entry.timestamp.replace('T', ' ').slice(0, 19)}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[#0F172A]">{entry.actor_email}</td>
                  <td className="py-2.5 px-4 font-mono text-[#64748B]">{entry.actor_role}</td>
                  <td className={`py-2.5 px-4 font-mono font-semibold ${actionColor(entry.action)}`}>
                    {entry.action}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[#0F172A]">
                    {entry.target_type}:{entry.target_id}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[11px] text-[#64748B] max-w-xs truncate">
                    {JSON.stringify(entry.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
