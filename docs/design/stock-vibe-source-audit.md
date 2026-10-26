# Vibe-Trading 来源与依赖审计

更新日期：2026-10-16

范围：T00 上游快照与依赖锁审核
状态：源码内容已锁定；Windows 运行闭包仍待 T02 实测

## 来源快照

上游地址为 <https://github.com/HKUDS/Vibe-Trading>。当前本地副本没有 `.git` 元数据，因此无法确认提交或标签。`pyproject.toml` 声明的 `0.1.16` 只是包版本，不作为源码身份。使用逐文件摘要生成的快照身份：

```text
snapshot_id: sha256:190f869e930ccf0ee0224701892da7f28478e66e1300700c48d0e9f5583a0753
archive: third_party/vibe-trading/vibe-trading-source.zip
archive_sha256: 1f3eeca190f1ce935ad71d3bb294f5e8bb1cbaa3f63fbb5304ff2e11a0fda83d
```

归档包含 2,544 个文件，未压缩 42,782,560 字节，ZIP 压缩后 18,034,920 字节。`files.json` 为每个归档成员记录相对路径、SHA-256 和字节数；`source-lock.json` 记录内容身份、归档摘要及文件清单摘要。归档是未打补丁的上游快照；宿主补丁应另存并在构建时显式应用，不改写该来源摘要。ZIP 使用路径排序、固定时间戳与 DEFLATE 9；同一 Python/zlib 环境可逐字节复现，跨压缩库环境以 `snapshot_id` 和逐文件 SHA-256 判断内容相同。

快照保留完整 `agent/` 源码、资源、技能、测试及测试夹具，并保留根 `pyproject.toml`、README、构建清单、requirements 与锁文件、MIT `LICENSE` 和 `NOTICE`。另保留唯一一个 Windows 依赖候选文件 `desktop/electron/requirements-windows-lock.txt`，不包含 Electron 程序。根前端、Electron 应用、wiki 不进入归档。`.env`/本机环境文件、`.venv`、运行数据、缓存、VCS 目录和 Python 字节码按规则排除；仅保留 `.env.example` 与 `.env.template`。本次扫描没有发现 agent 目录中的符号链接或待排除目录。

生成与校验脚本位于 [snapshot.py](../../tools/stock_vibe/snapshot.py)。重新生成时使用一个空的输出目录；脚本不会覆盖已有快照：

```powershell
py -3.11 tools/stock_vibe/snapshot.py create --source <Vibe-Trading 源码目录> --snapshot-root <空输出目录>
py -3.11 tools/stock_vibe/snapshot.py verify --snapshot-root third_party/vibe-trading
```

## 依赖选择

当前唯一锁定候选是归档内根目录 `requirements-lock.txt`，SHA-256 为 `e3198d6e1d4dc9899f4416e2d4becf5c44fe7e9fd7e80fafe8ea8e5c37fddbb6`。文件头记录它由 uv 按 `--universal --python-version 3.11 --generate-hashes` 从 `agent/requirements.txt` 生成。该锁固定 196 个发行包；静态解析确认 `agent/requirements.txt` 的 49 个直接依赖全部有锁定项，且当前版本满足 `pyproject.toml` 的已锁直接约束。它是 Mona 初始受管运行包的唯一候选基线，不代表 Windows wheel 可用、完整安装成功或 A 股能力已经验证。

`pyproject.toml` 声明 50 个直接依赖，而 `agent/requirements.txt` 声明 49 个；唯一差异是 `pyproject.toml` 中的 `mcp<1.30` 上限。两份现有锁当前都锁定 `mcp==1.28.1`，但从 requirements 重新生成时不会自动保留该上限。T02 的受控构建输入必须明确保留它，再锁定并安装，不得执行无界升级。

`desktop/electron/requirements-windows-lock.txt` 的文件头标注 Python 3.12 和 pip-compile。它有 189 个锁定发行包；与根 universal 锁有 73 个共享包版本不同，额外锁入 `smartmoneyconcepts`、`numba`、`llvmlite` 等当前可选的 SMC 链依赖，并为 `httpx` 加入 `brotli/http2/socks`、为 `pydantic` 加入 `email` extra；这些 extra 不在当前基础 requirements 中。该文件不适合作为本次 CPython 3.11 候选基线，保留用于差异审计。

`requirements-channels-lock.txt` 固定 17 个频道 SDK 依赖，来源是单独的 `agent/requirements-channels.txt`；股票原生 API 不需要消息频道运行时，因此单独保留而不并入股票基础组件。

能力分组按以下边界处理：

