# 股票模块数据源与合规可行性矩阵

状态：V6 证据层支持文档（历史 P2-T1 调研结论，继续有效）
核验日期：2026-08-19
范围：A 股（沪、深、北）股票深度投研；零新增数据成本；只评估公开可访问来源，不把“能请求到”当作“有权生产或再分发”。

本文件是数据源与合规边界参考，不是投研、选股或决策雷达产品基线；产品基线以
`stock-research-best-practice-v6-development-plan.md` 和
`stock-research-best-practice-v6-acceptance-report.md` 为准。

## 1. 结论先行

### 1.1 Go/no-go

| 决策 | 结论 | 边界 |
|---|---|---|
| P2-T2 内部证据层 | **GO（有条件）** | 使用交易所/政府/上市公司正式披露作为事实源；行情与 K 线暂沿用现有 Tencent → EastMoney 运行链，但标记为 `production_capture/aggregated`，不标记 `official_authority`。 |
| 零成本正式商业数据后端 | **NO-GO（当前）** | 交易所规则要求行情/交易信息按许可使用和传播；现有公开网页/前端接口没有可核验的商业再分发授权。报告对外展示前，至少完成交易所及实际数据供应方书面授权核验。 |
| 通达信本地/网络协议 | **NO-GO（零成本）** | 官方 TdxQuant HTTP 是依赖本机已启动客户端的 localhost 接口；逆向私有协议、抓客户端交互数据或使用未授权插件受其用户协议限制。只有取得 TQ/数据包/再分发书面许可后，才可作为候选后端。 |
| Tushare 免费层 | **NO-GO（交付级）** | 120 积分免费档只有非复权日线；多数所需接口要求更高积分或独立权限。服务协议明确个人、非商业、仅查看使用，不能满足交付级商业后端。 |
| AKShare / BaoStock | **开发备选，不进正式默认链** | AKShare 上游明示学术研究用途且目标站点变更会导致接口移除；BaoStock 宣传免费/无需注册，但本次未核验到机器限流、SLA、商业再分发条款。 |

### 1.2 零成本推荐组合与单点故障

**推荐组合（内部研究、不再分发原始行情）**：

1. 事实主链：交易所（SSE/SZSE/BSE）公告、规则、日/月统计；巨潮资讯（CNINFO）上市公司公告和定期报告；证监会、国务院政策库；人民银行和国家统计局宏观数据。
2. 运行行情链：保留现有 `TencentProvider` 的 quote/K 线主路径，`EastMoneyProvider` 作为回退；保留返回对象中的 `SourceRecord`、`published_at/as_of`，任何取不到或时间不满足截止条件的字段置 `missing`。
3. 推导层：用可追溯行情快照确定性计算市场宽度、行业相对收益、换手/流动性代理；推导结果标记 `claim_type=inference`，不伪装为官方指标。
4. 低频正式链：用公告公开时间、报告期末、宏观统计期末分别填入 `published_at`、`period_end`，禁止把抓取时间当成信息公开时间。

**单点/共因故障**：

- Tencent 与 EastMoney 同时不可用时，`market_regime`、实时 `tradeability`、行业相对强弱和短线门槛均应 `missing/insufficient_data`；不能用旧快照冒充当前观测。
- 两个聚合行情源可能共享交易所或上游行情依赖；双源不等于独立真值。`failover.py` 只在 `ProviderError` 时回退，也不保证源的授权、时效或语义正确。
- CNINFO/交易所网页没有统一、公开、稳定的批量 API 合同；页面结构或访问策略变化会使公司质量和事件日历整体降级。
- 官方宏观/政策源分散在多个部门；单一站点故障不应让全局 `cycle_context` 变为中性，应按指标保留缺失。
- 当前能稳定免费取得的是宏观、公告、定期报告、交易规则和部分日/月汇总；行业产品价格、库存/产能、机构一致预期、逐笔盘口/滑点、完整 ETF/机构资金流在零成本正式来源下不能承诺完整。

## 2. 现有实现边界（只读核验）

