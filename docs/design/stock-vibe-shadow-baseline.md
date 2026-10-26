# Vibe-Trading Shadow baseline

The fixed synthetic Shadow chain now completes through extraction, code/config generation, backtest, report, and scan on the controlled terminal-execution build. Its native A-share T+1 gate passes. This is a contract baseline only; it does not complete broader T01 acceptance or validate strategy quality or a real account comparison.

## Controlled input and source

The only baseline inputs are `tests/fixtures/stock_vibe/shadow/journal.csv` and `bars.csv`. The journal has five synthetic profitable roundtrips for `600519.SH` dated 2025-06-09 through 2025-06-20. The local bars cover 2025-05-30 through 2025-07-01. They are contract fixtures, not broker exports, observed market data, account history, or evidence of strategy quality. The canonical bars SHA-256 is `ce6ab2a6624efdc8f4e969cb5d585d9a860d84330e57ae19cd1cea152bcd313f`.

All runtime files are copied under a fresh `.codex_tmp/shadow-*/native` root. The child process sets `VIBE_TRADING_HOME` there, routes temporary/cache directories there, disables dotenv discovery, and leaves `HOME` and `USERPROFILE` unchanged. Backtest source is explicitly `local`; scan uses native `auto` resolution with `local` first and still records the actual source per symbol. The local bridge config contains only `600519.SH`. No network data or account credentials are used.

The controlled source snapshot is `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753`. The tested build is `.codex_tmp/vibe-native-terminal-v2/agent`; its receipt applies 0001 through 0005, including 0005 SHA-256 `3080e68c39af63cd11e59e5b62d9ae535bbd05a1f09b08d825d9733ce869bed0`. Patch 0003, `third_party/vibe-trading/patches/0003-shadow-data-source.json`, has SHA-256 `76ac1b533d0f237db45f10a63f38e9ef23ed383de6223801ea2999a98d2a0bbf` and is based on the locked snapshot hashes for `agent/src/tools/shadow_account_tool.py` (`b62b19ec5e840973dc6645661c27f0194cd4a5a11ed58f66fa9e6a5ff1036c58`) and `agent/src/shadow_account/scanner.py` (`74c12272779da0a538afc838890b74b99cd03121a56ae1e0bd72db4b525e008d`). It exposes native backtest `source` and `per_market_count` parameters and reports scan source, coverage, basket, missing symbols, and loader errors. The existing list-returning scanner API remains available to other callers.

## Native run evidence

The first full run used the same controlled snapshot and canonical fixtures before the terminal-execution fix. Its preserved output is `.codex_tmp/shadow-source-test-f79c4c00f2c84328b40819b877701240`. Native extraction produced Shadow `shadow_0f4aa259` from five roundtrips. The backtest used local bars for one symbol and wrote trades, equity, metrics, and OHLCV artifacts; the report tool produced a PDF. Scan resolved `600519.SH` to the local loader and returned one match with `partial` status because the other four symbols in the native five-symbol basket were unscanned.

That pre-fix run was not a valid passing result. Its `trades.csv` shows a 2025-07-01 buy and a 2025-07-01 sell with `reason=end_of_backtest` and `holding_days=0`, violating A-share T+1. The baseline runner now pairs native entry and exit rows and records this as the `china_a_t_plus_one` failed rule gate; a run with any same-day roundtrip exits nonzero and is reported as `failed_rule_gate`. The fixture remains unchanged so the defect cannot be hidden by moving the signal or backtest window.

The latest full run used `.codex_tmp/vibe-native-terminal-v2/agent`, with the exact same journal and bars hashes. Its output is `.codex_tmp/shadow-source-test-9758487926784fc38e57ded84846b658`, Shadow `shadow_a78eebea`. Extraction found five profitable synthetic roundtrips. The `RunShadowBacktestTool` schema exposes both `source` and `per_market_count`; its execution result and persisted config record `source=local` and one symbol, `600519.SH`. The report tool produced a PDF. Scan used local bars for that symbol, returned one match with `partial` status, and listed four unscanned basket symbols; the latest bar equals the frozen 2025-07-01 target date.

The native T+1 gate passed: `trades.csv` has no same-day exit, `fills.jsonl` contains one real `open` fill on 2025-07-01, and no forced close. The terminal position weight is `0.9996497091849645`. Final equity is `1,018,511.7753199`, matching the native final-value metric, so the open position is marked at the final bar rather than treated as cash or closed synthetically. `HOME` and `USERPROFILE` remained unchanged. The intermediate terminal build had a `plan_rejections` aggregation error; the v2 build corrected it and the same-fixture run above completed.

The independent no-data scanner contract test did pass against the terminal build. An empty local Data Bridge config returned `status=error`, `data_status=error`, no matches, and five `NoAvailableSourceError` entries. `HOME` and `USERPROFILE` remained unchanged. Output: `.codex_tmp/shadow-no-data-test-99ccb1f6364347cf8b2c9898af7f55dc`.

