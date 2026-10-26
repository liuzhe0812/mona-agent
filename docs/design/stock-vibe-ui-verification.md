# Stock Vibe 功能验证记录

状态：正常桌面开发实例默认开放新版功能。旧版归档入口、执行权状态和“验收后启用”阻断已删除；不再以验收声明控制用户测试。

## 正常桌面服务实测（2026-10-17，当前）

使用仓库根目录 `npm run dev` 启动真实 Tauri、Gateway 和 Services，保留该开发实例供用户直接测试。未使用预览服务、执行权回调或临时数据根放行。锁定 ZIP 经 `RuntimeComponentStore` 安装到真实统一运行时，并由 `PythonEnvironmentBuilder(environment="stock-vibe")` 离线构建解释器，组件为 `stock-vibe@0.1.16+stock.preflight.11`，环境 generation `4a7b7dbb1621f3e4f2eaf1d67cf33ea5`。

按用户已确认的模型来源，股票配置选择现有 Mona API 默认预设，真实绑定百炼 `qwen3.7-plus`。正常 Services `/api/stock-vibe` 返回允许执行；行情、团队预设、策略运行、操作及账户读取端点均返回 200。600519.SH 的行情请求窗口为 2026-09-16 至 2026-10-16，实际来源 Tencent。账户端点可读不代表已连接真实券商。

正常投研 session `35630bdfdd07` / attempt `ec5d143167a3` 实际完成，报告原生状态 `completed`，grounding `valid=true`、`issues=[]`；这不等于策略有效性或投资建议正确。正常团队 run `swarm-20261017-072748-c7e56dd3` 的研究与复核两节点均完成，并生成实际证据文件和复核报告。通过宿主 API 下载的 `evidence.md` 为 3,690 字节，SHA-256 `b7ccf85aea27721501ab0feaa90c395b2efd8771018cb951dbf0fd3871ff16ca`，与原生产物索引一致。

这些请求走用户正常开发实例的 Services 端口和正常原生数据目录，未修改鉴权、幂等、未知写入恢复及交易只读限制。记录位于 `.codex_tmp/stock-normal-acceptance/`、`.codex_tmp/stock-normal-acceptance.log` 与 `.codex_tmp/stock-normal-team.log`，不将用户数据或配置密钥提交仓库。

最新定向验证：前端 28 项、TypeScript、主界面 Vite 正式构建通过；后端默认访问/鉴权/退役拒绝/配置/工具/边界等 45 项与 4 个 subtests 通过，3 项真实组件用例另行通过（私有测试数据根、未配置模型）。测试读取真实统一运行时，不再依赖旧 `verification.json` 临时目录门槛。此前指向补丁 1–6 的旧测试目录产生过 2 项失败，已改为统一运行时解析并复验。

下方为此前阶段的历史记录，不能用于恢复旧归档入口或验收启用开关。

## 删除旧实现后的入口验证（2026-10-17，历史）

`App → StockEntry` 只有新版页面与独立只读历史归档，没有旧执行页面分支。旧 HTTP 路由不再注册；旧任务、cron 和陈旧工具注册永久拒绝派发。旧 `stock` 配置在加载时移除，不改写用户原配置文件。

临时入口改为渲染同一个 `StockEntry`，使用 preflight 11 和新建私有数据根实际打开。投资工作台、机会选股、AI 投研、策略实验室、账户与复盘均可见；添加 600519.SH 后，新版原生服务取得 Tencent 的 79 根日 K，界面显示覆盖 2026-06-22 至 2026-10-16。未调用模型、连接券商或写入正式执行权。截图：`.codex_tmp/stock-vibe-entry-removal-preview-2/stock-entry-after-removal.jpg`。这是生产入口组件的隔离运行证据，未启动整套桌面应用。

