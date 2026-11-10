# Mona 线上工作台：独立宿主与共享会话界面

网页与桌面执行能力的实际差异、必要隔离理由及待对齐项见 [执行差异清单](hosted-work-parity.md)。

## 2026-11-06 会话执行链共用边界（v20 已部署并验收）

普通会话共用应用的 `AgentRunner`、`ContextBuilder`、`Consolidator`、能力按需加载、内置 Skill 模板、`UserQuestions`/提问工具、计划/目标工具、`WorkTurnController`、`SubagentManager`、恢复投影和标题生成。Hosted 仅适配账号、逻辑工作区、持久化和 HTTP/WS；不是另一套模型循环。共享类新增的依赖注入参数均保留桌面缺省行为。

`ContextBuilder` 的记忆与 Skill 加载器显式注入。每个账号的可信子进程只在已经校验的 `state/users/<owner>/runtime/config.json` 下构造记忆；禁止父进程切换全局配置、构造默认 `SessionManager` 或调用桌面 vault 回退。摘要游标与前缀指纹在专表保存，原文历史和模型投影分开；动态 Office/附件信息放在 user runtime context，单轮 system prompt 保持稳定。记忆搜索只连接本账号已有 MEMORY/SOUL/events；笔记、资料库与全会话索引未接入时明确 unavailable，不把网页附件当成已入库知识。

问答、预览与追加输入绑定 owner/session/run。预览先下载并核对真实图像字节，存入隔离预览目录；短期媒体票据只在请求时生成，历史只存逻辑路径。重复问答/输入批次保持幂等；取消、未知状态或服务重启不自动选答案、不重放写入。子任务共用同一个 Runner，结果作为 runtime 注入返回主任务；每个子任务有独立工具/能力集合和编辑器状态，主任务结束前核对真实退出和交付。

模型用量展示取最后一次请求，累计用量继续保留独立字段。Widget 的 streaming 仅发送空代码；完整代码通过原共享校验后才显示。上下文、文件编辑、计划、目标与结束均沿应用原协议更新现有 UI。发布状态和必要验收见 [实施清单](../plans/hosted-work-full-parity-20261105.md)。下文旧版本“当前”属于记录当时，不能代替根目录最新生产状态。

执行轮数缺省值取 `AgentDefaults.max_tool_iterations`（当前 100），不另设网页 30 轮上限。完整执行历史成功持久化后清除临时恢复 checkpoint，与应用 SAVE 阶段一致；中断或结果未确认时保留恢复证据，不自动重放写入。素材复制复用应用 `SkillAssetCopyTool` 的完整 schema，复制 I/O 留在沙箱适配边界，兼容素材引用中的 `assets/` 前缀并校验只读内置来源、实际文件、链接/大小及目标范围。与应用一致，复制公开内置依赖素材不额外要求其所属 Skill 被单独 `skill_read`；执行脚本仍要求对应 Skill 已加载，私人目录仍禁止。v21 已修正这一额外门槛，并验证三张真实样张同时可见。

生产验收已完成真实 Qwen 样张/面板选择/三页原生 PPTX/UI 下载/刷新恢复；此前失败和只观察同一完成任务的补充证据均留档。画布静态前端 v18 同时保留原共享编辑器，只修请求版本竞态、退出前尚未发出的自动保存、浏览器本地下载和 PDF 打印 CSP，未重建 Office。当前后台/前端目录与 PID 以根目录两份生产文档为准。

2026-11-05：生产已切至 v10，共享会话仍复用第 11 节所列桌面原组件。网页隐藏新对话欢迎右块、猫形提示词入口和左下退出按钮，桌面保留；Office 465 个产物与 v8 逐字节一致，未重新构建或修改。Ubuntu 当前 release 为 `/home/liuzhe/mona-hosted-work/releases/20261105-skills-ui-v10/content`，PID `34615`；VPS 继续使用 v9 静态 root `/var/www/mona/work-releases/20261105-skills-ui-v9/content` 的 3,890 个文件及原代理，Nginx master `420299` 不变。v10 仅修改 executor 的 Widget 事件白名单和对应测试，前端、Skill 与 Office 均与 v9 一致。

v9 包含 13 套内置 Skill、761 个资源，支持发现、按需读取、引用、真实样张、素材复制与隔离脚本；不读取私有/专家/用户配置，也不引入 ContextBuilder 或 memory(always)。当前网页工具可支持 Word、Excel、PPT、画布、设计、PRD、visualizer 共 7 套；PDF、生图、视频、记忆、长期目标和 Skill 私有安装缺对应工具服务，不能宣称 13 套全部可执行。设计仅支持参考和 Office，浏览器自动操作尚未接入。高级脚本要求 Python >=3.13，实时公开 runtime catalog 仅登记 Windows 基座；Linux 依赖缺失时返回 `runtime_unavailable`，不回退宿主。

可视化沿用原 `show_widget`、MonaClient 事件和 iframe；网页加载独立固定 bootstrap，公开内容不含用户代码或凭据，主页面 CSP 未放宽、iframe 不允许 same-origin。真实本地浏览器计数器交互和父 DOM 访问拒绝已通过；标准库案例检索也已在真实 gVisor 执行，素材 SHA 一致、容器精确清理。Linux 关联测试 16 项、Windows UI 7 项、Widget 6 项、后端路由 28 项通过（另 1 项跳过），DI 6 项、Wire 3 项和类型检查、独立构建通过。

