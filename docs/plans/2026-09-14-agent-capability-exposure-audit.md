# Mona 业务入口与 Agent 能力暴露审查表

日期：2026-09-14。状态：请求级能力加载已实施；邮件等分组仍可继续调优。

后续 Codex 参考批次进一步将开发/文件写入、HTTP、Skill 配套工具改为可发现的按需能力，普通会话初始工具降至 19 个；`my`、Notes/Knowledge、记忆、基础文件发现/读取、网页和任务协调仍常驻。Skill 读取成功后自动提供配套工具，文档流水线预加载执行能力，已有会话从保留工具调用恢复能力。浏览器、开发、终端、数据库的完整操作契约与能力同步加载。本页下方的 50/46/30 项数字保留为前序审查快照；最新同条件测量见[实施计划](2026-09-14-harness-token-optimization.md)。

判断标准：只有用户在会话中需要 AI 判断、组织、执行的能力，才需要会话工具。固定页面按钮和内部流水线直接调用业务服务。一个功能同时有按钮和聊天入口时，两种入口可以共用后端；不能因为存在按钮就删除聊天能力。

## 1. 已核实的结论

- **画像生成、画像建议和画像图表没有作为普通会话工具暴露。** 画像更新走前端业务 API，图表由画像数据生成并在页面渲染。删除这些页面能力不会减少目前的工具 Schema。
- **画像内容与画像操作不同。** `ContextBuilder` 会注入只读画像快照；这是 system 内容，可另行精简。`my` 是 Agent 运行状态检查/修改工具，不是个人画像。
- **主要问题曾是会话业务工具常驻过多。** 延迟加载实施前，无活动数据库/终端的普通会话仍得到数据库、终端、Office、媒体和邮件等工具；本批次已按下述边界处理。
- 不是所有“后台”工具都应移除：计划更新、文件交付、任务委派都需要模型在会话中作出业务判断，程序负责执行和同步。

已实施边界：

- `my` 保持不变，继续提供模型、配置和运行状态的检查与允许范围内的修改。
- Office、图片、视频、邮件、数据库、终端、笔记写入、收藏、消息、自动化和浏览器由模型通过 `load_capability` 按用户自然语言加载；没有增加关键词分类器。
- Notes 与 Agent Knowledge 的搜索/读取继续初始可见，让模型在可能由个人资料回答时主动查询；`my` 保持完整能力。
- 活动 Office、数据库、终端和浏览器上下文直接预加载对应分组，媒体附件预加载图片/视频分组。无 UI 上下文的普通自然语言任务由模型先加载，再在下一次调用获得完整工具。
- 图片分组在轮中加载时自动返回完整 `image-generation` Skill；图片模式在 turn 入口预加载时仍由 system 注入同一 Skill。
- `terminal_task` 从后端解析到已有终端后，会在同一轮解锁执行、输出和上传工具。
- `complete_goal` 只在活动长期目标或当前显式 `/goal` 回合暴露；`long_task` 原有显式 `/goal` 边界不变。
- 普通会话画像只注入 preferences；可信 `origin=profile_advice` 会话额外注入 work_context 与 current_focus。

同一本机配置的普通“你好”离线发送边界快照从上一阶段约 19,959 降到最终复测约 13,007：初始工具 46 → 30，工具 Schema 约 12,461 → 6,811，system 约 7,438 → 6,135。初始工具仍包含 `my`、Notes/Knowledge 搜索读取、文件/命令/网页、记忆/Skill、计划和子任务；专项能力保留在加载目录中。

## 2. 实施前清单的统计边界

复用当前源码的 `AgentLoop`、`ToolLoader` 和 `ToolRegistry.get_definitions()`，读取本机工具配置及 Agent 授权快照；在临时数据目录构造普通 websocket 会话，订阅设为有效，未携带活动面板元数据。没有调用模型、执行业务工具、连接 MCP 或启动生产服务。

