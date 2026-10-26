# Stock Vibe 原生 Swarm A 股证据验收

## 验收结果

`mona_ashare_research` 已按 600519.SH、2026-09-16 至 2026-10-15 实际运行原生两节点 Swarm。最终有效运行的原生任务、数据抓取、证据写入和跨任务文件读取均成功；复核节点读取了原始 evidence.md，所引用的数值都能在原始日线记录中核对。运行时原始 manifest 因探针把 Windows 文件的 CRLF 与 ReadFileTool 返回的 LF 差异误判为内容不一致而记为 failed；系统自动注入的 Ground Truth 数值也被当成了不允许的模型输出。保留所有原始记录后，离线审计确认跨任务读取和数字核验通过；最初 manifest 和失败记录未覆盖。

通用历史 as-of 语义曾有单独缺口：原生 Ground Truth 预取使用运行当天而忽略 user_vars.end_date。补丁 0012 只为 hosted `mona_ashare_research` 加入明确日期窗口、未来日期拒绝和实际来源收据。修复后通过确定性 native fixture 以及一次真实、无 LLM 的历史 Tencent 查询；没有重新运行模型 Swarm。

最终 preset 保持两个顺序节点：`tencent_research` 仅允许 `get_market_data` 和 `write_file`，`evidence_reviewer` 仅允许 `read_file`。preset 使用原生模板变量 `symbol`、`start_date`、`end_date`，不设置模型覆盖；它以一次 Tencent 请求生成完整 evidence.md，并将原生 worker 要求的 report.md 单独写入同一任务工作区。report.md 的首行必须包含 evidence.md 的 write_file 绝对路径，原生 runtime 会用 report.md 作为依赖节点收到的 summary。复核节点必须按该路径读取证据，不得猜路径或另行取数。

最终提交补丁的 SHA-256：

- `0007-ashare-preset.json`: `fcf13d9a45ed121b38300e23b20b514e4450003a83e5fa3c108a2d5dd560d9a2`
- `0012-host-swarm-asof.json`: `5f060f8aff1551c9e29d842f81e558e3ecf789c1b46aa085d271855c8bf9beba`

首次固定样本 run 使用的 0007 SHA-256 是 `2c1ef298e1f19116a0fc61ca725cf22ef9dab900a48108325b8e3711c17dc84a`，原文件副本保存在 `.codex_tmp/stock-vibe-swarm-probe/0007-ashare-preset-first-run.json`。final4 的 prepared receipt 使用 0007 SHA-256 `650c8a88468ba6c71c9c0bf1288691286da988535058d0ef5c5c3490546dbab7` 与 0008 SHA-256 `39d910589993b702b1da33c6b12b77e7606598165fb297f48d9c78e22b28a9ba`。当前 0007 在该 run 后仅补充了“Ground Truth 来自自动 prefetch、不得替代 evidence、end_date 外数据不使用”的说明；没有用这版 prompt 再调用模型。

最终 source receipt 仅含 reviewed 的 0001–0012，未包含未就绪补丁：`.codex_tmp/t05-swarm-source-with-12-v2/agent/mona-source.json`。T05 的 LLM 运行使用准备好的 0001–0008 快照；0012 是随后对通用历史 as-of 缺口的独立 native 修复，不应描述为经过新的 LLM Swarm 回归。

## 真实运行记录

每次 `POST /swarm/runs` 均只发一次，使用新的 `X-Mona-Request-ID`。失败运行和原始 Swarm 快照都保留在 `.codex_tmp/stock-vibe-swarm-probe/`。

