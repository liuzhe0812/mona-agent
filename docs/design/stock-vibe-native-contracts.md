# Vibe-Trading 原生接口与隔离核查

- 核查日期：2026-10-16
- 核查对象：`D:\liuzhe\Desktop\code\Vibe-Trading\agent` 源码，只读
- 对照范围：股票 Vibe 实施方案 T00、T01、T05、T08
- 证据级别：源码存在（`source_supported`）。本核查没有联网、安装或启动服务，没有读取凭据，也没有连接真实账户；以下不等于隔离运行验证或真实来源验收。

文中路径均相对上游源码根目录 `Vibe-Trading/`；行号来自本次读取的源码。

## 服务入口、认证与运行状态

`agent/api_server.py:156-176` 组装 FastAPI 应用、middleware 与 lifespan；`:188-200` 注册 sessions/system，`:246-261` 注册 Swarm、live、portfolio，`:302-312` 注册 SSE 票据和 scheduled routes。路径按下表使用原生 HTTP 路径，不加 Mona 的 `/api/stock-vibe` 前缀。

| 能力 | 真实入口与最小请求 | 返回/状态字段 | 证据与集成约束 |
|---|---|---|---|
| 健康/就绪 | `GET /live`、`GET /health`、`GET /ready`，均无请求体 | `/live` 与 `/health` 返回 `{status:"healthy", service, timestamp}`；`/ready` 返回 `ready`，模型配置不可用时为 503 | `agent/src/api/system_routes.py:40-45,236-273`。health 只说明该处理器可响应，不含实例 ID、引擎版本或数据根身份；宿主需做独立启动握手，不能用 HTTP 200 认领陌生进程。 |
| API 认证 | 常规私有路由使用 `Authorization: Bearer <API key>`；配置 key 后 loopback 也必须带 key。未配置 key 时仅 loopback 开发信任 | 错误凭据 401；未配置 key 的非本机请求 403；共享 key 得到的是不可归因 Principal，不是实名用户 | `agent/src/api/security.py:355-366,463-504,571-588`。host 应把原生端口和 key 留在 Services 内，不给 WebUI。 |
| 创建 session | `POST /sessions`；body 可 `{}`，字段只有可选 `title`、`config` | 201；`session_id,title,status,created_at,updated_at,last_attempt_id`；session 状态为 `active,completed,archived`，初始为 `active` | `agent/src/api/sessions_routes.py:31-45,386-413`；状态枚举见 `agent/src/session/models.py:122-139`。 |
| 发送研究消息 | `POST /sessions/{session_id}/messages`，`{"content":"..."}` | 接收后返回 `message_id,attempt_id`；忙碌为 409；session 不存在为 404；runtime 未启用为 501。Attempt 可处于 `pending,running,waiting_user,completed,failed,cancelled,interrupted` | 请求仅有 `content`，没有 request_id；route 将任务交给 service 后即返回。`agent/src/api/sessions_routes.py:52-55,761-780`、`agent/src/session/service.py:249-309`、`agent/src/session/models.py:130-139,246-280`。不能把入队回执当最终报告。 |
| 读取/取消 session | `GET /sessions`；`GET /sessions/{id}`；`GET /sessions/{id}/messages`；`POST /sessions/{id}/cancel` | session 字段同上；消息含 `message_id,session_id,role,content,created_at,linked_attempt_id,metadata,tool_trail`；取消返回 `cancelled` 或 `no_active_loop` | `agent/src/api/sessions_routes.py:415-435,782-814`。取消是 session 当前任务级动作，不代表共享服务停止。 |
| Swarm preset 与启动 | `GET /swarm/presets`；`POST /swarm/runs`，最小 body 为 `{"preset_name":"<现有 preset>","user_vars":{}}` | 启动回执 `{id,status,preset_name}`；可列举或读取 run/task | `agent/src/api/swarm_routes.py:79-107`。这里没有 request_id；额外字段不会作为请求关联读取。 |
| Swarm 状态/恢复 | `GET /swarm/runs`；`GET /swarm/runs/{id}`；`POST /swarm/runs/{id}/cancel`；`POST /swarm/runs/{id}/retry?resume=true` | run 状态 `pending,running,completed,failed,cancelled`；task 状态 `pending,blocked,in_progress,completed,failed,cancelled`；run 详情带 `is_stale,agents,tasks,created_at,completed_at,final_report` | `agent/src/api/swarm_routes.py:109-165,213-271`；枚举见 `agent/src/swarm/models.py:124-150`。retry 创建新 run；resume 会重放已完成的上游任务产物，不能由 Mona 当作原 run 重试或重发。 |
| Portfolio | `GET /api/portfolio`；无 body 的 `POST /api/portfolio/refresh`；`GET /api/portfolio/refresh-status` | latest 返回 `empty` 或 `ok`；snapshot 有 `snapshot_id,valuation_version,created_at,complete,totals,valuation,fx,accounts,positions,combined_holdings,warnings`。账户行有 `status,error,error_code,failure_kind,reconnect_required,last_success_at`。refresh-status 有 `running,current,sources`，并保留 `brokers` 兼容别名 | `agent/src/api/portfolio_routes.py:147-190`、`agent/src/portfolio/service.py:395-432,458-477`。刷新会向选中的来源读取并保存新 snapshot；请求无 request_id。 |
| Portfolio 设置/导入 | `GET/PUT /api/portfolio/settings`；`POST /api/portfolio/imports/extraetf`，body 必需 `csv_text,label,source_mtime,expected_positions,max_age_days` | settings 含 `settings,catalog`；导入回执 `{status:"ok",import:...}` | `agent/src/api/portfolio_routes.py:37-56,244-271`。改设置/导入走更严格 settings-write auth。此导入解析 ExtraETF CSV，不是东方财富在线账户连接。 |
| Portfolio rebalance | `POST /api/portfolio/rebalance`，body `{snapshot_id,target_weights}` | 返回 proposal | `agent/src/api/portfolio_routes.py:59-62,273-278`、`agent/src/portfolio/rebalance.py:73-75`。代码将模式标作 `proposal_only`；股票一期只读仍应只开放所需 portfolio 读取路由。 |
| Scheduled research | `POST /scheduled-runs`，最小 body `{prompt,schedule}`；schedule 是毫秒间隔字符串或 5 段 cron；`id` 可选。`GET /scheduled-runs` 可带 `status`、`limit` | job 状态 `pending,running,completed,failed,cancelled,expired`；响应含 `id,next_run_at,last_run_at,consecutive_failures,last_error,failure_kind,delivery_status,delivery_attempts,last_verdict` 等 | `agent/src/api/scheduled_routes.py:211-264,370-427,470-608`、`agent/src/scheduled_research/models.py:184-215`。`id` 是 job 身份，不是通用请求幂等键。服务启动时会启动 executor：`agent/api_server.py:128-143`；dispatch 状态 `completed` 只表示 attempt 已入队，研究和通知仍需各自确认，见 `scheduled_routes.py:64-90`。 |

