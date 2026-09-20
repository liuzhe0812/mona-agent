import type { NoteAiActionId, NoteTransformation, OperationNote } from "./notes-data";
import {
  computeFlowchartDocumentHash,
  extractSemanticGraph,
  parseFlowchartMarkdown,
} from "./flowchart/flowchart-document";

export const NOTE_AI_ACTIONS: Array<{
  id: Exclude<NoteAiActionId, "freeform">;
  label: string;
  description: string;
}> = [
  {
    id: "summary",
    label: "总结当前笔记",
    description: "提炼重点、结论和下一步",
  },
  {
    id: "translate",
    label: "翻译",
    description: "中文译英文，其他语言译中文",
  },
  {
    id: "generateHtml",
    label: "生成HTML文档",
    description: "生成精美排版的HTML文档",
  },
];

/** 选中节点上下文，由 MindMapDocumentEditor 上抛 */
export interface MindMapSelectionContext {
  /** 节点路径（索引数组），根节点为 [] */
  path: number[];
  /** 文本路径，例如 ["Mona 产品规划", "AI 文档", "思维导图"] */
  pathLabels: string[];
  /** 选中节点为根的子树 Markdown */
  subtreeMarkdown: string;
}

/**
 * 大纲格式规范，所有思维导图 Prompt 共用。
 * 保持与 mindmap-outline.ts 的解析规则完全一致。
 */
const OUTLINE_SPEC = `大纲格式规范（必须严格遵守）：
- 第一行是 # 一级标题作为根节点；
- 根节点后使用无序列表（-/*/+ 开头）表示子节点；
- 每层使用 2 个空格缩进；
- 节点内容为单行纯文本，不要使用 Markdown 内联格式；
- 不允许跳级缩进；
- 不允许代码块、表格、引用或普通段落；
- 同级节点允许重名；
- [[wiki link]] 作为普通节点文本保留。`;