前端 8 文件 115 项测试通过，TypeScript 检查和主界面 Vite 正式构建通过（`.codex_tmp/stock-removal-web-build/`）。删除后的路由、旧配置兼容、退休任务拒绝、原生执行门槛、历史归档及通用会话等 11 个后端测试文件合并运行，84 项与 4 个 subtests 通过；记录：`.codex_tmp/stock-removal-backend-tests.log`。Rust `cargo check --locked --lib` 通过，服务能力统一为 `stock-vibe-v1`。

Windows Rust 单测初次因测试 EXE 未带 Common Controls manifest 返回 `0xc0000139`。仅给本地测试产物嵌入 tauri-build 自带的 `windows-app-manifest.xml` 后，Services 能力测试 1 项、backend_process 测试 9 项通过，1 个子进程夹具按设计忽略。未修改系统 DLL 或正式应用构建配置；不声称未经此处理的干净 Windows 单测命令已通过。

临时预览已关闭，55530、55531、55532 三个端口与其自有进程退出。下方记录为删除旧实现之前的历史验证过程。

## 实测证据

受控预览记录位于 `.codex_tmp/stock-vibe-ui-preview-1/`。验收只读使用了 `research-evidence.json`（SHA-256 `0f269c373923e92c68cce039ed4898471969a3b6d480cb9c207f18d577352a40`）与 `research-report.md`（SHA-256 `b3337e19ee1d0ac5f1964ed7dc46584319238674dd4eeff4b15250a0c6eb89dc`）；未把私有报告正文或账户资料复制进仓库。

实际 UI 将“沿用 Mona API”解析到 `qwen3.7-plus`。选择仅改变预览会话的内存状态，没有修改全局配置。屏幕同屏显示腾讯来源的 80 根日 K。一次用户发送只产生一次宿主消息提交；原生研究循环实际调用两次 `get_market_data`，并拒绝四份中间答案。最终 attempt 为 `completed`，grounding ledger 有 160 条行情事实，最后一次数值证据核验 `valid=true`、`issues=[]`。

同一证据记录的研究数据区间为 2026-09-16 至 2026-10-15，来源为 Tencent。报告仍含需要人工核查的自然语言主张：交易日日期与窗口边界是否对应原始行、阴阳线描述是否与 OHLC 关系一致，以及观察阈值是否引用了正确标的和时点。grounding 的 `valid=true` 表示数值与已登记事实通过当前检查，不证明自然语言日期、窗口、K 线语义正确，也不代表预测准确或策略有效。报告中的条件是待验证假设。

## 尚未验收

最初预览未完成的 Markdown 渲染和布局检查已在后续记录中补充。本记录没有证明完整的旧入口零回退，不能据此认定正式应用已切换。

稳定架构要求四道独立门槛：[依赖边界、真实原生链路、失败状态与旧调用零回退、执行权冻结/迁移/恢复](../architecture/stock-vibe-integration.md)。研究预览只覆盖真实链路的一部分；团队、策略回测、Shadow 的后续有限验证见下文，正式执行权恢复和完整旧路径零回退均未由本记录证明。正式 App 保持未切换。

## 2026-10-17 后续验证

前述 Markdown 渲染与工作台窄窗口布局已修正；真实 UI 已检查。预览通过统一运行时的 preflight 5 升级启动，继续使用预览 1 的私有数据根，旧会话和操作未复制重建、未改写来源。当前证据不等于完整桌面发行验收。

### 历史情景存档

预览 2 中由 UI 显式发送一次历史研究问题，沿用 Mona API 的百炼 `qwen3.7-plus`。宿主创建请求 `8460fc7e971e4c31adf00229d011cebd`、消息请求 `c3148a4b61a94d988abe365816be97c3` 对应原生 session `64155687e9f3`、attempt `52f004e495ce`、run `20261017_004933_97_a2f042`。原生模型实际调用 `get_market_data` 与 `record_research_scenario`，保存 artifact `75ad04228a4b4bc9a0889c8df4834f13`，attempt 最终 completed。

情景为截至 2026-10-15 的历史观察，行情窗口 2026-09-16 至 2026-10-15；条件及失效阈值引用同一 run 的 Tencent close / low 原值及证据摘要。服务端记录完整来源对象及 20 项补丁，没有概率、目标价或个性化仓位。该链路验证情景保存与读取，不证明其后表现或判断正确。

