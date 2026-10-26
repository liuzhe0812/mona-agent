# Vibe-Trading 受控来源

`source-lock.json` 固定来源快照，`files.json` 固定归档内每个文件的 SHA-256；包版本只是上游声明，不是提交身份。原始归档永不就地修改。

```powershell
python -m tools.stock_vibe.snapshot verify
python -m tools.stock_vibe.prepare --destination .codex_tmp/vibe-native
```

准备命令只接受尚不存在的目标，先校验整个归档，再在暂存目录应用精确补丁，成功后移动到目标。无需访问开发机的原始源码目录。生成的 `agent/mona-source.json` 绑定快照与补丁摘要。

## 补丁

以下 SHA-256 是当前补丁 JSON 文件本身的摘要；源文件前像另由每个补丁的 `files[].sha256` 固定。当前目录的 `0001–0027` 均已冻结。`0018` 与 `0020` 的摘要已由实际文件核对，并随 preflight 5 来源收据进入该构建；`0021` 至 `0023` 的摘要已由实际文件核对，并通过隔离原生夹具测试。补丁冻结及其进入隔离构建不代表正式切换或发布验收通过。

| 文件 | 分类 | SHA-256 | 目的 |
| --- | --- | --- | --- |
| `patches/0001-host-isolation.json` | 宿主接入 | `c9083da2c7dacdae83c0a51c19195c191202f618e35457d53089a3acb55a6caa` | 显式私有数据根；隔离独立 Vibe 的 dotenv、配置与 legacy migration；限制文件路径；保留原生回测沙箱；认证实例握手；宿主启动不进行联网预检。 |
| `patches/0002-cli-host-alias.json` | 确认缺陷 | `002b57ae952e034a084edfd85bf25e287e00ea6465647b27f0ff54b8aa998faf` | 修复隔离启动时 CLI 以 `__main__` 运行而路由注册器需要 `api_server` 模块别名的问题。 |
| `patches/0003-shadow-data-source.json` | 宿主接入 | `76ac1b533d0f237db45f10a63f38e9ef23ed383de6223801ea2999a98d2a0bbf` | Shadow 显式选择数据源；扫描记录实际来源、覆盖与缺失；全无数据时返回错误。 |
| `patches/0004-host-requests.json` | 宿主接入 | `dfa9725892fca306b5a587d69455f8c43a4c43d19ac7be5344c8a34177b3cf77` | 对选定写入口先持久化稳定请求 ID，提供回执查询与真实活动计数；未知结果不重复派发。 |
| `patches/0005-terminal-execution.json` | 确认缺陷 | `3080e68c39af63cd11e59e5b62d9ae535bbd05a1f09b08d825d9733ce869bed0` | 修复回测末日强制平仓绕过 T+1/涨跌停的问题；不能成交的持仓保留并按末价计值。 |
| `patches/0006-host-shutdown.json` | 宿主接入 | `6a0c070c965ffed7aa3ee1955a7c4528cf5a23ef27814ce7d10b11257fe86dae` | 认证关闭入口触发 Uvicorn 正常清理；独立 Vibe 启动行为保持原样。 |
| `patches/0007-ashare-preset.json` | 宿主接入 | `fcf13d9a45ed121b38300e23b20b514e4450003a83e5fa3c108a2d5dd560d9a2` | 增加两节点串行 A 股数据与证据复核预设；保留原生 Swarm、依赖、工具和产物。 |
| `patches/0008-host-readonly-trading.json` | 宿主接入 | `39d910589993b702b1da33c6b12b77e7606598165fb297f48d9c78e22b28a9ba` | Hosted 下隐藏并拒绝在线券商写操作；保留已分类的读工具与本地研究工具。 |
| `patches/0009-host-operations.json` | 宿主接入 | `ee5ff4c45a94e0b231ecb33439febe9473f765422d51f4aa07700d0746b2dc09` | 提供有界原生回测/Shadow 操作与 A 股行情读取路由。 |
| `patches/0010-host-reads.json` | 宿主接入 | `0d10e9aecc8d30ed9b51c8130c436086abcbe03d7e6e03bf64ca81d5199d5f41` | 按原生身份读取 attempt、Shadow profile 与受限产物句柄，不暴露物理路径。 |
| `patches/0011-host-swarm-read-roots.json` | 宿主接入 | `025dbc0ac04d09e32f1f3448359bef234a7ff245c353ebf7fb085349a478de9d` | 允许 hosted Swarm 读取私有 Swarm runs 下的同伴证据；不扩大写入根或独立运行根。 |
| `patches/0012-host-swarm-asof.json` | 宿主接入 | `5f060f8aff1551c9e29d842f81e558e3ecf789c1b46aa085d271855c8bf9beba` | 限定 hosted A 股研究的历史窗口并记录实际行情加载来源。 |
| `patches/0013-host-swarm-artifacts.json` | 宿主接入 | `6200fcec995e6d0acbb91d338af32d71347e164910e53b5abb239606be518ff6` | 只按已持久化的原生 Swarm 产物引用提供受控下载。 |
| `patches/0014-hosted-strategy-boundary.json` | 宿主接入 | `847967684d085ab677024af1e12fe824c5eb749cc6e1df73a026fb2299c06805` | Hosted 下为生成策略文件读取、路径和动态属性别名增加静态限制。 |
| `patches/0015-hosted-research-scenarios.json` | 宿主接入 | `51e9dadd6c7701915d0c7531781a8fb32084a4f9f200b1c46c75737d3e77f24b` | 增加仅 hosted 可用的结构化情景追加、原生来源收据、条件观察函数与只读列表/详情路由；数值阈值必须引用同一 run 的观察行情事实。 |
| `patches/0016-hosted-scheduled-firings.json` | 宿主接入 | `8e84fe1f7f003330c195e11e3d0c895d7e99cf6405ebd2f8b2d3549a6a8ad589` | 原生 Scheduled Research 派发前持久化 firing claim 并关联 attempt；未知结果不作为新 firing 重试。 |
| `patches/0017-hosted-runner-process-tree.json` | 宿主进程生命周期 | `0faf2ab80e0ddab1154879d6f1db031c299cab39764cdc2e1ba9d66b6ae01e6f` | Hosted Windows 回测子进程由独占 Job 管理；关闭时一并回收启动器及其后代。 |
| `patches/0018-hosted-attention-policy.json` | Hosted 主动关注 | `a935284f6c83eb0182143a702111862a13a19dba55382fd68b2d180d731dd2a0` | 在既有 scheduled-research tick 内运行持久关注策略，以来源行情观察情景条件，并记录可领取、可确认的通知状态。 |
| `patches/0019-hosted-owned-records.json` | Hosted 状态完整性 | `5ac62f3b4b8551677793560afce896a3d69e61f39603f3e5aea87e0f1a66e252` | 阻止通用文件工具写入引擎自有 session、情景、调度、run grounding 与来源收据文件，要求走专用原生工具。 |
| `patches/0020-hosted-backtest-inputs.json` | 宿主接入 | `2b9a73dbeabd38aa779a0bf014ce9511cac6a6dbf8f23978a1370dc55f389dd1` | 提供认证的安全回测输入列表，只读已有原生输入，不读取提示词、不执行策略、不计算结果或修改 run 状态。 |
| `patches/0021-hosted-shadow-unavailable.json` | 确认缺陷 | `f047c2a586c22cb4d2bad4dff5b390667649ff52bb684c251f8b21f14bdb68ac` | Hosted Shadow 无可用指标时返回错误；缺少账户 journal 的比较字段保留为 null；报告缺失市场和账户证据时显示 N/A/未计算；显式 `local` 无数据时不回退到网络 loader。 |
| `patches/0022-hosted-shadow-cache-inputs.json` | 确认缺陷 | `ea054458854ed5d0e8ca4000dba3c76146946a532432cc2c9fd9492f380e9a00` | Hosted Shadow 缓存绑定窗口、profile 与实际 journal 哈希、source、market scope 和篮子数量；仅同输入的报告可复用，缓存缺失时要求先完成对应回测，不隐式重跑。 |
| `patches/0023-hosted-shadow-account-comparison.json` | 确认缺陷 | `201d169cde5779f9b7aa45d179c5fc80f1d162d89eb268dd0bf65566e34789b5` | Hosted Shadow 仅保留独立回测；缺少同一窗口的完整账户初始持仓、本金和净值证据时，个人账户收益、delta 与经济归因均为 null。旧 hosted 缓存也只恢复 Shadow 指标，并在读取时隐藏旧差额，不改写旧缓存文件。 |
| `patches/0024-hosted-trade-journal-operation.json` | 宿主接入 | `c57a3267d0a008f192df531fecbfa766fcd6252fd13afae14845c17cee478df6` | 通过私有上传 ID 调用原生完整成交记录分析；API 投影将非有限数值转为 null，并保留原生原始结果。 |
| `patches/0025-hosted-shadow-report-metadata.json` | 确认缺陷 | `b94b6a79f3acf15159410ffce14830bf0e186b8e8133b210b67863317dbd41e8` | 分开标记 journal 提取窗口与 Shadow 回测请求，记录报告生成时间；显式注明未请求信号扫描，并提示零成交结果不代表策略有效性。 |
| `patches/0026-hosted-strategy-oos-validation.json` | 宿主接入 | `5b5b68a790eaacde7a2758d94fecd859928dda939761cedcaa38504d34af4eaa` | 固定已完成 A 股策略代码，在开发期之后新建独立成本情景运行，保存原生 validation.json；缺数据不补零，不合成通过阈值，策略 run 的严格因子检验标注不适用。 |
| `patches/0027-hosted-strict-factor-validation.json` | 宿主接入 | `9d90ec6acb73e259e8574d31c3560d4862764a1c8cde6df0ac844e8e00f81565` | 独立调用原生严格横截面 IC/OOS/随机对照检验，仅用内置 Alpha101/Qlib158 与固定 CSI300；缺少显式行情配置或成分降级时不可用，完整保留原始因子、跳过项和数据范围。 |

