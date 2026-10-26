# 股票 Vibe 宿主架构

- 状态：Accepted（架构约束；实现与验收进度见实施方案）
- 日期：2026-10-16
- 范围：一期 A 股研究、团队、策略验证、成交复盘、Shadow、情景与条件跟踪

股票功能迭代同时遵循 [股票模块开发标准](stock-module-development-standard.md)：先核对原生能力与使用条件，再规划当前三个 Tab 及共享研究能力的调用和产物映射，最后逐项设计、开发和验证。

## 当前分支边界（2026-10-17）

用户明确要求本分支直接删除旧股票模块，并让正常开发启动即可测试全部新版入口。本分支的股票业务只允许 `mona/services/stock_vibe/`、`components/stock-vibe/`、`stock-vibe-api.ts` 和 `stock_vibe_task`。正常股票入口直接展示新版，不设置验收后启用、执行权切换或额外批准开关。

旧 `mona/services/stock/`、`components/stock/`、`stock-api.ts`、五个旧工具、内置 A 股专家包、旧复盘/选股调度及 WeStock 运行时装配已移除。旧 `/api/stock/*` 路由不再注册。旧版归档界面、归档 API、迁移协调器和 `stock-execution` 状态模块也已删除；原始用户文件保留，不自动执行或重放旧任务。

新版路由默认受理请求，只保留本地鉴权、输入校验、稳定请求 ID 与真实运行环境/模型/数据可用性检查。行情不需要先配置研究模型。缺少某项模型或行情凭据时，提示对应操作需要的配置，不封住整个页面。下文删除前的实施记录为历史，不构成运行时门槛。

## 所有权

Services 独占 `mona/services/stock_vibe/` 与 `/api/stock-vibe` 业务路由，并按需持有完整 Vibe 原生服务子进程。前端只访问 Services，由原生服务执行金融业务；不得在 Mona 重建金融循环、策略计算或第二套调度。Gateway 独占纯模型桥接和全局运行时安装任务。Vibe 不得调用 Mona 的 `/v1/chat/completions`（该入口运行 Mona AgentLoop）。桥接从显式选择的 Mona API 默认配置（`model_preset="default"`）、命名兼容 API 预设，或独立的 `model_binding`（Codex、Claude Code、CodeBuddy 账号模型）取得不可变模型快照；两种选择互斥，不改变全局聊天模型。两者均未设置时保持未选择，不隐式回退。

账号模型复用 `NativeWorkProvider` 的受管登录与工具回传协议，不启用引擎自带文件、Shell、MCP 或协作工具。每个新研究模型回合使用独立工作目录和原生会话，只按已返回的工具调用 ID 续接；工具名与参数返回 Vibe，由 Vibe 执行金融工具并回传结果。混用会话、重复或过期结果拒绝续接；新会话历史超出原生输入上限时明确失败，不截掉研究证据。完成、中断、断连或运行实例释放时回收会话和临时目录；等待 Vibe 工具期间保留原会话。桥接仅转译消息、工具调用和 usage，不运行 Mona AgentLoop 或 Mona 金融工具。模型菜单复用现有引擎目录与连接设置，打开菜单不触发登录、推理或修改全局模型。

Vibe 是 session/attempt、swarm run/task、strategy artifact、backtest run、shadow profile/result、portfolio snapshot、scheduled job 和原始产物的唯一事实来源。宿主只保存请求关联、显示偏好和恢复索引。入队、运行、产物完成和通知完成分别记录；禁止从模型文本或 HTTP 200 推断完成。

## 股票研究共享入口（2026-10-19，当前方向）

股票模块当前为投资工作台、机会选股、账户与复盘三个 Tab；研究不设独立 Tab。主会话中的 `stock_vibe_task` 与投资工作台右栏是两处任务入口：前者接收用户的自然语言问题，后者带入当前标的并显示已有研究摘要。两处都经 Services 调用明确接入的 Vibe 原生 Session、工具、技能或团队，不在 WebUI 或 Mona AgentLoop 中重建金融执行。上游工具存在不等于已为 Mona 接通，入口仅承诺经过能力映射和实际验证的任务。

从任一入口发起后，研究任务、Session/Attempt、原生事件、报告与证据保持同一来源；用户从右栏摘要打开详情后，可查看报告与依据、继续原任务追问。已有原生会话和报告作为历史保留，不因入口调整删除或复制；无法确认来源的历史项据实标记。不能为两处入口分别创建一份报告或另建一套事实表。未完成入口合并、历史恢复或报告来源对账前，须作为待验收项记录，不提前声明闭环完成。