| 现有组件 | 已实现来源/端点 | 当前字段 | 角色判断 |
|---|---|---|---|
| `mona/services/stock/provider_tencent.py` | `qt.gtimg.cn` quote；`web.ifzq.gtimg.cn` 日/周/月 K 线、分钟热备 | `price`、`change_pct`、`volume`、`pe`、`pb`、`market_cap`、`as_of`；K 线 `date/open/close/high/low/volume` | 生产抓取/聚合候选；公开前端端点，未核验到公开 API SLA、限流或商业再分发授权。 |
| `mona/services/stock/provider.py` (`EastMoneyProvider`) | `push2.eastmoney.com` quote/全市场快照；`push2his.eastmoney.com` K 线/分时；`datacenter.eastmoney.com` F10 财务；`np-anotice-stock.eastmoney.com` 公告；`searchapi.eastmoney.com` 搜索 | 快照含 `price/change_pct/volume/turnover/market_cap/pe/pb/industry`；财务含 `eps/roe/gross_margin/net_margin/revenue/revenue_yoy/net_profit/profit_yoy/operating_cashflow/debt_ratio/roic`；公告含标题/URL/公开时间/摘要 | 生产抓取/聚合候选，不是正式权威源。财务当前为单期快照，不能替代多期正式报告。东方财富用户协议对行情复制/提供给他人有书面许可约束。 |
| `mona/services/stock/failover.py` | quote/K 线主备回退；市场快照择可用 provider；fundamentals/news/search 委托 EastMoney；分时另有 EastMoney → Tencent 链 | 仅按异常回退，逐条保留实际来源记录 | 这是容错编排，不是来源授权、独立性或新鲜度验证；P2-T2 不应增加“失败即 neutral”。 |

## 3. 来源分类与证据规则

### 3.1 分类

- **官方权威源**：交易所、证监会、国务院部门、人民银行、国家统计局、上市公司法定披露平台/原始公告。适合支撑 `fact`；仍需记录公开时间与原文 URL。
- **生产抓取/聚合源**：EastMoney、Tencent 等面向网页/终端的公开数据端点。适合内部运行快照和降级，不自动拥有交易所数据权，也不自动成为权威事实源。
- **仅开发备选**：AKShare、BaoStock，以及已满足权限但未完成法务核验的其他库。可用于离线比对/开发验证，不进入默认生产链。
- **明确不采用**：逆向通达信私有协议、客户端内存/本地文件抓取、需要付费积分/行情授权/独立权限的接口、来源或许可不明的商业数据。

### 3.2 每条证据必带的时间与状态

| 字段 | 语义 | 适用来源 |
|---|---|---|
| `observed_at` / `market_as_of` | 行情、快照、K 线实际观测时间 | Tencent/EastMoney/交易所行情 |
| `published_at` | 公告、政策、新闻、定期报告首次公开时间 | CNINFO、交易所、CSRC、国务院、公司原文 |
| `period_end` | 财务或宏观统计期末，不等于公开时间 | 定期报告、PBOC、NBS |
| `fetched_at` | 本系统取得数据的时间 | 所有来源 |
| `availability_status` | `available` / `stale` / `missing` / `unknown_availability` / `excluded_future` | 所有来源 |
| `source_role` | `official_authority` / `production_capture` / `development_only` | 所有来源 |
| `license_status` | `verified_internal` / `pending_legal` / `not_allowed` | 所有来源 |

不能确认公开时间、机器批量许可或再分发权限的字段，不得用于历史回放或对外原始数据展示；应显示 `missing` 或 `pending_legal`。

## 4. 八个证据分区可行性矩阵

下表中的“建议接入”是 P2-T2 内部 EvidenceBundle 的建议，不等于商业再分发授权。`F` 为可作为事实；`I` 为必须由确定性规则推导；`H` 为需人工复核的假设；`M` 为零成本正式源无法稳定提供，应保持缺失。`I/H` 均不得伪装为官方事实。

