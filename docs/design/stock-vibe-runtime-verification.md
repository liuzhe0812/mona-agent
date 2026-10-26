# Stock Vibe runtime offline verification

This records a real offline install of the current preflight package in a disposable runtime store under this worktree's `.codex_tmp`. It exercises the shared runtime component installer and Python environment builder; it does not install into or activate anything in the user's managed runtimes.

## Input and procedure

The package was built from the pinned `third_party` snapshot with patches `0001-host-isolation.json` and `0002-cli-host-alias.json`. Patch `0003-shadow-data-source.json` was not in the package, so this is a preflight result, not final T02 source acceptance.

| Input | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime.zip`, 195,691,781 bytes |
| Package SHA-256 | `59b30c82567b0c98115da8fd3ad219ff484cbf7d0c453291d9c464ae76dc614e` |
| Source snapshot ID | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Upstream requirements lock SHA-256 | `e3198d6e1d4dc9899f4416e2d4becf5c44fe7e9fd7e80fafe8ea8e5c37fddbb6` |
| Offline wheel lock SHA-256 | `4baf3bbf4aa704a7a937c5a52e1c95358bd98db3a255306c298b324785eb1083` |
| Test root | `.codex_tmp/stock-vibe-runtime-verify-preflight` |
| Reused base | Installed `python-base@3.13.15`, copied read-only into the test store |

The command was:

```powershell
python tools/stock_vibe/verify_install.py --package .codex_tmp/stock-vibe-runtime.zip --test-root .codex_tmp/stock-vibe-runtime-verify-preflight
```

The verifier copies the installed base component, its receipt, and current pointer into a fresh local test store, then calls `RuntimeComponentStore.install_archive` and `PythonEnvironmentBuilder(environment="stock-vibe")` with the base and stock-vibe refs. The environment builder ran its three installation steps successfully with `--no-index --require-hashes`; pip cache and temporary paths were directed into the test root. `HOME` and `USERPROFILE` were unchanged. The installed base is reused evidence, not a first-time base download or installation.

## Result

The report at `.codex_tmp/stock-vibe-runtime-verify-preflight/verification.json` has `status: verified`.

| Check or artifact | Result |
| --- | --- |
| Runtime component install and manifest validation | Passed; `stock-vibe-runtime`, version `0.1.16+stock.preflight.1` |
| Python environment generation | Passed; base `python-base@3.13.15` plus stock-vibe preflight component |
| Builder install steps | 3 of 3 returned 0 |
| `pip check` | Passed: `No broken requirements found.` |
| Python / pip | Python 3.13.15; pip 26.2.1 |
| Core imports | Passed: `fastapi`, `pydantic_settings`, `numpy`, `pandas`, `api_server`, `src.agent.loop`, `src.swarm.runtime`, `backtest.runner`, `src.shadow_account.extractor` |
| Global base and official environment pointers | Before/after SHA-256 values matched |
| Global stock-vibe pointer | Absent before and after |
| Test-root stock-vibe environment pointer | Created only inside the disposable test root |

Actual byte counts from the verification report:

| Item | Bytes |
| --- | ---: |
| Program files in package receipt | 32,957,037 |
| Wheel files in package receipt (187 wheels) | 183,145,414 |
| ZIP expanded contents | 216,519,210 |
| Installed component, including manager receipt | 216,519,431 |
| Built Python environment directory | 784,605,080 |
| Pip cache after install | 0 |
| Temporary files after install | 0 |

The copied base contained 2,970 files / 58,732,447 bytes and its tree SHA-256 matched the installed source component: `8d04793211be59e9e61a65c3b1c32d84bc713541208a208617f224185e999170`. Its `current.json` and receipt both had SHA-256 `2ab7bd3097ac21f87033e294a020bf768a606c5586e4cd99673c2e64f1e83a5a`. The global official environment pointer SHA-256 remained `8d1d7b097ee398357421b42ce9b0c02e5043792e61a49c266591332663fddc21`.

## Updated preflight 3

The later `.codex_tmp/stock-vibe-runtime-current-3.zip` includes patches 0001–0006 and a controlled rebuild of jsonpath. Version `0.1.16+stock.preflight.3` is 195,698,396 bytes, SHA-256 `56c70059e1ae8703b2c15e56234a803f298891199433dd00c0176153ed40c001`. Its source receipt SHA-256 is `4939dc6a6233f527fc2e4e26e61f3aa4e018ff6d4bea25660e329d95857a449a`. It was installed separately into `.codex_tmp/stock-vibe-runtime-verify-current`; the earlier evidence was not overwritten.

| Measured item | Bytes |
| --- | ---: |
| Program payload | 32,981,206 |
| 187 wheel files | 183,145,415 |
| ZIP expanded contents | 216,544,336 |
| Installed component including manager receipt | 216,544,557 |
| Isolated Python environment | 785,228,089 |
| Reused base | 58,732,447 |
| Retained package + component + environment + base | 1,256,203,489 |
| Pip cache and remaining temporary files | 0 |

The retained total adds measured files; it is not a measured preparation peak. It exceeds the original approximate 1 GB estimate; old versions and extraction staging require further space. No promised native tools were removed to reach the estimate. Public first-time base download, installer size delta and peak preparation space remain unmeasured.

The build used CPython3.13.15, pip26.2.1 and the hash-locked tools in `third_party/vibe-trading/build-requirements.lock`. jsonpath's source hash was checked against the upstream lock, then built with `--no-cache-dir --no-build-isolation --no-binary=jsonpath` and `SOURCE_DATE_EPOCH=1767225600`. Source/build hashes are in `build-receipt.json`. The exact Windows wheel lock is versioned as `requirements-windows-cp313.lock`, SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648`.

