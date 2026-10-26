# 股票 Vibe 免费行情源探针

## 目的与边界

本探针对单只 A 股 `600519.SH` 分别直接调用受控 Vibe 的 Tencent 和 Eastmoney loader，不经过 fallback chain，也不调用 Mona 旧股票金融代码。请求不需要 provider 凭据，锁定运行环境为 `vibe-venv-313`，源码为受控 `vibe-native-9/agent`。探针通过 `OwnedProcess` 启动每个独立子进程，设置专属 `VIBE_TRADING_HOME`，关闭 loader 缓存，不继承 `HOME`、`USERPROFILE` 或数据凭据；只传操作系统、证书和已有代理环境变量。

日线窗口固定为 2026-09-16 至 2026-10-15。Tencent loader 的 `fetch(codes, start_date, end_date, *, interval="1D", fields=None)` 只接受日线别名；Eastmoney loader 使用同一接口，并依据 `KLT_BY_INTERVAL` 支持 `1m`、`5m`、`15m`、`30m`、`1H`、日/周/月等区间。基于该显式映射，另对 Eastmoney 请求 2026-10-15 的 1 分钟数据。每个 source/interval 独立启动一次，不循环证券；探针不重复运行已知结果，重试和节流遵循各原生 loader 自身规则。

复现命令：

```powershell
.\.codex_tmp\vibe-venv-313\Scripts\python.exe -m tools.stock_vibe.data_probe `
  --source-root .codex_tmp\vibe-native-9\agent `
  --python .codex_tmp\vibe-venv-313\Scripts\python.exe `
  --output .codex_tmp\stock-vibe-data-probe
```

输出目录须为空，并位于 `.codex_tmp/`。每次记录独立的原生结果 JSON、loader 返回 DataFrame 的 CSV、stdout/stderr 与实际抓取时间。CSV 是 loader 标准化后的 OHLCV 返回帧，不是未经解析的 HTTP 响应体。

## 实测结果

| 来源与频率 | 结果 | 返回字段与区间 | 调整与限制 |
| --- | --- | --- | --- |
| Tencent 日线 | 成功，16 行 | `open/high/low/close/volume`；2026-09-16 至 2026-10-15；中位 bar 间隔 1 日 | 请求 `qfq`，loader 也尝试 raw companion 转换；返回帧 `attrs` 为空，调整属性未被显式报告。 |
| Eastmoney 日线 | 成功，16 行 | `open/high/low/close/volume`；2026-09-16 至 2026-10-15；中位 bar 间隔 1 日 | 请求 `fqt=1`，loader 也尝试 `fqt=0` raw companion 转换；返回帧 `attrs` 为空，调整属性未被显式报告。 |
| Eastmoney 1 分钟 | 请求完成但没有数据 | 请求 2026-10-15；无返回字段或 bar | 源码映射支持 `1m`；本次请求日志记录 `ProxyError` / `RemoteDisconnected`，不能据此宣称分钟数据可用或不可用。 |

两家日线 loader 的原生元数据都将 A 股成交量单位声明为“手”；本次探针没有独立校验行情源单位。日线两次请求耗时分别为 1.289 秒（Tencent）和 2.134 秒（Eastmoney）；Eastmoney 分钟请求耗时 0.818 秒后返回连接错误。抓取时间戳按 UTC 保存，耗时来自隔离运行器记录，不能代表源站实时延迟。两家日线返回帧的调整 `attrs` 均为空，因此只能确认 loader 发出了对应的前复权请求，不能确认实际输出采用了何种复权基准。

实测 CSV 与错误原文保存在忽略目录 `.codex_tmp/stock-vibe-data-probe/`：日线文件为 `tencent-daily/bars.csv` 和 `eastmoney-daily/bars.csv`；分钟错误在 `eastmoney-1m/stderr.txt`；`manifest.json` 汇总来源、接口、请求区间、时间、字段、行数、实际起止和每次结果。环境只提供过固定日期范围和单个证券，不含 API token 或账户信息。

该探针只证明一个标的在一个月窗口内的两路免费日线调用能够返回 16 行，并记录一次分钟连接失败。它不证明全市场覆盖、历史 PIT 完整性、分钟历史覆盖、专业数据授权、停复牌完整性、复权属性已校准或实时更新延迟满足产品要求。空结果和网络失败仍需如实展示，不能由另一 source 或旧算法补齐。
