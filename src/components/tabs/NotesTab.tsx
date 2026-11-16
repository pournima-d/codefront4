import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CheckSquare,
  Download,
  Eraser,
  Globe,
  Highlighter,
  Indent,
  Italic,
  Link2,
  List,
  ListOrdered,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  Outdent,
  Plus,
  Redo2,
  Save,
  Search,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Trash2,
  Underline,
  Undo2,
} from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import type { NoteItem, Role } from '../../types';

interface NotesTabProps {
  currentUserId: string;
  role: Role;
  onToast: (msg: string, tone?: 'info' | 'error' | 'success') => void;
}

const FONT_OPTIONS = [
  'DM Sans',
  'Plus Jakarta Sans',
  'Georgia',
  'Times New Roman',
  'Arial',
  'JetBrains Mono',
  'Courier New',
];

const SIZE_OPTIONS = [
  { label: '12 pt', value: '2' },
  { label: '14 pt', value: '3' },
  { label: '16 pt', value: '4' },
  { label: '20 pt', value: '5' },
  { label: '26 pt', value: '6' },
  { label: '34 pt', value: '7' },
];

const TEXT_COLORS = ['#0F172A', '#2563EB', '#059669', '#D97706', '#DC2626', '#7C3AED', '#475569'];
const HIGHLIGHT_COLORS = ['transparent', '#FEF08A', '#BBF7D0', '#BFDBFE', '#FECACA', '#E9D5FF'];

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeNoteHtmlClient(rawHtml: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return rawHtml.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml || '<p></p>', 'text/html');
  const blockedTags = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'STYLE']);
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (blockedTags.has(child.tagName)) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc') {
          child.removeAttribute(attr.name);
        } else if (
          (name === 'href' || name === 'src' || name === 'action') &&
          (val.startsWith('javascript:') || val.startsWith('vbscript:') || val.startsWith('data:text/html'))
        ) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML || '<p></p>';
}

