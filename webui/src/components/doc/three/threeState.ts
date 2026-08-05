/**
 * 3D 项目聚合状态（由服务端从 object-sculpt-spec.json 推导）。
 * 前端不维护第二套阶段真相，仅渲染服务端结果。
 */

import { getServicesHttpBase } from "@/lib/api";

export type ThreeStageStatus =
  | "pending"
  | "running"
  | "review"
  | "passed"
  | "failed"
  | "blocked";

export interface ThreeStage {
  id: string;
  status: ThreeStageStatus;
}

export interface ThreeComponent {
  id: string;
  name: string;
  role: string;
  primitive: string;
}

export interface ThreeFileEntry {
  name: string;
  path: string;
}

export interface ThreeReviewEntry {
  passId?: string;
  action?: string;
  summary?: string;
}

export interface ThreeProjectState {
  name: string;
  meta: Record<string, unknown>;
  specPresent: boolean;
  specHash: string;
  stages: ThreeStage[];
  blockedReason: string;
  components: ThreeComponent[];
  references: ThreeFileEntry[];
  renders: ThreeFileEntry[];
  comparisons: ThreeFileEntry[];
  reports: ThreeFileEntry[];
  candidatePresent: boolean;
  candidateBaseHash: string | null;
  sourcePresent: boolean;
  lastReview: ThreeReviewEntry | null;
}

export interface ThreeCandidateChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
}

export interface ThreeCandidateDiff {
  specHash: string;
  candidateBaseHash: string | null;
  stale: boolean;
  changes: ThreeCandidateChange[];
  truncated: boolean;
}

export const STAGE_LABELS: Record<string, string> = {
  "blockout": "粗模",
  "structural-pass": "结构",
  "form-refinement": "形体",
  "material-pass": "材质",
  "surface-pass": "表面",
  "lighting-pass": "灯光",
  "interaction-pass": "交互",
  "optimization-pass": "优化",
};

export const STATUS_LABELS: Record<ThreeStageStatus, string> = {
  pending: "待处理",
  running: "进行中",
  review: "评审中",
  passed: "已通过",
  failed: "未通过",
  blocked: "已阻塞",
};

export function stageLabel(id: string): string {
  return STAGE_LABELS[id] ?? id;
}

export function projectFileUrl(base: string, name: string, path: string): string {
  return `${base}/api/three/project/file?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`;
}

export async function fetchProjectState(name: string): Promise<ThreeProjectState> {
  const base = await getServicesHttpBase();
  const resp = await fetch(`${base}/api/three/project?name=${encodeURIComponent(name)}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as ThreeProjectState;
}

export async function fetchProjectFileText(name: string, path: string): Promise<string> {
  const base = await getServicesHttpBase();
  const resp = await fetch(projectFileUrl(base, name, path));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

export async function fetchCandidateDiff(name: string): Promise<ThreeCandidateDiff> {
  const base = await getServicesHttpBase();
  const resp = await fetch(
    `${base}/api/three/project/candidate/diff?name=${encodeURIComponent(name)}`,
    { headers: { Accept: "application/json" } },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as ThreeCandidateDiff;
}

export async function applyCandidate(name: string): Promise<void> {
  const base = await getServicesHttpBase();
  const resp = await fetch(`${base}/api/three/project/candidate/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }
}

export async function discardCandidate(name: string): Promise<void> {
  const base = await getServicesHttpBase();
  const resp = await fetch(`${base}/api/three/project/candidate/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
}

export async function downloadProjectFile(
  name: string,
  path: string,
  filename: string,
): Promise<void> {
  const base = await getServicesHttpBase();
  const resp = await fetch(projectFileUrl(base, name, path));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface UploadedReference {
  path: string;
  name: string;
}

export async function uploadReferenceImage(
  name: string,
  dataUrl: string,
  filename?: string,
): Promise<UploadedReference> {
  const base = await getServicesHttpBase();
  const resp = await fetch(`${base}/api/three/project/reference`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, dataUrl, filename }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as UploadedReference;
}
