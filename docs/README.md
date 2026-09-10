# Mona 文档目录

> 本目录中的临时方案默认不进入版本管理；长期架构基线和仍被代码引用的交付文档必须显式纳入版本管理。
> 长期架构入口：`architecture/runtime-component-management.md`。
> 代码目录禁止散落 `.md` 设计文档，所有设计/计划文档统一收纳于此。

## 目录结构

| 目录 | 用途 | 收纳规则 |
|------|------|---------|
| `architecture/` | 跨模块架构设计 | 整体架构、跨模块协作、技术选型对比 |
| `plans/` | 开发计划 | 实施计划、迭代计划、MVP 计划（`*-plan.md`、`*-dev-plan.md`） |
| `design/` | 模块设计方案 | 单模块详细设计、接口设计（`*-design.md`、`*-redesign.md`） |
| `research/` | 调研分析 | 竞品对比、技术调研、可行性分析 |
| `guides/` | 使用指南 | CLI 参考、配置说明、API 文档、集成指南 |
| `archive/` | 归档历史文档 | 已废弃、被替代、原型、调试日志、用户手册 |

## 命名规范

- 主题命名：`<模块>-<类型>.md`（如 `email-design.md`、`video-dev-plan.md`）
- 时间戳命名（历史保留）：`YYYY-MM-DD-<模块>-<类型>.md`
- 设计文档后缀：`-design.md`（方案）、`-redesign.md`（重构）、`-plan.md`（计划）

## 索引

### architecture/（7 篇）
跨模块架构与整体设计。

- `runtime-component-management.md`：可下载模型、解释器、浏览器和原生工具的统一存储、下载、版本与生命周期基线
- `engineering-boundaries.md`：核心扩展、进程、Prompt、安全、Windows、UI、测试和文档治理边界
- `module-invariants.md`：邮件、通讯录、数据库、浏览器、画布、Terminal 与 URL 转笔记的长期行为不变量
- `retrieval-architecture.md`：Notes 与 Materials 的事实源、权限、索引和统一检索契约
- `user-profile-distillation.md`：用户级画像存储、信号归因、蒸馏和只读快照边界
- `browser-development-framework.md`：WebView2 标签、原生事件、状态所有权和回归矩阵
- `services-split-design.md`：Gateway、Services 与前端 API 的进程所有权
- `services-split-design.md`：后端进程拆分架构（gateway Agent 运行时 + services 业务服务）

### plans/（49 篇）
按模块和时间组织的开发计划。

- `main-chat-canvas-workspace.md`：主会话右侧可编辑画布工作区的剩余实施与验收
- [ai-canvas-official-demo-implementation.md](plans/ai-canvas-official-demo-implementation.md)：以官方 Demo 为基准，验收 AI 自主生成、默认创作、检查修正及新内容迁移的当前开发计划（待实施）
- [2026-09-07-ai-canvas-quality-replication-plan.md](plans/2026-09-07-ai-canvas-quality-replication-plan.md)：上一阶段画布能力实施记录，已由官方 Demo 计划取代
- `database-ai-sidebar-development-plan.md`：数据库 AI 侧边栏受控变更闭环的剩余实施计划
- `runtime-component-migration-plan.md`：现有分散运行时迁入统一组件仓库的实施与验收
- `multi-agent-completion-plan.md`：多 Agent V1 收口实施指南（阶段 C0–C5、P0 问题清单、测试与发布门槛），已纳入版本管理
- `stock-research-best-practice-v6-development-plan.md`：股票投研 V6 交付计划（量化验证、A 股执行约束、三周期决策、六 Agent 与前端验收基线）
- `stock-research-best-practice-v6-acceptance-report.md`：股票投研 V6 验收报告与剩余运行验收项
- `stock-agent-capability-upgrade-plan.md`：六 Agent Skill 与工具能力映射（V6 支撑文档）
- `ai-opportunity-research-delivery-plan.md`：AI 选股候选机会研究子流程（V6 支撑文档）
- `im-ui-interaction-dev-plan.md`：企业 IM UI 与交互开发计划（三栏壳层、会话列表、房间上下文栏的交付与验收基线），已纳入版本管理
- `flowchart-orthogonal-connector-drag-plan.md`：流程图折线拖动与最小路径合并开发计划（控制点交互、正交路径、回拖重叠合并）
- `mona-ui-refactor-plan.md`：全产品 UI 大规模改造执行计划（规范收口、公共基础、三个样板、全模块迁移与新功能准入）
- `storage-value-closure-plan.md`：存储空间模块完整改造路线（阶段 A 价值闭环：大文件回收站/口径对齐/性能/AI 通道；阶段 B–D：值守化/答案化/趋势化）