### SSE 事件契约

- `POST /auth/sse-ticket` 需要 Bearer key，返回一次性短时 `{ticket}`；浏览器将票据用于 EventSource URL。长期 key 不允许放 URL。`agent/src/api/auth_routes.py:46-55`、`agent/src/api/security.py:591-622`。
- Session 流为 `GET /sessions/{session_id}/events`；支持 `Last-Event-ID` header 或同名 query、`replay=active`。帧是 `id,event,data`；event envelope 字段为 `event_id,event_type,data,session_id,timestamp`。EventBus 每 session 缓存 500 个事件，空闲 heartbeat 30 秒。`agent/src/api/sessions_routes.py:816-887`、`agent/src/session/events.py:20-54,57-83,195-203`。
- Session 的 `attempt.interrupted` 会在服务重启恢复时落入状态；重启恢复不会重发最后消息。相关逻辑见 `agent/src/session/service.py:136-151`。
- session 关键事件至少包括 `message.received`、`attempt.created`、`attempt.started`、`attempt.completed`、`attempt.failed`、`attempt.cancelled`；重启恢复会标记未完成 attempt 为 `interrupted`。`agent/src/session/service.py:136-151,290-301,357-361,434-468`。
- Swarm 流为 `GET /swarm/runs/{run_id}/events`，游标可用 `Last-Event-ID` 整数 header 或 `last_index`；结束帧为 `event: done`，data 含终态 status。它的游标是事件序号，与 session 的 opaque event ID 不同。`agent/src/api/swarm_routes.py:169-211`。
- Session、Swarm SSE 都使用 `require_event_stream_auth`。接入端必须保留原生事件名、event ID/游标、session/run 身份和真实终态；HTTP 连接断开不等于任务取消。

