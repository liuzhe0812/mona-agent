# Mona Agent 与会话一体化管理开发计划

> 文档版本：1.0  
> 状态：已执行（2026-08-17）  
> 制定日期：2026-08-17  
> 适用范围：WebUI、Gateway、Agent Runtime  
> 相关文档：[多 Agent 功能设计](../design/multi-agent-functional-design.md)、[多 Agent 开发指南](../design/multi-agent-development-guide.md)、[IM UI 交互开发计划](./im-ui-interaction-dev-plan.md)

## 1. 文档目的

把当前独立且内容偏薄的“伙伴”模块，与会话管理合并为一个以 Agent 为主语的工作入口，并补齐 Agent 的个性、运行配置、记忆、权限和专属 Skill 管理能力。

本计划覆盖已确认的 1—5 项：

1. 会话列表按 Agent 分组，房间单独分组。
2. 移除独立“伙伴”入口，在主内容区完成 Agent 管理。
3. 增加用户级 Agent 配置，并在运行时统一解析生效。
4. 补齐记忆、权限、数据和生命周期管理。
5. 开放 Agent 指令文件与专属 Skill 管理，并支持通过 AI 对话安全安装 Skill。

本文档取代《IM UI 交互开发计划》中“伙伴独立页面”和“会话统一平铺”相关设计；房间、项目、置顶、归档等其他约定继续有效。

## 2. 结论与设计原则

### 2.1 结论

“伙伴管理 + 会话管理”合并是当前架构下更合适的方向，但不应做成无限层级的资源树。左侧列表负责“找 Agent、找会话”，主内容区负责“使用 Agent、管理 Agent”。

推荐结构：

```text
搜索 Agent / 会话                                  ＋

置顶
  A股分析师 · 茅台估值复盘

⌄ Mona                                      3
  产品方案讨论
  周报整理

⌄ A股分析师                                  1
  茅台估值复盘
  新能源行业跟踪

› 小红书运营

⌄ 房间                                       2
  投资研究组
  内容策划组

归档
```

- Agent 头像和名称只出现在分组头，不在每条直属会话中重复。
- 点击 Agent 头像或名称进入管理页；点击会话进入聊天。
- Agent 分组中的 `＋` 创建该 Agent 的新直属会话。
- 没有会话的 Agent 仍显示，避免“已安装但找不到”。
- 房间单独分组，避免一个多 Agent 房间被重复挂到多个 Agent 下。
- 置顶会话从原分组提升到全局置顶区，并保留小型 Agent 身份标识。
- 项目不增加第三层树结构；会话行显示弱化的项目标签，列表顶部提供项目筛选。

### 2.2 基本边界

每类信息只保留一个来源：

| 信息 | 来源 | 是否可由用户修改 |
|---|---|---|
| Agent 包声明、版本、最大能力边界 | `AgentDefinition` / Agent 包 | 否 |
| 显示名、头像、启用状态、模型覆盖、能力收窄 | `AgentUserConfig` | 是 |
| 人格、行为规则、用户偏好、长期记忆 | Agent 私有 Markdown 文件 | 是 |
| 具体任务上下文 | 会话或房间 | 是 |
| 权限上限与安全策略 | 平台策略与 Agent 包声明 | 否，只能由用户进一步收窄 |
| 专属能力 | Agent 私有 Skill 目录 | 是，需经过校验和授权 |

不做以下设计：

- 不把 API Key 复制到每个 Agent 配置中；Agent 只引用全局模型和连接配置。
- 不提供任意路径文件编辑器；只允许访问白名单文件和目标 Agent 的私有目录。
- 不自动把 Skill 申请的工具加入 Agent 权限。
- 不建立通用插件市场、签名中心或复杂工作流引擎；本期只完成本地 Agent 管理闭环。
- 不把 Agent、项目、会话做成三层常驻树。

## 3. 当前实现基线

现有代码已经具备大部分底层能力，应直接复用：

