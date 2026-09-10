# Mona 多 Agent 架构实现收口开发指南

> 文档日期：2026-08-15  
> 面向对象：继续完成多 Agent V1、IM 产品交互、股票六 Agent 与后续 Agent 商店的开发人员  
> 当前代码基线：本地 `master`，HEAD `8a219e43`  
> 关联文档：`../design/multi-agent-functional-design.md`、`../design/multi-agent-development-guide.md`、`./im-ui-interaction-dev-plan.md`、`./stock-research-best-practice-v6-development-plan.md`

---

## 1. 本文目的

当前仓库已经具备可运行的多 Agent 底座，但“核心代码存在”不等于“产品已经交付”。本文以当前真实代码为基线，说明：

1. 哪些能力已经完成，后续不得重写第二套实现。
2. 哪些能力只完成了后端、目录或 UI 骨架。
3. 开发人员应按什么顺序收口。
4. 每个阶段需要修改哪些文件、保持哪些接口和通过哪些测试。
5. 多 Agent V1、股票六 Agent、Agent Package/商店分别在什么条件下才可开始和验收。

本文是“从当前实现继续开发”的执行指南，不替代功能设计文档。

---

## 2. 结论与交付目标

### 2.1 当前结论

当前实现可评价为：

- 多 Agent 核心运行底座：基本成立。
- 专业 Agent 私聊、房间 `@Agent`、Mona 委派：主链路已接通。
- Memory/Skill：当前工作区已补到工具级隔离，但尚未形成真实 Agent Package Skill 的端到端闭环。
- Workflow：后端执行器较完整，产品编辑和产物闭环未完成。
- IM：企业微信式三栏壳层存在，最终会话列表、未读、正式头部和响应式未完成。
- Agent Package/官网购买：仅有 manifest/Registry 雏形，安装与授权系统未实现。
- 股票六 Agent：设计已明确复用通用引擎，尚未进入代码实现。

### 2.2 本轮收口目标

本轮首先交付“多 Agent V1”，满足：

1. Mona、专业 Agent 私聊和协作房间处于同一消息列表。
2. 专业 Agent 私聊由真实专业 Agent 执行。
3. 房间支持结构化 `@Agent` 和 Mona 临时委派。
4. 每个 Agent 的 Memory、包内 Skill、自建 Skill 和工具权限真正隔离且可用。
5. 每个房间只有一个当前工作流；工作流支持手动/定时、串行/并行、审批、取消和恢复。
6. 房间侧栏只放摘要；复杂工作流配置在主内容区完成，不使用画布。
7. 工作流步骤产生的真实 Artifact 可追溯到 AgentJob、StepRun 和原房间。
8. 核心场景有自动化测试，并经过一次真实桌面端人工验收。

### 2.3 本轮不同时实现的内容

以下内容不要与 V1 收口混在同一批改动中：

- 官网商品、订单和支付。
- 第三方 Package 市场和向 Mona 官方专家库上传内容的服务；本地自定义专家不受影响。
- 任意拖拽工作流画布。
- 专业 Agent 相互递归委派。
- 一个房间多套当前工作流。
- 股票专用 Job/Workflow 状态机。
- 多轮自由辩论、投票和动态循环编排。

先把现有一套链路做完整，再扩展商业能力。

---

## 3. 开发前必须处理的版本边界

### 3.1 当前仓库不是干净的远端 master

截至本文编写时：

- 本地 `master` 比 `origin/master` 领先 4 个提交。
- 本地 HEAD 为 `8a219e43`。
- 工作区仍有大量已修改和未跟踪文件。
- 多 Agent 的部分关键修复只存在于未提交工作区。
- 三份根目录设计/开发文档没有被 Git 跟踪。
- `docs/` 被 `.gitignore` 忽略，股票设计文档也不在版本库中。

因此不能从 `origin/master` 重新拉一个干净分支后直接宣称“继续当前进度”，也不能执行会丢弃工作区的 reset/clean。

### 3.2 当前未提交但与多 Agent 直接相关的改动

至少包括：

- `mona/agent/loop.py`
- `mona/agent/memory.py`
- `mona/agent/partner_loop.py`
- `mona/agent/skill_usage.py`
- `mona/agent/skills.py`
- `mona/agent/subagent.py`
- `mona/agent/tools/skill_tools.py`
- `mona/agent/workflow.py`
- `mona/channels/websocket.py`
- `mona/cron/types.py`
- `mona/session/manager.py`
- `mona/session/webui_turns.py`
- `mona/webui/sidebar_state.py`
- `webui/src/components/ChatList.tsx`
- `webui/src/hooks/useSessions.ts`
- `webui/src/hooks/useSidebarState.ts`
- `webui/src/lib/api.ts`
- `webui/src/lib/types.ts`
- 相关新增/修改测试