0021–0023 的原生夹具回归验证无数据错误、合成 7-bar Shadow 结果、完整缓存输入和同窗口账户证据缺失时的 null 投影。它也验证旧版本 hosted 缓存中的 71 元跨窗口值不会在读取或 PDF 中恢复，旧缓存文件保持原样。`shadow_baseline.py` 的 Report 调用现在重用 Backtest 的完全相同窗口、source、markets、篮子数量和 journal。0025 的隔离合成回归验证 PDF/HTML 显示 journal 窗口、回测窗口与请求数据范围，并验证 hosted 报告默认不扫描、显式扫描请求被拒绝。测试使用 verify 6 Python 3.13.15 环境和合成夹具；它们不是产品 UI 验收，也不代表 preflight 9 或发布验收通过。历史 Shadow 误报及失败文件摘要见 [Shadow baseline](../../docs/design/stock-vibe-shadow-baseline.md)。

0026 的 fresh 1–26 源通过真实本地 Runner 定向测试：固定代码的开发回测及两个不重叠验证期成本情景成功运行，成本变化进入结果；源代码和配置字节未改写，原生验证文件存在，无数据不补零。原生无总体通过门槛，因此只保存原始 checks；严格因子数据/入口不在此策略实验中，未执行。该测试使用隔离 Python 与合成行情，不代表产品 UI 或正式切换通过。