Offline builder steps, pip check, nine core imports, unchanged HOME/USERPROFILE, global pointers and base hashes passed. Real service ownership, graceful shutdown, idle exit and restart passed in [lifecycle evidence](stock-vibe-runtime-lifecycle.md). The restricted registry found112 tools with zero import/registration failures,90 skills and30 presets. Later patches and other platforms require their own verification. No public catalog URL has been published.

## Limits of the earlier preflight 1

This verifies that this preflight archive can be installed offline against the reused Python base, its locked wheels satisfy `pip check`, and selected native-package modules import. It does not establish upstream source authenticity or the trustworthiness of the upstream build toolchain. It does not test startup, HTTP/SSE behavior, a real account, model execution, or a package containing patch 0003. Those remain separate checks before final T02 acceptance.

## Updated preflight 5 (2026-10-17)

Preflight 5 was installed offline into a fresh disposable store. This section records the separate package receipt and the actual installation report; it does not replace the older preflight 1 or 3 evidence above.

| Input or receipt | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime-preflight-5.zip`, 195,749,595 bytes |
| Package SHA-256 | `1a09384180c38d3944301130d4dbdfec54fe8335777f57431aec559e8552a90a` |
| Package sidecar receipt | `.codex_tmp/stock-vibe-runtime-preflight-5.zip.receipt.json`, SHA-256 `b6465814ff1e41f062abb3e0c8a1f94d839506b4865081732da65367b5160c27` |
| Installed source receipt | `.codex_tmp/stock-vibe-runtime-verify-5/components/stock-vibe/versions/0.1.16+stock.preflight.5/source-receipt.json`, SHA-256 `1ebf906acd2cf3d32ce5c051206e2d80a1a99c3a90ef8d2ec42a80e3966b3d00` |
| Snapshot | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Frozen patch set | `0001–0020`, including `0018` SHA-256 `a935284f6c83eb0182143a702111862a13a19dba55382fd68b2d180d731dd2a0` and `0020` SHA-256 `2b9a73dbeabd38aa779a0bf014ce9511cac6a6dbf8f23978a1370dc55f389dd1` |
| Upstream requirements lock | SHA-256 `e3198d6e1d4dc9899f4416e2d4becf5c44fe7e9fd7e80fafe8ea8e5c37fddbb6` |
| Windows wheel lock | SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648` |

The package sidecar describes the archive inventory and pinned wheel metadata; its `verification_scope` explicitly does not claim a full upstream build-chain audit or an upstream server run. The actual offline install result is `.codex_tmp/stock-vibe-runtime-verify-5/verification.json`, with `status: verified`.

| Installation check | Observed result |
| --- | --- |
| Component | `stock-vibe`, version `0.1.16+stock.preflight.5`; manifest SHA-256 `94e63c8a390e5aa50fbb9cab685619be832d65b67079f93f916dabf817c8d248` |
| Python environment | Reused `python-base@3.13.15` plus the stock-vibe pack; generation `0f3079774fffd8061b3b008d36de4736` |
| Offline install steps | 3 of 3 returned 0; no network enabled |
| `pip check` | Return code 0; `No broken requirements found.` |
| Core imports | Return code 0 for `fastapi`, `pydantic_settings`, `numpy`, `pandas`, `api_server`, `src.agent.loop`, `src.swarm.runtime`, `backtest.runner`, and `src.shadow_account.extractor` |
| Installed component | 1,812 files / 216,751,028 bytes |
| Isolated Python environment | 32,578 files / 786,535,924 bytes |
| Package expanded contents | 216,750,807 bytes |
| Pip cache / remaining temporary files | 0 / 0 bytes |
| User and shared state | HOME unchanged; Python base and official-environment pointers match before/after; stock-vibe global pointer absent before/after |