其中包含：

- 专业 Agent 不可用时不再回退成 Mona。
- manifest 指定模型的实际使用。
- Skill Read/Create/Script/Reference/Asset 的 Agent 级隔离。
- Skill 使用记录、归档和锁文件的 Agent 级隔离。
- IM 最新可见消息摘要。
- Sidebar state v2 和阅读位置数据。
- 工作流待审批、运行状态和定时状态的会话列表数据。

### 3.3 开发人员第一步

开始功能开发前必须先完成：

1. 保存当前工作区的完整状态和差异清单。
2. 将多 Agent 相关改动与无关 provider、终端、流程图等改动分开。
3. 把当前多 Agent 修复整理为可评审提交。
4. 不提交 `_patch*.py`、scratch、baseline 临时目录、调试脚本和根目录 `node_modules/`。
5. 将本文和三份核心方案文档纳入版本管理；若继续忽略整个 `docs/`，至少为需要交付的设计文档添加明确例外。
6. 整理后重新运行本文第 13 节的基线测试。

退出标准：开发人员、评审人员和 CI 看到的是同一套代码，不再出现“工作区已修复、master 没有、远端更旧”的三种实现状态。

---

## 4. 不得重写的现有核心能力

以下能力已经存在，应复用和补齐，不应另建平行实现。

### 4.1 AgentDefinition 与 AgentRegistry

现有实现：

- `mona/agent/partners.py`
- Mona 保留固定 ID `mona`。
- 内置 Agent 从 `mona/agents/<agent_id>/agent.json` 加载。
- 已安装 Agent 当前从 `~/.mona/agents/<agent_id>/agent.json` 加载。
- Prompt、头像和 Skill 路径有包内包含关系校验。
- 专业 Agent 的工具表由 manifest allowlist 与平台安全工具交集决定。

后续只扩展缺失字段，例如 `visibility`、enabled 状态和正式 Package 版本解析，不另建第二个 Agent 注册中心。

### 4.2 专业 Agent 私聊

现有实现：

- `mona/agent/loop.py`
- `mona/agent/partner_loop.py`
- `ConversationMetadata.direct_agent_id`
- 专业 Agent 使用自己的 Prompt、模型、Memory 和 ToolContext。
- 专业 Agent 消息写入真实 `author_id`。

后续不得把专业 Agent 私聊再次改回“Mona Prompt 中模拟角色”。

### 4.3 房间、结构化 @ 和 AgentJob

现有实现：

- `mona/channels/websocket.py`
- `mona/agent/room.py`
- `mona/agent/jobs.py`
- `mona/agent/tools/delegate.py`
- `mona/agent/subagent.py`
- `webui/src/components/thread/ThreadComposer.tsx`
- `webui/src/hooks/useMonaStream.ts`

规则：

- 前端发送 `target_agent_ids`，不要让后端重新依赖显示名解析文本。
- 服务端必须验证目标 Agent 是当前房间成员。
- 专业 Agent 的执行必须产生持久化 AgentJob。
- Job 终态不可被迟到结果覆盖。
- Job 结果回到原房间，不创建新会话。

### 4.4 WorkflowStore、WorkflowRunStore 与 WorkflowRunner

现有实现：`mona/agent/workflow.py`。

已经支持：

- 草稿、激活版本和不可变运行快照。
- DAG 校验与拓扑执行。
- 串行、并行、失败、取消。
- Approval token、过期和幂等决策。
- 每房间活动运行锁。
- cron 与重启恢复。

后续前端和股票模块都必须复用该状态机。禁止新增 `stock/pipeline.py`、内存 Workflow 表或第二套审批状态。

### 4.5 Memory 与 Skill 私有目录

现有边界：

```text
~/.mona/agents/<agent_id>/memory/
~/.mona/agents/<agent_id>/skills/
```

平台内置 Skill 可以共享；Agent Package Skill 和 Agent 自建 Skill 不共享。

---

## 5. 当前 P0 问题清单

### P0-1：包内 Skill 的真实加载链路没有验收

现状：

- 两个内置 Agent 的 `skills` 均为空。
- 两个 Agent 的工具白名单有 `skill_create`，没有 `skill_read`。
- `SkillsLoader.build_skills_summary()` 明确要求通过 `skill_read` 读取完整 Skill。
- 当前隔离测试直接构造 SkillTool 或 mock `resolve_skill_dirs()`，没有用真实内置 Agent manifest 验证。
- 方案示例把 `skills[]` 定义为具体 Skill 目录，例如 `skills/market-research`；当前 `SkillsLoader` 却把每个 `package_skill_dir` 当作“包含多个 Skill 的根目录”。两者语义不一致。