0027 的 fresh 1–27 源使用真实打包 alpha101 registry 和合成横截面数据运行严格内核，生成 71 行与 30 个跳过项；数据不是真实 Tushare 成分，因此外围仍标 unavailable，不能冒充沪深 300 验收。无显式 TUSHARE_TOKEN 分支不调用取数。该凭据是原生行情服务凭据，现有回测 loader 与策略在同一子进程使用原生行情白名单；这里没有建立其与策略代码的 OS 密钥隔离，也不改变模型/券商凭据禁入边界。真实 Tushare 权限和网络数据仍需单独验收。

研究、Swarm、策略、回测与 Shadow 仍由原生体系执行。0005 是真实基准发现的成交规则修复，保留修复前失败及同输入重跑证据。原生身份由受控构建收据、实例、进程和数据根摘要共同确认。上游升级必须重新审核补丁，源文件 SHA 或精确文本不符即拒绝应用。

依赖选择与许可来源见 [来源审计](../../docs/design/stock-vibe-source-audit.md)，宿主边界见 [稳定架构](../../docs/architecture/stock-vibe-integration.md)。`requirements-windows-cp313.lock` 固定已实测的 187 个 Windows CPython 3.13 wheel；`build-requirements.lock` 与 `build-receipt.json` 记录 jsonpath 源码转 wheel 的哈希及工具链。用户端只安装 wheel，不运行源码构建。离线安装与实际大小见 [运行包验证](../../docs/design/stock-vibe-runtime-verification.md)。此源码归档不是可发布运行包，不包含运行环境或用户数据；公开下载目录、完整平台发布资格仍未验收。

