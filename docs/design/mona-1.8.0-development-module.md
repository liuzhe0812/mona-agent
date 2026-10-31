# Mona 1.8.0 开发模块设计方案

> 实施责任更新（2026-09-28，用户确认）：工作台、内置Coding、三家CLI接入、跨引擎协作及最终联合验收由同一主任务统一负责；不再以另一CLI任务未交付作为当前责任边界。仍保留工作台、执行器和供应商协议的技术分层，不改全局导航。详细当前状态见 `docs/plans/development-1.8.0-workbench-closeout.md`；后文早期的独立任务分工只作为历史背景，不表示限制统一负责人修改适配代码。

- 状态：Target / Delivery Design
- 版本：1.8.0
- 文档类型：产品与技术一体化交付设计
- 适用范围：桌面端开发模块、内置 Coding Agent、Codex / Claude Code / CodeBuddy 原生执行器接入、跨执行者协作
- 目标读者：产品、前端、Tauri、Gateway、Agent Runtime、测试与发布人员
- 设计原则：参考 Pi coding-agent 的“默认能力越少越强”，参考 Cindy 的“多原生执行器统一会话与交接”，但不复制其产品形态
- 非目标：本版本不建设完整 IDE，不建设复杂共享长期记忆，不自动解决同项目多会话之间的代码冲突

---

## 0. 最新确认：供应商优先的模型体系

用户已确认优先参考 Cindy 的模型供应商设置和模型选择器，再继续开发工作台整体交互。本节替代此前将多个执行者设置表单直接作为用户主入口的安排；不改变底层 Executor、Provider、Session 的独立职责。

- 固定来源为 Mona AI、OpenAI、Anthropic；其他已添加供应商各保留自己的身份，不按模型名称猜测归属。
- 设置页采用左侧供应商列表、右侧连接与模型管理。自供模型在 Mona AI 内展示，不因模型品牌归入其他来源。
- 自动检测本机 Codex / Claude Code，将结果归入 OpenAI / Anthropic；连接供应商不要求先创建开发项目，不自动登录、安装或发送任务。
- 添加入口按供应商进入连接步骤；官方浏览器授权与 API Key 入口由真实接入能力决定。不把未实现的授权按钮当成已交付功能。
- 普通对话和开发模块复用同一 ModelSelector：顶部搜索、左侧收藏/全部/来源、右侧模型、底部添加入口。主入口不要求依次填写执行程序路径、环境变量和模型。
- 来源、模型、实际执行路由保持独立；同名模型的 API、原生执行者及不同用户来源不能相互替换凭据或会话。选择原生模型仍使用原生执行器，不回落到 Mona 模型 API 冒充。
- 模型列表默认只展示名称、真实能力信息和可见性；类型修正、默认模型及生成配置通过“分别调整”进入，保留已有能力。
- 收藏和顺序属于展示偏好；模型可见性不表示撤销授权，也不能终止正在执行的会话。刷新目录保留用户明确隐藏的已有模型。
- 开发任务中真正跨执行者的选择提示交接边界；同引擎普通模型切换不显示无条件“内容丢失”的警告。

最新落地与验证边界见 `docs/plans/development-1.8.0-model-sources-acceptance.md`。

## 0.1 最新确认：单主会话开发工作台

用户已明确取消多屏方案。开发模块只采用项目/会话树和一个中央主会话；标题栏的任务概览浮卡与工作侧栏均按需打开，Mona 全局导航保持不变。项目下多个任务仍可后台并行，但不再提供分屏或平铺会话入口。

新建入口直接打开项目的新任务草稿页并聚焦输入框，首次发送时创建正式开发会话；仅打开草稿页不创建空会话、不启动模型或 CLI，不再弹出任务命名或执行引擎选择表单。旧会话与后台任务保留；未发送草稿的文字、附件引用、渠道、模型与推理强度按项目持久保存，重载窗口后仍可找回。新草稿沿用该项目当前会话已确认的渠道、模型与推理强度，首次使用则采用已配置默认来源。用户只在统一的渠道/模型选择器中选择，执行方式由所选条目的实际路由决定，不按模型名字推断，也不再要求额外选择 Mona Coding、Codex 或 Claude Code。失败不自动切换来源。

首次提交在创建前保存稳定请求身份与当时的文字、附件引用和模型选择。未确认结果时可继续原提交，或明确放弃本次提交；之后编辑的新草稿独立保留。放弃先由服务端封存原身份，未确认期间只核对放弃，不再恢复为发送；已接收的任务和已创建会话保留，不假称停止或撤回。相同创建请求只返回同一会话，已删除会话不因旧请求重试复活；参数不一致时由服务端明确区分本次拒绝与原提交事实，前端不能自行换 ID。

右侧标签栏的加号紧邻最后一个标签，空闲空间留在加号与右侧放大/收起控件之间；标签过多时滚动标签区，加号与右侧控件仍可见。

标题栏的任务概览按钮按需打开浮卡，默认关闭，不占用永久右列；浮卡整合项目、Git、模型状态、任务计划（存在时）、子智能体、项目规则与 Skills。工作侧栏默认收起；“新标签页”默认显示浏览器起始页，也可关闭，访问网页后显示网页标题和 favicon；关闭全部标签页自动收起侧栏，再次打开时恢复起始标签。首页与加号工具菜单只列审查、终端、辅助对话和文件。子智能体配置从概览的配置图标进入；关闭页签或收起侧栏不停止任务或终端进程。Git 操作使用独立悬浮入口。会话正文和真实工具活动参考用户提供的 Zcode 截图，采用紧凑、低装饰呈现；不生成虚假的测试成功、提交或进度。

当前执行引擎就是主负责人，不额外调用 Mona 模型转述。子智能体是项目级可编辑配置，职责、引擎、模型来源、只读范围与启用状态显式保存，按需创建独立子会话。Codex/Claude 连接由另一任务处理，本轮 UI 改造不更改认证与供应商配置链路。

子智能体设置以紧凑列表展示已保存配置，支持创建、编辑、启停和删除。描述用于主引擎判断何时调用，执行指令用于约束子任务；不显示静态解释副标题，也不提供手动派发入口。每轮主任务以用户运行上下文接收已启用配置的名称、描述和只读权限，Mona 的上下文压缩保留本轮目录；原生引擎通过同一宿主工具按配置 ID 自主派发。子任务只接收自己的目标和执行指令，不再递归委派。旧配置未填写描述时使用原职责描述，原执行指令保持可用。

会话内容与原生工具过程使用明确身份关联；标题栏概览浮卡与工作标签只承担观察和交互，不因关闭视图结束任务。差异审查必须携带明确文件范围、实际差异和版本，派发前发现变化须重新确认，不能用文件级问答替代对所选差异的审查。当前原型对齐、事件观察和版本化审查的实现及验收边界见 `docs/plans/development-1.8.0-prototype-alignment-acceptance.md`。

Git“提交或推送”的弹窗布局、暂存范围开关、键盘选择和分支下拉按本地 ZCode 源码对齐。提交信息留空或点击生成按钮时，使用当前模型只读生成；提交、提交并推送、推送均为实际 Git 操作。关闭“包含未暂存的更改”时只提交暂存版本，使用临时 index 保留工作区内容和其他暂存；提交并推送在同一持久记录内顺序执行，后半段失败不重做提交。单独推送先展示目标及领先/落后状态并确认；只推送绑定的提交，禁止强制覆盖。分支下拉提供当前标记、搜索、创建、Git 图谱和切换受阻后的提交并切换流程。图谱支持历史分页、提交信息和逐文件差异。关闭视图不结束操作，不确定结果不重放。

任务概览的 Git 区域按“更改及增删统计、分支下拉、提交或推送”三行呈现。更改直接打开差异侧栏，分支下拉提供搜索、切换和创建入口；分支写操作沿用持久记录和结果核对，不重复执行结果未知的请求。此区域不再显示模型、轮次状态或耗时，项目标题和其他概览区块保留。

Git 环境由读写入口共用检测：优先寻找系统 PATH，再补查 Windows 常见全局和当前用户安装目录，并实际验证 `git --version`。缺少或无法运行 Git、非仓库、仓库无变更和状态查询失败分别呈现；不能把不可用显示成零修改。缺失时保留文件编辑、开发会话及原有操作记录，禁用 Git 写操作，提供安装说明、官方安装页和显式重新检测；不自动下载、安装 Git 或修改系统 PATH。已知缺失不持续轮询，重新检测清除短期探测缓存；仅新 PATH 尚未进入进程时才需要正常重开应用。详见 `docs/plans/development-1.8.0-git-environment-acceptance.md`。