结果：目录隔离测试通过，不代表真实 Agent 能读取包内 Skill 或自己创建的普通 Skill。

### P0-2：IM-1 数据已经存在，UI 尚未接通

现状：

- 后端已经开始返回 `preview_at`、`preview_author_type`、`workflow_run_status`、`waiting_approval`、`scheduled`。
- Sidebar state v2 已保存 `last_read_at_by_key`。
- 前端已有 `isSessionUnread()` 和 `markSessionRead()`。
- `ChatList` 和 `AppRail` 尚未真正使用这些数据。

结果：用户看不到可靠未读、审批或定时状态。

### P0-3：会话列表仍是旧 ChatList 的分组逻辑

现状：

- 私聊和房间已经混排。
- 但仍显示置顶/项目/普通会话分组标题。
- 搜索只是图标打开弹窗，不是常驻搜索框。
- Mona/旧会话的头像行为不统一。
- 第二行常显示会话标题，不一定是最新消息。
- `showTimestamps` 参数未实际生效。

结果：结构像 IM，信息模型仍像原任务/项目侧栏。

### P0-4：工作流编辑器位置和交互不符合最终方案

现状：

- 完整 `WorkflowEditor` 嵌在 `RoomContextPanel` 的窄侧栏。
- 没有主内容区“聊天/工作流编辑”模式。
- 没有手动/cron 触发方式编辑 UI。
- 依赖关系主要通过内部 step ID 复选框配置。
- 没有面向普通用户的并行表达。

结果：技术上能保存 DAG，但不符合“简单、无画布、面向用户”的产品要求。

### P0-5：Workflow Artifact 固定为空

现状：AgentJob 成功后，`StepRun.output` 写入：

```json
{"summary": "...", "artifacts": []}
```

结果：房间侧栏、运行卡和后续步骤无法可靠引用真实产物，股票结构化研究也无法建立在该字段上。

### P0-6：创建房间规则前后端不一致

现状：

- 产品设计要求房间目标必填。
- 前端允许空目标。
- 后端也会把空目标转成 `None`。
- 后端会自动插入 Mona，但前端没有把 Mona 明确显示为固定成员。
- 创建失败只记录日志，缺少完整错误、重试和保留表单内容。

### P0-7：发布门槛未通过

当前验证结果：

- 多 Agent 定向 Python 测试：151 项通过。
- 前端工作流专项测试：18 项通过。
- 前端完整测试：990 项通过、2 项失败、3 项跳过。
- 前端生产构建通过。
- `npm run lint` 无法执行，因为仓库没有 ESLint 依赖和配置。
- 新增 `test_partner_unavailable.py` 存在 3 个 Ruff E402 问题。

不能在完整测试仍失败、文档未跟踪、工作区未提交时标记正式完成。

---

## 6. 必须保持的架构约束

后续每个提交都必须满足：

1. **只有一套 Agent 执行模型**：私聊、委派和工作流步骤都基于 AgentDefinition、ToolContext、AgentJob 和现有 AgentLoop/runner。
2. **只有一套房间会话**：房间状态、消息、Job、WorkflowRun 和 Artifact 都关联原 `chat_id/room_id`。
3. **只有一个可信执行身份**：`agent_id` 从服务端执行上下文注入，模型和前端不能伪造。
4. **专业 Agent 不能递归委派**：`spawn`、`delegate_agent`、`propose_workflow` 仍是 Mona-only。
5. **长期数据按 Agent 隔离**：Memory、Skill、Skill usage、archive 和 lock 都按 Agent 目录存储。
6. **工作流属于房间**：没有全局工作流导航，没有每次运行新建会话。
7. **运行使用不可变快照**：编辑/激活新版本不能改变正在执行的旧运行。
8. **产物来自结构化记录**：不能从模型回复文本猜测文件路径，也不能依赖目录差异推断责任归属。
9. **前端不另建真相源**：运行、审批、未读和定时状态必须来自持久化后端数据。
10. **不引入画布和新工作流引擎**：步骤卡片足够表达 V1。

---

## 7. 阶段 C0：收敛当前工作区

### 7.1 任务

- 整理第 3.2 节所列改动。
- 将身份回退修复、Agent 模型、Skill 隔离和 IM-1 数据层分为可独立评审的提交。
- 删除或排除临时 patch/scratch 文件。
- 将设计、开发、IM、本文四份文档纳入 Git。
- 更新 `../design/multi-agent-development-guide.md` 中失真的完成勾选。

特别需要修正的文档状态：

- “最近产物”不能标为完成，因为 `StepRun.output.artifacts` 仍为空。
- “未读、系统通知和审批提示”不能标为全部完成，因为 UI 未接通。
- “搜索框 + 未读角标”不能标为完成，因为当前只有搜索按钮且没有真实角标。
- 阶段 4.5 的两个“需联调验证”项仍保持未完成。