真实读取发现前端此前把情景来源误当字符串，拒绝了服务端来源对象。类型、校验与展示已按原生对象修复；两项相关 UI 测试通过。工作台“走势情景”现能显示同一 artifact 的条件、来源时点、失效条件和编号，无需再次发起研究。证据：`.codex_tmp/stock-vibe-ui-preview-2/scenario-evidence.json`，原生 artifact SHA-256 `acdcb40a5bd1cdc7be20a1b7684bb36c46cfa53c1959cabfad37ce68d701729b`；截图 `scenario-ui.jpg` 与 `scenario-saved-ui.jpg`。这些文件仅在隔离验收目录中。

### 复盘报告缺项失败样本

preflight 5 的 Shadow 回测 `759cb976049545a9b61ab926e130f634` 在全范围无可用指标时仍返回 completed；原生报告 `05bb0c687fd840a48862cabb8afff0e9` 的 PDF 可以打开，但错误地把部分缺失市场指标及未计算归因显示为零。此次验收失败，不能当成有效财务结果。下载 PDF SHA-256 `4b03f93c71aaf48d4ea826f2e30a00d612c916c4b2054242a9ab712b40d83842` 与原生产物一致，原始文件和两页渲染图保留在预览 2，正在通过独立补丁修复并复验。

### 团队历史窗口复核

preflight 5 由 UI 发起宿主请求 `faa0a30d2e83c7b8293ebfb7eb51511c`，只派发一次，原生 run `swarm-20261016-170420-f6b6745f`。两节点依次真实完成，研究员调用一次 get_market_data、两次 write_file；复核员调用一次 read_file 读取上游实际证据文件。最终报告声明 `EVIDENCE_REVIEW=PASS`，该声明仍属于模型复核结论。

独立核对了请求区间 2026-09-16 至 2026-10-15：自动预取与工具返回的 16 行相同，所有行均未晚于截至日；evidence.md 中的 16 行 OHLCV 与两者逐字段一致。实际来源 Tencent，未发生回退。未独立校准复权、手/股单位或完整交易日历，不据 PASS 推导全部 PIT 或投资分析正确。

UI 读取真实 run / 两个 task / 最终报告，下载 evidence.md 后逐字节等于原生产物：3,780 字节，SHA-256 `b473b341e0ea214ade555056e090f1f062f2daabacfbddf42229cdf3baa9583f`。证据 `.codex_tmp/stock-vibe-ui-preview-2/team-evidence.json`，报告正文摘要 `c78e02794d73e292dd92fcbc2f419c943e3b271225685d4abef202c2ee480fda`，截图 `team-ui.jpg`。报告渲染修复长代码段撑破页面与路径隐藏误伤除法；当前 1440 宽视口页面 scrollWidth 与 clientWidth 均为 1440。

### 前端与桌面编译边界

相关 UI 测试、build tsconfig 类型检查通过。标准 ZCode 样式预生成后，Vite 正式构建成功，输出在 `.codex_tmp/stock-vibe-web-build-2/`；保留既有字体解析和 chunk 体积警告。没有运行独立 office-editor 构建，不能称整个桌面发行流水线通过。

普通 `cargo check --lib` 因当前 worktree 缺 `resources/mona-gateway` 失败；使用 tauri-build 官方支持的进程内 `TAURI_CONFIG={"bundle":{"resources":[]}}` 后，`cargo check --locked --manifest-path src-tauri/Cargo.toml --lib` 成功，21 个既有警告。没有修改 tauri.conf.json 或伪造资源。该检查仅证明 Rust 编译，不证明打包资源或实际系统通知投递。

通知点击现保留 artifact/session/attempt 引用：条件提醒打开所引用的历史情景，研究完成提醒只读打开对应 attempt 报告，不发起新研究。相关组件和引用身份测试通过；系统 toast 的投递、点击与后台行为仍未在完整桌面实际验收。

