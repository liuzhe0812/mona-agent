/** 用户画像 API 客户端 — 调用 services 进程的 /api/profile/* 路由。
 *
 * 令牌由 Tauri 的 local_http_request 原生桥自动附加；前端不读取或暴露令牌。 */

import { getServicesHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";

/** profile.rich.json 顶层结构。 */
export interface RichProfile {
  version?: string;
  scope?: "user";
  revision?: number;
  updated_at?: string | null;
  last_distilled_at?: string | null;
  facts?: {
    context_revision?: number;
    explicit_context?: Partial<Record<ProfileField, ExplicitContextValue>>;
    [key: string]: unknown;
  };
  effective_context?: EffectiveContextItem[];
  work_patterns?: WorkPatterns;
  profile?: ProfileData;
  dashboard?: ProfileDashboard;
  advice?: AdviceState;
  feedback?: {
    advice?: Record<string, AdviceFeedback>;
    artifacts?: Record<string, ArtifactFeedback>;
  };
  evidence_index?: Record<string, EvidenceRef>;
  projection_error?: {
    code: "user_projection_failed" | string;
    occurred_at: string;
    profile_revision: number;
  } | null;
  evidence?: Record<string, unknown>;
  trajectory?: TrajectoryPoint[];
  visualizations?: Record<string, unknown>;
}

export interface WorkPatterns {
  frequent_tasks?: string[];
  preferred_tools?: string[];
  tool_chains?: string[];
  active_hours?: string;
  output_style?: "concise" | "detailed" | "adaptive" | string;
  work_focus?: string;
  confidence?: number;
  evidence?: {
    top_tools?: { tool: string; count: number }[];
    tool_chains?: { chain: string; count: number }[];
    hourly_distribution?: Record<string, number>;
    daily_distribution?: Record<string, number>;
    tool_success?: Record<string, { success: number; total: number }>;
    by_agent?: Record<string, Record<string, unknown>>;
    by_conversation_type?: Record<string, Record<string, unknown>>;
    attributions?: Array<Record<string, unknown>>;
    tool_usage_scope?: "agent_execution" | string;
    user_preference_tools?: Array<Record<string, unknown>>;
  };
  visualizations?: {
    top_tools_chart?: { tool: string; count: number }[];
    tool_chain_sankey?: { chain: string; count: number }[];
    active_hours_heatmap?: { hour: number; count: number }[];
  };
}

export interface ProfileData {
  understanding?: UnderstandingItem[];
  identity?: {
    primary_role?: string;
    secondary_roles?: string[];
    timezone_hint?: string;
  };
  tech_stack?: { area: string; items: string[] }[];
  interests?: string[];
  pain_points?: PainPoint[];
  open_questions?: string[];
  knowledge_structure?: {
    deep_areas?: string[];
    exploring_areas?: string[];
  };
  relationships?: {
    frequent_contacts?: string[];
    collaboration_pattern?: string;
  };
  work_rhythm?: {
    active_hours?: string;
    intensity?: "light" | "moderate" | "heavy" | string;
  };
  confidence?: number;
  evidence?: {
    note_distribution?: { notebook: string; count: number }[];
    tag_distribution?: { tag: string; count: number }[];
    title_keywords?: { keyword: string; count: number }[];
    top_senders?: { sender: string; address?: string; count: number }[];
    notes_monthly?: Record<string, number>;
    total_notes?: number;
    keyword_first_seen?: Record<string, string>;
    session_topics?: { title: string; tools: string[] }[];
    total_sessions?: number;
  };
  visualizations?: {
    radar_scores?: RadarScore[];
    skill_matrix?: SkillItem[];
    knowledge_graph?: KnowledgeGraph;
    milestones?: Milestone[];
    tech_stack_radar?: { axes: { axis: string; value: number }[] };
    knowledge_structure_bar?: { notebook: string; count: number }[];
    relationship_graph?: {
      nodes: { id: string; label: string; group: number; size?: number }[];
      links: { source: string; target: string; weight?: number }[];
    };
    tag_cloud?: { tag: string; count: number }[];
  };
}

export type ObservedProfileField =
  | "background"
  | "current_focus"
  | "preferences"
  | "work_context"
  | "interests";
export type ProfileField = ObservedProfileField | "special_instructions";
export type AdviceDimension = "learning" | "method" | "reuse" | "opportunity";

export interface ExplicitContextValue {
  mode: "override" | "suppress";
  value: string;
  updated_at: string;
}

export interface UnderstandingItem {
  field: ObservedProfileField;
  text: string;
  source_refs: string[];
  observed_at?: string | null;
}

export interface EffectiveContextItem {
  field: ProfileField;
  value: string;
  origin: "confirmed" | "observed" | "suppressed" | "missing";
  source_refs: string[];
}

export interface EvidenceRef {
  ref: string;
  kind: "user_message" | "note" | "artifact" | "explicit_context";
  source_scope_id: string;
  title: string;
  occurred_at: string | null;
  excerpt: string;
  truncated: boolean;
  session_key?: string;
  message_id?: string;
  message_index?: number;
  note_relative_path?: string;
  artifact_id?: string;
  content_hash: string;
  available?: boolean;
}

export interface AdviceContent {
  id: string;
  kind?: "holistic_learning" | "one_insight";
  dimension: AdviceDimension;
  title: string;
  why_now: string;
  source_refs: string[];
  knowledge?: {
    title: string;
    content: string;
  };
  learning_advice?: string;
  knowledge_area?: string;
  application_areas?: Array<{
    area: string;
    benefit: string;
  }>;
  resources?: Array<{
    title: string;
    url: string;
    source?: string;
    language?: string;
    reading_hint?: string;
    found_at?: string;
  }>;
  first_step: string;
  starter_content: string;
  expected_output: string;
  done_when: string;
  start_prompt: string;
  created_at: string;
  last_supported_at: string;
  source_scope_id: string;
}

export interface AdviceFeedback {
  revision: number;
  useful: boolean | null;
  disposition: "active" | "dismissed" | "completed";
  dismiss_reason: "already_known" | "not_now" | "incorrect" | null;
  updated_at: string | null;
}

export interface ArtifactFeedback {
  revision: number;
  adopted: boolean;
  updated_at: string;
}

export interface AdviceState {
  current_ids?: string[];
  items?: AdviceContent[];
  generated_at?: string | null;
  last_attempt_at?: string | null;
  generation_status?: "ready" | "empty" | "unavailable" | "failed" | "stale";
  empty_reason?: string;
  input_fingerprint?: string;
  context_revision_used?: number;
}

export interface MetricValue {
  value: number | null;
  availability: "available" | "partial" | "unavailable";
}

export interface MetricComparison {
  current: MetricValue;
  previous: MetricValue;
  delta: number | null;
  comparison_available: boolean;
  comparison_reason?: string | null;
}

export interface SourceCoverage {
  source: "sessions" | "notes" | "artifacts" | "agent_execution";
  status: "available" | "partial" | "unavailable";
  scanned_count: number;
  selected_count: number;
  unknown_time_count: number;
  assumed_timezone_count: number;
  truncated_count: number;
  earliest: string | null;
  latest: string | null;
  reason_code: string | null;
}

export interface ProfileArtifact {
  id: string;
  title: string;
  mime: string | null;
  first_recorded_at: string | null;
  session_key: string;
  room_id?: string | null;
  created_by_agent_id?: string | null;
  artifact_ref: Record<string, unknown>;
  source_ref: string;
  missing: boolean;
  adopted?: boolean;
  feedback_revision?: number;
}

export interface ProfileDashboard {
  as_of?: string;
  window_start?: string;
  window_end?: string;
  previous_start?: string;
  source_scope_id?: string;
  timezone?: string;
  metrics?: Record<string, MetricComparison>;
  coverage?: SourceCoverage[];
  daily_activity?: Array<{ date: string; user_messages: number }>;
  topic_records?: Array<{
    topic: string;
    count: number;
    previous_count?: number;
    delta?: number;
    source: string;
  }>;
  artifacts?: ProfileArtifact[];
  profile_charts?: ProfileCharts;
}

export interface ProfileCharts {
  profile_dimensions: Array<{ axis: string; count: number }>;
  previous_profile_dimensions: Array<{ axis: string; count: number }>;
  topic_graph: {
    nodes: Array<{ id: string; label: string; group: string; count: number }>;
    links: Array<{ source: string; target: string; weight: number }>;
  };
  collaboration_types: Array<{ label: string; count: number }>;
  artifact_types: Array<{ label: string; count: number }>;
  domain_task_matrix: {
    domains: string[];
    tasks: string[];
    values: number[][];
  };
  topic_trends: {
    labels: string[];
    series: Array<{ topic: string; values: number[] }>;
  };
  topic_comparison: Array<{
    topic: string;
    current: number;
    previous: number;
    delta: number;
  }>;
  new_topics: Array<{ topic: string; count: number; first_seen_at: string }>;
}

export interface RadarScore {
  axis: string;
  key: string;
  value: number;
  raw_signal?: number;
}

/** 用户反复纠结/卡住的问题（由蒸馏 LLM 从对话提炼，带新鲜度）。 */
export interface PainPoint {
  topic: string;
  detail?: string;
  /** 最后一次出现该信号的月份，格式 YYYY-MM */
  last_seen?: string;
}

export interface SkillItem {
  area: string;
  level: number;
  score: number;
  note_count: number;
}

export interface KnowledgeGraph {
  nodes: { id: string; label: string; group: number; size?: number }[];
  links: { source: string; target: string; weight?: number }[];
}

export interface Milestone {
  type: string;
  title: string;
  date: string;
  icon: string;
  description: string;
}

export interface GrowthComparison {
  current_radar: RadarScore[];
  previous_radar: RadarScore[];
  new_skills: string[];
  skill_progression: { skill: string; before: number; after: number; delta: number }[];
  current_snapshot_date?: string;
  previous_snapshot_date?: string;
}

export interface TrajectoryPoint {
  timestamp: string;
  task: string;
  confidence: number;
  data_snapshot?: Record<string, unknown>;
}

export interface DistillResult {
  ok: boolean;
  task?: string;
  confidence?: number;
  error?: string;
  code?: string;
  status?: "success" | "empty" | "reused" | "failed" | "skipped";
  results?: Array<{
    task: string;
    success: boolean;
    confidence: number;
    error?: string;
    code?: string;
    status?: "success" | "empty" | "reused" | "failed" | "skipped";
  }>;
}

export class ProfileApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ProfileApiError";
  }
}