子智能体结果回传与主会话处理是两件事：回传本身不自动唤醒已结束的主任务。子智能体区域只读展示任务摘要、列表和详情，已移除手动调用与接续按钮。已有结果处理接口先只读核对是否已接收，再确认当前渠道和模型；主任务运行时通过既有后续消息队列接续，主任务未知时禁止新增执行。服务端从原会话提取准确结果与来源，不接受前端编造的结果正文，不依赖最近三条消息。相同结果始终对应同一个处理请求，响应丢失、重挂载、重启、取消或失败都不自动重跑；原输入草稿保留。内置与原生主负责人复用各自既有发送路径，不能借此声称原生 CLI 的自动委派协议已完成。实现及验证见 `docs/plans/development-1.8.0-result-follow-up-acceptance.md`。

## 1. 版本定位

Mona 1.8.0 新增独立“开发”模块，把 Mona 从通用 Agent 工作台扩展为可持续进行真实软件开发的 Agent 开发工作台。

用户进入开发模块后，应能在一个产品界面中完成：

1. 打开或创建一个本地项目；
2. 创建多个持续开发会话；
3. 选择渠道和模型，由其实际路由使用 Mona Coding、Codex、Claude Code 或 CodeBuddy；
4. 查看执行过程、文件变化、命令结果和验证状态；
5. 在不中断任务的前提下切换项目会话和右侧工作面板；
6. 按需引入其他执行者协作、审查或接力；
7. 在应用重启、执行者重启或会话切换后继续工作；
8. 最终得到可解释、可验证、可继续修改的代码结果。

开发模块不是“给普通聊天加几个代码工具”，也不是“把三个 CLI 终端嵌进 Mona”。

目标形态是：

> 一个精简但完整的内置 Coding Agent + 三个可直接担任主执行者或协作者的原生 CLI Agent + 一个统一管理项目、会话、执行状态和开发产物的工作台。

---

## 2. 已确定的产品决策

以下决策属于 1.8.0 基线，不在实现阶段重新讨论。

| 决策项 | 最终结论 |
|---|---|
| 产品形态 | 导航中增加独立“开发”模块 |
| 页面布局 | 项目/会话树与中央唯一主会话；标题栏概览浮卡和工作侧栏按需打开 |
| 多会话显示 | 单主会话，彻底移除多屏入口；多个任务可在后台并行 |
| 多桌面窗口 | 数据模型与视图状态解耦，为后续独立桌面窗口复用做准备；1.8.0 不建设复杂窗口管理系统 |
| 开发 Agent | 内置 Mona Coding，重点参考 Pi coding-agent 的设计哲学 |
| 默认工具 | 只保留开发必需能力；通用 Mona 工具不默认进入 Coding Agent |
| 记忆 | 做减法；默认依赖项目、项目规则、项目 Skills、当前会话，不加载通用用户长期记忆 |
| 外部执行者 | Codex、Claude Code、CodeBuddy 均可做主执行者，也可做协作者 |
| 外部执行机制 | 使用原生 Agent 接口，不把它们降级为“只调用对应模型” |
| CLI 原生能力 | 保留其原生 Agent 循环和必要内置开发能力 |
| 项目规则 | 四个执行者共用同一项目规则来源 |
| 项目 Skills | 四个执行者共用同一项目 Skill 来源 |
| 用户级配置 | 不自动加载用户级行为配置、用户级 Skills、私有长期记忆 |
| MCP / Hooks | 不启用外部 CLI 用户或项目自定义 MCP、Hooks；不能因兼容模式静默打开 |
| 同项目多会话 | 任意 Agent 可以创建多个会话并同时工作 |
| 并发冲突 | 不做项目级单写锁、不强制工作树、不替用户解决不同会话之间的代码冲突 |
| 协作 | 按需发生，不要求每个任务先规划、派工、审查 |
| 完整 IDE | 不在 1.8.0 实现调试器、完整 LSP、扩展市场等 IDE 全量能力 |

---

## 3. 成功标准

### 3.1 用户成功标准

一个用户只通过开发模块就能完成一个真实项目任务，并具备以下体验：

- 不需要复制提示词到外部 Codex / Claude Code / CodeBuddy；
- 不需要手工搬运协作者之间的上下文；
- 不需要为了查看另一个任务而停止当前任务；
- 不需要理解每个 CLI 不同的底层会话 ID；
- 不需要因为切换执行者而重新解释整个项目；
- 不会因为折叠面板、切换会话或切换模块而丢任务；
- 能明确知道“谁正在做什么、改了什么、验证过什么、现在是否还在运行”。

### 3.2 工程成功标准

1. 内置 Coding Agent 不依赖普通 Mona 的完整 ContextBuilder 装配；
2. 外部执行器不经过 Mona 内置模型二次转述普通用户请求；
3. 三家 CLI 均具备结构化会话、状态、事件、取消、恢复或明确的能力降级；
4. 项目规则与项目 Skills 有单一事实来源；
5. 用户级 MCP、Hooks、用户记忆不会被意外注入外部执行器；
6. 会话、运行、原生执行者绑定和 UI 视图具有稳定 ID；
7. 重启恢复不会重放结果未知的写入操作；
8. 同一异步事件不会串到错误会话、项目或工作标签；
9. 任务“完成”必须来自真实执行与验证结果，不来自进程退出或自然语言猜测。

---

## 4. 核心业务对象

### 4.1 Project

项目代表一个用户选择的本地开发目录。

项目记录至少包含：

- projectId；
- 显示名称；
- 根目录真实路径；
- Git 仓库信息（如存在）；
- 默认分支 / 当前工作目录信息；
- 项目规则入口；
- 项目 Skills 根目录；
- 最近打开时间；
- 是否仍可访问；
- 项目级执行器兼容状态。

项目不是会话。一个项目可以长期存在并承载多个开发会话。

### 4.2 Development Session

左侧“任务”本质上就是一条持续开发会话。

每条会话至少记录：

- sessionId；
- projectId；
- 标题；
- 当前主执行者；
- 当前模型选择；
- 当前运行状态；
- 最近活动时间；
- 是否置顶 / 归档；
- 原生执行器绑定集合；
- 会话消息历史；
- 本会话派生的协作子任务；
- 本会话 UI 状态引用；
- 最近一次可靠验证摘要。

一条会话可以完成多轮工作，不因一次任务结束而销毁。

### 4.3 Executor

执行者表示“由哪套 Agent 执行开发”。

1. Mona Coding
2. Codex
3. Claude Code
4. CodeBuddy

执行者与模型必须分开。

例如：

- 执行者：Codex
- 模型：gpt-5.x-codex

不能把“Codex”只作为 Mona Coding 的模型选项，否则失去 Codex 原生 Agent 的工具、线程和执行语义。

### 4.4 Native Session Binding

每个开发会话可保存多个执行者的原生会话绑定。

字段至少包含：

- bindingId；
- developmentSessionId；
- executorId；
- nativeSessionId / threadId；
- nativeSessionCapabilitySnapshot；
- workingDirectory；
- createdAt；
- lastUsedAt；
- state：active / parked / unavailable / stale；
- lastKnownUsage；
- compatibilityVersion。

同一开发会话从 Codex 切到 CodeBuddy 后，Codex 绑定应进入 parked，而不是删除。

用户以后切回 Codex，优先恢复原线程。

### 4.5 Run

Run 表示一次具体执行轮次，而不是整个会话。

至少包括：

- runId；
- sessionId；
- executorId；
- nativeBindingId；
- 用户请求；
- acceptedAt；
- startedAt；
- finishedAt；
- 状态；
- 输入队列；
- 工具/命令事件；
- 用户确认项；
- 结果；
- 变更引用；
- 验证证据；
- error / unknown reason。

### 4.6 Collaboration Task

协作子任务表示主会话向其他执行者派发的一个明确任务。

至少包含：

- taskId；
- parentSessionId；
- parentRunId；
- assignedExecutor；
- assignedNativeSession；
- task；
- expectedOutput；
- dependencies；
- status；
- result；
- artifacts；
- validationEvidence。

协作子任务不要求用户创建“房间”。

### 4.7 View

视图只保存 UI 状态，不拥有执行状态。

包括：

- viewId；
- 当前项目及其选中的 developmentSessionId；
- 每个会话的滚动位置与输入草稿；
- 右栏折叠状态；
- 右栏当前 tab；
- 当前放大状态。