## preflight 8：成交统计、零成交回测与报告元数据失败

预览 3 运行验证通过的 preflight 8（补丁 1–24），继续使用原私有数据根。新页面来源没有本地会话选择，也没有配置研究模型；通过“查看已保存研究”只读打开已有 session `64155687e9f3` / attempt `52f004e495ce`，未发起新研究。`history-ui.jpg` 留存界面，原情景 SHA 未变。

已有上传 `da4bec945bae4438a2c1bd9fa0595ede` 的合成 journal.csv 经原生统计操作 `d7439cb46d4245b19e949d58b9c7eb48` 返回 10 条记录、5 组已配对往返、平均持有 1.4 日，原区间 2025-06-09 至 06-20，样本已实现盈亏 71.00 CNY。这不代表真实账户或净值。没有重新上传、调用模型或连接券商。

显式本地数据、A 股样本数 1、2025-06-23 至 07-01 的回测 `8d11265dd7db4b30a8ea04f8a0738ddd` 成功生成 7 个权益点，权益均为 1,000,000，收益 0%，成交数 0。实际画像要求 RSI14 和负的此前五日收益，七根验证 K 线不满足；目标仓位与实际持仓均为零。没有修改画像、行情或结束日期以制造非零结果。流程可运行不证明策略有效。

报告操作 `4f8c4975849f4273bdcc6e0440d57b76` 生成报告 `27e75411335b42458d91678c118bf306`，浏览器下载与原生 PDF 一致，71,069 字节，SHA-256 `2d83b0720520fac81169afe1bd7bbb274583809fe2ac4478a0047fb3cf4416a7`。账户比较与归因已为不可用，A 股有效零收益保持；但 PDF 只标注成交提取区间，未列实际影子验证区间、数据源、样本范围，报告标题时间也不明确，故此次报告元数据验收失败。原件与提取文本保留，不能作为最终报告交付。补丁 25 针对该问题修复。

显式扫描 `b06c26eaaa1b4764aa8c47910f880ffc` 截至 2025-07-01：尝试固定篮子 5 只，1 只有本地数据，4 只缺数据，已覆盖样本无匹配，整体为 partial。原生 `per_market` 是最多返回的匹配数，不是扫描样本数；界面已将回测数量改名“回测样本数（1–100）”，并单列扫描范围说明。没有声称全市场无信号。

上述原生行、宿主请求、来源与下载摘要见 `.codex_tmp/stock-vibe-ui-preview-3/ui-native-evidence.json`。预览已正常关闭，三个自有端口和原生 PID 均退出，记录于 `shutdown-evidence.json`。

## preflight 9：报告修复与同根历史复验

预览 4 使用已通过离线安装验证的 preflight 9（补丁 1–25），仍复用同一私有根；本轮没有模型调用、真实账户资料、券商连接或下单。UI 显式指定原合成附件、原画像、本地数据、A 股样本数 1 和 2025-06-23 至 07-01，分别发起回测 `4f17f0f6d0114ee7a19f0586041a9e03`、报告 `52021105f3ab4500b4d151d2d92a8110`，随后独立发起截至 07-01 的扫描 `21d1d2dd2bc2464facc1f83c76100478`，三个操作均 completed。宿主各只有一个创建请求，来源均记录完整 25 项补丁。

回测仍为七个权益点、零成交、0% 收益；没有为得到非零结果修改输入。独立扫描的 payload 使用默认每市场最多返回 3 条匹配，实际尝试 5 只、可用 1 只、缺失 4 只，已覆盖样本无匹配。UI 清楚列出部分覆盖与缺失代码，不把回测样本数解释为扫描数量。