/** 流程图选中上下文（与 FlowchartSelectionContextValue 一致） */
export interface FlowchartSelectionContext {
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * 流程图 patch 输出契约（见设计文档 §9.6, §9.7）。
 * 全量生成也走 replaceGraph op，不再有第二套 fenced block。
 */
const FLOWCHART_PATCH_CONTRACT = (baseHash: string, baseDocumentHash: string) => `输出格式：
1. 先用 1-2 段简短文字说明你的修改思路；
2. 然后输出 patch JSON，放在 \`\`\`mona-flowchart-patch fenced block 中；
3. JSON 必须符合以下 schema：
   {
     "baseHash": "${baseHash}",
     "baseDocumentHash": "${baseDocumentHash}",
     "ops": [
       { "name": "replaceGraph", "graph": { "direction": "TB|LR", "layout": "auto|manual", "theme": {"stylePreset":"solid|soft|outline","paletteId":"deep-blue|blue-gray|green|orange|red|purple|monochrome|default","preserveManualStyles":true}, "background":"#RRGGBB", "nodes": [{"id":"n1","kind":"形状","label":"...","icon":"可选图标","laneId":"可选泳道ID","size":{"width":160,"height":64},"style":{"fill":"#RRGGBB","borderColor":"#RRGGBB","color":"#RRGGBB","bold":true},"position":{"x":0,"y":0}}], "edges": [{"id":"e1","source":"n1","target":"n2","label":"可选","style":{"route":"smoothstep","markerEnd":"arrowclosed"}}], "groups":[{"id":"g1","label":"分区标题","memberIds":["n1","n2"],"style":{"fill":"#F8FAFC","borderColor":"#CBD5E1"}}], "pools":[{"id":"p1","label":"协作流程","orientation":"horizontal","lanes":[{"id":"lane-user","label":"用户"},{"id":"lane-system","label":"系统"}]}] } },
       { "name": "addNode", "node": { "id": "n-x", "kind": "process", "label": "...", "icon":"server", "style":{"fill":"#DBEAFE"} } },
       { "name": "updateNode", "id": "n1", "expectedLabel": "原文本", "patch": { "kind": "process", "label": "新文本", "position":{"x":120,"y":80}, "icon":"check", "style":{"fill":"#DCFCE7"} } },
       { "name": "removeSubgraph", "nodes": [{"id":"n1","expectedLabel":"原文本"}], "edges": [{"id":"e1","expected":{"source":"n1","target":"n2","label":"可选"}}] },
       { "name": "addEdge", "edge": { "id": "e-x", "source": "n1", "target": "n2", "label": "可选", "style":{"route":"smoothstep","markerEnd":"arrowclosed"} } },
       { "name": "updateEdge", "id": "e1", "expected": {"source":"n1","target":"n2","label":"可选"}, "patch": { "label": "新标签", "style":{"stroke":"#2563EB","strokeWidth":2,"labelColor":"#2563EB","labelFontSize":12,"labelBold":true,"labelOffsetX":0,"labelOffsetY":-8} } },
       { "name": "removeEdge", "id": "e1", "expected": {"source":"n1","target":"n2","label":"可选"} },
       { "name": "addGroup", "group": { "id":"g1", "label":"分区标题", "memberIds":["n1","n2"], "style":{"fill":"#F8FAFC","borderColor":"#CBD5E1"} } },
       { "name": "updateGroup", "id":"g1", "expectedLabel":"分区标题", "patch": { "label":"新标题", "position":{"x":80,"y":100}, "memberIds":["n1","n2"] } },
       { "name": "removeGroup", "id":"g1", "expectedLabel":"分区标题" },
       { "name": "addPool", "pool": { "id": "pool-1", "label": "泳池标题", "orientation": "horizontal", "lanes": [{"id":"lane-1","label":"泳道 1"},{"id":"lane-2","label":"泳道 2"}] } },
       { "name": "addLane", "poolId": "pool-1", "lane": { "id": "lane-3", "label": "可选标题" } },
       { "name": "moveNodeToLane", "id": "n1", "expectedLabel": "原文本", "laneId": "lane-1" },
       { "name": "setTheme", "theme": {"stylePreset":"soft","paletteId":"deep-blue","preserveManualStyles":true}, "background":"#FFFFFF" },
       { "name": "reflow", "direction": "TB|LR" }
     ]
   }

字段说明：
- baseHash: 必须等于下方提供的 baseHash 值；
- baseDocumentHash: 必须等于下方提供的完整文档哈希；用户改动位置或样式后旧 patch 也会被拒绝；
- ops: 操作数组，按顺序原子应用；任一 op 失败则整个 patch 不应用；
- replaceGraph 必须是唯一 op，不能与其他 op 混用；新建或全量重做泳道图可使用 replaceGraph.pools，已有泳道的局部修改使用局部 ops；
- addNode 的 id 必须在当前图和同一 patch 中唯一；新增节点默认由本地布局，不输出 position；
- updateNode/removeSubgraph/updateEdge/removeEdge/updateGroup/removeGroup/moveNodeToLane 必须提供 expected，与当前图不匹配则整个 patch 拒绝；
- removeSubgraph 必须显式列出待删节点和这些节点在执行到该 op 时的全部关联边，不允许漏列、夹带或隐式级联；
- 完整创建优先用 layout=auto，让本地计算位置和避障；只有明确需要特殊分区时用 manual，且每个节点必须提供 position；
- 可以使用 size/style/icon/theme/groups 表达层次；同图只用一个主色，状态色最多两种，强调节点应是少数；
- 节点 kind 仅允许以下流程语义形状：
  起止：start（开始）/ end（结束）/ terminator（起止胶囊）；
  流程：process（流程）/ alternate-process（替代流程）/ predefined-process（预定义流程）/ subprocess（子流程）/ manual-operation（手动操作）；
  判断：decision；
  数据与输入输出：input-output（输入输出）/ manual-input（手动输入）/ display（显示）/ document（文档）/ multi-document（多文档）/ database（数据库）/ internal-storage（内部存储）/ stored-data（存储数据）；
  其他流程符号：preparation（准备）/ delay（延迟）/ card（卡片）/ merge（合并）/ extract（提取）/ sort（排序）/ or（或）/ summation（求和）/ connector（连接点）/ off-page-connector（跨页连接）/ annotation（注释）；
- 基础形状可使用 rectangle/rounded-rectangle/ellipse/circle/triangle/right-triangle/diamond-basic/pentagon-basic/hexagon-basic/octagon/star/cloud/callout/plus/l-shape/arrow-left/arrow-right/arrow-up/arrow-down/arrow-bidirectional/bracket-round/bracket-square/brace/code-block/note/text；不要创建 image/freehand 或直接创建容器节点。架构分区使用 groups 或 addGroup/updateGroup/removeGroup；新建完整泳道图使用 replaceGraph.pools 和节点 laneId，局部泳道修改使用 addPool/addLane/moveNodeToLane；
- 通用 icon 只允许 user/users/browser/mobile/server/database/file/folder/cloud/network/message/mail/search/lock/check/warning/settings/code/cpu/ai；
- 颜色只用十六进制；普通正文不小于 12px，保证对比度；
- 自环边（source === target）不允许；
- 单个 patch 的 ops 数量上限 50。

高质量构图规则：
- 生成前先确定主阅读方向、主路径、分支、反馈回路和分区；节点文字简洁，不把段落塞进形状；
- 流程图优先 auto 布局与 smoothstep 正交线；反馈边走图形外侧，不穿越无关节点；
- 判断节点的每条出边必须有清楚的条件标签；相同层级保持相近尺寸和对齐；
- 架构图使用 groups 表达系统边界，用 icon 辅助识别，用实线/虚线区分调用语义；
- 只为关键节点设置节点级颜色，其余使用统一 theme；避免彩虹配色和无意义装饰；
- 局部修改只改目标 ID，不重建整图，不删除用户未要求删除的元素。

泳道（泳池）规则：
- 语义 JSON 中 lanes 是既有泳道列表（id + label），节点的 laneId 表示所属泳道；
- 创建泳池用 addPool：恰好 2 条泳道，orientation 可省略（默认 horizontal）；坐标和尺寸由本地生成，不要输出；
- 追加泳道用 addLane：poolId 必须是既有或本 patch 创建的泳池；
- 调整节点归属用 moveNodeToLane：laneId 为目标泳道 id，传 null 表示移出泳道回到画布；
- addNode 的 node 不要带 laneId；要把新节点放进泳道时，先 addNode 再 moveNodeToLane；
- 同一 patch 中可以先 addPool 再 moveNodeToLane 引用新泳道；
- replaceGraph.pools 每个泳池包含 2-12 条泳道，节点 laneId 必须引用其中一条；泳道图使用 auto 布局。`;

/**
 * 大图上下文裁剪（设计文档 §9.5）。
 *
 * 默认发送完整语义图。节点数超过阈值时按以下顺序保留：
 * 1. 所有选中节点和边；
 * 2. 选中节点的直接前驱和后继；
 * 3. 从开始到选区、从选区到结束的路径；
 * 4. 其余节点只发送 ID、kind 和 label；
 * 5. 明确告诉模型上下文被裁剪，不允许它删除未提供的节点。
 */
const FLOWCHART_CONTEXT_NODE_THRESHOLD = 25;

export function buildFlowchartAiContext(
  contentMarkdown: string,
  selection: FlowchartSelectionContext | null,
): { json: string; trimmed: boolean } {
  const parsed = parseFlowchartMarkdown(contentMarkdown);
  if (!parsed.ok) {
    // 解析失败时回退为原始 markdown，让 AI 自行理解
    return { json: contentMarkdown, trimmed: false };
  }
  const doc = parsed.document;
  const fullGraph = extractSemanticGraph(doc);

  if (doc.nodes.length <= FLOWCHART_CONTEXT_NODE_THRESHOLD) {
    return {
      json: JSON.stringify({
        direction: doc.direction,
        canvas: doc.canvas,
        theme: doc.theme,
        nodes: doc.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          label: node.label,
          position: node.position,
          size: node.size,
          style: node.style,
          icon: node.icon,
          parentId: node.parentId,
          container: node.container,
        })),
        edges: doc.edges,
      }, null, 2),
      trimmed: false,
    };
  }

  // 大图裁剪
  const selectedNodeIds = new Set(selection?.nodeIds ?? []);
  const selectedEdgeIds = new Set(selection?.edgeIds ?? []);

  // 1. 选中的节点和边全量保留
  const keepFull = new Set<string>(selectedNodeIds);
  const keepEdges = new Set<string>(selectedEdgeIds);

  // 2. 选中节点的直接前驱和后继
  for (const edge of fullGraph.edges) {
    if (selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target)) {
      keepFull.add(edge.source);
      keepFull.add(edge.target);
      keepEdges.add(edge.id);
    }
  }

  // 3. 从 start 到选区的路径、从选区到 end 的路径
  const startNodes = fullGraph.nodes.filter((n) => n.kind === "start").map((n) => n.id);
  const endNodes = fullGraph.nodes.filter((n) => n.kind === "end").map((n) => n.id);

  // BFS 从 start 到选中节点
  const adj = new Map<string, string[]>();
  const reverseAdj = new Map<string, string[]>();
  for (const e of fullGraph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!reverseAdj.has(e.target)) reverseAdj.set(e.target, []);
    adj.get(e.source)!.push(e.target);
    reverseAdj.get(e.target)!.push(e.source);
  }

  // 从 start 出发能到达的所有节点
  const reachableFromStart = new Set<string>(startNodes);
  const queue = [...startNodes];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!reachableFromStart.has(next)) {
        reachableFromStart.add(next);
        queue.push(next);
      }
    }
  }

  // 能到达 end 的所有节点
  const canReachEnd = new Set<string>(endNodes);
  queue.push(...endNodes);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const prev of reverseAdj.get(cur) ?? []) {
      if (!canReachEnd.has(prev)) {
        canReachEnd.add(prev);
        queue.push(prev);
      }
    }
  }

  // 保留从 start 可达且能到 end 的路径节点（完整路径）
  for (const n of fullGraph.nodes) {
    if (reachableFromStart.has(n.id) && canReachEnd.has(n.id)) {
      keepFull.add(n.id);
    }
  }

  // 保留 keepFull 节点之间的边
  for (const e of fullGraph.edges) {
    if (keepFull.has(e.source) && keepFull.has(e.target)) {
      keepEdges.add(e.id);
    }
  }

  // 4. 选区与相关路径保留视觉字段，其余节点只保留定位信息。
  const documentNodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const nodes: Array<Record<string, unknown>> = [];
  for (const n of fullGraph.nodes) {
    if (keepFull.has(n.id)) {
      const visual = documentNodes.get(n.id);
      nodes.push({
        ...n,
        position: visual?.position,
        size: visual?.size,
        style: visual?.style,
        icon: visual?.icon,
        parentId: visual?.parentId,
      });
    } else {
      // 其余节点只发送 ID、kind、label 和泳道归属（laneId 是责任分配语义，不能丢）
      const trimmed: { id: string; kind: string; label: string; laneId?: string; trimmed: true } = {
        id: n.id,
        kind: n.kind,
        label: n.label,
        trimmed: true,
      };
      if (n.laneId !== undefined) trimmed.laneId = n.laneId;
      nodes.push(trimmed);
    }
  }

  const edges = doc.edges.filter((edge) => keepEdges.has(edge.id));
  const trimmedGraph = {
    direction: fullGraph.direction,
    canvas: doc.canvas,
    theme: doc.theme,
    nodes,
    edges,
    lanes: fullGraph.lanes,
  };

  return { json: JSON.stringify(trimmedGraph, null, 2), trimmed: true };
}