## A 股数据源代码支持

下面仅说明源码里存在的 provider 和配置门槛；当前没有做网络请求，因此都不能标记为 `contract_verified` 或 `live_verified`。

| 类型 | 源码支持 | 配置/限制 | 一期判定 |
|---|---|---|---|
| 免费行情 | Tencent：A 股/HK OHLCV、免 token；Eastmoney：A 股/HK/美股 OHLCV、免 token、HTTP 节流；BaoStock：A 股日线、免 token，但需安装包；AKShare：免 token、多市场，但需安装包 | 默认 A 股 fallback 次序是 Tencent → Eastmoney → BaoStock → AKShare → Tushare → Gildata → local。`resolve_loader()` 看 loader 的 `is_available()`，不代表源站健康或能返回指定标的区间 | `agent/backtest/loaders/registry.py:175-196,591-625`；Tencent `tencent_loader.py:1,61-80`；Eastmoney `eastmoney_loader.py:1-14,53-94`；BaoStock `baostock_loader.py:1-8,165-217`；AKShare `akshare_loader.py:1-5,90-113`。免 token 不承诺额度、历史长度、时效或服务持续性。 |
| 凭据型/增强行情 | Tushare：代码支持 A/HK/基金日线及分钟接口；Gildata：A/HK/指数行情 | Tushare 要 `TUSHARE_TOKEN`；Gildata 要 `GILDATA_TOKEN`，源码标作商业供应商。没有读取或配置用户 token，也未核实授权套餐和数据范围 | `tushare.py:1,117-148`；`gildata_loader.py:1-8,38-42,321-338`。token 存在仅代表配置不空，不等于该账户有目标接口权限。 |
| 财报/基本面 | 原生 A/HK 财报工具调用 Eastmoney datacenter；另有 Tushare fundamentals 与通用 fundamentals loader | 不可从函数名推断字段完整、公告时点、PIT 覆盖或报告修订历史 | `agent/src/tools/financial_statements_tool.py:6-17,40-46`；`agent/backtest/loaders/tushare_fundamentals.py:1-12,120-132`。T05 需按具体字段和时点做真实样本。 |
| 本地/增强数据桥 | `local` loader 读取 Data Bridge 本地配置；另有 FMP、Tiingo、Finnhub、Alpha Vantage 等凭据型 loader | local 配置当前默认指向真实 `~/.vibe-trading/data-bridge/config.yaml`；外部服务 token/套餐需用户配置和授权 | `agent/backtest/loaders/local_loader.py:1-8,48`；`registry.py:180-196,654-676`；各 provider loader 中的 credential checks。需先修正路径并单独验证覆盖。 |

`registry.py:267-321` 对复权口径做了区分：A 股 Eastmoney/AKShare 前复权结果被标记为 `split_dividend_additive`，不能与常见乘法复权尺度静默混用。K 线来源、复权、请求时间、数据截至时间、缺项和覆盖范围应随研究产物显示。代码的 fallback 选择、`is_available()` 或缓存命中都不能代替实际覆盖验收。

## 券商能力核查

