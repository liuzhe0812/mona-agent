# Stock Vibe Services runtime lifecycle

The Windows Services supervisor was exercised against an installed offline native package. The test starts the real native HTTP service and verifies its process ownership, file lock, authenticated endpoints, persistent session store, idle shutdown, and restart behavior. It uses no model preset or credentials, so the server stays data-only and makes no model request.

## Isolated package verification

Package `.codex_tmp/stock-vibe-runtime-current-3.zip` is version `0.1.16+stock.preflight.3`, 195,698,396 bytes, SHA-256 `56c70059e1ae8703b2c15e56234a803f298891199433dd00c0176153ed40c001`. Its source receipt contains the locked snapshot `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` and patches 0001–0006, including 0006 SHA-256 `6a0c070c965ffed7aa3ee1955a7c4528cf5a23ef27814ce7d10b11257fe86dae`.

The package was verified offline into `.codex_tmp/stock-vibe-runtime-verify-current` with:

```powershell
py -3.11 -m tools.stock_vibe.verify_install `
  --package .codex_tmp/stock-vibe-runtime-current-3.zip `
  --test-root .codex_tmp/stock-vibe-runtime-verify-current
```

`verification.json` reports `verified`: Python 3.13.15, `pip check` and all nine core imports passed. The installed component occupies 216,544,557 bytes; the isolated Python environment occupies 785,228,089 bytes. `HOME` and `USERPROFILE` were unchanged, the copied global Python base tree hash matched its source, and all global runtime pointers remained unchanged.

## Lifecycle evidence

The live test uses only the verified runtime root and places native data under `.codex_tmp/stock-vibe-runtime-pytest-final/test_services_runtime_lifecycl0/native`. With no model preset, `/mona/identity` succeeds and `/ready` returns 503. Two overlapping leases share the same client and instance. A contender using the same data root is refused by the real engine file lock without acquiring a process or ownership lock. Changing a synthetic model preset while a lease is held returns busy and leaves the existing instance running.

The test creates one session with a synthetic title, releases all leases, and confirms `/mona/activity` is inactive with no session, swarm, benchmark, comparison, or scheduler activity. The Windows Job Object PID set matches the verified launch tree: a Vibe virtual-environment `python.exe` launcher, its Python-base `python.exe` server child authenticated by `/mona/identity`, and the system `System32/conhost.exe` child. The process tree snapshot uses Toolhelp parent PIDs, `QueryFullProcessImageNameW`, and Job Object PID enumeration. It accepts only the server-to-launcher ancestor chain and a real system `conhost.exe` whose parent is in that chain. Any other Job member prevents idle status.

For the idle test, the test moves `last_used` into the past and waits at most six seconds for the real idle loop to POST `/mona/shutdown`. Uvicorn logs `Application shutdown complete`; the owned process exits and its Job Object reports zero active processes. Restarting on the same data root creates a different engine instance, and `GET /sessions/f2a02fb40aa7` still returns the original session. A later explicit `close()` produces a second graceful shutdown. The full engine log and native session files remain under the `.codex_tmp` evidence root.

A separate same-length corruption case changes a program file in a small private inventory and confirms the bundle verifier rejects its SHA-256. It does not touch the installed package. An isolated native-registry probe with a restricted environment and no credentials found 112 tools, 90 skills, and 30 bundled Swarm presets, with no tool import or registration failures. Required backtest, Shadow, swarm, skill, and goal tools were present. Its report is `.codex_tmp/stock-vibe-runtime-verify-current/native-registry-inventory-restricted.json`.

## Validation and limits

`ruff check mona/runtime/process_tree.py mona/services/stock_vibe/runtime.py tests/services/stock_vibe/test_runtime.py` passes. The targeted lifecycle suite reports `3 passed` in 17.50 seconds. The process inventory is retained at `.codex_tmp/stock-vibe-runtime-verify-current/job-tree-inventory.json`; verification and test artifacts stay under `.codex_tmp`.

This acceptance was run on Windows only; it makes no macOS claim. The idle deadline is simulated by changing `last_used`, while the loop, service processes, shutdown request, Uvicorn lifespan, session persistence, and Job Object cleanup are real. Model binding, real provider calls, broker accounts, and external network access are intentionally not tested. On platforms where process membership is unknown, the supervisor remains conservative and does not auto-idle-stop.