### 7.2 退出标准

- `git status` 只包含当前阶段明确要提交的文件。
- 没有临时生成文件混入功能提交。
- 评审者能从提交历史还原当前实现。
- 第 13.1 节定向测试通过。

---

## 8. 阶段 C1：完成 Agent Skill 端到端闭环

### 8.1 修复 package skill 路径语义

建议保持 manifest 当前设计语义：`skills[]` 的每一项指向一个具体 Skill 目录，该目录必须包含 `SKILL.md`。

例如：

```json
{
  "skills": [
    "skills/a-share-research"
  ]
}
```

需要修改：

- `mona/agent/partners.py`
- `mona/agent/skills.py`
- `mona/agent/tools/skill_tools.py`
- 真实 manifest 测试

要求：

1. `AgentRegistry.resolve_skill_dirs(agent_id)` 返回 manifest 中声明的具体 Skill 目录。
2. `SkillsLoader.list_skills()` 能把这些具体目录识别为一个 Skill，而不是继续把它当根目录枚举子目录。
3. `SkillsLoader.resolve_skill_dir(name)` 可以在私有层、具体 package skill 层、平台 builtin 层按优先级解析。
4. 同名覆盖顺序保持：Agent 私有 > Agent Package > 平台 builtin。
5. 不通过把 manifest 临时改成 `"skills": ["skills"]` 掩盖 schema/实现不一致；除非同时正式修改文档、校验和迁移规则。

### 8.2 给两个内置 Agent 配置真实专属 Skill

至少新增：

```text
mona/agents/com.mona.a-share-analyst/skills/a-share-research/SKILL.md
mona/agents/com.mona.xhs-operator/skills/xhs-content-operations/SKILL.md
```

并更新各自 `agent.json` 的 `skills`。

Skill 内容必须是该 Agent 的专业工作方法，不复制平台通用 Skill。首版只需要一项高质量、可验证的专属 Skill，不要为了数量创建空壳。

### 8.3 补齐工具白名单

两个 Agent 至少需要：

- `skill_read`
- `skill_create`

仅当专属 Skill 确实需要脚本、references 或 assets 时，再加入：

- `skill_script_run`
- `skill_reference_read`
- `skill_asset_copy`

不要给当前专业 Agent 加 `spawn`、`delegate_agent` 或 `propose_workflow`。

### 8.4 必须新增的真实链路测试

测试不能继续只 mock package skill 目录，至少覆盖：

1. 使用仓库内真实 A 股分析师 manifest 加载 Registry。
2. Registry 能列出其专属 Skill。
3. ToolLoader 根据真实 allowlist 注册 `skill_read`。
4. A 股分析师能读取自己的 package Skill。
5. 小红书运营不能读取 A 股分析师 package Skill。
6. A 股分析师创建 Skill 后能在下一次 AgentLoop/Job 中读取。
7. Mona 和其他 Agent 不能读取该自建 Skill。
8. 重启 Registry/SkillsLoader 后隔离仍成立。

### 8.5 退出标准

- “独立 Skill”不再只是目录隔离，而是可发现、可读取、可执行、可重启恢复。
- 两个内置 Agent 至少各有一个真实专属 Skill。
- 所有测试使用真实 manifest 路径通过。

---

## 9. 阶段 C2：完成 IM-1 数据与未读闭环

### 9.1 后端会话摘要

涉及：

- `mona/session/manager.py`
- `mona/session/webui_turns.py`
- `mona/channels/websocket.py`
- `mona/webui/sidebar_state.py`

保持当前原则：

- preview 来自最后一条用户可读消息。
- 排除 tool、reasoning、系统注入和纯内部结构。
- preview 文本、时间、作者类型、作者 ID 和消息类型来自同一条消息。
- 老会话按需回退扫描，并写入/更新摘要缓存。
- 工作流状态来自持久化 WorkflowRun/active workflow，不来自内存中的 React 状态。

补充检查：

- 媒体消息、附件消息和无文本消息的 preview。
- 时区格式一致性；不得依赖可能混用时区格式的字符串比较。
- 超长消息截断和 Unicode。
- `_ui_only`、tool call、tool result 不成为 preview。

### 9.2 前端已读规则

涉及：

- `webui/src/hooks/useSidebarState.ts`
- `webui/src/App.tsx`
- `webui/src/hooks/useSessions.ts`

规则：

1. 用户自己发送的消息不产生未读。
2. 非当前会话收到 Agent 消息产生未读。
3. 非当前房间进入 `waiting_approval` 产生提醒。
4. 选择会话且对应 `previewAt` 已渲染后，推进阅读位置。
5. 当前窗口失焦时不能仅因 activeKey 相同就自动清除未读。
6. 窗口重新 focus/visible 后，当前会话已显示的最新消息可标记已读。
7. 阅读位置只向前推进。
8. 未读状态重启后保持。

