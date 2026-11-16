import React, { useCallback, useEffect, useState } from 'react';
import { Filter, Maximize2, Minimize2, Network, RotateCcw, ShieldCheck, Sparkles, Table2, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { ApprovalBadge, EvidenceBadge } from '../StatusChip';
import type { ApprovalState, EvidenceState, Role } from '../../types';

interface MapNode {
  id: string;
  type: string;
  title: string;
  owner_name: string | null;
  evidence_state: EvidenceState;
  approval_state: ApprovalState;
  visibility_level: string;
  stage: string;
  source_id: string | null;
  source_file: string;
  locator: string;
}

interface MapEdge {
  id: string;
  from_record_id: string;
  to_record_id: string;
  relation: string;
}

interface MapSource {
  id: string;
  title: string;
  filename: string;
  visibility_level: string;
  exclude_from_ai: number;
  status: string;
}

interface FilterSummary {
  requestedSourcesCount: number;
  permittedSourcesCount: number;
  filteredOutCount: number;
  permittedSpansCount: number;
  filteredOutSources: Array<{ id: string; title: string; reason: string }>;
  focus: string;
}

interface MapTabProps {
  role?: Role;
  onOpenRecord: (recordId: string) => void;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

export function MapTab({ role, onOpenRecord, onToast }: MapTabProps) {
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [edges, setEdges] = useState<MapEdge[]>([]);
  const [sources, setSources] = useState<MapSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'table'>('graph');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  // Map filters
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [ownerFilter, setOwnerFilter] = useState('ALL');
  const [sourceFilter, setSourceFilter] = useState('ALL');

  // Pre-filtered multi-source reconstruction controls
  const [reconOpen, setReconOpen] = useState(false);
  const [selectedReconSources, setSelectedReconSources] = useState<string[]>([]);
  const [reconFocus, setReconFocus] = useState('');
  const [reconUseAi, setReconUseAi] = useState(false);
  const [reconstructing, setReconstructing] = useState(false);
  const [filterSummary, setFilterSummary] = useState<FilterSummary | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  const canReconstruct = !role || role === 'PI_LEAD' || role === 'RESEARCHER';

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

  const loadMap = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{ nodes: MapNode[]; edges: MapEdge[]; sources?: MapSource[] }>('/api/map');
      setNodes(res.nodes);
      setEdges(res.edges);
      const srcList = res.sources || [];
      setSources(srcList);
      setSelectedReconSources((prev) =>
        prev.length > 0 ? prev.filter((id) => srcList.some((s) => s.id === id)) : srcList.map((s) => s.id)
      );
      if (res.nodes.length > 0 && (!selectedId || !res.nodes.some((n) => n.id === selectedId))) {
        setSelectedId(res.nodes[0].id);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load knowledge map';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast, selectedId]);

  useEffect(() => {
    void loadMap();
  }, [loadMap]);

  const handleRunReconstruction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reconstructing) return;
    setReconstructing(true);
    try {
      const res = await apiFetch<{
        createdCount: number;
        extractorMode: string;
        filterSummary: FilterSummary;
      }>('/api/map/reconstruct', {
        method: 'POST',
        body: JSON.stringify({
          sourceIds: selectedReconSources,
          focus: reconFocus,
          useAi: reconUseAi,
        }),
      });
      setFilterSummary(res.filterSummary);
      await loadMap();
      onToast(
        `Reconstruction complete: ${res.createdCount} new claims (${res.extractorMode}).`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Multi-source reconstruction failed', 'error');
    } finally {
      setReconstructing(false);
    }
  };

  const handleDeleteNode = async (nodeId: string) => {
    if (deletingId || !canReconstruct) return;
    setDeletingId(nodeId);
    try {
      await apiFetch(`/api/records/${nodeId}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      if (selectedId === nodeId) {
        setSelectedId(null);
      }
      await loadMap();
      onToast(`Deleted claim ${nodeId}.`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete claim', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  // Apply Map Filters
  const uniqueTypes = Array.from(new Set(nodes.map((n) => n.type))).sort();
  const uniqueOwners = Array.from(new Set(nodes.map((n) => n.owner_name || 'UNKNOWN'))).sort();

  const visibleNodes = nodes.filter((n) => {
    if (typeFilter !== 'ALL' && n.type !== typeFilter) return false;
    if (ownerFilter !== 'ALL' && (n.owner_name || 'UNKNOWN') !== ownerFilter) return false;
    if (sourceFilter !== 'ALL' && n.source_id !== sourceFilter && n.source_file !== sourceFilter) return false;
    if (statusFilter === 'SUPPORTED' && n.evidence_state !== 'SUPPORTED') return false;
    if (
      statusFilter === 'INCOMPLETE' &&
      n.evidence_state === 'SUPPORTED' &&
      n.approval_state === 'APPROVED'
    ) {
      return false;
    }
    if (statusFilter === 'UNOWNED' && n.owner_name !== null) return false;
    return true;
  });

  const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
  const visibleEdges = edges.filter(
    (e) => visibleNodeIds.has(e.from_record_id) && visibleNodeIds.has(e.to_record_id)
  );

  const stageCols: Record<string, number> = {
    '01': 90,
    '02': 270,
    '03': 470,
    '04': 670,
    '05': 870,
  };

  const positioned = new Map<string, { x: number; y: number }>();
  const stageRowCounts: Record<string, number> = {};
  for (const n of visibleNodes) {
    const idx = stageRowCounts[n.stage] || 0;
    stageRowCounts[n.stage] = idx + 1;
    positioned.set(n.id, {
      x: stageCols[n.stage] ?? 270,
      y: 90 + idx * 96,
    });
  }

  const nodeColor = (ev: EvidenceState) => {
    if (ev === 'SUPPORTED') return '#059669';
    if (ev === 'UNSUPPORTED') return '#DC2626';
    if (ev === 'CONFLICTING' || ev === 'NOT_ESTABLISHED' || ev === 'STALE') return '#D97706';
    return '#2563EB';
  };

  const selectedNode = visibleNodes.find((n) => n.id === selectedId) || visibleNodes[0] || null;
  const nodeTitleMap = new Map(nodes.map((n) => [n.id, n.title]));

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
            ? 'fixed inset-2 sm:inset-4 z-50 rounded-2xl border border-[#CBD5E1] bg-[#F8FAFC] p-4 sm:p-5 shadow-2xl flex flex-col gap-3 overflow-hidden'
            : 'space-y-4'
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-4 shrink-0">
          <div>
            <h1 className={`font-display font-bold text-[#0F172A] ${isMaximized ? 'text-xl' : 'text-2xl'}`}>
              Knowledge Continuity Map
            </h1>
            {!isMaximized && (
              <p className="text-sm text-[#64748B]">
                Full-canvas dependency graph across project stages with pre-AI SQL source filtering and accessible table view.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canReconstruct && !isMaximized && (
              <button
                type="button"
                onClick={() => setReconOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#2563EB]/30 bg-white px-4 py-1.5 text-xs font-semibold text-[#2563EB] hover:bg-[#2563EB]/5"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{reconOpen ? 'Hide reconstruction' : 'Run pre-filtered reconstruction'}</span>
              </button>
            )}
            <div className="inline-flex rounded-full border border-[#E2E8F0] bg-white p-1">
              <button
                type="button"
                onClick={() => setViewMode('graph')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  viewMode === 'graph' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
                }`}
              >
                <Network className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Graph view</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                  viewMode === 'table' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
                }`}
              >
                <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Table view</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsMaximized((v) => !v)}
              aria-label={isMaximized ? 'Exit full screen' : 'Maximise Knowledge Map'}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
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
            onClick={() => void loadMap()}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      {/* Pre-Filtered Multi-Source Reconstruction Drawer */}
      {reconOpen && canReconstruct && (
        <form
          onSubmit={handleRunReconstruction}
          className="rounded-2xl border border-[#2563EB]/30 bg-white p-5 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-bold text-[#0F172A]">
                Pre-Filtered Multi-Source Reconstruction
              </h2>
              <p className="text-xs text-[#64748B]">
                Server SQL pre-filter removes RESTRICTED_PI_ONLY, exclude_from_ai=1, and NEEDS_OCR sources before extraction.
              </p>
            </div>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setSelectedReconSources(sources.map((s) => s.id))}
                className="text-[#2563EB] hover:underline font-medium"
              >
                Select all
              </button>
              <span className="text-[#CBD5E1]">·</span>
              <button
                type="button"
                onClick={() => setSelectedReconSources([])}
                className="text-[#64748B] hover:underline font-medium"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {sources.map((src) => {
              const checked = selectedReconSources.includes(src.id);
              const blocked =
                src.visibility_level === 'RESTRICTED_PI_ONLY' ||
                src.exclude_from_ai === 1 ||
                src.status !== 'PARSED';
              return (
                <label
                  key={src.id}
                  className={`flex items-start gap-2 rounded-xl border p-2.5 text-xs cursor-pointer ${
                    checked ? 'border-[#2563EB] bg-[#2563EB]/5' : 'border-[#E2E8F0] bg-[#F8FAFC]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedReconSources((prev) => [...prev, src.id]);
                      } else {
                        setSelectedReconSources((prev) => prev.filter((id) => id !== src.id));
                      }
                    }}
                    className="mt-0.5 rounded border-[#CBD5E1]"
                  />
                  <div className="min-w-0">
                    <p className="font-semibold text-[#0F172A] truncate">{src.title}</p>
                    <p className="font-mono text-[10px] text-[#64748B] truncate">
                      {src.filename} ·{' '}
                      {blocked ? (
                        <span className="text-[#D97706]">
                          {src.visibility_level === 'RESTRICTED_PI_ONLY'
                            ? 'PI_ONLY'
                            : src.exclude_from_ai === 1
                              ? 'AI_EXCLUDED'
                              : src.status}
                        </span>
                      ) : (
                        <span className="text-[#059669]">PERMITTED</span>
                      )}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={reconFocus}
              onChange={(e) => setReconFocus(e.target.value)}
              placeholder="Optional extraction focus (e.g., sintering risks, open calibration gaps)…"
              className="flex-1 min-w-[220px] rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2 text-xs text-[#0F172A]"
            />
            <label className="flex items-center gap-1.5 text-xs text-[#64748B] cursor-pointer">
              <input
                type="checkbox"
                checked={reconUseAi}
                onChange={(e) => setReconUseAi(e.target.checked)}
                className="rounded border-[#CBD5E1]"
              />
              <span>Optional Gemini assist</span>
            </label>
            <button
              type="submit"
              disabled={reconstructing || selectedReconSources.length === 0}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#2563EB] px-5 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{reconstructing ? 'Running filter & extraction…' : 'Reconstruct selected'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Pre-AI Filter Summary */}
      {filterSummary && (
        <div className="rounded-xl border border-[#059669]/30 bg-white p-4 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-[#0F172A]">
              <ShieldCheck className="h-4 w-4 text-[#059669]" aria-hidden="true" />
              <span>Pre-AI SQL Filter Summary</span>
            </div>
            <div className="font-mono tabular-nums text-[#475569]">
              Requested: {filterSummary.requestedSourcesCount} · Permitted: {filterSummary.permittedSourcesCount} ·
              Filtered out: {filterSummary.filteredOutCount} · Spans fed: {filterSummary.permittedSpansCount}
            </div>
          </div>
          {filterSummary.filteredOutSources.length > 0 && (
            <p className="text-[#92400E]">
              Excluded before extraction:{' '}
              {filterSummary.filteredOutSources.map((f) => `${f.title} (${f.reason})`).join('; ')}
            </p>
          )}
        </div>
      )}

      {/* Map Filters Bar */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white px-4 py-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 font-semibold text-[#0F172A]">
          <Filter className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
          <span>Map filters:</span>
        </span>
        <select
          aria-label="Filter map by record type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
        >
          <option value="ALL">All types ({nodes.length})</option>
          {uniqueTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter map by completeness status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
        >
          <option value="ALL">All statuses</option>
          <option value="SUPPORTED">Supported evidence</option>
          <option value="INCOMPLETE">Incomplete / Needs review</option>
          <option value="UNOWNED">Unowned (UNKNOWN)</option>
        </select>

        <select
          aria-label="Filter map by owner"
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
          className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A]"
        >
          <option value="ALL">All owners</option>
          {uniqueOwners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter map by source"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs text-[#0F172A] max-w-[200px]"
        >
          <option value="ALL">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>

        <span className="ml-auto font-mono text-[11px] text-[#64748B] tabular-nums">
          Showing {visibleNodes.length}/{nodes.length} nodes · {visibleEdges.length} edges
        </span>
      </div>

      {loading ? (
        <div className="h-[520px] rounded-2xl border border-[#E2E8F0] bg-white animate-pulse" />
      ) : viewMode === 'table' ? (
        <div className={`rounded-2xl border border-[#E2E8F0] bg-white overflow-auto ${isMaximized ? 'flex-1 min-h-0' : ''}`}>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#E2E8F0] text-xs font-semibold text-[#64748B] bg-[#F8FAFC]">
                <th className="py-3 px-4">ID</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Title</th>
                <th className="py-3 px-4">Owner</th>
                <th className="py-3 px-4">Evidence</th>
                <th className="py-3 px-4">Approval</th>
                <th className="py-3 px-4">Links</th>
                {canReconstruct && <th className="py-3 px-4 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] text-sm">
              {visibleNodes.map((n) => {
                const rels = visibleEdges.filter((e) => e.from_record_id === n.id || e.to_record_id === n.id);
                return (
                  <tr
                    key={n.id}
                    onClick={() => onOpenRecord(n.id)}
                    className="hover:bg-[#F8FAFC] cursor-pointer"
                  >
                    <td className="py-2.5 px-4 font-mono text-xs font-semibold text-[#2563EB]">{n.id}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-[#64748B]">{n.type}</td>
                    <td className="py-2.5 px-4 font-medium text-[#0F172A]">{n.title}</td>
                    <td className="py-2.5 px-4 text-xs text-[#475569]">{n.owner_name || 'UNKNOWN'}</td>
                    <td className="py-2.5 px-4">
                      <EvidenceBadge state={n.evidence_state} />
                    </td>
                    <td className="py-2.5 px-4">
                      <ApprovalBadge state={n.approval_state} />
                    </td>
                    <td className="py-2.5 px-4 font-mono text-xs text-[#64748B]">
                      {rels.map((r) => `${r.from_record_id}→${r.to_record_id} (${r.relation})`).join(', ') || '—'}
                    </td>
                    {canReconstruct && (
                      <td className="py-2.5 px-4 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        {confirmDeleteId === n.id ? (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              disabled={deletingId === n.id}
                              onClick={() => void handleDeleteNode(n.id)}
                              className="rounded-full bg-[#DC2626] px-2.5 py-1 text-[11px] font-semibold text-white"
                            >
                              {deletingId === n.id ? 'Deleting…' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-full border border-[#E2E8F0] px-2 py-1 text-[11px] text-[#64748B]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(n.id)}
                            aria-label={`Delete claim ${n.id}`}
                            className="rounded-full border border-[#E2E8F0] p-1.5 text-[#64748B] hover:border-[#DC2626]/40 hover:text-[#DC2626]"
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
      ) : (
        <div className={`grid grid-cols-1 lg:grid-cols-12 gap-4 ${isMaximized ? 'flex-1 min-h-0' : ''}`}>
          <div className={`lg:col-span-9 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden relative ${isMaximized ? 'flex flex-col h-full min-h-0' : ''}`}>
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-white/95 p-1 shadow-xs">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => setZoom((z) => Math.max(0.65, Number((z - 0.15).toFixed(2))))}
                className="p-1.5 rounded-full hover:bg-[#F8FAFC] text-[#0F172A]"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="font-mono text-xs tabular-nums px-1.5 text-[#64748B]">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => setZoom((z) => Math.min(1.5, Number((z + 0.15).toFixed(2))))}
                className="p-1.5 rounded-full hover:bg-[#F8FAFC] text-[#0F172A]"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Reset zoom"
                onClick={() => setZoom(1)}
                className="p-1.5 rounded-full hover:bg-[#F8FAFC] text-[#0F172A]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <span className="h-4 w-px bg-[#E2E8F0] mx-0.5" aria-hidden="true" />
              <button
                type="button"
                aria-label={isMaximized ? 'Exit full screen' : 'Maximise graph'}
                title={isMaximized ? 'Exit full screen (Esc)' : 'Maximise graph'}
                onClick={() => setIsMaximized((v) => !v)}
                className="p-1.5 rounded-full hover:bg-[#F8FAFC] text-[#2563EB]"
              >
                {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            </div>

            <div className={`overflow-auto bg-[#F8FAFC] ${isMaximized ? 'flex-1 min-h-0' : 'h-[560px]'}`}>
              <svg
                width={1020 * zoom}
                height={Math.max(560, (Object.values(stageRowCounts).reduce((m, v) => Math.max(m, v), 4) + 1) * 96) * zoom}
                viewBox={`0 0 1020 ${Math.max(560, (Object.values(stageRowCounts).reduce((m, v) => Math.max(m, v), 4) + 1) * 96)}`}
                role="img"
                aria-label="BATON Knowledge Dependency Graph"
              >
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#94A3B8" />
                  </marker>
                </defs>

                {/* Stage Column Labels */}
                {[
                  { x: 90, label: '01 Connect' },
                  { x: 270, label: '02 Reconstruct' },
                  { x: 470, label: '03 Verify' },
                  { x: 670, label: '04 Review' },
                  { x: 870, label: '05 Handover' },
                ].map((col) => (
                  <g key={col.label}>
                    <line x1={col.x} y1={38} x2={col.x} y2={900} stroke="#E2E8F0" strokeDasharray="4 4" />
                    <text x={col.x} y={26} textAnchor="middle" fill="#64748B" fontSize="11" fontWeight="600">
                      {col.label}
                    </text>
                  </g>
                ))}

                {/* Edges */}
                {visibleEdges.map((e) => {
                  const p1 = positioned.get(e.from_record_id);
                  const p2 = positioned.get(e.to_record_id);
                  if (!p1 || !p2) return null;
                  const isConflict = e.relation === 'CONFLICTS_WITH' || e.relation === 'BLOCKS';
                  return (
                    <line
                      key={e.id}
                      x1={p1.x}
                      y1={p1.y}
                      x2={p2.x}
                      y2={p2.y}
                      stroke={isConflict ? '#D97706' : '#94A3B8'}
                      strokeWidth={isConflict ? 2 : 1.5}
                      strokeDasharray={isConflict ? '5 3' : undefined}
                      markerEnd="url(#arrow)"
                    />
                  );
                })}

                {/* Nodes */}
                {visibleNodes.map((n) => {
                  const pos = positioned.get(n.id);
                  if (!pos) return null;
                  const isSelected = n.id === (selectedNode?.id || selectedId);
                  const color = nodeColor(n.evidence_state);
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${pos.x - 74}, ${pos.y - 30})`}
                      onClick={() => setSelectedId(n.id)}
                      className="cursor-pointer"
                    >
                      <rect
                        width="148"
                        height="60"
                        rx="10"
                        fill="#FFFFFF"
                        stroke={isSelected ? '#0F172A' : '#E2E8F0'}
                        strokeWidth={isSelected ? 2.5 : 1.25}
                      />
                      <circle cx="14" cy="18" r="5" fill={color} />
                      <text x="25" y="22" fontSize="11" fontWeight="700" fill="#0F172A" fontFamily="JetBrains Mono, monospace">
                        {n.id} · {n.type.slice(0, 7)}
                      </text>
                      <text x="12" y="42" fontSize="11" fill="#475569">
                        {n.title.length > 20 ? `${n.title.slice(0, 19)}…` : n.title}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          <aside className="lg:col-span-3 rounded-2xl border border-[#E2E8F0] bg-white p-5 flex flex-col justify-between space-y-4">
            {selectedNode ? (
              <>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-[#2563EB]">{selectedNode.id}</span>
                    <span className="font-mono text-xs text-[#64748B]">{selectedNode.type}</span>
                  </div>
                  <h2 className="font-display text-base font-bold text-[#0F172A]">{selectedNode.title}</h2>
                  <div className="flex flex-wrap gap-2">
                    <EvidenceBadge state={selectedNode.evidence_state} />
                    <ApprovalBadge state={selectedNode.approval_state} />
                  </div>
                  <dl className="text-xs space-y-2 pt-2 border-t border-[#E2E8F0]">
                    <div>
                      <dt className="text-[#64748B]">Owner</dt>
                      <dd className="font-medium text-[#0F172A]">{selectedNode.owner_name || 'UNKNOWN'}</dd>
                    </div>
                    <div>
                      <dt className="text-[#64748B]">Cited source</dt>
                      <dd className="font-medium text-[#0F172A]">
                        {selectedNode.source_file} · <span className="font-mono">{selectedNode.locator}</span>
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => onOpenRecord(selectedNode.id)}
                    className="w-full rounded-full bg-[#2563EB] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8]"
                  >
                    Open record in inspector
                  </button>
                  {canReconstruct && (
                    confirmDeleteId === selectedNode.id ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={deletingId === selectedNode.id}
                          onClick={() => void handleDeleteNode(selectedNode.id)}
                          className="flex-1 rounded-full bg-[#DC2626] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
                        >
                          {deletingId === selectedNode.id ? 'Deleting…' : 'Confirm delete'}
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
                        onClick={() => setConfirmDeleteId(selectedNode.id)}
                        className="w-full inline-flex items-center justify-center gap-1.5 rounded-full border border-[#DC2626]/30 bg-white px-4 py-2 text-xs font-semibold text-[#DC2626] hover:bg-[#DC2626]/5"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Delete claim</span>
                      </button>
                    )
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-[#64748B]">Select any node on the canvas to inspect its provenance.</p>
            )}
          </aside>
        </div>
      )}

      {/* Evidence-Supported Continuity Edges Table */}
      {!isMaximized && (
        <section className="rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
            <h2 className="font-display text-sm font-bold text-[#0F172A]">
              Evidence-Supported Continuity Map Edges ({visibleEdges.length})
            </h2>
            <span className="text-xs text-[#64748B]">Click a relationship to inspect the source record</span>
          </div>
          {visibleEdges.length === 0 ? (
            <div className="p-5 text-xs text-[#64748B]">No dependency edges match the current map filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]">
                    <th className="py-2.5 px-4">Source claim</th>
                    <th className="py-2.5 px-4">Relation</th>
                    <th className="py-2.5 px-4">Target claim</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {visibleEdges.map((e) => (
                    <tr key={e.id} className="hover:bg-[#F8FAFC]">
                      <td className="py-2.5 px-4">
                        <button
                          type="button"
                          onClick={() => onOpenRecord(e.from_record_id)}
                          className="font-mono font-semibold text-[#2563EB] hover:underline"
                        >
                          {e.from_record_id}
                        </button>
                        <span className="ml-2 text-[#475569]">{nodeTitleMap.get(e.from_record_id) || ''}</span>
                      </td>
                      <td className="py-2.5 px-4">
                        <span
                          className={`font-mono font-semibold ${
                            e.relation === 'CONFLICTS_WITH' || e.relation === 'BLOCKS'
                              ? 'text-[#D97706]'
                              : 'text-[#059669]'
                          }`}
                        >
                          {e.relation}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <button
                          type="button"
                          onClick={() => onOpenRecord(e.to_record_id)}
                          className="font-mono font-semibold text-[#2563EB] hover:underline"
                        >
                          {e.to_record_id}
                        </button>
                        <span className="ml-2 text-[#475569]">{nodeTitleMap.get(e.to_record_id) || ''}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      </div>
    </>
  );
}
