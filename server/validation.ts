import path from 'node:path';
import { EVIDENCE_STATES, type EvidenceState, type Role, type VisibilityLevel, type WorkflowStageId } from '../src/types.ts';

export const ALLOWED_ROLES: Role[] = [
  'PI_LEAD',
  'RESEARCHER',
  'REVIEWER',
  'INCOMING_MEMBER',
  'AUDITOR',
];

export const ALLOWED_VISIBILITIES: VisibilityLevel[] = [
  'PROJECT_SHARED',
  'PRIVATE_OWNER',
  'RESTRICTED_PI_ONLY',
];

export const ALLOWED_STAGES: WorkflowStageId[] = ['01', '02', '03', '04', '05'];

export const ALLOWED_RECORD_TYPES = new Set([
  'OBJECTIVE',
  'EXPERIMENT',
  'DECISION',
  'RESULT',
  'RISK',
  'GAP',
  'TASK',
  'DEPENDENCY',
  'RECURRING_PROBLEM',
  'CONTACT',
]);

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
export const ALLOWED_EXTENSIONS = new Set(['.pdf', '.md', '.txt', '.csv', '.json']);

const DISALLOWED_MIME_PREFIXES = [
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-sh',
  'application/javascript',
  'text/javascript',
  'text/html',
  'image/',
  'video/',
  'audio/',
];

export function isValidId(value: unknown, maxLen = 96): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= maxLen && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function isValidEmail(email: string): boolean {
  if (email.length < 5 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function isValidRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALLOWED_ROLES as string[]).includes(value);
}

export function isValidVisibility(value: unknown): value is VisibilityLevel {
  return typeof value === 'string' && (ALLOWED_VISIBILITIES as string[]).includes(value);
}

export function isValidEvidenceState(value: unknown): value is EvidenceState {
  return typeof value === 'string' && (EVIDENCE_STATES as string[]).includes(value);
}

export function sanitizeFilename(rawName: string): string {
  const base = path.basename(rawName || 'upload.txt');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'upload.txt';
}

export function validatePagination(
  limitRaw: unknown,
  offsetRaw: unknown,
  maxLimit = 250
): { ok: true; limit: number; offset: number } | { ok: false; error: string } {
  let limit = maxLimit;
  let offset = 0;
  if (limitRaw !== undefined && limitRaw !== '') {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > maxLimit) {
      return { ok: false, error: `Pagination limit must be an integer between 1 and ${maxLimit}.` };
    }
    limit = n;
  }
  if (offsetRaw !== undefined && offsetRaw !== '') {
    const n = Number(offsetRaw);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) {
      return { ok: false, error: 'Pagination offset must be a non-negative integer.' };
    }
    offset = n;
  }
  return { ok: true, limit, offset };
}