| 能力 | 当前实现 | 本计划处理 |
|---|---|---|
| Agent 定义与发现 | `mona/agent/partners.py` 中的 `AgentDefinition`、`AgentRegistry` | 保持定义只读，新增用户覆盖层 |
| 直属会话与房间元数据 | `ConversationMetadata` | 继续作为会话归属来源，不迁移历史会话 |
| Agent 私有上下文 | `mona/agent/context.py` | 继续加载私有指令、记忆和 Skill |
| 指令和记忆文件 | `~/.mona/agents/<agent_id>/memory/` | 增加 UI、历史、回滚和写入保护 |
| 文件历史 | `mona/agent/memory.py` 中的 `GitStore` | 直接用于版本历史和回滚 |
| Skill 加载优先级 | `mona/agent/skills.py` | 保持“私有 > Agent 包 > 平台内置” |
| Skill 使用、置顶、归档 | `mona/agent/skill_usage.py` | 扩展来源信息，不新建第二套台账 |
| Agent 私有 Skill 创建 | `mona/agent/tools/skill_tools.py` | 改为通过统一管理服务校验；对话创建先生成提案 |
| 会话列表 | `webui/src/components/ChatList.tsx` | 改成按 Agent 分组的统一入口 |
| 独立伙伴页面 | `webui/src/components/shell/PartnersView.tsx` | 能力迁移后删除独立入口 |
| Agent 列表接口 | `mona/channels/websocket.py` 的 `/api/agents` | 扩展摘要，增加详情和管理接口 |

已确认的缺口：

- `/api/agents` 当前只返回摘要，`enabled` 仍是固定值。
- 前端 Agent 数据为一次性缓存，配置改变后不能主动刷新。
- `PartnerAgentLoop` 尚未接入每个 Agent 的禁用 Skill 配置。
- 指令文件存在，但没有用户管理界面和受保护的 AI 修改流程。
- 当前 Skill 创建工具会直接写入目标目录，没有暂存、差异预览和用户批准。
- Skill 脚本可以运行，但当前执行方式不构成强隔离环境，因此外部脚本不能默认启用。

## 4. 目标信息架构

### 4.1 左侧统一列表

列表分为四个固定区域：

1. 搜索与新建。
2. 全局置顶会话。
3. 可见 Agent 及其直属会话。
4. 房间与归档。

Agent 分组头包含：

- 头像、名称、启用状态。
- 未读数量或运行状态。
- 展开/折叠按钮。
- 新建直属会话按钮。
- 更多菜单：管理、启用/停用、查看数据；可卸载 Agent 再显示“卸载”。

只把 `visibility=partner` 的 Agent 放入全局 Agent 列表。房间内部的临时或内部 Agent 只在房间上下文中展示。

搜索规则：

- 同时匹配 Agent 名称、描述、会话标题和项目标签。
- 搜索结果允许临时平铺，但每条会话必须显示所属 Agent 或房间。
- 清空搜索后恢复分组和折叠状态。

### 4.2 主内容区状态

主内容区只保留三种一级状态：

| 左侧选择 | 主内容区 |
|---|---|
| Agent 分组头 | Agent 管理页 |
| 直属会话 | 单 Agent 对话页 |
| 房间 | 多 Agent 房间页 |

Agent 管理页包含五个页签：

1. **概览**：显示名、头像、描述、启用状态、来源和版本。
2. **个性与规则**：`SOUL.md`、`AGENTS.md`、`USER.md`、`MEMORY.md`。
3. **模型与运行**：模型预设、推理强度和必要的高级参数。
4. **能力与权限**：工具、委派、外部连接引用及其实际生效范围。
5. **Skills 与数据**：Skill 来源、启停、归档、导入、导出，以及记忆数据操作。

技术字段默认折叠。界面优先使用用户能理解的名称，不直接暴露目录、内部 ID 和完整运行参数。

## 5. 数据与运行模型

### 5.1 保持 `AgentDefinition` 不可变

Agent 包内的声明继续作为能力上限和默认值，不允许用户直接改写：

- `id`
- 包来源和版本
- 默认 prompt
- 默认模型
- `tool_allowlist`
- 是否允许委派
- 包内 Skills
- 可见性

对于包提供的 Agent，`prompt.md` 只读；用户创建的 Agent 后续可单独支持编辑基础 prompt，但不属于本期必需范围。