关闭 view 不结束 session，也不结束 run。

---

## 5. 页面信息架构

## 5.1 全局导航

主导航增加“开发”。

入口进入项目选择或最近使用项目。

如果上次存在已打开的开发工作台，则恢复上一次开发 UI 状态，但不得因为恢复 UI 自动重放任务。

### 5.2 首次进入开发模块

无项目时展示：

- 打开本地项目；
- 最近项目；
- 项目不可访问状态；
- 执行器安装与认证状态提示。

打开项目后显示项目/会话列表和中央主会话；概览浮卡和工作侧栏按需打开。

---

## 6. 左侧：任务列表

### 6.1 结构

顶部：

- 当前项目名称；
- 项目切换；
- 新建任务；
- 任务搜索。

列表按活跃、置顶、普通、归档组织。

项目名和任务名默认占满行内可用宽度，右侧操作按钮仅在悬停、键盘焦点或菜单打开时覆盖显示，不预留按钮占位。名称右侧使用渐隐遮罩；长名称在悬停或键盘焦点时缓慢往返滚动，滚动距离包含按钮遮盖区域，移开后回到开头。短名称保持静止，系统减少动画设置下不自动滚动。侧栏调整宽度、窗口缩放或名称变化后重新测量。

归档只作用于单个任务。项目更多菜单提供“查看归档任务”，不提供归档项目或批量归档项目内任务的入口；无论当前任务列表是否为空，都可进入。选择后，该项目原任务列表切换为归档任务视图，顶部显示“归档任务”和“返回任务列表”；其他项目保持原视图。归档任务仍可打开、恢复或永久删除。移除项目只隐藏项目入口，不删除本地文件或任务记录，重新打开同一目录可恢复。

每项显示：

- 会话标题；
- 主执行者图标；
- 状态点；
- 最近更新时间；
- 待用户操作标记；
- 完成未读标记。

### 6.2 会话操作

支持：

- 新建任务；
- 重命名；
- 置顶；
- 归档（不因任务运行状态禁用）；
- 删除会话；
- 在中央主会话区打开；
- 复制项目路径 / 会话链接（如产品有内部 deeplink）。

永久删除按会话 ID 执行，一并删除父子会话记录；运行中、排队中、等待确认、状态 unknown 或旧 revision 不阻止删除。后端取消该会话的执行与待发输入，并阻止迟到保存重建会话记录。执行者或终端清理失败、超时不撤销删除；必须保留必要资源身份并明确告警，不影响其他任务，也不删除项目文件。

### 6.3 多会话原则

同一个项目允许：

- 多个 Mona Coding 会话；
- 多个 Codex 会话；
- 多个 Claude Code 会话；
- 多个 CodeBuddy 会话；
- 混合执行者并行。

系统不因为同一 projectId 就阻止第二个会话执行。

如果多个会话编辑同一个文件，属于用户并行开发行为，本版本不增加全局锁和自动仲裁。

但系统自己的写操作仍必须遵守每个工具既有的文件当前状态检查，不能用明显过期快照静默覆盖文件。

---

## 7. 中间：开发会话区域

### 7.1 会话顶部

标题栏左侧显示当前会话标题；项目列表展开时，收起按钮位于项目侧栏顶部、添加项目按钮右侧，中央标题栏不重复显示。项目列表收起后，展开按钮显示在中央标题栏左侧。右侧提供更多菜单和任务概览按钮。工作侧栏收起时，右侧显示打开按钮及其分隔线；展开后两者隐藏，由工作侧栏顶部的收起按钮关闭侧栏。当前渠道与模型通过统一的单模型选择器选择，所选条目的实际路由决定执行者，不再分别选择执行者和模型。

更多菜单目前提供重命名、置顶/取消置顶、归档/恢复、复制会话标题、复制项目路径和打开侧边聊天。

标题栏的更多操作左侧提供彩色项目快捷打开按钮：主按钮在系统资源管理器中打开当前项目，箭头下拉只列“资源管理器”和“终端”。终端启动本机独立系统终端，以当前项目目录作为工作目录；快捷打开不切换工作侧栏或会话，失败通过现有操作弹窗说明原因和下一步。

### 7.2 消息区

消息区展示：

- 用户消息；
- Agent 正文；
- reasoning / thinking 的产品化摘要（遵循现有产品策略，不暴露内部链式思维）；
- 文件读取；
- 文件修改；
- 命令运行；
- 浏览器验证；
- 外部 Agent 原生事件；
- 等待确认；
- 协作者活动；
- 验证结果；
- 最终结果。

工具细节默认压缩展示，用户可展开。

事件展示必须经过统一语义映射，不直接把三家供应商的内部 event name 暴露给用户。

### 7.3 输入框

开发主会话、新任务和侧边聊天共用普通会话的 `ThreadComposer`，统一输入框外观、多行自动高度、用户发送快捷键、停止按钮和待发送队列交互。三者只共享输入 UI，执行调度与数据存储仍由各自模块负责。

当前开发接口支持文本和项目文件引用。普通会话的图片、文档上传能力尚未接入时，隐藏附件入口；不显示不可用的发送选项。输入框保持简短提示，不提供“补充当前任务”下拉，也不放实现说明式的长占位文案。

### 7.4 运行中输入语义

普通会话和开发会话沿用相同的待发送队列交互，并准确显示服务端确认的状态：

- 运行中的输入默认作为 `follow_up` 排队，当前 Run 结束后发送；
- Mona Coding 可在队列条目上选择“追加”，将该条输入作为 `steering` 送入当前运行；
- Codex 具有原生 `steering` 能力时，队列条目显示“引导”，绑定原 Run 和原生 turn；目标结束或变化时拒绝，不新建轮次。回执未知保留原请求，核对只读取记录，不重发。
- 不支持 `steering` 的原生 CLI 不显示“追加”操作；
- 编辑或撤回队列条目以服务端确认成功为准。失败时保留原内容和请求标识，不得换新请求重复执行。
- 另有执行者明确接受运行中输入、输入被拒绝或连接状态未知时，分别显示真实的 `steering`、`rejected` 或 `unknown` 状态；不能把派发成功当成执行者已接受。

输入框和队列 UI 共用不改变各执行者的调度协议、会话存储或能力边界。

沙箱审批卡显示在输入区，摘要面板不重复显示。审批期间保留输入草稿和附件；子任务审批使用子任务所属会话与原确认 ID。“允许类似命令”仅在 Codex 给出合法命令前缀时显示，并交给原生权限协议处理。

---

## 8. 单主会话与工作标签

中央始终只展示一个主会话。左侧按项目展开对应会话，点击会话切换中央内容；后台执行不随视图切换而取消。项目和会话的绑定必须准确，不能使用当前已选项目替代被点击会话的真实项目。

会话草稿、文件编辑缓冲区、滚动位置与工作标签各自隔离。用户阅读历史时，流式内容不能强制滚回底部；用户回到最新消息后再自动跟随。

任务概览按需打开，默认关闭，不占用永久右列；工作侧栏也默认收起。打开或关闭概览、工作标签和侧栏不会改变中央单主会话，也不会结束 Run。

工作侧栏默认收起；收起时由会话标题栏的打开按钮展开，展开后由右侧栏顶部的收起按钮关闭。新标签页默认显示浏览器起始页，首页和加号菜单只提供审查、终端、辅助对话和文件。子智能体配置从概览的配置图标进入。侧栏支持放大/还原，单个标签可以关闭；关闭标签或收起侧栏不会停止开发任务或终端进程。查看子智能体会话时，它显示在右侧，不替换中央主会话。

整个应用退出后的行为由实际后台运行能力决定，不承诺不存在的后台常驻。

---

## 9. 任务概览与工作侧栏

标题栏分别提供任务概览和工作侧栏开关。概览是按需显示的浮卡，默认关闭，不占用永久右列；工作侧栏默认收起，可独立展开、放大/还原或收起。

### 9.1 任务概览浮卡

浮卡整合当前项目、Git、模型状态、任务计划（存在时）、子智能体、项目规则与 Skills：

- 项目；
- Git 分支与工作区状态；
- 当前渠道、模型及其执行路由状态；
- 当前任务计划（存在时）；
- 子智能体配置与会话；
- 项目规则与 Skills。

只显示实际状态，不推断变更归属。

例如，差异来自当前 Git 工作区时，应标为“工作区变更”，不能标为某个执行者的修改。

### 9.2 工作侧栏