## 统一策略库扩展（2026-10-22）

| 补丁 | 分类 | SHA-256 | 范围 |
| --- | --- | --- | --- |
| `patches/0053-unified-strategy-library.json` | 宿主接入 | `c33c9f29814ec8514cf2aa6a8abe2de129f27669211b8bbc1354022a8317b5d9` | 20项固定来源和SDM策略目录、版本绑定、受控Runner扫描与原生回测、完整持久历史、独立策略会话及真实产物登记 |
| `patches/0054-unified-strategy-results.json` | 确认缺陷 | `6a29dcbd6f5a5c8a566b9e7b093a07b60eb52d75ec484832ae1432210383ca0c` | 核对最终编辑回执与配置/代码归属；不完整保存明确反馈；最新时点全部不可计算报错，合法全零信号正常返回；原生示例接口不兼容局部说明 |
| `patches/0055-custom-strategy-deletion.json` | 宿主接入 | `9c8fab7875ac4b28f8440562344a46a5f20a0a75e3e74481bcf74c50bf787784` | 版本绑定的自定义策略删除；原生停用并保留原版本、历史与报告；已删档案只读，禁止新执行、修改及状态更新复活 |
| `patches/0056-strategy-stock-scopes.json` | 宿主接入 | `dfe44847ba4975a74cb000f0764e75a8dca6d585b77e2bcadfdd48990cfe24ae` | 全A股、具体行业、自选范围；分页完整目录与A股交集；持久任务中解析完整成员快照；作用域限定的缺股覆盖、超时及结果容量处理 |
| `patches/0057-strategy-scope-resilience.json` | 确认缺陷 | `8413c6d136a547421867b31f2cb937f72df8f7916ec8e44e2918daaeec479de3` | 完整行业目录10分钟缓存并保留原时间；合并并发加载；仅连接/超时有限重试，失败与不完整目录不缓存 |
| `patches/0058-strategy-scope-transport.json` | 确认缺陷 | `5e6c7df73e4e64e39c01a1d0c45deb036d09cdf1a5c5fa862546997d35b0198a` | 目录请求复用线程本地 Chrome Session，每次请求读取系统代理，保留证书校验、节流和有限重试；修复真实目录读取中的连接中断 |
| `patches/0059-custom-strategy-ai-editing.json` | 宿主接入 | `888df81f5a2b98e517afedd25bbb7234c4aa8a9c23419095c1b2fc49837c5fdb` | 仅允许未删除且版本匹配的自定义策略作为AI修改来源；创建、发送与登记前校验，保留普通内置研究及独立新建，修正不可用内置策略的行动提示 |
| `patches/0060-strategy-catalog-loading.json` | 确认缺陷 | `5b88a5cbb864cb8b09757befa751f617c16347d8c76b4e3b0a79e97ce9c389c8` | 先按来源选择目录，复用不可变内置展示信息并返回深拷贝；自定义详情及执行前源码、版本、删除校验保持实时 |
| `patches/0061-native-startup-loading.json` | 确认缺陷 | `a3f4fc8b5c7c9a07cd49fd0958ef7c212f1a6b1b6436f16749ff5dccb3766bf9` | 按真实属性访问延迟AgentLoop、模型构建器及Swarm执行器导入，保留公开导出及路由；减少策略读取前的无关冷加载 |

