# Mona 流程图与架构图协议

本参考记录当前 Mona 流程图 AI 入口已经实现并由校验器接受的完整视觉载荷。需要写入流程图
patch 时读取相关段落，不要把文档内存模型中没有 patch 写入路径的字段当作接口。

## 工具与 Patch 顶层

先调用轻量的 `canvas.open` 获取当前图和两个哈希，再把下面的对象作为 `canvas.apply.patch`。`canvas.apply` 只负责提交真实可编辑 patch 并返回阶段回执，不等待截图；视觉验收显式使用 `canvas.inspect(include_visual=true)`。旧笔记助手仍可能要求 `mona-flowchart-patch` fenced block；主会话工具路径不要在最终回复重复输出 fenced block。

```json
{
  "baseHash": "当前语义哈希",
  "baseDocumentHash": "当前完整文档哈希",
  "ops": []
}
```

`baseHash` 保护节点/边语义，`baseDocumentHash` 保护完整可见文档状态（不含 viewport），
包括位置、尺寸、样式、图标、主题、分组和边路由。两个哈希可以直接放在 patch 内，也可以分别
作为工具顶层的 `base_hash`、`base_document_hash` 传入；工具会统一归一化，若同时提供必须一致。
当前 canvas 工具要求两个哈希都来自最近一次 `canvas.open`；不要猜测或复用旧哈希。

`patch` 必须是对象，不能把 JSON 字符串作为 `patch` 传入。`ops` 按声明顺序原子执行，最多 50 个
操作，patch 序列化后不超过 64 KiB。`replaceGraph` 必须是唯一 op；它适合新图或大幅重组。局部
修改使用其它操作。

## 全量视觉蓝图

`replaceGraph.graph` 的字段为：

```text
direction: "TB" | "LR"
layout?: "auto" | "manual"
theme?: { stylePreset: "solid" | "outline" | "soft", paletteId, preserveManualStyles: boolean }
background?: color
nodes: FlowchartPatchNode[]
edges: FlowchartEdge[]
groups?: FlowchartPatchGroup[]
pools?: FlowchartPatchPool[]
```

`layout` 省略或为 `auto` 时，本地使用 Dagre、自动尺寸、连接点分配和正交避障；为 `manual`
时每个节点都必须提供 `position: {x, y}`。通常选择 auto，只有需要精确复刻版式、固定系统
分区或人工对齐时才选择 manual。`position` 是节点外接矩形的左上角坐标，所有形状都遵循这条
规则；圆、椭圆和旋转图形也不能把 position 当作中心点。右边界为 `x + width`，下边界为
`y + height`。

节点的有效字段是 `id`、`kind`、`label`，以及可选的 `position`、`size`、`style`、`icon`、
`zIndex`（-100–100）、`rotation`（-360–360）、`opacity`（0–1）和 `decorative`。`decorative: true`
表示该节点是纯视觉图元，不进入流程语义、自动布局和普通节点重叠检查，也不能作为边端点；页面越界仍会报错。
自动布局会根据 label、字号和图标计算推荐尺寸；普通语义节点显式 size 的宽度范围是 48–1200，
高度范围是 28–800。`decorative: true` 的纯视觉图元宽高下限为 2px，可用于眼睛高光、胡须等
细节，并保持显式尺寸。manual 的坐标必须是有限数值且绝对值不超过 100000。

边的有效字段是 `id`、`source`、`target`、`label`，以及可选的 `style`、`sourceHandle`、
`targetHandle`、`sourcePort`、`targetPort`、`controlPoints`。source/target 必须存在，不能是自环，也不能指向容器。

group 的字段是 `id`、`label`、`memberIds`、可选的 `style`。每个 group 至少有 2 个成员，
成员必须存在且不能同时属于多个 group；应用后成员用文档已有的 `parentId` 持久保存归属，位置转为
分区相对坐标。移动分区时成员整体跟随，保存重开后仍能恢复关系。group 不能作为边端点。

完整泳道图使用 `pools`。每个 pool 包含 `id`、`label`、可选 `orientation` 和 2–12 条
`{id,label}` 泳道；节点通过 `laneId` 引用其中一条。泳道图只使用 auto 布局，由本地排版、
扩展泳池并处理跨泳道连线。

