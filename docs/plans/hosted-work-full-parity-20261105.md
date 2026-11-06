# 普通 Work 会话链路共用评估与实施

用户要求：评估所有需要共用的能力并复刻到 Web；复用应用实现，尽量不重构。

更新至 2026-11-06：**harness v17b、v19 素材修正、v20 任务收尾修正均已上线；真实身份会话与 PPT 完整闭环验收通过。** PPT 结论由第三次真实任务的原始执行记录和补充浏览器观察共同确认。前两次任务失败、第三次初验的脚本失败报告均保留，未改写为成功。

范围是普通会话的行为与交互链路，不复制任何桌面用户数据、系统权限或私人凭据。浏览器/终端 UI 继续按用户要求移除；云同步继续关闭。共享的是逻辑和协议，账号、存储、文件执行、网络与通信保留租户适配。

## 已确认的共用矩阵

以下状态区分已发布代码与已执行验收；生产推理覆盖身份会话及下文 PPT 链路，不能将本地测试通过扩大为所有能力均已完成真实模型验收。

| 领域 | 直接共用的应用实现 | Web 必须适配的部分 | 当前状态 |
|---|---|---|---|
| 执行/循环保护 | AgentRunner / AgentRunSpec | 独立可信子进程、取消与预算 | 原已共用，补齐 callbacks |
| 提示/人格 | ContextBuilder、SOUL、tool/capability/skills 模板 | 逻辑 /workspace、隔离记忆/profile、动态上下文 | 已发布，真实 Qwen 身份回答通过；不加后台身份 |
| Skill | SkillsLoader / SkillReadTool / ReferenceReadTool | 内置只读范围、无私人桌面层、沙箱脚本 | 已发布；真实读取 pptx/design，v19 修复素材路径/schema |
| 按需能力 | LoadCapabilityTool / capability ContextVar / registry | 只注册批准工具，不能以加载扩大权限 | 已发布；保留工具注册与授权边界 |
| 问答 | AskUserQuestionTool / UserQuestions / UserQuestionPanel | 账号/会话/活动run、回答回执、停止、重连 | 本地 HTTP/WS/浏览器通过；生产 PPT 真实选择、补充偏好和回执通过 |
| 样张预览 | 原 question_preview 与媒体 UI | 等待前安全下载图像、SHA、隔离存储、短期票据、历史签新票据 | 生产三张 JPG 与内置 SHA 匹配，浏览器自然加载通过 |
| 窗口/摘要 | 目录解析、Session.get_history、Consolidator | owner scope、游标/摘要指纹、原文与模型投影分离 | 已发布；生产窗口为目录确认的 1M，全量原文保留 |
| 事件与用量 | AgentProgressHook / build_bus_progress_callback | WS鉴权、虚拟路径、public model alias、final_usage | 身份与第三次 PPT 均 completed，PPT 工具阶段齐全、turn_end 收尾，保留先前失败 |
| 计划/目标 | UpdatePlanTool / LongTaskTool / CompleteGoalTool / cmd_goal | /goal真实用户门控、会话持久化、同步事件 | 已发布，生产 PPT 已产生计划同步；不新增目标调度器 |
| 追加输入 | WorkTurnController / MessageBus / Runner injection callback | owner队列、幂等poll/ack、停止暂停与重连 | 已发布；文本、图片/文件、仅附件、刷新与取消 HTTP/WS 测试通过 |
| 恢复 | 共享 checkpoint_recovery 纯函数 | SQLite原文历史、未知状态不重放 | 已发布；v20 在完整历史保存后清空 checkpoint，防重复恢复 |
| 文件读取 | 应用 ReadFileTool | 沙箱bytes、逻辑路径、文档Linux运行时 | 文本/图像已接；PDF/Office原始解析缺安全运行时时明确 unavailable |
| 子代理 | SubagentManager / SpawnTool / AgentRunner | 批准工具spec工厂、同租户、等待清理、结果注入 | 已发布；同一Runner等待与接回结果测试通过，独立工具/编辑器状态 |
| 账号记忆 | SearchMemoryTool / ReadMemoryTool / MemorySearchTool | 显式 owner memory/history path；无默认HOME回退 | 已发布，仅 MEMORY/SOUL/events，不伪称笔记与资料已入库 |
| 会话标题 | maybe_generate_webui_title_after_turn | 账号内保存、手动标题保护、短超时 | 已发布，失败不改变已完成任务；保留已有/手动标题 |
| Office/画布/交付 | 既有OfficeTool/CanvasTool/DeliverFileTool及编辑器 | HTTP/WS、版本、范围、隔离执行 | 生产 PPT 制作/保存/导出/交付/最终答复闭环通过；真实下载、编辑器与刷新恢复通过，画布 v18 单独验收通过 |
| 依赖服务 | 应用工具类与统一运行时 | 各用户自己的服务/模型配置；缺失应明确unavailable | 不凭空启用缺凭据/运行时功能 |

