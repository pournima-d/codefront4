import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileText,
  Globe,
  Lock,
  Maximize2,
  Minimize2,
  PenLine,
  RefreshCw,
  Shield,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  apiFetch,
  ApiError,
  getActiveProjectId,
  getCsrfToken,
  getSessionToken,
} from '../../lib/api';
import type { Role, SourceItem, SourceSpan, VisibilityLevel } from '../../types';

interface SourcesTabProps {
  role: Role;
  currentUserId: string;
  currentUserEmail: string;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

interface UploadQueueItem {
  id: string;
  file: File;
  visibility: VisibilityLevel;
  excludeFromAi: boolean;
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error' | 'needs_ocr';
  message?: string;
}

const ALLOWED_EXT = ['.pdf', '.md', '.txt', '.csv', '.json'];

const BLANK_NOTE_TEMPLATE = `# Research Observation Note
Owner: [Your Name]
Objective: [Describe experiment or study objective]

Decision: [Key methodology decision and rationale]
Result: [Observed measurement or outcome]
Risk: [Any open safety, calibration, or reproducibility risk]
Task: [Next action item and owner]`;

const BLANK_CSV_TEMPLATE = `type,title,owner,evidence_state,excerpt
EXPERIMENT,Experiment run 01,[Your Name],NEEDS_REVIEW,Describe protocol parameters and observed outcome here.
DECISION,Methodology update,[Your Name],NEEDS_REVIEW,Document why this method or parameter was selected.`;

export function SourcesTab({ role, currentUserId, currentUserEmail, onToast }: SourcesTabProps) {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [spans, setSpans] = useState<SourceSpan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [spansLoading, setSpansLoading] = useState(false);

  const [ingestMode, setIngestMode] = useState<'file' | 'text'>('file');
  const [dragActive, setDragActive] = useState(false);
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [defaultVisibility, setDefaultVisibility] = useState<VisibilityLevel>('PROJECT_SHARED');
  const [defaultExcludeAi, setDefaultExcludeAi] = useState(false);
  const [stageBeforeUpload, setStageBeforeUpload] = useState(false);
  const [reconstructing, setReconstructing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [togglingVis, setTogglingVis] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [ocrFallbackText, setOcrFallbackText] = useState('');
  const [useAi, setUseAi] = useState(false);

  // Paste text state
  const [textTitle, setTextTitle] = useState('');
  const [textFilename, setTextFilename] = useState('research-note.md');
  const [textVisibility, setTextVisibility] = useState<VisibilityLevel>('PROJECT_SHARED');
  const [textExcludeAi, setTextExcludeAi] = useState(false);
  const [textContent, setTextContent] = useState('');
  const [submittingText, setSubmittingText] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const canUpload = role === 'PI_LEAD' || role === 'RESEARCHER' || role === 'INCOMING_MEMBER';
  const canReconstruct = role === 'PI_LEAD' || role === 'RESEARCHER';

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

  const loadSources = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch<{ sources: SourceItem[] }>('/api/sources');
      setSources(res.sources);
      if (res.sources.length > 0 && (!selectedSourceId || !res.sources.some((s) => s.id === selectedSourceId))) {
        setSelectedSourceId(res.sources[0].id);
      } else if (res.sources.length === 0) {
        setSelectedSourceId(null);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load files';
      setLoadError(msg);
      onToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, [onToast, selectedSourceId]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (!selectedSourceId) {
      setSpans([]);
      return;
    }
    let active = true;
    setSpansLoading(true);
    setOcrFallbackText('');
    setConfirmDeleteId(null);
    apiFetch<{ spans: SourceSpan[] }>(`/api/sources/${selectedSourceId}/spans`)
      .then((res) => {
        if (active) setSpans(res.spans);
      })
      .catch((err) => {
        if (active) onToast(err instanceof ApiError ? err.message : 'Failed to load spans', 'error');
      })
      .finally(() => {
        if (active) setSpansLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSourceId, onToast]);

  const uploadSingleFile = async (item: UploadQueueItem) => {
    const ext = item.file.name.slice(item.file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? {
                ...q,
                status: 'error',
                progress: 100,
                message: `Unsupported file type (${ext || 'unknown'}). Allowed: PDF, MD, TXT, CSV, JSON.`,
              }
            : q
        )
      );
      return;
    }
    if (item.file.size > 2 * 1024 * 1024) {
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? { ...q, status: 'error', progress: 100, message: 'File exceeds 2 MB maximum limit.' }
            : q
        )
      );
      return;
    }

    setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'uploading', progress: 25 } : q)));

    const formData = new FormData();
    formData.append('file', item.file);
    formData.append('visibility_level', item.visibility);
    formData.append('exclude_from_ai', String(item.excludeFromAi || item.visibility === 'PRIVATE_OWNER'));

    try {
      const result = await new Promise<{
        source: SourceItem;
        spans: SourceSpan[];
        status: string;
        newRedactionProposals: number;
      }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/sources/upload?projectId=${encodeURIComponent(getActiveProjectId())}`);
        xhr.withCredentials = true;
        const sid = getSessionToken();
        if (sid) xhr.setRequestHeader('X-Baton-Session', sid);
        const csrf = getCsrfToken();
        if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
        xhr.timeout = 10_000;

        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            const pct = Math.min(90, Math.round((ev.loaded / ev.total) * 90));
            setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, progress: pct } : q)));
          }
        };

        xhr.onload = () => {
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(xhr.responseText || '{}');
          } catch {
            // ignore
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(body as { source: SourceItem; spans: SourceSpan[]; status: string; newRedactionProposals: number });
          } else {
            reject(new ApiError((body.error as string) || `Upload error (${xhr.status})`, xhr.status));
          }
        };
        xhr.onerror = () => reject(new ApiError('Network error during upload.', 0));
        xhr.ontimeout = () => reject(new ApiError('Upload timed out after 10 seconds.', 408));
        xhr.send(formData);
      });

      const isNeedsOcr = result.status === 'NEEDS_OCR';
      setQueue((prev) =>
        prev.map((q) =>
          q.id === item.id
            ? {
                ...q,
                progress: 100,
                status: isNeedsOcr ? 'needs_ocr' : 'done',
                message: isNeedsOcr
                  ? 'NEEDS_OCR: Scanned PDF contains no extractable text layer.'
                  : `Parsed ${result.spans.length} sections${item.visibility === 'PRIVATE_OWNER' ? ' · Private (only you)' : ' · Public'}.`,
              }
            : q
        )
      );

      await loadSources();
      if (result.source?.id) {
        setSelectedSourceId(result.source.id);
      }
      onToast(
        isNeedsOcr
          ? 'Uploaded PDF marked NEEDS_OCR.'
          : `Uploaded "${item.file.name}" (${item.visibility === 'PRIVATE_OWNER' ? 'Private' : 'Public'}).`,
        isNeedsOcr ? 'info' : 'success'
      );
    } catch (err) {
      const msg = err instanceof ApiError ? `${err.status || ''} ${err.message}`.trim() : 'Upload failed';
      setQueue((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: 'error', progress: 100, message: msg } : q))
      );
      onToast(msg, 'error');
    }
  };

  const enqueueFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || !canUpload) return;
    const newItems: UploadQueueItem[] = Array.from(fileList).map((file) => ({
      id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`,
      file,
      visibility: defaultVisibility,
      excludeFromAi: defaultExcludeAi || defaultVisibility === 'PRIVATE_OWNER',
      progress: 0,
      status: 'pending',
    }));
    setQueue((prev) => [...newItems, ...prev]);
    if (!stageBeforeUpload) {
      newItems.forEach((item) => {
        void uploadSingleFile(item);
      });
    }
  };

  const uploadPendingStaged = () => {
    const pending = queue.filter((q) => q.status === 'pending');
    pending.forEach((item) => {
      void uploadSingleFile(item);
    });
  };

  const handleSubmitText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingText || !canUpload) return;
    setSubmittingText(true);
    try {
      const res = await apiFetch<{
        source: SourceItem;
        spans: SourceSpan[];
        newRedactionProposals: number;
      }>('/api/sources/text', {
        method: 'POST',
        body: JSON.stringify({
          title: textTitle,
          filename: textFilename,
          content: textContent,
          visibility_level: textVisibility,
          exclude_from_ai: textExcludeAi || textVisibility === 'PRIVATE_OWNER',
        }),
      });
      setTextTitle('');
      setTextContent('');
      await loadSources();
      if (res.source?.id) {
        setSelectedSourceId(res.source.id);
      }
      onToast(
        `Saved "${res.source.title}" (${textVisibility === 'PRIVATE_OWNER' ? 'Private' : 'Public'}).`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to save pasted content', 'error');
    } finally {
      setSubmittingText(false);
    }
  };

  const handleToggleVisibility = async (src: SourceItem, nextVis: VisibilityLevel) => {
    if (togglingVis) return;
    setTogglingVis(true);
    try {
      await apiFetch(`/api/sources/${src.id}/visibility`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility_level: nextVis }),
      });
      await loadSources();
      onToast(
        nextVis === 'PRIVATE_OWNER'
          ? `"${src.title}" is now Private (visible only to you).`
          : `"${src.title}" is now Public (visible to everyone in the workspace).`,
        'success'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Could not update visibility', 'error');
    } finally {
      setTogglingVis(false);
    }
  };

  const handleDownloadSource = async (src: SourceItem) => {
    try {
      const headers: Record<string, string> = {};
      const sid = getSessionToken();
      if (sid) headers['X-Baton-Session'] = sid;
      const resp = await fetch(`/api/sources/${src.id}/download`, {
        credentials: 'include',
        headers,
      });
      if (!resp.ok) {
        throw new Error('Download permission denied or file unavailable.');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = src.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Download failed', 'error');
    }
  };

  const handleDeleteSource = async (src: SourceItem) => {
    try {
      await apiFetch(`/api/sources/${src.id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      await loadSources();
      onToast(`Deleted "${src.title}".`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Delete failed', 'error');
    }
  };

  const handleRetryProcessing = async () => {
    if (!selectedSourceId || retrying) return;
    setRetrying(true);
    try {
      const res = await apiFetch<{ status: string; spanCount: number }>(
        `/api/sources/${selectedSourceId}/retry`,
        {
          method: 'POST',
          body: JSON.stringify(ocrFallbackText.trim() ? { raw_text: ocrFallbackText } : {}),
        }
      );
      await loadSources();
      const spRes = await apiFetch<{ spans: SourceSpan[] }>(`/api/sources/${selectedSourceId}/spans`);
      setSpans(spRes.spans);
      onToast(
        res.status === 'PARSED'
          ? `Re-processed file successfully (${res.spanCount} sections extracted).`
          : `File remains ${res.status}. Paste OCR transcript text below to parse.`,
        res.status === 'PARSED' ? 'success' : 'info'
      );
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Retry failed', 'error');
    } finally {
      setRetrying(false);
    }
  };

  const handleReconstruct = async () => {
    if (!selectedSourceId || reconstructing) return;
    setReconstructing(true);
    try {
      const res = await apiFetch<{ createdCount: number; extractorMode: string }>(
        `/api/sources/${selectedSourceId}/reconstruct`,
        {
          method: 'POST',
          body: JSON.stringify({ useAi }),
        }
      );
      onToast(`Reconstructed ${res.createdCount} new claims (${res.extractorMode}).`, 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Reconstruction failed', 'error');
    } finally {
      setReconstructing(false);
    }
  };

  const selectedSource = sources.find((s) => s.id === selectedSourceId) || null;
  const isSelectedOwner =
    Boolean(selectedSource) &&
    (selectedSource!.uploaded_by_id === currentUserId || selectedSource!.uploaded_by === currentUserEmail);
  const canManageSelected =
    Boolean(selectedSource) &&
    (selectedSource!.visibility_level === 'PRIVATE_OWNER'
      ? isSelectedOwner
      : isSelectedOwner || role === 'PI_LEAD');

  const visibilityLabel = (vis: VisibilityLevel) => {
    if (vis === 'PRIVATE_OWNER') return 'Private · Only you';
    if (vis === 'RESTRICTED_PI_ONLY') return 'PI Restricted';
    return 'Public · Shared';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">Files &amp; Source Vault</h1>
          <p className="text-sm text-[#64748B]">
            Choose Private (visible only to you) or Public (shared across the workspace) before uploading PDF, Markdown, TXT, CSV, or JSON files.
          </p>
        </div>

        {canUpload && (
          <div className="inline-flex rounded-full border border-[#E2E8F0] bg-white p-1">
            <button
              type="button"
              onClick={() => setIngestMode('file')}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                ingestMode === 'file' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>File upload</span>
            </button>
            <button
              type="button"
              onClick={() => setIngestMode('text')}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                ingestMode === 'text' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Paste text / Template</span>
            </button>
          </div>
        )}
      </div>

      {loadError && (
        <div
          role="alert"
          className="rounded-xl border border-[#DC2626]/30 bg-[#DC2626]/5 px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#991B1B]"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadSources()}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      {/* Upload or Paste Ingestion Panel */}
      {canUpload && ingestMode === 'file' && (
        <section className="rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-4">
          {/* Step 1: Prominent Public vs Private Visibility Choice BEFORE Uploading */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#0F172A]">
              1. Choose file access level before uploading
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => setDefaultVisibility('PROJECT_SHARED')}
                className={`text-left rounded-xl border p-3 transition-colors ${
                  defaultVisibility === 'PROJECT_SHARED'
                    ? 'border-[#059669] bg-[#059669]/6'
                    : 'border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#94A3B8]'
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-bold text-[#0F172A]">
                  <Globe className="h-4 w-4 text-[#059669]" aria-hidden="true" />
                  <span>Public (Workspace Shared)</span>
                </div>
                <p className="text-[11px] text-[#64748B] mt-1">
                  Everyone authenticated in this workspace can inspect and cite this file.
                </p>
              </button>

              <button
                type="button"
                onClick={() => {
                  setDefaultVisibility('PRIVATE_OWNER');
                  setDefaultExcludeAi(true);
                }}
                className={`text-left rounded-xl border p-3 transition-colors ${
                  defaultVisibility === 'PRIVATE_OWNER'
                    ? 'border-[#7C3AED] bg-[#7C3AED]/6'
                    : 'border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#94A3B8]'
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-bold text-[#0F172A]">
                  <Lock className="h-4 w-4 text-[#7C3AED]" aria-hidden="true" />
                  <span>Private (Only Me)</span>
                </div>
                <p className="text-[11px] text-[#64748B] mt-1">
                  Requires your login to view or download. Completely hidden from all other users.
                </p>
              </button>

              {(role === 'PI_LEAD' || role === 'RESEARCHER') && (
                <button
                  type="button"
                  onClick={() => setDefaultVisibility('RESTRICTED_PI_ONLY')}
                  className={`text-left rounded-xl border p-3 transition-colors ${
                    defaultVisibility === 'RESTRICTED_PI_ONLY'
                      ? 'border-[#DC2626] bg-[#DC2626]/6'
                      : 'border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#94A3B8]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-bold text-[#0F172A]">
                    <Shield className="h-4 w-4 text-[#DC2626]" aria-hidden="true" />
                    <span>PI Lead Restricted</span>
                  </div>
                  <p className="text-[11px] text-[#64748B] mt-1">
                    Visible strictly to PI Lead accounts; excluded from AI synthesis and handovers.
                  </p>
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-xs font-medium text-[#0F172A] cursor-pointer">
                <input
                  type="checkbox"
                  checked={defaultExcludeAi || defaultVisibility === 'PRIVATE_OWNER'}
                  disabled={defaultVisibility === 'PRIVATE_OWNER'}
                  onChange={(e) => setDefaultExcludeAi(e.target.checked)}
                  className="rounded border-[#CBD5E1] text-[#2563EB] focus:ring-[#2563EB]"
                />
                <span>Exclude from AI synthesis</span>
              </label>

              <label className="flex items-center gap-2 text-xs font-medium text-[#64748B] cursor-pointer">
                <input
                  type="checkbox"
                  checked={stageBeforeUpload}
                  onChange={(e) => setStageBeforeUpload(e.target.checked)}
                  className="rounded border-[#CBD5E1] text-[#2563EB] focus:ring-[#2563EB]"
                />
                <span>Review per-file privacy before uploading</span>
              </label>
            </div>
            <span className="text-xs text-[#64748B]">Max 2 MB per file · SHA-256 deduplicated</span>
          </div>

          <div
            role="button"
            tabIndex={0}
            aria-label="Drop files here or press Enter to browse"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              enqueueFiles(e.dataTransfer.files);
            }}
            className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] ${
              dragActive
                ? 'border-[#2563EB] bg-[#2563EB]/5'
                : 'border-[#CBD5E1] bg-[#F8FAFC] hover:border-[#2563EB]'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.md,.txt,.csv,.json"
              className="hidden"
              onChange={(e) => {
                enqueueFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <Upload className="h-7 w-7 mx-auto text-[#2563EB] mb-2" aria-hidden="true" />
            <p className="text-sm font-semibold text-[#0F172A]">
              Drop files here or click to upload as{' '}
              <span className={defaultVisibility === 'PRIVATE_OWNER' ? 'text-[#7C3AED]' : 'text-[#059669]'}>
                {visibilityLabel(defaultVisibility)}
              </span>
            </p>
            <p className="text-xs text-[#64748B] mt-1">
              PDF, Markdown (.md), Plain Text (.txt), CSV (.csv), JSON (.json)
            </p>
          </div>

          {/* Per-File Upload Progress & Results */}
          {queue.length > 0 && (
            <div className="space-y-2.5">
              {queue.some((q) => q.status === 'pending') && (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#0F172A]">
                    Staged files ({queue.filter((q) => q.status === 'pending').length})
                  </span>
                  <button
                    type="button"
                    onClick={uploadPendingStaged}
                    className="rounded-full bg-[#2563EB] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#1D4ED8]"
                  >
                    Upload staged files
                  </button>
                </div>
              )}
              {queue.slice(0, 6).map((q) => (
                <div
                  key={q.id}
                  className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-2.5 flex flex-col gap-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-[#0F172A] truncate">{q.file.name}</span>
                    <div className="flex items-center gap-2">
                      {q.status === 'pending' ? (
                        <select
                          aria-label={`Visibility for ${q.file.name}`}
                          value={q.visibility}
                          onChange={(e) =>
                            setQueue((prev) =>
                              prev.map((item) =>
                                item.id === q.id
                                  ? { ...item, visibility: e.target.value as VisibilityLevel }
                                  : item
                              )
                            )
                          }
                          className="rounded-lg border border-[#E2E8F0] bg-white px-2 py-1 text-[11px] text-[#0F172A]"
                        >
                          <option value="PROJECT_SHARED">Public · Workspace Shared</option>
                          <option value="PRIVATE_OWNER">Private · Only Me</option>
                          <option value="RESTRICTED_PI_ONLY">PI Restricted</option>
                        </select>
                      ) : (
                        <span className="font-mono text-[11px] text-[#64748B]">
                          {visibilityLabel(q.visibility)}
                        </span>
                      )}
                      <span className="font-mono tabular-nums text-[#64748B]">{q.progress}%</span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-[#E2E8F0] overflow-hidden">
                    <div
                      className="h-full transition-all"
                      style={{
                        width: `${q.progress}%`,
                        backgroundColor:
                          q.status === 'error'
                            ? '#DC2626'
                            : q.status === 'needs_ocr'
                              ? '#D97706'
                              : q.status === 'done'
                                ? '#059669'
                                : '#2563EB',
                      }}
                    />
                  </div>
                  {q.message && (
                    <p
                      className={`text-xs flex items-center gap-1.5 ${
                        q.status === 'error'
                          ? 'text-[#DC2626]'
                          : q.status === 'needs_ocr'
                            ? 'text-[#B45309]'
                            : 'text-[#059669]'
                      }`}
                    >
                      {q.status === 'error' || q.status === 'needs_ocr' ? (
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>{q.message}</span>
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {canUpload && ingestMode === 'text' && (
        <form onSubmit={handleSubmitText} className="rounded-2xl border border-[#E2E8F0] bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-bold text-[#0F172A]">
                Paste text, structured CSV, or start from a blank template
              </h2>
              <p className="text-xs text-[#64748B]">
                Automatically splits paragraphs, CSV rows, or JSON entries into addressable sections.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setTextTitle('Research Observation Note');
                  setTextFilename('observation-note.md');
                  setTextContent(BLANK_NOTE_TEMPLATE);
                }}
                className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-1.5 text-xs font-semibold text-[#0F172A] hover:border-[#2563EB]"
              >
                Blank Note Template
              </button>
              <button
                type="button"
                onClick={() => {
                  setTextTitle('Experiment Log Table');
                  setTextFilename('experiment-log.csv');
                  setTextContent(BLANK_CSV_TEMPLATE);
                }}
                className="rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-1.5 text-xs font-semibold text-[#0F172A] hover:border-[#2563EB]"
              >
                Blank CSV Template
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-[#0F172A] mb-1">File title</label>
              <input
                type="text"
                required
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                placeholder="e.g., Week 1 Synthesis Log"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs text-[#0F172A]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Filename (.md/.txt/.csv/.json)</label>
              <input
                type="text"
                required
                value={textFilename}
                onChange={(e) => setTextFilename(e.target.value)}
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-mono text-[#0F172A]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#0F172A] mb-1">Access level</label>
              <select
                value={textVisibility}
                onChange={(e) => setTextVisibility(e.target.value as VisibilityLevel)}
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs text-[#0F172A]"
              >
                <option value="PROJECT_SHARED">Public (Everyone)</option>
                <option value="PRIVATE_OWNER">Private (Only Me)</option>
                <option value="RESTRICTED_PI_ONLY">PI Restricted</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[#0F172A] mb-1">Content</label>
            <textarea
              rows={6}
              required
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="Write or paste your Markdown notes, CSV rows, or JSON records…"
              className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-xs font-mono text-[#0F172A]"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs font-medium text-[#0F172A] cursor-pointer">
              <input
                type="checkbox"
                checked={textExcludeAi || textVisibility === 'PRIVATE_OWNER'}
                disabled={textVisibility === 'PRIVATE_OWNER'}
                onChange={(e) => setTextExcludeAi(e.target.checked)}
                className="rounded border-[#CBD5E1]"
              />
              <span>Exclude from AI synthesis</span>
            </label>
            <button
              type="submit"
              disabled={submittingText}
              className="rounded-full bg-[#2563EB] px-5 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
            >
              {submittingText ? 'Saving…' : 'Save file'}
            </button>
          </div>
        </form>
      )}

      {/* Split File Vault + Span Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-5 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center justify-between">
            <h2 className="font-display text-sm font-bold text-[#0F172A]">Your accessible files</h2>
            <span className="font-mono text-xs tabular-nums text-[#64748B]">{sources.length} files</span>
          </div>
          {loading ? (
            <div className="p-6 text-sm text-[#64748B]">Loading files…</div>
          ) : sources.length === 0 ? (
            <div className="p-8 text-center text-sm text-[#64748B]">
              No files uploaded yet. Use the upload box above to add a Private or Public file.
            </div>
          ) : (
            <ul className="divide-y divide-[#E2E8F0]">
              {sources.map((src) => {
                const selected = src.id === selectedSourceId;
                return (
                  <li key={src.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedSourceId(src.id)}
                      className={`w-full text-left px-5 py-3.5 transition-colors ${
                        selected ? 'bg-[#2563EB]/6' : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="h-4 w-4 text-[#2563EB] shrink-0" aria-hidden="true" />
                          <span className="font-medium text-sm text-[#0F172A] truncate">{src.title}</span>
                        </div>
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap ${
                            src.status === 'NEEDS_OCR' || src.status === 'ERROR'
                              ? 'text-[#D97706]'
                              : src.visibility_level === 'PRIVATE_OWNER'
                                ? 'text-[#7C3AED]'
                                : src.visibility_level === 'RESTRICTED_PI_ONLY'
                                  ? 'text-[#DC2626]'
                                  : 'text-[#059669]'
                          }`}
                        >
                          {src.visibility_level === 'PRIVATE_OWNER' ? (
                            <Lock className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <Globe className="h-3 w-3" aria-hidden="true" />
                          )}
                          <span>{src.status !== 'PARSED' ? src.status : visibilityLabel(src.visibility_level)}</span>
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#64748B] font-mono tabular-nums">
                        <span>{src.filename}</span>
                        <span>·</span>
                        <span>{src.span_count ?? 0} sections</span>
                        <span>·</span>
                        <span>{src.uploaded_by}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {isMaximized && (
          <div
            aria-hidden="true"
            onClick={() => setIsMaximized(false)}
            className="fixed inset-0 z-40 bg-[#0F172A]/45 backdrop-blur-[2px]"
          />
        )}
        <section
          className={
            isMaximized
              ? 'fixed inset-2 sm:inset-4 z-50 rounded-2xl border border-[#CBD5E1] bg-white shadow-2xl overflow-hidden flex flex-col'
              : 'lg:col-span-7 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden flex flex-col'
          }
        >
          <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div>
              <h2 className="font-display text-sm font-bold text-[#0F172A]">
                {selectedSource ? `Preview — ${selectedSource.title}` : 'Select a file to inspect'}
              </h2>
              {selectedSource && (
                <p className="font-mono text-[11px] text-[#64748B] mt-0.5">
                  {visibilityLabel(selectedSource.visibility_level)} · SHA-256: {selectedSource.sha256.slice(0, 14)}…
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {selectedSource && (
                <>
                <button
                  type="button"
                  onClick={() => handleDownloadSource(selectedSource)}
                  className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] px-3 py-1.5 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Download</span>
                </button>

                {canManageSelected && (
                  <button
                    type="button"
                    disabled={togglingVis}
                    onClick={() =>
                      handleToggleVisibility(
                        selectedSource,
                        selectedSource.visibility_level === 'PRIVATE_OWNER' ? 'PROJECT_SHARED' : 'PRIVATE_OWNER'
                      )
                    }
                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      selectedSource.visibility_level === 'PRIVATE_OWNER'
                        ? 'border-[#059669]/40 bg-[#059669]/8 text-[#059669] hover:bg-[#059669]/15'
                        : 'border-[#7C3AED]/40 bg-[#7C3AED]/8 text-[#7C3AED] hover:bg-[#7C3AED]/15'
                    }`}
                  >
                    {selectedSource.visibility_level === 'PRIVATE_OWNER' ? (
                      <>
                        <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Make Public</span>
                      </>
                    ) : (
                      <>
                        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Make Private</span>
                      </>
                    )}
                  </button>
                )}

                {canReconstruct &&
                  selectedSource.status === 'PARSED' &&
                  selectedSource.visibility_level === 'PROJECT_SHARED' && (
                    <>
                      <label className="flex items-center gap-1.5 text-xs text-[#64748B] cursor-pointer ml-1">
                        <input
                          type="checkbox"
                          checked={useAi}
                          onChange={(e) => setUseAi(e.target.checked)}
                          className="rounded border-[#CBD5E1]"
                        />
                        <span>AI assist</span>
                      </label>
                      <button
                        type="button"
                        onClick={handleReconstruct}
                        disabled={reconstructing}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
                      >
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{reconstructing ? 'Extracting…' : 'Extract claims'}</span>
                      </button>
                    </>
                  )}

                {canManageSelected && (
                  confirmDeleteId === selectedSource.id ? (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleDeleteSource(selectedSource)}
                        className="rounded-full bg-[#DC2626] px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Confirm delete
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
                      onClick={() => setConfirmDeleteId(selectedSource.id)}
                      aria-label="Delete file"
                      className="rounded-full border border-[#E2E8F0] p-1.5 text-[#64748B] hover:text-[#DC2626]"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )
                )}
                </>
              )}

              <button
                type="button"
                onClick={() => setIsMaximized((v) => !v)}
                aria-label={isMaximized ? 'Exit full screen' : 'Maximise file preview'}
                title={isMaximized ? 'Exit full screen (Esc)' : 'Maximise screen'}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  isMaximized
                    ? 'border-[#0F172A] bg-[#0F172A] text-white hover:bg-[#1E293B]'
                    : 'border-[#E2E8F0] bg-white text-[#0F172A] hover:border-[#2563EB]'
                }`}
              >
                {isMaximized ? (
                  <>
                    <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Exit (Esc)</span>
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                    <span>Maximise</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className={`p-5 space-y-3 overflow-y-auto ${isMaximized ? 'flex-1 min-h-0' : 'max-h-[540px]'}`}>
            {spansLoading ? (
              <p className="text-sm text-[#64748B]">Loading file sections…</p>
            ) : selectedSource && selectedSource.status !== 'PARSED' ? (
              <div className="rounded-xl border border-[#D97706]/30 bg-[#D97706]/8 p-5 space-y-3 text-sm text-[#92400E]">
                <p>
                  This file is currently <code className="font-mono font-bold">{selectedSource.status}</code>
                  {selectedSource.status === 'NEEDS_OCR'
                    ? ' (scanned PDF without an embedded text layer).'
                    : '.'}{' '}
                  You can retry extraction from disk or paste OCR transcript text below.
                </p>
                {canManageSelected && (
                  <div className="space-y-2">
                    <textarea
                      rows={4}
                      value={ocrFallbackText}
                      onChange={(e) => setOcrFallbackText(e.target.value)}
                      placeholder="Optional: paste OCR transcript text extracted externally, then click Retry processing…"
                      className="w-full rounded-xl border border-[#D97706]/30 bg-white p-3 text-xs text-[#0F172A]"
                    />
                    <button
                      type="button"
                      onClick={handleRetryProcessing}
                      disabled={retrying}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>{retrying ? 'Processing…' : 'Retry processing'}</span>
                    </button>
                  </div>
                )}
              </div>
            ) : spans.length === 0 ? (
              <p className="text-sm text-[#64748B]">
                {selectedSource ? 'No extracted sections available for this file.' : 'Upload or select a file on the left to inspect its contents.'}
              </p>
            ) : (
              spans.map((sp) => (
                <div key={sp.id} className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-[#2563EB]">{sp.locator}</span>
                    <span className="font-mono text-[#64748B]">{sp.id}</span>
                  </div>
                  <p className="text-sm text-[#0F172A] leading-relaxed whitespace-pre-wrap">{sp.content}</p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
