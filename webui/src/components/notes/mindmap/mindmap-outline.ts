/**
 * Markdown 大纲解析与序列化。
 *
 * 规范：
 * 1. 一个一级标题作为根节点；
 * 2. 根节点后使用无序列表表示子节点；
 * 3. 每层使用两个空格缩进；
 * 4. 节点内容为单行纯文本；
 * 5. 空行忽略；
 * 6. 同级节点允许重名；
 * 7. [[wiki link]] 作为普通节点文本保留；
 * 8. 不允许跳级缩进；
 * 9. 不允许根节点之外的普通段落、代码块、表格和引用。
 *
 * 存储格式 v2（见 docs/plans/mindmap-dev-plan.md §7）：
 * - 节点行末可附 `<!-- mona:mindmap-v1 {"id":"...","note":"...",...} -->` 注释；
 * - 注释内 JSON 必须标准转义；
 * - 旧格式无注释时仍能解析，节点 ID 在运行时生成（不持久化）；
 * - 序列化时若节点含扩展字段或稳定 ID，写回注释；首次修改后自动升级到 v2。
 * - 字段集与 Mind Elixir NodeObj 对齐，不引入不存在的字段。
 */

export interface MindMapNodeStyle {
  fontSize?: string;
  color?: string;
  background?: string;
  fontWeight?: string;
  border?: string;
}

export interface MindMapNodeImage {
  url: string;
  width: number;
  height: number;
  fit?: "fill" | "contain" | "cover";
}

export interface MindMapNode {
  id: string;
  topic: string;
  children: MindMapNode[];
  /** 节点备注（长文本，不显示在主结构中） */
  note?: string;
  /** 图标/标记（如 priority-1、flag、star） */
  icons?: string[];
  /** 超链接（URL） */
  hyperLink?: string;
  /** 节点内图片 */
  image?: MindMapNodeImage;
  /** 自定义样式 */
  style?: MindMapNodeStyle;
  /** 未识别的扩展元数据，原样保留 */
  metadata?: Record<string, unknown>;
}

export type ParseMindMapResult =
  | { ok: true; root: MindMapNode; plainText: string }
  | { ok: false; message: string; line: number };

const LIST_ITEM_RE = /^(\s*)[-*+]\s+(.+)$/;
/** 行末 v2 元数据注释，如 `... <!-- mona:mindmap-v1 {"id":"..."} -->` */
const METADATA_COMMENT_RE = /\s*<!--\s*mona:mindmap-v1\s+(\{.*?\})\s*-->\s*$/;
/** v2 注释的命名空间前缀 */
const METADATA_NS = "mona:mindmap-v1";

/**
 * 生成稳定节点 ID（UUID v4）。
 * 优先使用 crypto.randomUUID()；不可用时回退到随机字符串。
 */