## 不采用的捷径

- 不把全量 AgentLoop/ToolLoader 直接实例化到公共服务：ToolLoader 在检查 allowlist 之前会构造工具、还会导入插件 entry points。
- 不在共享父进程按请求切全局 config path；仅独立 owner 子进程使用已经校验的 runtime/config.json。
- 不调用 SessionManager 的硬编码 `Path.home()/.mona/sessions` 迁移，不读取宿主历史。
- 不把 host 路径作为模型可读工作区；不直接使用会暴露 host 图片路径的 offload helper。
- 不为预览调用会 quiesce 沙箱进程的 sandbox.save，不将预览伪称最终交付。
- 不按“PPT”关键词另造强制路由，不把目录相同说成整套 harness 相同。

## 验收要求

先做每个适配范围的必要单测，再做本地真实 UI/HTTP/WS 与隔离依赖联合验收。模拟模型/认证只验证程序分支，不能作为生产推理结果。发布需要真实 Ubuntu 管理连接、原部署/状态备份、完整清单和原服务保护。本次恢复管理连接后已按此边界实际发布，记录见生产进度。

最终应验证：新稿先加载制作Skill并读设计参考，未指定风格先展示样张/等待选择；刷新、取消、重复回执不重问、不重做写入；输出/用量/任务结束与应用一致；账号与工作区隔离、原文历史保留；模型和运行时缺依赖真实提示，不伪造完成。

### 本地联合验收（2026-11-06）

- `test_shared_interaction_integration.py`：真实 create_app/HTTP/WS/SQLite 与问答工具，回答/重连/取消、跨账号拒绝、图片真实落盘和媒体票据 GET、过期/重签及历史无凭据。
- `test_steering_integration.py`：真实 WS 文本/图片/文件追加，空正文、HTTP poll/ack 重试、相同 bytes 幂等导入、历史原 input_id、stop 暂停、刷新不重开执行；跨账号/会话拒绝。图像及文件按真实字节与 SHA 核对。
- `test_shared_protocol_ui_browser.py`：v16 实际前端 + Edge，选项/自定义回答成功收起，PNG 实际加载为 180×100，侧栏计划与目标更新，上下文环 12.5%→5.0%，turn_end 正常结束。报告：`output/hosted-work/shared-protocol-ui-c36ef4a9/acceptance.json`。

上述认证、模型或沙箱执行边缘使用明确测试替身；不是生产推理或 Linux gVisor 验收。该阶段曾因 Ubuntu SSH 超时无法发布，仅做 VPS 只读核对；此为历史阶段，管理连接随后恢复，实际 Linux 与生产验收见下文。

### 发布构建边界

发布候选以 v15 真实 manifest/归档为基础。构建时 Git HEAD 的 ContextBuilder 含其它任务的 interaction 分支、AgentLoop 含其它 channel_turn_end 变更；没有整文件覆盖到生产。共享文件只应用本任务的最小 diff，其余原生产源码保持。已从 v11–v15 归档还原并逐项 SHA 核对 1,278 个 Python/Skill/必要测试基线文件，再在该隔离源码上验收。