| 分区 | 候选来源与具体字段 | 时间语义与更新频率 | 认证/限流 | 稳定性 | 商业使用/再分发约束 | 失败降级 | 建议接入 |
|---|---|---|---|---|---|---|---|
| `market_regime` | **官方** SSE/SZSE/BSE 市场总貌、成交概况、指数/日月统计：交易日数、上市数、成交量/额、市值、指数收盘/涨跌、官方融资融券汇总（F）。**聚合**现有全市场快照：上涨/下跌/停牌、涨停/跌停、成交额/换手、宽基/风格相对收益（行情是观测，宽度为 I）。 | 行情 `observed_at`：盘中/收盘；交易所日报/周报/月报按页面发布；融资融券汇总为交易日收盘后发布。官方 PBOC/NBS 不替代市场宽度。 | 官方网页可公开查阅；机器接口、下载频率及批量许可未公开/需法务确认。现有 Tencent/EastMoney 无 token，但公开端点限流/SLA 未公开。 | 官方统计权威、低频可复核；机器抓取中等。聚合快照字段/结构可能变化，且两源不保证独立。 | SSE/SZSE/BSE 规则均要求交易信息按许可使用/传播；EastMoney 协议也要求交易所书面许可。内部分析与对外再分发必须分开。 | Tencent → EastMoney；均失败则市场宽度、实时成交、短线门槛 `missing`。可保留最近官方日/月统计但标记 `stale`，不得冒充当前。 | **有条件接入**：官方日/月汇总 F；快照仅内部运行/降级，不能作为授权的正式行情后端。 |
| `industry_context` | **官方** CSRC《上市公司行业分类指引》/分类结果、上市公司协会分类（通过交易所引用）、SSE/SZSE/BSE 行业统计/行业指数：`classification_scheme/code/name`、成员、行业成交/指数（F）。**聚合**现有快照的行业字段及成员收益、上涨占比、相对基准收益（I；需标注映射源）。 | 分类结果按官方发布节奏（证监会历史公告说明按季度公布）；行业统计日/周/月视页面；行情成员收益按 `observed_at`。 | 官方网页公开；分类机器下载/API 频率未公开/需法务确认。聚合行业映射和批量限流未公开。 | 分类权威但更新存在滞后；相对强弱依赖全市场快照，交叉市场覆盖可能不完整。 | 分类文本/指数交易信息的商业再分发条款未在本次核验中确认；写 `pending_legal`。 | 分类以官方最近版本为准；相对收益缺成员快照则 `missing`，不得用单只股票涨跌代表行业。 | **接入**：官方分类 F + 确定性相对收益 I；完整行业宽度不可得时显示缺口。 |
| `policy_context` | CSRC 政策法规/公告、国务院政策文件库及相关部委正式文件、PBOC 政策公告：`issuer`、`document_id`、`title`、`published_at`、`effective_from/to`、原文 URL、政策对象（F）。`policy_stage`、受益/受损行业、传导链、兑现窗口是 I/H，必须列 basis。 | 事件驱动；公开时间为 `published_at`，生效/实施日另存；不把抓取时间当发布时间。 | 官方网页通常无需账号；机器访问频率、批量抓取/再分发许可未公开/需法务确认。 | 权威性高；跨部门站点结构和附件链接中等稳定，需保存原文快照/哈希。 | 政府公开信息可查阅不等于授予商业再分发或全文镜像许可；本次未核验统一授权，标 `pending_legal`。 | CSRC ↔ 国务院政策库 ↔ PBOC/部委相关正式站点；若原文不可取，保留已核验来源，否则缺失，不以媒体补写事实。 | **接入**：正式文件 F；行业映射、阶段和兑现窗口仅 I/H。 |
| `cycle_context` | **宏观/流动性官方** PBOC：M0/M1/M2、社会融资规模存量/增量、人民币贷款、公开市场操作；NBS：GDP、CPI/PPI、工业增加值、固定资产投资、零售、PMI/工业产品等（F）。**公司周期**来自多期定期报告/业绩预告；**行业供需/价格**仅在有对应政府/交易所/公司原始披露时接入。字段：`indicator/value/unit/period_end/published_at/revision`、周期类别。 | PBOC 公开市场操作可按交易日公告；社融/M2按月/季/年；NBS 按月/季/年；财务按报告期公开。观测期与公开期必须分离。 | 官方网页公开；机器限流/下载 SLA/再分发未公开/需法务确认。 | 宏观统计权威；修订、口径变化和发布日期差异要求保存版本。行业库存、产能、产品价格覆盖不统一。 | 统计/政策页面的商业使用和再分发边界未统一核验；原始报告 URL 可追溯，原始数值对外再分发 `pending_legal`。 | PBOC/NBS 官方替代；公司周期缺报告则 `missing`；行业供需无稳定源则 `M`，允许公司公告趋势作为 I，不得写成宏观事实。 | **接入宏观与公司周期**；**不承诺行业供需全覆盖**。 |
| `company_quality` | SSE/SZSE/BSE 披露与 CNINFO 定期报告/临时公告：`report_period/period_end`、`published_at`、营业收入、归母净利润、经营现金流、毛利率、净利率、ROE、资产负债率、资本开支/R&D、分红、审计意见、关联交易、股本/稀释（原始字段 F；比率和趋势为 I）。现有 EastMoney F10 只作快速回退/交叉核对。 | 年报/半年报/季报在报告期结束后公开；临时公告事件驱动；财务数字必须同时记录报告期与公开时间。 | CNINFO/交易所网页可查阅；公开 API、批量下载限流、再分发授权未公开/需法务确认。EastMoney 接口无公开 SLA/商业授权。 | 原始披露权威；PDF/HTML 解析和页面结构中等稳定；财务口径/重述需版本化。 | CNINFO 明示法定披露平台但免责声明不保证完整/准确；交易信息及网站内容再利用边界仍需按站点/交易所规则确认。不得把聚合 F10 作为正式原始财务源。 | CNINFO → 对应交易所/公司投资者关系原文；均失败则该期指标 `missing`，不以前一期静默填充。 | **接入**：多期正式报告为长线门槛；EastMoney 仅 `degraded` 回退。 |
| `capital_positioning` | SSE/SZSE/BSE 官方融资融券、转融通、质押/交易公开信息；CNINFO 股东增减持、高管增减持、股权质押、限售解禁、十大股东/基金持股、大宗交易页面：融资余额/融券余量/融资买入卖出、质押数量/比例、解禁计划/实际数量、增减持数量/价格、公开交易席位（F）。ETF/机构资金流只有有正式披露时接入，不能用“主力净流入”替代。 | 融资融券通常交易日收盘后；SSE 页面明确汇总/明细口径；质押、解禁、增减持、公告以 `published_at` 和 `event_date` 分开；持仓为统计日/报告期。 | 官方网页公开；机器频率/批量权限未公开/需法务确认。Tushare 对应接口需积分/权限；TDX 数据包需客户端。 | 官方余额/公告可复核；跨市场覆盖、事件延迟、基金持仓报告期滞后。 | 交易所/CNINFO 交易信息再分发需许可；Tushare 个人非商业；TDX 未授权数据不可用。 | 官方汇总 ↔ CNINFO 原公告；缺少标的级数据则只保留市场级；缺资金流就显示 `missing`，不推断机构净买入。 | **接入可核验官方项**；机构/ETF流量、精细筹码无稳定零成本正式源，显示缺失。 |
| `event_calendar` | SSE/SZSE/BSE/CNINFO：预约披露/定期报告、业绩预告/快报、股东会、分红除权除息、解禁、增减持、质押、停复牌、风险警示、退市、问询/监管/重大事项公告：`event_type`、`announced_at/published_at`、`event_date`、`status`、`instrument_id`、原文 URL（F）。 | 公告公开时间与实际生效/发生日期分开；事件驱动，交易日/收盘后批量更新。 | 网页公开；统一 API、历史覆盖、批量限流未公开/需法务确认。 | 原始公告权威；跨站点重复、撤回/更正和 PDF 解析需去重/版本化。 | CNINFO/交易所声明及交易信息规则不自动授予批量复制/商业再分发权。 | CNINFO ↔ 对应交易所 ↔ 公司原文；冲突保留两条证据并标 `needs_review`，无原文不生成事件。 | **接入**：这是零成本最可落地分区之一；只输出可追溯事件，不做媒体传闻补齐。 |
| `tradeability` | 交易所规则与行情统计：停牌/复牌、交易日历、涨跌幅限制/板块规则、竞价/收盘时间、T+1/回转交易例外、成交量/额、换手、前收/最新/高低（F）。现有 Tencent/EastMoney quote/K 线提供观测字段；盘口深度、逐笔成交、真实滑点、成交可实现性仅在获授权行情源可得时接入。 | 行情 `observed_at`；规则 `effective_from`；停复牌/除权除息为公告事件；T+1 不是价格观测。 | 规则公开；实时行情通信/批量使用需交易所许可；现有端点限流/SLA/授权未公开。 | 规则权威但会修订；报价端点中等稳定；没有订单簿就不能声称真实滑点。 | SSE/SZSE/BSE 明确交易信息归本所并限制使用/传播；商业产品必须先确认授权。 | quote Tencent → EastMoney；两者不可用则 `price/volume/tradeability` 缺失；规则仍可作为静态事实，但不得计算当前可交易性。 | **接入规则 + 基础观测**；`slippage_proxy` 只作为 I，盘口/授权外数据保持 M。 |

