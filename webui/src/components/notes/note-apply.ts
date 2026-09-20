/**
 * 普通笔记 AI 结果应用器（替代「AI 只能生成、用户手动追加/替换」的旧路径）。
 *
 * 结构化契约两种：
 *   1. ```note-patch：局部修改，block 内为 JSON `{ baseHash, edits: [{ find, replace }] }`；
 *   2. ```note-replace：整篇重写，block 内为完整 Markdown 正文。
 *
 * 与思维导图 / 流程图应用器对齐的 dry-run 流程：
 *   - prepareNotePatch：解析 + 在副本上试应用，返回 PendingNotePatch 供 UI 预览（不修改正文）；
 *   - applyPendingPatch：对中心状态再次校验 baseHash 后原子应用。
 *
 * 自动应用策略：note-patch 且 baseHash 仍匹配时自动应用；note-replace 一律进入待确认卡片。
 */

/** patch 应用模式 */
export type NoteApplyMode = "patch" | "replace";

/** 单条局部修改：find 必须在当前正文中逐字存在且唯一 */
export interface NoteEdit {
  find: string;
  replace: string;
}

/** note-patch fenced block 的载荷 */
export interface NotePatch {
  baseHash: string;
  edits: NoteEdit[];
}

/** 待确认的笔记修改（预览态，未应用） */
export interface PendingNotePatch {
  /** AI 回答所在的 message ID */
  messageId: string;
  /** 发起请求时的 baseHash，用于检测生成期间笔记是否被修改 */
  requestBaseHash: string;
  mode: NoteApplyMode;
  /** mode === "patch" 时存在 */
  patch?: NotePatch;
  /** dry-run 产生的目标正文，供应用时直接使用 */
  proposedMarkdown: string;
  /** 变更摘要 */
  summary: { edited: number } | { replaced: true };
  /** 状态机：ready 可应用，stale 期间笔记已变，applied 已应用，ignored 已忽略，invalid dry-run 失败 */
  status: "ready" | "stale" | "applied" | "ignored" | "invalid";
  /** invalid/stale 时的错误信息 */
  error?: string;
}

export type PrepareNoteResult =
  | { ok: true; pending: PendingNotePatch }
  | { ok: false; message: string };

export type ApplyNotePendingResult =
  | { ok: true; markdown: string; notice: string }
  | { ok: false; message: string; notice: string };

/** 正文简单哈希，用于 baseHash 乐观锁校验 */
export function computeNoteBaseHash(markdown: string): string {
  let hash = 0;
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}

/**
 * 从 AI 回答中提取指定语言的最后一个 fenced block。
 *
 * 取最后一个开围栏 + 其后最后一个闭围栏，避免正文里的 ``` 代码块把内容截断。
 */
function extractFencedBlock(text: string, lang: string): string | null {
  const openRe = new RegExp("```" + lang + "\\s*\\r?\\n", "g");
  let open: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(text)) !== null) open = match;
  if (!open) return null;

  const rest = text.slice(open.index + open[0].length);
  const closeIndex = rest.lastIndexOf("```");
  const body = closeIndex >= 0 ? rest.slice(0, closeIndex) : rest;
  return body.trim();
}

/** AI 回答中是否包含结构化笔记修改指令（用于隐藏「追加/替换」手动按钮） */
export function hasStructuredNoteEdit(content: string): boolean {
  return (
    extractFencedBlock(content, "note-patch") !== null ||
    extractFencedBlock(content, "note-replace") !== null
  );
}

/** 解析 note-patch JSON 载荷；失败时返回错误信息，不抛异常 */
export function parseNotePatch(
  jsonText: string,
): { ok: true; patch: NotePatch } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, message: "修改指令 JSON 解析失败" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "修改指令必须是对象" };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.baseHash !== "string" || !obj.baseHash) {
    return { ok: false, message: "修改指令缺少 baseHash" };
  }
  if (!Array.isArray(obj.edits) || obj.edits.length === 0) {
    return { ok: false, message: "修改指令缺少 edits 数组" };
  }

  const edits: NoteEdit[] = [];
  for (let i = 0; i < obj.edits.length; i++) {
    const raw = obj.edits[i];
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, message: `edits[${i}] 不是对象` };
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.find !== "string" || !item.find) {
      return { ok: false, message: `edits[${i}] 缺少 find 原文片段` };
    }
    if (typeof item.replace !== "string") {
      return { ok: false, message: `edits[${i}] 缺少 replace 字符串` };
    }
    edits.push({ find: item.find, replace: item.replace });
  }

  return { ok: true, patch: { baseHash: obj.baseHash, edits } };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export type ApplyNotePatchResult =
  | { ok: true; markdown: string; edited: number }
  | { ok: false; message: string };

/**
 * 应用 note-patch：先校验 baseHash 仍匹配，再逐条替换。
 * 任一条 find 不存在或不唯一则整个 patch 不应用（原子性）。
 */