延迟加载实施前，该环境暴露 **50 个工具，Schema 合计约 13,422 tokens**。各行数字是 `cl100k_base` 对单独工具数组的估算，逐行相加为 13,472；数组边界编码导致与整体差 50，非遗漏。该数字保留为逐项审查基线，不代表当前普通会话的初始工具集合。

Playwright 在开发环境缺失，动态 MCP 未连接，`schedule_service` / `todo_service` 未注入，因此浏览器、电脑操作、日程和待办不在这 50 项内。第 5 节单列这些能力，不能把这份清单当作完整桌面进程的实时清单。

以下逐项表格记录审查依据；其中能力分组和按需加载已经实现，重叠工具合并等未明确标为“已实施”的项目仍只是候选。实现使用模型驱动的能力发现与后端会话状态，不使用关键词开关。

## 3. 固定业务入口：不需要成为普通会话工具

| 业务/入口 | 当前调用路径 | 普通 Agent 是否需要操作工具 | 建议与保留行为 | 证据 |
|---|---|---|---|---|
| 画像页“刷新画像” | 页面读取 `/api/profile` | 否；当前未暴露 | 保持页面读取，不注册工具 | [ProfileView](../../webui/src/components/profile/ProfileView.tsx)、[profile-api](../../webui/src/lib/profile-api.ts) |
| 画像页“更新画像” | `handleDistill` → `triggerDistill("all")` → `/api/profile/distill` → 蒸馏服务 | 否；当前未暴露 | 模型调用归业务流水线，不进入普通会话工具目录 | [ProfileView](../../webui/src/components/profile/ProfileView.tsx)、[服务路由](../../mona/services/server.py)、[蒸馏服务](../../mona/distill/service.py) |
| 画像/协作统计图表 | `build_profile_charts` → dashboard → ProfileTab 图表组件 | 否；当前未暴露 | 页面图表继续直接渲染；不是学者 `chart` 工具 | [profile_charts](../../mona/distill/profile_charts.py)、[ProfileTab](../../webui/src/components/profile/ProfileTab.tsx) |
| 画像纠正、建议反馈、产物采纳 | `/api/profile/context`、`advice/*/feedback`、`artifacts/*/feedback` | 否；当前未暴露 | 保留用户确认、版本检查及更新接口 | [profile-api](../../webui/src/lib/profile-api.ts) |
| 画像生成建议 | 蒸馏流水线内的 advice 模型任务 | 否；当前未暴露 | 专用模型请求按建议业务提供上下文 | [advice](../../mona/distill/tasks/advice.py) |
| 建议卡“开始行动” | `prepareAdviceStart` → App 新建会话并传入建议 prompt | **后续行动需要会话能力** | 建议生成仍是业务接口；开始行动后按具体任务提供工具，不能一并移除 | [profile-api](../../webui/src/lib/profile-api.ts)、[App](../../webui/src/App.tsx) |
| 自动画像蒸馏 | 注册系统调度任务 → 蒸馏流水线 | 否；当前无专属会话工具 | 保留内部调度；源码存在自动入口，不能把画像描述为绝对仅由按钮触发 | [register_distill_jobs](../../mona/distill/service.py) |
| Agent 私有记忆整理、Skill 演化 | Dream/特定执行身份下的内部流程 | 主 Mona 不需要对应写工具 | 保留内部 `memory_edit` / `skill_create`，不加入普通主会话 | [memory_tools](../../mona/agent/tools/memory_tools.py)、[skill_tools](../../mona/agent/tools/skill_tools.py) |
| 系统概览、存储扫描、启动项、软件与维护记录 | 系统页面直接调用 Tauri IPC | 否；无对应专属工具在本次清单中 | 保持固定扫描和执行命令，当前 Schema 可节省量为 0 | [useSystemData](../../webui/src/components/system/useSystemData.ts) |
| 系统管家“生成方案/诊断/分析范围” | `/api/system/plan`、`diagnose`、`storage/analyze` → 专用 `provider.chat(..., tools=None)` | 否；已有无工具专用模型请求 | 保留隔离业务请求，不并入普通 Agent | [systemAgentApi](../../webui/src/components/system/systemAgentApi.ts)、[system_agent](../../mona/system_agent.py) |
| 系统管家确认执行、失败后交给 Mona | 前端确认后调用清理/更新/启动项命令；交接时新开聊天 | 默认执行不需要；**明确交接后需要会话能力** | 保留原执行路径，只在交接任务中按实际需求提供能力 | [SystemAssistant](../../webui/src/components/system/SystemAssistant.tsx)、[SystemAgentChat](../../webui/src/components/system/SystemAgentChat.tsx) |
| Agent 知识“添加资料/重新学习/删除” | `/api/materials/knowledge` 与 retry → 后台学习队列 | 否；管理/学习未作为本次会话工具暴露 | 面板负责资料管理；会话 `knowledge_search/read` 负责已学资料问答，两者保留 | [AgentKnowledgePanel](../../webui/src/components/agents/AgentKnowledgePanel.tsx)、[materials-api](../../webui/src/lib/materials-api.ts)、[knowledge](../../mona/materials/knowledge.py) |