export function generateNodeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `node-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * 从节点行内容中剥离并解析 v2 元数据注释。
 * 返回 [纯 topic, 元数据对象 | null]。
 * 元数据 JSON 解析失败时返回 null（不阻塞解析）。
 */
function extractMetadata(rawTopic: string): [string, Record<string, unknown> | null] {
  const m = rawTopic.match(METADATA_COMMENT_RE);
  if (!m) return [rawTopic.trim(), null];
  const topicWithoutComment = rawTopic.replace(METADATA_COMMENT_RE, "").trim();
  try {
    const obj = JSON.parse(m[1]);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      return [topicWithoutComment, obj as Record<string, unknown>];
    }
  } catch {
    // JSON 解析失败：忽略注释，保留纯 topic
  }
  return [topicWithoutComment, null];
}

/** v2 元数据中已知字段的键集合（用于区分已知字段与未识别 metadata） */
const KNOWN_METADATA_KEYS = new Set(["id", "note", "icons", "hyperLink", "image", "style"]);

/**
 * 把 v2 元数据对象应用到 MindMapNode。
 * 已知字段按类型校验后赋值；未识别字段归入 `metadata`。
 */
function applyMetadata(node: MindMapNode, meta: Record<string, unknown>): void {
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    switch (key) {
      case "id":
        if (typeof value === "string" && value.length > 0) node.id = value;
        break;
      case "note":
        if (typeof value === "string") node.note = value;
        break;
      case "icons":
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) node.icons = value;
        break;
      case "hyperLink":
        if (typeof value === "string") node.hyperLink = value;
        break;
      case "image":
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const img = value as { url?: unknown; width?: unknown; height?: unknown; fit?: unknown };
          if (typeof img.url === "string" && typeof img.width === "number" && typeof img.height === "number") {
            const image: MindMapNodeImage = { url: img.url, width: img.width, height: img.height };
            if (img.fit === "fill" || img.fit === "contain" || img.fit === "cover") image.fit = img.fit;
            node.image = image;
          }
        }
        break;
      case "style":
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          const s = value as Record<string, unknown>;
          const style: MindMapNodeStyle = {};
          if (typeof s.fontSize === "string") style.fontSize = s.fontSize;
          if (typeof s.color === "string") style.color = s.color;
          if (typeof s.background === "string") style.background = s.background;
          if (typeof s.fontWeight === "string") style.fontWeight = s.fontWeight;
          if (typeof s.border === "string") style.border = s.border;
          if (Object.keys(style).length > 0) node.style = style;
        }
        break;
      default:
        // 未识别字段原样保留到 metadata
        unknown[key] = value;
        break;
    }
  }
  if (Object.keys(unknown).length > 0) node.metadata = unknown;
}

/**
 * 解析 Markdown 大纲为思维导图树。
 * 解析失败时返回错误信息和行号，不抛异常。
 *
 * v2 行为：
 * - 行末 `<!-- mona:mindmap-v1 {...} -->` 注释中的 id 优先作为节点 ID（稳定 ID）；
 * - 无注释或无 id 字段时，运行时生成随机 ID（不持久化）；
 * - 已知字段（note/icons/hyperLink/image/style）按类型校验后赋值；
 * - 未识别字段原样保留到 node.metadata。
 */
export function parseMindMap(markdown: string): ParseMindMapResult {
  const lines = markdown.split("\n");
  let root: MindMapNode | null = null;
  let rootLine = -1;

  // 1. 找到一级标题作为根节点
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    const headingMatch = trimmed.match(/^#\s+(.+)$/);
    if (headingMatch) {
      if (root !== null) {
        return { ok: false, message: "存在多个一级标题，只能有一个根节点", line: i + 1 };
      }
      const [topic, meta] = extractMetadata(headingMatch[1]);
      const node: MindMapNode = { id: generateNodeId(), topic, children: [] };
      if (meta) applyMetadata(node, meta);
      root = node;
      rootLine = i;
    } else {
      // 一级标题之前不允许非空内容（frontmatter 除外，但 frontmatter 由上层剥离）
      if (root === null) {
        return { ok: false, message: "第一个非空行必须是 # 一级标题（根节点）", line: i + 1 };
      }
    }
  }

  if (root === null) {
    return { ok: false, message: "缺少 # 一级标题（根节点）", line: 1 };
  }

  // 2. 解析列表项
  const stack: { node: MindMapNode; indent: number }[] = [{ node: root, indent: -1 }];
  let prevIndent = -1;

  for (let i = rootLine + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "") continue;

    const listMatch = raw.match(LIST_ITEM_RE);
    if (!listMatch) {
      return { ok: false, message: "根节点之后只允许无序列表项（-/*/+ 开头）", line: i + 1 };
    }

    const indent = listMatch[1].length;
    const [topic, meta] = extractMetadata(listMatch[2]);

    // 缩进校验：必须为 2 的倍数
    if (indent % 2 !== 0) {
      return { ok: false, message: `缩进必须为 2 的倍数，当前 ${indent} 个空格`, line: i + 1 };
    }

    // 跳级检查：新节点的 level 不能比前一个节点的 level 大 1 以上
    if (prevIndent >= 0 && indent > prevIndent + 2) {
      const expectedLevel = (prevIndent + 2) / 2;
      return {
        ok: false,
        message: `缩进跳级：从 ${prevIndent} 空格跳到 ${indent} 空格，应为 ${prevIndent + 2} 空格（level ${expectedLevel}）`,
        line: i + 1,
      };
    }

    // 找到父节点：弹出栈直到栈顶 indent < 当前 indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    const newNode: MindMapNode = { id: generateNodeId(), topic, children: [] };
    if (meta) applyMetadata(newNode, meta);
    parent.children.push(newNode);
    stack.push({ node: newNode, indent });

    prevIndent = indent;
  }

  const plainText = buildPlainText(root);
  return { ok: true, root, plainText };
}

/**
 * 收集节点上的 v2 元数据，用于序列化时写回注释。
 * 只在节点含有扩展字段（id 除外，但稳定 ID 必须写）时返回对象。
 * 返回 null 表示该节点无需写注释（保持旧格式行）。
 */
function collectMetadata(node: MindMapNode): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  // 稳定 ID 始终写回（确保重启后 ID 不变）
  meta.id = node.id;
  if (node.note !== undefined) meta.note = node.note;
  if (node.icons !== undefined) meta.icons = node.icons;
  if (node.hyperLink !== undefined) meta.hyperLink = node.hyperLink;
  if (node.image !== undefined) meta.image = node.image;
  if (node.style !== undefined) meta.style = node.style;
  if (node.metadata !== undefined) {
    for (const [k, v] of Object.entries(node.metadata)) {
      // 不覆盖已知字段
      if (!KNOWN_METADATA_KEYS.has(k)) meta[k] = v;
    }
  }
  // 只有 id 一个字段时，为了保持稳定 ID，仍然写注释
  return meta;
}

/** 把元数据对象格式化为 v2 注释字符串 */
function formatMetadataComment(meta: Record<string, unknown>): string {
  return ` <!-- ${METADATA_NS} ${JSON.stringify(meta)} -->`;
}

/** 将思维导图树序列化为 Markdown 大纲 */
export function serializeMindMap(node: MindMapNode): string {
  const lines: string[] = [];
  serializeNode(node, true, 0, lines);
  return lines.join("\n");
}

function serializeNode(node: MindMapNode, isRoot: boolean, level: number, lines: string[]): void {
  const meta = collectMetadata(node);
  const suffix = meta ? formatMetadataComment(meta) : "";
  if (isRoot) {
    lines.push(`# ${node.topic}${suffix}`);
  } else {
    // level=1 为顶层列表项（0 缩进），level=2 为 2 空格缩进，依此类推
    const indent = "  ".repeat(level - 1);
    lines.push(`${indent}- ${node.topic}${suffix}`);
  }
  for (const child of node.children) {
    serializeNode(child, false, level + 1, lines);
  }
}

