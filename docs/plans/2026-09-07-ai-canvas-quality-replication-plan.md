# Mona AI 流程图高质量生成能力复刻实施计划

> 日期：2026-09-07
> 状态：上一阶段实施记录，后续开发以[官方 Demo 实施计划](ai-canvas-official-demo-implementation.md)为准。
> 下列勾选和测试数字记录当时已做工作，不证明官方 Demo 质量达标。后续审计确认仍有产品代码与 AI 调用缺口。
> 设计依据：[高质量生成能力复刻方案](../design/2026-09-07-ai-canvas-quality-replication-design.md)

## 1. 计划边界

目标是在 Mona 现有 React Flow 画布中复刻 `next-ai-draw-io` 的高质量 AI 流程图能力。

已从旧计划删除：draw.io 内核、XML 新格式、静态资源分发、Services 画布会话、多人协作、跨设备同步、Office 集成、旧格式迁移、大规模付费模型基准。上述内容与当前目标无关或会造成过度设计。

本次只实施：AI 视觉 blueprint、现有形状和样式开放、通用图标、节点尺寸与布局优化、正交线避障、本地质量检查、配套 skill、相关回归与 dev 真实样例。

## 2. 执行阶段

### P0：计划收缩与基线

- [x] 审计本地 `next-ai-draw-io 0.4.16` 的提示词、ID 编辑、XML 校验和可选视觉检查。
- [x] 审计 Mona 现有图模型、patch、Dagre、形状、主题、泳道和主会话应用路径。
- [x] 删除超范围设计，确定继续使用 Mona 自研底座。

### P1：AI 协议与文档哈希

- [x] 新增完整文档哈希，AI patch 保护语义和视觉编辑。
- [x] 扩展 `replaceGraph`：主题、背景、节点尺寸/样式/图标/可选位置、边样式/端口/控制点、auto/manual 布局。
- [x] 新增 `setTheme`、`reflow`；扩展局部节点和边操作。
- [x] 严格校验未知字段、颜色、尺寸、图标、端口和控制点。
- [x] 更新变更摘要、prompt 和大图上下文，使 AI 能看到所需视觉状态。

主要文件：

- `webui/src/components/notes/flowchart/flowchart-document.ts`
- `webui/src/components/notes/flowchart/flowchart-patch.ts`
- `webui/src/components/notes/notes-ai.ts`
- `webui/src/components/notes/flowchart/flowchart-apply.ts`
- `webui/src/components/canvas/conversation-canvas.ts`

验收：视觉改动不会被并发覆盖；非法 blueprint 原子拒绝；局部修改不重建整图。

### P2：图标、尺寸、布局和路由

- [x] 新增有限通用图标目录并复用现有 Lucide 依赖。
- [x] 渲染图标，在属性面板中允许用户修改或清除。
- [x] 根据标签、字号、图标和形状确定节点最小尺寸。
- [x] 增强 Dagre 间距、共享泳道主轴、稳定分支顺序和端口选择。
- [x] 为正交边生成可重复的避障控制点，反馈边走外侧。
- [x] 保留人工/AI 显式位置和控制点，自动路由可在节点移动后重算。

主要文件：`flowchart-icons.tsx`、`flowchart-document.ts`、`flowchart-patch.ts`、`FlowchartCanvas.tsx`。

验收：相同输入坐标与控制点一致；长中文不默认裁切；典型回路不穿过无关节点。

### P3：本地质量检查与 UI 反馈

- [x] 新增 `flowchart-quality.ts` 纯函数，并在画布渲染后检查真实标签边界与 SVG 边路径。
- [x] patch 应用后运行检查，自动尺寸和路由完成后复查。
- [x] 把剩余 warning 加入 patch 结果、主会话状态和笔记变更卡片。
- [x] 无变化、失败和质量 warning 使用不同状态，不把应用成功当成质量通过。

验收：构造的五类问题都能返回正确对象 ID；质量检查不修改文档；warning 不阻止用户继续人工编辑。

### P4：mona-canvas skill