工作侧栏展开时，右栏顶部提供收起控件；会话标题栏只在侧栏收起时显示 SquarePlus 打开按钮，并隐藏其前的分隔线。

“新标签页”默认显示浏览器起始页，可直接输入 URL 或搜索。其首页与加号菜单只提供以下按需打开的工具入口：

- 审查；
- 终端；
- 辅助对话；
- 文件。

子智能体配置从任务概览的配置图标进入；点击任务摘要打开“子智能体”标签，列表按进行中、完成、未完成分组，完成任务按结束时间倒序排列；点击记录进入只读详情，并可返回列表。页签可关闭，侧栏可放大/还原或收起；关闭页签、收起侧栏不会停止任务或终端进程。

这些操作只改变 UI 状态，不改变任务归属。

---

## 10. 审查面板

### 10.1 默认能力

审查面板首先是“真实变更查看器”，不是自动模型审查器。

提供：

- 文件变更列表；
- Git diff；
- 未跟踪文件；
- 当前分支；
- 提交记录；
- 变更统计；
- 本会话报告过的修改活动。

### 10.2 变更归属

本版本不建设复杂的跨会话文件归因系统。

必须区分：

- **工作区真实变更**：当前目录相对 Git 基准的事实；
- **本会话活动记录**：该执行者明确执行过的写文件和命令。

如果不能证明某个 diff 由当前会话独占产生，就不显示“由 XX Agent 修改”。

### 10.3 Agent 审查

用户可选择：

- 当前执行者审查；
- 指定另一个执行者审查；
- 只读审查。

只读审查必须在执行环境层限制写入能力，不能只靠提示词要求“不修改”。

审查结果绑定具体代码状态，例如：

- commit SHA；
- diff hash；
- 文件内容 hash；
- 或明确的工作区 snapshot id。

代码变化后，旧审查显示“基于旧版本”，不能继续作为当前代码已审查的证据。

---

## 11. 文件面板

文件列表与编辑器采用同一区域的两级切换：默认显示完整文件列表，打开文件后进入占满侧栏主体的编辑视图，顶部提供“返回”按钮。返回恢复原目录和列表滚动位置，保留未保存草稿；再次打开同一文件继续编辑原草稿。列表与编辑器不再上下同时展示。

文件列表不显示目录标题栏，子目录首行提供“返回上一级”。文件和目录右键菜单可打开、复制相对或完整路径，并在桌面端的资源管理器中显示；仅文件提供“使用系统应用打开”和引用到当前会话。系统应用打开磁盘中的已保存文件，不写入编辑草稿。链接不允许打开或在资源管理器中显示。

文件列表不显示刷新按钮，编辑器不显示保存和重新读取按钮；用户使用 Ctrl/Cmd+S 显式保存。编辑器按文件类型和当前深浅主题显示语法颜色。

支持：

- 文件树；
- 文件搜索；
- 文本查看；
- 基本文本编辑；
- diff 查看；
- 打开到外部编辑器（如已有能力）；
- 引用文件到当前会话。

不在 1.8.0 建设：

- 完整 IDE 语言服务；
- 重型代码导航；
- 完整调试器；
- 扩展市场。

文件保存仍需遵守基本并发正确性：如果当前编辑缓冲区所基于的文件已发生变化，应提示用户，不得静默覆盖。

这属于单次编辑安全，不属于“系统替用户协调多 Agent”。

---

## 12. 终端面板

复用 Mona 现有本地终端能力。

### 12.1 用户终端与 Agent 执行日志分离

用户打开的终端是可交互 shell。

Agent 的命令执行展示是运行事件。

两者不应混成同一 xterm 历史，否则用户无法判断：

- 哪些命令是自己输入；
- 哪些命令是 Agent 执行；
- 哪个进程属于哪个任务。

### 12.2 长进程

开发服务器、watcher 等长进程必须具有稳定运行记录。

隐藏面板不停止进程。

“Agent Run 已停止”不等于其历史命令产生的所有子进程已经停止，除非实际执行层确认。

---

## 13. 浏览器面板

复用已有浏览器基础设施，用于：

- 本地 Web 应用预览；
- URL 验证；
- 截图与视觉检查；
- 用户手动调试。

新标签页默认显示浏览器起始页，可直接输入 URL 或搜索；浏览器沿用现有宿主和页面身份。原页面已经不存在时不自动创建替代页，页面导航也不自动关联 Agent。开发地址栏提供扩展程序和浏览器选项入口：扩展由用户显式选择本地解压目录后安装，并可列举、启停和移除；不自动安装、不提供商店下载或完整 Chrome 扩展界面。浏览器选项复用查找、打印、缩放、下载、历史与清理浏览数据，增加截图和设备尺寸；不提供 Cookie 或密码导入。

内置 Coding Agent 的浏览器开发验证能力按需加载。

外部 CLI 不因为右侧有浏览器面板就自动获得 Mona 的 browser tool。

如果某执行者自身具备浏览器能力，使用其原生能力；如果不具备，则可由 Mona 宿主提供一个明确的验证协作任务，但不能偷偷通过 MCP 给外部 Agent 注入新工具。

---

## 14. 侧边聊天

侧边聊天解决“我想问代码问题，但不想打断正在运行的主任务”。

### 14.1 默认行为

- 使用内置 Mona Coding 的只读模式；
- 上下文来自用户选中的代码、diff、日志和必要会话摘要；
- 不自动继承主会话完整历史；
- 不允许修改项目；
- 不自动创建协作者；
- 不写入长期记忆。

### 14.2 回主会话

用户可以“加入主会话”。

此操作将选定结论写入主会话输入草稿，用户确认发送后才影响主任务。

不能后台静默将侧边聊天结论注入运行中的主执行者。

---

## 15. 内置 Mona Coding Agent

## 15.1 设计目标

重点参考 Pi coding-agent：

> 默认工具少、提示词短、项目上下文清晰、持续会话可靠；复杂能力按需扩展，而不是默认装满。

内置 Coding Agent 必须能在没有任何外部 CLI 的情况下独立完成常见开发任务。

### 15.2 默认能力

默认工具能力建议收敛为：

1. Read：读取文件和必要的二进制/图片信息；
2. Edit：精确修改现有文件；
3. Write：创建或明确覆盖文件；
4. Exec：运行命令、测试、构建、Git；
5. Find/Search：当现有 Read 无法高效定位时提供轻量搜索能力。

是否把 Find/Search 合并到 Read 工具内部属于实现问题，不作为产品概念暴露。

### 15.3 按需能力

可以按需加载：

- 浏览器验证；
- 图像读取；
- 外部执行者协作；
- 网络检索；
- 项目 Skill 配套脚本。

不默认加载：

- 邮件；
- 日历；
- Office；
- 股票；
- 通用数据库；
- 个人知识库；
- 其他与开发无关的 Mona 工具。

### 15.4 系统提示词

固定系统提示词只包含：

- 开发 Agent 身份；
- 当前项目范围；
- 使用实际工具完成任务；
- 尊重用户现有改动；
- 基于真实命令和文件状态判断成功；
- 不虚报执行结果；
- 用户明确要求以外不做不必要操作。

不默认加入：

- 通用 Mona 人格；
- 生活助手职责；
- 用户画像；
- “必须先规划”；
- “必须多 Agent 审查”；
- “必须生成开发文档”；
- 大量框架知识。

### 15.5 Context Builder

必须设计开发专用装配路径，不能直接沿用当前通用 ContextBuilder 的全部行为。

开发上下文默认仅由以下部分组成：

1. Coding Agent 固定 system；
2. 当前项目规则摘要 / 入口；
3. 当前项目 Skill 索引；
4. 当前开发会话；
5. 必要的 session compaction；
6. 当前用户请求；
7. 当前活动 UI 引用（文件、diff、图片等）；
8. 当前已授权工具契约。

明确排除：

- SOUL.md；
- USER.md；
- 用户画像；
-普通 Mona 私有长期 Memory；
- 跨项目近期历史；
- 普通 Mona 的 always-on Skills；
- 无关工具描述。

### 15.6 项目上下文

项目事实优先通过当前文件读取。

长期工程决定优先进入：

- AGENTS.md；
- 项目 docs；
- 明确的项目 Skill。

不新增一个自动“猜项目”的大型记忆数据库作为 1.8.0 前置条件。

### 15.7 会话压缩

上下文压缩必须保留。

压缩摘要至少保留：

- 用户当前目标；
- 明确约束；
- 已做决定；
- 已修改文件；
- 已运行命令；
- 测试结果；
- 当前错误；
- 未完成事项；
- 下一步线索。