async function _jsonRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const base = await getServicesHttpBase();
  const res = await httpFetch(`${base}${path}`, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let code: string | undefined;
    let body: unknown;
    try {
      body = await res.json();
      if (body && typeof body === "object") {
        const payload = body as { error?: string; code?: string };
        if (payload.error) msg = payload.error;
        code = payload.code;
      }
    } catch {
      // 忽略 JSON 解析错误
    }
    throw new ProfileApiError(msg, res.status, code, body);
  }
  return (await res.json()) as T;
}

/** 获取 profile.rich.json 全量数据。 */
export async function fetchProfile(): Promise<RichProfile> {
  return _jsonRequest<RichProfile>("/api/profile", { method: "GET" });
}

/** 获取 USER.md 内容。 */
export async function fetchUserMd(): Promise<string> {
  const data = await _jsonRequest<{ content: string }>(
    "/api/profile/user",
    { method: "GET" },
  );
  return data.content ?? "";
}

/** 更新 USER.md 的某个 section（或 full 全量替换）。 */
export async function updateUserSection(
  section: string,
  content: string,
): Promise<{ ok: boolean; mode: string; section?: string }> {
  return _jsonRequest<{ ok: boolean; mode: string; section?: string }>(
    "/api/profile/user",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, content }),
    },
  );
}