## 5. 重点来源判断

### 5.1 通达信：本地/网络协议能否作为正式后端源？

**已核验事实**：

- 通达信官方量化文档的 HTTP 调用地址是 `POST http://127.0.0.1:17709/`，并明确要求先开启支持 TQ 的通达信客户端；调用方法是 TdxQuant 方法，示例返回 K 线字段。
- 官方市场交易数据文档要求先在客户端中下载股票数据包，并列出融资融券、涨跌停、ETF、解禁、质押、龙虎榜、公开市场操作等聚合字段；这说明它是客户端/数据包服务，不是无账号、无许可的公共云 API。
- 通达信用户协议禁止反向工程、复制/修改客户端与服务器交互数据、使用未授权插件或第三方工具接入，以及未经明示授权的运营/传播。
- 通达信“全品类数据库”页面把数据库同步/数据文件包作为面向证券公司、银行、保险、高校、研究所等客户的产品服务；本次未找到可用于 Mona 零成本商业再分发的公开许可。

**推断与决策**：

- **官方 TQ HTTP 接口**可以作为“取得书面授权后的条件候选”，前提是部署受支持客户端、账号/数据包、许可范围和稳定性验收均明确；它不满足当前零成本正式后端条件。
- **抓包/逆向网络协议、读本地 `.day`/缓存/客户端内存**明确不采用；它既不是可复核的正式 API，也无法证明商业使用与再分发权。
- P2-T2 不新增 TDX provider；如未来获得授权，应另立合同核验任务，记录数据包版本、权限范围、更新承诺和再分发边界。

