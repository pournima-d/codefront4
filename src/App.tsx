import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CheckSquare,
  Compass,
  EyeOff,
  FileText,
  FolderUp,
  GitBranch,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  NotebookPen,
  Radar,
  RefreshCw,
  Shield,
  Users,
  X,
} from 'lucide-react';
import { BatonLogo } from './components/BatonLogo';
import { LoginScreen } from './components/LoginScreen';
import { SensitiveAuthModal } from './components/SensitiveAuthModal';
import { AuditTab } from './components/tabs/AuditTab';
import { ColdStartTab } from './components/tabs/ColdStartTab';
import { HandoverTab } from './components/tabs/HandoverTab';
import { MapTab } from './components/tabs/MapTab';
import { NotesTab } from './components/tabs/NotesTab';
import { OverviewTab } from './components/tabs/OverviewTab';
import { RadarTab } from './components/tabs/RadarTab';
import { RecordsTab } from './components/tabs/RecordsTab';
import { RedactionTab } from './components/tabs/RedactionTab';
import { ReviewTab } from './components/tabs/ReviewTab';
import { SourcesTab } from './components/tabs/SourcesTab';
import { TeamTab } from './components/tabs/TeamTab';
import { apiFetch, getActiveProjectId, setActiveProjectId, setCsrfToken, setSessionToken } from './lib/api';
import { ROLE_TABS, type ProjectInfo, type Role, type SessionInfo, type TabKey } from './types';