### 9.3 AppRail 消息角标

消息角标计算为：

```text
unread session keys ∪ waiting-approval room keys
```

按会话去重，不按消息数累加。不要为审批再建立第二个未读数据库。

### 9.4 退出标准

- 新旧会话、Mona、专业 Agent 和房间都返回正确 preview。
- 非当前会话的新 Agent 消息会出现未读。
- 进入并看见消息后清除。
- 审批提醒与普通未读按会话去重。
- 重启后状态正确。

---

## 10. 阶段 C3：完成最终会话列表

### 10.1 新增纯展示模型

新增：

```text
webui/src/lib/session-list-model.ts
```

只包含纯函数：

- display title
- latest preview
- search text
- stable sort
- relative timestamp
- unread/status priority
- conversation avatar model

`ChatList` 和 `SessionSearchDialog` 共用这些函数，避免两套搜索和标题规则。

### 10.2 SessionListPanel

修改 `webui/src/components/shell/SessionListPanel.tsx`：

- 顶部使用常驻搜索输入框。
- 右侧保留“+”菜单。
- 输入时即时过滤，无需提交。
- 可搜索会话标题、最新消息、房间目标和 Agent 名称。
- 搜索结果保留头像、类型、最新 preview 和时间。
- 归档会话默认不出现，用户进入归档视图后再搜索。
- 支持桌面 260px 和移动 Sheet `w-full`。

### 10.3 ChatList

修改 `webui/src/components/ChatList.tsx`：

- 消息 Tab 使用连续会话列表，不显示 project/group 标题。
- 所有会话显示头像，包括 Mona 和旧会话。
- 第一行：伙伴名或房间名 + 时间。
- 第二行：最后一条用户可读消息 preview。
- 显示一个主状态：待审批 > 失败 > 运行中 > 未读 > 定时。
- 保留置顶、归档、重命名和删除。
- `showTimestamps` 必须真正生效；若最终产品永远显示时间，则删除该无效配置和 prop。
- 不在同一行同时堆叠多个重复角标。

### 10.4 AppRail

修改 `webui/src/components/shell/AppRail.tsx`：

- 消息入口显示第 9.3 节的去重角标。
- 高度不足时仍保证消息和伙伴入口固定可见。
- overflow 菜单保留模块角标。

### 10.5 必须新增的组件测试

- Mona、专业 Agent、房间三类会话混排。
- 所有会话都有头像。
- 最新消息而不是标题显示在第二行。
- 常驻搜索按四类字段命中。
- 未读、审批和运行状态优先级。
- 时间显示规则。
- 置顶、归档、重命名、删除不回归。
- 500 条以上会话不会一次渲染全部内容。

### 10.6 退出标准

会话列达到 `./im-ui-interaction-dev-plan.md` 第 10 节规范，用户不需要理解“项目会话”和“房间会话”的内部差异。

---

## 11. 阶段 C4：正式聊天头部、房间侧栏和主区工作流编辑

### 11.1 App/ThreadShell 主内容模式

在现有 `App.tsx` 或 `ThreadShell.tsx` 中增加最小状态：

```ts
type RoomMainMode = "chat" | "workflow_editor";
```

规则：

- 模式属于当前打开的房间视图，不产生新会话。
- 切换房间时默认回到 chat，或按明确产品规则恢复。
- 离开有脏数据的编辑器必须确认。
- 浏览器刷新后仍以服务器 draft/active 版本为准。

不要为此引入新的全局状态库。

### 11.2 恢复正式聊天头部

当前 `App.tsx` 向 `ThreadShell` 传入 `showHeader={false}`，需要恢复正式头部。

头部至少显示：

- 私聊：真实 Agent 头像、名称、简介入口。
- 房间：组合头像、房间名、目标摘要。
- 房间上下文开关。
- 返回聊天/退出工作流编辑按钮。
- 窄屏导航按钮。

### 11.3 RoomContextPanel 只保留摘要

修改 `webui/src/components/room/RoomContextPanel.tsx`：

- 房间目标。
- 成员列表。
- 当前工作流摘要。
- 当前/最近运行摘要。
- 最近 Artifact 摘要。
- “编辑工作流”入口。

移除窄侧栏中的完整 `WorkflowEditor`。

### 11.4 主区 WorkflowEditor

复用现有 `WorkflowPanel` 的 API、push 事件和命令，不复制请求逻辑。

编辑器顺序：

1. 房间和工作流目标。
2. 触发方式：手动/定时。
3. 纵向步骤卡片。
4. 保存草稿、激活版本、试运行/运行。

每个 Agent 步骤：