The base is reused installation evidence, not a first-time base installation. This verifies the offline component install, pinned environment, `pip check`, and selected imports only. It does not complete the desktop build, OS notification delivery, continuous market-data acceptance, formal ownership switch, or release qualification. The preflight label and previous package records remain historical evidence, not a completion claim for T02 or the four formal switch gates.

## Updated preflight 6 (2026-10-17)

Preflight 6 was built after patch 0021 froze and installed in the separate `.codex_tmp/stock-vibe-runtime-verify-6` root. The ZIP, sidecar, and verification report are retained independently of preflights 1–5.

| Input or receipt | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime-preflight-6.zip`, 195,750,668 bytes |
| Package SHA-256 | `5fb6928c3087bd73a744f8cec9ac59ca7ad25dfeb4cd9730549e3a7a3038326c` |
| Source receipt SHA-256 | `7e91b5f185d064e6293f6575ad810c6ec814309cf5f9d83da33ee76939778d73` |
| Snapshot | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Patch set | `0001–0021`; patch 0021 SHA-256 `f047c2a586c22cb4d2bad4dff5b390667649ff52bb684c251f8b21f14bdb68ac` |
| Windows wheel lock | SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648`; 187 wheel files |
| Verification report | `.codex_tmp/stock-vibe-runtime-verify-6/verification.json`, `status: verified` |

The installation used the reused `python-base@3.13.15` and created generation `1bd31bf7f6c02b6fc8f824b1ca90e82e` only inside the verification root. Its interpreter path is `.codex_tmp/stock-vibe-runtime-verify-6/python/stock-vibe-envs/1bd31bf7f6c02b6fc8f824b1ca90e82e/Scripts/python.exe`.

| Check | Observed result |
| --- | --- |
| Offline builder steps | 3 of 3 returned 0; network disabled |
| `pip check` | Return code 0; `No broken requirements found.` |
| Core imports | Return code 0 for `fastapi`, `pydantic_settings`, `numpy`, `pandas`, `api_server`, `src.agent.loop`, `src.swarm.runtime`, `backtest.runner`, and `src.shadow_account.extractor` |
| HOME / USERPROFILE | Unchanged |
| Global base / runtime pointers | Base tree and pointers matched before/after; global stock-vibe pointer remained absent |
| Installed component | 1,812 files / 216,756,455 bytes |
| Isolated Python environment | 32,578 files / 786,535,924 bytes |
| Pip cache / remaining temporary files | 0 / 0 bytes |

## Updated preflight 7 (2026-10-17; global base check failed)

Preflight 7 was built after patch 0022 froze. Its package and verification root are retained separately from preflight 6. The package install, Python environment build, `pip check`, and nine core imports succeeded, but the full verifier returned `status: failed`; this package is not a passing verification or final business candidate.

| Input or receipt | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime-preflight-7.zip`, 195,752,043 bytes |
| Package SHA-256 | `f7f6f98fdce13d635fb6c847cfe8f6c3d3500c5372571f7616cccc3d788122e4` |
| Source receipt SHA-256 | `c2218d12fe62cb7107d784dd3a1d9ebee9fa5b96a8674003e9b0bd823e69e9bb` |
| Snapshot | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Patch set | `0001–0022`; patch 0022 SHA-256 `ea054458854ed5d0e8ca4000dba3c76146946a532432cc2c9fd9492f380e9a00` |
| Windows wheel lock | SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648`; 187 wheel files |
| Verification report | `.codex_tmp/stock-vibe-runtime-verify-7/verification.json`, `status: failed` |
| Reported error | `VerificationError: global runtime state changed during test-root verification` |

The installer created generation `6e1a8f450b0416a4c5efc187032584f5` inside verify-7 at `.codex_tmp/stock-vibe-runtime-verify-7/python/stock-vibe-envs/6e1a8f450b0416a4c5efc187032584f5/Scripts/python.exe`. Builder steps returned 0, `pip check` reported no broken requirements, the same nine core imports returned 0, HOME/USERPROFILE were unchanged, and global runtime pointers matched before/after. The failure was specifically `global_base_unchanged: false`.