/**
 * 生成 plainText：用于前端 preview 显示。
 *
 * 注意：plainText 字段不参与后端 backlink/mention 扫描——后端直接扫描
 * .md 文件 body 原文，并在 `find_plain_mentions` 中跳过结构化文档
 * （见 notes_links.rs 的 `is_structured_note`）。这里生成的内容仅用于
 * preview 等前端展示场景，需要包含节点 topic 原文以保证可读性。
 */
function buildPlainText(root: MindMapNode): string {
  const parts: string[] = [];
  const walk = (node: MindMapNode) => {
    if (node.topic) parts.push(node.topic);
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return parts.join("\n");
}

/**
 * 从 AI 回答中提取 fenced block 内容。
 * 支持 ```mindmap 和 ```mindmap-patch 两种。
 * 返回最后一个合法块的内容。
 */
export function extractFencedBlock(text: string, lang: string): string | null {
  const re = new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```", "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1].trim();
  }
  return last;
}

/**
 * 清洗 AI 返回的 Markdown：剥离一层 ```markdown 代码围栏。
 */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (m) return m[1].trim();
  return trimmed;
}

/**
 * 根据节点路径在树中查找节点。
 * 路径 [1, 0] 表示 root.children[1].children[0]。
 * 根节点路径为 []。
 */
export function findNodeByPath<T extends { id: string; children?: T[] }>(
  root: T,
  path: number[],
): T | null {
  if (path.length === 0) return root;
  let current: T = root;
  for (const idx of path) {
    const children = current.children ?? [];
    if (idx < 0 || idx >= children.length) return null;
    current = children[idx];
  }
  return current;
}

/**
 * 计算节点的索引路径（从根到该节点）。
 * 如果节点不存在于树中，返回 null。
 */
export function findPathToNode<T extends { id: string; children?: T[] }>(
  root: T,
  targetId: string,
): number[] | null {
  if (root.id === targetId) return [];
  const children = root.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const sub = findPathToNode(children[i], targetId);
    if (sub !== null) return [i, ...sub];
  }
  return null;
}

/**
 * 根据 ID 在树中查找节点。
 * 找不到返回 null。
 */
export function findNodeById<T extends { id: string; children?: T[] }>(
  root: T,
  id: string,
): T | null {
  if (root.id === id) return root;
  const children = root.children ?? [];
  for (const child of children) {
    const found = findNodeById(child, id);
    if (found !== null) return found;
  }
  return null;
}

/** 计算 contentMarkdown 的简单哈希（用于 baseHash 校验） */
export function computeBaseHash(markdown: string): string {
  let hash = 0;
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}

/**
 * 深拷贝 MindMapNode，保留所有扩展字段（note/icons/hyperLink/image/style/metadata）。
 * 用于 patch 应用前的树拷贝、大纲视图切换等场景。
 */
export function cloneMindMapNode(node: MindMapNode): MindMapNode {
  const clone: MindMapNode = {
    id: node.id,
    topic: node.topic,
    children: node.children.map(cloneMindMapNode),
  };
  if (node.note !== undefined) clone.note = node.note;
  if (node.icons !== undefined) clone.icons = [...node.icons];
  if (node.hyperLink !== undefined) clone.hyperLink = node.hyperLink;
  if (node.image !== undefined) {
    clone.image = { ...node.image };
  }
  if (node.style !== undefined) {
    clone.style = { ...node.style };
  }
  if (node.metadata !== undefined) {
    clone.metadata = { ...node.metadata };
  }
  return clone;
}