- Agent。
- 任务。
- 期望输出。
- 执行关系。

依赖交互不要强迫普通用户编辑 step ID。推荐提供：

- 接在上一步之后。
- 与上一步并行。
- 在选定步骤全部完成后执行。

底层仍只保存现有 `dependsOn`，不要增加冗余 `parallel_group` 真相源。并行层可以从 DAG 推导。

Approval 步骤：

- 显示用户实际需要确认的内容。
- 明确其后续步骤。
- 保存前验证不能成为无意义的孤立步骤。

定时触发：

- 常用模式优先，例如每天、工作日、每周。
- 高级用户才展开 Cron 表达式。
- 后端仍保存现有 `WorkflowTrigger`。

### 11.5 退出标准

- 侧栏不承载复杂表单。
- 无画布即可创建串行、并行和审批流程。
- 可配置手动和定时触发。
- 编辑器退出有脏数据确认。
- 保存、激活和运行仍使用原 WorkflowStore/Runner。

---

## 12. 阶段 C5：Workflow Artifact、创建流程和端到端闭环

### 12.1 Artifact 数据契约

必须建立结构化来源：

```text
Agent tool result
  -> AgentJob.artifacts
  -> StepRun.output.artifacts
  -> WorkflowRun
  -> room message/run card/context panel
```

建议在 `AgentJob` 增加向后兼容字段：

```python
artifacts: list[str] = []
```

要求：

- `deliver_file` 或其他受控产物工具在成功时记录规范化 Artifact 引用。
- 引用必须位于允许的 workspace/shared output 内。
- 记录创建 Agent、room_id、job_id、workflow_run_id、workflow_step_id。
- WorkflowRunner 从最终 AgentJob 复制 Artifact，不解析自然语言回复。
- 旧 Job/Run 缺少字段时按空数组读取。
- 失败不能删除已产生的 Artifact。

禁止通过“运行前后扫描目录差异”长期推断 Artifact 归属，这在并行工作流中会产生错误归属。

### 12.2 Approval 的准确边界

当前 Approval 是可靠的编排门，但不是所有外部副作用的通用授权令牌。

多 Agent V1 当前两个专业 Agent 的 allowlist 不应包含发布、交易、删除等高风险工具。因此：

- V1 将 Workflow Approval 定义为业务流程确认门。
- 当前专业 Agent 继续禁止高风险外部动作。
- 在未来 Agent Package 获得外部发布/交易工具之前，必须新增“审批结果与具体 ToolContext/动作绑定”的授权机制。
- 在该机制完成前，文档和 UI 不得宣称“任何高风险动作都绝不可能绕过审批”。

### 12.3 创建房间

修改：

- `webui/src/components/shell/ConversationDialogs.tsx`
- `webui/src/App.tsx`
- `mona/channels/websocket.py`

要求：

- goal 前后端都必填，只有迁移读取旧房间时允许为空。
- Mona 在 UI 中固定选中、不可取消；后端继续兜底插入。
- 至少选择一个专业 Agent。
- 标题可自动生成，但用户可编辑。
- 请求中禁止重复提交。
- 创建错误显示在对话框中，保留已填数据并允许重试。
- 关闭脏表单需要确认。

### 12.4 端到端场景

必须跑通：

1. 新建 Mona 会话。
2. 新建 A 股分析师私聊并验证回答作者不是 Mona。
3. 新建包含 Mona、A 股分析师、小红书运营的房间。
4. 房间输入 `@A股分析师`，只创建正确目标 AgentJob。
5. 普通房间消息由 Mona 响应。
6. Mona 使用 `delegate_agent` 创建临时任务，结果回到原房间并再次唤醒 Mona。
7. 创建包含并行 Agent 步骤和 Approval 的工作流。
8. 保存草稿、激活、运行、批准和完成。
9. 运行卡显示真实 Artifact。
10. 应用重启后房间、Job、运行和审批仍可查看或恢复。
11. Agent A 创建的 Skill 对 Agent B 和 Mona 不可见。

### 12.5 退出标准

- 第 12.4 节全部通过。
- 后端、前端和持久化数据中的 Agent/room/job/run/artifact ID 一致。
- 不需要通过日志或文件系统手工证明成功。

---

## 13. 测试与发布门槛

### 13.1 多 Agent 后端定向测试

在仓库根目录执行：

```powershell
.\.venv\Scripts\python.exe -m pytest -q `
  tests/test_multi_agent_phase2c.py `
  tests/test_multi_agent_phase3.py `
  tests/test_multi_agent_phase4.py `
  tests/channels/test_websocket_room_mentions.py `
  tests/agent/test_partner_unavailable.py `
  tests/agent/test_skill_tools_agent_scope.py `
  tests/session/test_im_session_summary.py `
  tests/webui/test_sidebar_state_v2.py `
  tests/channels/test_im_session_list_api.py