- `schedule-week-view-dev-plan.md`：日程模块周视图时间轴 + 拖拽排期（分段视图切换、事件块时长可视化、待办拖入日历）

- `materials-refactor-plan.md`：资料库模块重构（统一检索层、frontmatter PyYAML、vault 自包含、编译管线优化、前端拆分），已落地
- `artifact-panel-dev-plan.md`：AI 对话产物区体验改造（会话相关性、预览导航、回收站删除、变更推送），TDD 执行
- `system-module-optimization-plan.md`：系统模块优化计划（死代码清理、诊断命令接入概览、UI 规范收敛、数据层体验优化）
- `settings-improvement-plan.md`：设置页改进计划（修 Overview 断链、移除死设置、消灭原生弹窗、重启标记语义修正）
- `2026-08-07-ppt-module-deep-optimization-plan.md`：PPT 模块深度优化（自动保存、WebSocket 推送、向导式配置、预览增强）
- `2026-08-07-video-rearchitecture-plan.md`：视频模块架构重构（分镜双源修复、旁白前置合成、帧级进度、WS 推送、快照导出）

### design/（57 篇 Markdown）
模块级详细设计方案。

- [2026-09-07-miniapp-three-end-design.md](design/2026-09-07-miniapp-three-end-design.md)：微信小程序、桌面与云服务互通方案，覆盖笔记日程同步、云端对话、P2P 远控、内网 ASR 与数据归属（待实施）
- `multi-agent-functional-design.md`：多 Agent 功能设计（伙伴 Agent、房间协作、Agent 商店的产品依据），已纳入版本管理
- `multi-agent-development-guide.md`：多 Agent 开发指南（阶段 0–4 技术方案，代码注释中引用的 `docs/design/multi-agent-development-guide.md` 即本文），已纳入版本管理
- `mona-ui-design-system.md`：Mona 唯一全局 UI 设计规范，以当前新会话第一屏为视觉母版
- [ai-canvas-official-demo-development.md](design/ai-canvas-official-demo-development.md)：官方 Demo 视觉基准、上游创作方法、AI 默认设计标准与本地生成反馈闭环（待实施）
- [2026-09-07-ai-canvas-quality-replication-design.md](design/2026-09-07-ai-canvas-quality-replication-design.md)：上一阶段画布设计记录，已由官方 Demo 方案取代
- `2026-08-04-notes-materials-implementation-assessment-and-plan.md`：笔记资料库实现评估与分阶段改进计划（阶段 0-2 已落地，检索闭环可用）
- `note-import-design.md`：笔记来源扩展设计方案（URL 转笔记增强 + 文档转笔记 MVP，支持 docx/pptx/pdf/xlsx）
- `stock-data-source-compliance-matrix.md`：股票数据源与合规可行性矩阵（V6 证据层支持文档）

### guides/（14 篇）
面向使用者和开发者的参考文档。

- [mona-worker-deployment.md](guides/mona-worker-deployment.md)：内网计算节点的 Docker、GPU、目录、长期运行与迁移配置
- `browser-testing.md`：WebView2 生命周期、下载、窗口、压力与安全回归矩阵
- `three-maker-guide.md`：3D Maker 使用指南（参考图到 Three.js 模型的 AI 建模管线、候选规格协作、导出与安全边界）

### reports/

- [2026-09-07-ai-canvas-quality-replication-report.md](reports/2026-09-07-ai-canvas-quality-replication-report.md)：历史测试与渲染记录；已补充后续审计更正，不代表官方 Demo 质量达标

### archive/（5 个文件）
已归档的历史文档、原型、系统模块设计存档。

---

新增文档时请放入对应分类目录，并保持命名规范。