The verifier's copied base at the start of verify-7 had 2,972 files / 58,863,426 bytes and tree SHA-256 `7561a76f43f70bc2f04d551ed2559fe05a2fb9cd6f98e8ec2cd1a9856bbd3c19`. A separate read-only comparison after the failed run found the current base had 2,977 files / 59,054,053 bytes, tree SHA-256 `1e7c58f68f8af19512268941bfce765a2afc160135fad87a561a23f0887d51cb`. It found five additional files and no removed or changed files:

| Difference | Relative path |
| --- | --- |
| Added | `python/Lib/__pycache__/bdb.cpython-313.pyc` |
| Added | `python/Lib/__pycache__/cmd.cpython-313.pyc` |
| Added | `python/Lib/__pycache__/code.cpython-313.pyc` |
| Added | `python/Lib/__pycache__/codeop.cpython-313.pyc` |
| Added | `python/Lib/__pycache__/pdb.cpython-313.pyc` |

The writer of those cache files was not established. The native contract audit reported that its own subprocess tests used the isolated verify-6 interpreter and set `PYTHONDONTWRITEBYTECODE=1`; this does not identify the writer or make verify-7 pass. No cache files were removed or ignored to bypass the global-base integrity check. The retained report remains authoritative for this run.

## Updated preflight 8 (2026-10-17)

Preflight 8 contains frozen patches 0001–0024 and was installed into a new `.codex_tmp/stock-vibe-runtime-verify-8` root. It is retained as historical package-install evidence; preflight 9 supersedes it as the current offline packaging candidate. This is not formal ownership-switch or release qualification.

| Input or receipt | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime-preflight-8.zip`, 195,753,165 bytes |
| Package SHA-256 | `8b3c9db7ed76ebb061f77db18d91bdcb7e7119a09d253ce5959ed1e310765b36` |
| Package sidecar receipt SHA-256 | `f2529114d84d1af9f46468f8355127d714728f79d24b09a9c6584d4d1361b0b9` |
| Source receipt SHA-256 | `2bee1cbac269c0488a1cf4973cc86b41d74429dbd56388d6926564102d13e27e` |
| Snapshot | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Patch set | `0001–0024`; patch 0023 SHA-256 `201d169cde5779f9b7aa45d179c5fc80f1d162d89eb268dd0bf65566e34789b5`; patch 0024 SHA-256 `c57a3267d0a008f192df531fecbfa766fcd6252fd13afae14845c17cee478df6` |
| Windows wheel lock | SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648`; 187 wheels |
| Verification report | `.codex_tmp/stock-vibe-runtime-verify-8/verification.json`, `status: verified` |

| Installation check | Observed result |
| --- | --- |
| Component | `stock-vibe`, version `0.1.16+stock.preflight.8`; manifest SHA-256 `1a4d14610473bba3410f57c4ac380ea98f1ac6c3fb61d17edefabf8132047e51` |
| Python environment | `python-base@3.13.15` plus stock-vibe pack; generation `2c3bd309ec15c2f6cffa21bd87aa9a83` |
| Offline builder steps | 3 of 3 returned 0; network disabled |
| `pip check` / core imports | Both returned 0; nine core imports were checked |
| Global Python base | 2,977 files / 59,054,053 bytes; tree SHA-256 `1e7c58f68f8af19512268941bfce765a2afc160135fad87a561a23f0887d51cb`; unchanged during this verification |
| Global runtime pointers / HOME | Unchanged; global stock-vibe pointer remained absent |
| Installed component | 1,812 files / 216,768,956 bytes |
| Isolated Python environment | 32,578 files / 786,535,924 bytes |
| Pip cache / remaining temporary files | 0 / 0 bytes |

The verifier run started before a small follow-up change that forwards `PYTHONDONTWRITEBYTECODE` through its isolated builder command runner. That run still reports an unchanged global-base tree; the environment was built from the copy inside verify-8. A separate lightweight capture probe passed after the change, confirming the flag reaches the child runner. The verification was not rerun solely for that forwarding adjustment. As with the earlier preflights, these checks do not establish a live market-data run, user-account access, full desktop packaging, or completion of the four formal ownership gates.

## Updated preflight 9 (2026-10-17)