/** 流程图自由提问（保留流程图上下文） */
export function buildFlowchartFreeformPrompt(
  note: OperationNote,
  question: string,
  selection: FlowchartSelectionContext | null,
  baseHash: string,
): string {
  const title = note.title || "未命名流程图";
  const parsed = parseFlowchartMarkdown(note.contentMarkdown);
  const documentHash = parsed.ok ? computeFlowchartDocumentHash(parsed.document) : "";
  const context = buildFlowchartAiContext(note.contentMarkdown, selection);
  const selectionInfo = selection && selection.nodeIds.length > 0
    ? `\n当前选中节点：${selection.nodeIds.join(", ")}\n选中边：${selection.edgeIds.length > 0 ? selection.edgeIds.join(", ") : "无"}`
    : "\n当前未选中节点。";

  return `用户正在流程图编辑器中处理当前图。请围绕流程图内容回答用户问题。

用户问题：
${question}

当前流程图标题：${title}
当前图（包含可编辑视觉字段）：
${context.json}
${selectionInfo}

回答规则：
1. 如果用户的意图是修改流程图（生成/续写/补全/优化），按下面的契约输出结构化结果；
2. 如果只是提问或讨论，正常回答即可，不要输出 fenced block；
3. 所有修改统一用 \`\`\`mona-flowchart-patch fenced block，baseHash 必须为 "${baseHash}"，baseDocumentHash 必须为 "${documentHash}"；
4. 不要追问，不要询问更多信息。

${FLOWCHART_PATCH_CONTRACT(baseHash, documentHash)}`;
}

