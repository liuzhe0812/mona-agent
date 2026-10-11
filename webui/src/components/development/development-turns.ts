import { isRunActive, type DevMessage, type DevRun } from "@/lib/development-api";

export interface DevelopmentTurn {
  id: string;
  userPreview: string;
  assistantPreview: string;
  running: boolean;
}

const INTERNAL_SOURCE_KINDS = new Set(["collaboration", "runtime", "steering"]);
const PREVIEW_SCAN_LIMIT = 4096;
const PREVIEW_LIMIT = 220;

function truncatePreview(value: string): string {
  const chars = Array.from(value);
  return chars.length > PREVIEW_LIMIT ? `${chars.slice(0, PREVIEW_LIMIT - 1).join("")}…` : value;
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\((?:<[^>]*>|[^)]*)\)/g, (_match, alt: string) => alt.trim() || "图片附件")
    .replace(/!\[([^\]]*)\]\s*\[[^\]]*\]/g, (_match, alt: string) => alt.trim() || "图片附件")
    .replace(/data:[a-z0-9.+/-]+(?:;[a-z0-9=.+_-]*)*,[^\s<>)\]]+/gi, "")
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:<[^>]*>|[^)]*)\)/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/\*\*(.*?)\*\*|__(.*?)__/g, (_match, a: string, b: string) => a ?? b)
    .replace(/\*(.*?)\*|_(.*?)_/g, (_match, a: string, b: string) => a ?? b)
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, "$1")
    .replace(/[ \t]*\|[ \t]*/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, " ")
    .trim();
}

function mediaPreview(message: DevMessage, response: boolean): string {
  const media = message.media ?? [];
  if (media.some((item) => item.kind === "image")) return response ? "图片回复" : "图片附件";
  if (media.some((item) => item.kind === "audio")) return response ? "音频回复" : "音频附件";
  if (media.some((item) => item.kind === "video")) return response ? "视频回复" : "视频附件";
  if (media.length) return response ? "文件回复" : "文件附件";
  return "";
}

function messagePreview(message: DevMessage, response: boolean): string {
  const source = message.content.slice(0, PREVIEW_SCAN_LIMIT);
  const plain = stripMarkdown(source);
  const hasInlineImage = /!\[[^\]]*\]\s*(?:\([^)]*\)|\[[^\]]*\])|data:image\//i.test(source);
  return truncatePreview(plain || mediaPreview(message, response) || (hasInlineImage ? response ? "图片回复" : "图片附件" : ""));
}

function isInternal(message: DevMessage): boolean {
  return INTERNAL_SOURCE_KINDS.has(message.sourceKind ?? "");
}

/** Build one rail item per delivered user request, binding answers through run identity. */
export function buildDevelopmentTurns(
  messages: DevMessage[],
  runs: DevRun[],
  live?: { runId: string; content: string } | null,
): DevelopmentTurn[] {
  const runByRequestMessage = new Map(runs.flatMap((run) =>
    run.requestMessageId ? [[run.requestMessageId, run] as const] : []));
  const turns: DevelopmentTurn[] = [];
  const turnByMessageId = new Map<string, DevelopmentTurn>();
  const runIdByTurn = new Map<DevelopmentTurn, string>();

  for (const message of messages) {
    if (message.role !== "user" || message.queued || isInternal(message)) continue;
    const turn: DevelopmentTurn = {
      id: message.id,
      userPreview: messagePreview(message, false) || "暂无内容",
      assistantPreview: "暂无回复",
      running: false,
    };
    turns.push(turn);
    turnByMessageId.set(message.id, turn);
    const runId = message.runId ?? runByRequestMessage.get(message.id)?.id;
    if (runId) runIdByTurn.set(turn, runId);
  }

  const turnByRunId = new Map<string, DevelopmentTurn>();
  for (const turn of turns) {
    const runId = runIdByTurn.get(turn);
    if (runId && !turnByRunId.has(runId)) turnByRunId.set(runId, turn);
  }
  for (const run of runs) {
    const turn = run.requestMessageId ? turnByMessageId.get(run.requestMessageId) : undefined;
    if (turn) {
      runIdByTurn.set(turn, run.id);
      turnByRunId.set(run.id, turn);
    }
  }

  const runByResultMessage = new Map(runs.flatMap((run) =>
    run.resultMessageId ? [[run.resultMessageId, run] as const] : []));
  const assistantByTurn = new Map<DevelopmentTurn, string>();
  let latestTurn: DevelopmentTurn | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (!message.queued && !isInternal(message)) latestTurn = turnByMessageId.get(message.id);
      continue;
    }
    if (message.role !== "assistant" || message.toolCalls.length > 0 || isInternal(message)) continue;
    const runId = message.runId ?? runByResultMessage.get(message.id)?.id;
    const turn = runId
      ? turnByRunId.get(runId)
      : latestTurn && !runIdByTurn.has(latestTurn) ? latestTurn : undefined;
    if (!turn) continue;
    const preview = messagePreview(message, true);
    if (preview) assistantByTurn.set(turn, preview);
  }

  const runById = new Map(runs.map((run) => [run.id, run]));
  for (const turn of turns) {
    const runId = runIdByTurn.get(turn);
    const run = runId ? runById.get(runId) : undefined;
    const isLive = !!runId && live?.runId === runId;
    turn.running = run ? isRunActive(run) : isLive;
    if (isLive) {
      turn.assistantPreview = stripMarkdown(live!.content.slice(0, PREVIEW_SCAN_LIMIT)) || "正在回复…";
      turn.assistantPreview = truncatePreview(turn.assistantPreview);
    } else {
      turn.assistantPreview = assistantByTurn.get(turn) || (turn.running ? "正在回复…" : "暂无回复");
    }
  }

  return turns;
}