## Verification and limits

`ruff check tools/stock_vibe/shadow_baseline.py tests/services/stock_vibe/test_shadow_source.py` passes. The targeted pytest reports `2 passed` against the v2 build. The integration test checks one Shadow identity through extraction, backtest, report, and scan; the tool schemas and execution carry source/basket arguments; the frozen scan has no future bars; the final-day position fill and mark; and a T+1 gate that matches the native trade artifact. The negative scanner case verifies that no local data returns an error with no matches instead of a successful empty scan.

This fixture contains one synthetic symbol and a short training/backtest window. It does not test fair personal-versus-Shadow comparison, full account net asset value, fees/dividends/flows/initial holdings, or statistical holdout quality. Those remain unverified; a successful tool chain on these fixtures would establish contract behavior only.

## Hosted unavailable-result regression (0021)

The original hosted Shadow operation exposed a separate failure. Operation `759cb976049545a9b61ab926e130f634` omitted its window, market list, basket count, and journal path. The native backtest had no usable bars (`equity_points=0` and a missing-data error), but returned `status=ok`, zero real PnL and attribution, and produced a report containing zero metrics. The archived Mona operation record remains `completed`; it is retained as failure evidence and has not been rewritten.

The preserved evidence hashes are:

- Operation payload JSON: `5b0e7f3f76ba7c8c5fb50eaac7cf96615bf04915ab062cd7a362e0ee868d1d0e`.
- Raw tool result: `c64186ae2f418a63072461b20af8af0d0d63589eb0639ca1aeb3296cdc665f1a`.
- Native source receipt: `ff449ecbd1c878b79bb030fa95f67420035199ec813e8f72cd11ff310809c74e`.
- Cached Shadow result: `74a6221df3f706f4213ef100e205a0d360cbd35edee8cf6656222ac2c01e94eb`.
- Native report PDF and UI-downloaded PDF: both `4b03f93c71aaf48d4ea826f2e30a00d612c916c4b2054242a9ab712b40d83842`.

Patch `0021-hosted-shadow-unavailable.json` (SHA-256 `f047c2a586c22cb4d2bad4dff5b390667649ff52bb684c251f8b21f14bdb68ac`) changes hosted Shadow backtests with no usable metrics to `status=error`, preserves the source error and requested scope, and keeps real PnL, delta, and attribution null when journal evidence is unavailable. Reports label unavailable market metrics N/A and explain when account comparisons were not calculated. Explicit local-source failures now remain local and cannot fall back to Tushare.

The dedicated test `tests/services/stock_vibe/test_shadow_unavailable.py` passed against fresh prepared source `.codex_tmp/vibe-native-shadow-unavailable-0021-final/agent` (`1 passed`). It uses only the fixed synthetic Shadow fixtures and no model or account credentials. It checks the native tool response, the unchanged seven-bar fixture metrics, null journal-comparison fields, a missing-market N/A row, and extracted text from generated HTML/PDF. WeasyPrint could not load its native library in this environment, so PDF verification exercised the ReportLab fallback.

This test calls `RunShadowBacktestTool` directly; it does not create a Mona Operation record. Source inspection confirms `src/api/mona_operations.py::_run_operation` maps parsed `status=error` to Operation `status=failed` with `error_category=native_tool_error`, but the post-0021 persisted Operation transition has not been exercised here. The old record above is still `completed`, so do not interpret the native fixture pass as an Operation-level or UI acceptance result. Cache reuse across changed source, market scope, basket size, or journal input is also outside this test and is tracked separately.

## Hosted account-comparison policy (0023–0024)

The synthetic journal's five roundtrips run from 2025-06-09 through 2025-06-20 and sum to **71.00** in realized trade PnL. That is a transaction sample for that earlier period; it is not full account return, account net value, or opening holdings. The Shadow validation window is 2025-06-23 through 2025-07-01. A previously captured seven-bar run compared Shadow PnL `18,511.78` with the earlier journal sum `71.00`, yielding a delta of `18,440.78`. That delta compared different windows and omitted full opening positions, principal, and same-window net-value evidence; it is retained as a failed comparison and must not be described as personal performance. The earlier no-data operation failure above is a separate preserved error.

Patch `0023-hosted-shadow-account-comparison.json` (SHA-256 `201d169cde5779f9b7aa45d179c5fc80f1d162d89eb268dd0bf65566e34789b5`) now keeps hosted Shadow metrics and sets real account PnL, delta, and economic attribution to null even when a journal is supplied. Its report explains that complete opening positions, principal, and net-value evidence for the same backtest window are missing, and that the journal is transaction evidence only. The report omits attribution tables, waterfall charts, and counterfactual claims. Standalone Vibe retains its previous comparison behavior.