| 能力 | 源码证据 | 状态 |
|---|---|---|
| 东方财富成交文件解析 | `trade_journal_parsers.py` 的 format detector 以 `买卖标志`+`股票代码` 或 `买卖标志`+`成交均价` 识别 Eastmoney；parser 文档列出预期列 `成交日期,成交时间,股票代码,股票名称,买卖标志,成交数量,成交均价,成交金额,佣金,印花税`。输出规范化字段为 `datetime,symbol,name,side,quantity,price,amount,fee,market`；amount 取成交金额或数量×均价，fee 为佣金+印花税，market 固定 `china_a`。CSV、XLSX、XLS 由 `load_dataframe` 读取。`agent/src/tools/trade_journal_parsers.py:101-125,128-160,173-202,401-450,701-733` | 本地成交记录解析；由 MCP `analyze_trade_journal(file_path,analysis_type,filter_expr)` → registry → `TradeJournalTool` → `safe_user_path` → `parse_file` → profile/behavior 分析调用；Shadow extractor 和 backtester 也直接复用 parser。`agent/mcp_server.py:3088-3118`、`agent/src/tools/trade_journal_tool.py:632-699,716-756`、`agent/src/shadow_account/extractor.py:65-97`、`agent/src/shadow_account/backtester.py:535-560`。这是成交文件分析，不读取在线账户或当前持仓。 |
| ExtraETF portfolio 文件导入 | `/api/portfolio/imports/extraetf` 接收 `csv_text,label,source_mtime,expected_positions,max_age_days`。源码格式为两种分号分隔文件：holdings 列 `ISIN;Name;Typ;Anzahl;Kaufpreis;Aktueller Kurs;Aktueller Wert;Währung;Wechselkurs;Region;Land;Sektor;Portfolioname;Portfolio ID`；transactions 列 `Datum;ISIN;Name;Typ;Transaktion;Anzahl;Preis;Gebühren;Steuern;Währung;Wechselkurs;Portfolioname;Portfolio ID;Stückzinsen`。Portfolio 只接受 holdings，transactions 文件不能当 positions。API 接收的 `source_mtime` 由调用方提供；import store 将其标为 `file_mtime`，源码不在该 route 对本地文件 stat。`agent/src/api/portfolio_routes.py:51-56,265-271`、`agent/src/portfolio/imports.py:66-108`、`agent/src/portfolio/extraetf.py:1-29,188-234,254-278` | 独立的 ExtraETF 持仓文件导入；与东方财富成交文件 parser 是两套不同格式、不同用途的能力，不证明东方财富在线连接。 |
| 东方财富行情 HTTP | `eastmoney_client.py:34-35` 有 push2his K 线和 searchapi 标的解析；`eastmoney_loader.py:53-94` 注册行情 loader | 行情接口源码存在；这不是账户连接、资金读取、持仓读取或成交历史连接。在线行情也未在本次联网验证。 |
| 东方财富证券账户在线 | 对 `agent/src/trading/connectors/`、`agent/src/portfolio/` 和 portfolio routes 按 Eastmoney/东方财富检索，无 broker connector、profile 或账户适配器 | 未发现实现；必须补券商能力与认证/账户/持仓/可卖/资金/成交历史接口，再做真实账户资格验收。成交文件 parser、ExtraETF portfolio import 和行情 HTTP 都不能计为在线账户已支持。 |
| QMT/xtquant | 对 `agent/src/trading/connectors/`、`agent/src/portfolio/` 和 portfolio routes 按 QMT、xtquant、mini.QMT 检索，无匹配实现 | 未发现实现；需明确后续接入方式及客户端/SDK 条件。 |
| 通用 Portfolio connectors | `compatibility.py` 对 IBKR、Longbridge、Binance、Alpaca、OKX、Futu、Tiger 等给出 native 或 experimental 兼容级别；未含 Eastmoney/QMT | “native/experimental”是代码声明，不表示当前设备凭据、权限、历史范围和真实账户已通过验收。真实能力逐项留在待验状态。 |

完整 `api_server` 还注册 `/live/*` 和 `/mandate/commit` 路由（`agent/api_server.py:252-261`；例如 `agent/src/api/live_routes.py:996,1056,1077-1096,1287,1380-1431`）。股票业务 API 必须白名单映射只读 Portfolio 所需操作，不能暴露原生 live 写入/执行控制。