真实公网 Qwen 联合验收 `output/hosted-work/skills-ui-20261105-v1/production-v2.json` 的 `passed=true`：真实 Skill 发现和读取、Widget 计数器 0→1 与刷新后交互、素材复制交付 SHA 校验、另一账号 404 和退出后 401 返回登录均通过；测试令牌均撤销，钱包余额与版本保持 0，页面异常和 HTTP 失败均为 0，只有两条新模型消息。v9 首次 Widget 因白名单拒绝的失败记录保留；对应自有任务确认容器/进程结束后离线结束追踪，状态 `interrupted`、结果仍未知且未重派。v10 只增加 Widget 白名单项，未知事件仍拒绝，新增 executor 4 项回归在 Windows 和 Linux 均通过。提交 `d6d26b421`、`f6be94e49`、`9c0e81b03`、`8671ffbf1`。

最终无活动或 unknown 任务、未确认文件操作及额外 Work 容器；Docker、原 8 容器、Work 隧道和 VPS 原服务保持，其他站点配置未变，3,890 个静态文件再次验 SHA 通过。v9 切换前 12 会话/18 任务/5 文件字段与备份一致，验收后为 14/22/6；唯一 `interrupted` 为已核对的上述失败验收任务。

## 2026-11-05 v8 验收（历史）

v8 当时仅调整 Hosted Office 对重复且同值的顶层 `mode` 的兼容、工具说明和对应回归；前端产物与 v7 逐字节一致，VPS 静态目录沿用已验的 v7。

v8 的 Qwen 共享工作台发布验收已完成。真实 v6 已验证任务结束、Mona 人设回答，以及 Word 人工和 AI 编辑、保存、导出、恢复，相关 Word 产物此后未改；v8 实际验证 Excel 读取 `[6,7,42]`、公式导出和刷新重读，PPT 模型编辑和导出，思维导图保存恢复、执行中停止、跨账号隔离和退出撤销。v8 验收未发现页面异常或 HTTP/请求传输失败；控制台有 16 条 Univer 隐藏布局宽度日志，未阻断内容、导出或恢复。测试令牌均已撤销，测试钱包余额及版本保持 0；当时未重测密码登录或桌面成品。2026-11-04 的管理网络中断和 v6 未切换是历史状态。

v8 最终复核原有 8 个容器的 ID、状态和启动时间及其他服务的 PID、启动时间均保持，无额外 Work 容器；切换前 9 个会话、14 条任务、5 条文件字段与备份一致，验收后为 11、18、5，未留下运行中或未知任务及未知文件操作。自有候选单元已停止并保留状态；不接云同步，付费 Codex 和微信网站登录仍未开放。

## 现行架构与决策

更新：2026-11-03。最新决策：Qwen 免费且不设置个人账号白名单；Codex 使用 Ubuntu 平台专用账号，按对应模型官方 Token 单价扣网站和客户端共用的 Mona 余额，不另建钱包。该决策取代此前“Work 只复用认证、不接钱包”的限制；任务、文件、模型凭据和执行环境仍独立，订阅、支付、云同步与桌面设备逻辑不变。

2026-11-06 v34 已接入 Codex 执行和共用钱包结算，并完成真实账户扣费验收；其他 wallet 来源仍未接通，不能按免费回退。Ubuntu/gVisor 已通过实机隔离验收；不将存活状态等同于任务或计费已完成。默认示例关闭，桌面更新不会启动在线服务。

2026-11-03 的后续开发直接复用桌面普通会话和右栏组件，增加账号私有 Office、画布存储与浏览器传输适配；当时按用户要求仅开发和本地验证，后来已于 2026-11-05 发布，云同步仍未接入。下文旧日期的生产验收记录对应各自当时版本，共享界面的实际边界见第 11 节。

## 1. 范围与运行方式

官网仅提供基本 Work：账号登录、会话、平台模型选择、文本与附件输入、执行进度、停止和文件交付。不开通开发、运维、邮件、笔记、桌面操作或其他模块；用户不能提交 API Key、自定义端点、原生引擎目录、宿主命令或身份字段。

调用链：工作台公共 HTML/资源由 VPS 已验 release 直供；`/api/work/` 与动态 Widget → Work 专用反向通道 → Ubuntu `172.31.3.176:17175` → 独立可信执行宿主 → 用户 gVisor 工具沙箱。账号与隔离工作数据仍由 Ubuntu 接口提供，认证继续使用 VPS Auth。官网只需入口与目标转发，无需嵌入原业务进程。业务依赖限于现有用户认证及收费线路的共享钱包计费，不访问 Pro、设备、同步、支付或后台任务接口。

模型调用留在可信宿主，使用在线 Work 自己的运营凭据，不向上游模型传递用户账号令牌，也不把模型密钥放进用户脚本环境。工具请求只能回到固定工具表，公共网页读取经过受控 HTTP 入口。每账号身份只从 Auth 的只读 `/auth/identity` 返回值派生，不接受前端指定 user_id；付费模型另需服务端余额准入，不能由前端标签决定收费。

每轮使用独立 Python 宿主和用户容器；可信控制面并非运行在不可信容器里。同一账号任务及文件操作串行。工作区快照、会话和 runtime 数据按账号隔离；同一账号不同会话共用其工作区。平台同一原生账号配置串行，未知结果保留占用，不在另一用户处重用未知执行。