### 5.2 新增 `AgentUserConfig`

每个 Agent 使用一个小型 JSON 覆盖文件：

```text
~/.mona/agents/<agent_id>/config.json
```

建议最小结构：

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "enabled": true,
  "displayName": "A股分析师",
  "avatar": null,
  "modelPreset": null,
  "reasoningEffort": null,
  "temperature": null,
  "maxTokens": null,
  "grantedTools": null,
  "disabledSkills": [],
  "delegationEnabled": true,
  "updatedAt": "2026-08-17T00:00:00Z"
}
```

约束：

- `revision` 用于乐观并发控制，避免两个页面互相覆盖。
- 缺少配置文件时等价于当前行为，首次修改时再创建。
- `grantedTools: null` 表示继承 Agent 包允许的工具，空数组才表示全部关闭。
- 写入使用临时文件加原子替换，避免中途退出造成损坏。
- API 只接受已声明字段；未知字段、非法模型、非法工具和越界数值直接拒绝。
- 停用 Agent 不删除会话、记忆或 Skills，只禁止新任务进入。
- Mona 可以停用非核心能力，但不能被卸载。

### 5.3 统一解析实际配置

新增一个具体的配置解析器，供 API、会话创建和 `PartnerAgentLoop` 共用，不增加单实现接口或工厂。

```text
实际显示信息 = 用户覆盖值 ?? AgentDefinition 默认值

实际模型 = Agent 用户覆盖
        ?? AgentDefinition 默认模型
        ?? 全局默认模型预设

实际工具 = 平台安全允许集合
        ∩ AgentDefinition 声明上限
        ∩（用户授予集合 ?? AgentDefinition 声明上限）

实际委派 = AgentDefinition 允许
        ∩ 用户未关闭

实际 Skills = 私有 + Agent 包 + 平台内置 - disabledSkills
```

用户配置只能收窄包声明和平台安全边界，不能通过修改 JSON 扩权。配置在下一轮对话或新建运行上下文时生效，不回写历史消息。

## 6. 指令文件与记忆设计

### 6.1 文件职责

当前架构中没有单数形式的 `agent.md`。应沿用已经存在的文件，而不是再增加同义配置：

| 文件 | 用途 | 默认 AI 写入策略 |
|---|---|---|
| `SOUL.md` | 人格、价值取向、表达风格 | 生成修改提案，用户批准后写入 |
| `AGENTS.md` | 工作原则、执行规则、协作边界 | 生成修改提案，用户批准后写入 |
| `USER.md` | 对当前用户的稳定认知与偏好 | 生成修改提案，用户批准后写入 |
| `MEMORY.md` | Agent 长期记忆 | 保持现有受控自动维护能力，用户可查看和回滚 |

原始 Markdown 是唯一事实来源。UI 提供编辑器、预览、保存、版本历史、差异对比和回滚，不再建立一套字段化人格模型与 Markdown 双向同步。

### 6.2 写入规则

- 用户在管理页手动保存：校验后直接写入并记录版本。
- 用户要求 AI 优化人格或规则：AI 只能提交差异提案，不能直接覆盖受保护文件。
- `MEMORY.md` 继续允许现有记忆工具维护，但每次修改必须进入 `GitStore` 历史。
- 所有文件接口使用枚举键，不接受客户端传入路径。
- 限制单文件大小、编码和可写文件名；使用 UTF-8 与原子写入。
- 恢复历史版本也是一次新提交，不能破坏既有历史。

## 7. Skill 管理与对话安装设计

### 7.1 Skill 来源和权限

管理页统一显示三类 Skill：

| 来源 | 位置 | 用户操作 |
|---|---|---|
| Agent 私有 | `~/.mona/agents/<agent_id>/skills/` | 查看、创建、导入、更新、归档、恢复、导出、启停 |
| Agent 包内 | Agent 包的 `skills/` | 查看、启停，不可改写 |
| 平台内置 | Mona 内置 Skills | 查看、启停，不可改写 |

继续沿用“Agent 私有 > Agent 包 > 平台内置”的加载优先级。发生同名覆盖时必须显示来源和冲突警告，不允许静默替换。

兼容 [Agent Skills 规范](https://agentskills.io/specification)：Skill 目录必须包含带 `name` 和 `description` 的 `SKILL.md`，可选 `scripts/`、`references/` 和 `assets/`。工具声明仅表示需求，不代表获得权限。

### 7.2 单一 `SkillManager`

在现有 `SkillsLoader`、`skill_usage` 和 Skill 工具之上增加一个具体服务，供 UI 与 AI 工具共用：

- 列出和查看 Skill。
- 校验目录与 `SKILL.md`。
- 暂存创建、导入或更新内容。
- 激活、归档、恢复和导出私有 Skill。
- 更新现有使用台账中的来源、版本和哈希。
- 触发 Agent Skill 缓存失效和前端刷新事件。

不创建新的仓库抽象或第二套 Skill 数据库。现有 `.usage.json` 增补以下可选字段即可：

- `origin`
- `source`
- `version`
- `contentHash`
- `installedAt`
- `approvedAt`

### 7.3 AI 对话安装流程

AI 不能把内容直接写入正式 Skill 目录。正常对话中的创建、导入和更新统一走以下流程：

```mermaid
flowchart LR
    A["用户要求 Agent 安装或创建 Skill"] --> B["从运行上下文确定目标 Agent"]
    B --> C["写入该 Agent 的 .staging/request_id"]
    C --> D["结构、安全、权限与冲突校验"]
    D -->|失败| E["返回问题，不改变正式目录"]
    D -->|通过| F["生成安装提案与差异预览"]
    F --> G{"用户批准？"}
    G -->|否| H["删除暂存并记录拒绝"]
    G -->|是| I["原子移动到 skills/name"]
    I --> J["更新来源台账并刷新 Agent"]