原始会话历史仍持久化，不因压缩被删除。

### 15.8 长结果

命令输出、测试日志、工具结果超过上下文预算时：

- 全文持久化；
- 模型获得明确的摘要和引用；
- 可按行或字符窗口继续读取；
- 不能只给一个无法继续读取的截断字符串。

---

## 16. 外部执行者统一抽象

不要求三个 CLI 内部一致，但 Mona 需要一个稳定的宿主契约。

每个 Executor Adapter 最少实现以下能力：

| 能力 | 语义 |
|---|---|
| probe | 检查安装、版本、认证、可用能力 |
| create_session | 创建原生会话 |
| resume_session | 恢复原生会话；不支持时明确返回 unsupported |
| send | 发送新一轮用户请求 |
| steer | 运行中追加输入；不支持则返回 queued/unsupported |
| interrupt | 请求中断当前 Run |
| close_runtime | 释放本地执行资源，不等于删除会话 |
| get_status | 获取可证明的当前状态 |
| list_models | 返回该执行器可选模型 |
| capabilities | 返回当前版本支持的能力 |
| normalize_event | 将原生事件映射为 Mona 统一事件 |
| apply_project_context | 以受控方式提供项目规则与 Skills |

Adapter 不负责修改业务会话 UI，也不直接写产品数据库。

---

## 17. Codex 接入

### 17.1 主路径

使用官方 Codex App Server。

目标能力：

- thread start；
- thread resume；
- turn start；
- turn steer / follow-up；
- turn interrupt；
- 原生事件流；
- usage；
- approvals；
- model selection；
- working directory。

### 17.2 项目规则

统一项目规则以 Mona 项目来源为事实源。

适配时确保 Codex 读取与当前项目对应的 AGENTS.md 或受控投影。

不能为了兼容重复维护两份互相独立的规则正文。

### 17.3 Skills

项目 Skills 以 Mona 项目 Skill 来源为准。

如果 Codex 原生支持对应 Skill 发现方式，适配器生成兼容视图或受控路径映射。

Skill 正文仍按需加载，不把全部 Skill 内容塞到每个 turn。

### 17.4 禁止自动继承

不自动继承：

- 用户全局自定义 instructions；
- 用户全局 Skills；
- 用户 MCP；
- Hooks；
- 其他与项目无关的本地配置。

认证凭据、官方运行必需配置、模型选择不属于“行为上下文”，可以由运行层使用。

---

## 18. Claude Code 接入

### 18.1 主路径

使用官方 Claude Agent SDK。

优先选择与 Mona Python Gateway 最自然的 SDK 接入方式。

### 18.2 原生能力

保留：

- Claude Code 的原生 Agent 循环；
- 官方基础文件/命令能力；
- 原生 session；
- streaming；
- permission / approval；
- model selection。

### 18.3 项目配置隔离

明确配置 source，不依赖“CLI 默认会加载什么”。

目标只允许：

- 项目规则；
- 项目 Skills；
- 必要工作目录。

禁止自动装配：

- 用户全局 CLAUDE 配置；
- 用户全局 memory；
- 自定义 MCP；
- Hooks；
- Plugins。

如果某版本 SDK 无法细粒度满足该隔离要求，该版本不得进入 1.8.0 支持矩阵。

---

## 19. CodeBuddy 接入

### 19.1 首选主路径

优先评估官方 ACP。

原因：

- 面向宿主客户端；
- 更适合结构化会话和事件；
- 便于统一权限交互；
- 不需要模拟终端文本。

### 19.2 SDK 备选

如果当前稳定 ACP 无法满足以下任一关键要求，则在 D1 阶段切换为官方 SDK 主路径：

- 会话恢复；
- 取消；
- 结构化事件；
- 模型选择；
- 项目配置隔离；
- 权限确认；
- 工作目录。

最终生产只保留一条主路径。

### 19.3 项目资源隔离

由于 CodeBuddy 不同接入入口的默认配置加载行为可能不同，必须通过实际测试验证：

- 只加载项目规则；
- 只加载项目 Skills；
- 不加载用户级设置；
- 不加载用户 MCP；
- 不加载 Hooks；
- 不加载用户记忆。

不能以“文档说默认不加载”代替回归测试。

---

## 20. 执行者能力协商

不同执行器不能被假设为功能完全一致。

每个 native binding 创建时保存 capability snapshot，例如：

- supportsResume；
- supportsSteering；
- supportsInterrupt；
- supportsModelSwitch；
- supportsApproval；
- supportsUsage；
- supportsNativeSubagents；
- supportsProjectSkills；
- supportsRichEvents；
- supportsImageInput。

UI 根据能力显示或隐藏操作。

如果执行器升级后能力发生变化，重新 probe 并更新 snapshot。

不能调用一个当前执行器没声明支持的能力，然后通过 fallback 猜测成功。

---

## 21. 项目规则

### 21.1 单一事实来源

默认项目规则入口：

- 项目根目录 AGENTS.md；
- 目录层级 AGENTS.md（如未来需要）；
- docs 中被 AGENTS.md 明确引用的稳定设计文档。

不维护：

- Mona 专用 rules 正文；
- Codex 专用 rules 正文；
- Claude 专用 rules 正文；
- CodeBuddy 专用 rules 正文。

确实需要供应商兼容文件时，只作为自动生成投影。

### 21.2 冲突处理

若项目已有 CLAUDE.md、CODEBUDDY.md 等文件：

1. 默认不偷偷合并进统一项目规则；
2. UI 标记“发现供应商专属规则”；
3. 用户可以选择导入；
4. 导入后生成明确的项目级统一规则修改；
5. 不在后台维护多份同步副本。

---

## 22. 项目 Skills

### 22.1 统一目录

推荐项目 Skill 根目录：

`.agents/skills/`

每个 Skill 采用当前 Mona 可识别的 Skill 结构，并保持必要的引用、资源、脚本。

### 22.2 适配原则

共享的是：

- Skill 名称；
- 描述；
- 说明正文；
- 项目资源；
- 脚本入口。

不共享供应商特有工具名。

如果 Skill 中包含“调用某供应商独有工具”的硬编码，应标记兼容性。

### 22.3 禁止行为

扫描 Skill 时不得：

- 自动执行脚本；
- 自动启用 MCP；
- 自动安装插件；
- 自动读取用户 Home 目录中的关联配置。

---

## 23. 主执行者

每个开发会话有一个当前主执行者。

### 23.1 选择 Mona Coding

用户请求直接进入 Mona Coding。

### 23.2 选择 Codex / Claude / CodeBuddy

用户请求直接进入目标 native session。

普通 turn 不先经过 Mona Coding LLM。

Mona 宿主只做：

- 项目上下文准备；
- 认证与会话管理；
- 权限边界；
- 事件转发；
- UI 呈现；
- 持久化。

---

## 24. 协作

### 24.1 触发方式

协作可以由：

- 用户显式指定；
- 用户选择“让 XX 审查”；
- Mona Coding 根据任务需要调用协作能力。

不要求用户先创建 room。

### 24.2 典型模式

#### 实现 → 审查 → 修复

1. Codex 实现；
2. CodeBuddy 只读审查；
3. 审查结果返回主会话；
4. 原 Codex 会话继续修复；
5. 最终验证。

#### 并行研究

1. Mona Coding 分两个独立研究任务；
2. Claude Code 与 Codex 分别调查；
3. 不写代码或写不同区域；
4. 结果回主会话；
5. 主执行者作最终选择。

#### 执行者接力

1. Codex 已完成部分开发；
2. 用户切换到 CodeBuddy；
3. CodeBuddy 获得必要 handoff；
4. CodeBuddy 基于当前真实项目继续工作；
5. Codex 原生会话 parked，可稍后恢复。

### 24.3 不做的事

Mona 不自动认为“多 Agent 一定更好”。

简单任务默认一个执行者完成。

---

## 25. Handoff 交接包

执行者切换和协作必须使用有界、可复现的交接包。

交接内容至少包括：

1. 当前用户目标；
2. 成功标准；
3. 用户明确约束；
4. 项目规则入口；
5. 当前工作目录；
6. 已完成工作；
7. 未完成工作；
8. 修改文件清单；
9. 关键命令与结果；
10. 最近可靠验证；
11. 当前已知错误；
12. 需要接手者重点确认的问题；
13. 必要的最近对话；
14. 项目 Skills 索引。

不包含：

- 全部私有长期记忆；
- 全部项目历史会话；
- 其他执行者不可解释的内部思维；
- 密钥和凭据；
- 大量无关工具日志。