复用现有 AgentRunner、工具协议、检查点和流式钩子，不启动完整桌面 AgentLoop 的模块发现。基础 Work 固定工具为 list_dir、read_file、write_file、exec、web_fetch、deliver_file；共享界面入口按明确的 desktop_ui 上下文注入原 CanvasTool、OfficeTool 与 Widget 能力，并按本页顶部的范围接入内置 Skill 资源与隔离脚本。不宣称迁移了完整桌面 Skills、长期记忆或浏览器自动化；镜像中未安装的工具不能冒充可用。

## 2. 桌面兼容边界

v20 已接入共享提问工具、回答/重连快照、安全样张、上下文与恢复投影，v21 继续对齐公开内置依赖素材复制。共享执行循环仍不代表全部外部依赖已可用：用户工具与文件保留 Hosted 沙箱适配，缺失的解析运行时、模型服务及检索服务按实际返回不可用。私人 Skill 层仍禁止，内置脚本仍需先加载对应 Skill。

桌面入口、Gateway/Services、工具授权、原生账号及既有数据目录不变。新增配置只有显式启动在线宿主才使用，桌面不自动生成用户容器。

执行侧共用通用 AgentRunner、Provider 和工具协议代码，任务和文件状态独立；账号余额及收费流水由同一个 Auth 钱包负责。HostedWorkConfig 虽定义在统一 schema 中，但不挂入桌面 Config，不会进入桌面设置保存和同步。NativeWorkProvider 的 native_home 是显式可选参数，未指定时保留桌面原行为。在线网页有独立 HTML、Vite 配置、缓存和输出，发布时固定通用源码版本。桌面或在线服务任一侧升级，不要求另一侧同时升级。

## 3. 沙箱与存储

仅支持已配置 Docker + gVisor runsc 的 Ubuntu/Linux。镜像必须是明确 SHA-256 image ID 或仓库 digest。启动先检查运行时和镜像，禁止自动 pull、降级 runc 或回退宿主 shell。

容器非 root、只读根文件系统、无附加 capabilities、no-new-privileges，并限制 PID、CPU、内存。不得挂载宿主目录、平台配置、认证目录或 Docker socket。用户只可写 /workspace 和私有 /tmp，系统程序和运行库按需只读。默认工作区 64MiB、单文件 10MiB、单条命令 120 秒、任务 900 秒、全局并发 2，均由服务端配置。

脚本容器使用 network=none，既不能访问私网，也不能直接请求公网或安装网络依赖。公共网页由 web_fetch 读取：只允许 HTTP(S) 标准端口、拒绝 URL 凭据、每跳验证、连接解析器拒绝非公网 DNS 结果、禁用环境代理与 Cookie。回环、私网、链路本地、双栈及 IPv4 映射 IPv6 等边界必须测试。该入口不提供任意网络写操作。

工作区使用有界 tmpfs。保存前停止残留用户进程，在容器中生成只包含普通文件/目录的有界 ZIP；宿主只保存不透明字节，不在宿主解压。下一轮在新容器中恢复。链接、特殊文件、过多文件或保存失败不能标为成功；保存失败保留旧快照。

上传、下载和交付核对账号、会话、精确文件身份与内容摘要。交付必须在工作区保存后重新校验。旧文件被后续任务修改时，旧下载记录拒绝返回错误版本，需要重新交付。上传文件先有安全保存结果再写入公开文件记录。

## 4. 平台模型与账号

平台配置 hosted_work.models；客户端只接收已开放且执行条件满足的模型 ID、显示名、来源。每个模型独立保存 `enabled`、计费方式和价格；旧模型缺省保持开放，新条目缺省关闭，从关闭到开放必须先配置价格。运行配置在派发时冻结并通过 stdin 传递，账号令牌不进入命令行、数据库、工具结果或持久日志。

认证：在线服务的 `/api/work/auth/login` 和 `/api/work/auth/logout` 分别代理 `/auth/web/login` 和 `/auth/web/logout`，不创建第二套账号。每次受保护请求调用 `/auth/identity` 验证真实用户及撤销；该接口只返回 account_id，不返回余额/订阅/设备信息。收费由独立 sidecar 同时校验服务密钥及网站会话，再由原 Auth 确认身份；不扩大通用身份接口、绕过桌面设备鉴权或向网页开放结算权限。

自定义 API：平台在独立配置中填写 api_base，并通过名称以 `MONA_WORK_MODEL_` 开头的环境变量提供运营 API Key。凭据缺失直接拒绝，不读取桌面 API Key 或旧 model-token。不得把账号服务旧 `/v1` 网关重新配置为在线模型入口。自定义 API 和 Codex CLI 均由管理员配置 `billing_mode` 与独立 `price`，来源不决定是否免费；新配置缺省 wallet，管理 API 要求明确计费方式。既有 Qwen 用户指定的免费状态显式保留。

此前撤销的 `/internal/hosted-work/model-token`、节点密钥与模型鉴权例外没有恢复。新增收费边界必须基于真实生产源码独立审阅，不能因用户同意共享钱包而恢复旧例外或发布其他任务的 Auth 修改。