最终报告 ID `d214cb011d2141559df02c649281dc37`。UI 下载的 `downloaded-shadow-synthetic.pdf` 与发布后原生只读文件逐字节相同：71,199 字节，SHA-256 `f4048063a20f918d70b4989d80aa9360aab58ff3e5497e92e6e98984a4d734a2`。提取文本并逐页检查三页渲染图，标题时间区分画像创建与报告生成；分别列出成交提取期、影子验证期、local、china_a、每市场篮子数 1；扫描标注 Not requested。账户收益、差额和归因仍为 null/未计算，不输出合成样本 71 的跨期比较；零成交提示保留。未发现文字截断或表格重叠。实际使用 ReportLab 回退引擎，不据此声称 WeasyPrint 或所有桌面环境可用。

本轮同时修正两处宿主/界面边界：报告五项日期与范围输入必须明确提供，宿主在派发前拒绝缺项；列表中的 lightweight completed 记录没有 tool_result 时不显示扫描或回测主结果，不能把详情缺失补成零/无匹配。真实重进页面已确认没有虚构扫描卡，打开历史成交任务后只读恢复原 10 条、5 组、1.4 日和样本盈亏 71，没有新建统计操作。原历史情景 JSON 和前两份失败 PDF 的 SHA 均保持不变。

最终定向检查：报告元数据原生测试与当时合同测试合计 3 passed；收紧必填合同后再次 2 passed、Ruff 通过。前端最新相关组件/API 12 文件 40 passed，入口单独 6 passed，build tsconfig 类型检查通过。此前 Vite 正式构建输出 `.codex_tmp/stock-vibe-web-build-4/` 成功；最后的摘要结果保护仅补做定向测试和类型检查，未重复整个桌面发行构建。

完整证据在 `.codex_tmp/stock-vibe-ui-preview-4/ui-native-evidence.json`、`pdf-review/`、`account-synthetic-ui.jpg` 与 `shadow-synthetic-ui.jpg`。所有预览自有端口及原生 PID 49236 已退出，浏览器临时视口已恢复、临时页已关闭。没有更改真实用户 ownership、迁移、合并或发布；东方财富真实导出格式、在线资格、严格实验入口、分钟行情与完整桌面系统通知仍未完成验收。

## preflight 10：独立区间与成本情景

预览 5 使用已完成离线安装验证的 preflight 10（补丁 1–26），继续复用同一私有数据根。另建 `ui-oos-contract-fixture` 与 600002.SH 的十二根合成行情，开发期 2025-06-02 至 06-09、验证期 06-10 至 06-17；原先的回测/Shadow 基准文件未修改。该输入只是确定性链路夹具，不是券商或真实市场样本。

真实 UI 创建一次开发回测，operation `e6570f7eae754b83b4cf267db6ed8536` 对应 run `mona-e4f13de1a93b4d8cac565eb0c5fef9fe`；随后以该已完成 run 为唯一策略输入提交独立验证 `c32fd5321f784463878459ecb2042437`，原成本与自定义佣金/滑点分别生成 `mona-bcf846eddc394b4fb3b40eeb6c2b5317` 和 `mona-88c315ea16e1493c933672953e23fc2b`。宿主仅有两个创建请求，回看任务与导出均没有重发。

两个情景使用相同原始 `signal_engine.py` 字节，单文件 SHA-256 `649fd06f4a4ff73aa577ab245defde03a5ceef5b60d21e9a5296ca098c9a1412`。原生 `code_sha256` 是带相对文件名及 NUL 分隔的代码树摘要，本例为 `467c7c71c091d2bf3532ea3b5f08ee5d9730aa472c90819f7bdcf933ae209163`，不是单文件 SHA。开发配置仍逐字节等于种子配置；验证期严格在开发期之后。原成本收益 `0.014779679999999962`，自定义佣金率 `0.002`、滑点率 `0.003` 后为 `0.011620412479999898`，UI 分别显示 1.48% 和 1.16%；两者各一笔成交。这些数值只证明原生费用配置影响这份合成夹具，不证明投资表现。

两个独立 run 都生成原生 `validation.json`，普通检验为 partial；UI 显示“部分执行、结果不可用”，保留各项 checks 和缺项原因，并说明原生没有总体通过阈值，不拼成通过结论。严格因子检验在此策略实验中为不适用；其独立横截面入口由补丁 27 另行接入与验收。