theme 的 `stylePreset` 为 `solid`、`outline` 或 `soft`；`paletteId` 为 `default`、
`deep-blue`、`blue-gray`、`green`、`orange`、`red`、`purple`、`monochrome`；
`preserveManualStyles` 决定切换主题时是否保留节点级手动样式。`background` 和样式颜色优先
使用 `#RRGGBB`，校验器也接受其它十六进制长度和 `transparent`。

## 节点与图标

AI allowlist 是 `FLOWCHART_NODE_KINDS` 中排除 `group`、`swimlane-pool`、`swimlane-lane`、
`image`、`freehand` 后的全部 kind，包含：

```text
start, end, terminator,
process, alternate-process, predefined-process, subprocess, manual-operation,
decision,
input-output, manual-input, display, document, multi-document,
database, internal-storage, stored-data,
preparation, delay, card, merge, extract, sort, or, summation,
connector, off-page-connector, annotation,
rectangle, rounded-rectangle, ellipse, circle, triangle, right-triangle,
diamond-basic, pentagon-basic, hexagon-basic, octagon, star, cloud, callout,
plus, l-shape, arrow-left, arrow-right, arrow-up, arrow-down, arrow-bidirectional,
bracket-round, bracket-square, brace, code-block, note, text
```

图片和手绘节点不在 AI allowlist 内；不要发明图片生成工具、外部资源路径或图片字段。

图标必须来自 `FLOWCHART_ICON_NAMES`：

```text
user, users, browser, mobile, server, database, file, folder, cloud, network,
message, mail, search, lock, check, warning, settings, code, cpu, ai
```

节点样式字段为 `fontFamily`、`fontSize`（10–48）、`color`、`fill`、`borderColor`、
`borderWidth`（0–12）、`borderStyle`（solid/dashed/dotted）、`bold`、`italic`、`underline`、
`textAlign`、`verticalAlign`、`lineHeight`（1–2.2）和 `cornerRadius`（0–80）。边样式字段为
`stroke`、`strokeWidth`（0.5–12）、`strokeDasharray`、`route`（bezier/smoothstep/straight）、
`markerStart` 和 `markerEnd`（none/arrow/arrowclosed），以及 `labelColor`、`labelBackground`、
`labelFontSize`（8–32）、`labelBold`、`labelOffsetX`、`labelOffsetY`（-400–400）。

handle 可以写 `top`、`right`、`bottom`、`left`，也可以写带方向后缀的
`top-source`、`right-target` 等。`bottom-right` 等复合方向会按第一个方向归一化到底层四向端口。
`sourcePort` / `targetPort` 表示在所选边上的位置比例，范围 0.05–0.95，默认 0.5；上/下边从左向右，
左/右边从上向下。例如两条不同关系分别使用 `sourceHandle: "right", sourcePort: 0.3` 和
`sourceHandle: "right", sourcePort: 0.7`，目标侧也相应错开。它们是文档几何字段，保存、读取和编辑均保留。
多条关系需要独立可辨的路径；反向关系不能重叠在同一条线上。语义确实相同的双向关系才可用一条双向箭头。
controlPoints 最多 8 个有限坐标；smoothstep 使用按顺序
连接的拐点，bezier 使用两个控制点。不要把控制点放入节点包围盒。

同心/放射构图不服从单一 TB/LR 主轴：径向关系应显式写 `route: "straight"`，并从源节点朝
目标的侧面选择 sourceHandle/targetHandle；需要绕行时显式给出侧面、端口比例和控制点。

## 操作

局部操作的字段和用途如下：

```text
addNode        { name, node: { id, kind, label, position?, size?, style?, icon?, zIndex?, rotation?, opacity?, decorative? } }
updateNode     { name, id, expectedLabel, patch: { kind?, label?, position?, size?, style?, icon?, zIndex?, rotation?, opacity?, decorative? } }
removeSubgraph { name, nodes: [{ id, expectedLabel }], edges: [{ id, expected: { source, target, label? } }] }
addEdge        { name, edge: { id, source, target, label?, style?, sourceHandle?, targetHandle?, sourcePort?, targetPort?, controlPoints? } }
updateEdge     { name, id, expected: { source, target, label? }, patch: { source?, target?, label?, style?, sourceHandle?, targetHandle?, sourcePort?, targetPort?, controlPoints? } }
removeEdge     { name, id, expected: { source, target, label? } }
addGroup       { name, group: { id, label, memberIds, style? } }
updateGroup    { name, id, expectedLabel, patch: { label?, position?, memberIds?, style? } }
removeGroup    { name, id, expectedLabel }
addPool        { name, pool: { id, label, orientation?, lanes: [{ id, label }, { id, label }] } }
addLane        { name, poolId, lane: { id, label? } }
moveNodeToLane { name, id, expectedLabel, laneId: string | null }
setTheme       { name, theme: FlowchartThemeSettings, background? }
reflow         { name, direction?: "TB" | "LR" }
```