## VIBE_TRADING_HOME 与隔离缺口

### 已支持的共享根

`agent/src/config/paths.py:10-34` 定义 `VIBE_TRADING_HOME`；`:13-34` 的优先级是显式 `config_path` 的父目录、环境变量、最后才是 `Path.home()/.vibe-trading`。`:37-54` 的 sessions、runs、swarm-runs、uploads 使用该 helper。`api/helpers.py:25-30` 在 import 时计算上述 API 目录；Portfolio store 使用 helper（`agent/src/portfolio/store.py:37-47`），live 根也使用 helper（`agent/src/live/paths.py:23-30`）。

因此必须在子进程启动时、import `api_server` 前注入专属 `VIBE_TRADING_HOME`。仅在服务导入后设置环境变量来不及改变 import-time 常量。该变量本身不会重写下面的 `Path.home()` 或含 `~/.vibe-trading` 的配置值。

### 必须补丁或明确关闭的路径

| 区域 | 仍访问真实 Home/工作目录的路径 | 要求 |
|---|---|---|
| dotenv 与设置读写 | `agent/src/api/helpers.py:25-33`：`ENV_PATH=Path.home()/".vibe-trading"/".env"`；另有 `LEGACY_ENV_PATH=agent/.env`。`settings_routes.py:642-662` 将其作为 settings 读写目标，目标不存在时先读 legacy dotenv 再合并，并在报错中固定提示真实 Home。`providers/llm.py:843-850` 搜索真实 home `.env`、`agent/.env`、`Path.cwd()/.env`。 | 将所有读取/写入都锚定专属 VIBE 根；集成模式禁用 agent/CWD/旧 Home fallback；不继承独立 Vibe 的 provider key。 |
| TAP 凭据发现 | `agent/src/trading/tap_forward.py:39-46,49-76` 再次扫描真实 home、agent 与 CWD 的 `.env`，查找 `TAP_*`。 | 同样改为专属根或在股票宿主中关闭 TAP auto-discovery；不能只修 `providers/llm.py`。 |
| 自动 legacy migration | `agent/api_server.py:128-143` 每次启动调用 `migrate_legacy_state()` 且不传路径。默认 source 是 `migrate.py:44-50` 的 package 根；`:34-39,114-150` 对 package 下 `sessions/runs/.swarm/runs/uploads` 做 move 并删除空 source，destination 才是 `get_runtime_root()`。 | 启动前明确 migration source 身份并限制到隔离副本；在受控快照不承载可迁移旧状态时应关闭迁移。不得因为迁移而扫描或搬动独立安装的数据。默认函数不是读取 `Path.home()`，但会在 package 目录执行有源端删除的 move。 |
| 生成代码沙箱 | `agent/src/core/runner.py:181-204` 从真实 HOME 下 `.vibe-trading` 将 `cache`、`data-bridge`、`qveris.json` symlink 进临时 HOME；`:635-655` 由 `HOME/USERPROFILE/Path.home()` 计算源。 | 将 symlink 源 root 换成经身份核验的专属 VIBE 根，并确认失败时不能继承真实 HOME。 |
| 文件读写允许根 | `agent/src/tools/path_utils.py:120-159,172-200` 默认允许真实 HOME 下 `.vibe-trading/uploads/imports/shadow_runs/runs`，同时才追加 `get_runtime_root()` 路径。 | 移除真实 HOME 旧根；只允许专属根和用户明确授权目录。否则工具可读/写独立 Vibe 的附件与 runs。 |
| Portfolio/报告文件 | `agent/src/api/uploads_routes.py:109-116` 从真实 `Path.home()/.vibe-trading/shadow_reports` 读取 Shadow 报告。 | 用受控数据根解析 report ID，禁止读取旧 Home。 |
| 配置与 OAuth token 缓存 | `agent/src/config/schema.py:48` 固定 Robinhood `agent.json` 路径；`:190-218,228-238,252-260,385-389` 的 Robinhood/IBKR/Scalable OAuth `cache_dir` 含 `~/.vibe-trading`；`agent/src/live/registry.py:145-153` 对 cache_dir 做 `expanduser()` 并查 token 文件。 | 创建配置快照时把这些 path 规范化到专属根；不可复用旧 token cache。即使一期不开放 live trading，也要确认 Portfolio OAuth 不会从旧路径取 token。 |
| Memory/索引/研究配置 | `agent/src/memory/persistent.py:21`、`memory/search_index.py:23`；`hypotheses/registry.py:32-42`（有 override，默认仍真实 HOME）；`swarm/presets.py:30-35`；`agent/skills.py:97`。 | 分别迁至专属 root 的 memory、hypotheses、user presets/skills；迁移仅限批准白名单，不复制独立 Vibe 的秘密、运行记录或启用状态。 |
| 数据缓存与本地源 | `agent/backtest/loaders/base.py:512-517`（配置 override 可覆盖，默认真实 home loader cache）；`gildata_codes.py:59`；`local_loader.py:48`；`qveris_loader.py:40` 与 `agent/src/tools/qveris_tool.py:24`；`mt5_loader.py:39`；`br_data/store.py:12,125`（可配 override）；`agent/src/tools/alpha_bench_tool.py:127,1254`；`autopilot_tool.py:253`。 | 每个默认读写路径都要使用统一 root 或被能力门禁关闭。单独设置 `VIBE_TRADING_HOME` 不会自动改写它们。Local Data Bridge、QVeris 与 MT5 还可能带外部数据或凭据。 |
| 策略/Shadow/消息缓存 | `agent/src/strategy_store/sqlite_store.py:37,97-104`（配置 override，默认真实 home）；`agent/src/strategy_discovery/evidence_store.py:128-139`（通常用 runtime root，但配置异常时 fallback 到真实 home）；`shadow_account/fonts.py:29`；`channels/qq.py:194-196`。 | 修正默认与异常 fallback，或在一期禁用未使用能力；避免 fallback 出错时跨到旧 Home。 |

