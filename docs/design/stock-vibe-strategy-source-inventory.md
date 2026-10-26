# Vibe 内置策略与生成材料源码盘点

- 日期：2026-10-21
- 用途：为[统一策略库设计](stock-vibe-unified-strategy-library.md)确定完整目录，避免只展示多因子示例或把因子数量当策略数量。
- 范围：仓库锁定的 Vibe 0.1.16 源码 ZIP，非测试 Python、Markdown、Jinja、JSON、YAML，以及相关宿主补丁。静态扫描后逐项读取策略入口、规则和输出；未逐个执行策略。
- 快照：`sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753`。
- ZIP：`third_party/vibe-trading/vibe-trading-source.zip`，18,034,920 字节；本轮实测 SHA-256 与 `source-lock.json` 一致：`1f3eeca190f1ce935ad71d3bb294f5e8bb1cbaa3f63fbb5304ff2e11a0fda83d`。

## 1. 计数与展示决定

找到 14 个标准 `SignalEngine` 示例、5 个期权实现、1 段完整 ML 示例代码。即 19 个 Python 内实现和 1 个文档内完整示例，构成内置策略来源目录的 20 个候选条目；这不是 20 个已在 Mona 接入或已验证有效的策略。

另有 1 个 Alpha 组合器，需要具体因子与参数才能形成策略；478 项因子、团队预设、占位与外部平台模板分别作为生成材料。当前没有锁定源码自带、宣称经过效果验证的 SDM 成熟策略种子库；SDM 内容属于运行时登记档案。

所有固定来源进入可查目录，保留“内置 / 示例 / 资产类型”和真实限制。能否在当前 A 股界面运行，分别检查数据、接口、依赖与策略逻辑。原生存在明确问题的策略不能在上线目录里被标成可正常运行。

## 2. 14 个标准信号引擎示例

下表来源统一为 ZIP 内 `agent/src/skills/<目录>/example_signal_engine.py`；行号指源文件。它们均提供无必填构造参数的 `SignalEngine` 和 `generate(data_map)`，输入是给定证券池的数据，不会自动取得整个市场。

多个文件附带联网 `__main__` 演示。受管实例化应复用现有多因子适配的来源/代码校验方式，仅剥离演示执行段，不改动交易规则。具有标准接口不等于已通过当前宿主运行器、依赖或行情验证。