候选已完成验证：工作区相关测试 528 项通过、17 跳过，新增首轮图片输入用例另 1 项通过；隔离生产候选先通过 472 项，8 项因测试目录缺少原有空白 Office 模板失败，核对模板 SHA 与生产 manifest 一致并补齐后 8 项通过，新增图片用例再通过 1 项（合计 481）。修的是验收目录依赖，没有修改 Office 代码或模板。两组均仅排除此前 v15 已记录的 Codex `model_pending` 与现有 `billing_unavailable` 闸门错误码旧断言，不改该范围外用例。跳过项目包括显式选择的浏览器/Linux/gVisor资源验收及 Windows symlink 权限；本轮真实浏览器另单独通过 1 项。Ruff 通过。

首版本地 v17 归档为 888,466 字节，SHA256 `61235ab8373bb7d96e3e65a48e02b86181ea175fc55d5b1c29d1721fb777703a`，82 个变更文件、完整清单 5,636 项；82 项实际归档内容逐项核 SHA。随后仅修正测试夹具的 registry 类绑定，形成 v17b，运行时代码无此差异。v17b 包 888,457 字节，SHA256 `3ac2e04b268be85e2f77aec5ddc139e62b40e92ab9933ffad84a4a5af6b632dc`，清单 SHA256 `ce7156d1234da4bf49a88d04d11e5738a6a761d943ec40a0fbf03bca215917a6`。包内没有前端或 Office 产物变更，兼容既有 VPS 静态界面。

[候选交付记录](../../deploy/hosted-work/harness-parity-candidate-20261106.json) 和 [package.json](../../output/hosted-work/harness-parity-20261106/package.json) 中的 `deployed=false`、SSH 阻塞说明属于打包时快照，保留不覆盖；后续上线事实以各版本 activated 及生产验收记录为准。

真实风格确认已有完整路径：读 `mona-pptx` 的 native 指南、显式读 `mona-design`，按相对 `assets/` 的路径复制三张 `style-specimens/ppt/*.jpg` 到工作区，逐张 `deliver_file` 后 `ask_user_question`。引用返回给模型的图片不等于用户预览；父任务提问前必须由父任务登记待发图片。当前 Office 的 visual 检查只供模型，原生 export 不支持把文档直接转 PNG，不得仅改扩展名冒充图片。

## 生产部署与真实验收进度（2026-11-06）

### v17b：已发布，身份会话通过

Ubuntu 管理连接恢复后，5,636 项发布文件核验完成，Linux 必要验收 **203 passed**，仅记录既有 aiohttp 字符串 request key 警告。备份为 `/home/liuzhe/mona-hosted-work/backups/20261106-harness-work-v17b`，原会话、任务和文件记录保留。依据：[Linux 测试](../../output/hosted-work/harness-parity-20261106/linux-tests-v17b.json)、[启用记录](../../output/hosted-work/harness-parity-20261106/activated.json)。

真实 Qwen 身份会话 `60eee046f654bfa627ec08eae6a3de32` 为 `completed`，回答将 Mona 定位为有性格、好奇心与判断力的 AI 伙伴，没有“助手”、online/work 或隔离环境等后台身份标签。真实流式输出、推理结束及 `turn_end` 均收到，最新请求上下文为 **6,606 / 1,000,000 token**，窗口来源 `catalog`。测试网页登录会话已撤销，测试账户余额、预留、活动请求与余额版本均保持 0。依据：[identity-production.json](../../output/hosted-work/harness-parity-20261106/identity-production.json)。

### 第一次真实 PPT：素材复制失败，停止保留现场

`production-ppt` 的真实任务 `06bb7da9e70d5ca739b63a18b3f13bc2` 已依次读取 `mona-pptx`、`mona-design` 及参考资料，但模型按文档使用 `assets/` 前缀时，Hosted 素材适配未按桌面规则兼容，`skill_asset_copy` 失败 6 次，未形成有效样张确认闭环。验收约 90.9 秒超时后发起停止，任务最终为 `cancelled`。