上表区分了“路径默认会跨根”和“存在配置 override”。只有部署代码明确设置并核验了每个 override，才能把对应行从隔离缺口移除；共享根可用不代表每个 native 子系统都已隔离。

## 必须补丁与必须真实验收

| 项目 | 判定 |
|---|---|
| 启动前注入 `VIBE_TRADING_HOME`；修正 dotenv/settings/TAP 路径；限制 legacy migration；清理沙箱与文件允许根；重写或关闭直读真实 Home 的组件路径 | **服务首次启动前必须补丁或显式禁用**，否则不能证明不会读取/写入独立 Vibe 状态。 |
| 原生写请求的稳定关联 | Session create/message、Swarm start/retry、Portfolio refresh/import 等入口没有通用 `request_id`；Scheduled 的 `id` 仅是 job ID。宿主需先持久记账并具备查询/幂等绑定；不确定时保持 unknown，不重复执行。 |
| 健康、认证、session attempt、Swarm run/task、Portfolio refresh、scheduled dispatch、SSE 断线/续传/重启恢复 | **必须在隔离测试数据根真实启动并记录请求/响应/事件样本**。本报告仅是源码契约，不能替代 T01 的契约样本。 |
| 免费及增强数据 | 对选定 A 股、区间、复权口径分别做受控真实请求，记录 provider、返回行数/时间范围、数据更新时间、缺项和失败状态。付费源需用户自行配置授权；不能凭 token 有无推断套餐能力。 |
| 东方财富在线与 QMT | 两项当前都没有 broker adapter 源码；补丁后才可测。只有用户具备官方接口资格与真实只读凭据时才可升为 `live_verified`。东方财富成交文件分析与 ExtraETF 持仓导入是分开的文件能力，均不构成在线连接。 |

静态审计没有运行任何 upstream 服务，也没有访问真实账户或数据源。对没有凭据、权限或官方接口证据的能力，实施状态应保留 `requires_credentials` / `unavailable` / 待真实验收；源码存在最多记为 `source_supported`。