```

目标目录固定为：

```text
~/.mona/agents/<当前执行 agent_id>/skills/<skill_name>/
```

模型侧工具不接受 `target_agent_id`。目标 Agent 必须从可信的 `ToolContext` 得到，避免通过提示词向其他 Agent 目录写入。跨 Agent 安装只能由用户在界面明确选择目标并再次批准。

暂存目录：

```text
~/.mona/agents/<agent_id>/skills/.staging/<request_id>/
```

激活前至少校验：

- Skill 名称、目录层级和 `SKILL.md` frontmatter。
- 路径穿越、绝对路径、符号链接和非法文件名。
- 文件数量、单文件大小、总大小和内容哈希。
- 同名私有 Skill、包内 Skill和平台 Skill 冲突。
- 声明的工具是否在 Agent 实际权限范围内。
- 是否包含脚本、二进制、依赖安装或网络访问需求。
- 更新已有 Skill 时的内容差异与来源变化。

外部来源内容与 AI 生成内容必须区分：

- AI 生成：模型在暂存区生成 `SKILL.md` 和必要资源。
- 文件、URL 或目录导入：系统保留原始字节、来源和哈希，模型不得悄悄改写。
- 更新：必须展示差异，不直接覆盖。

包含脚本的外部 Skill 默认禁用脚本能力。本期不承诺强沙箱；只有用户看过脚本风险并批准，且 Agent 已有对应工具权限时才可启用。Skill 安装永远不能自动授予工具、连接或密钥。

### 7.4 统一变更提案

`SOUL.md`、`AGENTS.md`、`USER.md` 的 AI 修改和 Skill 安装共用一个最小持久化提案模型，避免出现两套审批状态机：

```text
AgentChangeProposal
  id
  agentId
  kind: instruction_patch | skill_install
  status: pending | approved | rejected | expired
  token
  expectedRevision
  preview
  stagedPath?
  createdAt
  expiresAt
  resolvedAt?