export function NotesTab({ currentUserId, role, onToast }: NotesTabProps) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeVersion, setActiveVersion] = useState<number>(1);
  const [saveStatus, setSaveStatus] = useState<'SAVED' | 'UNSAVED' | 'SAVING' | 'CONFLICT'>('SAVED');
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled Research Note');
  const [fontFamily, setFontFamily] = useState('DM Sans');
  const [visibility, setVisibility] = useState<'PROJECT_SHARED' | 'PRIVATE_OWNER'>('PROJECT_SHARED');
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);

  const [searchQuery, setSearchQuery] = useState('');
  const [visFilter, setVisFilter] = useState<'ALL' | 'PROJECT_SHARED' | 'PRIVATE_OWNER'>('ALL');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [showLinkBox, setShowLinkBox] = useState(false);
  const [linkUrl, setLinkUrl] = useState('https://');
  const [showColorMenu, setShowColorMenu] = useState<'fore' | 'hilite' | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  const editorRef = useRef<HTMLDivElement | null>(null);

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

  const updateCountsFromDom = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.innerText || '';
    const trimmed = text.trim();
    setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);
    setCharCount(text.replace(/\n/g, '').length);
  }, []);

  const loadNoteIntoEditor = useCallback(
    (note: NoteItem | null) => {
      setConflictMsg(null);
      if (!note) {
        setSelectedId(null);
        setActiveVersion(1);
        setTitle('Untitled Research Note');
        setFontFamily('DM Sans');
        setVisibility('PROJECT_SHARED');
        setSaveStatus('UNSAVED');
        if (editorRef.current) {
          editorRef.current.innerHTML = '<p><br></p>';
        }
        setWordCount(0);
        setCharCount(0);
        return;
      }
      setSelectedId(note.id);
      setActiveVersion(note.version || 1);
      setTitle(note.title);
      setFontFamily(note.font_family || 'DM Sans');
      setVisibility(note.visibility_level);
      setSaveStatus('SAVED');
      if (editorRef.current) {
        editorRef.current.innerHTML = sanitizeNoteHtmlClient(note.content_html || '<p><br></p>');
      }
      updateCountsFromDom();
    },
    [updateCountsFromDom]
  );

  const loadNotes = useCallback(
    async (selectIdAfter?: string | null) => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await apiFetch<{ notes: NoteItem[] }>('/api/notes');
        setNotes(res.notes);
        const targetId = selectIdAfter !== undefined ? selectIdAfter : selectedId;
        if (targetId) {
          const found = res.notes.find((n) => n.id === targetId);
          if (found) {
            loadNoteIntoEditor(found);
          } else if (res.notes.length > 0) {
            loadNoteIntoEditor(res.notes[0]);
          } else {
            loadNoteIntoEditor(null);
          }
        } else if (res.notes.length > 0 && selectedId === null) {
          loadNoteIntoEditor(res.notes[0]);
        } else if (res.notes.length === 0) {
          loadNoteIntoEditor(null);
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Failed to load notes';
        setLoadError(msg);
        onToast(msg, 'error');
      } finally {
        setLoading(false);
      }
    },
    [loadNoteIntoEditor, onToast, selectedId]
  );

  useEffect(() => {
    void loadNotes(undefined);
  }, []);

  const canCreate = role !== 'AUDITOR';
  const activeNote = notes.find((n) => n.id === selectedId) || null;
  const canEditActive =
    canCreate &&
    (!activeNote ||
      activeNote.author_id === currentUserId ||
      (activeNote.visibility_level === 'PROJECT_SHARED' && role === 'PI_LEAD'));

  const markDirty = () => {
    if (!canEditActive) return;
    setSaveStatus((prev) => (prev === 'CONFLICT' ? 'CONFLICT' : 'UNSAVED'));
  };

  const execCmd = (command: string, value?: string) => {
    if (!canEditActive) return;
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateCountsFromDom();
    markDirty();
  };

  const insertChecklistItem = () => {
    if (!canEditActive) return;
    editorRef.current?.focus();
    document.execCommand(
      'insertHTML',
      false,
      '<div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><input type="checkbox" /> <span>Action item</span></div>'
    );
    updateCountsFromDom();
    markDirty();
  };

  const insertTable = () => {
    if (!canEditActive) return;
    editorRef.current?.focus();
    document.execCommand(
      'insertHTML',
      false,
      '<table style="width:100%;border-collapse:collapse;margin:10px 0;"><thead><tr><th style="border:1px solid #CBD5E1;padding:6px;background:#F8FAFC;text-align:left;">Parameter</th><th style="border:1px solid #CBD5E1;padding:6px;background:#F8FAFC;text-align:left;">Value</th><th style="border:1px solid #CBD5E1;padding:6px;background:#F8FAFC;text-align:left;">Observation</th></tr></thead><tbody><tr><td style="border:1px solid #CBD5E1;padding:6px;">Sample A</td><td style="border:1px solid #CBD5E1;padding:6px;">—</td><td style="border:1px solid #CBD5E1;padding:6px;">—</td></tr><tr><td style="border:1px solid #CBD5E1;padding:6px;">Sample B</td><td style="border:1px solid #CBD5E1;padding:6px;">—</td><td style="border:1px solid #CBD5E1;padding:6px;">—</td></tr></tbody></table><p><br></p>'
    );
    updateCountsFromDom();
    markDirty();
  };

  const applyLink = () => {
    const trimmed = linkUrl.trim();
    if (!trimmed || trimmed === 'https://' || !/^https?:\/\//i.test(trimmed)) {
      if (trimmed && trimmed !== 'https://') {
        onToast('Hyperlinks must start with http:// or https://.', 'error');
      }
      setShowLinkBox(false);
      return;
    }
    execCmd('createLink', trimmed);
    setShowLinkBox(false);
    setLinkUrl('https://');
  };

  const handleNewNote = () => {
    if (!canCreate) return;
    loadNoteIntoEditor(null);
    setConfirmDeleteId(null);
    editorRef.current?.focus();
  };

  const performSave = useCallback(
    async (isAuto = false) => {
      if (saving || !canEditActive) return;
      if (isAuto && !selectedId) return;
      setSaving(true);
      setSaveStatus('SAVING');
      setConflictMsg(null);
      const html = sanitizeNoteHtmlClient(editorRef.current?.innerHTML || '<p></p>');
      const plain = editorRef.current?.innerText || '';
      try {
        if (selectedId) {
          const res = await apiFetch<{ note: NoteItem }>(`/api/notes/${selectedId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              title: title.trim() || 'Untitled Research Note',
              content_html: html,
              plain_text: plain,
              font_family: fontFamily,
              visibility_level: visibility,
              expected_version: activeVersion,
            }),
          });
          setActiveVersion(res.note.version || activeVersion + 1);
          setNotes((prev) => prev.map((n) => (n.id === res.note.id ? res.note : n)));
          setSaveStatus('SAVED');
          if (!isAuto) {
            onToast(`Saved "${res.note.title}" (v${res.note.version || activeVersion + 1}).`, 'success');
          }
        } else {
          const res = await apiFetch<{ note: NoteItem }>('/api/notes', {
            method: 'POST',
            body: JSON.stringify({
              title: title.trim() || 'Untitled Research Note',
              content_html: html,
              plain_text: plain,
              font_family: fontFamily,
              visibility_level: visibility,
            }),
          });
          await loadNotes(res.note.id);
          onToast(`Created note "${res.note.title}".`, 'success');
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setSaveStatus('CONFLICT');
          setConflictMsg(err.message);
          onToast('Save blocked by newer server version — reload latest note before saving.', 'error');
        } else {
          setSaveStatus('UNSAVED');
          if (!isAuto) {
            onToast(err instanceof ApiError ? err.message : 'Failed to save note', 'error');
          }
        }
      } finally {
        setSaving(false);
      }
    },
    [activeVersion, canEditActive, fontFamily, loadNotes, onToast, saving, selectedId, title, visibility]
  );

  // Debounced autosave every 3s for already-created notes when modified
  useEffect(() => {
    if (!selectedId || !canEditActive || saveStatus !== 'UNSAVED' || saving || loading) return;
    const timer = setTimeout(() => {
      void performSave(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, [selectedId, canEditActive, saveStatus, saving, loading, title, fontFamily, visibility, wordCount, charCount, performSave]);

  const handleSave = () => {
    void performSave(false);
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setSelectedId(null);
      await loadNotes(null);
      onToast('Note deleted.', 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Failed to delete note', 'error');
    }
  };

  const exportDocument = (format: 'doc' | 'html') => {
    const htmlBody = sanitizeNoteHtmlClient(editorRef.current?.innerHTML || '');
    const safeTitle = (title.trim() || 'research-note').replace(/[^a-zA-Z0-9._-]/g, '-');
    const escapedTitle = escapeHtmlAttr(title.trim() || 'Untitled Research Note');
    const escapedFont = escapeHtmlAttr(fontFamily);
    const docHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapedTitle}</title><style>body{font-family:"${escapedFont}",sans-serif;max-width:780px;margin:40px auto;line-height:1.6;color:#0F172A;}table{border-collapse:collapse;width:100%;}td,th{border:1px solid #CBD5E1;padding:6px;}</style></head><body><h1>${escapedTitle}</h1>${htmlBody}</body></html>`;
    const blob = new Blob([docHtml], {
      type: format === 'doc' ? 'application/msword' : 'text/html;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredNotes = notes.filter((n) => {
    if (visFilter !== 'ALL' && n.visibility_level !== visFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        n.title.toLowerCase().includes(q) ||
        n.plain_text.toLowerCase().includes(q) ||
        n.author_name.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#0F172A]">Notes Studio</h1>
          <p className="text-sm text-[#64748B]">
            Full rich-text research notebook with font styling, tables, checklists, Word export, and Private vs. Public access control.
          </p>
        </div>
        {canCreate ? (
          <button
            type="button"
            onClick={handleNewNote}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#2563EB] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8]"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>New note</span>
          </button>
        ) : (
          <span className="rounded-full border border-[#E2E8F0] bg-white px-3.5 py-1.5 text-xs font-semibold text-[#64748B]">
            Read-only auditor view
          </span>
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
            onClick={() => void loadNotes(selectedId)}
            className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Saved Notes Sidebar */}
        <aside className="lg:col-span-4 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden">
          <div className="p-3.5 border-b border-[#E2E8F0] space-y-2.5">
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search notes…"
                className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] pl-8 pr-3 py-1.5 text-xs text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
              />
            </div>
            <div className="flex gap-1 text-[11px] font-semibold">
              {[
                { key: 'ALL', label: 'All' },
                { key: 'PROJECT_SHARED', label: 'Public' },
                { key: 'PRIVATE_OWNER', label: 'My Private' },
              ].map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setVisFilter(f.key as typeof visFilter)}
                  className={`flex-1 rounded-lg py-1 transition-colors ${
                    visFilter === f.key
                      ? 'bg-[#0F172A] text-white'
                      : 'bg-[#F8FAFC] text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="p-6 text-xs text-[#64748B]">Loading saved notes…</div>
          ) : filteredNotes.length === 0 ? (
            <div className="p-6 text-center text-xs text-[#64748B]">
              No saved notes yet. Write your first note in the editor on the right and click Save.
            </div>
          ) : (
            <ul className="divide-y divide-[#E2E8F0] max-h-[600px] overflow-y-auto">
              {filteredNotes.map((n) => {
                const isSel = n.id === selectedId;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(null);
                        loadNoteIntoEditor(n);
                      }}
                      className={`w-full text-left px-4 py-3 transition-colors ${
                        isSel ? 'bg-[#2563EB]/6' : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold text-[#0F172A] truncate">{n.title}</span>
                        <span
                          className={`inline-flex items-center gap-1 text-[10px] font-semibold shrink-0 ${
                            n.visibility_level === 'PRIVATE_OWNER' ? 'text-[#7C3AED]' : 'text-[#059669]'
                          }`}
                        >
                          {n.visibility_level === 'PRIVATE_OWNER' ? (
                            <Lock className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <Globe className="h-3 w-3" aria-hidden="true" />
                          )}
                          <span>{n.visibility_level === 'PRIVATE_OWNER' ? 'Private' : 'Public'}</span>
                        </span>
                      </div>
                      <p className="text-xs text-[#64748B] truncate mt-0.5">
                        {n.plain_text || 'Empty document'}
                      </p>
                      <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono tabular-nums text-[#94A3B8]">
                        <span>{n.author_name}</span>
                        <span>{n.word_count} words</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Word-Style Document Editor */}
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
              : 'lg:col-span-8 rounded-2xl border border-[#E2E8F0] bg-white overflow-hidden flex flex-col'
          }
        >
          {/* Document Title, Visibility & Actions Bar */}
          <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3">
            <input
              type="text"
              aria-label="Note title"
              value={title}
              disabled={!canEditActive}
              onChange={(e) => {
                setTitle(e.target.value);
                markDirty();
              }}
              placeholder="Document title…"
              className="flex-1 min-w-[200px] font-display text-lg font-bold text-[#0F172A] bg-transparent border-b border-transparent focus:border-[#2563EB] focus:outline-none py-0.5 disabled:opacity-70"
            />

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-semibold ${
                  saveStatus === 'CONFLICT'
                    ? 'bg-[#DC2626]/10 text-[#DC2626]'
                    : saveStatus === 'UNSAVED'
                      ? 'bg-[#D97706]/10 text-[#B45309]'
                      : saveStatus === 'SAVING'
                        ? 'bg-[#2563EB]/10 text-[#2563EB]'
                        : 'bg-[#059669]/10 text-[#059669]'
                }`}
              >
                {saveStatus === 'CONFLICT'
                  ? 'Version conflict'
                  : saveStatus === 'SAVING'
                    ? 'Saving…'
                    : saveStatus === 'UNSAVED'
                      ? selectedId
                        ? 'Unsaved edits'
                        : 'Unsaved draft'
                      : `Saved v${activeVersion}`}
              </span>
              <div className="inline-flex rounded-full border border-[#E2E8F0] bg-[#F8FAFC] p-0.5 text-xs font-semibold">
                <button
                  type="button"
                  disabled={!canEditActive}
                  onClick={() => {
                    setVisibility('PROJECT_SHARED');
                    markDirty();
                  }}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 transition-colors ${
                    visibility === 'PROJECT_SHARED' ? 'bg-[#059669] text-white' : 'text-[#64748B]'
                  }`}
                >
                  <Globe className="h-3 w-3" aria-hidden="true" />
                  <span>Public</span>
                </button>
                <button
                  type="button"
                  disabled={!canEditActive}
                  onClick={() => {
                    setVisibility('PRIVATE_OWNER');
                    markDirty();
                  }}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 transition-colors ${
                    visibility === 'PRIVATE_OWNER' ? 'bg-[#7C3AED] text-white' : 'text-[#64748B]'
                  }`}
                >
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  <span>Private</span>
                </button>
              </div>

              {canEditActive && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#2563EB] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{saving ? 'Saving…' : selectedId ? 'Save note' : 'Create & save'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => exportDocument('doc')}
                className="inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] px-3 py-1.5 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
                title="Download Word (.doc)"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>.doc</span>
              </button>

              <button
                type="button"
                onClick={() => setIsMaximized((v) => !v)}
                aria-label={isMaximized ? 'Exit full screen' : 'Maximise note editor'}
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

              {selectedId && canEditActive && (
                confirmDeleteId === selectedId ? (
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleDelete(selectedId)}
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
                    onClick={() => setConfirmDeleteId(selectedId)}
                    aria-label="Delete note"
                    className="rounded-full border border-[#E2E8F0] p-1.5 text-[#64748B] hover:text-[#DC2626] hover:border-[#DC2626]/40"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )
              )}
            </div>
          </div>

          {conflictMsg && selectedId && (
            <div
              role="alert"
              className="px-5 py-2.5 bg-[#DC2626]/8 border-b border-[#DC2626]/20 flex flex-wrap items-center justify-between gap-2 text-xs text-[#991B1B]"
            >
              <span>{conflictMsg}</span>
              <button
                type="button"
                onClick={() => void loadNotes(selectedId)}
                className="rounded-full bg-[#DC2626] px-3 py-1 font-semibold text-white hover:bg-[#B91C1C]"
              >
                Reload latest version
              </button>
            </div>
          )}

          {/* Word-Style Formatting Ribbon */}
          <div className="px-4 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0] flex flex-wrap items-center gap-1.5 text-xs relative">
            <select
              aria-label="Font family"
              value={fontFamily}
              disabled={!canEditActive}
              onChange={(e) => {
                setFontFamily(e.target.value);
                execCmd('fontName', e.target.value);
              }}
              className="rounded-lg border border-[#E2E8F0] bg-white px-2 py-1 text-xs text-[#0F172A]"
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>

            <select
              aria-label="Font size"
              defaultValue="3"
              disabled={!canEditActive}
              onChange={(e) => execCmd('fontSize', e.target.value)}
              className="rounded-lg border border-[#E2E8F0] bg-white px-2 py-1 text-xs text-[#0F172A]"
            >
              {SIZE_OPTIONS.map((sz) => (
                <option key={sz.value} value={sz.value}>
                  {sz.label}
                </option>
              ))}
            </select>

            <select
              aria-label="Paragraph style"
              defaultValue="P"
              disabled={!canEditActive}
              onChange={(e) => execCmd('formatBlock', e.target.value)}
              className="rounded-lg border border-[#E2E8F0] bg-white px-2 py-1 text-xs text-[#0F172A]"
            >
              <option value="P">Normal text</option>
              <option value="H1">Heading 1</option>
              <option value="H2">Heading 2</option>
              <option value="H3">Heading 3</option>
              <option value="BLOCKQUOTE">Quote block</option>
              <option value="PRE">Code block</option>
            </select>

            <span className="h-5 w-px bg-[#E2E8F0] mx-1" aria-hidden="true" />

            {[
              { cmd: 'bold', icon: Bold, label: 'Bold' },
              { cmd: 'italic', icon: Italic, label: 'Italic' },
              { cmd: 'underline', icon: Underline, label: 'Underline' },
              { cmd: 'strikeThrough', icon: Strikethrough, label: 'Strikethrough' },
              { cmd: 'superscript', icon: Superscript, label: 'Superscript' },
              { cmd: 'subscript', icon: Subscript, label: 'Subscript' },
            ].map((b) => {
              const Icon = b.icon;
              return (
                <button
                  key={b.cmd}
                  type="button"
                  disabled={!canEditActive}
                  onClick={() => execCmd(b.cmd)}
                  aria-label={b.label}
                  title={b.label}
                  className="rounded-lg p-1.5 text-[#334155] hover:bg-white hover:text-[#0F172A] disabled:opacity-40"
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}

            <span className="h-5 w-px bg-[#E2E8F0] mx-1" aria-hidden="true" />

            {/* Text & Highlight Color Popovers */}
            <div className="relative">
              <button
                type="button"
                disabled={!canEditActive}
                onClick={() => setShowColorMenu((v) => (v === 'fore' ? null : 'fore'))}
                title="Text color"
                className="rounded-lg px-2 py-1 font-bold text-[#0F172A] hover:bg-white border border-transparent hover:border-[#E2E8F0]"
              >
                A
              </button>
              {showColorMenu === 'fore' && (
                <div className="absolute left-0 top-8 z-20 flex gap-1.5 rounded-xl border border-[#E2E8F0] bg-white p-2 shadow-md">
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Color ${c}`}
                      onClick={() => {
                        execCmd('foreColor', c);
                        setShowColorMenu(null);
                      }}
                      className="h-5 w-5 rounded-full border border-[#CBD5E1]"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                disabled={!canEditActive}
                onClick={() => setShowColorMenu((v) => (v === 'hilite' ? null : 'hilite'))}
                title="Highlight color"
                className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
              >
                <Highlighter className="h-3.5 w-3.5" />
              </button>
              {showColorMenu === 'hilite' && (
                <div className="absolute left-0 top-8 z-20 flex gap-1.5 rounded-xl border border-[#E2E8F0] bg-white p-2 shadow-md">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Highlight ${c}`}
                      onClick={() => {
                        execCmd('hiliteColor', c);
                        setShowColorMenu(null);
                      }}
                      className="h-5 w-5 rounded-full border border-[#CBD5E1]"
                      style={{ backgroundColor: c === 'transparent' ? '#FFFFFF' : c }}
                    />
                  ))}
                </div>
              )}
            </div>

            <span className="h-5 w-px bg-[#E2E8F0] mx-1" aria-hidden="true" />

            {[
              { cmd: 'justifyLeft', icon: AlignLeft, label: 'Align left' },
              { cmd: 'justifyCenter', icon: AlignCenter, label: 'Align center' },
              { cmd: 'justifyRight', icon: AlignRight, label: 'Align right' },
              { cmd: 'justifyFull', icon: AlignJustify, label: 'Justify' },
              { cmd: 'insertUnorderedList', icon: List, label: 'Bullet list' },
              { cmd: 'insertOrderedList', icon: ListOrdered, label: 'Numbered list' },
              { cmd: 'outdent', icon: Outdent, label: 'Decrease indent' },
              { cmd: 'indent', icon: Indent, label: 'Increase indent' },
            ].map((b) => {
              const Icon = b.icon;
              return (
                <button
                  key={b.cmd}
                  type="button"
                  disabled={!canEditActive}
                  onClick={() => execCmd(b.cmd)}
                  aria-label={b.label}
                  title={b.label}
                  className="rounded-lg p-1.5 text-[#334155] hover:bg-white hover:text-[#0F172A] disabled:opacity-40"
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}

            <span className="h-5 w-px bg-[#E2E8F0] mx-1" aria-hidden="true" />

            <button
              type="button"
              disabled={!canEditActive}
              onClick={insertChecklistItem}
              title="Insert checklist item"
              className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
            >
              <CheckSquare className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={!canEditActive}
              onClick={insertTable}
              title="Insert 3x3 table"
              className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
            >
              <Table className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={!canEditActive}
              onClick={() => execCmd('insertHorizontalRule')}
              title="Insert divider line"
              className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>

            <div className="relative">
              <button
                type="button"
                disabled={!canEditActive}
                onClick={() => setShowLinkBox((v) => !v)}
                title="Insert hyperlink"
                className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
              >
                <Link2 className="h-3.5 w-3.5" />
              </button>
              {showLinkBox && (
                <div className="absolute right-0 top-8 z-20 flex items-center gap-1.5 rounded-xl border border-[#E2E8F0] bg-white p-2 shadow-md">
                  <input
                    type="url"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    placeholder="https://…"
                    className="w-44 rounded-lg border border-[#E2E8F0] px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={applyLink}
                    className="rounded-lg bg-[#2563EB] px-2.5 py-1 text-xs font-semibold text-white"
                  >
                    Add
                  </button>
                </div>
              )}
            </div>

            <span className="h-5 w-px bg-[#E2E8F0] mx-1" aria-hidden="true" />

            <button
              type="button"
              disabled={!canEditActive}
              onClick={() => execCmd('undo')}
              title="Undo"
              className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={!canEditActive}
              onClick={() => execCmd('redo')}
              title="Redo"
              className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={!canEditActive}
              onClick={() => execCmd('removeFormat')}
              title="Clear formatting"
              className="rounded-lg p-1.5 text-[#334155] hover:bg-white"
            >
              <Eraser className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Paper Canvas */}
          <div className={`bg-[#F8FAFC] p-5 sm:p-7 flex-1 ${isMaximized ? 'overflow-y-auto' : ''}`}>
            <div className={`mx-auto rounded-xl border border-[#E2E8F0] bg-white p-6 sm:p-10 shadow-xs ${isMaximized ? 'max-w-5xl min-h-full' : 'max-w-3xl min-h-[420px]'}`}>
              <div
                ref={editorRef}
                contentEditable={canEditActive}
                suppressContentEditableWarning
                onInput={() => {
                  updateCountsFromDom();
                  markDirty();
                }}
                style={{ fontFamily }}
                className="min-h-[360px] text-[15px] leading-relaxed text-[#0F172A] focus:outline-none [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-3 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:border-[#94A3B8] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-[#475569] [&_a]:text-[#2563EB] [&_a]:underline"
              />
            </div>
          </div>

          {/* Bottom Document Status Footer */}
          <div className="px-5 py-2.5 border-t border-[#E2E8F0] bg-white flex flex-wrap items-center justify-between gap-2 text-xs text-[#64748B]">
            <div className="flex items-center gap-3 font-mono tabular-nums">
              <span>{wordCount} words</span>
              <span>·</span>
              <span>{charCount} chars</span>
              <span>·</span>
              <span>{fontFamily}</span>
            </div>
            <div>
              {activeNote ? (
                <span>
                  Author: <strong className="text-[#0F172A]">{activeNote.author_name}</strong> ·{' '}
                  {visibility === 'PRIVATE_OWNER'
                    ? 'Private — visible only to you'
                    : 'Public — shared across workspace'}
                </span>
              ) : (
                <span>
                  Unsaved draft ·{' '}
                  {visibility === 'PRIVATE_OWNER'
                    ? 'Will be saved privately (only you)'
                    : 'Will be shared publicly with team'}
                </span>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
