# 普通 Work 会话链路共用评估与实施

用户要求：评估所有需要共用的能力并复刻到 Web；复用应用实现，尽量不重构。状态：**本地开发与候选验证完成，已打包，尚未生产发布**。

范围是普通会话的行为与交互链路，不复制任何桌面用户数据、系统权限或私人凭据。浏览器/终端 UI 继续按用户要求移除；云同步继续关闭。共享的是逻辑和协议，账号、存储、文件执行、网络与通信保留租户适配。

## 已确认的共用矩阵

| 领域 | 直接共用的应用实现 | Web 必须适配的部分 | 当前状态 |
|---|---|---|---|
| 执行/循环保护 | AgentRunner / AgentRunSpec | 独立可信子进程、取消与预算 | 原已共用，补齐 callbacks |
| 提示/人格 | ContextBuilder、SOUL、tool/capability/skills 模板 | 逻辑 /workspace、隔离记忆/profile、动态上下文 | 本地已接线，统一 Mona 人格，不加后台身份 |
| Skill | SkillsLoader / SkillReadTool / ReferenceReadTool | 内置只读范围、无私人桌面层、沙箱脚本 | 共用规则/依赖引用已本地完成 |
| 按需能力 | LoadCapabilityTool / capability ContextVar / registry | 只注册批准工具，不能以加载扩大权限 | 本地已接线 |
| 问答 | AskUserQuestionTool / UserQuestions / UserQuestionPanel | 账号/会话/活动run、回答回执、停止、重连 | 本地 HTTP/WS 与真实浏览器通过 |
| 样张预览 | 原 question_preview 与媒体 UI | 等待前安全下载图像、SHA、隔离存储、短期票据、历史签新票据 | 真实字节、媒体票据和浏览器图片通过 |
| 窗口/摘要 | 目录解析、Session.get_history、Consolidator | owner scope、游标/摘要指纹、原文与模型投影分离 | 本地已接线；全量原文保留 |
| 事件与用量 | AgentProgressHook / build_bus_progress_callback | WS鉴权、虚拟路径、public model alias、final_usage | 本地协议/浏览器更新与收尾通过 |
| 计划/目标 | UpdatePlanTool / LongTaskTool / CompleteGoalTool / cmd_goal | /goal真实用户门控、会话持久化、同步事件 | 本地已接线；不新增目标调度器 |
| 追加输入 | WorkTurnController / MessageBus / Runner injection callback | owner队列、幂等poll/ack、停止暂停与重连 | 文本、图片/文件、仅附件、刷新与取消 HTTP/WS 均通过 |
| 恢复 | 共享 checkpoint_recovery 纯函数 | SQLite原文历史、未知状态不重放 | 应用与Host均已委派共享函数 |
| 文件读取 | 应用 ReadFileTool | 沙箱bytes、逻辑路径、文档Linux运行时 | 文本/图像已接；PDF/Office原始解析缺安全运行时时明确 unavailable |
| 子代理 | SubagentManager / SpawnTool / AgentRunner | 批准工具spec工厂、同租户、等待清理、结果注入 | 同一Runner等待与接回结果通过；独立工具/编辑器状态 |
| 账号记忆 | SearchMemoryTool / ReadMemoryTool / MemorySearchTool | 显式 owner memory/history path；无默认HOME回退 | 本地已接，仅 MEMORY/SOUL/events，不伪称笔记与资料已入库 |
| 会话标题 | maybe_generate_webui_title_after_turn | 账号内保存、手动标题保护、短超时 | 本地已接，失败不改变已完成任务 |
| Office/画布/交付 | 既有OfficeTool/CanvasTool/DeliverFileTool及编辑器 | HTTP/WS、版本、范围、隔离执行 | 原已共用；画布故障按后续项处理 |
| 依赖服务 | 应用工具类与统一运行时 | 各用户自己的服务/模型配置；缺失应明确unavailable | 不凭空启用缺凭据/运行时功能 |

## 不采用的捷径

- 不把全量 AgentLoop/ToolLoader 直接实例化到公共服务：ToolLoader 在检查 allowlist 之前会构造工具、还会导入插件 entry points。
- 不在共享父进程按请求切全局 config path；仅独立 owner 子进程使用已经校验的 runtime/config.json。
- 不调用 SessionManager 的硬编码 `Path.home()/.mona/sessions` 迁移，不读取宿主历史。
- 不把 host 路径作为模型可读工作区；不直接使用会暴露 host 图片路径的 offload helper。
- 不为预览调用会 quiesce 沙箱进程的 sandbox.save，不将预览伪称最终交付。
- 不按“PPT”关键词另造强制路由，不把目录相同说成整套 harness 相同。