Codex/GPT 与 WorkBuddy：复用 NativeWorkProvider，WorkBuddy 内部 ExecutorId 仍为 codebuddy。平台提供专用、已认证的受管原生目录和配置，不能使用用户工作区或把整个宿主 HOME 暴露给容器。原生内置文件/命令/MCP 工具保持禁用，只允许 Mona 工具回调；原生认证根与用户 runtime 数据分离。

当前 Codex 平台账户的 `CODEX_HOME` 仍由所有 Work 用户共同使用，原生会话文件和状态数据库没有按 Mona 用户物理分区。用户工作区、Mona 记忆及工具调用各自按用户限定，但不能因此声称 Codex 原生状态已完全隔离；上线多用户服务前必须补齐原生状态隔离并实测。Web 暂不提供用户自定义 Skill 和 MCP 配置；公开内置 Skill 以只读方式共享，其脚本在用户的 gVisor 工作区执行。

2026-11-07 生图使用同一内置 `image-generation` Skill 与桌面 `generate_image`/Codex 图片供应商，Hosted 只增加账号工作区、受限网络、父进程凭据和图片交付适配。管理员独立设置每张价格，预留金额等于该价格；只有一张已核验、已持久保存且有 SHA256 回执的图片才能结算。图片、历史记录及票据按 owner/session/run/operation 校验；结算未确认时不开放读取，已有请求绝不重派。真实 Codex 上游单图已验证，真实网页钱包闭环仍待余额足够后验收。该线路使用非公开接口，官方托管支持及授权未确认。

Codex 专用账号、工具封锁及真实用量结算已在 Ubuntu 验证；模型目录不等于每个模型都具有调用权限，接入也不等于已证明公共使用授权。Ubuntu 配置见 [两条模型线路配置](../guides/hosted-work-two-providers.md)。

收费仍应复用 Auth 人民币钱包、预扣、结算与流水；不新增充值或第二套余额。工作台模型价格独立于应用价表，须在派发时冻结本次价格快照并留存版本，未来计费桥不能回查应用模型价表或信任浏览器上报金额。官方美元单价需明确模型、计费档位和换算口径，不能直接当人民币使用。只按上游确认的真实输入、缓存输入和输出 Token 结算；缺失、重复、迟到回执，取消和进程退出必须保留可核对状态，不能把缺失用量当零、重复扣费或自动退款。当前用量聚合与任务终态不足以证明上述条件，计费适配及真实验收是收费上线前置。

每次模型迭代和工具执行前重新核对账号身份；撤销后拒绝新的操作，已开始的外部模型调用不能被宣称已经撤销。

### Office 工作区图片与视觉检查

网页 Office 的用户 `assetPath` 属于该轮隔离工作区，不能直接映射为宿主 `documents` 中的文件。适配层须通过同账号、同轮次的沙箱下载接口核验路径、大小与摘要，转为共享 Office 接受的图像数据；主、子任务使用相同工作区。已由 Office 管理的账号文档资产沿用其既有受限目录，不能扩展到宿主其他路径。

PPT 视觉检查由真实编辑器 SlideCanvas 生成并绑定文档版本。捕获等待真实画布挂载、图像与字体就绪后同步绘制，不能依赖后台标签可能暂停的动画帧；资源未就绪须在现有请求超时前返回明确失败并清理临时节点，不能将空白或未完成画面算作已检查。

Office 的“保存”保留编辑器工作副本，“导出”生成命名文档。模型导出时，Hosted 适配层须将账号文档区中已导出的字节写入本轮真实 `/workspace`，校验路径、大小和 SHA256，再沿原有任务收尾流程保存工作区快照并核对交付文件；不能只将宿主 `documents` 的逻辑路径当成文件已在用户容器内。重复导出同一路径使用已观察摘要保护覆盖，最终交付核对该路径最新版本。写入未确认时保留文档副本并明确失败，不报告工作区保存成功。

## 5. 连续性、停止与人工核对

发送、创建会话、上传均使用稳定请求 ID。相同 ID 相同内容只观察原结果，不重复执行；换内容拒绝。刷新、断线和关闭浏览器只影响观察，不重新派发任务，也不自动停止服务端执行。

进度是持久、有序、有界事件，通过游标按需读取，文字逐段呈现。任务在工作区保存和容器结束确认后才报告完成，模型说“完成”不是状态依据。停止精确作用于原执行，等待原生 Provider 和沙箱清理。

响应丢失、进程退出但没有有效终态、清理结果不明时记录 unknown，并阻止后续执行。重启把原 running/cancelling 标为 unknown，不从头运行。未知文件操作同样持久化并保留资源占用。网页显示可采取的核对动作，不静默重试。

执行结果和计费状态分别持久化。模型调用失败、正常完成及用户取消保留各自真实结果；缺少用量或结算回执不能覆盖回答、失败原因或将已结束执行改成 unknown。账务继续保留原预留与真实用量，由既有恢复循环核对，不估算补扣或重派模型。取消回执不等待账务网络；余额不足的准入错误仍明确反馈。

Web 点击停止不展示“停止结果待核对”或“不支持停止”弹窗。停止立即向本账号、本轮固定身份的执行进程组发送终止信号，2 秒内未退出则强制结束；同时取消所属会话的编辑等待、待发输入和可取消的图片请求。进程组与对应隔离容器已结束即可记录 cancelled，未确认的历史副作用与账务保留，不宣称文件回滚或任务成功。强停可能未完成本轮工作区快照，只能保证此前已保存内容保留；不得将它标成保存成功。清理失败保留原进程身份和句柄，再次停止继续结束同一执行，不因丢失句柄而永久卡住。已有 unknown 轮次只在原执行清理确认后转为 cancelled，保留原检查点和历史且不再次投影或执行。轮次标识尚未到达时，停止意图只等待匹配输入的原轮次，不错停其他任务、不重发原输入。