### 5.2 Tushare：免费层/积分/API 条款是否满足？

**已核验事实**（Tushare 官方页面）：

- 积分频次表列出：120 积分、每分钟 50 次、每天 8000 次、价格 0 元/年，仅含“非复权日线数据”；2000/5000 以上才进入更多常规接口。
- 权限说明列出：`daily` 120 起、交易日 15:00—17:00 更新；`daily_basic` 2000 起；周/月线、复权行情、指数、申万行业分类/成分、宏观等多项需要 2000 或更高；新闻/公告等为独立权限，不等同于免费积分。
- `daily_basic` 文档列出 `turnover_rate`、`volume_ratio`、PE/PB、总股本/流通股本、总市值/流通市值、涨跌停状态等字段，但最低 2000 积分；`share_float` 文档列出解禁公告日/解禁日/数量/比例/股东，但其频次仍以页面权限为准。
- Tushare 数据服务协议将服务定义为个人、不可转让、非商业、可撤销、有期限许可，并要求仅用于个人查看；用户协议还允许调整/关停服务，服务条款不保证及时性、准确性、完整性或稳定性。

**推断与决策**：

- 120 免费档只能作为开发日线样本或离线比对，不能满足八个分区所需的市场宽度、行业、资金、事件、财务多期等字段。
- 购买积分/独立权限违反“零新增成本”；即使获得积分，默认服务条款仍不满足 Mona 的交付级商业使用/再分发，**不接入正式链**。
- P2-T2 若保留接口形状用于测试，必须标 `development_only`，测试不得依赖在线 token 或免费额度。

### 5.3 EastMoney、Tencent 与官方来源的角色边界