## 验收要求

先做每个适配范围的必要单测，再做本地真实 UI/HTTP/WS 与隔离依赖联合验收。模拟模型/认证只验证程序分支，不能作为生产推理结果。发布需要真实 Ubuntu 管理连接、原部署/状态备份、完整清单和原服务保护；当前该管理连接未恢复时不得称已上线。

最终应验证：新稿先加载制作Skill并读设计参考，未指定风格先展示样张/等待选择；刷新、取消、重复回执不重问、不重做写入；输出/用量/任务结束与应用一致；账号与工作区隔离、原文历史保留；模型和运行时缺依赖真实提示，不伪造完成。

### 本地联合验收（2026-11-06）

- `test_shared_interaction_integration.py`：真实 create_app/HTTP/WS/SQLite 与问答工具，回答/重连/取消、跨账号拒绝、图片真实落盘和媒体票据 GET、过期/重签及历史无凭据。
- `test_steering_integration.py`：真实 WS 文本/图片/文件追加，空正文、HTTP poll/ack 重试、相同 bytes 幂等导入、历史原 input_id、stop 暂停、刷新不重开执行；跨账号/会话拒绝。图像及文件按真实字节与 SHA 核对。
- `test_shared_protocol_ui_browser.py`：v16 实际前端 + Edge，选项/自定义回答成功收起，PNG 实际加载为 180×100，侧栏计划与目标更新，上下文环 12.5%→5.0%，turn_end 正常结束。报告：`output/hosted-work/shared-protocol-ui-c36ef4a9/acceptance.json`。

上述认证、模型或沙箱执行边缘使用明确测试替身；不是生产推理或 Linux gVisor 验收。Ubuntu SSH 超时阻塞发布，VPS 只读确认旧服务 PID 保持，不把可达性当本候选上线成功。

### 发布构建边界

发布候选以 v15 真实 manifest/归档为基础。当前 Git HEAD 的 ContextBuilder 含其它任务的 interaction 分支、AgentLoop 含其它 channel_turn_end 变更；不能整文件覆盖到生产。共享文件只应用本任务的最小 diff，其余原生产源码保持。已从 v11–v15 归档还原并逐项 SHA 核对 1,278 个 Python/Skill/必要测试基线文件；候选需在此隔离源码上再验收。

候选已完成验证：工作区相关测试 528 项通过、17 跳过，新增首轮图片输入用例另 1 项通过；隔离生产候选先通过 472 项，8 项因测试目录缺少原有空白 Office 模板失败，核对模板 SHA 与生产 manifest 一致并补齐后 8 项通过，新增图片用例再通过 1 项（合计 481）。修的是验收目录依赖，没有修改 Office 代码或模板。两组均仅排除此前 v15 已记录的 Codex `model_pending` 与现有 `billing_unavailable` 闸门错误码旧断言，不改该范围外用例。跳过项目包括显式选择的浏览器/Linux/gVisor资源验收及 Windows symlink 权限；本轮真实浏览器另单独通过 1 项。Ruff 通过。

本地归档 `output/hosted-work/harness-parity-20261106/work-harness-v17.delta.tar.gz`：888,466 字节，SHA256 `61235ab8373bb7d96e3e65a48e02b86181ea175fc55d5b1c29d1721fb777703a`，82 个变更文件、完整清单 5,636 项；82 项实际归档内容逐项核 SHA。完整 manifest SHA256 `56329cccbbf62c6f71211976cff589008e225e8722601b075a4023e8c712e53e`。包内没有前端或 Office 产物变更，VPS v16 静态界面继续兼容。交付记录 `deploy/hosted-work/harness-parity-candidate-20261106.json` 明确 `deployed=false`；尚未执行 Linux/gVisor/真实生产模型验收。

真实风格确认已有完整路径：读 `mona-pptx` 的 native 指南、显式读 `mona-design`，按相对 `assets/` 的路径复制三张 `style-specimens/ppt/*.jpg` 到工作区，逐张 `deliver_file` 后 `ask_user_question`。引用返回给模型的图片不等于用户预览；父任务提问前必须由父任务登记待发图片。当前 Office 的 visual 检查只供模型，原生 export 不支持把文档直接转 PNG，不得仅改扩展名冒充图片。

## 用户追加事项（处理顺序）

当前共用迁移完成后，再处理线上画布保存和导出问题。画布导出必须下载到用户本地，不以服务器生成文件或HTTP 200当作完成。本事项暂不混入当前改动。