| Run | 原生结果 | 验收发现 |
| --- | --- | --- |
| `swarm-20261016-131248-1e568a78` | 两个任务均 completed | 固定样本首次运行取得 Tencent 数据，但写入路径重复嵌套，reviewer 对三个猜测路径的读取均 not_found。Evidence 文件本身保留，SHA-256 为 `f1d849bec0099ac6fb1855e81e4071d80b3c0c9ce9a3c397eda3e23659c9b925`。不算通过。 |
| `swarm-20261016-132857-7b10cf16` | failed，bridge 调用 0 | 当时的 0008 在 build registry 时因 `src/tools/__init__.py` 缺少 `os` 导入而抛出 NameError。已保留失败日志，未重试原 ID。 |
| `swarm-20261016-133543-834fb601` | 两个任务 completed | Source summary 丢掉 `EVIDENCE_PATH`，reviewer 没有父节点上下文。根因为 native worker 只替换 system_prompt 中的 `{upstream_context}` 占位符；preset 后续已加入该占位符。 |
| `swarm-20261016-134849-8fd65145` | 两个任务 completed | report.md 被原生 `_resolve_summary()` 选作 source task summary，但缺绝对 evidence 路径；reviewer 因而没有读到文件。preset 已要求 report.md 首行写入成功回执的精确路径。 |
| `swarm-20261016-135341-5dc3f3ef` | 两个任务 completed | Source summary 含精确绝对路径；ReadFileTool 仅允许当前任务目录和既有 hosted 读根，拒绝了私有 Swarm runs 根中的父文件，状态为 outside_readable_roots。Hosted 只读根由 0011 加入；本次没有使用新的 LLM 运行验证 0011。 |
| `swarm-20261016-140043-0bd02bad` | 原生 run 和两个任务 completed | Source summary 首行包含真实路径；reviewer 一次绝对路径读取成功。原始 manifest 因旧版探针比较 CRLF/LF 仍记为 failed。规范化后的离线复核见 `.codex_tmp/stock-vibe-swarm-probe/native-generic-final-4-2026-10-16/post-run-audit-3/manifest.json`，其数据、grounding 和报告检查均通过。 |

最终运行的 POST request ID 是 `0500882f417742e2a5ce00b0a3947783`，创建的 native run id 是 `swarm-20261016-140043-0bd02bad`，SSE 终态和 run.status 都是 completed，source/reviewer task 均 completed。六次 `qwen3.7-plus` 调用全部 HTTP 200，每次有效上限 4096 tokens；运行使用 `aliyun-bailian-coding`。OwnedProcess 收到 graceful shutdown 并以 returncode 0 退出。

## 原始数据与 ReadFileTool 证据

最终运行的 source task 对 `600519.SH` 调用一次 `get_market_data`，参数为 `source=tencent`、`interval=1D`、`max_rows=0`。工具返回 `_provenance`：`source=tencent`、`requested_source=tencent`、`detected_source=tencent`、`fallback_used=false`、`adjustment=split_dividend_additive`、`volume_unit=lots`；实际覆盖 2026-09-16 至 2026-10-15，共 16 行。`_provenance` 没有 `provider` 或 `interval` 字段；证据把 provider 如实标成未提供，并把 1D 标成请求参数。

Evidence artifact 位于 `artifacts/tencent_research/task_tencent_data/evidence.md`，3327 原始字节，SHA-256 `11d859b42b67017266d80d1dc13152a719062425f6646b05f58c752f1d8ce7d5`。Windows 将文件保存为 CRLF；ReadFileTool 的 `Path.read_text()` 将 CRLF 规范化为 LF，因此返回文本为 3260 UTF-8 字节。两边转为 LF 后内容完全一致，SHA-256 均为 `e347aa8f5bf1997873ba75086aad4c75951582fda3dea4fed57b20f58f92eb75`。

复核节点只调用一次 `read_file`，路径与 evidence.md 的 write_file 回执完全相同，返回 status=ok。它核对了 2026-09-16 和 2026-10-15 两条完整 OHLCV 日期行；review summary 中所有数字均可在 evidence.md 中找到，未发现未验证的数字。reviewer summary 在按行分类时没有再抄写 `1D`，但请求和已读文件都明确包含该字段。

Review system message 中另有 native runtime 自动注入的 `Ground Truth — Recent Market Data` 表。该表包含 2026-10-09、10-12、10-13、10-14、10-15 五条收盘价和成交量，五条数值都逐项匹配同一次 runtime `grounding_data` 快照和显式 Tencent 工具行。因此 reviewer 的 Ground Truth 引用是真实输入，不是模型凭空生成。Ground Truth 不记录所选 loader provenance；代码中的默认 A-share chain 首项为 Tencent，Tencent loader 的 `is_available()` 总是 true，但快照本身只保存 bars；本次自动预取 bars 与显式 Tencent 结果完全一致。

旧探针曾因 CRLF/LF 判定文件不相等，也因不允许报告出现任何数值而误报上述真实 grounding 数据。`swarm_probe.py` 现在将 ReadFileTool 文本和原文件统一规范为 LF，分别保留原始文件 hash 与规范化文本 hash；它也检查 Ground Truth 是否出现、条目是否与 run snapshot 及显式 Tencent 行一致、所有数据是否没有超过请求 end_date，以及 summary 数值是否存在于 source evidence。