### 25.1 恢复优先

切回以前使用过的同一执行者：

1. 优先 resume 原生会话；
2. 补充其离开期间的 delta handoff；
3. resume 失败时创建新原生会话并使用 full handoff；
4. UI 标明发生了 fallback。

---

## 26. 外部执行者原生子 Agent

Codex / Claude / CodeBuddy 未来可能有自己的原生 subagent / team 能力。

本版原则：

- 允许它们内部使用自己默认的执行机制；
- Mona 可以展示其原生活动摘要；
- 不自动把内部 subagent 升格为 Mona 顶层协作者；
- 跨执行器协作由 Mona 统一管理；
- 不允许递归形成“外部 Agent 再要求 Mona 无限制派新 Agent”的失控链路。

---

## 27. 状态机

### 27.1 Run 状态

推荐状态：

- queued；
- preparing；
- running；
- waiting_user；
- interrupting；
- interrupted；
- succeeded；
- failed；
- unknown；
- recovering。

### 27.2 状态定义

**queued**

请求已保存，但执行者尚未接受。

**preparing**

启动进程、恢复线程、装载项目上下文。

**running**

执行者明确接受该 Run，并开始产生原生事件。

**waiting_user**

等待权限、确认、问题回答或认证。

**interrupting**

已请求停止，但尚未确认执行者结束。

**interrupted**

执行层确认该轮终止。

**succeeded**

执行者正常结束。注意：不等于用户目标全部验收通过。

**failed**

得到确定性失败结果。

**unknown**

连接丢失、宿主超时等情况下无法确认执行者真实状态。

**recovering**

Mona 正在重连并查询真实状态。

### 27.3 禁止状态推断

- 终端进程退出 0 ≠ 整个开发任务成功；
- 网络超时 ≠ Run 失败；
- UI 关闭 ≠ Run 取消；
- cancel 已发送 ≠ Run 已停止；
- Agent 说“完成” ≠ 测试已通过。

---

## 28. 输入队列

每条输入有稳定 inputId。

状态：

- pending；
- reserved；
- accepted；
- consumed；
- cancelled；
- rejected；
- unknown。

允许用户：

- 查看排队消息；
- 修改尚未 accepted 的消息；
- 撤回尚未 accepted 的消息；
- 合并多条 queued 输入。

一旦输入已经跨过原生执行器 dispatch boundary，就不能在 UI 中伪装成“撤回成功”。

---

## 29. 中断

### 29.1 Run 中断

中断流程：

1. UI 发出 interrupt；
2. Adapter 调用原生 interrupt / cancel；
3. Run 进入 interrupting；
4. 等待原生确认；
5. 确认后进入 interrupted；
6. 如果无法确认，进入 unknown，而不是假装成功停止。

### 29.2 子进程

中断 Agent 不代表其所有后台子进程都终止。

例如 Agent 启动了 dev server，必须单独跟踪。

---

## 30. 应用重启恢复

### 30.1 恢复顺序

应用启动后：

1. 恢复 Development Session；
2. 恢复 Run 记录；
3. 对非终态 Run 查询执行器原生状态；
4. 可以 resume 时重连；
5. 无法确认时标记 unknown；
6. 绝不自动重放最后一个写入请求；
7. 恢复选中项目、会话、草稿和右栏状态。

### 30.2 产品状态与原生状态分离

即使 native process 已退出，只要有 native thread id 可恢复，Development Session 仍然存在。

即使 native session 不可恢复，产品会话历史也仍然存在，可通过 handoff 创建新 native session。

---

## 31. 数据持久化

建议将开发模块核心状态放在 Gateway 侧持久层。

至少包含：

### projects

- id
- root_path
- display_name
- created_at
- last_opened_at
- rule_source
- skills_root
- git_metadata

### development_sessions

- id
- project_id
- title
- primary_executor
- selected_model
- status
- archived
- created_at
- updated_at

### executor_bindings

- id
- session_id
- executor
- native_session_id
- native_state
- capability_snapshot
- working_directory
- created_at
- last_used_at

### runs

- id
- session_id
- executor_binding_id
- request_message_id
- status
- error
- result
- started_at
- finished_at

### run_inputs

- id
- run_id
- content
- status
- created_at
- accepted_at

### collaboration_tasks

- id
- parent_session_id
- parent_run_id
- assigned_executor
- assigned_binding
- task
- expected_output
- status
- result

### dev_views

- id
- project_id
- layout
- selected_session_id
- right_sidebar_state

完整聊天正文继续复用 Mona 既有会话消息体系，不另存第二份自然语言 transcript。

---

## 32. 统一事件模型

Adapter 原生事件必须映射为统一事件。

核心 event type：

- run.accepted
- run.started
- run.status
- agent.message.delta
- agent.message.completed
- tool.started
- tool.completed
- command.started
- command.output
- command.completed
- file.read
- file.changed
- approval.requested
- approval.resolved
- input.queued
- input.accepted
- collaboration.started
- collaboration.completed
- run.interrupting
- run.interrupted
- run.failed
- run.completed
- run.unknown

每条事件至少包含：

- eventId；
- projectId；
- developmentSessionId；
- runId；
- executorId；
- nativeSessionId（可空）；
- timestamp；
- sequence；
- payload。

### 32.1 幂等

eventId 与 sequence 用于：

- WebSocket 重连；
- 前端重放；
- 崩溃恢复；
- 防止重复插入消息。

前端不能以文本相同去重。

---

## 33. 进程与模块所有权

### 33.1 Gateway

负责：

- Development Session；
- Coding Agent；
- AgentRunner；
- Run 状态；
- 项目上下文；
- Handoff；
- CLI Adapter 协调；
- 协作任务；
- 消息与事件持久化；
- 模型路由；
- 对外 API / WebSocket。

### 33.2 Tauri

负责必须由桌面宿主拥有的：

- 本地窗口；
- 本机程序路径发现；
- 必要的原生子进程生命周期；
- 安全 IPC；
- 系统级路径选择；
- 桌面多窗口基础能力。

是否由 Tauri 直接持有某家 CLI 子进程，要按官方 SDK 运行形态确定；不能为了统一把所有执行器都强行塞到 Tauri。

### 33.3 Services

不承载 Coding Agent 或 CLI 调度状态。

Services 继续保留与 AgentLoop 无关的产品服务。

---

## 34. Executor Adapter 放置

建议在 Gateway / Agent Runtime 边界建立开发执行器目录，例如逻辑上：

- development/executors/base
- development/executors/mona
- development/executors/codex
- development/executors/claude
- development/executors/codebuddy

这是逻辑职责，不要求按此字面目录实现。

不将三家适配器写进 provider 模块。

Provider 解决“模型 API”。

Executor Adapter 解决“完整 Agent 运行时”。

二者必须明确分离。

---

## 35. 权限与安全

### 35.1 项目路径

所有外部执行者工作目录必须来自已确认 Project root。

不允许模型通过字符串参数把执行器切换到未授权路径。

### 35.2 凭据

Mona 只传递执行器启动所需的最少认证信息。

凭据：

- 不进模型 prompt；
- 不写开发会话正文；
- 不写日志；
- 不进入 handoff；
- 不进入项目规则。

### 35.3 外部 CLI 配置

必须防止外部 CLI 自动执行：

- 用户 Hooks；
- 用户 MCP；
- 项目 MCP；
- 未授权插件；
- 自动启动脚本。

不能只在 system prompt 里要求“不使用”，必须由启动配置或沙箱边界保证。

### 35.4 高风险操作

沿用 Mona 既有风险与用户确认策略。

外部执行器原生 permission 必须映射到 Mona 可见确认。

不能用“自动模式”绕过删除、凭据、系统级修改等既有安全边界。

---

## 36. 模型选择

每个执行器拥有自己的模型列表。

用户可对会话选择：

- executor；
- model；
- reasoning / effort（执行器支持时）。

模型切换分两类：

1. 同 executor 内切模型；
2. 跨 executor 切换。

同执行器内是否保持原生 session，由官方运行时能力决定。

跨执行器必须走 handoff。

---

## 37. Usage 与成本

仅展示执行器能可靠提供的数据。

可能包括：

- input tokens；
- output tokens；
- cached tokens；
- duration；
- native usage units。

如果供应商不能提供价格，不估算金额。

不同供应商 usage 结构不同，UI 做统一摘要并保留原始细节。

---

## 38. Git 与 PR

开发模块提供 Git 信息，但不把 Git 作为所有项目的强制前提。