export function validateUploadedFileContent(
  filename: string,
  mimetype: string | undefined,
  buffer: Buffer
): { ok: true; ext: string } | { ok: false; status: number; error: string } {
  if (!filename || typeof filename !== 'string') {
    return { ok: false, status: 400, error: 'Valid filename is required.' };
  }

  // Reject null bytes or traversal characters in raw name
  if (filename.includes('\0') || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    const extCheck = path.extname(path.basename(filename)).toLowerCase();
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      // Allow stripping only if extension valid? No: explicitly reject path traversal attempts cleanly with 400!
      if (/\.\.[\\/]/.test(filename) || filename.startsWith('/') || /^[A-Za-z]:\\/.test(filename)) {
        return { ok: false, status: 400, error: 'Invalid filename containing path traversal characters.' };
      }
    }
    if (!ALLOWED_EXTENSIONS.has(extCheck)) {
      return {
        ok: false,
        status: 415,
        error: `Unsupported file type (${extCheck || 'unknown'}). Allowed: PDF, MD, TXT, CSV, JSON.`,
      };
    }
  }

  const ext = path.extname(path.basename(filename)).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      status: 415,
      error: `Unsupported file type (${ext || 'unknown'}). Allowed: PDF, MD, TXT, CSV, JSON.`,
    };
  }

  if (buffer.length === 0) {
    return { ok: false, status: 400, error: 'Empty files cannot be uploaded.' };
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: 'File exceeds the 2 MB maximum upload size.' };
  }

  const lowerMime = (mimetype || '').toLowerCase().trim();
  if (lowerMime && DISALLOWED_MIME_PREFIXES.some((p) => lowerMime.startsWith(p))) {
    return { ok: false, status: 415, error: `MIME type "${mimetype}" is not permitted for upload.` };
  }

  if (ext === '.pdf') {
    if (lowerMime && !['application/pdf', 'application/octet-stream', 'application/x-pdf'].includes(lowerMime)) {
      return { ok: false, status: 415, error: `Invalid MIME type "${mimetype}" for .pdf upload.` };
    }
    const headerSlice = buffer.subarray(0, Math.min(1024, buffer.length)).toString('latin1');
    if (!headerSlice.includes('%PDF-')) {
      return { ok: false, status: 422, error: 'Malformed PDF file: missing %PDF- header signature.' };
    }
    return { ok: true, ext };
  }

  // Non-PDF text formats (.md, .txt, .csv, .json): forbid binary null bytes
  if (buffer.includes(0)) {
    return { ok: false, status: 422, error: `Malformed ${ext} file: binary null bytes are not allowed.` };
  }
  const text = buffer.toString('utf8');
  if (!text.trim()) {
    return { ok: false, status: 400, error: 'Uploaded text file contains only whitespace.' };
  }

  if (ext === '.json') {
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') {
        return { ok: false, status: 422, error: 'JSON upload must represent an object or array.' };
      }
    } catch {
      return { ok: false, status: 422, error: 'Malformed JSON file: unable to parse JSON syntax.' };
    }
  }

  return { ok: true, ext };
}

/**
 * Strips dangerous HTML tags, event handlers, and scriptable URIs from rich-text Notes Studio HTML.
 */
export function sanitizeNoteHtml(rawHtml: string): string {
  if (!rawHtml || typeof rawHtml !== 'string') return '<p></p>';
  let html = rawHtml.slice(0, 250_000);

  // Strip dangerous block tags and their inner content
  html = html.replace(/<\s*(script|style|iframe|object|embed|svg|math|form|noscript|meta|link|base)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '');
  // Strip self-closing or unclosed dangerous tags
  html = html.replace(/<\s*(?:script|style|iframe|object|embed|svg|math|form|input|button|textarea|select|meta|link|base)\b[^>]*\/?>/gi, '');
  // Strip HTML comments (can hide payloads)
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // Strip inline on* event handlers (double-quoted, single-quoted, or unquoted)
  html = html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Strip srcdoc or formaction attributes
  html = html.replace(/\s+(?:srcdoc|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Neutralize javascript:, vbscript:, and data: URIs inside href/src/action
  html = html.replace(
    /(\s(?:href|src|action)\s*=\s*["']?\s*)(?:javascript|vbscript|data):[^"'\s>]*/gi,
    '$1#blocked'
  );
  // Strip CSS expression() / url() inside style attributes
  html = html.replace(/style\s*=\s*"([^"]*)"/gi, (_m, css: string) => {
    const cleanCss = css.replace(/expression\s*\(|javascript:|url\s*\(/gi, '');
    return `style="${cleanCss}"`;
  });
  html = html.replace(/style\s*=\s*'([^']*)'/gi, (_m, css: string) => {
    const cleanCss = css.replace(/expression\s*\(|javascript:|url\s*\(/gi, '');
    return `style='${cleanCss}'`;
  });

  return html.trim() || '<p></p>';
}

export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export function validateStrictIsoDate(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Date must be a string in YYYY-MM-DD or ISO-8601 format.' };
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
    return { ok: false, error: `Invalid date format "${trimmed}". Expected YYYY-MM-DD or ISO-8601.` };
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    return { ok: false, error: `Unparseable date "${trimmed}".` };
  }
  return { ok: true, value: trimmed };
}