正文分段沿用共享进度钩子的真实 `stream_end` 回执及其续接语义，经 Hosted 协议传给同一会话组件；不同答案段保持不同流身份。只显示真实收到的文字、思考和工具事件，不为掩盖模型失败生成虚构过程。

Codex 的请求投影复用共享原生历史打包器。完全相同的图像块只传一次像素，后续位置以明确编号引用；不同字节或不同 detail 的图像继续完整传送，原始消息与文字不修改，不以去图重发未知请求。此规范化不等于已证明上游某次 HTTP 400 的唯一原因。执行诊断保留受限格式的供应商错误码，不记录原异常正文、认证材料或提示词。

Hosted 原生初始化在创建绑定前失败时，尚未走到模型发送边界，可确认本次新增模型用量为零，并沿现有钱包结算释放该次预留。绑定建立后的失败仍按真实回执结算，缺失用量继续待核对；不将“启动失败”一概当零，不自动改写旧未确认账务。

历史和检查点的内联图片按账号及原始 data URL 摘要存入工作台 SQLite 的 `history_media`，记录中保存受账号约束的内部引用，使用前校验并逐字节还原；摘要指纹仍基于原始内容。非图片历史和图片展开量分别有界；默认每账号媒体存储 1 GiB、单次展开 32 MiB。保存和引用更新同事务，删除会话仅回收确认不再被本账号其他记录引用的图片，活动或未知任务期间跳过回收。旧内联历史在后续安全写入或离线核对时无损迁移。

停止须同时作用于对应账号和轮次的执行子进程及仍在请求阶段的生图任务；已经开始的上游请求若没有明确终态，账务与结果仍保持待核对。生产 Linux 通过固定并校验身份的 pidfd 进程组处理残留，不能对复用的数字 PGID 发杀信号；删除会话须等待该轮进程、图片请求和父任务结束。已派发的远端请求没有终止回执时，不能保证上游立即停止计费。

使用本版本写入媒体引用后，禁止直接切回不支持该格式的旧版本或恢复旧数据库。只有服务停止且无活动/未知任务时，才可使用 `python -m mona.hosted_work.history_media_rollback --config <配置文件>` 原子还原；若还原结果超出旧版容量，工具会拒绝，须保留新版本并另行处理。

离线运维入口：`python -m mona.hosted_work.reconcile --config <配置文件>`，默认仅列出未知记录。改变状态必须先停止本在线服务及其拥有的原生进程，核对工作区结果，再提供精确 owner/kind/id、说明和 `--apply --confirm-executors-stopped --acknowledge-unknown-result`。

核对工具要求服务锁、用户执行锁空闲，并成功确认原容器不存在。它不删除其他进程、不重新执行任何请求。处理后保留审计，语义是“跟踪结束、原结果仍未知”，不会改为成功。没有公网解锁接口，禁止直接删除数据库行绕过核对。

## 6. 文件与部署入口

VPS 提供无账号数据的 `/work/`、`/work/hosted-work.html` 和公开资源；v24 起 `/work/admin/`、`/work/hosted-admin.html` 同样直供该 release 的独立 `hosted-admin.html`，不能误指向普通会话 HTML。沿用原 CSP/no-store，前端发布与 Ubuntu API 可独立进行。各 HTML 入口和 assets 必须指向同一已验证静态版本并保留旧 hash。动态 `/work/widget-frame.html?channel=...`、管理 API、账号 API 和 WebSocket 仍由 Ubuntu 处理，不把动态 Widget 模板直接当普通静态页面提供。浏览器/终端按用户要求在 Hosted 新建菜单隐藏，桌面保留。

网页普通 Work 继续直接使用共享 `AgentRunner`，进度 Hook 继承应用 `AgentProgressHook`，通道适配只负责将推理、回答、工具与 Widget 转成既有桌面事件；保留真实 call/turn/input ID，不另造核心循环或逐轮固定提示。参数做有界展示，工具原始结果只保留在执行历史中，不重复塞入进度。失败关闭已有流并显示安全原因，unknown 不重派或伪装完成。

窗口统一使用 `resolve_model_context_window_details` 与应用供应商目录。Hosted 不读取个人配置，不走桌面 IPC；已知目录标记已知，未发现时保留统一默认来源。旧 `context_window_tokens` 仅兼容为额外输入预算 cap，默认不再套用 32768，不能把运营 cap 当模型容量。任务结果中的 diagnostic 与父进程告警仅记录原因、阶段、异常类型、窗口来源、单次占用峰值及 HTTP 状态，不记录凭据、正文或原始 stderr。

Office 导出已沿用应用的交付协议。对同轮再次 `deliver_file`，适配器只命中当前 scope 中已登记的逻辑路径/大小/SHA，重新核对后复用 `DeliverFileTool`，由同一 bus 去重；临时 workspace context 必须恢复，核对间变化仍拒绝。同名未登记文件不得借账号文档根旁路交付，继续原 gVisor 生命周期；不同会话或新轮次不继承该登记。核心 Office 与全部编辑器产物保持共用。