- [x] 创建简短 `SKILL.md`，只路由所需参考。
- [x] 提炼上游的分区、阅读方向、间距、端口、避障和复核方法。
- [x] 增加流程图、泳道和架构图设计参考，与实际 patch 能力一致。
- [x] 使用现有 skill validator 校验。
- [x] 核对 Mona 内置 skill 扫描路径；没有新增下载或云端依赖。

### P5：验证与真实样例

- [x] 扩展 patch、document、layout 和 shape 测试，覆盖成功与拒绝路径。
- [x] 新增质量检查测试，覆盖对象 ID 和确定性。
- [x] 主会话和笔记侧栏回归；思维导图、人工编辑、保存和导出相关测试通过。
- [x] 运行相关 Vitest、TypeScript 构建与 skill 校验。
- [x] 在 dev 环境用实际编辑器渲染复杂回路、四角色泳道和三层软件架构，根据共性问题迭代。
- [x] 独立 Agent 只读取 `mona-canvas` skill 生成复杂退款流程；当前解析器应用成功并在真实编辑器渲染。
- [ ] 使用 Mona 模型从自然语言自主生成同类样例：本机当前模型凭据为 `no-key`，调用被提供方拒绝。

## 3. 测试矩阵

| 范围 | 必测行为 |
| --- | --- |
| Patch schema | 未知字段、未知图标、非法颜色/尺寸/端口/控制点、超限载荷、重复 ID |
| 原子应用 | 任一操作失败整批不生效、expected 不匹配、视觉哈希冲突、重复应用 |
| 完整创建 | 自动布局、手动布局、主题、样式、图标、判断标签、反馈边 |
| 局部修改 | 改字、改色、换图标、改线型、重新布局，未目标对象保持 |
| 布局 | TB/LR、长中文、宽节点、分支、回路、同端点多边、结果确定性 |
| 容器 | 泳池、泳道、跨泳道边、容器不与子节点误报重叠 |
| 质量检查 | 重叠、文本溢出、穿线、越界、重复路由和概览缩放过低均返回对象 ID |
| 入口 | 主会话自动应用、笔记侧栏确认应用、过期 patch 拒绝、内部 JSON 不显示给用户 |

## 4. 完成门槛

代码完成：

- 相关测试、类型检查和构建通过。
- Skill 校验通过，协议和参考内容一致。
- 没有新增云端、协作、Office 或第二套画布实现。
- 当前工作树中的其它修改未被还原或覆盖。

效果完成：

- 四类固定样例结构完整，无严重重叠、文字溢出、穿越节点或页面越界。
- 图中可以出现合理的主题、强调层级、图标、分组/泳道、正交线与反馈路径。
- 用户修改视觉后，旧 AI 结果不会覆盖；第二轮局部修改不破坏其它对象。
- 实际生成过程发现的通用问题已回写到协议、布局或 skill，没有为某个测试主题写死内容和坐标。

## 5. 当前证据

- 相关 Vitest：22 个文件，456 passed，3 skipped。
- TypeScript 检查与完整 `npm run build`：通过。
- `mona-canvas` quick validate：通过。
- dev 实际编辑器渲染：架构分区、复杂反馈回路、四角色泳道通过；详见[验收记录](../reports/2026-09-07-ai-canvas-quality-replication-report.md)。
- 独立 Agent 输出：[patch](../../output/ai-canvas-quality/independent-agent/refund-flow.patch.md)、[PNG](../../output/ai-canvas-quality/independent-agent/refund-flow.png)、[验证结果](../../output/ai-canvas-quality/independent-agent/validation.json)。
- 自主模型验收：未通过环境前置条件，错误为 `Incorrect API key provided: no-key`。
- 本地模型替代检查：Ollama、LM Studio 和常见兼容端口均不可用；未安装模型或修改用户配置。

后续实施必须先完成新计划中的布局、局部编辑、分区关系、AI 反馈和默认创作能力，再运行产品模型验收；不能只补凭据后将本记录视为整体完成。
