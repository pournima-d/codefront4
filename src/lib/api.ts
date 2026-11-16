const CSRF_STORAGE_KEY = 'baton_csrf_token';
const SESSION_STORAGE_KEY = 'baton_session_token';

function readStorage(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (value) {
      window.sessionStorage.setItem(key, value);
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // ignore storage errors
  }
}

let csrfTokenStore: string | null = readStorage(CSRF_STORAGE_KEY);
let sessionTokenStore: string | null = readStorage(SESSION_STORAGE_KEY);
let activeProjectIdStore: string = readStorage('baton_active_project_id') || 'PRJ-MAIN-01';

export function setActiveProjectId(projectId: string): void {
  activeProjectIdStore = projectId || 'PRJ-MAIN-01';
  writeStorage('baton_active_project_id', activeProjectIdStore);
}

export function getActiveProjectId(): string {
  return activeProjectIdStore;
}

export function setCsrfToken(token: string | null): void {
  csrfTokenStore = token;
  writeStorage(CSRF_STORAGE_KEY, token);
}

export function getCsrfToken(): string | null {
  return csrfTokenStore;
}

export function setSessionToken(token: string | null): void {
  sessionTokenStore = token;
  writeStorage(SESSION_STORAGE_KEY, token);
}

export function getSessionToken(): string | null {
  return sessionTokenStore;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function attachProjectParam(url: string): string {
  if (
    !url.startsWith('/api/') ||
    url.startsWith('/api/auth/') ||
    url.startsWith('/api/health') ||
    url.startsWith('/api/drafts/') ||
    url.startsWith('/api/presence/') ||
    url.startsWith('/api/projects') ||
    url.includes('projectId=')
  ) {
    return url;
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}projectId=${encodeURIComponent(activeProjectIdStore)}`;
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('Content-Type') && options.method && options.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }
  if (sessionTokenStore) {
    headers.set('X-Baton-Session', sessionTokenStore);
  }
  if (csrfTokenStore && options.method && options.method.toUpperCase() !== 'GET') {
    headers.set('X-CSRF-Token', csrfTokenStore);
  }

  try {
    const response = await fetch(attachProjectParam(url), {
      ...options,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    let data: any = null;
    if (contentType.includes('application/json')) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }

    if (
      response.status === 401 &&
      typeof window !== 'undefined' &&
      !url.startsWith('/api/auth/login') &&
      !url.startsWith('/api/auth/register') &&
      !url.startsWith('/api/auth/reauth') &&
      !url.startsWith('/api/auth/me')
    ) {
      window.dispatchEvent(new CustomEvent('baton:session-expired'));
    }

    if (!response.ok) {
      throw new ApiError(
        data?.error || `Request failed (${response.status})`,
        response.status,
        data?.code
      );
    }

    return data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('Request timed out after 10 seconds.', 408);
    }
    throw new ApiError(err instanceof Error ? err.message : 'Network request failed.', 0);
  } finally {
    clearTimeout(timeout);
  }
}