| 来源 | 可以证明什么 | 不能自动证明什么 | 证据层角色 |
|---|---|---|---|
| SSE/SZSE/BSE | 交易规则、官方市场统计、交易公开信息、规则定义和部分融资/质押数据；交易所是规则和交易信息原始权利主体 | 免费机器抓取、商业再分发、跨站聚合授权 | 官方权威事实源；对外原始行情需许可核验 |
| CNINFO | 深交所法定信息披露平台运营的上市公司公告、定期报告、公司日历及部分交易/股东信息入口 | 站点声明不保证完整/准确；不等于实时行情授权 | 公司质量和事件事实主链；保存原文 URL/公开时间 |
| CSRC/国务院政策库 | 监管政策、法规、政府文件和公开发布时间 | 不提供个股实时价格、订单簿或资金流 | 政策事实主链 |
| PBOC/NBS | 流动性、社融/M2、价格、工业、GDP/PMI 等宏观统计及统计期 | 不提供个股行业景气的全部产品价格/库存 | 宏观周期事实主链 |
| EastMoney | 公共网页/前端接口可取得的 quote、K 线、F10、公告、快照 | 权威原始来源、交易所许可、可持续 API/SLA、商业再分发 | 现有生产抓取/聚合回退；原始字段需 `pending_legal` |
| Tencent | 现有公开前端端点可取得 quote/K 线等观测 | 公开 API 合同、限流、SLA、交易所/商业再分发权 | 现有生产抓取/聚合主路径；源不可用即缺失/回退 |
| Tushare/AKShare/BaoStock | 结构化接口/开发便利，部分字段可作离线比对 | 免费、非商业、无 SLA 或开源代码不等于底层数据可商用 | 仅开发备选 |

### 5.4 AKShare 与 BaoStock

- AKShare 上游 README/介绍明确：数据接口及数据仅用于学术研究；接口可能因不可控因素移除；目标网站页面变化会导致接口异常，需要持续更新。仓库 MIT 只覆盖代码，不覆盖其抓取的交易所、EastMoney、CNINFO 等底层数据权利。结论：开发/回归比对可用，正式交付不采用。
- BaoStock 官方站点宣传“免费、开源、无需注册”，并提供历史行情/财务等 API 入口；本次未核验到对 Mona 机器调用的明确限流、SLA、商业使用和再分发条款。结论：可做离线历史开发备选，但在条款确认前不进默认正式链；所有未知项写 `未公开/需法务确认`，不补数字。

## 6. 零成本正式来源下的明确缺口

以下缺口必须在 EvidenceBundle 中显示 `missing` 或 `inference`，不能回填为 `neutral` 或由 Agent 猜测：

1. 全市场实时宽度、涨跌停封单、逐笔盘口、真实滑点和成交可实现性；现有公开聚合端点只能提供有限快照。
2. 跨沪深北统一、稳定、可授权的行业相对强弱/行业宽度；官方分类可取得，横截面收益需行情快照推导。
3. 行业库存、产能利用率、产品现货/期货价格与公司收入的稳定逐公司映射；只有宏观或部分行业官方统计时，不能外推到所有公司。
4. 机构一致预期、券商盈利预测、私募/公募实时仓位和完整 ETF 资金流；免费正式源或商业许可未核验。
5. 统一跨市场的股东持仓、质押、减持、解禁时点；可取公告不代表已结构化、无延迟或全覆盖。
6. 交易所和聚合行情对外展示/再分发权；公开可访问不等于商业许可，当前是 go/no-go 的法律阻断项。

## 7. 给 P2-T2 的最小字段与接入优先级

### 7.1 所有分区共用最小元数据（P0）

每个字段/记录至少携带：

```text
source_id, source_role, provider, url
observed_at | published_at | period_end | fetched_at
availability_status, missing_reason, license_status
claim_type (fact|inference|hypothesis), basis (inference/hypothesis 时必填)
```

不得在没有 `published_at` 的公告/政策事实上写“已公开”；不得在没有 `period_end` 的财务/宏观值上写“某季度”；不得在没有 `license_status=verified_internal` 的数据上承诺对外再分发。

### 7.2 P2-T2 最小业务字段