## 历史 as-of 缺口与 0012 修复

原生 `grounding.py` 的旧 `fetch_grounding_data()` 使用 `date.today()` 向前取 30 天。`SwarmRuntime._prefetch_grounding_data()` 只把 symbols 传给它，不读取 preset 的 `start_date` / `end_date`。这会让更早的历史研究在 system prompt 中收到 end_date 之后的行情。最终 LLM 样本截止 10 月 15 日、运行日为 10 月 16 日，当时自动预取没有 10 月 16 日收盘 bar，故样本没有实际泄漏；这不能证明任意历史窗口安全。

根因源码位置（1–11 快照）：`src/swarm/grounding.py:160–205` 计算 today−30 日并直接 `resolve_loader(market)`；`src/swarm/runtime.py:813–863` 预取时只传 symbols；`src/swarm/grounding.py:231–283` 把 bars 渲染成 Ground Truth；`src/swarm/worker.py:312–318` 将它附加到 worker system prompt。默认 A-share chain 在 `backtest/loaders/registry.py:180–182` 以 Tencent 开头，`tencent_loader.py:73` 将其声明为 always available。旧 `run.json.grounding_data` 没有实际所选 source 字段。

0012 只在 `VIBE_TRADING_HOSTED=1` 且 preset 为 `mona_ashare_research` 时启用 as-of grounding。`start_run` 在保存 run 之前校验 canonical 日期、起始不晚于截止、end_date 不晚于今天；预取使用请求的明确起止时间。它通过 `src.market_data.fetch_market_data_json(..., source="auto", interval="1D", max_rows=0, include_provenance=True)` 取得数据，拒绝返回窗口外的任一 bar，并在 `SwarmRun.grounding_metadata` 持久化实际 `_provenance`、请求 interval/window 和实际 coverage；没有 provider 字段时不补值。GET `/swarm/runs/{run_id}` 返回该 metadata。独立 Vibe 及其他 Swarm preset 继续使用原有 recent-grounding 行为。

0012 实现位置：校验和真实来源预取在 `src/swarm/grounding.py:160–329`，hosted/preset 边界在 `src/swarm/runtime.py:57–61, 335–342, 827–912`，可选 run metadata 在 `src/swarm/models.py:314`，GET 回显在 `src/api/swarm_routes.py:154`。

确定性 fixture 验证了旧日期窗口、未来 end_date 拒绝、越界 bar 拒绝、实际来源保留、provider 不推断，以及 SwarmStore/GET metadata 往返。`tests/services/stock_vibe/test_swarm_asof.py` 使用外层 pytest 启动显式 Python 3.13 子进程，测试过程没有 LLM 或网络。

随后进行了一次真实、免费、无 LLM 的历史窗口查询。请求为 600519.SH、2026-09-16 至 2026-10-15、source=auto、interval=1D、include_provenance=true；真实 `_provenance` 证实实际 source=tencent、fallback=false，覆盖区间 16 行且无超过 end_date 的记录。高层响应 3034 字节，SHA-256 `f089a7ddcb3cca8691b6682774f5158d466d278ba42d34871d52e668f271d235`。完整本地证据保存在 `.codex_tmp/t05-asof-probe/real-tencent-historical-window.json`，3805 字节，SHA-256 `d272a5bb6c6db052c2a24e05d8097db450f0b5367848555dbf93fb11ab61ec68`。运行使用 isolated VIBE_TRADING_HOME、禁用 dotenv、仅 allowlisted OS 环境；没有启动 API server、Swarm worker 或模型。

该历史查询只证明 0012 helper 在该窗口收到真实 Tencent 来源数据并写入有效元数据；它不是新的 LLM Swarm run。最终 0012 source receipt SHA-256 为 `ff96b3a8b88788e8fdf19f3212cd97136c7ce40fdbadd215da228f68a635e448`。

## Native artifact 边界

原生 `SwarmTask.artifacts` 是 run-relative 路径字符串列表，例如 `artifacts/tencent_research/task_tencent_data/evidence.md`；没有每项 SHA-256、大小或 artifact id。任务本身另有 task id。最终运行的 GET Swarm detail 使用 task serializer，当时 serializer 没有暴露 artifacts。受控下载句柄由后续独立补丁处理，本次 T05/0012 没新增下载路由。