## 4. 实施前 50 个工具逐项审查

### 4.1 文件、执行与交付（11 项）

这些工具服务于普通会话的真实工作，当前保留为初始通用能力。它们不因页面上也存在打开、保存按钮而失去会话价值。

| 工具 | 约 Token | 会话里的真实任务 | 结论及边界 | 证据 |
|---|---:|---|---|---|
| `read_file` | 293 | “读取附件/代码，告诉我问题在哪” | 保留；文件权限和读取分页不变 | [filesystem](../../mona/agent/tools/filesystem.py) |
| `find_files` | 350 | “找到那个配置文件” | 保留；按路径/类型定位 | [search](../../mona/agent/tools/search.py) |
| `list_dir` | 147 | “看看目录里有哪些资料” | 保留；与内容搜索职责不同 | [filesystem](../../mona/agent/tools/filesystem.py) |
| `grep` | 470 | “找出所有调用位置” | 保留；精准内容搜索 | [search](../../mona/agent/tools/search.py) |
| `apply_patch` | 344 | “修改这几个文件” | 保留；结构化编辑 | [apply_patch](../../mona/agent/tools/apply_patch.py) |
| `edit_file` | 318 | “替换这处配置值” | 保留；与 patch 有重叠，但当前是必需能力，不直接删除 | [filesystem](../../mona/agent/tools/filesystem.py) |
| `write_file` | 129 | “新建这份文件” | 保留；新建/整文件写入 | [filesystem](../../mona/agent/tools/filesystem.py) |
| `exec` | 658 | “运行脚本、验证修改” | 保留；不得取代受审批的业务写入路径 | [shell](../../mona/agent/tools/shell.py) |
| `write_stdin` | 477 | “继续这个命令/提交输入/停止进程” | 保留执行配套；后续可在已有进程时提供，但必须支持同一轮长命令续调 | [exec_session](../../mona/agent/tools/exec_session.py) |
| `list_exec_sessions` | 87 | “找到刚才仍在运行的命令” | 保留执行恢复；不能仅凭本条文本不含命令而隐藏 | [exec_session](../../mona/agent/tools/exec_session.py) |
| `deliver_file` | 171 | “把最终文件交给我” | 保留；模型选择最终产物，后端负责归属与展示；不能自动交付目录里所有文件 | [deliver_file](../../mona/agent/tools/deliver_file.py) |

### 4.2 通用网页、记忆、Skill 与任务组织（11 项）