Git 项目支持：

- 当前分支；
- status；
- diff；
- staged；
- commit；
- PR 信息（有连接时）。

非 Git 项目仍可使用 Coding Agent 和三个外部执行者。

### 38.1 多会话

本版本不自动为每会话创建 branch 或 worktree。

用户可以自行使用 Git 分支 / worktree。

后续版本可增加“新任务使用独立工作树”的可选策略，但不作为 1.8.0 默认。

---

## 39. 项目规则和 Skills 更新

每次 Run 开始记录：

- project rules fingerprint；
- skills index fingerprint。

规则变化后：

- 新 Run 使用新版本；
- 已经 running 的 Run 不强制中断；
- handoff 生成时使用当前项目事实；
- UI 可提示“项目规则已变化，下一轮生效”。

---

## 40. 错误语义

Adapter 错误必须归一化为用户可理解的类别：

- executable_not_found；
- unsupported_version；
- authentication_required；
- authentication_failed；
- native_session_not_found；
- native_session_expired；
- unsupported_capability；
- permission_denied；
- user_cancelled；
- provider_rate_limited；
- process_crashed；
- transport_lost；
- invalid_project_context；
- unknown_outcome。

错误消息需要提供唯一、可执行的下一步。

不能把原始 SDK exception 整段直接暴露给用户。

---

## 41. CLI 探测与兼容矩阵

每个执行器启动前执行 probe。

记录：

- 路径；
- 版本；
- 协议版本；
- 认证状态；
- capability；
- 最低支持版本；
- 已测试版本范围。

1.8.0 发布时必须冻结一份支持矩阵。

“系统安装了命令”不等于“兼容当前 Mona”。

---

## 42. 认证

开发设置中展示三家状态：

- 未安装；
- 已安装未登录；
- 可用；
- 需要重新登录；
- 版本过旧；
- 当前授权方式不支持 Mona 集成。

不能在 Mona 中伪造供应商登录流程。

优先调用官方允许的认证方式。

第三方产品使用个人订阅的商业授权边界必须在发布前单独确认，不能把技术可运行等同于可分发。

---

## 43. 项目 Skill 与外部 Agent 的实际注入

用户之前明确要求“公用项目规则、项目 Skill，不需要用户级配置、MCP、Hooks”。

因此验收不能只看 Mona 数据层。

必须检查原生执行器实际收到的上下文和配置。

测试项目应准备：

- 项目 AGENTS.md：包含唯一标记；
- 项目 Skill：包含唯一标记；
- 用户级 rule：包含禁止出现的唯一标记；
- 用户级 Skill：包含禁止出现标记；
- 用户 MCP：可检测调用；
- Hook：可检测触发。

最终必须证明：

- 项目规则可用；
- 项目 Skill 可用；
- 用户规则未进入；
- 用户 Skill 未进入；
- MCP 未启动；
- Hook 未触发。

三家分别验证。

---

## 44. 内置 Coding Agent 的上下文验收

同样构造唯一标记，检查真实 provider 请求。

必须证明 system/input 中不存在：

- SOUL；
- USER；
- user profile；
- 普通 Mona Memory；
- 无关业务 Skill；
- 无关业务 tool schema。

同时证明存在：

- Coding system；
- 项目规则入口；
- 项目 Skill 索引；
- 当前 session；
- 当前用户请求；
- 当前实际开发工具。

---

## 45. 性能要求

### 45.1 工作台启动

打开开发模块不应启动四个 Agent。

只有实际进入某会话并需要执行时才启动对应 native runtime。

### 45.2 资源释放

parked native session：

- 保存可恢复 ID；
- 不要求进程永久常驻；
- 可释放进程和大内存。

### 45.3 单主会话与后台执行

中央只渲染当前主会话，不渲染不可见任务的完整 Markdown。会话状态由后端持有；切换显示不重启任务。流式更新保留已完成消息的对象引用，避免反复渲染历史代码块。

### 45.4 事件有界

长任务工具事件在 UI 中虚拟化或分页。

不能因为多会话运行让 React 保留无限 tool event DOM。

---

## 46. 可观测性

开发模块需要记录不含敏感信息的结构化诊断：

- sessionId；
- runId；
- executor；
- adapter version；
- native session hash/opaque id；
- state transition；
- event sequence；
- duration；
- error category。

不得记录：

- API key；
- token；
-完整命令环境；
- 完整用户隐私文件；
- 用户 Home 配置正文。

---

## 47. 测试体系

### 47.1 单元测试

覆盖：

- 状态机；
- run CAS；
- input queue；
- capability negotiation；
- handoff 构造；
- project context filter；
- executor event normalization；
- view/session 解耦。

### 47.2 Adapter 合约测试

对三家分别运行相同合约：

1. probe；
2. create；
3. send；
4. stream；
5. interrupt；
6. resume；
7. failure；
8. auth；
9. project rules；
10. project Skills；
11. no user config；
12. no MCP；
13. no Hooks。

执行器不支持某能力时，测试 expected unsupported，而不是假失败。

### 47.3 集成测试

真实运行：

- 内置 Coding 修改示例项目并运行测试；
- Codex 修改并恢复；
- Claude 修改并恢复；
- CodeBuddy 修改并恢复；
- 执行者切换；
- implement → review → fix；
- 应用重启恢复；
- WebSocket 重连；
- 用户运行中追加消息；
- interrupt unknown handling。

### 47.4 UI 测试

覆盖：

- 标题栏概览浮卡与按需工作侧栏；
- 侧栏两态；
- 中央只有一个主会话，无多屏入口；
- 左侧项目/会话归属准确；
- 子智能体详情在右侧打开；
- 右侧跟随当前主会话；
- 草稿不串；
- 异步消息不串；
- 折叠不停止任务；
- 状态 badge 与后台一致。

### 47.5 真实项目测试

至少选择：

- Python 项目；
- TypeScript 项目；
- Rust / Tauri 项目；
- 非 Git 项目；
- 中文路径项目；
- 大型项目；
- 存在 AGENTS.md 与项目 Skills 的项目。

---

## 48. 交付级验收清单

以下是 1.8.0 发布准入，不是“后续优化”。

### A. 开发工作台

1. 导航存在独立开发模块；
2. 可打开本地项目；
3. 可创建多个开发会话；
4. 会话可重命名、置顶、归档；
5. 概览浮卡与按需工作侧栏稳定；
6. 概览浮卡默认关闭、工作侧栏默认收起，展开和收起行为正确；
7. 单主会话且无多屏入口；
8. 切换会话不复制后台任务；
9. 左栏按项目打开对应会话；
10. 右栏跟随当前主会话；
11. 输入草稿不串；
12. 异步结果不串。

### B. Mona Coding

13. 默认开发工具集精简；
14. 不加载通用用户画像；
15. 不加载普通 Mona Memory；
16. 不加载无关业务 Skills；
17. 项目规则有效；
18. 项目 Skills 可按需使用；
19. 连续多轮可基于已有修改继续；
20. 上下文压缩后任务状态不丢；
21. 长结果可继续读取；
22. 真实测试结果进入完成判断。

### C. Codex

23. 创建原生 session；
24. 连续多轮；
25. resume；
26. interrupt；
27. 项目规则；
28. 项目 Skill；
29. 用户配置隔离；
30. 事件结构化展示。

### D. Claude Code

31. 创建原生 session；
32. 连续多轮；
33. resume；
34. interrupt；
35. 项目规则；
36. 项目 Skill；
37. 用户配置 / MCP / Hooks 隔离；
38. 事件结构化展示。

### E. CodeBuddy

39. 创建原生 session；
40. 连续多轮；
41. resume 或明确能力边界；
42. interrupt；
43. 项目规则；
44. 项目 Skill；
45. 用户配置 / MCP / Hooks 隔离；
46. 事件结构化展示。

### F. 协作与接力

47. 四个执行者均可作为主执行者；
48. 用户可指定协作者；
49. 内置 Coding 可按需委派；
50. 协作者结果回到正确父会话；
51. implement → review → fix 跑通；
52. 切换执行者不创建新的 Mona 产品会话；
53. 切回已有执行者优先 resume；
54. resume 失败可 full handoff；
55. handoff 不包含密钥和用户私有记忆。

### G. 恢复与可靠性

56. 工作标签关闭不停止 Run；
57. 模块切换不停止 Run；
58. WebSocket 重连不重复显示事件；
59. 应用重启恢复会话；
60. 结果未知的写入 Run 不自动重放；
61. interrupt 未确认时不显示已停止；
62. 迟到事件不能修改终态；
63. capability 不支持时返回明确边界；
64. auth 失效不会丢产品会话。