Hosted cache reads also suppress comparison fields from older records. When a matching version-22 cache is available, the reader keeps its Shadow metrics, projects real PnL, delta, and attribution to null, and leaves the original cache bytes unchanged. The added `comparison_policy` cache identity prevents a new hosted result from reusing an old comparison cache.

Patch `0024-hosted-trade-journal-operation.json` (SHA-256 `c57a3267d0a008f192df531fecbfa766fcd6252fd13afae14845c17cee478df6`) exposes the existing full journal analyzer through a private-upload operation. Its sample transaction PnL remains tied to the journal's date range and is not promoted to a Shadow-window account return.

The baseline consumer now passes the same window, source, market scope, basket size, and journal to the hosted Report tool that it passed to Backtest. The fresh-source verification used `.codex_tmp/vibe-native-trade-journal-0024-final/agent` and the isolated Python 3.13.15 environment from verify 6. `PYTHONDONTWRITEBYTECODE=1` was set for the outer and native child processes.

```powershell
$source = (Resolve-Path ".codex_tmp/vibe-native-trade-journal-0024-final/agent").Path
$python = (Resolve-Path ".codex_tmp/stock-vibe-runtime-verify-6/python/stock-vibe-envs/1bd31bf7f6c02b6fc8f824b1ca90e82e/Scripts/python.exe").Path
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:STOCK_VIBE_SHADOW_SOURCE_ROOT = $source
$env:STOCK_VIBE_SHADOW_PYTHON = $python
$env:STOCK_VIBE_SHADOW_UNAVAILABLE_SOURCE_ROOT = $source
$env:STOCK_VIBE_SHADOW_UNAVAILABLE_PYTHON = $python
$env:STOCK_VIBE_SHADOW_CACHE_SOURCE_ROOT = $source
$env:STOCK_VIBE_SHADOW_CACHE_PYTHON = $python
pytest -q tests/services/stock_vibe/test_shadow_source.py tests/services/stock_vibe/test_shadow_unavailable.py tests/services/stock_vibe/test_shadow_cache_inputs.py
```

Result: `4 passed in 106.40s`. Ruff passed for the baseline script and all three tests. The tests check the independent Shadow result, the same-window non-comparability explanation, suppression of the prior 71.00/delta from a seeded version-22 cache, and preservation of the old cache bytes. This is source-consumer verification using the verify-6 environment; it does not establish preflight-8 or product UI acceptance.

## UI9 Shadow report check (2026-10-17)

This is a limited synthetic UI/report check from `.codex_tmp/stock-vibe-ui-preview-4/`, not a T07 real-account review or a formal switch gate. The source receipts in `ui-native-evidence.json` identify the fixed source snapshot and patches 0001–0025. The evidence JSON SHA-256 is `0425d620f1cda550993545f9aee14e8f440e289fc7fc9aade52f7e8f387c29da`.

The UI used the already existing synthetic profile `shadow_2bb71d74`, not the original manual baseline profile `shadow_a78eebea`; these runs use different profile/input identities and must not be described as a regression against that earlier baseline. The journal/profile window is 2025-06-09 through 2025-06-20. The requested Shadow window is 2025-06-23 through 2025-07-01, with `source=local`, `markets=["china_a"]`, and `per_market_count=1`. Only seven bars fall in this requested backtest window. RSI14 was unavailable and the configured negative prior-return condition was not met, so the native result produced no trades: final value `1,000,000`, total return `0%`, and `trade_count=0`. This describes the actual input/rule outcome; it does not establish strategy effectiveness or indicate a regression from the separate manual profile.

The native report records the profile/journal window separately from the Shadow window and includes the actual source, market, basket size, report time, and scan state. `include_today_signals=false`; the report states “Not requested” and does not run a scan. A separate `scan_shadow_signals` operation returned `partial` using the local source, with one symbol available, four missing, and no matches. The ordinary journal sample’s transaction PnL of `71.00` belongs to its own 2025-06-09–2025-06-20 period; it was not compared with the Shadow result. Account return, delta, and economic attribution remain null because complete same-window opening positions, principal, and net-value evidence are absent.

The UI-native evidence records a byte-identical native and downloaded PDF (`d214cb011d2141559df02c649281dc37`, 71,199 bytes, SHA-256 `f4048063a20f918d70b4989d80aa9360aab58ff3e5497e92e6e98984a4d734a2`); all three pages were visually reviewed and report metadata passed. Extracted text is in `pdf-review/extracted.txt` (SHA-256 `4ade3ea43ad4f5f6887bbaa2eefb04fb0437476be6be5b80dea6296c978c77a9`). Two prior report hashes and the prior scenario index are recorded unchanged in the evidence file. The metadata test had 1 pass, the host contracts tests had 2 passes, and the UI 40-test and StockEntry 6-test runs passed separately. These checks establish report metadata/rendering and this synthetic UI path only; they do not establish a real account comparison, a complete Shadow acceptance, or any of the four formal cutover gates.
