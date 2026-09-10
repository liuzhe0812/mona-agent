# 画布视觉复核

本参考提炼 `next-ai-draw-io` 的视觉验收标准，并以 Mona 的本地质量检查和编辑器结果为准。
它不引入独立云端检查服务：`canvas.apply` 的阶段回执只说明 patch 提交状态，先看本地
`qualityIssues`，再通过 `canvas.inspect(include_visual=true)` 观察当前模型收到的真实画面。
`canvas.open` 负责轻量读取对象和版本；工具负责连接恢复，不要从回执外猜测挂载状态或反复连接。

## 结构与语义

先确认：

1. 所有边的 source 和 target 都存在，没有意外自环，也没有把 group、pool 或 lane 当成边端点。
2. 主流程方向一致，判断节点的出边有清楚条件，架构边标签能说明调用、依赖或数据方向。
3. group 成员属于正确系统边界，泳道归属与责任描述一致。
4. 局部修改保留了未涉及对象的 ID、标签、样式和关系；视觉 patch 使用了最新
   `baseDocumentHash`，它可以来自 patch 内字段或工具顶层哈希参数。

`collectFlowchartSemanticWarnings` 是非阻塞语义检查，可能报告 `no-start`、`no-end`、
`start-has-incoming`、`end-has-outgoing`、`decision-unlabeled-branch`、`isolated-node`、
`unreachable-node` 和 `has-cycle`。流程片段没有起止节点、架构图没有流程终点、或重试/审批
存在循环时，结合用户意图处理 warning；不要为了消除提示而添加虚假的节点或边。

## 本地质量检查

`summary.qualityIssues` 中的 error 在交付前应清零：

- `node-overlap`：同一父级的节点包围盒重叠；
- `text-overflow`：label、字号和图标超出节点可用区域；
- `edge-through-node`：边的任何路径段穿过非 source/target 节点；
- `page-overflow`：页面模式下节点超出画布范围。
- `group-member-outside` / `group-title-overlap`：分区没有包住成员或标题区压住成员；
- `render-missing-node` / `render-missing-edge`：文档对象没有出现在实际 DOM/SVG 中。
- `duplicate-terminal`：多个同名终点可能把同一结果拆成重复对象，应合并或改成有区分的结果状态。

`duplicate-route` / `edge-overlap` 表示两条关系重叠，包含不同端点的部分共线和反向共线。
使用不同侧面、`sourcePort` / `targetPort`（如 0.3 / 0.7）和分开的控制点通道局部修正，不靠改色掩盖。
`label-overlap` 的几何估算为 warning，实际 DOM 遮挡为 error；可调整对应边的 `labelOffsetX/Y` 或路径。
自动路由保留明确指定的连接侧和控制点；显式设计仍有问题时，根据报告局部修正，不重排无关节点。

`overview-too-small` 表示整图适应常用视口后比例过低。优先压缩标签和布局，内容确实过多再
拆分阶段；不能通过缩小字号消除提醒。

## 画面检查顺序

上游提示要求在布局阶段为障碍物预留约 20–30px 间隙，复杂绕行使用多个拐点组成清楚的
L/U 形路径，并在生成前检查边是否穿过无关形状、两条边是否共路、连接点是否在角点、是否
可以重排节点减少交叉。结合 Mona 画布检查：

- 节点和 group 是否在单一视口内，边距和空白是否足够；
- 主路径、分支、汇合和系统边界是否有清楚的视觉层次；
- 节点尺寸是否能容纳 label，文字是否截断、重叠或小到无法阅读；
- 主题、背景、节点级强调色和图标是否形成一致系统，是否存在无意义的彩虹配色；
- 连线是否从自然侧面连接，是否出现贴角、回折或穿过节点；
- 多条关系是否使用不同路径，箭头和虚实线是否与关系含义一致；
- 泳道标题、group 标题和关键节点是否能在缩放后快速识别。
- 整图适应视口后是否仍能直接阅读主要标签。

## 处理结果

- 通过：没有 quality error；warning 已确认是有意设计或已通过局部 patch 修正。
- 失败：指出具体节点/边/标签/group 和问题，优先修正方向、分组、尺寸、样式、handles 或
  控制点，再提交一个最小 patch。
- 版本冲突：重新读取当前图和两个哈希，按当前文档继续；不要重放旧 patch。

不要在同一个问题上重复 inspect 或重复提交相同 patch。修正后仍有问题时，只根据新的
qualityIssues 或画面差异继续；若同一修正没有改善就停止，避免把检查循环当成进展。若 apply
返回结果未确认，先读取当前文档和哈希，再决定是否继续，不能重放未确认的写入。

来源：本地参考仓库 `D:\liuzhe\Desktop\code\next-ai-draw-io\lib\validation-prompts.ts`、
`lib\diagram-validator.ts` 中的重叠、连线、文字、布局和渲染检查标准；Mona 的
`webui/src/components/notes/flowchart/flowchart-quality.ts`、`flowchart-patch.ts`。