| 优先级 | 分区 | 最小字段（先做这些；其余缺失） |
|---|---|---|
| P0 | `market_regime` | 宽基/风格 `instrument_id`、`observed_at`、收盘/涨跌/成交额；市场上涨/下跌/停牌计数；涨跌停计数若源提供；市场总成交额；来源与缺失原因。 |
| P0 | `industry_context` | 分类体系/版本、行业代码/名称、证券成员、行业基准、行业收益、相对基准收益、成员可用数/总数；相对收益和宽度注明 I。 |
| P0 | `policy_context` | 发布机构、文号/标题、`published_at`、生效/实施日、URL、原文摘要；政策阶段/行业映射/兑现窗口仅 I/H + basis。 |
| P0 | `cycle_context` | `cycle_type`（宏观/行业/公司/风格）、指标名、值/单位、`period_end`、`published_at`、修订/版本、观察窗口；无正式源的行业供需为 missing。 |
| P0 | `company_quality` | 报告期/公开时间、收入、归母净利、经营现金流、ROE、毛利率、净利率、资产负债率、资本开支/R&D（报告披露时）、审计/重述状态、来源 URL。 |
| P1 | `capital_positioning` | 融资余额/融券余量/融资买入卖出（市场或标的级）、质押数量/比例、增减持公告数量/价格、解禁日期/数量、公告时间；机构/ETF流量缺失不补。 |
| P0 | `event_calendar` | 事件类型、证券、`published_at`、计划/实际事件日、状态、URL、撤回/更正关联；至少覆盖定期报告、业绩预告、分红、股东会、解禁、增减持、停复牌、风险/退市。 |
| P0 | `tradeability` | 最新价/前收/高低/成交量/成交额/换手（含 `observed_at`）、停牌状态、适用板块和当前价格限制规则、T+1/回转例外；盘口、滑点、逐笔无源则 missing，滑点代理仅 I。 |

### 7.3 接入顺序

1. **P0-1（先完成）**：现有 Tencent ↔ EastMoney quote/K 线、交易日历/规则、官方市场日/月统计；加 freshness、来源角色和双源失败后的 missing。
2. **P0-2**：CNINFO/交易所公告与定期报告；先事件日历，再多期公司质量，按公开时间过滤未来数据。
3. **P0-3**：CSRC/国务院政策、PBOC/NBS 宏观；建立 `published_at`/`period_end`，行业映射只走确定性映射或人工待验证。
4. **P1-1**：官方融资融券、质押、解禁、增减持；只接有原文 URL 和事件/统计日期的字段。
5. **P1-2**：用已有行情快照确定性计算行业相对收益、市场宽度、流动性代理；覆盖不足时输出 `degraded/insufficient`。
6. **暂缓**：Tushare 付费/高积分接口、通达信数据包/协议、AKShare/BaoStock 作为正式来源、未授权的盘口/机构资金流。

## 8. 官方/上游核验清单（直接 URL）

以下链接均在 **2026-08-19** 访问或核验；页面内容与授权可能变更，接入前应保存 `fetched_at` 和版本/哈希。

### 8.1 交易所、披露与分类

- SSE 对外公示数据目录（市场概览、股票成交、指数、融资融券、质押、交易公开信息）：<https://www.sse.com.cn/market/publicdata/>
- SSE 股票成交概况（日/周/月/年）：<https://www.sse.com.cn/market/stockdata/overview/day/index_his.shtml>
- SSE 融资融券汇总口径：<https://www.sse.com.cn/market/othersdata/margin/sum/>
- SSE 交易规则（2026 修订；交易信息使用/传播、即时行情、交易时间）：<https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml>
- SSE 行业分类说明/以中国上市公司协会结果为准：<https://big5.sse.com.cn/site/cht/www.sse.com.cn/assortment/stock/areatrade/trade/>
- SZSE 统计资料目录（成交、行业统计、融资融券、质押、行情）：<https://www.szse.cn/market/periodical/index.html>
- SZSE 2026 交易规则发布：<https://investor.szse.cn/lawrules/rule/trade/t20260424_620190.html>
- SZSE 法律声明/内容与行情信息知识产权及商业使用限制：<https://www.szse.cn/application/laws/>
- BSE 股票行情/行业分类入口：<https://www.bse.cn/nq/quotation.html>
- BSE 交易规则（2026；交易信息归本所、许可使用/传播）：<https://www.bse.cn/jygl_list/200028217.html>
- CNINFO 法定信息披露平台公告查询：<https://www.cninfo.com.cn/new/commonUrl?url=disclosure%2Flist%2Fnotice>
- CNINFO 个股披露/财务/股东/事件入口（示例结构）：<https://www.cninfo.com.cn/new/disclosure/stock?stockCode=600448>
- CSRC 行业分类指引（2012 修订）：<https://www.csrc.gov.cn/csrc/c101864/c1024632/content.shtml>
- CSRC 行业分类结果目录：<https://www.csrc.gov.cn/csrc/c100103/common_list_2.shtml>