```

当前基线：151 passed。后续不得下降。

### 13.2 必须补充的后端测试

- 真实 built-in manifest + package Skill。
- Agent 私聊使用 manifest model。
- Agent 卸载后不回退 Mona。
- 空 goal 创建房间被拒绝。
- AgentJob Artifact 进入 StepRun。
- 并行 Job 的 Artifact 不串房间、不串步骤。
- cron 工作流的会话摘要状态。
- 旧 Job/WorkflowRun schema 向后兼容。

### 13.3 前端专项测试

在 `webui/` 执行：

```powershell
npm test -- `
  src/tests/workflow.test.tsx `
  src/tests/useSidebarState.test.ts `
  src/tests/useSessions.test.tsx `
  src/tests/api.test.ts
```

并新增：

- `session-list-model.test.ts`
- `ChatList` 最终信息结构测试。
- `SessionListPanel` 常驻搜索测试。
- `AppRail` 未读/审批去重角标测试。
- 正式聊天头部身份测试。
- RoomContextPanel 摘要测试。
- 主区 WorkflowEditor 触发方式、并行和脏数据测试。
- NewRoomDialog 必填、Mona 固定和失败重试测试。

### 13.4 全量前端检查

```powershell
npm test
npm run build
```

当前完整测试存在：

- `src/tests/app-layout.test.tsx` 的 noVNC 测试环境错误。
- `src/tests/i18n.test.tsx` 的设置导航/中文文案断言失败。

正式交付前必须修复或以有证据的方式调整测试，不能忽略失败。

### 13.5 lint 现状

当前 `npm run lint` 是无效脚本：仓库没有 ESLint 依赖和配置。

默认建议：本轮先以 TypeScript build、Vitest 和现有 UI debt 检查作为门槛，不为多 Agent 收口单独引入整套 lint 依赖。若团队决定 lint 是正式仓库门槛，则一次性补齐兼容的 ESLint 依赖、配置和 CI，不能只保留一个永远失败的脚本。

Python 侧必须修复新增测试中的 Ruff E402，再运行相关生产代码和测试检查。

### 13.6 人工验收

自动化通过后，至少验证：

- 1920×1080 浅色和深色。
- 1366×768。
- 小于 1024px 的 Sheet/Drawer。
- 100%、125%、150% 缩放。
- 三类会话混排。
- 500 条会话和长标题/长 preview。
- 房间并行运行、审批和 Artifact。
- 断网、Agent 不可用、创建失败和服务重启。

保留截图或录屏作为交接证据。

---

## 14. 股票六 Agent 的进入条件

只有以下通用能力完成后才开始股票模块：

1. Agent Package Skill 端到端闭环。
2. Workflow Artifact 结构化闭环。
3. 主区工作流编辑与运行卡完成。
4. 通用多 Agent E2E 通过。

### 14.1 先补三个通用扩展

#### Agent visibility

`AgentDefinition` 增加：

```python
visibility: Literal["partner", "internal"] = "partner"
```

要求：

- Registry 加载两类 Agent。
- `/api/agents` 返回 visibility。
- 全局伙伴列表和新建私聊过滤 internal。
- 股票研究房间成员、工作流和运行记录可以显示属于该房间的 internal Agent。
- 权限校验不能因为 UI 隐藏而减弱。

#### WorkflowRun inputs

增加不可变运行输入：

```python
inputs: dict[str, JSONValue] = {}
```

要求：

- 创建运行时保存快照。
- 股票代码、运行日期和分析范围作为 inputs。
- 模型只能读取，不能修改原输入。
- 旧 WorkflowRun 缺少字段时兼容空对象。

#### 结构化步骤输出

在现有 `StepRun.output` 上扩展，不创建股票专用消息协议。

至少支持：

- summary
- artifacts
- typed structured payload
- source IDs
- data timestamp

### 14.2 六个 Agent 必须是真实 Agent

创建六个 `visibility=internal` 的 manifest、Prompt、专属 Skill 和最小工具白名单：

- 技术分析
- 基本面分析
- 新闻/情绪分析
- 多方研究员
- 空方研究员
- 主席/裁决员

要求：

- 每个角色有独立 agent_id、Memory 和 Skill。
- `can_delegate=false`。
- 所有执行产生真实 AgentJob。
- 默认六 Agent 工作流只产生一个 WorkflowRun。
- 第一版固定一轮辩论，不实现循环引擎。
- 股票模块不直接调用 ProviderRegistry 顺序执行六次模型。

### 14.3 股票模块退出标准

- 全局伙伴只显示 A 股分析师，不显示六个 internal Agent。
- 股票研究房间显示六个团队内置角色。
- 一次深度投研产生六个真实 AgentJob。
- 最终报告能追溯到 inputs、来源、每个结构化观点和 Artifact。
- 六个 Agent 的 Memory/Skill 不互相读取。
- 手动、定时和 Mona 委派复用同一套 WorkflowRunner/AgentJob。

---

## 15. Agent Package 与商店的后续开发边界

V1 稳定后再实施。正式结构应调整为：

```text
~/.mona/packages/<package_id>/<version>/
  package.json
  agents/<agent_id>/agent.json
  agents/<agent_id>/prompt.md
  agents/<agent_id>/skills/...