- **基础候选**：完整保留 `requirements-lock.txt`，不在 T00 按包名猜测上游核心依赖；T02 结合真实工具发现和 A 股能力清单再决定是否裁剪。
- **继续评估的可选项**：`ashare` extras 中的 `baostock` 可作为免费 A 股数据源候选，需在 T05 验证实际覆盖、时效和联网可用性后再决定是否纳入组件。
- **不并入基础候选**：频道 SDK、非 A 股连接器以及 `smc` 等可选 extra。`smc` 只支撑一个示例技能且引入 `numba/llvmlite`；除非能力清单要求并通过工具发现验收，否则不带入基础组件。

本次来源审计未自行安装依赖或下载 wheel。系统 Python 3.11.9 的可用性和静态锁文件检查不构成 Windows 安装或依赖闭包证据。主线已按同一哈希锁在受管 CPython 3.13 环境完成安装；T02 仍需测量 Windows x64 原生工具发现、免费数据能力、下载体积、展开体积和空间峰值，不能据安装成功将候选锁描述为可发布组件。

主线 T02 的真实 Windows 安装检查进一步发现，根锁中的 `jsonpath==0.82.2` 没有可用二进制 wheel，`--only-binary=:all:` 安装失败。开发验证允许受控源码构建后继续；生产组件必须在受控构建环境生成 Windows wheel，并固定 wheel 摘要与构建工具，禁止让用户端运行源码构建。该项仍是生产依赖闭包缺口。

随后在 CPython 3.11 按哈希允许源码构建也因 `pillow==12.3.0` 无可安装发行包而失败；pip 提示候选要求更高 Python 版本。主线改用统一运行时的 CPython 3.13.15，按同一哈希锁成功安装 188 个发行包，且 `langchain`、`langchain-core`、`langgraph`、`fastapi`、`httpx` 可用。此结果只证明该受管开发环境安装成功；不得回退无哈希锁或据此标记生产闭包完成。

2026-10-16 后续进展：受控宿主补丁已扩至 29 个上游文件，`patches/0001-host-isolation.json` SHA-256 为 `a4e4c4637c45e575b802a21d2458deb99fc710f539fb1fd3da86ba31908598ac`，由 `prepare.py` 从同一快照身份生成 `vibe-native-6`。补丁将 alpha-bench 报告写入根和 allowed write roots 限制到私有运行根，并阻止回测沙箱对祖先目录自动搜索 dotenv；原生健康和 ready 状态仍由原生服务报告。

来源隔离回归用例位于 `tests/services/stock_vibe/test_source.py`。归档篡改、文件清单篡改、精确补丁文本不匹配三个负例均通过，准备失败时没有创建目标或遗留暂存目录。隔离子进程测试以显式参数使用 `.codex_tmp/vibe-native-6`、`.codex_tmp/vibe-venv-313/Scripts/python.exe`、临时 VIBE 数据根和随机非凭据 CWD dotenv sentinel；验证 memory、hypotheses、skills、swarm、upload、report 和允许写目录均落在私有根，CWD dotenv 未载入，HOME/USERPROFILE 未改变，legacy migration 未移动构建目录 sentinel。

## 验证与仓库状态

后续受控构建已修正早期补丁草稿的导入问题；当前0001摘要为 `c9083da2c7dacdae83c0a51c19195c191202f618e35457d53089a3acb55a6caa`。前文 `vibe-native-6` 为保留的历史验证。Windows CPython3.13 的187个wheel已离线安装并通过依赖检查；jsonpath已用固定源码摘要和构建工具重新构建。见 `build-receipt.json`、`requirements-windows-cp313.lock` 与 [运行包验证](stock-vibe-runtime-verification.md)。该证据解决当时的受控源码构建缺口，未替代公开分发与完整平台验收。

- `py -3.11 tools/stock_vibe/snapshot.py verify --snapshot-root third_party/vibe-trading`：成功，归档成员、清单摘要、文件数、逐文件长度与 SHA-256 全部匹配。
- 使用同一 Python 3.11 环境从只读上游目录重建快照：`snapshot_id` 与归档 SHA-256 均与已保存归档一致。
- `py -3.11 -m ruff check tools/stock_vibe/snapshot.py`：通过。
- 使用 PowerShell 设置 `STOCK_VIBE_NATIVE_ROOT=.codex_tmp\vibe-native-6` 与 `STOCK_VIBE_TEST_PYTHON=.codex_tmp\vibe-venv-313\Scripts\python.exe` 后，运行 `py -3.11 -m pytest -q tests/services/stock_vibe/test_source.py`：4 passed。
- `py -3.11 -m ruff check tests/services/stock_vibe/test_source.py`：通过。
- 本文件所在的 `docs/design/*` 被仓库 `.gitignore` 忽略；提交时需显式纳入 `docs/design/stock-vibe-source-audit.md`，本任务不修改 `.gitignore`。