`addNode` 提供 `position` 时会保留显式坐标，省略时才由本地自动放置；因此复杂图可以先规划全图，
再按完整模块分批加入而不移动已有内容。需要一次性显式定位整图时使用 `replaceGraph` 的 manual 布局。
`updateNode` 会合并 style，`icon: null` 会清除图标；修改
label、icon 或 fontSize 且未显式提供 size 时，本地会重新计算推荐尺寸。`addEdge` 和
`updateEdge` 会保留显式的样式、handles 和控制点。

`addGroup` 创建可移动分区；`updateGroup` 可局部修改标题、位置、成员和样式；`removeGroup`
只解散分区并保留成员。`setTheme` 更新全局主题和可选背景；当 `preserveManualStyles` 为 false 时会清理主题提供的
节点颜色覆盖。`reflow` 可改变方向，并对根节点、group/pool/lane 内节点执行容器感知布局，
随后重新分配连接点和正交路由。

`removeSubgraph` 是显式删除：节点列表中的每个节点必须存在且匹配 expectedLabel；边列表
必须精确包含这些节点的全部关联边，并逐条匹配 source、target 和（若提供）label。不要依赖
隐式级联，也不要把无关边夹带进来。

## 泳道与架构边界

- `addPool` 必须一次创建恰好两条泳道；`orientation` 可选，默认 `horizontal`。
- `addLane` 只能向已有或同一 patch 之前创建的泳池追加泳道，泳池由本地操作扩容和重排。
- 新节点要进入泳道时，先 `addNode`，再用 `moveNodeToLane` 指向目标 lane；同一 patch 中可以
  先 `addPool` 再移动节点。
- `moveNodeToLane` 的 `laneId: null` 表示移回根级；已有节点移动时保持屏幕位置语义，新节点
  在放置阶段统一安排。
- 新建或全量重做泳道图使用 `replaceGraph.pools` 和节点 `laneId`；已有泳道的局部调整继续用
  `addPool`、`addLane`、`moveNodeToLane`，避免无关内容被重建。

## 布局、路由与质量回执

`replaceGraph` 的 auto 布局和 `reflow` 都使用本地 Dagre。它使用节点真实尺寸，按方向布局；
容器感知模式分别布局根级节点和每条泳道内容，并按内容扩展泳池。本地补齐缺失的连接侧；自动
正交边未指定端口比例时，同侧多条关系会错开。路由复用实际渲染线段，避让节点、已占用通道和标签，
不再把所有回边强制塞到全图外侧。显式连接侧、比例、控制点以及 straight/bezier 路线保留；
未提供控制点的 smoothstep 才由本地按需补齐绕行。显式路线有冲突时会报告边 ID，由局部修改解决。

应用回执 `summary.qualityIssues` 来自本地 `inspectFlowchartQuality`，包括：

```text
node-overlap      error       同层节点包围盒重叠
text-overflow     error       文字可能超出节点可用区域
edge-through-node error       连线穿过非端点节点
page-overflow     error       页面模式下节点超出页面范围
group-member-outside error    分区没有完整包住成员
group-title-overlap error     分区标题区压住成员
render-missing-node error     文档节点没有进入实际 DOM
render-missing-edge error     文档连线没有进入实际 SVG
duplicate-route   error       两条边使用完全相同的路径
edge-overlap      error       不同端点或反向连线存在显著共线重合
label-overlap     warning/error 标签位置估算冲突/实际 DOM 标签遮挡
overview-too-small warning    整图适应常用视口后比例过低
```

质量问题应在交付前处理；具体复核顺序和语义 warning 见 [visual-review.md](visual-review.md)。

来源：`webui/src/components/notes/flowchart/flowchart-patch.ts`、
`flowchart-document.ts`、`flowchart-quality.ts` 和 `webui/src/components/notes/notes-ai.ts`。