~/.mona/agents/<agent_id>/
  memory/
  skills/
  config.json
```

Package 阶段需要实现：

- 安全下载和大小限制。
- 固定官方源、包大小和文件哈希校验。
- 安全解压和路径穿越防护。
- manifest/schema 校验。
- 权限差异确认。
- 原子安装和版本切换。
- 升级失败保留上一版本。
- 卸载产品文件但保留用户数据策略。
- entitlement 缓存、过期和离线行为。
- 一个商品包含一个 partner Agent 和多个 internal Agent。
- 正在运行的 Job 固定使用启动时 Package 版本。

不要把支付、订单逻辑写进 AgentRunner。官网负责商品、订单和授权，本地负责授权校验、包下载、安装和运行门控。

---

## 16. 多 Agent V1 完成定义

只有以下项目全部满足，才可以将多 Agent V1 标记为完成：

### 16.1 版本与文档

- [ ] 当前修复全部进入可追溯提交。
- [ ] 临时脚本和目录未进入功能提交。
- [ ] 功能设计、开发指南、IM 计划、本文已纳入版本管理。
- [ ] 文档勾选与真实代码一致。

### 16.2 Agent 执行

- [ ] Mona、A 股分析师、小红书运营使用正确身份和作者 ID。
- [ ] 专业 Agent 不可用时不回退 Mona。
- [ ] manifest model 实际生效。
- [ ] 专业 Agent 工具表不含委派工具。

### 16.3 Memory 与 Skill

- [ ] 每个 Agent 只读取自己的 Memory。
- [ ] 真实 Package Skill 可发现和读取。
- [ ] 两个内置 Agent 各有至少一个专属 Skill。
- [ ] Agent 自建 Skill 可在后续运行使用。
- [ ] A Agent 的 Skill 对 B Agent 和 Mona 不可见。
- [ ] Skill usage、archive 和 lock 不跨 Agent。

### 16.4 房间与委派

- [ ] 私聊和房间在一个会话列表。
- [ ] 房间 goal 必填，Mona 固定成员。
- [ ] `@Agent` 使用结构化 ID 并验证成员。
- [ ] Mona 可创建持久化临时 AgentJob。
- [ ] Job 结果回原房间并使用真实 Agent 作者。
- [ ] Job 取消、失败、迟到结果和重启恢复正确。

### 16.5 工作流

- [ ] 每房间只有一个当前工作流。
- [ ] 编辑器位于主区，侧栏只显示摘要。
- [ ] 无画布可配置手动/定时、串行/并行、审批。
- [ ] 运行使用不可变版本快照。
- [ ] 取消、失败、审批、重复点击和恢复正确。
- [ ] AgentJob Artifact 进入 StepRun 并在原房间展示。
- [ ] 不创建额外工作流会话。

### 16.6 IM

- [ ] 常驻搜索框。
- [ ] 连续混排列表。
- [ ] 所有会话有正确头像、标题、最新 preview 和时间。
- [ ] 未读和待审批状态可靠并持久化。
- [ ] AppRail 消息角标按会话去重。
- [ ] 正式聊天头部显示真实身份。
- [ ] 桌面、窄屏、主题和缩放人工验收通过。

### 16.7 质量门槛

- [ ] 多 Agent 后端定向测试全部通过且不少于当前 151 项。
- [ ] 前端专项测试全部通过。
- [ ] 前端完整测试零失败。
- [ ] 生产构建通过。
- [ ] 无失效的必跑命令。
- [ ] 第 12.4 节 E2E 完整通过。
- [ ] 已知 P0/P1 缺陷为零。

---

## 17. 开发交接时必须提供

每个完成阶段应交付：

1. 提交列表和变更文件列表。
2. 数据模型/API 变更说明。
3. 旧数据迁移与回滚说明。
4. 测试命令和原始结果摘要。
5. 未完成项和已知问题。
6. 涉及 UI 时提供目标分辨率截图。
7. 涉及持久化时提供重启前后验证结果。
8. 涉及隔离时提供跨 Agent 负向测试结果。

如果某项未验证，必须明确写“未验证”和原因，不能用“应该可以”代替。
