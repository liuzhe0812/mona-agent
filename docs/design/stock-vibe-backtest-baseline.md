# 股票 Vibe 原生回测基准

## 用途

这是一组固定合成行情，用来核对受控 Vibe 源码中的本地 CSV 加载、A 股引擎、交易费用与回测产物契约。它不是免费行情源实测，不代表市场表现或研究结论；执行不请求行情网络。

上游压缩包没有 Git 元数据，不能确认提交或标签。基准绑定来源锁快照 `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753`，上游声明包版本 `0.1.16` 只作来源信息。脚本还校验受控构建的 `agent/mona-source.json`，确认来源快照和每个隔离补丁都与仓库锁定内容一致。

## 输入与运行

固定输入位于 `tests/fixtures/stock_vibe/backtest/`：`bars.csv` 是六根日线；`signal_engine.py` 只按固定 bar 序号提交 50% 持仓再退出，不包含选股逻辑；`config.json` 只使用 `local:600000.SH`，不设外部 benchmark。`halt_gap.csv` 的一个交易日缺少 OHLC，用于核验缺失 bar 的处理。

使用已安装锁定依赖的 Python，明确指定受控源码和新的隔离输出目录：

```powershell
python tools/stock_vibe/baseline.py `
  --source-root .codex_tmp/vibe-native-9/agent `
  --python .codex_tmp/vibe-venv-313/Scripts/python.exe `
  --output .codex_tmp/stock-vibe-backtest-baseline
```

源码参数可以指向 `.codex_tmp/<任意受控构建>/agent`；脚本会核对收据身份，不依赖构建目录名称。输出目录必须为空，并且位于 `.codex_tmp/` 或 `docs/plans/evidence/`。执行通过 `src.tools.backtest_tool.run_backtest` 调用真实 `src.core.runner.Runner` 和原生 `backtest/runner.py`，不替换 Runner。脚本将 `VIBE_TRADING_HOME`、Data Bridge、运行目录和临时目录限制在输出根；如果源码路径的祖先存在 `.env`，会拒绝运行，避免 dotenv 搜索读到外部配置。

成功后，输出根保留输入副本、运行命令、源码与 fixture 摘要、stdout/stderr、规则探针和 `baseline_manifest.json`。`native-home/runs/backtest/` 保留原生配置、策略代码、run card、`equity.csv`、`trades.csv`、`fills.jsonl`、`metrics.csv`、持仓及 OHLCV 产物。脚本要求原生 run state 成功、run card 证实数据源为 `local`，并且至少有一笔完整往返交易和非零费用。

## 已核实的规则边界

以下规则由受控源码和其对应原生测试确认；脚本运行时还会调用同一原生引擎和 local loader 输出一份隔离的 `rule-probe.json`。运行期数值以该产物为准。

| 规则 | 源码能力 | 边界 |
| --- | --- | --- |
| T+1 | `ChinaAEngine.can_execute` 按持仓建仓日与当前 bar 日期阻止当日卖出；原生测试覆盖当日阻止、次日允许。 | 只证明代码路径，不代表交易所或券商实盘验收。 |
| 整手 | 买入数量向下取整到 100 股；原生测试覆盖 250 股取 200、99 股取 0，基准成交量也会检查为整手。 | 未在本基准覆盖送转、拆并股等事件。 |
| 涨跌停 | 主板 10%，创业板/科创板 20%，北京代码 30%；引擎在实际开盘成交价上检查涨跌停阻断，原生测试覆盖主板、创业板。 | ST 身份和上市初期无涨跌幅限制无法从当前代码参数可靠判断；不能把 5% ST 规则或新股例外描述为已支持。 |
| 停牌 / 缺失 bar | local CSV loader 丢弃 OHLC 缺失行；引擎没有该日期的 bar 时拒绝下单。原生测试覆盖长缺口仍可完成回测。 | 无停牌状态字段，停牌与行情缺失无法区分；长期缺失的估值沿用最后有效价格，不代表已核实停牌价格。 |
| 费用 | A 股默认佣金率 0.025%、最低 5 元；双边过户费 0.001%；卖出印花税 0.05%。原生测试覆盖最低佣金及买卖印花税差异。 | 这是上游默认模型，不含券商费率、规费和个性化最低收费核验。 |

源码证据在受控快照 `agent/backtest/engines/china_a.py`、`agent/backtest/loaders/local_loader.py` 和 `agent/backtest/engines/base.py`；对应测试为 `agent/tests/test_china_a_engine.py`、`agent/tests/test_local_source_routing.py` 与 `agent/tests/test_engine_robustness.py`。本文件和合成行情不替代真实数据覆盖、实时 freshness 或实际交易验收。

## 本次运行证据

锁定依赖环境 `vibe-venv-313` 下，受控构建 `vibe-native-9/agent` 的真实运行成功。原生 `run_backtest` 返回 `status=ok`、`exit_code=0`，`state.json` 为 `success`；run card 的 `source` 和 `data_sources` 均为 `local`。没有请求网络行情，合成行情只验证执行与产物契约。

基准账户从 10,000 元变为 10,147.7968 元，输出 `total_return=0.01477968`；只有 1 笔往返，2025-06-04 买入 400 股、2025-06-06 卖出 400 股。原生 fills 分别记录买入费用 5.0408 元、卖出费用 7.1624 元，合计 12.2032 元。`equity.csv` 有 6 个样本日；`metrics.csv`、`trades.csv`、`fills.jsonl` 和 run card 均由原生引擎生成。短窗口合成年化、Sharpe 等指标不代表可用的绩效结论。配置没有外部 benchmark；原生指标仍以策略标的等权篮子生成内部比较值，本次 `benchmark_return=0.11`，不能解释成外部指数或行情来源。

真实规则探针记录在 `rule-probe.json`：同日卖出被阻止，次日可卖；250 股向下取整为 200 股，99 股为 0；主板、创业板、科创板和北交所幅度分别为 10%、20%、20% 和 30%，主板涨停买入及跌停卖出均被阻止；1000 股、10 元成交的原生费用为买入 5.1 元、卖出 10.1 元。缺 OHLC 的 2025-06-04 bar 未被 local loader 输出，基于该日期的开仓得到一次 `no_bar` 拒绝；输出没有 `halted`、`suspended`、`suspension` 或 `status` 列，因此只能确认缺失 bar 处理，不能确认缺失原因是停牌。

可复查证据保存在忽略目录 `.codex_tmp/stock-vibe-backtest-baseline-native9/`：`baseline_manifest.json` 绑定受控源码收据、来源文件和固定 fixture 的 hash；`native-home/runs/backtest/` 保存本次配置、策略、run card 和原生产物。固定行情 SHA-256 为 `5969ee22541236586585bae585cfc21c71362e2eb92a820527ceb1291ed538f3`，固定策略 SHA-256 为 `649fd06f4a4ff73aa577ab245defde03a5ceef5b60d21e9a5296ca098c9a1412`。

第一次使用 `vibe-native-6` 时，原生子进程因隔离 dotenv guard 引用了未导入的 `os` 而失败；完整错误留在 `.codex_tmp/stock-vibe-backtest-baseline-native6/baseline_manifest.json`。该错误经受控补丁修复后，新构建 `vibe-native-9` 的同一固定输入成功通过。失败尝试没有覆盖成功运行产物。
