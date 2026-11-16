export type Role =
  | 'PI_LEAD'
  | 'RESEARCHER'
  | 'REVIEWER'
  | 'INCOMING_MEMBER'
  | 'AUDITOR';

export type EvidenceState =
  | 'SUPPORTED'
  | 'CONFLICTING'
  | 'UNSUPPORTED'
  | 'STALE'
  | 'NEEDS_REVIEW'
  | 'NOT_ESTABLISHED';

export const EVIDENCE_STATES: EvidenceState[] = [
  'SUPPORTED',
  'CONFLICTING',
  'UNSUPPORTED',
  'STALE',
  'NEEDS_REVIEW',
  'NOT_ESTABLISHED',
];

export type ApprovalState =
  | 'APPROVED'
  | 'NEEDS_REVISION'
  | 'REJECTED'
  | 'NEEDS_REVIEW';

export type VisibilityLevel = 'PROJECT_SHARED' | 'PRIVATE_OWNER' | 'RESTRICTED_PI_ONLY';

export type WorkflowStageId = '01' | '02' | '03' | '04' | '05';

export const WORKFLOW_STAGES: Array<{
  id: WorkflowStageId;
  num: string;
  name: string;
  description: string;
}> = [
  { id: '01', num: '01', name: 'Connect', description: 'Upload public or private files, notes & datasets' },
  { id: '02', num: '02', name: 'Reconstruct', description: 'Extract typed claims bound to verbatim spans' },
  { id: '03', num: '03', name: 'Verify', description: 'Check evidence states & flag conflicting data' },
  { id: '04', num: '04', name: 'Review', description: 'Human sign-off, redaction & debt triage' },
  { id: '05', num: '05', name: 'Handover', description: 'Publish filtered brief & validate readiness' },
];

export type TabKey =
  | 'overview'
  | 'sources'
  | 'notes'
  | 'map'
  | 'records'
  | 'review'
  | 'handover'
  | 'team'
  | 'radar'
  | 'coldstart'
  | 'redaction'
  | 'audit';

export const ROLE_TABS: Record<Role, TabKey[]> = {
  PI_LEAD: [
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
  ],
  RESEARCHER: [
    'overview',
    'sources',
    'notes',
    'map',
    'records',
    'handover',
    'team',
    'radar',
    'redaction',
  ],
  REVIEWER: [
    'overview',
    'sources',
    'notes',
    'map',
    'records',
    'review',
    'handover',
    'team',
  ],
  INCOMING_MEMBER: [
    'overview',
    'sources',
    'notes',
    'handover',
    'coldstart',
    'team',
  ],
  AUDITOR: [
    'overview',
    'sources',
    'notes',
    'map',
    'records',
    'handover',
    'team',
    'audit',
  ],
};

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  title: string;
  departing: boolean;
}

export interface SessionInfo {
  user: AuthUser;
  csrfToken: string;
  sessionToken?: string;
  cameraVerified: boolean;
  hasSensitiveAuth: boolean;
}

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  stage_current: WorkflowStageId;
  member_role?: Role;
  sensitive_patterns?: string[];
  created_at?: string;
}

export interface ProjectMemberInfo {
  project_id: string;
  user_id: string;
  role: Role;
  name: string;
  email: string;
  title: string;
  departing: boolean;
  added_by: string | null;
  created_at: string;
}

export interface SourceSpan {
  id: string;
  source_id: string;
  locator: string;
  content: string;
  line_start: number | null;
  line_end: number | null;
}

export interface SourceItem {
  id: string;
  project_id: string;
  title: string;
  filename: string;
  file_type: string;
  file_size: number;
  sha256: string;
  visibility_level: VisibilityLevel;
  exclude_from_ai: number;
  status: 'PARSED' | 'NEEDS_OCR' | 'ERROR';
  uploaded_by: string;
  uploaded_by_id?: string;
  created_at: string;
  span_count?: number;
}

export interface NoteItem {
  id: string;
  project_id: string;
  author_id: string;
  author_name: string;
  author_role: Role;
  title: string;
  content_html: string;
  plain_text: string;
  font_family: string;
  visibility_level: 'PROJECT_SHARED' | 'PRIVATE_OWNER';
  word_count: number;
  version?: number;
  created_at: string;
  updated_at: string;
}

export interface RecordVersionEntry {
  id: string;
  record_id: string;
  version: number;
  title: string;
  excerpt: string;
  evidence_state: EvidenceState;
  approval_state: ApprovalState;
  owner_name: string | null;
  locator: string;
  reason: string;
  edited_by: string;
  created_at: string;
}

export interface ResearchRecord {
  id: string;
  project_id: string;
  type: string;
  title: string;
  owner_name: string | null;
  owner_user_id: string | null;
  source_id: string | null;
  source_file: string;
  locator: string;
  span_id: string | null;
  evidence_state: EvidenceState;
  approval_state: ApprovalState;
  approved_version: number | null;
  version: number;
  visibility_level: VisibilityLevel;
  exclude_from_ai: number;
  excerpt: string;
  rationale?: string;
  stage: WorkflowStageId;
  last_updated: string | null;
  created_at: string;
  span_content?: string | null;
  verbatim_match?: boolean;
}