### H. 代码与验证

65. 真实 Git diff 与会话活动分开；
66. 不错误归属其他会话变更；
67. 审查结果绑定代码版本；
68. 代码变化后旧审查可识别为旧状态；
69. 非 Git 项目仍可开发；
70. 中文路径和 Windows 路径可用。

全部通过后，才达到“交付级开发模块”。

---

## 49. 实施顺序

本版本一次性交付，但必须按依赖顺序实现。

### D0：冻结业务与协议

输出：

- 数据对象；
- Adapter 合约；
- Run 状态机；
- 输入队列；
- 统一 event；
- project context 白名单；
- UI 项目、会话、工作标签的关系。

在这一阶段不得写四套各自为政的接入代码。

### D1：三家 CLI 风险验证

不做完整 UI，先用最小 harness 验证：

- 启动；
- session；
- resume；
- interrupt；
- streaming；
- model；
- auth；
- config isolation；
- project rules；
- project Skills。

这里决定 CodeBuddy 最终 ACP 还是 SDK。

任何一家达不到配置隔离要求，必须在继续开发前解决或明确调整 1.8.0 支持方式。

### D2：工作台骨架

完成：

- 开发导航；
- Project；
- Development Session；
- 左任务列表；
- 单主会话；
- 项目与会话切换；
- 标题栏概览浮卡与按需工作侧栏；
- 会话恢复。

此时可以使用 fake executor 验证 UI，不依赖某一家 CLI。

### D3：Mona Coding

完成：

- Coding Context；
- 精简 Tool Set；
- 持续会话；
- run event；
- 文件 / 命令事件；
- compaction；
- side chat read-only；
- browser 按需。

必须先成为可独立使用的 Coding Agent。

### D4：CLI Adapter 完整接入

按同一合约依次接入：

1. Codex
2. Claude Code
3. CodeBuddy

顺序仅代表实现顺序，最终三者均属于本版交付。

### D5：协作和执行者切换

完成：

- collaboration task；
- handoff；
- parked native sessions；
- delta handoff；
- full fallback；
- review flow；
- queue。

### D6：右栏业务完善

完成：

- diff；
- terminal；
- browser；
- files；
- review；
- side chat；
- PR 信息。

### D7：恢复、压力与发布验收

完成：

- crash / restart；
- protocol version mismatch；
- auth expiry；
- long run；
- 同项目多任务并行与单主会话切换；
- large repo；
- packaging；
- upgrade migration；
- 全部交付验收项。

---

## 50. 数据迁移与版本升级

1. 1.8.0 首次进入开发模块时建立开发模块存储；
2. 不迁移普通 Mona 会话为开发会话；
3. 用户可从普通会话显式“在开发模块继续”，此时只复制必要用户内容或建立来源引用；
4. 不迁移外部 CLI 历史会话，除非官方接口能可靠列出并且用户明确选择导入；
5. 1.8.x schema 变化必须版本化；
6. 无法迁移时保留旧数据并降级只读，不静默清空。

---

## 51. 发布与回滚

### 发布前必须冻结

- 三家支持版本矩阵；
- 协议版本；
- 数据 schema；
- project rule / Skill 规范；
- capability semantics；
- 安全配置；
- 认证说明；
- 70 项验收结果。

### 回滚要求

如果某一个外部执行器因上游升级暂时不可用：

- 不影响 Mona Coding；
- 不影响其他执行器；
- 开发会话仍可打开；
- 对应 binding 标记 unavailable；
- 用户可切换执行者继续；
- 不删除该执行器历史绑定。

---

## 52. 已知风险

### 52.1 上游 CLI 协议变化

控制方式：

- Adapter 隔离；
- 版本 probe；
- 支持矩阵；
- capability snapshot；
- 合约测试。

### 52.2 配置隔离失败

风险：

外部 CLI 可能自动加载用户配置、MCP、Hooks。

控制：

- D1 真实黑盒测试；
- 明确启动参数；
- 独立配置目录（若官方支持且不破坏认证）；
- 不满足则禁止该接入版本上线。

### 52.3 原生会话恢复能力不一致

控制：

- 每家 capabilities 明确；
- unsupported 不伪装 supported；
- handoff fallback；
- 产品会话独立于 native session。

### 52.4 同项目多会话冲突

这是已接受的产品边界。

Mona 不增加全局锁，但仍：

- 显示真实工作区状态；
- 不错误归属 diff；
- 工具按当前文件状态工作；
- 不把旧 review 当当前 review。

### 52.5 多 Agent 成本与复杂度

控制：

- 默认单执行者；
- 协作按需；
- 不自动启动三家“互相讨论”；
- 明确显示正在运行的执行者。

---

## 53. 不变量

实现中必须长期保护以下不变量：

1. View 不是任务所有者；
2. Session 不是 Run；
3. Executor 不是 Model；
4. Provider 不是 Executor Adapter；
5. Native Session 不是 Mona Development Session；
6. Project rules 单一事实来源；
7. Project Skills 单一事实来源；
8. 不自动加载用户 Memory；
9. 不自动加载用户 MCP / Hooks；
10. 不因切换 UI 重新执行任务；
11. 不因连接失败自动重放有副作用的写操作；
12. 不把同项目其他会话的 diff 归因给当前 Agent；
13. 不要求简单任务强制多 Agent；
14. 不把外部 CLI 降级为只调用其模型；
15. 不为了统一 UI 编造执行器不存在的能力；
16. 任何“完成”都必须与实际执行状态一致。

---

## 54. 对现有 Mona 的影响边界

开发模块不得破坏：

- 普通 Mona 聊天；
- 现有 Agent / Partner；
- 现有协作房间；
- Office；
- 浏览器；
- Terminal；
- Notes；
- 现有工具权限系统。

开发模块可以复用这些基础设施，但不能要求它们迁移成开发模块专用版本。

当前协作工具受 room 限制，因此开发模块的跨执行者协作应在底层任务/执行服务上复用能力，而不是为了复用 UI 构造隐藏 room。

---

## 55. 最终交付定义

Mona 1.8.0 的“开发模块已交付”必须同时满足：

1. 产品上是完整的开发工作台，而不是实验入口；
2. 内置 Mona Coding 可以独立开发真实项目；
3. Codex、Claude Code、CodeBuddy 都是原生 Agent 执行，而不是模型别名；
4. 四个执行者可以直接作为主执行者；
5. 支持按需协作和接力；
6. 项目规则、项目 Skills 跨执行者统一；
7. 用户级配置、MCP、Hooks、Memory 符合明确隔离边界；
8. 项目/会话树、单主会话、概览与动态工作标签达到产品可用标准；
9. 会话、任务、取消、恢复、重连具有可靠状态语义；
10. 真实项目、真实 CLI、真实模型通过发布验收矩阵；
11. 失败场景不会导致静默覆盖、重复执行或假完成；
12. 所有对用户的状态描述都与实际执行证据一致。

达到上述标准后，这一版本才属于“可正式交付的 1.8.0 开发模块”，而不是 MVP 或技术验证。

---

## 56. 参考实现与资料

Pi coding-agent：

- https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md

Cindy：

- https://github.com/makecindy/cindy
- `apps/desktop/src/main/maker-ipc/agentHandoff.ts`
- `apps/desktop/src/main/maker-ipc/sessionAgentSwitchHandler.ts`
- `apps/desktop/src/main/maker-ipc/orcaTeamService.ts`

Codex：

- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/guides/agents-md
- https://developers.openai.com/codex/skills

Claude Agent SDK：

- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts

CodeBuddy：

- https://www.codebuddy.cn/docs/cli/ide-integrations
- https://www.codebuddy.cn/docs/cli/sdk

---

## 57. 结论

1.8.0 不应按照“先做一个能跑的 Coding Demo，再慢慢补生产能力”的 MVP 思路建设。

本方案以正式交付为目标：

- 产品结构一次定义正确；
- 内置 Agent 从第一天就按 Pi 式精简装配；
- 外部 CLI 从第一天就按原生 Agent 而不是模型供应商设计；
- 会话、Run、原生绑定和 UI 视图从第一天分离；
- 配置隔离、恢复、取消、幂等和状态语义属于主功能，不是后续加固；
- 三个 CLI 的真实兼容验证前置；
- 最后用完整的交付矩阵决定是否发布，而不是以“能聊天、能改文件”判定完成。