运行包`stock-vibe@0.1.16+mona.strategy.library.2`已通过统一仓库及stock-vibe隔离Python环境安装，SHA-256为`744f988a9cc16beb61ffd5fcfe842667d3a111936019ffb6d42a94b0c47fd2a3`，195,862,869字节。源码锁和wheel锁未修改。真实Session/AgentLoop/工具/Runner链、宿主API与隔离浏览器流程已验证；计算使用合成本地行情，模型响应脚本化，不代表真实市场有效或正式桌面发布。详细交互、测试范围及运行截图见[统一策略库实现记录](../../docs/design/stock-vibe-unified-strategy-library.md#10-实现与验收2026-10-22)。

0055删除扩展已追加安装为`stock-vibe@0.1.16+mona.strategy.library.3`，运行包SHA-256为`2dd7a67068ca12c14af272c38c9d4cb7528ebff47f4cbe17f98fead87c7a14e2`，195,864,122字节，隔离Python环境generation为`37f83c90b3dfe5d95c6ff72213c24531`。自定义删除及原有完整生成/编辑登记/扫描/回测探针均通过，冻结的0053/0054未修改；详见[删除功能记录](../../docs/design/stock-vibe-unified-strategy-library.md#11-自定义策略删除2026-10-22)。

0056–0058范围扩展已通过统一安装器安装为`stock-vibe@0.1.16+mona.strategy.library.6`；运行包SHA-256为`cf4e0f63f219e88c4473713a02fd6029d28b239d5080ebfd8553bf493baac6b3`，195,871,189字节，隔离Python环境generation为`98603694f6294ae6816028dd537338d7`。源码与依赖锁未变；原生受控回归及独立目录来源探针通过，最终产品接口的行业来源连接仍有失败，不能等同于完整真实行情选股验收。范围语义、运行证据及限制见[范围功能记录](../../docs/design/stock-vibe-unified-strategy-library.md#12-全a股行业与自选范围2026-10-22)。

0059自定义修改限制已安装为`stock-vibe@0.1.16+mona.strategy.library.7`；运行包SHA-256为`13495cc1ee2fe6d00aa1f37adaf20bc4f21bd0921c96d6c9bf2725d831fc4620`，195,871,355字节，隔离Python环境generation为`fc44c227d33ef5b475468c93e36808e2`。原生完整探针验证内置修改在模型前拒绝、自定义真实派生及普通研究/扫描/回测保留。接口与UI修正的验证范围见[修改限制与交互记录](../../docs/design/stock-vibe-unified-strategy-library.md#13-自定义修改限制与交互修正2026-10-22)，不改变第12节记录的真实来源连接限制。

0060/0061读取优化已安装为`stock-vibe@0.1.16+mona.strategy.library.8`；运行包SHA-256为`df51b17e8c13e17ecc8d0d9fe16ad4168378733f018a3724ef7a28198a2e944f`，195,872,082字节，隔离Python环境generation为`c34e6fc39319c2bb8891795a24cd8fc9`。展示缓存与执行身份隔离、延迟导出/路由/真实Session兼容回归通过；完整读取计时与剩余文件校验优化见[性能记录](../../docs/design/stock-vibe-unified-strategy-library.md#14-策略读取性能2026-10-22)，不以模块导入提速替代端到端证据。