interface NavMeta {
  key: TabKey;
  label: string;
  group: 'Workspace & Capture' | 'Evidence & Handover' | 'Continuity Risk & Audit';
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_GROUPS: Array<NavMeta['group']> = [
  'Workspace & Capture',
  'Evidence & Handover',
  'Continuity Risk & Audit',
];

const NAV_ITEMS: NavMeta[] = [
  { key: 'overview', label: 'Overview', group: 'Workspace & Capture', icon: LayoutDashboard },
  { key: 'sources', label: 'Files & Vault', group: 'Workspace & Capture', icon: FolderUp },
  { key: 'notes', label: 'Notes Studio', group: 'Workspace & Capture', icon: NotebookPen },
  { key: 'team', label: 'Team & Work', group: 'Workspace & Capture', icon: Users },
  { key: 'map', label: 'Knowledge Map', group: 'Evidence & Handover', icon: GitBranch },
  { key: 'records', label: 'Records', group: 'Evidence & Handover', icon: FileText },
  { key: 'review', label: 'Review Queue', group: 'Evidence & Handover', icon: CheckSquare },
  { key: 'handover', label: 'Handover', group: 'Evidence & Handover', icon: Compass },
  { key: 'radar', label: 'Debt Radar', group: 'Continuity Risk & Audit', icon: Radar },
  { key: 'coldstart', label: 'Cold-Start Test', group: 'Continuity Risk & Audit', icon: HelpCircle },
  { key: 'redaction', label: 'Redactions', group: 'Continuity Risk & Audit', icon: EyeOff },
  { key: 'audit', label: 'Audit Log', group: 'Continuity Risk & Audit', icon: Activity },
];

function parseHashRoute(): { tab: TabKey | 'login'; recordId: string | null } {
  const raw = window.location.hash || '#/login';
  const cleaned = raw.replace(/^#\/?/, '');
  const [pathPart, queryPart] = cleaned.split('?');
  const params = new URLSearchParams(queryPart || '');
  const recordId = params.get('id');
  const validTabs: Array<TabKey | 'login'> = [
    'login',
    'overview',
    'sources',
    'notes',
    'map',
    'records',
    'review',
    'handover',
    'team',
    'radar',
    'coldstart',
    'redaction',
    'audit',
  ];
  const matched = validTabs.includes(pathPart as TabKey | 'login')
    ? (pathPart as TabKey | 'login')
    : 'overview';
  return { tab: matched, recordId };
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [booting, setBooting] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<string>(() => getActiveProjectId());
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [toast, setToast] = useState<{ msg: string; tone: 'info' | 'error' | 'success' } | null>(null);
  const [reauthModal, setReauthModal] = useState<{
    open: boolean;
    label: string;
    onSuccess: (() => void) | null;
  }>({ open: false, label: '', onSuccess: null });

  const showToast = useCallback((msg: string, tone: 'info' | 'error' | 'success' = 'info') => {
    setToast({ msg, tone });
  }, []);

  const activeProjectObj = projects.find((p) => p.id === activeProject);
  const effectiveRole: Role =
    activeProjectObj?.member_role || session?.user.role || 'RESEARCHER';

  const loadProjects = useCallback(async () => {
    try {
      const res = await apiFetch<{ projects: ProjectInfo[] }>('/api/projects');
      setProjects(res.projects);
      if (res.projects.length > 0 && !res.projects.some((p) => p.id === getActiveProjectId())) {
        const firstId = res.projects[0].id;
        setActiveProjectId(firstId);
        setActiveProject(firstId);
      }
    } catch {
      // ignore if unauthenticated
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadProjects();
    const onProjectsChanged = (ev: Event) => {
      const custom = ev as CustomEvent<string | undefined>;
      if (custom.detail) {
        setActiveProjectId(custom.detail);
        setActiveProject(custom.detail);
      }
      void loadProjects();
      setRefreshNonce((n) => n + 1);
    };
    window.addEventListener('baton:projects-changed', onProjectsChanged);
    return () => window.removeEventListener('baton:projects-changed', onProjectsChanged);
  }, [session, loadProjects]);

  useEffect(() => {
    const onSessionExpired = () => {
      setCsrfToken(null);
      setSessionToken(null);
      setSession(null);
      setProjects([]);
      setMobileNavOpen(false);
      window.location.hash = '#/login';
      showToast('Session expired. Please sign in again.', 'error');
    };
    window.addEventListener('baton:session-expired', onSessionExpired);
    return () => window.removeEventListener('baton:session-expired', onSessionExpired);
  }, [showToast]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const defaultTabForRole = (role: Role): TabKey => {
    return ROLE_TABS[role][0] || 'handover';
  };

  // Ensure activeTab remains permitted if switching to a project with a narrower project role
  useEffect(() => {
    if (!session) return;
    const allowed = ROLE_TABS[effectiveRole];
    if (!allowed.includes(activeTab)) {
      const def = defaultTabForRole(effectiveRole);
      setActiveTab(def);
      setActiveRecordId(null);
      window.location.hash = `#/${def}`;
    }
  }, [session, effectiveRole, activeTab]);

  const navigateTo = useCallback(
    (tab: TabKey, recordId?: string | null) => {
      if (!session) return;
      const allowed = ROLE_TABS[effectiveRole];
      const safeTab = allowed.includes(tab) ? tab : defaultTabForRole(effectiveRole);
      setActiveTab(safeTab);
      setActiveRecordId(recordId ?? null);
      setMobileNavOpen(false);
      window.location.hash = recordId ? `#/${safeTab}?id=${encodeURIComponent(recordId)}` : `#/${safeTab}`;
    },
    [session, effectiveRole]
  );

  // Restore existing HttpOnly or iframe session on reload
  useEffect(() => {
    let active = true;
    apiFetch<SessionInfo>('/api/auth/me')
      .then((res) => {
        if (!active) return;
        setCsrfToken(res.csrfToken);
        if (res.sessionToken) {
          setSessionToken(res.sessionToken);
        }
        setSession(res);
        const parsed = parseHashRoute();
        const allowed = ROLE_TABS[res.user.role];
        const target =
          parsed.tab !== 'login' && allowed.includes(parsed.tab)
            ? parsed.tab
            : defaultTabForRole(res.user.role);
        setActiveTab(target);
        setActiveRecordId(parsed.recordId);
        if (parsed.tab === 'login' || !allowed.includes(parsed.tab as TabKey)) {
          window.location.hash = `#/${target}`;
        }
      })
      .catch(() => {
        if (!active) return;
        setCsrfToken(null);
        setSessionToken(null);
        setSession(null);
        window.location.hash = '#/login';
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Hashchange listener (refresh-safe + back/forward safe)
  useEffect(() => {
    const onHash = () => {
      if (!session) {
        if (window.location.hash !== '#/login') window.location.hash = '#/login';
        return;
      }
      const parsed = parseHashRoute();
      if (parsed.tab === 'login') {
        const def = defaultTabForRole(effectiveRole);
        setActiveTab(def);
        window.location.hash = `#/${def}`;
        return;
      }
      const allowed = ROLE_TABS[effectiveRole];
      if (!allowed.includes(parsed.tab)) {
        const def = defaultTabForRole(effectiveRole);
        setActiveTab(def);
        window.location.hash = `#/${def}`;
        showToast('That workspace tab is restricted for your role.', 'error');
        return;
      }
      setActiveTab(parsed.tab);
      setActiveRecordId(parsed.recordId);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [session, effectiveRole, showToast]);

  // Presence heartbeat every 15s
  useEffect(() => {
    if (!session) return;
    const sendHeartbeat = () => {
      apiFetch('/api/presence/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          route: `#/${activeTab}`,
          recordId: activeTab === 'records' ? activeRecordId : null,
        }),
      }).catch(() => {});
    };
    sendHeartbeat();
    const timer = setInterval(sendHeartbeat, 15_000);
    return () => clearInterval(timer);
  }, [session, activeTab, activeRecordId]);

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } catch {
      // ignore
    }
    setCsrfToken(null);
    setSessionToken(null);
    setSession(null);
    setProjects([]);
    window.location.hash = '#/login';
  };

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC]">
        <div className="text-sm font-medium text-[#64748B]">Restoring BATON workspace…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <LoginScreen
          onComplete={(newSession) => {
            setSession(newSession);
            const def = defaultTabForRole(newSession.user.role);
            setActiveTab(def);
            window.location.hash = `#/${def}`;
          }}
        />
        {toast && (
          <div
            role="status"
            aria-live="polite"
            className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl border px-4 py-3 shadow-md text-sm font-medium ${
              toast.tone === 'error'
                ? 'border-[#DC2626]/30 bg-white text-[#DC2626]'
                : toast.tone === 'success'
                  ? 'border-[#059669]/30 bg-white text-[#059669]'
                  : 'border-[#E2E8F0] bg-white text-[#0F172A]'
            }`}
          >
            {toast.msg}
          </div>
        )}
      </>
    );
  }

  const allowedTabs = ROLE_TABS[effectiveRole];
  const visibleNav = NAV_ITEMS.filter((item) => allowedTabs.includes(item.key));

  const requestSensitiveAuth = (label: string, onSuccess: () => void) => {
    setReauthModal({ open: true, label, onSuccess });
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col lg:flex-row">
      {/* Sidebar Navigation (Desktop) */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:shrink-0 border-r border-[#E2E8F0] bg-white">
        <div className="px-5 py-5 border-b border-[#E2E8F0] flex items-center">
          <BatonLogo variant="full" />
        </div>

        <nav aria-label="Primary workspace navigation" className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
          {NAV_GROUPS.map((groupName) => {
            const groupItems = visibleNav.filter((item) => item.group === groupName);
            if (groupItems.length === 0) return null;
            return (
              <div key={groupName} className="space-y-1">
                <p className="px-3.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
                  {groupName}
                </p>
                {groupItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => navigateTo(item.key)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`w-full flex items-center gap-3 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-[#0F172A] text-white'
                          : 'text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0F172A]'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="p-4 border-t border-[#E2E8F0] space-y-3">
          <div className="text-xs">
            <p className="font-semibold text-[#0F172A] truncate">{session.user.name}</p>
            <p className="font-mono text-[11px] text-[#2563EB]">
              {effectiveRole}
              {activeProjectObj && activeProjectObj.member_role && activeProjectObj.member_role !== session.user.role
                ? ' (project)'
                : ''}
            </p>
            <p className="text-[11px] text-[#64748B] mt-0.5">
              {session.hasSensitiveAuth ? 'Sensitive auth active' : 'Standard session'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-[#E2E8F0] px-4 py-2 text-xs font-semibold text-[#0F172A] hover:bg-[#F8FAFC]"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-[#E2E8F0] px-4 sm:px-8 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              aria-expanded={mobileNavOpen}
              className="lg:hidden rounded-lg p-2 text-[#0F172A] hover:bg-[#F8FAFC]"
            >
              {mobileNavOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="font-semibold text-[#0F172A] truncate">
                {visibleNav.find((n) => n.key === activeTab)?.label || 'Workspace'}
              </span>
              <span className="hidden sm:inline text-[#CBD5E1]">/</span>
              {projects.length > 0 ? (
                <select
                  aria-label="Active continuity project"
                  value={activeProject}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setActiveProjectId(nextId);
                    setActiveProject(nextId);
                    setActiveRecordId(null);
                    setRefreshNonce((n) => n + 1);
                  }}
                  className="hidden sm:inline-block max-w-[260px] truncate rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1 text-xs font-medium text-[#0F172A] focus:border-[#2563EB] focus:outline-none"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="hidden sm:inline text-xs text-[#64748B] truncate">
                  My Research Workspace
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                void loadProjects();
                setRefreshNonce((n) => n + 1);
                showToast('Workspace data refreshed.', 'info');
              }}
              aria-label="Refresh workspace data"
              className="inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] bg-white px-3 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-[#F8FAFC] whitespace-nowrap"
            >
              <RefreshCw className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
              <span className="hidden md:inline">Refresh data</span>
            </button>
            {!session.hasSensitiveAuth && effectiveRole === 'PI_LEAD' && (
              <button
                type="button"
                onClick={() =>
                  requestSensitiveAuth('unlock sensitive actions', () => {
                    setSession((prev) => (prev ? { ...prev, hasSensitiveAuth: true } : prev));
                    showToast('Sensitive action window active for 15 minutes.', 'success');
                  })
                }
                className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[#E2E8F0] px-3.5 py-1.5 text-xs font-medium text-[#0F172A] hover:bg-[#F8FAFC] whitespace-nowrap"
              >
                <Shield className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                <span>Verify for sensitive actions</span>
              </button>
            )}
            <span className="lg:hidden font-mono text-xs font-semibold text-[#2563EB]">
              {effectiveRole}
            </span>
          </div>
        </header>

        {/* Mobile Drawer */}
        {mobileNavOpen && (
          <div className="lg:hidden border-b border-[#E2E8F0] bg-white px-4 py-3 space-y-3">
            {projects.length > 0 && (
              <div>
                <label htmlFor="mobile-project-select" className="block text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] mb-1">
                  Active project
                </label>
                <select
                  id="mobile-project-select"
                  value={activeProject}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setActiveProjectId(nextId);
                    setActiveProject(nextId);
                    setActiveRecordId(null);
                    setRefreshNonce((n) => n + 1);
                  }}
                  className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-xs font-medium text-[#0F172A]"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {NAV_GROUPS.map((groupName) => {
              const groupItems = visibleNav.filter((item) => item.group === groupName);
              if (groupItems.length === 0) return null;
              return (
                <div key={groupName} className="space-y-1">
                  <p className="px-3.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
                    {groupName}
                  </p>
                  {groupItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => navigateTo(item.key)}
                        className={`w-full flex items-center gap-3 rounded-xl px-3.5 py-2 text-sm font-medium ${
                          isActive ? 'bg-[#0F172A] text-white' : 'text-[#475569]'
                        }`}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium text-[#DC2626]"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        )}

        {/* Active Tab Screen */}
        <main key={`${activeProject}-${refreshNonce}`} className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewTab
              role={effectiveRole}
              activeProjectId={activeProject}
              onNavigate={(t) => navigateTo(t)}
              onToast={showToast}
            />
          )}
          {activeTab === 'sources' && (
            <SourcesTab
              role={effectiveRole}
              currentUserId={session.user.id}
              currentUserEmail={session.user.email}
              onToast={showToast}
            />
          )}
          {activeTab === 'notes' && (
            <NotesTab
              currentUserId={session.user.id}
              role={effectiveRole}
              onToast={showToast}
            />
          )}
          {activeTab === 'map' && (
            <MapTab
              role={effectiveRole}
              onOpenRecord={(id) => navigateTo('records', id)}
              onToast={showToast}
            />
          )}
          {activeTab === 'records' && (
            <RecordsTab
              role={effectiveRole}
              initialRecordId={activeRecordId}
              onSelectRecordId={(id) => setActiveRecordId(id)}
              onToast={showToast}
            />
          )}
          {activeTab === 'review' && <ReviewTab onToast={showToast} />}
          {activeTab === 'handover' && (
            <HandoverTab
              role={effectiveRole}
              currentUserEmail={session.user.email}
              hasSensitiveAuth={session.hasSensitiveAuth}
              onRequestSensitiveAuth={requestSensitiveAuth}
              onToast={showToast}
            />
          )}
          {activeTab === 'team' && (
            <TeamTab
              role={effectiveRole}
              onOpenRecord={(id) => navigateTo('records', id)}
              onToast={showToast}
            />
          )}
          {activeTab === 'radar' && (
            <RadarTab
              role={effectiveRole}
              onOpenRecord={(id) => navigateTo('records', id)}
              onToast={showToast}
            />
          )}
          {activeTab === 'coldstart' && (
            <ColdStartTab
              role={effectiveRole}
              currentUserId={session.user.id}
              onToast={showToast}
            />
          )}
          {activeTab === 'redaction' && (
            <RedactionTab
              role={effectiveRole}
              activeProjectId={activeProject}
              hasSensitiveAuth={session.hasSensitiveAuth}
              onRequestSensitiveAuth={requestSensitiveAuth}
              onToast={showToast}
            />
          )}
          {activeTab === 'audit' && <AuditTab onToast={showToast} />}
        </main>
      </div>

      {/* Friendly Toast */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl border px-4 py-3 shadow-md text-sm font-medium ${
            toast.tone === 'error'
              ? 'border-[#DC2626]/30 bg-white text-[#DC2626]'
              : toast.tone === 'success'
                ? 'border-[#059669]/30 bg-white text-[#059669]'
                : 'border-[#E2E8F0] bg-white text-[#0F172A]'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* Password Re-entry Modal for Sensitive Actions */}
      <SensitiveAuthModal
        open={reauthModal.open}
        actionLabel={reauthModal.label}
        onClose={() => setReauthModal({ open: false, label: '', onSuccess: null })}
        onVerified={() => {
          setSession((prev) => (prev ? { ...prev, hasSensitiveAuth: true } : prev));
          const cb = reauthModal.onSuccess;
          setReauthModal({ open: false, label: '', onSuccess: null });
          cb?.();
        }}
      />
    </div>
  );
}
