/** 用户画像 API 客户端 — 调用 gateway HTTP server 的 /api/profile/* 路由。
 *
 * 这些路由为公开路由（无鉴权），与 scheduleApi 一致，使用 httpFetch 不带 token。 */

import { getGatewayHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";

/** profile.rich.json 顶层结构。 */
export interface RichProfile {
  version?: string;
  last_distilled_at?: string | null;
  facts?: Record<string, unknown>;
  work_patterns?: WorkPatterns;
  profile?: ProfileData;
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
  };
  visualizations?: {
    top_tools_chart?: { tool: string; count: number }[];
    tool_chain_sankey?: { chain: string; count: number }[];
    active_hours_heatmap?: { hour: number; count: number }[];
  };
}

export interface ProfileData {
  identity?: {
    primary_role?: string;
    secondary_roles?: string[];
    timezone_hint?: string;
  };
  tech_stack?: { area: string; items: string[] }[];
  interests?: string[];
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

export interface RadarScore {
  axis: string;
  key: string;
  value: number;
  raw_signal?: number;
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
  results?: Array<{
    task: string;
    success: boolean;
    confidence: number;
    error?: string;
  }>;
}

async function _jsonRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const base = await getGatewayHttpBase();
  const res = await httpFetch(`${base}${path}`, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // 忽略 JSON 解析错误
    }
    throw new Error(msg);
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
  task: "work-pattern" | "profile" | "all" = "all",
): Promise<DistillResult> {
  return _jsonRequest<DistillResult>("/api/profile/distill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });
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