Codex 管理页为 `/work/admin/`，API 为 `/api/work/admin/codex` 及 `/probe`，每次都通过原 Auth `/auth/identity/admin` 验证管理员。服务入口显式注入可信配置路径，网页不能选择运营配置或凭据位置。`HostedCodexSettings` 保存连接与独立价格草稿；保存采用原文件摘要版本校验、受限备份及原子替换，不改变公开 `models`、Qwen、认证或用户状态，不触发重启。

v25b/v26 管理页只提供“自定义 API”“Codex CLI”，共用模型参数与计费表单，独立 `h-full overflow-y-auto` 滚动区域不修改桌面全局样式。`/api/work/admin/models` 管理 `HostedWorkModel` 已定义的 `source=mona` 线路；只接收密钥环境变量引用，拒绝未载入凭据、其他来源覆盖、旧版本及活动/未知任务期间保存。与 Codex 草稿共用版本和文件锁，原子写入后在无 await 的空闲临界区更新共享运行配置；恢复页面焦点时刷新公开模型设置，不覆盖已派发任务参数。供应商 URL 全量校验 DNS 公网地址并固定实际连接 IP，保留原 Host/TLS SNI，拒绝重定向与跨 origin；只允许保留已有受控字面回环 origin，不开放新内网地址。

v29/v30 管理页按供应商返回的模型逐项管理开放状态和价格，不要求手填模型 ID，也不展示推理强度；旧配置中的推理参数兼容保留，不由界面覆盖。自定义供应商通过仅管理员可调用的 `/api/work/admin/models/discover` 请求自身 `/models`，服务器使用已载入的环境变量凭据，沿用 DNS 全量校验、固定连接 IP、TLS 主机名、响应大小及无重定向边界；列表缺失、分页不完整或格式无效时明确失败，不伪造模型。历史模型通过连接与上游模型 ID 关联，保留原平台 ID；目录未返回的已配置模型仍可关闭。每项价格/开关单独保存，未保存草稿不影响运行。