| 工具 | 约 Token | 会话里的真实任务 | 结论及边界 | 证据 |
|---|---:|---|---|---|
| `web_search` | 121 | “查一下最新信息” | 保留通用能力 | [web](../../mona/agent/tools/web.py) |
| `web_fetch` | 171 | “读这个链接” | 保留通用能力 | [web](../../mona/agent/tools/web.py) |
| `http_request` | 307 | “查询这个 API” | 保留；与网页正文提取不同，仍执行 SSRF 等检查 | [http](../../mona/agent/tools/http.py) |
| `memory_read` | 138 | “按之前约定的习惯做” | 保留私有记忆读取；不是画像蒸馏 API | [memory_tools](../../mona/agent/tools/memory_tools.py) |
| `memory_search` | 173 | “回忆上次讨论的约束” | 保留；不能用清空历史降低开销 | [memory_tools](../../mona/agent/tools/memory_tools.py) |
| `skill_read` | 118 | 读取匹配业务的工作方法 | 保留；是按需能力入口 | [skill_tools](../../mona/agent/tools/skill_tools.py) |
| `skill_reference_read` | 145 | 获取 Skill 指定的协议/模板 | 保留；独立路径边界 | [skill_tools](../../mona/agent/tools/skill_tools.py) |
| `skill_script_run` | 211 | 执行 Skill 提供的处理脚本 | 保留；脚本批准和统一运行时机制不变 | [skill_tools](../../mona/agent/tools/skill_tools.py) |
| `skill_asset_copy` | 163 | 使用 Skill 模板或素材 | 保留；不可随意让普通文件工具穿过 Skill 边界 | [skill_tools](../../mona/agent/tools/skill_tools.py) |
| `update_plan` | 199 | 对复杂工作更新步骤与进度 | 保留；模型提交计划，前端只展示；不是按钮数据同步工具 | [task_plan](../../mona/agent/tools/task_plan.py) |
| `spawn` | 145 | 把独立子任务交给伙伴执行 | 保留 Mona 协调能力；不能用程序根据句子切分自动代替 | [spawn](../../mona/agent/tools/spawn.py) |

### 4.3 专项会话能力：保留业务，减少无关会话常驻（23 项）