此入口调整不放宽现有 Host 边界：请求仍须有稳定 ID 和幂等恢复，未知写入不得自动重派；附件仍须通过受限上传、真实文件校验和原生安全读取；本地鉴权、运行时归属、数据根隔离和原生进程生命周期继续按本文约束执行。

### 机会选股策略对话（2026-10-21，目标调整）

用户已决定将机会选股统一为策略库，具体约束见[股票开发标准第0.3节](stock-module-development-standard.md#03-机会选股统一策略库2026-10-22最新决定)及[设计与实现记录](../design/stock-vibe-unified-strategy-library.md)。库内“用AI创建/修改策略”复用上述原生Session与共享对话，允许绑定独立策略来源而不强制指定一只股票；产物仍由Vibe生成和登记，Mona仅投影同一资产与运行。内置与自定义共用受控执行路径，最新信号扫描在Vibe的Runner及持久任务边界内完成，不在宿主重写金融逻辑。0053/0054已接通目录、独立策略会话、真实回执登记与扫描；具体数据、模型与测试范围仍按实施记录判断，不据此宣称真实市场效果。

内置策略的名称、说明、规则、参数及执行条件是版本固定内容，由构建工具从锁定原生源码导出为前端随包数据，页面同步展示、搜索及筛选，不请求目录/详情、不等待原生进程。构建前校验源码锁、补丁及导出产物摘要；来源变化时重新导出，不能手工另写一套策略事实。自定义策略独立异步读取，不能遮住内置内容；默认“全部”读取自定义数据仍可能按需启动原生服务，不能宣称整个页面零服务启动。

原生执行前仍重新核对真实源码与版本；静态展示不得替代运行包完整性、路径、执行身份或删除状态校验。运行默认配置、行业目录、历史与实际选股/回测按需读取；浏览内置内容不预读历史或执行默认配置。原生目录及规则读取不预先导入模型构建器或Swarm执行器的重依赖；这些导出在真实使用时加载，模型绑定与授权仍按既有边界校验。

## 来源与运行包

### 工作台扩展（2026-10-18）

0028通过受限Session config关联股票/任务/周期，并读取真实报告与原生Scheduled；0029在原生运行时内新增A股分时及实验预测。预测复用原生因子和时间交叉验证，保留训练截止、数据指纹和样本外基线，不将模型输出当已验证结果；宿主仅做窄契约、交互和显示。日K使用完整收盘数据，分时不预测已过去时刻；各功能数据不足只影响该项，不新增启用门槛。当前完成与验证见[工作台实施记录](../design/stock-vibe-workbench-implementation.md)。

`third_party/vibe-trading/` 保存来源锁、逐文件摘要、原始源码快照与分类补丁。没有 Git 元数据的来源明确使用 snapshot 身份，包版本不代表 commit。受控快照是构建输入，不从开发机绝对路径运行。完整 agent 源码、Swarm presets、Skills、因子、Shadow 模板与字体保持原生结构；分发排除测试、原前端、Electron、wiki、开发环境与用户数据。生产依赖只使用明确固定的唯一平台锁，不执行无界升级；依赖裁剪后必须核对真实工具发现与完整流程。

组件标识为 `stock-vibe`，仅通过 `ensure_official_runtime_resource` → Gateway 全局任务 → `RuntimeInstaller` 安装。程序与隔离 Python 环境在统一运行时仓库；不建立股票下载器。未发布的构建产物不得伪填下载 URL 或上线目录。组件冷下载、展开、缓存、暂存峰值、主安装包增量分别实测；估算不标为测量结果。

源码开发的锁定本地 ZIP 使用 `tools/stock_vibe/install.py --archive ... --sha256 ...` 接入同一 `RuntimeComponentStore` 和 `PythonEnvironmentBuilder(environment="stock-vibe")`，在真实统一运行时根构建隔离环境；不复制临时验证 venv，不构造下载地址。开发实例使用正式 Services 注册函数，不通过预览回调解除限制。

金融依赖使用统一 `PythonEnvironmentBuilder` 的 `stock-vibe` 环境作用域，目录为统一仓库下 `python/stock-vibe-envs/`。原有 `official` 作用域保持原路径与行为。组件清单的 `pythonEnvironment` 声明作用域，安装器按作用域组装离线 wheel 闭包；不同作用域不合并 packs，不改变其他业务的环境活动指针。原因是原生锁与已有科学计算包的固定版本不同，不能将金融依赖装进后者或 Gateway 的解释器。

## 目录与生命周期

用户数据位于 `get_data_dir()/stock-vibe/`；原生根为其 `native/`，显式注入 `VIBE_TRADING_HOME`。宿主关联与执行权放在 `host/`。不改变 HOME/USERPROFILE，不读取独立 Vibe 的 `.env`、配置、legacy 数据或凭据。测试使用临时根。dotenv/settings/migration 必须统一服从显式数据根，再 import 原生服务。原始快照只读，补丁应用到受控构建目录。

Services 分配 loopback 端口和私有随机令牌；启动握手确认引擎快照、实例 ID 与数据根身份。端口开放或 `/health` 返回正常不足以证明进程归属。默认只复用自身持有句柄的实例；不能核实的进程不复用、不终止。WebUI 不发现内部端口或取得引擎密钥。活动任务或启用的原生调度存在时保留进程；闲置退出只影响已核实空闲实例。Services cleanup 回收其进程及子进程，Windows 精确 Job Object / 其他平台进程组，不按程序名杀进程。升级可准备新版本，在活动任务完成前不切换；迁移前保存数据恢复点。

受管树由 `mona.runtime.process_tree.OwnedProcess` 持有。Windows venv 的 python.exe 可能只是重定向启动器，因此原生服务 PID 不必等于 Popen PID；必须以私有 Job 的 `IsProcessInJob` 加实例握手验证。进程先挂起创建、加入不继承句柄的 kill-on-close Job，再恢复主线程，防止启动器提前派生漏管子进程。POSIX 使用新 session 的进程组并核验归属。测试/宿主都不得直接结束启动器而留下原生服务。

## 认证、提交与恢复

Windows 空闲判定同时检查原生活动记录和 Job 成员。启动基线只接受已握手服务到启动器的真实父链，以及父位于该链的系统 conhost；出现其他启动进程即拒绝建立基线。后续 Job 成员必须为基线子集，不能以进程总数相同认定空闲。未核实平台成员时保留进程，不自动清退。认证 shutdown 先触发原生正常退出，Job/进程组回收是最后保障。

Mona 本地服务令牌保护全部新业务路径，包括读取账户、文件与事件票据；同时更新 Tauri/前端附加令牌的规则。原生私有认证继续存在，长效令牌不进 URL。事件只用短期一次票据或服务端转发，保留原生游标、身份和事件类型。

写请求必须携带稳定 `request_id`。先持久记录派发状态，再调用原生服务；相同 ID 不重复派发。回执丢失先查询原生请求关联；无法确定时保持 `unknown`，禁止自动重试。原生不具备稳定关联的入口先补最小原生请求绑定，不以标题和文本去重。Session 重启为 INTERRUPTED，不重发最后消息；Swarm retry/resume 保留父子 run；Alpha 内存 job 丢失表示需重新评测；scheduled dispatch 完成仅表示入队。取消只作用于具体任务，不能重启共享服务冒充取消成功。

宿主使用明确白名单映射原生路径，不提供任意代理。产物通过原生对象/产物 ID 访问，resolved path 必须处于核实的数据根；禁止前端提交任意本机路径。用户 URL 使用现有 SSRF 防护。原生交易写操作一期不可达，rebalance 仅为提案。

## 新旧隔离

来源在派发前绑定已握手的快照、补丁、实例、数据根摘要与实际模型能力元数据。宿主只在确认原生创建回执后建立对象引用；重启后仍读取原来源。无来源索引的原生历史对象明确标为未核实，不能套用当前组件身份。宿主 SQLite 保存请求摘要及回执，不复制研究正文或提供商密钥。事件代理唯一无需 Mona 头的路径为 `/api/stock-vibe/events`，必须校验并消费已鉴权签发、绑定对象和游标的30秒一次票据。

新前端只放在 `components/stock-vibe/` 与 `lib/stock-vibe-api.ts`，不导入旧 `components/stock/`、`lib/stock-api.ts` 及其聚合导出。新后端不依赖 `mona.services.stock` 或旧 stock_query/research/selection/submit/diagnosis_submit 金融工具。桥接不得依赖 Mona AgentLoop 或旧股票流程。解析真实 Python/TypeScript 导入、别名、re-export 和静态动态导入，并以负例验证检查器。可复用通用 runtime/config/providers/auth/security/通知/文件安全与无金融副作用的共享 UI；通用模块不是绕过禁止表的中转站。

不再维护新旧股票执行权状态。旧 Agent、工作流、cron 和陈旧工具引用由通用退役检查永久拒绝；该检查不能用于限制新版请求。进程锁只保护原生实例的数据根归属，用户关注偏好控制后台提醒。真实运行失败按具体操作反馈，不显示“仍在验收”。

旧用户文件保留在原位置，旧 AI 判断、评分、绩效、队列和启用状态不自动进入新版金融状态或训练。新版只通过原生对象及产物 ID 访问其自身数据。

## 能力与产物

接口声明区分 `source_supported`（代码存在）、`contract_verified`（隔离运行）、`live_verified`（真实来源验收）、`unavailable`、`requires_credentials`，不能以安装或示例代替可用性。免费数据优先，逐来源显示真实更新时点、覆盖区间、复权、PIT 缺口和限制；增强数据由用户自行选购配置。券商读取、持仓、可卖、资金、成交历史分别验收，文件解析不等于在线连接。无资格验收的连接明确待验，不阻断无依赖研究和文件复盘。

增强行情只读取 Mona 显式 `stockVibe.tushareToken` 或作用域环境变量 `MONA_STOCK_VIBE__TUSHARE_TOKEN`，后者优先；默认空，不从独立 Vibe 或旧券商配置寻找凭据。令牌注入原生行情环境，启动签名只加入摘要，GET 只给 configured 布尔状态，不写入来源/任务元数据。改变配置等待活动任务安全结束后重启实例。Tushare 是行情凭据：原生 Tushare 回测 loader 与 signal_engine 在同一子进程中，现有行情白名单保留该令牌以支持取数，未建立两者的 OS 密钥隔离；模型提供商及券商凭据仍不得透传给策略子进程。

固定策略的独立区间/成本实验与严格因子检验是两个原生 durable operation，复用既有 SQLite/worker，不在宿主计算指标。前者复用已完成代码，验证期晚于开发期，每个成本情景新建 run；普通 validation 保留 checks，没有原生总评阈值时不合成通过结论。后者使用固定打包因子库、CSI300 横截面数据、必填 OOS 划分和随机对照；成分降级或缺凭据时不可用，保留实际 rows、skip 和 meta。严格统计不等于完整 PIT 或策略盈利验收；原生普通 Alpha 内存 job 的旧恢复限制仍保留。

情景是原生研究的版本化产物：`schema_version, artifact_id, session_id/attempt_id, symbol, exchange, as_of, mode, horizon, judgment, evidence_refs, conditions, invalidation, next_step, supersedes, revision_reason`。每个关键位置引用来源和时点，条件保留比较操作与观测字段；缺失不填零，不生成无校准概率。修订只追加。条件观测记录原版本、事实时点、数据来源与 freshness；过期数据不触发，触发不代表盈利或预测准确。资金、持仓/可卖数量、风险偏好、账户时点和行情输入充分前不产生个性化仓位数字。


## 删除旧实现前的实施记录（2026-10-17，历史）

- App 的 `StockEntry` 只依据认证的 `/api/stock-vibe/ownership` 结果挂载 legacy 或 Vibe 其中一个执行界面。当前没有 ownership 记录时，原生状态默认 `legacy`；`switching`、`paused`、损坏状态和网络错误都不会挂载任一执行界面，也不会从 Vibe 回退到 legacy。页面每 5 秒只读刷新。隔离前端测试已覆盖这些状态；这不代表正式执行权已经切换。
- 新 Services API 默认由真实 `StockExecutionStore` 决定是否允许执行，显式 `execution_allowed` callback 仅用于隔离测试工厂。旧 HTTP/WS、AgentJob、workflow/恢复、cron 和隐藏股票 room 的冻结接线有定向测试；迁移/归档与 Mona tasktool 的实现和验收仍在进行。
- Preflight 5 已在隔离运行时安装验证，细节与 SHA 见 [运行包验证](../design/stock-vibe-runtime-verification.md)。它证明该构建离线安装、`pip check` 和选定模块导入通过，不证明桌面交付或正式切换。
- 情景观察目前只对已完成的日线窗口工作，使用 5 天 freshness；没有真实盘中分钟数据或持续行情验收。Rust 桌面通知只完成接线与 rustfmt；完整桌面编译因缺少 `mona-gateway` 资源受阻，OS 通知投递没有真实验收。
- 静态 AST 边界、Windows 原生 Job 进程归属和原生写工具受限修改测试已有证据；这些检查不提供 Windows 文件系统或网络强隔离，不能称为强沙箱。主线集成测试当时仍在运行并有待处理失败，本文不记录全绿结论。

截至本次记录，尚未写入正式环境的股票执行权记录，也未正式切换、合并或发布。迁移/归档和任务工具验收、UI 中真实模型保存情景、持续行情与桌面通知仍需完成；依赖、真实链路、失败和执行权四道门槛维持未通过。

后续证据已补充真实 UI 的研究/团队与情景保存、合成成交复盘/报告及固定代码独立实验；T12 协调器、归档、持久旧调用 lease 和 tasktool 也有隔离测试，详见实施方案与各验收记录。受控补丁当前冻结至 0027，安装与 UI 状态以对应具体版本记录为准。真实账户、增强行情权限、完整桌面交付及正式迁移切换仍未完成，四道正式门槛不据隔离样本自动勾选。