Preflight 9 adds frozen patch 0025, which records the actual Shadow verification window and run inputs in the report metadata without changing financial calculations. It was installed into a fresh `.codex_tmp/stock-vibe-runtime-verify-9` root using the verifier with bytecode suppression forwarded to builder children. It is retained as historical evidence; preflight 10 supersedes it as the current offline packaging candidate.

| Input or receipt | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime-preflight-9.zip`, 195,754,493 bytes |
| Package SHA-256 | `cd9104e7efe81457430b17a44af061cdade4edfe870f9e619c668f57859b9f31` |
| Package sidecar receipt SHA-256 | `19adece3b3104e7f711be733ce7fc63e6871e78b8834d68c53a42959a9493fba` |
| Source receipt SHA-256 | `3947e97c29a5bd847043230123bea06f68eae73b42c79cc5d28e1ec0f3f4cee3` |
| Snapshot | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Patch set | `0001–0025`; patch 0023 SHA-256 `201d169cde5779f9b7aa45d179c5fc80f1d162d89eb268dd0bf65566e34789b5`; patch 0024 SHA-256 `c57a3267d0a008f192df531fecbfa766fcd6252fd13afae14845c17cee478df6`; patch 0025 SHA-256 `b94b6a79f3acf15159410ffce14830bf0e186b8e8133b210b67863317dbd41e8` |
| Windows wheel lock | SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648`; 187 wheels |
| Verification report | `.codex_tmp/stock-vibe-runtime-verify-9/verification.json`, `status: verified` |

| Installation check | Observed result |
| --- | --- |
| Component | `stock-vibe`, version `0.1.16+stock.preflight.9`; manifest SHA-256 `2aec5ed295c35f46844ae8eea13880b3c6f36f86c7c48532f33c4dca083f8979` |
| Python environment | `python-base@3.13.15` plus stock-vibe pack; generation `0abbc3ea3484ededfac54f1a12c117ea` |
| Offline builder steps | 3 of 3 returned 0; network disabled |
| `pip check` / core imports | Both returned 0; nine core imports were checked |
| Global Python base | 2,977 files / 59,054,053 bytes; tree SHA-256 `1e7c58f68f8af19512268941bfce765a2afc160135fad87a561a23f0887d51cb`; unchanged during this verification |
| Global runtime pointers / HOME | Unchanged; global stock-vibe pointer remained absent |
| Installed component | 1,812 files / 216,774,669 bytes |
| Isolated Python environment | 32,578 files / 786,535,924 bytes |
| Pip cache / remaining temporary files | 0 / 0 bytes |

This run verifies offline installation, the locked environment, `pip check`, and selected module imports. It does not rerun the Shadow workflow, demonstrate that report accounting is economically comparable, or complete live data, account, desktop package, or ownership-switch qualification.

## Updated preflight 10 (2026-10-17)

Preflight 10 contains frozen patches 0001–0026 and was installed into a fresh `.codex_tmp/stock-vibe-runtime-verify-10` root. It is retained as historical evidence; preflight 11 supersedes it as the current offline packaging candidate.

| Input or receipt | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime-preflight-10.zip`, 195,758,709 bytes |
| Package SHA-256 | `45d7feb963ca7c3fca8ac8aceb3b769a32b7a64b34124ef5aa771cc3941c6c6f` |
| Package sidecar receipt SHA-256 | `e8b32f51b21bca3bc47737c0d3107ba644c76262d9211a2e962812637c54c6f5` |
| Source receipt SHA-256 | `f0d7fe890540f7596baf5ba426b9aa9f53c1fec586c24caca6e3f1749168ff2a` |
| Snapshot | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Patch set | `0001–0026`; patch 0026 SHA-256 `5b5b68a790eaacde7a2758d94fecd859928dda939761cedcaa38504d34af4eaa` |
| Windows wheel lock | SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648`; 187 wheels |
| Verification report | `.codex_tmp/stock-vibe-runtime-verify-10/verification.json`, `status: verified` |

The isolated environment generation is `1dd21103f43ad302163057d6154ed364`; its interpreter is `.codex_tmp/stock-vibe-runtime-verify-10/python/stock-vibe-envs/1dd21103f43ad302163057d6154ed364/Scripts/python.exe`.