/** 全量替换 USER.md。 */
export async function updateUserFull(
  full: string,
): Promise<{ ok: boolean; mode: string }> {
  return _jsonRequest<{ ok: boolean; mode: string }>(
    "/api/profile/user",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full }),
    },
  );
}

/** 手动触发蒸馏。task: "work-pattern" | "profile" | "all"。 */
export async function triggerDistill(
  task: "work-pattern" | "profile" | "advice" | "all" = "all",
): Promise<DistillResult> {
  return _jsonRequest<DistillResult>("/api/profile/distill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });
}

export async function updateProfileContext(input: {
  field: ProfileField;
  mode: "override" | "suppress" | "reset";
  value?: string;
  expected_context_revision: number;
}): Promise<{
  ok: boolean;
  revision: number;
  context_revision: number;
  effective_context: EffectiveContextItem[];
  warning?: { code: string; message: string };
}> {
  return _jsonRequest("/api/profile/context", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateAdviceFeedback(
  id: string,
  input: {
    useful?: boolean;
    disposition?: "active" | "dismissed" | "completed";
    dismiss_reason?: "already_known" | "not_now" | "incorrect";
    expected_item_revision: number;
  },
): Promise<AdviceFeedback & { profile_revision: number; current_ids: string[] }> {
  return _jsonRequest(`/api/profile/advice/${encodeURIComponent(id)}/feedback`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateArtifactFeedback(
  id: string,
  adopted: boolean,
  expectedItemRevision: number,
): Promise<ArtifactFeedback & { profile_revision: number }> {
  return _jsonRequest(`/api/profile/artifacts/${encodeURIComponent(id)}/feedback`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adopted, expected_item_revision: expectedItemRevision }),
  });
}

export async function fetchProfileEvidence(ref: string): Promise<EvidenceRef> {
  return _jsonRequest(`/api/profile/evidence/${encodeURIComponent(ref)}`, { method: "GET" });
}

export interface ProfileStartRequest {
  prompt: string;
  advice_id: string;
  source_refs: string[];
  origin: "profile_advice";
  evidence: EvidenceRef[];
}

export async function prepareAdviceStart(id: string): Promise<ProfileStartRequest> {
  return _jsonRequest(`/api/profile/advice/${encodeURIComponent(id)}/start`, { method: "POST" });
}

/** 获取成长对比数据。 */
export async function fetchGrowthComparison(
  date?: string,
): Promise<{
  comparison: GrowthComparison | null;
  snapshots: { date: string; keywords_count: number }[];
}> {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return _jsonRequest(`/api/profile/comparison${query}`, { method: "GET" });
}

/** 获取所有历史快照。 */
export async function fetchSnapshots(): Promise<{
  snapshots: Array<{
    date: string;
    radar_scores?: RadarScore[];
    keywords?: { keyword: string; count: number }[];
  }>;
}> {
  return _jsonRequest("/api/profile/snapshots", { method: "GET" });
}