原浏览器报告保留停止前 `running` 快照和停止请求 200，不能将该快照当作成功完成。失败经过与工具参数分别保留在 [production-ppt/acceptance.json](../../output/hosted-work/harness-parity-20261106/production-ppt/acceptance.json)、[素材错误记录](../../output/hosted-work/harness-parity-20261106/first-ppt-asset-errors.json)；[生产汇总](../../output/hosted-work/harness-parity-20261106/ppt-production.json) 保持 `passed=false`。测试登录已撤销，余额和版本未变。

### v19：素材适配已修复并上线，第二次 PPT 部分链路通过

修复复用桌面 `SkillAssetCopyTool` 的完整 schema，并兼容经路径校验的可选 `assets/` 前缀，仍限定已加载的内置 Skill 与当前工作区，不放宽任意文件访问。Windows 必要测试 **20 passed**、Linux **41 passed**。发布只改变 `skills.py` 与对应测试，5,636 项清单不变；备份 `/home/liuzhe/mona-hosted-work/backups/20261106-harness-work-v19`。依据：[v19 包](../../output/hosted-work/harness-parity-20261106/package-v19.json)、[启用记录](../../output/hosted-work/harness-parity-20261106/activated-v19.json)、[Linux 测试](../../output/hosted-work/harness-parity-20261106/linux-asset-fix-tests.json)。

第二次真实任务 `a7dd72b25b4637f3e22ab13b6e8d26d8` 已完成以下实际步骤：

- 读取制作与设计 Skill；复制三张真实内置 JPG 样张，均为 **1200 × 750**，逐张 SHA 与内置素材匹配，浏览器自然加载成功。
- 共用问题面板真实显示并提交一次选择，包含补充偏好，收到成功回答回执。
- 实际制作 PPT、保存、检查、导出，并通过 `deliver_file` 交付。首次导出遇到 `REVIEW_REQUIRED` 后进行了检查，后续导出成功；不是把第一次拒绝当作导出成功。

第二次整轮为 **failed / max_iterations**：第 30 次模型交互执行 `update_plan` 后还没有最终文字答复，Hosted 旧上限 30 使循环停止；普通桌面 Work 默认值为 100。原任务 `workspace_saved=true`，已有文档和交付结果保留，不能据此将整轮标为完成。依据：[production-ppt2/acceptance.json](../../output/hosted-work/harness-parity-20261106/production-ppt2/acceptance.json)、[最终结果](../../output/hosted-work/harness-parity-20261106/ppt2-result.json)、[Office 回执](../../output/hosted-work/harness-parity-20261106/ppt2-office-diagnostics.json)、[生产汇总](../../output/hosted-work/harness-parity-20261106/ppt-production2.json)。

本轮累计用量为 **1,046,951 token**，包含多次请求；最大单次上下文仅 **54,113 token**，最终请求为 **47,320 token**，模型窗口为 **1,000,000 token**。累计计费用量不能拿来判断一次请求是否超窗，此次停机原因是交互次数上限。

### v20：收尾修正已上线，第三次真实闭环通过

v20 将 Hosted 默认值继承普通 Work 的 `AgentDefaults` 100 次交互，生产 operator 配置也显式设置 `max_iterations=100`。完整执行历史成功保存后，再清空该轮 checkpoint，避免结束恢复时重复追加末次工具记录；没有重放未知写入。Windows、Linux 对应必要测试分别 **63 passed**。

[package-v20.json](../../output/hosted-work/harness-parity-20261106/package-v20.json) 记录 607,603 字节增量包，3 个变更文件（schema、turn、对应测试），完整清单 5,636 项：

- 包 SHA256：`43c6616a2da24239fb936acf6bbe09296cf5566e14caa16810a1683416abe688`
- 清单 SHA256：`4307d19bf816bca89c7e85d9d7544897637c52bd0ef061ada5659cf0ffa166ea`
- 备份：`/home/liuzhe/mona-hosted-work/backups/20261106-harness-work-v20`
- 启用目录：`/home/liuzhe/mona-hosted-work/releases/20261106-harness-work-v20/content`

