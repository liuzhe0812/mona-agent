# Synthetic Shadow contract fixtures

These files are deterministic, synthetic fixtures created only to exercise the native Vibe-Trading Shadow pipeline. They are not broker exports, market observations, account history, investment returns, or evidence of strategy quality.

- `journal.csv` contains five profitable FIFO roundtrips for one synthetic A-share symbol, from 2025-06-09 through 2025-06-20.
- `bars.csv` contains weekday-only synthetic OHLCV bars for the same symbol from 2025-05-30 through 2025-07-01.
- The pipeline uses 2025-06-09 through 2025-06-20 as extraction examples, 2025-06-23 through 2025-07-01 as the native Shadow backtest window, and 2025-07-01 as the frozen scan date. This small fixture is a contract check, not a statistically valid holdout.
- The canonical `bars.csv` SHA-256 is `ce6ab2a6624efdc8f4e969cb5d585d9a860d84330e57ae19cd1cea152bcd313f`. The end-to-end run records a separate A-share T+1 rule gate from native `trades.csv`; with the pre-fix native engine, the 2025-07-01 signal is force-closed on the same day as its entry (`reason=end_of_backtest`), so the run must be reported as a failed rule gate.
- `bars-supplemental-end-window-experiment.csv` (SHA-256 `51e9a540f429ed868a9dcfa672e2b6ce57372bc66afa192a25e4109682739ca7`) is a preserved experiment that adds a 2025-07-02 bar and changes the 2025-07-01 bar. The baseline runner does not read it. It must not be used to move the backtest end date or to claim that the same-day close defect is fixed.