| 工具 | 约 Token | 真实入口/会话需求 | 建议提供条件 | 证据 |
|---|---:|---|---|---|
| `db_inspect` | 214 | DB 面板 AI，“分析表结构/查询计划” | `load_capability(database)` 或活动 DB 预加载；执行仍要求可信 connection_id | [database](../../mona/agent/tools/database.py)、[DbAgentPanel](../../webui/src/components/db/DbAgentPanel.tsx) |
| `db_query` | 168 | DB AI，“查出符合条件的数据” | 同上；只读策略不变 | [database](../../mona/agent/tools/database.py) |
| `db_sql_draft` | 255 | DB AI，“写一段 SQL 给我” | 由 database 分组加载；没有连接也可生成草稿 | [database](../../mona/agent/tools/database.py) |
| `terminal_task` | 563 | 终端 AI，“排查并修复这台服务器” | 由 terminal 分组加载或活动终端预加载；自然语言入口和步骤约束不变 | [terminal](../../mona/agent/tools/terminal.py) |
| `terminal_exec` | 369 | 执行终端维护步骤 | terminal 分组已加载且活动终端存在；任务启动找到终端后可同轮解锁 | [terminal](../../mona/agent/tools/terminal.py) |
| `terminal_output` | 223 | 查看当前终端输出、验证命令结果 | 同上 | [terminal](../../mona/agent/tools/terminal.py) |
| `terminal_upload` | 307 | 上传维护所需文件 | 同上；审批不变 | [terminal](../../mona/agent/tools/terminal.py) |
| `office` | 1,206 | “新建报告/改这份表格/编辑幻灯片” | 由模型加载 office；活动 Office 直接预加载，新建文档不要求已有 session | [office](../../mona/agent/tools/office.py) |
| `generate_image` | 490 | “画一张图/修改这张图”，也可能是文档中的插图 | 由模型加载 image；加载结果先注入完整 Skill，图片模式/附件可预加载 | [image_generation](../../mona/agent/tools/image_generation.py) |
| `generate_video` | 369 | “生成一段视频” | 由模型加载 video；视频模式/附件可预加载 | [video_generation](../../mona/agent/tools/video_generation.py) |
| `video_extract_frame` | 285 | 分析视频、视频笔记选帧 | 视频输入或视频笔记链路；不能因为只提到“记笔记”而漏掉后续选帧 | [video_extract_frame](../../mona/agent/tools/video_extract_frame.py) |
| `email_search` | 356 | “找上周那封邮件” | 邮件检索/相关个人资料请求；订阅与范围限制保留 | [email_intel](../../mona/agent/tools/email_intel.py) |
| `email_read` | 275 | “读一下邮件全文” | 与邮件搜索配套 | [email_intel](../../mona/agent/tools/email_intel.py) |
| `email_action` | 242 | “整理这些邮件” | 邮件操作任务；当前返回操作建议并由前端确认，不等于自动发送邮件 | [email_intel](../../mona/agent/tools/email_intel.py) |
| `notes_search` | 111 | “找我的笔记” | Notes 查询；不得因有笔记搜索框而删除 | [knowledge_search](../../mona/agent/tools/knowledge_search.py) |
| `notes_read` | 110 | “读这篇笔记” | 与 Notes 搜索配套 | [notes](../../mona/agent/tools/notes.py) |
| `notes_create` | 226 | “把这段内容保存成笔记” | `notes_write` 分组按自然语言加载；免费可创建的行为保留 | [notes](../../mona/agent/tools/notes.py) |
| `notes_save_image` | 191 | “把图片保存到笔记” | `notes_write` 分组加载且授权/订阅允许 | [notes](../../mona/agent/tools/notes.py) |
| `knowledge_search` | 128 | “根据给你的资料回答” | Agent 私有 Knowledge 请求；保留身份与知识范围 | [knowledge_search](../../mona/agent/tools/knowledge_search.py) |
| `knowledge_read` | 113 | 读取知识结果与原始证据 | 与 Knowledge 搜索配套；不能只给摘要不给证据 | [knowledge_search](../../mona/agent/tools/knowledge_search.py) |
| `url2note` | 119 | 浏览器“转笔记”及聊天“把这个视频整理成笔记” | 聊天明确笔记请求；页面直接调用提取服务继续保留 | [url2note](../../mona/agent/tools/url2note.py) |
| `hoard_search` | 232 | “找到我之前收藏的那个链接” | 收藏/跨来源回忆任务；不是 Notes/Knowledge 的默认替代品 | [hoard](../../mona/agent/tools/hoard.py) |
| `hoard_capture` | 344 | “收藏一下这个” | 聊天收藏需求保留；后台被动采集由服务负责。是否保留 Agent 自主收藏属产品选择，不能偷偷删除 | [hoard](../../mona/agent/tools/hoard.py) |

### 4.4 需要拆分动作或核实替代关系（5 项）

| 工具 | 约 Token | 现有用途 | 建议 | 移除前提/证据 |
|---|---:|---|---|---|
| `my` | 349 | check 查看模型/用量/配置；set 修改模型、迭代数或写 scratchpad | **用户决定保持不变** | 继续保留聊天诊断、模型与配置修改能力。[self](../../mona/agent/tools/self.py) |
| `complete_goal` | 159 | 模型确认长期目标完成/取消/转向 | **已实施：**仅活动目标或当前 `/goal` 回合提供 | 不以助手结束回复自动判定目标完成。[long_task](../../mona/agent/tools/long_task.py) |
| `message` | 395 | 主动/跨渠道消息、现有附件、生成媒体交付 | **渠道/交付限定**：保留 IM 和媒体链；普通正文走原响应链 | 当前 prompt 仍要求生图后用它交付，删前须闭合替代链。[message](../../mona/agent/tools/message.py) |
| `document` | 151 | 将 PDF、Office、CSV 等文件解析为文本 | **重叠候选**：核对与 `read_file` 的格式、分页和输出差异后再决定合并；当前先按文档场景提供 | 不是“生成报告”按钮专用能力，不直接删除。[document](../../mona/agent/tools/document.py) |
| `heartbeat_update` | 187 | 编辑 HEARTBEAT.md 中的周期检查任务 | **按需且待梳理**：保留用户提出周期检查的会话需求；内部调度不交模型维护 | 与 schedule 的周期提醒不是天然等价；迁移前确认任务持久化、触发和展示差异。[heartbeat_tools](../../mona/agent/tools/heartbeat_tools.py) |