[activated-v20.json](../../output/hosted-work/harness-parity-20261106/activated-v20.json) 确认服务 active、主 PID **580839**、`NRestarts=0`，启动前后 21 个会话、31 个任务、6 个文件记录均保留，配置权限仍为 600。[Linux 收尾测试](../../output/hosted-work/harness-parity-20261106/linux-finish-tests.json) 通过 63 项。Docker PID **78383**、原 8 个容器状态及隧道 PID **423172** 均保持；未修改钱包或 Auth 代码。

第三次真实 Qwen 任务 `351394eb8eb7b8d5534cf16298f71c3b` 已 **completed / workspace_saved=true**，共 42 次模型交互，包含最终答复和 1 次 `turn_end`。48 个工具 start 均有对应终态：40 个 end、8 个 error，错误后经模型调整继续完成，缺少工具终态数量为 0；固定“正在处理任务”帧为 0。执行结果及 `checkpoint_cleared=true` 见 [ppt3-execution-verified.json](../../output/hosted-work/harness-parity-20261106/ppt3-execution-verified.json)。

第三次原始浏览器验收完成了真实 Skill、三张 1200 × 750 内置样张、UI 自然加载、真实选择与补充偏好提交、流式执行及任务结束的记录。随后脚本在没有先切回“概览”的情况下查找文件卡，因界面查找顺序断言失败；[production-ppt3/acceptance.json](../../output/hosted-work/harness-parity-20261106/production-ppt3/acceptance.json) 因此仍保留 `passed=false`。该失败不是将原任务改判为未完成，也没有通过重新发送模型请求掩盖。

补充观察使用 **同一会话、同一 completed run**，模式为 `observe_completed_run`，没有新建任务，`new_model_messages_sent=0`。观察报告引用原报告 SHA256 `27d14b5c1ac6a425fe2accf24bf8bda498b5777f1d7c13261010a83b91f65c18`，保留 `prior_report_passed=false`，并补齐此前缺少的真实 UI 与下载检查：

- “概览”中的交付文件卡可见，真实 UI 文件菜单下载 `mona-product-intro.pptx`，大小 **37,355 字节**，SHA256 `c9b260ff0ccd6906eb4ce1f6a1cddbeb853c246cdb3825c2ee419ef0b248dedb`。
- 下载文件包含 **3 页**，每页分别有 **3、11、9 个原生文字对象**；已恢复的 PPT 编辑器可见 3 页。
- 刷新后编辑器与交付记录保留，没有重放任务、派发工具或再次发送模型消息。
- 补充浏览器检查 `page_errors=[]`、`failed_requests=[]`、`console_errors=[]`。

以上结合原始执行证据，补充 [production-ppt3-observe/acceptance.json](../../output/hosted-work/harness-parity-20261106/production-ppt3-observe/acceptance.json) 为 `passed=true`；[ppt-observe.json](../../output/hosted-work/harness-parity-20261106/ppt-observe.json) 汇总为 `passed=true`、`browser_passed=true`、真实认证/真实模型、未模拟响应。测试网页登录会话均已撤销，测试账户余额、预留、活动请求和余额版本均保持 0，`wallet_unchanged=true`。

第三次累计用量为 **1,415,890 token**，其中累计缓存 token 为 **1,128,832**；最终请求上下文及本轮最大单次上下文均为 **53,962 token**，模型窗口仍为目录确认的 **1,000,000 token**。累计用量跨 42 次请求，不能与单次窗口混同。至此，从 Skill/样张/真实回答到制作、保存、导出、交付、最终答复及 `turn_end`，加上真实下载与刷新恢复，生产闭环验收已通过。

## 画布追加事项

线上画布保存和本地导出已作为独立 v18 静态发布处理，并完成真实普通账号验收：快速切换后保存/刷新保留，四项真实浏览器下载通过，PDF 仅确认打印内容，未扩大为系统打印对话框或用户手动保存已验。详见 [画布修复与生产验收记录](./hosted-work-canvas-fix-20261106.md)。该静态验收不替代上述 harness 的真实模型闭环。
