# Stock Vibe 原生研究探针

本探针验证 Mona 能否把当前默认模型通过纯 HTTP 模型桥接交给受控的 Vibe 原生研究循环，并在隔离环境中完成一次有数据证据的研究。宿主只调用 `load_config()`，在内存中建立具名 `ModelPresetConfig` 并创建 `StockModelBridge`；不保存用户配置、不把百炼凭据传给原生进程，也不创建 Mona `AgentLoop`。原生子进程只收到临时桥接/API 凭据、白名单系统与代理环境和私有 `VIBE_TRADING_HOME`。已有 `HOME`、`USERPROFILE` 保持原值；调度器和频道自动启动关闭。

## 固定输入与请求

行情输入来自前一项免费源探针：Tencent Finance 对 `600519.SH` 的 `1D` 日线，区间 `2026-09-16` 至 `2026-10-15`，共 16 行，字段为 `trade_date/open/high/low/close/volume`，不需要数据凭据。上传原始字节 SHA-256 为 `84e67d7a4cfc2952e7f7aaf182a4870f19e8ca64acef1d8e1772ba4a09deb746`。原生 `read_file` 使用文本模式，会将 CRLF 规范化为 LF；因此比对附件内容时使用归一化文本哈希 `94d187cd88439074bfa74f16e6f4a7b490d2359953980106e6b85b8a0429fa61`。

经确认的 Mona 默认模型为 `qwen3.7-plus`，provider 为 `aliyun-bailian-coding`，registry backend 为 `openai_compat`。探针将同一默认项拷贝为内存中的 `stock_vibe_research_probe`，输出上限取当前设置与 4096 的较小值。每次原生服务启动都核验 source receipt、instance ID、runtime root 哈希和真实服务 PID 的 OwnedProcess Job 归属。

原生行情工具 schema 为 `get_market_data(codes, start_date, end_date, source, interval, max_rows)`。追问使用 `codes=["600519.SH"]`、`start_date="2026-09-16"`、`end_date="2026-10-15"`、`source="tencent"`、`interval="1D"`、`max_rows=0`；只有返回 `_provenance` 显示实际 `source="tencent"` 时才接受。随后用 `read_file(path="../uploads/<uuid>.csv")` 校验原上传附件。探针为 HTTP 操作预先分配 `X-Mona-Request-ID`，每条消息请求只提交一次；请求日志不保存认证头或密钥。

## 实测结果

首个原生研究消息只依照 CSV 做分析，初次 `read_file(path="uploads/<uuid>.csv")` 在 run-dir 优先解析下返回 `not_found`；随后 `read_file(path="../uploads/<uuid>.csv")` 成功读取相同附件。原生 grounding ledger 没有将 `read_file` 输出登记为行情证据：价格证据数为 0，4 轮校验分别拒绝 29、20、20、20 个 `numeric_claim_unavailable` 声明。读出的 OHLCV 数字与附件一致，拒绝原因是证据类别未被 grounding 接受，不是数值错误。该 attempt `c64b80a83b74` 虽持久状态为 `completed`，最终内容是安全门拒绝文案，故输出保持 `failed_acceptance`。完整原结果和失败报告保存在 `.codex_tmp/stock-vibe-research-probe/native-retry-1/`，没有覆盖或重放。

随后按明确授权在同一 session 发起一条新的追问，保留旧 attempt，复用其私有 runtime 与已上传 CSV，不重新建 session 或上传。宿主只发出一次新消息 POST，request ID 为 `232448b39bb5453fa3fd013bfdb2b9d8`，新 attempt 为 `b218d0d003bb`。模型在 grounding 修正期间请求了两次相同的 Tencent 行情工具调用；两次都返回 16 行，实际 `_provenance.source="tencent"`、`fallback_used=false`、`adjustment="split_dividend_additive"`、`volume_unit="lots"`。逐日 open/high/low/close/volume 与附件 16 行完全一致。接着成功读取附件，归一化文本哈希一致。

最终研究报告已持久化，SHA-256 为 `f53869c4ecb9d8d7800a8090e4792241b7b60794cc774b4dbc02fcbf6d7927ea`。最终 grounding evidence 有 160 条价格证据，0 条工具失败，最后一次答案验证有效且没有问题；SSE 有 `attempt.completed`，持久 assistant 状态为 `completed`。证据还确认原生 server PID 属于本次 OwnedProcess Job，session、source receipt 和 runtime root 握手均通过。机器可读记录和原始 tool result 文件在 `.codex_tmp/stock-vibe-research-probe/native-followup-1/`。

复现 follow-up 时必须使用全新的输出目录并显式指定已完成结果：

```powershell
python -m tools.stock_vibe.research_probe `
  --source-root .codex_tmp\vibe-native-9\agent `
  --python .codex_tmp\vibe-venv-313\Scripts\python.exe `
  --input .codex_tmp\stock-vibe-data-probe\tencent-daily\bars.csv `
  --output .codex_tmp\stock-vibe-research-probe\native-followup-1 `
  --continue-from .codex_tmp\stock-vibe-research-probe\native-retry-1\manifest.json
```

`--continue-from` 只接受已完成且由本探针记录为 `failed_acceptance` 的旧 manifest。发送前会核对旧 session 的 `last_attempt_id`、持久 assistant 状态、原始上传哈希以及 OwnedProcess 已关闭；状态不符合就中止。旧 `attempt.json`、旧报告与旧输出目录保留原样，新结果写入单独目录。

## 边界

这次验收证明的是：一次真实免费 Tencent 数据请求、实际来源 provenance、附件逐字段一致性、native grounding 证据登记和最终持久答案链路。它不证明全市场覆盖、PIT 完整性、专业授权、分钟历史可用性、实时延迟或未来价格表现。Tencent 的复权口径按原生 provenance 记录为 `split_dividend_additive`；这不等同于对任意历史区间都完成复权校准。结果也不涉及账户、持仓、交易执行或个性化建议。