```

实现要求：

- 提案持久化，应用重启后仍可处理。
- 批准使用一次性随机 token 和预期版本，重复请求保持幂等。
- 批准前正式文件和正式 Skill 目录必须保持不变。
- 过期、拒绝或校验失败时清理暂存内容。
- 可以复用现有工作流批准中的 token、版本检查和交互卡片模式，但不依赖 `WorkflowRun` 实体。

## 8. API 与事件

Agent 配置属于 CRUD 管理，使用认证后的 HTTP API；聊天、房间和实时状态继续使用现有 WebSocket。建议最小接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/agents` | Agent 摘要、启用状态、来源、版本和配置 revision |
| `GET` | `/api/agents/{id}` | Agent 定义、用户配置和实际生效配置 |
| `PATCH` | `/api/agents/{id}/config` | 更新允许的用户配置，携带 `expectedRevision` |
| `GET` | `/api/agents/{id}/instructions` | 返回四个指令/记忆文件摘要 |
| `GET/PUT` | `/api/agents/{id}/instructions/{key}` | 读取或手动保存白名单文件 |
| `GET` | `/api/agents/{id}/instructions/{key}/history` | 查看版本历史 |
| `POST` | `/api/agents/{id}/instructions/{key}/restore` | 恢复指定版本 |
| `GET` | `/api/agents/{id}/skills` | 返回三类 Skill、来源、状态和兼容性 |
| `POST` | `/api/agents/{id}/skills/stage` | 用户界面导入或更新 Skill 并生成提案 |
| `PATCH` | `/api/agents/{id}/skills/{name}` | 启停、归档或恢复私有 Skill |
| `GET` | `/api/agent-change-proposals/{id}` | 获取提案和差异 |
| `POST` | `/api/agent-change-proposals/{id}/resolve` | 批准或拒绝提案 |

约束：

- `{id}` 和 `{name}` 必须经过注册表与安全名称校验。
- 指令接口的 `{key}` 只允许 `soul`、`agents`、`user`、`memory`。
- 返回实际权限时同时返回来源，前端能解释“为何不可启用”。
- 会话数量、未读数和项目标签优先由已有会话状态派生，不复制进 Agent 配置。

新增实时事件：

- `agents_updated`
- `agent_instructions_updated`
- `agent_skills_updated`
- `agent_change_proposal_created`
- `agent_change_proposal_resolved`

前端收到事件后只失效对应 Agent 缓存，不进行全应用刷新。

## 9. 五阶段实施计划

### 阶段 1：Agent 分组会话列表

**目标**：用户在列表中立即知道正在与哪个 Agent 对话。

工作项：

- 将直属会话按 `directAgentId` 分组。
- 使用 Agent 分组头展示头像、名称、状态、未读数和操作。
- 房间保留独立分组，归档保留独立入口。
- 全局置顶保留 Agent 身份标识；避免原分组重复出现。
- 支持无会话 Agent、折叠状态、跨 Agent 搜索和项目筛选。
- 保留现有重命名、置顶、归档、删除和可见数量限制。

验收：

- 任意直属会话都能从列表直接识别所属 Agent。
- 同一 Agent 的会话行不重复显示相同头像。
- 房间不会同时出现在多个 Agent 分组。
- 旧会话没有合法 `directAgentId` 时归入 Mona，行为与当前兼容。

### 阶段 2：Agent 管理主界面

**目标**：删除薄弱的独立伙伴模块，让 Agent 分组成为管理入口。

工作项：

- 点击 Agent 分组头打开主内容区管理页。
- 实现概览页与五个页签的框架，先接只读数据。
- 把“开始直属会话”“创建房间”等现有动作迁入新入口。
- 移除 `AppRail` 中独立伙伴入口；待能力迁移完成后删除 `PartnersView`。
- 处理窄屏返回、键盘导航、焦点状态和国际化文案。

验收：

- 不进入独立页面即可找到、使用和管理 Agent。
- Agent、直属会话、房间三种选择不会互相覆盖当前状态。
- 原伙伴页已有动作全部有新入口。

### 阶段 3：Agent 用户配置与运行时生效

**目标**：让显示、模型和能力收窄配置真正持久化并进入运行时。

工作项：

- 实现 `AgentUserConfig` 的读取、校验、原子写入和 revision 检查。
- 实现统一实际配置解析器。
- 扩展 `/api/agents`，新增详情和配置更新 API。
- 把 `enabled`、模型覆盖、工具授权、委派开关和 `disabledSkills` 接入 `PartnerAgentLoop`。
- 替换前端一次性 Agent 缓存，接入精准失效事件。
- 管理页接入概览、模型与运行、能力与权限设置。

