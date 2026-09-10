# Mona AI 流程图高质量生成能力复刻验收记录

> 日期：2026-09-07
> 状态：历史阶段验收记录。
> 更正：当时的测试与渲染记录不证明官方 Demo 质量达标。后续只读审计复现了反馈线穿节点、改色影响无关边、分区重排失配，并确认 AI 反馈未闭环；当前开发与验收以[官方 Demo 方案](../design/ai-canvas-official-demo-development.md)和[实施计划](../plans/ai-canvas-official-demo-implementation.md)为准。下文保留原阶段证据及当时的模型环境结果。

## 范围

本次只增强 Mona 现有 React Flow 流程图底座。没有引入 draw.io 内核、XML 文档、云端画布、多人协作、后端画布 session 或 Office 联动。

## 已完成

- AI patch 支持完整文档哈希、主题、背景、节点尺寸/样式/图标/可选位置、边样式/端口/控制点、架构分区和完整泳道 blueprint。
- 局部操作支持视觉修改、主题更新和重新布局，仍使用稳定 ID、expected 前置条件和原子应用。
- 新增 20 个本地 Lucide 通用图标，并在属性面板中允许用户修改或清除图标。
- 新增文字感知尺寸、正交线避障、反馈边外侧绕行、自动路由重算和大图首屏自动适应。
- 新增本地质量检查：节点重叠、文字溢出、边穿节点、页面越界和重复路由，问题返回节点/边 ID。
- `FlowchartCanvas.inspectQuality()` 在字体和 SVG 渲染完成后读取真实标签边界与边路径，并与文档几何检查合并；编辑器直接显示未完成或具体问题。
- 新增 `mona-canvas` skill，按需加载流程图、泳道、架构图和视觉复核方法。
- 创建期间不再用全屏遮罩挡住画布，用户可以看到并接管当前编辑器。

## 真实 dev 渲染

使用正在运行的 Vite dev 环境和实际 `FlowchartDocumentEditor` 渲染检查了以下固定 blueprint：

1. 三层软件架构：接入层、服务层、数据层；图标、锁定视觉分区、不同节点形状和跨区连线正常。
2. 复杂退款流程：判断分支、自动/人工路径、状态色、通知和外侧重试回路正常。
3. 四角色泳道：员工、主管、财务、系统；节点归属、共享主轴层级、跨泳道连线和反馈路径正常。

渲染检查发现并修复了四个单元测试未覆盖的通用问题：

- 大图首次打开固定 100%，导致视口裁切；现改为小图保持 100%，大图自动适应。
- AI 架构成员使用父容器后跨分区边坐标失真；现改为根级视觉分区，业务节点保持同一坐标系。
- 编辑器把子节点先于父容器交给 React Flow，导致泳道节点堆在第一行；初始化和同步现统一使用父先子排序。
- 旧泳道布局逐泳道独立计算，跨泳道节点没有全局层级；典型横向/纵向泳道现先计算共享主轴再放回各泳道。

另外使用只在浏览器渲染层压窄、文档几何仍充足的节点验证了 DOM 质检：静态估算不报错，实际检查正确返回“节点 node 的实际渲染文字超出可用区域”。

临时预览入口和测试 prompt 已删除，没有留下业务外演示代码。

## 独立 Agent 前向测试

独立 Agent 未获得预期答案，只收到真实退款流程需求、空白文档哈希和 `mona-canvas` skill 路径。它按 skill 路由读取三份参考，生成一个 `replaceGraph` auto patch：

- 13 个节点、16 条边；13 个节点带通用图标，9 个节点带差异化样式。
- 当前 Mona 解析器和应用器成功；无结构错误、重叠、文字溢出或穿线错误。
- 全图在常用视口的估算比例为 44%，本地检查正确保留 `overview-too-small` warning；1440×900 真实编辑器截图中的实际适应比例为 47%，结构和标签可读。

证据：[原始 patch](../../output/ai-canvas-quality/independent-agent/refund-flow.patch.md)、[真实编辑器 PNG](../../output/ai-canvas-quality/independent-agent/refund-flow.png)、[验证结果](../../output/ai-canvas-quality/independent-agent/validation.json)。

## 自动验证

- Flowchart、canvas 与 prompt 相关 Vitest：22 个文件，456 passed，3 skipped。
- `npx tsc -p tsconfig.build.json --noEmit`：通过。
- `npm run build`：通过，包括 WebUI 与 Office editor 既有构建；只有仓库原有的动态导入和大 chunk 提醒。
- `python mona/skills/skill-creator/scripts/quick_validate.py mona/skills/mona-canvas`：通过。
- 定向 ESLint 未运行：当前安装 ESLint 10，但仓库没有 `eslint.config.*`。未为本任务迁移全仓 lint 配置。

## 尚需运行的环境验收

现有 Gateway 健康运行在 HTTP 17173 / WebSocket 8765。为了验证 Mona 模型自主生成，使用当前工作区执行了独立 CLI 会话；模型调用返回：

```text
Incorrect API key provided: no-key.
```

因此当时没有将手工 blueprint 的成功渲染冒充为 Mona 模型自主生成。这只说明该轮产品模型调用未成功，不能证明剩余工作仅是补充凭据。后续审计已确认布局、局部编辑、分区关系和 AI 反馈存在代码缺口，应按新的官方 Demo 计划修复后再运行正常会话验收。

同时只读检查了本机常见本地模型入口：Ollama `11434`、LM Studio `1234` 和兼容服务 `8000` 均未运行，没有可在不安装模型、不改配置的前提下替代当前提供方的本地模型。