终端已改为“模型按需加载或活动终端预加载 + 后端会话/任务状态”双重约束。不能只按前端面板状态做关键词式隐藏；加载终端分组后仍由可信会话状态决定具体执行工具是否可用。

## 5. 不在本次 50 项中的能力

| 能力 | 当前不出现的原因/边界 | 建议 |
|---|---|---|
| `schedule`、`todo` | 构造时未注入对应业务服务；enabled 取决于服务是否存在 | 日程页、待办页按钮保留；“明天提醒我”“帮我记待办”是会话需求，应按场景提供。[schedule](../../mona/agent/tools/schedule.py)、[todo](../../mona/agent/tools/todo.py) |
| `cron` | `enabled()` 明确返回 False，已由 schedule 覆盖用户调度入口；后台 CronService 仍保留 | 不重新暴露；通用工具契约已改为提示模型加载并使用 `schedule`。[cron](../../mona/agent/tools/cron.py) |
| `browser_observe`、`browser_act` | 开发环境缺少 Playwright | 网页交互/当前页面任务需要；授权后按可发现的浏览器能力提供，不能归为按钮专用。[browser](../../mona/agent/tools/browser.py) |
| `computer_observe`、`computer_act`、动态 `mcp_*` | 本次没有连接运行时 MCP | 电脑操作与外部服务任务按授权提供；只开放门面和实际需要的业务工具，内部适配器不外露。[mcp](../../mona/agent/tools/mcp.py) |
| `canvas` | 无活动画布/创建意图时已有上下文过滤 | 保留现有按场景方式，支持同会话续改。[canvas](../../mona/agent/tools/canvas.py) |
| `delegate_agent`、`propose_workflow`、`run_collaboration` | 普通会话非协作房间，已有过滤 | 保留房间会话能力；工作流激活按钮保持直接业务行为。[delegate](../../mona/agent/tools/delegate.py)、[propose_workflow](../../mona/agent/tools/propose_workflow.py)、[run_collaboration](../../mona/agent/tools/run_collaboration.py) |
| `long_task` | 只在显式 `/goal` 入口可见 | 保留现有边界；和 complete_goal 的提供时机一起审查。[long_task](../../mona/agent/tools/long_task.py) |
| `config_set_provider` | 要求显式授权，本机未向模型暴露 | 倾向设置页操作；但已有“聊天帮我配置供应商”用途，最终移除属于产品行为调整。此快照可节省量为 0。[config](../../mona/agent/tools/config.py) |
| `crypto` | 显式授权过滤 | 编码/哈希等是可成立的会话任务，按需提供；不是画像或设置管理工具。[crypto](../../mona/agent/tools/crypto.py) |
| `materials_search/read`、`wiki_search/read` | 旧底层适配器设为 model_visible=False，当前有效授权也采用 knowledge 门面 | 保持不向主会话重复暴露；保留旧引用和内部兼容。[user_config](../../mona/agent/user_config.py)、[knowledge_search](../../mona/agent/tools/knowledge_search.py) |
| `academic_search`、`scientific_tool`、`research_record`、`dataframe_query`、`chart` | 学者 Agent 专属 | 保留专家任务能力；`chart` 与画像页面图表无关，不计入当前主 Mona 节省量。[user_config](../../mona/agent/user_config.py) |
| `music_score`、`guitar_tab`、股票研究与 submit 工具 | 音乐/股票专家或内部角色所有权限制 | 保留在对应专家；不要移入主 Mona。内部结构化提交可能仍需专家模型判断，不等于可全部改成按钮。[user_config](../../mona/agent/user_config.py) |
| 视频专用 DocumentAgentLoop | 文档工作台按 agent_kind 使用独立 prompt 和工具白名单 | 保留视频专用会话；PPT 统一由 `mona-pptx` 和 Office 编辑器处理。[document_loop](../../mona/agent/document_loop.py) |

