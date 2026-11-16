import React, { useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Eye,
  EyeOff,
  FileText,
  FolderLock,
  GitBranch,
  Globe,
  Lock,
  NotebookPen,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import { apiFetch, ApiError, setCsrfToken, setSessionToken } from '../lib/api';
import type { SessionInfo } from '../types';
import { BatonLogo } from './BatonLogo';

interface LoginScreenProps {
  onComplete: (session: SessionInfo) => void;
}

const DEMO_ACCOUNTS = [
  {
    email: 'elena.vance@baton-lab.edu',
    name: 'Elena Vance',
    role: 'PI_LEAD',
    desc: 'Full workspace control, approvals, handover publishing',
  },
  {
    email: 'marcus.chen@baton-lab.edu',
    name: 'Marcus Chen',
    role: 'RESEARCHER',
    desc: 'Upload private/public files, notes, claims, redactions',
  },
  {
    email: 'priya.nair@baton-lab.edu',
    name: 'Priya Nair',
    role: 'REVIEWER',
    desc: 'Verify evidence spans & approve or reject claims',
  },
  {
    email: 'aria.patel@baton-lab.edu',
    name: 'Aria Patel',
    role: 'INCOMING_MEMBER',
    desc: 'Upload files, write notes, view handover & Cold-Start quiz',
  },
  {
    email: 'jordan.lee@baton-lab.edu',
    name: 'Jordan Lee',
    role: 'AUDITOR',
    desc: 'Read shared records, team tracker & audit ledger',
  },
];

const BUILTIN_DEMO_PASSWORD = 'Baton@2026';

const FEATURES_LIST = [
  {
    icon: FolderLock,
    color: '#7C3AED',
    title: 'Private & Public File Vault',
    desc: 'Choose before uploading whether a PDF, CSV, Markdown, TXT, or JSON file is Private (visible only to you with your login) or Public (shared across your team). Switch visibility anytime.',
  },
  {
    icon: NotebookPen,
    color: '#2563EB',
    title: 'Word-Style Rich Text Notes Studio',
    desc: 'Write full lab notebooks and project memos with font family, font size, headings, bold/italic/underline, highlights, tables, checklists, hyperlinks, and one-click .doc export.',
  },
  {
    icon: Users,
    color: '#059669',
    title: 'Live Team Status & Work Tracker',
    desc: 'See which teammates are Online, Away, or Offline, inspect every member’s assigned role, see how many files, notes, claims, and reviews they finished, and track who did what.',
  },
  {
    icon: Sparkles,
    color: '#D97706',
    title: 'Evidence-Linked Claim Map',
    desc: 'Reconstruct structured decisions, protocols, risks, and open gaps directly from your public files with exact line or row citations and visual relationship mapping.',
  },
  {
    icon: ShieldCheck,
    color: '#DC2626',
    title: 'Human Review & Sensitive Redactions',
    desc: 'Editing any approved claim automatically resets approval to protect integrity. Automatic sensitive-pattern scanning masks emails, keys, or restricted keywords before sharing.',
  },
  {
    icon: CheckCircle2,
    color: '#0F172A',
    title: 'Handover & Cold-Start Readiness',
    desc: 'Assemble custom handover briefs from verified claims and run an automatic Cold-Start quiz that exposes missing owners or unresolved gaps before anyone leaves.',
  },
];

const TUTORIAL_STEPS = [
  {
    step: '01',
    title: 'Sign in or Create a Collaborator Account',
    summary: 'Start with your own researcher account or explore all 5 roles immediately using synthetic Demo Logins.',
    bullets: [
      'Click Create Account to register with your own name, email, and password (self-registered accounts start as RESEARCHER; a PI Lead assigns elevated project roles).',
      'Or pick one of the 5 synthetic Demo Login buttons to inspect PI Lead, Researcher, Reviewer, Incoming Member, or Auditor permissions.',
      'Sensitive operations such as publishing handovers or restricted scans require password re-authentication.',
    ],
  },
  {
    step: '02',
    title: 'Upload Files as Private or Public',
    summary: 'Decide file visibility before hitting upload—nothing leaks accidentally.',
    bullets: [
      'Open Files & Vault and select Private (Only Me) or Public (Workspace Shared) before dropping your file.',
      'Private files strictly require your authenticated session—no other teammate (not even a PI) can open or download them.',
      'Toggle any file between Private and Public anytime from the file preview header.',
    ],
  },
  {
    step: '03',
    title: 'Write Formatted Notes in Notes Studio',
    summary: 'Full Word-style document formatting saved directly to your workspace.',
    bullets: [
      'Switch fonts, font sizes, headings, text/highlight colors, alignments, tables, and checklists from the ribbon toolbar.',
      'Save each note as Private (personal draft) or Public (shared with teammates).',
      'Export any finished document directly as a Word-compatible .doc file.',
    ],
  },
  {
    step: '04',
    title: 'Monitor Online Presence & Who Did What',
    summary: 'Real-time visibility into team availability, roles, and contributions.',
    bullets: [
      'Open Team & Work to see live ONLINE / AWAY / OFFLINE indicators and each person’s role.',
      'Inspect the Work Completed table to see exact counts of files, notes, claims, reviews, and handovers per member.',
      'Follow the chronological Who Has Done What feed to audit every workspace contribution.',
    ],
  },
  {
    step: '05',
    title: 'Verify, Review & Hand Over Cleanly',
    summary: 'Turn shared files into verified records, resolve risks, and publish handovers.',
    bullets: [
      'Click Extract claims on any Public file to generate typed records linked verbatim to source sections.',
      'Reviewers approve verified records, while Debt Radar flags unassigned tasks or stale claims.',
      'Generate a Handover brief and run the Cold-Start Test to verify newcomer readiness.',
    ],
  },
];

export function LoginScreen({ onComplete }: LoginScreenProps) {
  const [authTab, setAuthTab] = useState<'signin' | 'register'>('signin');
  const [activeTutorialStep, setActiveTutorialStep] = useState(0);
  const [activeGraphNode, setActiveGraphNode] = useState<'vault' | 'notes' | 'claims' | 'team'>('vault');

  // Sign-in state
  const [email, setEmail] = useState(DEMO_ACCOUNTS[0].email);
  const [password, setPassword] = useState(BUILTIN_DEMO_PASSWORD);
  const [showPassword, setShowPassword] = useState(false);

  // Register state
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regTitle, setRegTitle] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const portalRef = useRef<HTMLElement | null>(null);

  const performPasswordLogin = async (loginEmail: string, loginPass: string) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const data = await apiFetch<SessionInfo>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPass }),
      });
      setCsrfToken(data.csrfToken);
      setSessionToken(data.sessionToken ?? null);
      onComplete(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await performPasswordLogin(email, password);
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const data = await apiFetch<SessionInfo>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: regName.trim(),
          email: regEmail.trim(),
          password: regPassword,
          title: regTitle.trim() || 'Workspace Collaborator',
        }),
      });
      setCsrfToken(data.csrfToken);
      setSessionToken(data.sessionToken ?? null);
      onComplete(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickDemoSignIn = async (demoEmail: string) => {
    setEmail(demoEmail);
    setPassword(BUILTIN_DEMO_PASSWORD);
    await performPasswordLogin(demoEmail, BUILTIN_DEMO_PASSWORD);
  };

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const currentTut = TUTORIAL_STEPS[activeTutorialStep];

  const graphCaptions: Record<'vault' | 'notes' | 'claims' | 'team', { label: string; color: string; detail: string }> = {
    vault: {
      label: 'Private & Public Vault',
      color: '#EF4444',
      detail: 'Lock files strictly to your account (Private) or share across the team (Public) before upload.',
    },
    notes: {
      label: 'Word-Style Notes Studio',
      color: '#2563EB',
      detail: 'Draft formatted lab notes with custom fonts, headings, tables, highlights, and .doc export.',
    },
    claims: {
      label: 'Evidence-Linked Claims',
      color: '#10B981',
      detail: 'Connect shared files to reviewer-approved decisions, risks, and verbatim source citations.',
    },
    team: {
      label: 'Live Team Work & Status',
      color: '#F59E0B',
      detail: 'Track Online/Away/Offline presence, assigned roles, work counts, and who did what.',
    },
  };

  return (
    <div className="min-h-screen bg-white text-[#0F172A]">
      {/* Multi-color Warm Editorial Hero Canvas */}
      <div
        className="border-b border-[#E2E8F0]"
        style={{
          background: [
            'radial-gradient(circle at 8% 14%, rgba(255, 92, 71, 0.30) 0%, rgba(255, 168, 107, 0.20) 24%, transparent 52%)',
            'radial-gradient(circle at 52% 8%, rgba(245, 158, 11, 0.16) 0%, transparent 42%)',
            'radial-gradient(circle at 88% 18%, rgba(59, 130, 246, 0.18) 0%, rgba(139, 92, 246, 0.14) 26%, transparent 55%)',
            'radial-gradient(circle at 75% 88%, rgba(16, 185, 129, 0.16) 0%, transparent 48%)',
            'linear-gradient(180deg, #FFFDFB 0%, #FFFFFF 100%)',
          ].join(', '),
        }}
      >
        {/* Strict 3-Zone Top Navigation Bar */}
        <header className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-10 py-3.5 flex items-center justify-between gap-8 border-b border-[#0F172A]/10">
          <BatonLogo variant="hero" />

          <nav aria-label="Home navigation" className="hidden md:flex items-center gap-8 text-sm font-medium text-[#334155]">
            <button
              type="button"
              onClick={() => scrollToSection('features')}
              className="whitespace-nowrap shrink-0 hover:text-[#0F172A] hover:underline underline-offset-4 transition-colors"
            >
              Features
            </button>
            <button
              type="button"
              onClick={() => scrollToSection('tutorial')}
              className="whitespace-nowrap shrink-0 hover:text-[#0F172A] hover:underline underline-offset-4 transition-colors"
            >
              How to Use
            </button>
            <button
              type="button"
              onClick={() => portalRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className="whitespace-nowrap shrink-0 hover:text-[#0F172A] hover:underline underline-offset-4 transition-colors"
            >
              Workspace Access
            </button>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => portalRef.current?.scrollIntoView({ behavior: 'smooth' })}
              className="inline-flex items-center gap-1.5 rounded-full bg-[#0F172A] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E293B] whitespace-nowrap shrink-0 transition-colors"
            >
              <span>Open Workspace</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Above-the-Fold Hero Split Layout (fits comfortably on desktop screen) */}
        <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-10 py-6 lg:py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
          {/* Left Hero Copy + Proper Interactive Continuity Graph */}
          <section className="lg:col-span-6 space-y-5">
            <div className="space-y-3.5">
              {/* Multi-color Geometric Node Connector Motif */}
              <div className="flex items-center gap-2.5" aria-hidden="true">
                <span className="h-3.5 w-3.5 rounded-full border-2 border-[#0F172A] bg-white" />
                <span className="h-0.5 w-6 bg-[#0F172A]" />
                <span className="h-5 w-5 rounded-full bg-[#EF4444]" />
                <span className="h-4.5 w-4.5 rounded-full bg-[#F59E0B]" />
                <span className="h-4.5 w-4.5 rounded-full bg-[#10B981]" />
                <span className="h-4.5 w-4.5 rounded-full bg-[#2563EB]" />
                <span className="h-4.5 w-8 rounded-full bg-[#8B5CF6]" />
              </div>

              <h1 className="font-display text-3xl sm:text-4xl lg:text-[42px] font-extrabold tracking-tight text-[#0F172A] leading-[1.08] text-balance">
                Work{' '}
                <span className="relative inline-block">
                  smarter,
                  <span
                    aria-hidden="true"
                    className="absolute left-0 -bottom-0.5 h-2 w-full rounded-full bg-gradient-to-r from-[#FF6B4A] via-[#F59E0B] to-[#34D399] -z-10"
                  />
                </span>{' '}
                keep private drafts locked, and pass every baton cleanly.
              </h1>

              <p className="text-sm sm:text-[15px] text-[#475569] max-w-xl leading-relaxed">
                Built for research labs, principal investigators, and transitioning teams. Reconstruct project decisions from raw files, verify verbatim evidence across 5 structured stages (Connect → Reconstruct → Verify → Review → Handover), and test newcomer readiness before anyone departs.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => scrollToSection('tutorial')}
                  className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[#EF4444] via-[#F97316] to-[#2563EB] px-5 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-xs hover:opacity-95 transition-opacity whitespace-nowrap"
                >
                  <span>Read 5-Step Tutorial</span>
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => scrollToSection('features')}
                  className="inline-flex items-center gap-2 rounded-full border border-[#CBD5E1] bg-white/90 px-4 py-2.5 text-xs sm:text-sm font-semibold text-[#0F172A] hover:border-[#0F172A] transition-colors whitespace-nowrap"
                >
                  <span>Explore Features</span>
                </button>
              </div>
            </div>

            {/* Proper Connected Continuity Workflow & Activity Graph */}
            <div className="rounded-3xl border border-[#E2E8F0] bg-white/95 p-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs font-bold text-[#0F172A]">
                  Interactive Workspace Flow
                </span>
                <span className="text-[11px] text-[#64748B] hidden sm:inline">
                  Click any node to inspect how data flows
                </span>
              </div>

              {/* Desktop / Tablet Connected Graph Canvas */}
              <div
                className="relative hidden sm:block h-[215px] rounded-2xl border border-[#F1F5F9] overflow-hidden"
                style={{
                  background:
                    'radial-gradient(circle at 18% 25%, rgba(239,68,68,0.10) 0%, transparent 45%), radial-gradient(circle at 50% 50%, rgba(16,185,129,0.09) 0%, transparent 48%), radial-gradient(circle at 85% 25%, rgba(59,130,246,0.10) 0%, transparent 45%), radial-gradient(circle at 82% 82%, rgba(245,158,11,0.10) 0%, transparent 45%), #FAFBFC',
                }}
              >
                {/* Exact Coordinate Curved Connectors SVG */}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 600 215"
                  preserveAspectRatio="none"
                  className="absolute inset-0 w-full h-full pointer-events-none"
                  fill="none"
                >
                  <defs>
                    <linearGradient id="hubRing" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#EF4444" />
                      <stop offset="35%" stopColor="#F59E0B" />
                      <stop offset="70%" stopColor="#10B981" />
                      <stop offset="100%" stopColor="#2563EB" />
                    </linearGradient>
                  </defs>

                  {/* Subtle dot grid */}
                  <pattern id="batonGrid" width="24" height="24" patternUnits="userSpaceOnUse">
                    <circle cx="2" cy="2" r="1" fill="#CBD5E1" opacity="0.55" />
                  </pattern>
                  <rect width="600" height="215" fill="url(#batonGrid)" />

                  {/* Vault (Top-Left edge x=201, y=50) -> Center Hub (x=265, y=106) */}
                  <path
                    d="M 201 50 C 236 50, 232 106, 265 106"
                    stroke={activeGraphNode === 'vault' ? '#EF4444' : '#94A3B8'}
                    strokeWidth={activeGraphNode === 'vault' ? '3' : '2'}
                    strokeLinecap="round"
                  />
                  <circle cx="201" cy="50" r="4.5" fill="#EF4444" />

                  {/* Notes (Bottom-Left edge x=201, y=164) -> Center Hub (x=265, y=109) */}
                  <path
                    d="M 201 164 C 236 164, 232 109, 265 109"
                    stroke={activeGraphNode === 'notes' ? '#2563EB' : '#94A3B8'}
                    strokeWidth={activeGraphNode === 'notes' ? '3' : '2'}
                    strokeLinecap="round"
                  />
                  <circle cx="201" cy="164" r="4.5" fill="#2563EB" />

                  {/* Center Hub (x=335, y=106) -> Claims (Top-Right edge x=399, y=50) */}
                  <path
                    d="M 335 106 C 368 106, 364 50, 399 50"
                    stroke={activeGraphNode === 'claims' ? '#10B981' : '#94A3B8'}
                    strokeWidth={activeGraphNode === 'claims' ? '3' : '2'}
                    strokeLinecap="round"
                  />
                  <circle cx="399" cy="50" r="4.5" fill="#10B981" />

                  {/* Center Hub (x=335, y=109) -> Team Activity (Bottom-Right edge x=399, y=164) */}
                  <path
                    d="M 335 109 C 368 109, 364 164, 399 164"
                    stroke={activeGraphNode === 'team' ? '#F59E0B' : '#94A3B8'}
                    strokeWidth={activeGraphNode === 'team' ? '3' : '2'}
                    strokeLinecap="round"
                  />
                  <circle cx="399" cy="164" r="4.5" fill="#F59E0B" />

                  {/* Center Orbital Hub Ring */}
                  <circle cx="300" cy="107.5" r="42" fill="url(#hubRing)" opacity="0.22" />
                  <circle cx="300" cy="107.5" r="34" fill="none" stroke="url(#hubRing)" strokeWidth="2.5" />
                </svg>

                {/* Node 1: Top-Left Private/Public Vault */}
                <button
                  type="button"
                  onClick={() => setActiveGraphNode('vault')}
                  style={{ left: '2.5%', top: '16px', width: '31%' }}
                  className={`absolute text-left rounded-xl border bg-white p-2.5 transition-all shadow-xs ${
                    activeGraphNode === 'vault'
                      ? 'border-[#EF4444] ring-2 ring-[#EF4444]/15'
                      : 'border-[#E2E8F0] hover:border-[#EF4444]/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0F172A] truncate">
                      <Lock className="h-3 w-3 text-[#EF4444] shrink-0" aria-hidden="true" />
                      <span className="truncate">Files &amp; Vault</span>
                    </span>
                    <span className="h-2 w-2 rounded-full bg-[#EF4444] shrink-0" aria-hidden="true" />
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="flex-1 rounded bg-[#FEF2F2] px-1.5 py-0.5 text-[10px] font-semibold text-[#DC2626] text-center">
                      Private
                    </span>
                    <span className="flex-1 rounded bg-[#ECFDF5] px-1.5 py-0.5 text-[10px] font-semibold text-[#059669] text-center">
                      Public
                    </span>
                  </div>
                </button>

                {/* Node 2: Bottom-Left Word-Style Notes */}
                <button
                  type="button"
                  onClick={() => setActiveGraphNode('notes')}
                  style={{ left: '2.5%', bottom: '16px', width: '31%' }}
                  className={`absolute text-left rounded-xl border bg-white p-2.5 transition-all shadow-xs ${
                    activeGraphNode === 'notes'
                      ? 'border-[#2563EB] ring-2 ring-[#2563EB]/15'
                      : 'border-[#E2E8F0] hover:border-[#2563EB]/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0F172A] truncate">
                      <NotebookPen className="h-3 w-3 text-[#2563EB] shrink-0" aria-hidden="true" />
                      <span className="truncate">Notes Studio</span>
                    </span>
                    <span className="text-[10px] font-bold text-[#2563EB] shrink-0">Aa</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    <div className="h-1.5 w-full rounded-full bg-[#DBEAFE]" />
                    <div className="flex gap-1">
                      <div className="h-1.5 w-2/3 rounded-full bg-[#EDE9FE]" />
                      <div className="h-1.5 w-1/3 rounded-full bg-[#FEF3C7]" />
                    </div>
                  </div>
                </button>

                {/* Center Hub Badge */}
                <div
                  style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}
                  className="absolute h-16 w-16 rounded-full bg-white border border-[#E2E8F0] shadow-sm flex flex-col items-center justify-center pointer-events-none"
                >
                  <ArrowUpRight className="h-5 w-5 text-[#10B981]" aria-hidden="true" />
                  <span className="text-[9px] font-bold tracking-tight text-[#0F172A]">BATON</span>
                </div>

                {/* Node 3: Top-Right Claims & Approvals */}
                <button
                  type="button"
                  onClick={() => setActiveGraphNode('claims')}
                  style={{ right: '2.5%', top: '16px', width: '31%' }}
                  className={`absolute text-left rounded-xl border bg-white p-2.5 transition-all shadow-xs ${
                    activeGraphNode === 'claims'
                      ? 'border-[#10B981] ring-2 ring-[#10B981]/15'
                      : 'border-[#E2E8F0] hover:border-[#10B981]/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0F172A] truncate">
                      <GitBranch className="h-3 w-3 text-[#10B981] shrink-0" aria-hidden="true" />
                      <span className="truncate">Verified Claims</span>
                    </span>
                    <CheckCircle2 className="h-3 w-3 text-[#10B981] shrink-0" aria-hidden="true" />
                  </div>
                  <div className="mt-2 flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-[#10B981]" />
                    <span className="h-1.5 flex-1 rounded-full bg-[#D1FAE5]" />
                    <span className="h-2 w-2 rounded-full bg-[#8B5CF6]" />
                    <span className="h-1.5 flex-1 rounded-full bg-[#EDE9FE]" />
                  </div>
                </button>

                {/* Node 4: Bottom-Right Team Contribution Bar Chart */}
                <button
                  type="button"
                  onClick={() => setActiveGraphNode('team')}
                  style={{ right: '2.5%', bottom: '14px', width: '31%' }}
                  className={`absolute text-left rounded-xl border bg-white p-2.5 transition-all shadow-xs ${
                    activeGraphNode === 'team'
                      ? 'border-[#F59E0B] ring-2 ring-[#F59E0B]/15'
                      : 'border-[#E2E8F0] hover:border-[#F59E0B]/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0F172A] truncate">
                      <Activity className="h-3 w-3 text-[#F59E0B] shrink-0" aria-hidden="true" />
                      <span className="truncate">Team Activity</span>
                    </span>
                    <span className="text-[10px] font-semibold text-[#059669] shrink-0">Live</span>
                  </div>
                  {/* Proper Color-Coded Mini Bar Chart */}
                  <div className="mt-2 flex items-end justify-between gap-1 h-7 px-1 border-b border-[#E2E8F0]">
                    <span className="flex-1 rounded-t bg-[#EF4444]" style={{ height: '55%' }} />
                    <span className="flex-1 rounded-t bg-[#F59E0B]" style={{ height: '82%' }} />
                    <span className="flex-1 rounded-t bg-[#10B981]" style={{ height: '65%' }} />
                    <span className="flex-1 rounded-t bg-[#2563EB]" style={{ height: '100%' }} />
                    <span className="flex-1 rounded-t bg-[#8B5CF6]" style={{ height: '72%' }} />
                    <span className="flex-1 rounded-t bg-[#0F172A]" style={{ height: '48%' }} />
                  </div>
                </button>
              </div>

              {/* Mobile Fallback 2x2 Grid */}
              <div className="grid grid-cols-2 gap-2 sm:hidden">
                {(['vault', 'notes', 'claims', 'team'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setActiveGraphNode(k)}
                    className={`rounded-xl border p-2.5 text-left text-xs font-bold ${
                      activeGraphNode === k ? 'border-[#0F172A] bg-[#F8FAFC]' : 'border-[#E2E8F0] bg-white'
                    }`}
                  >
                    <span style={{ color: graphCaptions[k].color }}>{graphCaptions[k].label}</span>
                  </button>
                ))}
              </div>

              {/* Live Graph Selection Caption */}
              <div className="flex items-center gap-2.5 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] px-3 py-2 text-xs">
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: graphCaptions[activeGraphNode].color }}
                  aria-hidden="true"
                />
                <p className="text-[#334155]">
                  <span className="font-bold text-[#0F172A]">{graphCaptions[activeGraphNode].label}: </span>
                  {graphCaptions[activeGraphNode].detail}
                </p>
              </div>
            </div>
          </section>

          {/* Right Auth Portal (Sign In, Create Account, Camera Login + Demo Logins) */}
          <section ref={portalRef} className="lg:col-span-6">
            <div className="bg-white border border-[#E2E8F0] rounded-3xl p-6 sm:p-7 shadow-sm space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-xl font-bold text-[#0F172A]">
                    {authTab === 'register' ? 'Create Your Workspace Account' : 'Enter BATON Workspace'}
                  </h2>
                  <p className="text-xs text-[#64748B] mt-0.5">
                    Sign in with credentials, create a new account, or use a quick demo login.
                  </p>
                </div>
              </div>

              {/* Auth Mode Tabs */}
              <div className="grid grid-cols-2 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] p-1 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab('signin');
                    setError(null);
                  }}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-full py-2 transition-colors ${
                    authTab === 'signin' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Sign In</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab('register');
                    setError(null);
                  }}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-full py-2 transition-colors ${
                    authTab === 'register' ? 'bg-[#0F172A] text-white' : 'text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Create Account</span>
                </button>
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-xl border border-[#DC2626]/30 bg-[#DC2626]/8 px-4 py-2.5 text-xs font-medium text-[#DC2626]"
                >
                  {error}
                </div>
              )}

              {authTab === 'signin' && (
                <form onSubmit={handlePasswordSubmit} className="space-y-4" noValidate>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div className="space-y-1">
                      <label htmlFor="login-email" className="block text-xs font-semibold text-[#0F172A]">
                        Email address
                      </label>
                      <input
                        id="login-email"
                        type="email"
                        required
                        autoComplete="username"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@organization.edu"
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2.5 text-sm text-[#0F172A] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                      />
                    </div>

                    <div className="space-y-1">
                      <label htmlFor="login-password" className="block text-xs font-semibold text-[#0F172A]">
                        Password
                      </label>
                      <div className="relative">
                        <input
                          id="login-password"
                          type={showPassword ? 'text' : 'password'}
                          required
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Enter password"
                          className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] pl-3.5 pr-10 py-2.5 text-sm text-[#0F172A] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-[#64748B] hover:text-[#0F172A]"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-[#2563EB] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-60 transition-colors"
                  >
                    <Lock className="h-4 w-4" aria-hidden="true" />
                    <span>{submitting ? 'Signing in…' : 'Sign in'}</span>
                  </button>

                  {/* Demo Login Accounts Only */}
                  <div className="pt-3 border-t border-[#E2E8F0] space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-[#0F172A] flex items-center gap-1.5">
                        <Zap className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                        <span>Synthetic Demo Accounts (1-click sign-in)</span>
                      </span>
                      <span className="font-mono text-[11px] text-[#64748B]">
                        Pass: {BUILTIN_DEMO_PASSWORD}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {DEMO_ACCOUNTS.map((acc) => (
                        <button
                          key={acc.email}
                          type="button"
                          disabled={submitting}
                          onClick={() => handleQuickDemoSignIn(acc.email)}
                          className="text-left rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#2563EB] hover:bg-white px-3 py-2 transition-colors disabled:opacity-60"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-[#0F172A] truncate">{acc.name}</span>
                            <span className="font-mono text-[10px] font-semibold text-[#2563EB] whitespace-nowrap">
                              {acc.role}
                            </span>
                          </div>
                          <p className="text-[11px] text-[#64748B] truncate mt-0.5">{acc.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                </form>
              )}

              {authTab === 'register' && (
                <form onSubmit={handleRegisterSubmit} className="space-y-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="reg-name" className="block text-xs font-semibold text-[#0F172A] mb-1">Full name</label>
                      <input
                        id="reg-name"
                        type="text"
                        required
                        value={regName}
                        onChange={(e) => setRegName(e.target.value)}
                        placeholder="e.g., Dr. Samira Rao"
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="reg-email" className="block text-xs font-semibold text-[#0F172A] mb-1">Email</label>
                      <input
                        id="reg-email"
                        type="email"
                        required
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="samira@lab.org"
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="reg-password" className="block text-xs font-semibold text-[#0F172A] mb-1">
                        Password (min 8 chars)
                      </label>
                      <input
                        id="reg-password"
                        type="password"
                        required
                        minLength={8}
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        placeholder="Create strong password"
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="reg-title" className="block text-xs font-semibold text-[#0F172A] mb-1">Job title / Specialty</label>
                      <input
                        id="reg-title"
                        type="text"
                        value={regTitle}
                        onChange={(e) => setRegTitle(e.target.value)}
                        placeholder="e.g., Graduate Researcher"
                        className="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-sm"
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2.5 text-xs text-[#475569]">
                    <span className="font-semibold text-[#0F172A]">Default role assignment:</span> Self-registered accounts start with the <span className="font-mono font-semibold text-[#2563EB]">RESEARCHER</span> collaborator role inside your personal workspace. A project <span className="font-mono font-semibold">PI_LEAD</span> can add you to shared projects and assign elevated roles.
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-full bg-[#0F172A] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#1E293B] disabled:opacity-60"
                  >
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                    <span>{submitting ? 'Creating account…' : 'Create account & enter workspace'}</span>
                  </button>
                </form>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Features Explanation Section */}
      <section id="features" className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-10 py-16 space-y-10">
        <div className="max-w-2xl space-y-2">
          <p className="text-xs font-semibold text-[#2563EB]">
            Platform Features
          </p>
          <h2 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-[#0F172A]">
            Everything your team needs to document, protect, and transfer knowledge.
          </h2>
          <p className="text-sm sm:text-base text-[#475569]">
            Start from a clean slate with zero mock clutter. Insert your own files, write rich-text notes, and collaborate safely across roles.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES_LIST.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="rounded-2xl border border-[#E2E8F0] bg-white p-6 space-y-3 hover:border-[#94A3B8] transition-colors"
              >
                <div
                  className="h-10 w-10 rounded-xl flex items-center justify-center text-white"
                  style={{ backgroundColor: f.color }}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h3 className="font-display text-lg font-bold text-[#0F172A]">{f.title}</h3>
                <p className="text-sm text-[#475569] leading-relaxed">{f.desc}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Interactive How-To-Use Tutorial Section */}
      <section
        id="tutorial"
        className="border-y border-[#E2E8F0] py-16"
        style={{
          background:
            'linear-gradient(135deg, rgba(255, 247, 237, 0.7) 0%, rgba(248, 250, 252, 0.95) 50%, rgba(239, 246, 255, 0.75) 100%)',
        }}
      >
        <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-10 space-y-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="space-y-2 max-w-2xl">
              <p className="text-xs font-semibold text-[#059669]">
                Quick-Start Tutorial
              </p>
              <h2 className="font-display text-3xl font-extrabold tracking-tight text-[#0F172A]">
                How to use BATON in 5 simple steps
              </h2>
              <p className="text-sm text-[#475569]">
                Click through each step below to see how private/public files, rich-text notes, team work tracking, and verified handovers fit together.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-5 space-y-2.5">
              {TUTORIAL_STEPS.map((st, idx) => {
                const isActive = idx === activeTutorialStep;
                return (
                  <button
                    key={st.step}
                    type="button"
                    onClick={() => setActiveTutorialStep(idx)}
                    className={`w-full text-left rounded-2xl border p-4 transition-colors flex items-start gap-3.5 ${
                      isActive
                        ? 'border-[#0F172A] bg-white shadow-xs'
                        : 'border-[#E2E8F0] bg-white/60 hover:bg-white'
                    }`}
                  >
                    <span
                      className={`font-mono text-xs font-bold px-2.5 py-1 rounded-lg shrink-0 ${
                        isActive ? 'bg-[#0F172A] text-white' : 'bg-[#E2E8F0] text-[#475569]'
                      }`}
                    >
                      {st.step}
                    </span>
                    <div>
                      <p className="text-sm font-bold text-[#0F172A]">{st.title}</p>
                      <p className="text-xs text-[#64748B] mt-0.5">{st.summary}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="lg:col-span-7 rounded-3xl border border-[#E2E8F0] bg-white p-7 sm:p-9 space-y-6">
              <div className="flex items-center justify-between gap-4 border-b border-[#E2E8F0] pb-4">
                <div>
                  <span className="font-mono text-xs font-bold text-[#2563EB]">
                    STEP {currentTut.step} OF 05
                  </span>
                  <h3 className="font-display text-2xl font-bold text-[#0F172A] mt-1">
                    {currentTut.title}
                  </h3>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={activeTutorialStep === 0}
                    onClick={() => setActiveTutorialStep((s) => Math.max(0, s - 1))}
                    className="rounded-full border border-[#E2E8F0] px-3.5 py-1.5 text-xs font-semibold text-[#0F172A] disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={activeTutorialStep === TUTORIAL_STEPS.length - 1}
                    onClick={() =>
                      setActiveTutorialStep((s) => Math.min(TUTORIAL_STEPS.length - 1, s + 1))
                    }
                    className="rounded-full bg-[#0F172A] px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>

              <p className="text-sm text-[#475569]">{currentTut.summary}</p>

              <ul className="space-y-3">
                {currentTut.bullets.map((b, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-[#0F172A]">
                    <CheckCircle2 className="h-4 w-4 text-[#059669] shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>

              <div className="pt-4 border-t border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4 text-xs text-[#64748B]">
                  <span className="inline-flex items-center gap-1">
                    <Globe className="h-3.5 w-3.5 text-[#059669]" /> Public shared
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3.5 w-3.5 text-[#7C3AED]" /> Private owner-only
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3.5 w-3.5 text-[#2563EB]" /> Rich-text .doc export
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => portalRef.current?.scrollIntoView({ behavior: 'smooth' })}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#2563EB] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1D4ED8]"
                >
                  <span>Try it now</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Clean Footer */}
      <footer className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-10 py-8 flex flex-wrap items-center justify-between gap-4 text-xs text-[#64748B]">
        <div className="flex items-center gap-3">
          <BatonLogo variant="compact" />
          <span>BATON · Collaborative Research &amp; Knowledge Workspace</span>
        </div>
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={() => scrollToSection('features')}
            className="hover:text-[#0F172A] transition-colors"
          >
            Features
          </button>
          <button
            type="button"
            onClick={() => scrollToSection('tutorial')}
            className="hover:text-[#0F172A] transition-colors"
          >
            How to Use
          </button>
          <button
            type="button"
            onClick={() => portalRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="font-semibold text-[#2563EB] hover:underline"
          >
            Sign In
          </button>
        </div>
      </footer>
    </div>
  );
}