“查看此运行与产物”只读打开对应 run。浏览器导出的原成本权益 CSV 与原生产物逐字节相同：532 字节，SHA-256 `619b906c7637bb5f7767fd8efe9c5b3a91821a84b07033e03dd4c821ae9c6c9d`。从其他 run 点击历史独立实验能恢复其原输入与结果，不创建新任务；已补相关原生引用形状的 UI 回归。

证据 `.codex_tmp/stock-vibe-ui-preview-5/ui-native-evidence.json` 包含原生操作、宿主回执、代码树/单文件/验证文件与下载摘要，界面截图为 `oos-synthetic-ui.jpg`。预览自有端口及原生 PID 85268 已退出，临时页关闭。当前验证未使用模型或账户资料，也未向网络行情服务取数。

## preflight 11：严格因子未配置分支与升级历史读取

预览 6 运行已完成 fresh 离线安装验证的 preflight 11（补丁 1–27）。预览程序在自己的内存配置及进程环境中明确清空增强行情配置，没有修改用户的配置文件或使用真实 Tushare 凭据。真实 UI 选择内置 Alpha101、2025-01-01 至 12-31、训练截止 06-30，并固定 5 组随机对照、horizon 1、top 20，发起一次严格因子操作 `3f59f04a8f2b45f68127999eca5a6bf1`；宿主仅有一个创建请求 `227d5e40cc5641d68a510a9e5857d658`。

持久 operation 为 failed；其实验状态明确为 unavailable，原因 `tushare_token_unconfigured`，`no_network_attempt=true`、`native_result=null`。界面显示“严格检验不可用/尚未配置行情服务”，没有显示零个因子、零 IC 或通过结果，并说明基础行情与成交文件复盘可继续使用。任务的基础执行状态与数据/统计可用性分别呈现。截图 `strict-unavailable-ui.jpg`，完整操作、输入、来源 27 和宿主回执见 `.codex_tmp/stock-vibe-ui-preview-6/ui-native-evidence.json`。

严格数学内核的证据另属于 native 专项：真实打包 Alpha101 registry 在合成横截面上生成 71 行与 30 个跳过项，其来源不是 Tushare CSI300，外围仍标 unavailable 并保留 raw/meta。该结果没有出现在本次无凭据 UI 中，也不构成真实行情或授权验收。Qlib158 注册代码仍保留，未宣称已做同等真实数据验证。

升级后的 UI 从其他 run 点击旧独立实验，可只读恢复其输入、两个情景和验证记录，没有创建新任务。旧 patch-26 操作的 `source_json`、原始结果和更新时间逐字段不变；既有最终合成 PDF 与历史情景 SHA 也未变。当前普通检验将 `no_native_aggregate_gate` 显示为“部分执行 · 无总体结论”，与可用的回测指标区分；策略版本和原始 checks 可展开。截图 `oos-restored-after-upgrade-ui.jpg`。表单对不合法截止顺序及超过五个日历年的请求在提交前阻止。

本轮相关前端 15 文件 55 项检查通过，后续三个结果/历史/日期组件 13 项定向检查通过，最终 build tsconfig 类型检查通过。Vite 构建 6 已覆盖新增验证组件并成功；最后的日期边界、结果文案及历史交互以定向检查和真实预览复验，未重复整个桌面发行流水线。后台新增配置/签名/接口/合同相关 41 项、客户端 9 项定向检查也通过。此前后端集成 suite 的首轮失败及修复重跑仍保留，不描述成一次全绿运行。

预览 6 自有端口及原生 PID 59004 已退出，临时页关闭。所有金融结果均有原生来源，实测仅使用公开历史行情或明确的合成夹具；没有真实券商连接、账户净值比较、正式 ownership 写入、迁移、合并或发布。真实东财导出格式、增强行情权限、完整桌面及 OS 通知仍待验收，四道正式切换门槛保持未通过。