验收：

- 修改配置并重启 Mona 后仍保留。
- 配置在下一次运行上下文中生效。
- 用户无法通过配置突破平台或 Agent 包的能力上限。
- revision 冲突不会静默覆盖其他页面的修改。

### 阶段 4：记忆、权限、数据与生命周期

**目标**：让用户能解释和控制 Agent 保存了什么、能做什么、停用后保留什么。

工作项：

- 展示实际工具权限、限制来源和外部连接引用。
- 展示记忆摘要、最后更新时间、历史数量和磁盘占用。
- 提供记忆查看、导出、清空与恢复确认。
- 提供 Agent 停用和可卸载 Agent 的卸载流程；默认保留会话和用户数据。
- 卸载时将“Agent 包”和“Agent 私有数据”作为不同目标明确展示。
- 为 Mona 设置不可卸载约束。

验收：

- 用户能知道一项能力来自平台、Agent 包还是自己的授权。
- 停用 Agent 后历史会话仍可阅读，不能发起新运行。
- 清空或卸载等高影响操作必须二次确认并说明可恢复性。

### 阶段 5：个性文件、专属 Skill 与对话安装

**目标**：形成 Agent 可自定义、可学习、可审计且不会越权的私有工作区。

工作项：

1. 接入四个 Markdown 文件的编辑、预览、历史、差异和回滚。
2. 对 AI 修改受保护文件增加变更提案。
3. 实现 `SkillManager`，把加载、校验、归档和来源台账统一在现有实现之上。
4. 在管理页支持私有 Skill 创建、导入、更新、启停、归档、恢复和导出。
5. 将模型可见的 Skill 创建/安装工具改为“暂存并提案”。
6. 实现批准卡片、一次性 token、版本检查、原子激活和实时刷新。
7. 增加跨 Agent 隔离、脚本风险和同名冲突防护。

验收：

- 用户可以直接编辑自己的 `SOUL.md`、`AGENTS.md`、`USER.md` 和 `MEMORY.md`，并回滚历史。
- AI 未经批准不能改写前三个受保护文件。
- 在 A Agent 对话中创建的 Skill 只进入 A 的私有目录，B 不可见。
- 批准前、拒绝后和校验失败时，正式 Skill 目录均不改变。
- Skill 声明新工具不会自动获得权限。
- 包含脚本或冲突的 Skill 会明确提示风险，不能静默启用或覆盖。

## 10. 迁移与兼容策略

- 不迁移、不重写现有会话和房间数据。
- 没有 `AgentUserConfig` 的 Agent 使用当前定义和全局默认值。
- 已存在的私有记忆、历史和 Skill 目录原地复用。
- 已存在但来源不明的 Skill 标记为 `unknown`，不编造来源；用户后续可确认。
- 新增的折叠状态采用兼容字段，默认展开 Mona、当前 Agent 和存在未读的 Agent。
- 旧的独立伙伴路由先保留一次版本跳转，稳定后再删除。
- 如果 Agent 包目录与用户私有数据目录重叠，加载器必须按已解析的包 Skill 路径排除，防止把包内 Skill 误标为用户私有 Skill；不在没有可靠来源时自动搬移文件。

## 11. 测试与验证

### 11.1 后端重点测试

- `AgentUserConfig` 默认值、字段校验、revision 冲突和原子写入。
- 实际模型、工具、委派和禁用 Skill 的交集解析。
- 未批准提案不修改文件；批准、拒绝、过期和重复提交保持正确。
- 指令文件白名单、大小限制、历史和回滚。
- Skill 路径穿越、符号链接、大小限制、哈希、同名冲突和非法 frontmatter。
- 对话工具只能写当前 `ToolContext.agent_id` 对应暂存目录。
- 私有、包内、平台 Skill 的来源、优先级和禁用行为。
- 旧 Agent、旧会话和来源未知 Skill 的兼容。

建议测试文件：

```text
tests/agent/test_agent_user_config.py
tests/agent/test_agent_effective_config.py
tests/agent/test_instruction_management.py
tests/agent/test_skill_manager.py
tests/agent/test_skill_install_approval.py
```