/**
 * 构造"从源笔记/材料生成流程图"的 prompt（设计文档 §7.10）。
 *
 * 输入是源笔记标题 + 正文摘要；目标流程图当前是空白图（只有 start 和 end 节点）。
 * AI 应基于源内容生成 replaceGraph op，覆盖空白图。
 *
 * 关键约束：
 * - 没有源内容时不允许凭标题编造业务细节；
 * - 必须输出 replaceGraph op（不能用 patch ops）；
 * - 生成结果保留来源 wiki link（在节点 label 或后续在文本投影中保留）。
 */
export function buildFlowchartFromSourcePrompt(
  targetNote: OperationNote,
  sourceTitle: string,
  sourceContent: string,
  baseHash: string,
): string {
  const ctx = buildFlowchartAiContext(targetNote.contentMarkdown, null);
  const graphJson = ctx.json;
  const parsed = parseFlowchartMarkdown(targetNote.contentMarkdown);
  const documentHash = parsed.ok ? computeFlowchartDocumentHash(parsed.document) : "";

  const trimmedSource = sourceContent.trim();
  const hasSource = trimmedSource.length > 0;
  const sourceSection = hasSource
    ? `源笔记标题：${sourceTitle}\n源笔记正文（截前 4000 字）：\n${trimmedSource.slice(0, 4000)}`
    : `源笔记标题：${sourceTitle}\n源笔记正文：（空）`;

  const sourceGuidance = hasSource
    ? `- 基于源笔记内容设计 4-10 个节点，覆盖该笔记描述的主要流程；\n- 节点 label 简洁（2-10 字），保留源文本中的关键术语；\n- 必须包含一个 start 节点和一个 end 节点；\n- 判断节点有多个出边时必须为每条边提供 label（如"是"/"否"）；`
    : `- 源笔记正文为空，不要凭标题编造业务细节；\n- 只输出最小骨架：一个 start 节点、一个 end 节点，以及一条 start → end 的边；\n- 在回答中提示用户补充源内容后再次生成。`;

  return `用户希望基于一篇源笔记生成一份流程图。原笔记不会被修改，本流程图作为独立笔记存在。

${sourceSection}

当前流程图（空白骨架，将被 replaceGraph 替换）：
${graphJson}

要求：
${sourceGuidance}
- 使用 replaceGraph op 全量输出；
- 来源：[[${sourceTitle}]]

${FLOWCHART_PATCH_CONTRACT(baseHash, documentHash)}`;
}