### 8.2 政策与宏观

- CSRC 政府信息公开指南：<https://www.csrc.gov.cn/csrc/c100033/c1320793/content.shtml>
- CSRC 规章库：<https://www.csrc.gov.cn/csrc/c106256/fg.shtml>
- 国务院政策文件库：<https://sousuo.www.gov.cn/zcwjk/>
- PBOC 社会融资规模存量统计表及口径：<https://www.pbc.gov.cn/diaochatongjisi/fileDir/resource/cms/2024/01/2024011510325158987.pdf>
- PBOC 公开市场业务交易公告目录页：<https://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125431/125475/17081-40.html>
- 国家统计局国家数据（GDP、CPI、PPI、工业增加值等）：<https://data.stats.gov.cn/easyquery.htm>
- 国家统计局数据发布与统计指标：<https://www.stats.gov.cn/sj/>

### 8.3 现有聚合端点与条款

- EastMoney 用户服务协议（行情数据复制/再提供、准确性/连续性免责声明）：<https://about.eastmoney.com/home/protocol>
- EastMoney 行情页面免责声明：<https://quote.eastmoney.com/>
- Tencent 现有公开行情端点（示例；未找到针对本项目的 API 合同/授权）：<https://qt.gtimg.cn/?q=marketStat>
- 现有代码端点见：`mona/services/stock/provider.py`、`mona/services/stock/provider_tencent.py`。

### 8.4 通达信、Tushare、开源备选

- 通达信官方 HTTP 调用文档（localhost:17709，要求 TQ 客户端）：<https://help.tdx.com.cn/quant/docs/markdown/mindoc-1hdhbmi50d038.html>
- 通达信官方市场交易数据字段（要求客户端先下载股票数据包）：<https://help.tdx.com.cn/quant/docs/markdown/TdxQuant.md/mindoc-1h10p8op6ia9g.html>
- 通达信用户服务协议：<https://www.tdx.com.cn/about/yhxy/index.html?tabindex=1>
- 通达信全品类数据库/数据包服务说明：<https://www.tdx.com.cn/tdxdata.html>
- Tushare 积分与频次权限：<https://tushare.pro/document/1?doc_id=290>
- Tushare API 权限说明（更新频率、最低积分）：<https://tushare.pro/document/1?doc_id=108>
- Tushare `daily_basic` 字段/权限：<https://tushare.pro/document/2?doc_id=32>
- Tushare `share_float` 字段/权限：<https://tushare.pro/document/2?doc_id=160>
- Tushare 用户协议：<https://tushare.pro/document/1?doc_id=409>
- Tushare 数据服务协议（非商业/个人查看许可和不保证条款）：<https://tushare.pro/document/1?doc_id=405>
- AKShare 上游 README（学术研究声明、接口可能移除）：<https://github.com/akfamily/akshare/blob/main/README.md>
- AKShare 上游介绍（公开站点采集、目标页面变更风险、学术研究用途）：<https://github.com/akfamily/akshare/blob/main/docs/introduction.md>
- BaoStock 官方站点（免费/无需注册宣传）：<https://www.baostock.com/>
- BaoStock 官方示例 PDF（历史行情/财务查询示例）：<https://www.baostock.com/helpdocs/pdf/%E5%9F%BA%E7%A1%80%E4%B8%8D%E7%AE%80%E5%8D%95%E4%B9%8B%E5%B8%82%E5%87%80%E7%8E%87.pdf>

## 9. 最终门槛

- P2-T2 可以按本矩阵接入正式公告、政策、宏观、定期报告和规则事实，并把现有行情端点作为带降级状态的内部观测源。
- P2-T2 不得新增付费积分、行情授权、客户端私有协议或不明商业许可；不得把 Tushare 120 免费层、AKShare、BaoStock、通达信抓包数据写成正式生产源。
- 在完成交易所/供应方授权前，产品可以做内部研究和证据回溯；**不能宣称零成本完成可对外再分发的交付级行情数据后端**。
- 任一核心分区因来源不可得、公开时间未知、授权未确认或统计期缺失，必须显示 `missing/degraded/insufficient_data`；裁决 Agent 不得将其改写成 `neutral`。