export function applyNotePatch(
  currentMarkdown: string,
  patch: NotePatch,
): ApplyNotePatchResult {
  const currentHash = computeNoteBaseHash(currentMarkdown);
  if (patch.baseHash !== currentHash) {
    return { ok: false, message: "笔记内容已变化，修改指令已过期" };
  }

  let next = currentMarkdown;
  for (let i = 0; i < patch.edits.length; i++) {
    const { find, replace } = patch.edits[i];
    const occurrences = countOccurrences(next, find);
    if (occurrences === 0) {
      return { ok: false, message: `edits[${i}] 未在笔记正文中找到原文片段` };
    }
    if (occurrences > 1) {
      return { ok: false, message: `edits[${i}] 原文片段在笔记中出现 ${occurrences} 次，无法定位` };
    }
    next = next.replace(find, replace);
  }

  return { ok: true, markdown: next, edited: patch.edits.length };
}

/**
 * 解析 AI 回答并 dry-run，不修改原正文。
 * 没有结构化 block 时返回 ok:false，让调用方按普通回答处理。
 */
export function prepareNotePatch(
  aiContent: string,
  currentMarkdown: string,
  messageId: string,
  requestBaseHash: string,
): PrepareNoteResult {
  const patchBlock = extractFencedBlock(aiContent, "note-patch");
  if (patchBlock !== null) {
    const parsed = parseNotePatch(patchBlock);
    if (!parsed.ok) {
      return {
        ok: true,
        pending: {
          messageId,
          requestBaseHash,
          mode: "patch",
          proposedMarkdown: currentMarkdown,
          summary: { edited: 0 },
          status: "invalid",
          error: parsed.message,
        },
      };
    }

    const result = applyNotePatch(currentMarkdown, parsed.patch);
    if (!result.ok) {
      const stale = parsed.patch.baseHash !== computeNoteBaseHash(currentMarkdown);
      return {
        ok: true,
        pending: {
          messageId,
          requestBaseHash,
          mode: "patch",
          patch: parsed.patch,
          proposedMarkdown: currentMarkdown,
          summary: { edited: 0 },
          // baseHash 不一致说明笔记在生成期间被改过：标记过期而非格式错误
          status: stale ? "stale" : "invalid",
          error: result.message,
        },
      };
    }

    return {
      ok: true,
      pending: {
        messageId,
        requestBaseHash,
        mode: "patch",
        patch: parsed.patch,
        proposedMarkdown: result.markdown,
        summary: { edited: result.edited },
        status: "ready",
      },
    };
  }

  const replaceBlock = extractFencedBlock(aiContent, "note-replace");
  if (replaceBlock !== null) {
    if (!replaceBlock) {
      return {
        ok: true,
        pending: {
          messageId,
          requestBaseHash,
          mode: "replace",
          proposedMarkdown: currentMarkdown,
          summary: { replaced: true },
          status: "invalid",
          error: "note-replace 内容为空",
        },
      };
    }
    return {
      ok: true,
      pending: {
        messageId,
        requestBaseHash,
        mode: "replace",
        proposedMarkdown: replaceBlock,
        summary: { replaced: true },
        status: "ready",
      },
    };
  }

  return { ok: false, message: "AI 回答中未找到 ```note-patch 或 ```note-replace block" };
}

/**
 * 应用 pending：patch 模式再次校验 baseHash 后重新应用；replace 模式直接使用 dry-run 结果
 * （整篇重写必须由用户确认，不做自动应用）。
 * 失败时调用方应把 pending 标记为 stale。
 */
export function applyPendingNotePatch(
  pending: PendingNotePatch,
  currentMarkdown: string,
): ApplyNotePendingResult {
  if (pending.status === "applied") {
    return { ok: false, message: "已应用过", notice: "该修改已应用" };
  }
  if (pending.status === "ignored") {
    return { ok: false, message: "已忽略", notice: "该修改已忽略" };
  }
  if (pending.status === "invalid") {
    return { ok: false, message: pending.error ?? "修改无效", notice: "修改无效" };
  }

  if (pending.mode === "patch" && pending.patch) {
    const result = applyNotePatch(currentMarkdown, pending.patch);
    if (!result.ok) {
      return { ok: false, message: result.message, notice: "应用失败（笔记已修改），请重新生成" };
    }
    return {
      ok: true,
      markdown: result.markdown,
      notice: `已更新笔记：修改 ${result.edited} 处`,
    };
  }

  return { ok: true, markdown: pending.proposedMarkdown, notice: "已重写笔记正文" };
}

/** 仅计算 baseHash，供调用方在发送 AI 请求前快照基线 */
export function snapshotNoteBaseHash(currentMarkdown: string): string {
  return computeNoteBaseHash(currentMarkdown);
}