| Installation check | Observed result |
| --- | --- |
| Component | `stock-vibe`, version `0.1.16+stock.preflight.10`; manifest SHA-256 `2753904882dc604008d63dd0316c92b7c83a69509bb59b54d11bdcbaa743dc5c` |
| Offline builder steps | 3 of 3 returned 0; network disabled |
| `pip check` / core imports | Both returned 0; nine core imports were checked |
| Global Python base | 2,977 files / 59,054,053 bytes; tree SHA-256 `1e7c58f68f8af19512268941bfce765a2afc160135fad87a561a23f0887d51cb`; unchanged during this verification |
| Global runtime pointers / HOME | Unchanged; global stock-vibe pointer remained absent |
| Installed component | 1,812 files / 216,797,232 bytes |
| Isolated Python environment | 32,540 files / 786,396,116 bytes |
| Pip cache / remaining temporary files | 0 / 0 bytes |

The verifier and its builder children used `PYTHONDONTWRITEBYTECODE=1`; no global-base files or pointers changed. This run validates package identity, offline dependency installation, `pip check`, and selected imports only. It does not constitute a live strategy-validation run, full desktop package test, or formal ownership switch.

## Updated preflight 11 (2026-10-17)

Preflight 11 contains frozen patches 0001–0027 and was installed into a fresh `.codex_tmp/stock-vibe-runtime-verify-11` root. It verifies offline package installation only; no native server, Tushare credential, or online market-data request was used.

| Input or receipt | Observed value |
| --- | --- |
| Package | `.codex_tmp/stock-vibe-runtime-preflight-11.zip`, 195,760,503 bytes |
| Package SHA-256 | `84e47f3196da76576dc20631e5bae04859e39132dd6a703b030d71ebb895ead8` |
| Package sidecar receipt SHA-256 | `9a3f9445c1c5559cb8ed24982093134b0bd931d11a88166d37502118df8106e2` |
| Source receipt SHA-256 | `5bf0bbfbff0f8c415737df2e0f3963058cd1ad027dae3722879097a3ec959a10` |
| Snapshot | `sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753` |
| Patch set | `0001–0027`; patch 0027 SHA-256 `9d90ec6acb73e259e8574d31c3560d4862764a1c8cde6df0ac844e8e00f81565` |
| Windows wheel lock | SHA-256 `861295cd158d7bb028f41a03b54b9845db0cc1914ae5181063c83a3ad7b88648`; 187 wheels |
| Verification report | `.codex_tmp/stock-vibe-runtime-verify-11/verification.json`, `status: verified` |

The isolated environment uses Python 3.13.15, generation `4a7b7dbb1621f3e4f2eaf1d67cf33ea5`, and interpreter `.codex_tmp/stock-vibe-runtime-verify-11/python/stock-vibe-envs/4a7b7dbb1621f3e4f2eaf1d67cf33ea5/Scripts/python.exe`.

| Installation check | Observed result |
| --- | --- |
| Component | `stock-vibe`, version `0.1.16+stock.preflight.11`; manifest SHA-256 `3dac5984476ef0279f718f82e10d2650dc3e5c33ee8ad8dc829fbdd6473fdd2a` |
| Offline builder steps | 3 of 3 returned 0; network disabled |
| `pip check` / core imports | Both returned 0; nine core imports were checked |
| Global Python base | 2,977 files / 59,054,053 bytes; tree SHA-256 `1e7c58f68f8af19512268941bfce765a2afc160135fad87a561a23f0887d51cb`; unchanged during this verification |
| Global runtime pointers / HOME | Unchanged; global stock-vibe pointer remained absent |
| Installed component | 1,812 files / 216,805,397 bytes |
| Isolated Python environment | 32,540 files / 786,396,116 bytes |
| Pip cache / remaining temporary files | 0 / 0 bytes |

The installer passed with `PYTHONDONTWRITEBYTECODE=1` in the verifier and builder children. This package check does not validate factor calculations, the missing-token no-network behavior, or a live Tushare request; those require separate native probes and credentials.

## Tushare data credential boundary

The host accepts an optional Mona-owned `stockVibe.tushareToken` configuration value or the explicitly scoped `MONA_STOCK_VIBE__TUSHARE_TOKEN` environment variable. Both are empty by default. The host sends a configured value only as `TUSHARE_TOKEN` in the isolated native service process environment; the host status endpoint exposes only `tushare_token_configured: boolean`. The token is included in the in-memory runtime restart signature as a SHA-256 digest and is omitted from source identity and request payloads.

The native backtest runner's existing data-source allowlist passes `TUSHARE_TOKEN` to the same subprocess that loads Tushare data and executes the strategy signal code. This is a data-source credential flow, not an OS sandbox boundary. The host does not use it for broker access or pass provider model API keys through this field. No real Tushare credential or online data request was used in the offline package verification; the strict-factor operation reports unavailable without a configured token and records that no network attempt was made.