| 名称 / 目录 | 源码位置 | 实际规则简述 | 数据、资产及接入限制 |
| --- | --- | --- | --- |
| 多因子排名 / `multi-factor` | 32、49、83–90、118–162 | 动量、5 日反转、低波动、量比做横截面 Z-score 后相加；默认 Top3 等权、每 20 交易日调仓 | 至少 2 个标的；当前唯一已在 Mona 显式提供固定示例回测的条目 |
| 基本面过滤 / `fundamental-filter` | 14、30、56–73、108–120 | 普通分支要求 0＜PE≤20、PB≤3、ROE≥8，合格股票等权；有财报字段时改用营收、盈利、净资产和 ROE 分支 | 要求 Tushare `extra_fields` / `fundamental_fields`。财报分支并未同时应用 PE/PB；缺字段不选，不能照搬摘要称两套规则共同生效 |
| 事件情绪筛选 / `event-driven` | 20、29、39–76 | `event_score≥0.2`，按分数选可选 TopN，再等权 | 需要历史可知时间安全的事件增强字段；仅有 OHLCV 无法计算 |
| 技术指标综合 / `technical-basic` | 122、147、188–249 | EMA/ADX 趋势、布林带/RSI 反转、OBV/量比三维投票 | 普通 OHLCV，输出正负方向；负数须沿市场引擎原义处理 |
| K 线形态综合 / `candlestick` | 81、91、479–527 | 单根、双根、三根看涨看跌形态加总并取方向 | OHLC；说明称 15 种，但实际 `generate` 组合 13 个检测输出，不能据宣传数字重复计数 |
| 一目均衡表 / `ichimoku` | 12、32、69、95–127 | 转换线/基准线交叉，叠加价格相对云带位置和云带方向；默认 9/26/52/26 | OHLC；须足够预热数据 |
| 艾略特波浪 / `elliott-wave` | 14、36、53、188、285、370 | Zigzag 摆动、五浪推动、ABC 调整和 Fibonacci 条件 | OHLC；摆动点有右侧确认时间。实现阶段的原生 AST 验证确认 `_zigzag` 的方法装饰器被当前运行器拒绝，目录保留但须适配后另存，不能声称可直接执行 |
| 谐波形态 / `harmonic` | 315、335、366–422 | Gartley/Bat/Butterfly/Crab 等 XABCD 形态，在 D 点生成方向 | 优先 `pyharmonics`，失败或缺包可回退内置检测；股票需 `is_stock`；D 点历史回填/确认时点须定向验证 |
| 缠论买卖点 / `chanlun` | 87、96、104–169 | CZSC 逐根更新，综合一买/一卖、三笔、五笔等结构 | 需要 `czsc`，至少 30 根 K 线 |
| 结构突破与缺口 / `smc` | 56、71、112–152 | ChoCH 优先、BOS 补充，再以同向或中性 FVG 过滤 | 需要 `smartmoneyconcepts`；整段 swing/BOS/FVG 的确认时间及前视问题须定向验证 |
| 配对均值回归 / `pair-trading` | 13、29、46–105 | 两资产价格比 60 日 Z-score，默认 2 入场、0.5 离场，配对仓位 ±0.5 | 恰好两个标的，依赖多空配对；不能直接裁成普通 A 股只做多策略 |
| 日历效应 / `seasonal` | 13、30、53–102 | 默认 1/2/3/11/12 月做多、5–9 月做空；可选星期效应 | 要求时间索引；同日期通常对全部输入证券给同方向，不是横截面排名器 |
| 波动率分位 / `volatility` | 41、59、82–112 | 20 日历史波动率在 120 日窗口中的分位低于 20 做多，高于 80 做空 | 年化默认 252，加密需 365；不是直接交易期权波动率 |
| 跨市场双均线 / `cross-market-strategy` | 14–22、36–82 | 按市场选双均线窗口，如 A 股 5/20，再按逆波动分配仓位 | **67–80 行以整个窗口最终波动率给全历史配权，存在明确前视问题。** 展示为实现待修正；外汇/期货符号识别也需核对，不标为可信历史回测策略 |

## 3. 5 个期权策略实现

来源：`agent/src/skills/options-strategy/example_signal_engine.py`。

| 名称 | 原生类 / 行号 | 原始规则 |
| --- | --- | --- |
| 现金担保卖 Put | `CashSecuredPutEngine`，168 | 约 0.30 Delta、35 天到期，持有至到期 |
| 铁鹰组合 | `IronCondorEngine`，186 | 约 16 Delta 卖跨、5 Delta 翼、45 天到期；50% 权利金止盈或剩余 21 天退出 |
| 波动过滤卖宽跨 | `VolGatedStrangleEngine`，213 | 短期/长期波动条件过滤后卖宽跨 |
| 备兑 Call | `CoveredCallEngine`，326 | 持股加卖约 0.30 Delta Call |
| 保护性 Put | `ProtectivePutEngine`，335 | 持股加买约 0.20 Delta Put，60 天到期、剩余 21 天滚动 |

原生 `ENGINES` 在 347–353 行映射五类；355 行 `SignalEngine = IronCondorEngine` 只指向铁鹰。注册五个条目时必须明确绑定各自类，不能复制同一默认入口冒充五种策略。

它们输出期权合约腿指令，不符合普通股票权重 Series 的使用语义。例子中的“股票腿”以接近零行权价 Call 模拟，并使用历史波动率与 Black-Scholes 合成价格，不是实际期权行情回测。普通 A 股入口仅展示说明和真实能力限制；本次不为了展示目录扩展期权交易或另造 A 股等价策略。

## 4. 完整 ML 示例与 Alpha 组合器

### ML 示例