Codex 模型在工作台注册表逐项保存开放状态和独立价格，v34 已接通执行及共用钱包。管理页读取专用 CLI 目录的缓存时标为未验证；管理员主动检测连接且认证/协议/隔离检查通过后，使用 CLI 实际返回的 `model_details`。模型目录不等于已核实逐模型调用权限。同一配置修订上更新单个模型时保留既有已验证目录；CLI 连接配置改变时失效。按 [OpenAI App Server 认证说明](https://learn.chatgpt.com/docs/app-server#auth-endpoints)，托管或商业服务不使用 App Server 内置认证；管理页未接入网页认证或展示登录命令。

价格由管理员直接保存到工作台 `HostedWorkPrice`，每个模型独立存输入、缓存输入、输出的人民币/百万 token 精确十进制字符串；空值表示未配置，零是明确价格。模型设置不读取或修改 Auth 的模型价表，旧 `billing_model` 仅为兼容保留；旧客户端省略 `price` 时不能擦除已保存值。Codex wallet 经服务端预扣和真实用量结算，其他 wallet 来源仍拒绝派发，不能回退免费。`model_policy` 同时约束公开列表、设置与已保存选择恢复、父进程准入和 provider 构造。已接受请求先观察原结果，不因后续策略变化重派。

Codex 管理页每 10 秒只读检查可信系统、npm、nvm 和固定运营目录；发现程序后在内部预填未保存路径，不在页面显示路径，不执行程序、不读认证文件、不覆盖已配置路径。失效且发现新程序时由管理员显式选择并保存。npm 旧 `vendor/<triple>/codex/codex` 和新版 `vendor/<triple>/bin/codex` 沿用共享解析器及包名、路径和执行权限校验。发现文件不代表登录、协议或任务执行已验证；连接检测仍使用专用 home、空 cwd 和原生协议，不执行模型任务、不伪造模型缓存。

2026-11-06 v32/v33：模型改为单行开放/设置交互，未定价模型首次开放须先填写价格。`HostedCodexSettings.local_proxy_url` 可选，仅接受带端口的 HTTP 字面回环地址；v34 将其注入 Codex 的独立任务进程，Qwen、Work 主进程和其他服务不受影响。生产连接检测读取到 8 个目录项，目录本身不代表逐模型调用权限。

- `mona/hosted_work/`：在线 API、会话状态、可信执行宿主、模型/工具适配、沙箱、人工核对。
- `mona/config/schema.py`：唯一显式配置定义。
- `webui/src/hosted-work/`、`webui/hosted-work.html`、`webui/vite.hosted.config.ts`：独立网页。
- `deploy/hosted-work/`：默认关闭的配置样例、工具镜像 Dockerfile、人工审核的 systemd 材料。
- `tests/hosted_work/`：协议与真实 AgentRunner 回归、显式 opt-in 的 Ubuntu 隔离验收。
- `mona-auth/app/routers/identity_router.py`：认证侧的通用只读身份接口。官网账号的完整认证变更见 `website-accounts.md`；生产候选必须基于当前线上源码构建，不发布其他任务未提交的 Auth 源码。

通过 frontend_dir 指定独立发布包内网页目录；服务自己提供 `/work/`、受限 assets 与 CSP。`/healthz` 只说明进程存活，并明确 models_configured；不证明认证/推理已联通。允许模型表为空的待配置服务启动，但无法提交模型任务。公网只转发 `/work/` 与 `/api/work/`，无需更改原 `/auth`、`/v1`、支付或同步路由。禁止代理整个桌面 Gateway，不暴露 Docker/Tauri/引擎端口，不开放跨站 CORS。

现有 Snap Docker 的 gVisor 已通过管理员授权安装和路径修复。OEClaw 与 Qdrant 的 4 个容器继续运行，Mona 的 4 个 Worker 容器已按独立审计暂停。日常在线 Work 发布只切换自己的不可变 release 与用户级 systemd 服务，不再次运行安装脚本、不重启 Docker、不触碰原 Worker/Relay/数据库。共享的是宿主硬件和 Docker 基础设施，资源仍需限额；不是宣称物理机器完全隔离。

## 7. 验证命令与发布准入

Mona 根目录：

```text
.venv\Scripts\python.exe -m pytest tests/hosted_work tests/development/test_work_native.py tests/development/test_work_native_images.py -q -rs
.venv\Scripts\python.exe -m ruff check mona/hosted_work tests/hosted_work mona/config/schema.py mona/providers/native_work_provider.py
```

webui 目录：

```text
node node_modules/vitest/vitest.mjs run src/hosted-work --exclude .tmp-verify/** --maxWorkers 2 --minWorkers 1
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json --incremental false
node node_modules/vite/bin/vite.js build --config vite.hosted.config.ts
```

Auth 测试必须使用临时 cwd、临时 SQLite、随机测试 JWT secret、隔离 MONA_AUTH_* 环境运行 test_identity.py、test_desktop_sessions.py、test_account_token_revocation.py；不加载生产 .env，不混淆主仓库与 Auth tests 包。

真实 Linux 验收为 tests/hosted_work/test_linux_sandbox.py：只有显式设置 MONA_HOSTED_SANDBOX_SMOKE=1 和已存在的 MONA_HOSTED_SANDBOX_IMAGE 才执行。它核验非 root、宿主文件不可见、系统写入拒绝、IPv4/IPv6 网络拒绝、两用户工作区隔离、快照恢复和精确清理，不安装或 pull 软件。Windows 跳过必须报告，不能把参数构造测试称为操作系统隔离验证。

上线前仍需真实认证接口、在线服务自己的模型来源/运营配额、Codex/WorkBuddy Linux 工具封锁、官网转发及浏览器下载/停止联合验收；Codex 还需共享钱包正常结算、余额不足拒绝、重复请求幂等及异常用量核对验收。另需确定磁盘总配额、备份、历史数据保留及容量压测。第一版满载明确拒绝，不提供无限排队或自动扩容，不能未经压测承诺公网用户容量。

## 8. 内网直接访问与浏览器验收（2026-10-30）

独立服务默认仍监听 loopback；运营可显式指定 bind_host 为单个私网接口，例如 172.31.3.176。禁止通配监听 0.0.0.0 / :: 和公网地址。public_origin 必须匹配实际浏览器入口；内网 HTTP 需要显式 allow_insecure_lan_http=true、固定私网 IP 和一致端口。该选项只适用于可信内网，HTTP 不提供链路加密；公网正式访问继续通过 HTTPS。账号上游仍使用 HTTPS，不能降低 TLS 校验。开放网页的入站接口不会给用户工具容器增加出站网络权限。

网页 HTML、JS、CSS、字体及 favicon 不依赖登录；它们不会因浏览器携带 Origin 而返回鉴权 JSON。静态资源仍限制目录和同源读取。业务 API 和登录动作继续按配置校验 Origin，所有请求检查 Host，不信任客户端伪造的 X-Forwarded-*；未登录业务请求仍为 401。根路径跳转到 /work/，favicon 为明确的空响应而非鉴权失败。

内网 HTTP 浏览器不是安全上下文：请求 ID 使用 getRandomValues 生成 128 位随机标识，不依赖 randomUUID；下载使用固定版本的 SHA-256 库核对内容，不跳过摘要校验。网页不要求浏览器关闭安全选项。

验收不得只检查 curl 返回 200。tests/hosted_work/test_web_access.py 覆盖模块脚本/样式携带 Origin、MIME、内网配置、Host/Origin 拒绝和业务鉴权。deploy/hosted-work/browser-check.mjs 用本机独立 Edge/Chromium 配置实际加载发布页面，检查网络错误、样式、脚本、布局及控制台；可在单独测试标签内拦截 API 验证登录、新建会话、附件、发送、下载校验及停止，但报告明确区分模拟接口流程和真实认证/推理，绝不把浏览器 fixture 部署到服务端或称为真实模型联调。

## 9. 账号衔接候选验证（2026-10-30）

以明确提交 `6a0ca489a4fcb593159e3570a07bc562b7be49bd` 的后端源码构建了独立候选，未带入当时其他任务未提交的云同步源码。归档 SHA256 为 `2d543e074457c9b4b685c0df759b1d0db25d58f8e10c91bd36cc6e3afc3f570b`，已在 Ubuntu 新目录核对 manifest 并通过 104 项测试，包括真实 gVisor 文件、网络与用户隔离。

该包现已切换到 Ubuntu 用户级服务，状态备份在 `/home/liuzhe/mona-hosted-work/backups/20261030-accounts-v2`；真实账号的 Work 登录和退出接口已验证。模型列表仍为空，不能执行模型任务。专用 WSS/STCP 通道到 VPS 本机 `127.0.0.1:18801` 的健康检查已通过，但官网路由和 HTTPS `public_origin` 尚未接通，生产浏览器联合验收尚未完成。Ubuntu 用户密钥环无登录开机解锁尚未验证，不能宣称服务已经具备无人值守开机恢复能力。

## 10. Qwen 公网接入与真实验收（2026-11-03）

继续使用上述明确发布包，667 个清单文件逐项核对一致；没有部署主工作树中的其他修改。运营配置修正为 `public_origin=https://mona-ai.cn`，端口 17175 仅用于内部监听，新增 Qwen3.7 Plus 的专用 API 配置和受限环境变量。只重启 Work 自身；用户指定的 Coding Plan 端点保留，供应商用途限制仍见配置指南。

VPS 仅新增 Work location 和专用限流区，经现有 18801 代理到 Ubuntu；保持原官网静态 root、Auth、余额/支付、个人模型 Relay 与其他路由。匿名模型接口为 JSON 401，错误 Origin 为 403，www Work 路径跳到规范 HTTPS 域。站点菜单从实际模型接口发现可用 Qwen，无需重新打包官网。

独立 Edge 隐身上下文完成真实官网账户菜单、共享会话、Qwen 工具任务、上传下载摘要、刷新不重派、exec 执行中停止、停止后新建任务、两账号隔离和退出撤销。测试会话由现行 Auth 为既有测试账号短时签发并撤销，角色未变；密码登录表单不在本轮重测范围。验收不是模拟网络回包，零余额账号完成 Qwen 任务后钱包与版本保持不变。真实 gVisor 烟测也在目标环境通过，最终无 unknown 任务或遗留 Work 容器。

Work 与隧道用户服务现均启用，Linger=yes；本轮没有重启 Docker、恢复四个暂停 Worker 或重启整机。隧道密钥环无人登录解锁未验收。Codex 原生程序、专用登录和共享钱包计费仍未就绪，公开模型表只有已验收的 Qwen；不能把免费线路验收替代收费线路验收。完整部署与验收留档见根目录两份生产文档和 `output/hosted-work/launch-20261103/acceptance-v3.json`。

## 11. 共用桌面会话组件（2026-11-03 开发基线，现已部署）

线上入口直接挂载原 `MonaClient`、`ClientProvider`、`ThreadShell`、`ThreadComposer`、`ArtifactSidebar`、`OfficeEditorHost` 和 `ConversationCanvasPanel`；Office 的三个 iframe 也从原编辑器源码构建。不存在另写的会话区或编辑器。浏览器始终保持 `isTauri()=false`，只在平台 I/O 层适配 HTTP、WebSocket、文件、事件和下载；桌面默认实现保留。

`/api/work/desktop` 只实现这些组件需要的兼容接口，不转发完整 Gateway/Services。会话历史沿用原 transcript replay，ID、分页版本和发送请求身份保持稳定。WebSocket 使用绑定账号和客户端的短期单用票据，JWT 不进入 URL；重连只观察已接收任务。Office 恢复信息随 attached 返回，不能变成新的进度消息、历史或模型任务。

账号身份仍来自 Auth。`state/users/<owner-hash>/desktop.sqlite3` 保存该账号的侧栏与 UI 历史，`documents` 是虚拟 `/workspace` 的文件根；Office Manager、工作副本、上传、票据与 checkpoint 再绑定会话。画布沿用原文件格式，保存串行且按 SHA256 校验旧版本，删除也必须提供已读版本。路径逐段拒绝链接及目录联接，不接收前端指定账号根。原 gVisor workspace.zip 保持不透明，只在该账号容器内读取、改名、移入回收区和保存；不得在宿主解压。

侧栏状态只能引用当前账号可见会话；保存时仅自动清理该账号删除墓碑已确认的旧会话键，其他账号或不存在的键仍拒绝。已读标记在写事务内只向前合并，旧标签页不能回退其他标签页的状态；删除会话时同事务清理其侧栏引用，保留其他会话的设置。

原 OfficeTool、CanvasTool 通过明确注入的受限传输连接同一编辑器。模型编辑请求必须对应当前账号仍在执行的 run；超时的修改返回结果未确认，同一请求不再次派发。Office 表格继续复用原 sidecar 协议，但 Linux 二进制必须来自经验证的统一运行时资源包，在按账号和会话建立的 gVisor 中运行；无宿主挂载、无网络、无模型密钥，不回退到宿主运行。未配置或容量不足时明确拒绝。

不接云同步，不改余额、支付、订阅或设备逻辑。浏览器未开放的原生终端和浏览器控制会明确提示使用桌面端。Office 导出使用当前 checkpoint 和正常浏览器下载，不要求网页伪装桌面或选择服务器路径。

本地浏览器验收入口为 `tests/hosted_work/test_shared_ui_browser.py`（显式设置 `MONA_HOSTED_UI_SMOKE=1`），使用真实本地 UI、HTTP/WS、磁盘存储和编辑器，仅认证为隔离测试依赖，不调用模型。它验证编辑、下载内容、刷新恢复、原画布编辑协议、账号隔离和退出清理，不代表真实生产认证、模型或 Linux/gVisor 表格验收。执行记录见 [实施与验收清单](../plans/hosted-work-shared-chat-20261103.md)。
