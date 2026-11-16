import React from 'react';
import { AlertTriangle, CheckCircle2, Clock, HelpCircle, ShieldAlert, XCircle } from 'lucide-react';
import type { ApprovalState, EvidenceState } from '../types';

export function EvidenceBadge({ state }: { state: EvidenceState | string }) {
  switch (state) {
    case 'SUPPORTED':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#059669]/10 px-2.5 py-0.5 text-xs font-medium text-[#059669] whitespace-nowrap">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>SUPPORTED</span>
        </span>
      );
    case 'CONFLICTING':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#D97706]/12 px-2.5 py-0.5 text-xs font-medium text-[#B45309] whitespace-nowrap">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>CONFLICTING</span>
        </span>
      );
    case 'STALE':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#D97706]/12 px-2.5 py-0.5 text-xs font-medium text-[#B45309] whitespace-nowrap">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>STALE</span>
        </span>
      );
    case 'NEEDS_REVIEW':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#2563EB]/10 px-2.5 py-0.5 text-xs font-medium text-[#2563EB] whitespace-nowrap">
          <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{state}</span>
        </span>
      );
    case 'NOT_ESTABLISHED':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#D97706]/12 px-2.5 py-0.5 text-xs font-medium text-[#B45309] whitespace-nowrap">
          <HelpCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{state}</span>
        </span>
      );
    case 'UNSUPPORTED':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DC2626]/10 px-2.5 py-0.5 text-xs font-medium text-[#DC2626] whitespace-nowrap">
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>UNSUPPORTED</span>
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#64748B]/12 px-2.5 py-0.5 text-xs font-medium text-[#475569] whitespace-nowrap">
          <span>{state}</span>
        </span>
      );
  }
}

export function ApprovalBadge({ state }: { state: ApprovalState | string }) {
  switch (state) {
    case 'APPROVED':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#059669]/10 px-2.5 py-0.5 text-xs font-medium text-[#059669] whitespace-nowrap">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>APPROVED</span>
        </span>
      );
    case 'NEEDS_REVISION':
    case 'NEEDS_REVIEW':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#D97706]/12 px-2.5 py-0.5 text-xs font-medium text-[#B45309] whitespace-nowrap">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{state}</span>
        </span>
      );
    case 'REJECTED':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DC2626]/10 px-2.5 py-0.5 text-xs font-medium text-[#DC2626] whitespace-nowrap">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>REJECTED</span>
        </span>
      );
    default:
      return <span className="text-xs text-[#64748B]">{state}</span>;
  }
}