`agent/src/skills/ml-strategy/SKILL.md:24–230` 包含完整 Python 代码块：OHLCV 特征、5 日涨跌标签、walk-forward 训练，默认随机森林，从 252 个训练样本起每 20 日重训，概率映射至 [-1,1]。也有 gradient boosting，以及名称为 ridge、实际采用 LogisticRegression 的分支。需要 scikit-learn。

它可以经固定代码提取与运行器校验成为内置示例。它目前不是独立 `.py` 资源，也不等于机器学习团队已经训练好的模型；训练数据、标签可知时间、模型版本及推理产物仍需执行留档。

### Alpha 组合器

`agent/src/skills/multi-factor/zoo_signal_engine.py:60–141、251–299` 提供 `ZooSignalEngine`，需 `alpha_ids`，支持明确权重、标准化及 TopN/BottomN，已有 `generate` 适配。

组合器本身没有一套固定参数。AI 在用户需求下确定因子、方向、权重、范围与数量后，才保存为具体策略；不由开发者预造大量“内置组合”。

## 5. 不计入成品策略的材料

| 对象与来源 | 实际是什么 | 处理 |
| --- | --- | --- |
| `src/factors/registry.py:1–19、325–343` 及因子库 | 478 项：academic 12、alpha101 101、fundamental 20、gtja191 191、qlib158 154；部分需额外字段 | 因子目录供研究/组合/评测；不自动作为 478 套交易策略 |
| `strategy-dev-manager/templates/factor_signal_engine.py:47`、`strategy_signal_engine.py:53` | TODO 要求替换为论文真实逻辑；保留动量/均值回归占位实现 | 生成材料；不能用论文名称给占位算法背书 |
| `strategy-generate/examples.md:3、19、35` | 双均线、RSI、加密趋势的三个工具调用教程，没有策略引擎代码 | 可指导 AI 生成，不重复注册成三套已经实现的策略 |
| `minute-analysis/example_signal_engine.py` | 分钟行情、VWAP/TWAP、成交量分布等分析函数；没有 `SignalEngine` | 数据/研究能力，不是成品策略 |
| `shadow_account/templates/signal_engine.py.j2:10–15、32–134` | 根据成交提炼规则生成代码的动态模板 | 需已有规则，生成后归用户资产 |
| `vnpy-export/scripts/cta_template.py:27、58` | `MaCrossStrategy`，继承 vnpy `CtaTemplate` | 外部平台导出模板，需要外部运行上下文；不能直接交 Vibe 回测 |
| `tools/autopilot_tool.py:418` scaffold | 默认全部空仓的占位引擎 | 需补实际规则，不能以空仓技术通过冒充有交易策略 |
| Swarm YAML、其余技能教学片段 | 研究工作流、接口与执行示例 | AI 在对话中按需使用，不作为成品策略行 |

`StrategyDiscoveryFacade` 的 `facade.py:276–344、368–410` 会把 Alpha 条目和 SDM 条目放在 strategies 命名的目录中；接口名称不改变它们的真实对象类型。统一库需按 artifact 类型和实际执行产物分类，不能整包照搬返回值。

## 6. 当前接入与实施证据边界

设计前，`0048-hosted-backtest-settings.json` 中新增的 `mona_backtest_settings.py:75–108、141–150、388–394` 仅显式注册多因子固定示例：核对源文件、去除演示执行段、调整允许的构造参数，写入新运行并记录来源。其余来源当时仅随技能存在。

2026-10-22 已通过0053/0054接通本表20项来源的完整目录，以及统一版本解析、扫描、回测和对话生成登记；没有改写上述上游示例的金融公式。不能使用的条目仍可见，显示实际限制。运行包、测试及截图见[实现记录](stock-vibe-unified-strategy-library.md#10-实现与验收2026-10-22)。实际可运行状态继续取决于运行器、依赖、市场与数据条件。

仅有 README 描述、完整函数、模型声称完成或一次合成测试，都不足以证明真实市场有效。交付中保留源码存在、接口验证、实际行情执行和效果证据的各自范围。