/** 自由提问（保留 mindmap 上下文） */
export function buildMindMapFreeformPrompt(
  note: OperationNote,
  question: string,
  selection: MindMapSelectionContext | null,
  baseHash: string,
): string {
  const title = note.title || "未命名思维导图";
  const selectionInfo = selection
    ? `\n当前选中节点：${selection.pathLabels.join(" > ")}\n选中子树：\n\`\`\`markdown\n${selection.subtreeMarkdown}\n\`\`\``
    : "\n当前未选中节点。";

  return `用户正在思维导图编辑器中处理当前导图。请围绕导图内容回答用户问题。

用户问题：
${question}

当前导图标题：${title}
当前完整大纲：
\`\`\`markdown
${note.contentMarkdown}
\`\`\`
${selectionInfo}

回答规则：
1. 如果用户的意图是修改导图结构（生成/扩展/精简/重组），按下面的契约输出结构化结果；
2. 如果只是提问或讨论，正常回答即可，不要输出 fenced block；
3. 全量替换用 \`\`\`mindmap fenced block；
4. 局部修改用 \`\`\`mindmap-patch fenced block，baseHash 必须为 "${baseHash}"；
5. 不要追问，不要询问更多信息。

${OUTLINE_SPEC}`;
}

export function buildAgentActionPrompt(
  actionId: Exclude<NoteAiActionId, "freeform">,
  note: OperationNote,
  filePath?: string,
): string {
  if (actionId === "summary") {
    if (filePath) {
      return [
        "请总结这篇笔记的内容。",
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后直接输出总结。`,
        "要求：只输出总结内容，不要追问，不要询问更多信息。",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return `请总结这篇笔记的内容。\n\n${context}\n\n要求：只输出总结内容，不要追问，不要询问更多信息。`;
  }

  if (actionId === "translate") {
    if (filePath) {
      return [
        "请翻译这篇笔记。",
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后输出翻译。`,
        "翻译规则：",
        "- 如果原文是中文，翻译为英文",
        "- 如果原文是其他语言，翻译为中文",
        "- 保持原文的格式和结构",
        "- 专业术语保留原文并在括号中附上翻译",
        "- 只输出译文，不要追问，不要解释",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return [
      "请翻译这篇笔记。",
      "",
      context,
      "",
      "翻译规则：",
      "- 如果原文是中文，翻译为英文",
      "- 如果原文是其他语言，翻译为中文",
      "- 保持原文的格式和结构",
      "- 专业术语保留原文并在括号中附上翻译",
      "- 只输出译文，不要追问，不要解释",
    ].join("\n");
  }

  if (actionId === "generateHtml") {
    if (filePath) {
      return [
        `请基于当前笔记内容，生成一份精美的HTML文档。使用 read_file 工具读取文件 ${filePath}，阅读后生成HTML文档。要求输出一个完整的、自包含的HTML文件（所有CSS写在<style>标签内），不要输出Markdown代码块包裹，不要解释。`,
        "",
        "文档风格规范（必须严格遵循）：",
        "【配色方案】",
        "- 主色：#1a3a5c（深蓝），辅助色：#2c5f8a（中蓝）",
        "- 强调色：#c9a84c（金色），浅强调色：#e8d59a",
        "- 背景：#ffffff，柔背景：#f8f7f4，区域背景：#faf9f6",
        "- 文字：#2c2c2c，次要文字：#5a5a5a，弱化文字：#8a8a8a",
        "- 边框：#e0ddd5，浅边框：#eeece6",
        "",
        "【封面页】",
        "- 全屏高度，深蓝渐变背景：linear-gradient(160deg, #0d1b2a 0%, #1b2d45 40%, #1a3a5c 70%, #2c5f8a 100%)",
        "- 居中白色文字，标题用笔记标题",
        "- 标题上方有金色边框徽章（letter-spacing: 4px）",
        "- 标题下方有副标题行和80px宽金色分割线",
        "- 底部有元信息行",
        "",
        "【左侧导航栏】",
        "- 240px宽，sticky定位，柔背景色，紧贴左侧无间距",
        '- 标题"目录"，各节链接',
        "- 链接无左边距和左边框，文字紧贴左侧，active状态用背景色和加粗区分",
        "",
        "【正文排版】",
        '- 节编号：金色，如"01"、"02"，letter-spacing: 3px',
        "- h2：Noto Serif SC，32px，深蓝色，letter-spacing: 2px",
        "- h3：Noto Serif SC，20px，深蓝色，左侧3px金色竖线",
        "- 段落：15px，行高1.8，次要文字色",
        "- 节之间用1px分割线隔开，间距80px",
        "",
        "【特色组件】",
        "- 高亮框：柔背景+浅边框+圆角8px",
        "- 特性卡片：2列网格，hover时金色边框+阴影",
        "- 流程步骤：横向排列，圆形编号，箭头连接",
        "- 对比行：左红右绿双栏对比",
        "- 表格：深蓝表头白字，偶数行柔背景",
        "",
        "【页脚】",
        "- 与封面同色深蓝渐变背景",
        "- 居中文字，内容为：Made by Mona",
        "",
        "【响应式】",
        "- 768px以下：封面标题缩小，单列布局，侧边栏隐藏",
        "",
        "【字体】",
        "- 引入 Google Fonts：Noto Serif SC 和 Noto Sans SC",
        "- 标题用 Noto Serif SC，正文用 Noto Sans SC",
        "",
        "根据笔记内容自动划分章节、生成目录、设计封面。",
        "生成完成后，使用 write_file 工具将 HTML 内容保存到当前工作区的 notes/ 子目录，文件名使用笔记标题（去除特殊字符）加 .html 后缀。",
        "不要在回复中输出 HTML 代码，只通过 write_file 工具保存文件即可。",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return [
      "请基于当前笔记内容，生成一份精美的HTML文档。要求输出一个完整的、自包含的HTML文件（所有CSS写在<style>标签内）。",
      "",
      "文档风格规范（必须严格遵循）：",
      "【配色方案】",
      "- 主色：#1a3a5c（深蓝），辅助色：#2c5f8a（中蓝）",
      "- 强调色：#c9a84c（金色），浅强调色：#e8d59a",
      "- 背景：#ffffff，柔背景：#f8f7f4，区域背景：#faf9f6",
      "- 文字：#2c2c2c，次要文字：#5a5a5a，弱化文字：#8a8a8a",
      "- 边框：#e0ddd5，浅边框：#eeece6",
      "",
      "【封面页】",
      "- 全屏高度，深蓝渐变背景：linear-gradient(160deg, #0d1b2a 0%, #1b2d45 40%, #1a3a5c 70%, #2c5f8a 100%)",
      "- 居中白色文字，标题用笔记标题",
      "- 标题上方有金色边框徽章（letter-spacing: 4px）",
      "- 标题下方有副标题行和80px宽金色分割线",
      "- 底部有元信息行",
      "",
      "【左侧导航栏】",
      "- 240px宽，sticky定位，柔背景色，紧贴左侧无间距",
      '- 标题"目录"，各节链接',
      "- 链接无左边距和左边框，文字紧贴左侧，active状态用背景色和加粗区分",
      "",
      "【正文排版】",
      '- 节编号：金色，如"01"、"02"，letter-spacing: 3px',
      "- h2：Noto Serif SC，32px，深蓝色，letter-spacing: 2px",
      "- h3：Noto Serif SC，20px，深蓝色，左侧3px金色竖线",
      "- 段落：15px，行高1.8，次要文字色",
      "- 节之间用1px分割线隔开，间距80px",
      "",
      "【特色组件】",
      "- 高亮框：柔背景+浅边框+圆角8px",
      "- 特性卡片：2列网格，hover时金色边框+阴影",
      "- 流程步骤：横向排列，圆形编号，箭头连接",
      "- 对比行：左红右绿双栏对比",
      "- 表格：深蓝表头白字，偶数行柔背景",
      "",
      "【页脚】",
      "- 与封面同色深蓝渐变背景",
      "- 居中文字，内容为：Made by Mona",
      "",
      "【响应式】",
      "- 768px以下：封面标题缩小，单列布局，侧边栏隐藏",
      "",
      "【字体】",
      "- 引入 Google Fonts：Noto Serif SC 和 Noto Sans SC",
      "- 标题用 Noto Serif SC，正文用 Noto Sans SC",
      "",
      context,
      "",
      "根据笔记内容自动划分章节、生成目录、设计封面。",
      "生成完成后，使用 write_file 工具将 HTML 内容保存到当前工作区的 notes/ 子目录，文件名使用笔记标题（去除特殊字符）加 .html 后缀。",
      "不要在回复中输出 HTML 代码，只通过 write_file 工具保存文件即可。",
    ].join("\n");
  }

  return "";
}

/**
 * 普通笔记的正文修改契约。
 *
 * 与思维导图 `mindmap-patch` / 流程图 `mona-flowchart-patch` 对齐：AI 输出结构化 block，
 * 前端由 `note-apply.ts` 解析 + baseHash 乐观锁校验后应用，避免把普通回答当成新正文覆盖笔记。
 */
export function buildNotePatchSpec(baseHash: string): string {
  return [
    "修改笔记的规则（重要）：",
    "1. 需要局部修改正文时，只输出一个 ```note-patch fenced block，内容为 JSON：",
    `{"baseHash":"${baseHash}","edits":[{"find":"当前正文中逐字存在且唯一的片段","replace":"替换后的内容"}]}`,
    "   - find 必须是当前正文的原文片段（含换行与缩进，建议带 2~5 行上下文以保证唯一），不要改写或省略；",
    '   - 删除内容时 replace 传空字符串 ""；',
    "   - 可包含多组 edits，按数组顺序依次应用，任一条定位失败则整次修改不生效；",
    "   - baseHash 必须原样使用上面给出的值。",
    "2. 需要整篇重写时，只输出一个 ```note-replace fenced block，内容为完整的新 Markdown 正文。",
    "3. 不需要改动笔记（只是回答问题、解读内容）时，直接用 Markdown 正常回答，不要输出上述 block。",
    "4. 输出 block 时不要在 block 前后重复正文，不要追问，不要解释修改过程。",
  ].join("\n");
}

export function buildFreeformAgentPrompt(
  note: OperationNote,
  question: string,
  baseHash?: string,
): string {
  const context = formatNoteContext(note, baseHash);
  const parts = [
    `用户正在笔记页面里处理当前笔记，请只围绕这篇笔记回答。`,
    "",
    `用户问题：`,
    question,
    "",
    context,
  ];
  if (baseHash) {
    parts.push("", buildNotePatchSpec(baseHash));
  }
  return parts.join("\n");
}

/**
 * Build a prompt for a user-defined transformation template.
 * Replaces variables {{note_title}}, {{note_content}}, {{note_source}}
 * with the note's actual values. If the template contains no variables, the note
 * context is appended automatically so the agent still has access to the note.
 */
export function buildTransformationPrompt(
  transformation: NoteTransformation,
  note: OperationNote,
): string {
  const content = note.contentMarkdown.slice(0, 12000);
  const truncated = note.contentMarkdown.length > content.length;
  const noteContent = truncated ? `${content}\n\n...内容过长，已截断` : content;

  let prompt = transformation.promptTemplate;
  let hasVariable = false;

  const replacements: Array<[RegExp, string]> = [
    [/\{\{\s*note_title\s*\}\}/g, note.title],
    [/\{\{\s*note_content\s*\}\}/g, noteContent],
    [/\{\{\s*note_source\s*\}\}/g, note.source.label],
  ];

  for (const [pattern, value] of replacements) {
    if (pattern.test(prompt)) {
      hasVariable = true;
      prompt = prompt.replace(pattern, value);
    }
  }

  // If the template has no variables, append the note context so the agent
  // still has access to the note content.
  if (!hasVariable) {
    prompt = `${prompt}\n\n${formatNoteContext(note)}`;
  }

  return prompt;
}

/** Pattern-to-label pairs for inferring displayContent from persisted user messages. */
const ACTION_PROMPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^请总结这篇笔记的内容/, label: "总结当前笔记" },
  { pattern: /^请翻译这篇笔记/, label: "翻译" },
  { pattern: /^请基于当前笔记内容，生成一份精美的HTML文档/, label: "生成HTML文档" },
];

/**
 * Infer a short display label from a persisted user message that was sent by a
 * note AI quick-action.  Returns `undefined` when the content doesn't match any
 * known action pattern (i.e. a freeform question).
 */
export function inferNoteActionDisplayLabel(content: string): string | undefined {
  if (!content) return undefined;

  // Check quick-action patterns first
  for (const { pattern, label } of ACTION_PROMPT_PATTERNS) {
    if (pattern.test(content)) return label;
  }

  // Flowchart action prompts
  if (/^用户希望基于当前标题生成一份完整的流程图/.test(content)) return "从主题生成流程图";
  if (/^用户希望从当前选中节点续写后续步骤/.test(content)) return "续写选中步骤";
  if (/^用户希望补全选中判断节点的分支/.test(content)) return "补全判断分支";
  if (/^用户希望优化当前流程图的结构/.test(content)) return "优化流程";
  if (/^用户希望审查当前流程图存在的问题/.test(content)) return "检查流程问题";

  // Extract user question from freeform prompt
  const freeformNoteMatch = content.match(/^用户正在笔记页面里处理当前笔记[\s\S]*?用户问题：\n(.+?)(?:\n\n当前笔记：|$)/);
  if (freeformNoteMatch) {
    const question = freeformNoteMatch[1].trim();
    if (question) return question;
  }
  const freeformFlowchartMatch = content.match(/^用户正在流程图编辑器中处理当前图[\s\S]*?用户问题：\n(.+?)(?:\n\n当前流程图标题：|$)/);
  if (freeformFlowchartMatch) {
    const question = freeformFlowchartMatch[1].trim();
    if (question) return question;
  }
  const freeformMindMapMatch = content.match(/^用户正在思维导图编辑器中处理当前导图[\s\S]*?用户问题：\n(.+?)(?:\n\n当前导图标题：|$)/);
  if (freeformMindMapMatch) {
    const question = freeformMindMapMatch[1].trim();
    if (question) return question;
  }

  return undefined;
}

export function buildAgentResultMarkdown(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? `${trimmed}\n` : `## Agent 处理结果\n\n${trimmed}\n`;
}

export function deriveNotePreview(markdown: string): string {
  const text = stripMarkdown(markdown).replace(/\s+/g, " ").trim();
  return text.slice(0, 46) || "空白笔记";
}

export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\(([^)]*)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~|]/g, " ");
}

function formatNoteContext(note: OperationNote, baseHash?: string): string {
  const content = note.contentMarkdown.slice(0, 12000);
  const truncated = note.contentMarkdown.length > content.length;
  const hashLine = baseHash ? `\n- 正文哈希：${baseHash}` : "";

  return `当前笔记：
- 标题：${note.title}
- 来源：${note.source.label}${hashLine}

Markdown 内容：
\`\`\`markdown
${content}${truncated ? "\n\n...内容过长，已截断" : ""}
\`\`\``;
}