export interface RecordEdge {
  id: string;
  from_record_id: string;
  to_record_id: string;
  relation: string;
}

export interface RadarFinding {
  id: string;
  project_id: string;
  record_id: string;
  priority_points: number;
  band: 'HIGH' | 'MEDIUM' | 'LOW';
  reasons: string[];
  suggested_followup: string;
  resolved: boolean;
  scanned_at: string;
  risk_category?: string;
  owner_name?: string | null;
  evidence_snapshot?: Record<string, unknown>;
  created_at?: string | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
  inactive?: boolean;
  record?: ResearchRecord;
}

export interface RedactionHistoryEntry {
  action: string;
  actor: string;
  at: string;
  confidence?: string;
  note?: string;
}

export interface RedactionProposal {
  id: string;
  project_id: string;
  target_type: 'SOURCE' | 'RECORD';
  target_id: string;
  span_id: string | null;
  category: 'EMAIL' | 'PHONE' | 'SECRET' | 'ID_NUMBER' | 'RESTRICTED_KEYWORD';
  matched_text: string;
  masked_preview: string;
  context_snippet: string;
  replacement: string;
  status: 'PROPOSED' | 'CONFIRMED' | 'REJECTED';
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  target_label?: string;
  locator?: string;
  confidence_label?: 'HIGH' | 'MEDIUM' | 'LOW';
  confidence_reason?: string;
  history?: RedactionHistoryEntry[];
}

export type ColdStartQuestionCategory =
  | 'Project objective'
  | 'Important decisions'
  | 'Current status'
  | 'Unresolved questions'
  | 'Risks'
  | 'Dependencies'
  | 'Next actions'
  | 'Responsibilities'
  | 'Evidence and provenance'
  | 'Known limitations';

export interface ColdStartQuestion {
  id: string;
  record_id: string;
  handover_item_id?: string;
  record_type: string;
  category?: ColdStartQuestionCategory;
  related_section?: string;
  source_ref?: string;
  question: string;
  answerable_from_handover: boolean;
  gap_reason: string | null;
  expected_hint: string;
  user_answer?: string;
  matched?: boolean;
  evaluation_status?: 'CORRECT' | 'PARTIAL' | 'INCORRECT' | 'UNANSWERED';
  score?: number;
  addressed_concepts?: string[];
  missing_concepts?: string[];
  feedback?: string;
}

export interface ColdStartCoverageSummary {
  knowledgeCoveragePct: number;
  answeredCount: number;
  unansweredCount: number;
  correctCount: number;
  partialCount: number;
  incorrectCount: number;
  evaluationMode: string;
  disclaimer: string;
}

export interface ColdStartRun {
  id: string;
  handover_id: string;
  handover_version: number;
  user_id: string;
  user_name: string;
  total_questions: number;
  answerable_questions: number;
  evaluation_mode?: string;
  coverage_summary?: ColdStartCoverageSummary;
  questions: ColdStartQuestion[];
  coverage_gaps: Array<{ record_id: string; question: string; reason: string }>;
  untested_records: Array<{ id: string; title: string; type: string }>;
  created_at: string;
}

export interface HandoverItem {
  id: string;
  handover_id: string;
  record_id: string;
  section: string;
  rendered_text: string;
  source_file: string;
  locator: string;
  evidence_state: EvidenceState;
  approval_state: ApprovalState;
  owner_name: string | null;
  version_at_inclusion: number;
  recipient_checked?: number;
}

export interface HandoverDoc {
  id: string;
  project_id: string;
  version: number;
  title: string;
  status: 'DRAFT' | 'PUBLISHED';
  summary_md: string;
  extractor_mode: 'rule-based' | 'gemini-augmented';
  created_by: string;
  recipient_name?: string | null;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
  items: HandoverItem[];
  acknowledgements: Array<{
    id: string;
    user_id: string;
    user_name: string;
    note: string;
    acknowledged_at: string;
  }>;
}

export interface MemberWorkSummary {
  sourcesUploaded: number;
  notesCreated: number;
  claimsWorked: number;
  reviewsCompleted: number;
  handoversCreated: number;
  totalActions: number;
}

export interface MemberActionLog {
  id: number;
  timestamp: string;
  action: string;
  target_type: string;
  target_id: string;
  actor_email?: string;
  actor_name?: string;
  actor_role?: string;
}

export interface TeamMemberStatus {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  departing: boolean;
  presence_status: 'ONLINE' | 'AWAY' | 'OFFLINE';
  current_route: string | null;
  current_record_id: string | null;
  last_seen_at: string | null;
  open_records: ResearchRecord[];
  work_summary?: MemberWorkSummary;
  recent_actions?: MemberActionLog[];
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  actor_user_id: string | null;
  actor_email: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown>;
  ip: string | null;
}