### 11.2 前端重点测试

- Agent 分组顺序、折叠、零会话、置顶、搜索和房间去重。
- Agent 分组头和会话行的键盘、焦点与窄屏行为。
- 配置表单脏状态、保存、revision 冲突和事件刷新。
- 指令编辑器、历史、差异和回滚。
- Skill 来源标识、可用操作、冲突和不兼容提示。
- 变更批准卡片的批准、拒绝、过期和重复点击。

建议测试文件：

```text
webui/src/components/shell/AgentSessionList.test.tsx
webui/src/components/shell/AgentManagementView.test.tsx
webui/src/components/agents/AgentInstructions.test.tsx
webui/src/components/agents/AgentSkills.test.tsx
webui/src/components/agents/AgentChangeApprovalCard.test.tsx
```

### 11.3 端到端场景

1. 修改 A股分析师的显示名和模型，重启后仍保留，下一次对话使用新配置。
2. 手动修改 `SOUL.md`，查看差异并恢复到上一版本。
3. 在 A股分析师对话中要求创建估值 Skill，批准后只在该 Agent 中生效。
4. 导入包含脚本的外部 Skill，确认默认不获得执行权限。
5. 停用 Agent，确认历史会话可读、不能继续发送、重新启用后恢复。

每阶段合并前至少执行：

```text
pytest <本阶段相关测试>
ruff check mona tests
cd webui
npm test
npm run lint
npm run build
```

## 12. 风险与控制

| 风险 | 控制措施 |
|---|---|
| Agent 多时列表变长 | 默认折叠低活跃 Agent，保留搜索、置顶和现有可见数量限制；只有出现性能数据后再加虚拟列表 |
| 分组弱化全局时间顺序 | 提供全局置顶、搜索和项目筛选，不增加常驻第三层树 |
| 配置展示与实际运行漂移 | 所有入口共用实际配置解析器，详情 API 同时返回默认值、覆盖值和最终值 |
| Agent 自我修改导致人格漂移 | 受保护文件采用差异提案、批准和版本历史 |
| 外部 Skill 带来供应链风险 | 暂存、来源、哈希、结构校验、脚本默认禁用、权限不自动扩大 |
| Agent 间数据串写 | 从可信运行上下文固定目标 Agent，API 和文件层同时校验目录边界 |
| 包内 Skill 被误判为私有 Skill | 依据 `ResolvedAgent` 的包路径分类并增加重叠目录回归测试 |
| 前端显示旧配置 | 实时事件按 Agent 失效缓存，revision 防止旧页面覆盖新值 |

## 13. 交付顺序与发布策略

阶段 1—3 构成首个可发布闭环：用户能识别 Agent、进入管理页并修改真实生效的基本配置。阶段 4—5 在此基础上增加高风险数据操作和 AI 自修改能力。

每阶段单独合并、可独立回退：

```text
阶段 1：只改变列表组织
阶段 2：迁移管理入口
阶段 3：配置持久化并接入运行时
阶段 4：开放数据和生命周期操作
阶段 5：开放个性文件与安全 Skill 安装
```

旧伙伴入口只在阶段 2 功能迁移并验证后移除；对话内直接写 Skill 只在阶段 5 的暂存、批准、原子激活全部完成后切换，避免出现半套安全流程。

## 14. 完成定义

以下条件全部满足，计划才视为完成：

- 会话列表能清楚表达“哪个 Agent、哪些会话、哪些房间”。
- 独立伙伴入口已移除，原能力没有丢失。
- Agent 用户配置持久化、可校验、可解释，并真实进入运行时。
- 用户能管理 Agent 的记忆、权限、数据和生命周期。
- 四个指令/记忆文件可编辑、可查看历史、可回滚。
- 私有、包内、平台 Skill 来源明确，操作权限正确。
- AI 创建或安装 Skill 必须经过目标隔离、暂存校验、差异预览和用户批准。
- Skill 不会自动获得工具、连接或密钥权限。
- 旧会话、旧 Agent 数据和现有 Skill 可继续使用。
- 后端测试、前端测试、lint 和构建全部通过。