## 6. 画像与其他上下文的单独决策

| 内容 | 当前行为 | 建议 | 是否是删工具 |
|---|---|---|---|
| 完整画像、dashboard 图表、建议列表 | 不在普通 Agent 工具 Schema；snapshot 也不直接注入这些完整对象 | 继续留在画像页/专用业务请求中 | 否 |
| 只读画像快照 | `context.py` 每次构建 system 时加载；白名单为 preferences、work_context、current_focus，内部包含背景/兴趣等字段 | 默认只保留必要语言、明确偏好与约束；背景/当前关注由相关任务按需携带，须防止丢失用户明确要求 | 否，是上下文精简 |
| 近期事件 Recent History | Dream 尚未处理的事件进入 system | 独立审查相关性、跨轮约束和恢复，不能随工具下架清空 | 否 |
| memory/my 常驻 Skill | 全文常驻 | memory 核心规则保留；my 动作拆分后再减少运行状态教程；不要先删说明留下旧宽接口 | 否 |
| 生图 Skill | generate_image 已注册时自动加载 | 延迟暴露生图工具时必须同步保证首次生成前完整方法已加载，包含文档内隐含生图需求 | 否，需联动能力装载 |

证据：[context.py](../../mona/agent/context.py)、[snapshot.py](../../mona/distill/snapshot.py)、[skills.py](../../mona/agent/skills.py)。此前约 474 Token 的画像开销只是当时快照，不能当作当前固定成本。此表未读取或展示用户画像正文。

## 7. 按业务分层后的预算方向

只计算本次已出现的工具，下面是单工具估算值之和，不含 system、历史或未来的能力发现开销。

| 分组 | 工具数 | 约 Token | 调整方向 |
|---|---:|---:|---|
| 文件/执行/交付 + 网页 + 记忆/Skill + 计划/子任务 | 22 | 5,335 | 通用候选；后续可继续评审执行配套与重叠接口 |
| 终端 + 数据库 | 7 | 2,099 | 优先跟随后端会话与任务状态提供 |
| Office + 图像/视频/选帧 | 4 | 2,350 | 文档/媒体业务按需，保证任务中途可获取 |
| 邮件 + Notes/Knowledge/URL笔记 + 收藏 | 12 | 2,447 | 个人资料/收藏请求按需；搜索与读取配套 |
| my、complete_goal、message、document、heartbeat_update | 5 | 1,241 | 拆动作、按状态/渠道提供或核实替代 |

实施后，无专项业务请求的工具 Schema 实测为约 6.8K（包含通用工具、查询能力和加载入口），system 约 6.1K，完整输入约 13.0K。这已经兑现主要 Schema 收益，但仍明显高于 Pi 的约 1.2K，不能以首轮数字替代整轮质量和成本评估。

优先处理顺序：

1. 已完成请求级能力加载、UI/附件预加载、同轮工具扩展、权限保护和并发隔离。
2. `my` 与 Notes/Knowledge 查询按用户决策保持初始可见。
3. 已修正通用工具契约中的 cron → schedule 入口文案，不新增调度功能。
4. 根据真实任务继续调整分组粒度，避免一个分组加载过多相邻工具。
5. Recent History 和常驻 Skill 独立审查，不能用删上下文破坏跨轮连续性。

实现已覆盖初始隐藏、自然语言能力加载后的下一次模型调用、图片 Skill 自动注入、UI/附件预加载、权限不扩张、内部子 Agent 兼容、目标生命周期和并发会话隔离；没有运行全量业务测试或真实模型请求。
