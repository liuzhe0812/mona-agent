# Mona 死代码清理开发计划

> 基于 2026-07-12 全模块审计结果，按 TDD 标准逐项处理验证。
> 审计基线 commit: `ad07b4f`(已包含 P0 中 3 个含明文密码脚本的删除)

## 测试命令约定

| 范围 | 命令 |
|------|------|
| Python 测试 | `pytest tests/ -x` |
| Python lint | `ruff check mona/ tests/` |
| Rust 编译检查 | `cargo check --manifest-path src-tauri/Cargo.toml` |
| Rust 测试 | `cargo test --manifest-path src-tauri/Cargo.toml` |
| 前端类型检查 | `cd webui && pnpm exec tsc --noEmit` |
| 前端 lint | `cd webui && pnpm lint` |
| 前端测试 | `cd webui && pnpm test` |
| 官网类型检查 | `cd site && pnpm exec tsc --noEmit` |

## TDD 适配原则

死代码清理本质上是**重构**而非新功能，TDD 循环适配如下：

- **Red 阶段**：在删除前，先确保存在覆盖该符号被删除后应保持不变行为的测试（"安全网测试"）。对功能性 stub（如 `mona/cli/models.py`），则按标准 TDD 写断言期望行为的失败测试。
- **Green 阶段**：执行删除/修复。运行全部测试与 lint，确认仍为绿色；若是 stub 修复则确认新测试由红转绿。
- **Refactor 阶段**：清理因删除产生的孤儿 import、空模块、未使用变量；若被删代码有专门的单元测试则一并删除该测试。
- **Verify 阶段**：执行对应语言的 lint（`ruff check`/`cargo check`/`tsc --noEmit`/`pnpm lint`）确认无新增告警。

每个 TDD 循环结束后单独提交一次 commit，commit message 遵循 conventional commits。

---

## Phase 0 — 基线建立（已完成）

- [x] 提交所有未提交的代码（`ad07b4f`）
- [x] 删除 3 个含明文 SSH 密码的临时脚本（`_tmp_check_service.py`/`_tmp_deploy_fix.py`/`_tmp_verify_license.py`）

---

## Phase 1 — P0 安全风险清理

### T1.1 删除剩余 7 个含凭据的部署/调试脚本

**目标**：删除 `deploy_auth.py`、`start_gateway_stt.py`、`tmp_deploy_notif.py`、`tmp_deploy_payment.py`、`tmp_deploy_promo.py`、`tmp_restart_service.py`、`tmp_revert_payment.py`

**TDD 循环**：
1. Red: 运行 `git grep -n "Alt34484\|sk-ijxtqvlwlsdhyp"` 确认 7 个文件均含明文密钥；记录当前命中清单作为基线。
2. Green: `git rm` 删除 7 个文件。重新运行上述 grep，确认命中数为 0。
3. Refactor: 检查 `.gitignore`，添加 `tmp_*.py` / `_tmp_*.py` 模式以防再次引入。
4. Verify: `ruff check` + `cargo check` + `tsc --noEmit` 均应通过。

> ⚠️ 这些文件已进入 git 历史。若需彻底清除历史需用 `git filter-repo --replace-text`，但会重写所有 commit 哈希。**强烈建议同步旋转 VPS root 密码和 SiliconFlow API Key**，此为根因方案。

**Commit**：`chore(security): 删除含明文凭据的部署脚本并加固 .gitignore`

---

## Phase 2 — P1 功能性死代码（影响功能）

### T2.1 修复 `mona/cli/models.py` 空 stub（litellm 替换遗留）

**当前状态**：4 个函数返回空值，导致 onboard 向导中模型自动补全静默失效。

**TDD 循环**：
1. Red: 在 `tests/cli/test_models.py`（新建）写测试：
   - `test_get_all_models_returns_known_models` — 断言返回列表包含至少一个已知模型名
   - `test_find_model_info_returns_known` — 断言对已知模型返回非 None
   - `test_get_model_context_limit_returns_int` — 断言对已知模型返回正整数
   运行测试，确认全部失败（当前 stub 返回空）。
2. Green: 实现真正的模型列表——可从 `mona/providers/registry.py` 的 `PROVIDERS` 元组与每个 provider 的 `default_model` 聚合，或从配置 `config/schema.py` 中已声明的模型预设读取；上下文窗口限制用静态表（GPT-4o=128000, Claude Sonnet=200000 等）。运行测试，确认转绿。
3. Refactor: 将静态模型表抽到 `mona/cli/models.py` 顶部常量；保留 `format_token_count` 不动。
4. Verify: `pytest tests/cli/ -x` + `ruff check mona/cli/models.py` + 手动运行 `mona onboard` 确认向导中模型补全工作。

**Commit**：`fix(cli): 恢复 models.py 模型列表实现，修复 onboard 向导静默失效`

### T2.2 删除 `mona/agent/tools/ssh.py` 软弃用工具

**当前状态**：`SSHExecTool` 标注 `[DEPRECATED]` 但仍被 `ToolLoader.discover()` 加载，靠 prompt 引导不调用。

**TDD 循环**：
1. Red: 在 `tests/agent/tools/` 下确认无测试直接 import `SSHExecTool`（若有则需先删除）。在 `tests/agent/test_runner_core.py` 或新文件写测试断言 `ssh_exec` 不在已加载工具名列表中。
2. Green: 
   - 删除 `mona/agent/tools/ssh.py`
   - 在 `mona/agent/tools/loader.py` 的 `_SKIP_MODULES` 添加 `"ssh"`（防止外部插件残留）
   - 同步移除 `_SKIP_MODULES` 中的 `"sftp"` 字符串（T3.2 顺便完成）
3. Refactor: 更新 `mona/templates/agent/tool_contract.md` L51 中对 `ssh_exec (deprecated)` 的引导文字，改为说明统一使用 `terminal_exec`。
4. Verify: `pytest tests/agent/ -x` + `ruff check mona/agent/tools/` + 启动 gateway 确认工具列表中无 `ssh_exec`。

**Commit**：`refactor(agent): 删除软弃用的 SSHExecTool，统一使用 terminal_exec`

### ~~T2.3 draw.io 占位符~~（已撤销 — 非死代码）

**调研结论**：draw.io 不是死代码，是运行时 fallback 体系的一部分。
- `mona/api/flowchart_runtime.py` 实现完整的 GitHub 按需下载机制（检测占位符标记 → 下载 release → 解压到 `~/.mona/runtime/drawio/`）
- `webui/src/components/doc/flowchart/DrawioEditor.tsx` 已完整实现 postMessage 嵌入协议
- `FlowchartMakerView.tsx` 已集成 `status.drawio.ok` 状态检查
- `mona/static/drawio/index.html` 是打包发布的 fallback，真正运行时从 GitHub 动态下载

**决策**：保留原样，不处理。PPT skill 走 SVG→PPTX 路线，与 draw.io 的 mxGraph XML 路线是完全独立的功能，不存在替代关系。

### T2.4 修复 `mona/skills/README.md` 过时 skill 列表

**当前状态**：列出 4 个不存在的 skill（weather/summarize/tmux/skill-creator）。

**TDD 循环**：
1. Red: 在 `tests/agent/test_skills_loader.py` 写测试：`test_readme_skill_list_matches_directory` — 扫描 `mona/skills/` 实际子目录，与 README 中的列表对比，断言完全一致。运行确认失败。
2. Green: 重写 README L23-33 的 skill 表格，改为动态扫描结果对应的列表（clawhub/cron/docx/github/html-report/image-generation/long-goal/memory/mona-flowchart/mona-ppt/mona-video/my/pdf/skill-creator/update-setup/weather 等——以实际目录为准）。
3. Refactor: 在 README 顶部加注释 "此列表由人工维护，新增 skill 时需同步更新"。
4. Verify: `pytest tests/agent/test_skills_loader.py -x` 通过。

**Commit**：`docs(skills): 同步 README skill 列表与实际目录`

### T2.5 删除 `browser/get_page_source` 半实现 stub ✅ 决策已定

**当前状态**：返回空字符串，但 Tauri 命令 `browser_get_page_source` 已暴露给前端。前端 `browser-ipc.ts` 虽导出 `browserGetPageSource` 但无任何组件调用。

**决策**：删除命令（用户采纳推荐选项）。

**TDD 循环**：
1. Red: Grep `browser_get_page_source|browserGetPageSource|get_page_source` 确认前端零调用方。运行 `cargo check` + `tsc --noEmit` 建立绿色基线。
2. Green:
   - 删除 `src-tauri/src/browser/mod.rs` L873-897 的 `get_page_source` 方法
   - 删除 `src-tauri/src/browser/commands.rs` L282-288 的 `#[tauri::command] pub async fn browser_get_page_source`
   - 删除 `src-tauri/src/lib.rs` L637 invoke_handler! 中的 `browser::commands::browser_get_page_source` 注册
   - 删除 `webui/src/lib/browser-ipc.ts` L238-241 的 `browserGetPageSource` 导出
3. Verify: `cargo check` + `cargo test` + `tsc --noEmit` + `pnpm lint` 通过。

**Commit**：`refactor(browser): 移除未实现的 get_page_source stub`

### T2.6 删除 `terminal/session.rs` ConnectionPool 死代码 ✅ 决策已定

**当前状态**：`ConnectionPool`、`SharedSshConnection` 及其方法整体未使用，SSH 连接复用机制未启用。三个连接入口（ssh_connect/ssh_connect_with_id_inner/ssh_reconnect）都直接调用 `SshClient::connect()` 新建连接，从未走池子。

**决策**：删除死代码（用户采纳推荐选项）。启用连接池需 1-2 天中高复杂度重构（SshClient 语义需从"一个完整连接"改为"共享连接上的一个 channel 会话"），目前无性能瓶颈反馈，不值得投入。

**TDD 循环**：
1. Red: Grep `ConnectionPool|SharedSshConnection|get_or_create|inc_ref|dec_ref|ref_count|\.pool\(\)` 确认零外部调用。运行 `cargo check` 建立绿色基线。
2. Green:
   - 删除 `session.rs` L79-114 的 `SharedSshConnection` 结构体及方法
   - 删除 `session.rs` L120-180 的 `ConnectionPool` 结构体及方法
   - 删除 `SessionManagerInner` 的 `connection_pool` 字段（L185 附近）
   - 删除 `SessionManager::new()` 中 `connection_pool: ConnectionPool::new()` 初始化
   - 删除 `SessionManager::pool()` 方法（L264-266）
3. Refactor: 检查 `DashMap` 是否还有其他用途（grep `DashMap` 全 src-tauri/），若无则从 Cargo.toml 移除依赖。
4. Verify: `cargo check` + `cargo test` 通过，无 `unused field`/`unused import` 警告。

**Commit**：`refactor(terminal): 移除未启用的 SSH 连接池死代码`

### T2.7 为 `db/types.rs` 未使用枚举变体添加显式标注 ✅ 决策已定

**当前状态**：
- `DatabaseType` 6 个变体只实现 Sqlite/Mysql，其余走 `_ => Err`。前端 select 列出全部 6 选项，`connections.json` 持久化依赖 serde 严格校验。
- `DatabaseObjectType` 11 个变体只构造 Table/View。前端 dbStore.ts 硬编码 'database'/'folder' 字符串，但 ConnectionTree.tsx 不读 object_type 靠中文名判断。
- 后端 `CellValue::display()` 从未被调用（前端 types.ts 独立实现了 `displayCellValue`）。

**决策**：保留+显式标注（用户采纳推荐选项）。删除变体会破坏前端选项和 connections.json 兼容性，需同步改前端 types.ts/NewConnectionDialog/EditConnectionDialog/dbStore.ts，风险收益比不划算。

**TDD 循环**：
1. Red: 运行 `cargo check` 确认无警告（当前已被 cargo 默认行为抑制）。移除 CellValue::display 的使用确认零调用方。
2. Green:
   - 为 `DatabaseType` 的 PostgreSQL/SqlServer/Oracle/Mongodb 变体添加 `#[allow(dead_code)]` 标注（在 enum 定义上方或各变体上方），表示"未来支持"
   - 为 `DatabaseObjectType` 的 Server/Procedure/Function/Index/Trigger/Event/Column 变体添加 `#[allow(dead_code)]` 标注
   - 删除 `CellValue::display()` 方法（types.rs L172-183），因前端独立实现了等价逻辑
3. Verify: `cargo check` 无新增警告 + `cargo test` + `tsc --noEmit` 通过。

**Commit**：`refactor(db): 显式标注未实现的枚举变体，删除未使用的 CellValue::display`

### T2.8 删除前端整目录死代码

**目标**：删除 `webui/src/components/workspace/`（3 文件）、`webui/src/components/knowledge/settings/`（5 文件）、`webui/src/stores/`（3 文件）。

**TDD 循环**：
1. Red: 对每个待删目录执行 `grep -r "<AgentWorkbench\|<ModulePlaceholder\|<WorkspaceTabs\|<QualityView\|chat-store\|activity-store\|research-store"` 全局，确认零调用方。运行 `tsc --noEmit` 建立绿色基线。
2. Green: `rm -rf` 删除三个目录。
3. Refactor: 检查 `webui/src/components/knowledge/` 根目录是否还有其他引用 `settings/` 的代码（quality-view.tsx 也需一并删除，见 T2.9）。
4. Verify: `tsc --noEmit` + `pnpm lint` + `pnpm test` 通过。

**Commit**：`refactor(webui): 删除 workspace/knowledge-settings/stores 整目录死代码`

### T2.9 删除前端单文件死代码（旧版组件）

**目标**：删除 14 个未使用组件（Composer/MessageList/AuthGate/AuthPage/EmptyState/SetupWizard/AccountSidebar/AiOperationOverlay/PropertiesPanel/FileList/FileToolbar/BatchOutputArea/BatchTabBar/quality-view）。

**TDD 循环**：
1. Red: 对每个组件名执行全局 grep 确认零调用方（包括动态字符串拼接情况）。运行 `tsc --noEmit` 建立基线。
2. Green: 逐个删除文件（或一次性批量删除）。
3. Refactor: 检查被删文件是否有内部 import 链（如 AuthPage import SubscribeView，但 SubscribeView 还被 LoginDialog 使用——仅删 AuthPage 保留 SubscribeView）。
4. Verify: `tsc --noEmit` + `pnpm lint` + `pnpm test` 通过。

**Commit**：`refactor(webui): 删除 14 个未使用的旧版组件`

---

## Phase 3 — P2 Python 后端可直接删除的死代码

### T3.1 删除 `mona/agent/tools/terminal.py` 的 `_gateway_port`

**TDD 循环**：
1. Red: `grep -rn "_gateway_port"` 确认仅定义处命中。
2. Green: 删除 terminal.py L33-40。
3. Verify: `pytest tests/tools/test_terminal_tool.py -x` + `ruff check mona/agent/tools/terminal.py`。

**Commit**：`refactor(terminal): 删除未使用的 _gateway_port 函数`

### T3.2 清理 `mona/agent/tools/loader.py` 的 `_SKIP_MODULES` 孤儿字符串

> 已在 T2.2 中顺便完成（删 `"sftp"` 同时加 `"ssh"`）。如 T2.2 未执行则独立处理。

### T3.3 删除 `mona/config/paths.py` 的 `get_bridge_install_dir`

**TDD 循环**：
1. Red: `grep -rn "get_bridge_install_dir"` 确认仅在 paths.py 定义 + `config/__init__.py` re-export + `tests/config/test_config_paths.py` 断言。
2. Green: 
   - 删除 `paths.py` L69-71
   - 删除 `config/__init__.py` 中的 re-export 行
   - 删除 `tests/config/test_config_paths.py` 中针对 `get_bridge_install_dir` 的断言
3. Verify: `pytest tests/config/ -x` + `ruff check mona/config/`。

**Commit**：`refactor(config): 删除未使用的 get_bridge_install_dir（WhatsApp bridge 不存在）`

### T3.4 删除 `mona/config/loader.py` 的重复函数 `_resolve_env_vars`

**TDD 循环**：
1. Red: `grep -rn "_resolve_env_vars"` 确认仅在 loader.py 定义 + 内部递归 + `tests/config/test_env_interpolation.py` 直接调用。
2. Green: 
   - 删除 `loader.py` L129-137 的 `_resolve_env_vars` 函数
   - 改写 `tests/config/test_env_interpolation.py` 中所有 `_resolve_env_vars(...)` 调用为 `resolve_config_env_vars(...)`（公开 API），保持测试断言不变
3. Verify: `pytest tests/config/test_env_interpolation.py -x` 全部通过 + `ruff check mona/config/loader.py`。

**Commit**：`refactor(config): 删除重复的 _resolve_env_vars，测试改用公开 resolve_config_env_vars`

### T3.5 评估 `mona/bus/queue.py` 的 `inbound_size`/`outbound_size`

**当前状态**：仅测试调用。

**TDD 循环**（决策驱动）：
1. 决策点：
   - 选项 A（推荐保留）：作为公开只读 API 保留，因为 `qsize()` 是合理的运维诊断接口。
   - 选项 B（删除）：若坚持"零测试专用 API"原则，改名为 `_inbound_size` 并删除测试。
2. 若选 A：仅在函数 docstring 注明"主要用于测试与诊断"，不做代码变更。跳过此条。
3. 若选 B：执行删除并改测试。
4. Verify。

**Commit**（若选 B）：`refactor(bus): 将仅测试使用的 size 属性改为私有`

### T3.6 删除 `mona/agent/runner.py` 的单数兼容垫片 `prepare_file_edit_tracker`

**TDD 循环**：
1. Red: `grep -rn "prepare_file_edit_tracker[^s]"` 确认仅 `runner.py:69` 定义 + `tests/utils/test_file_edit_events.py` 和 `tests/agent/test_loop_progress.py:177` 的 monkeypatch。
2. Green: 
   - 删除 `runner.py` L67-69 的单数别名
   - 修改上述两个测试，将 `monkeypatch.setattr(..., "prepare_file_edit_tracker", ...)` 改为 `"prepare_file_edit_trackers"`（复数）
3. Verify: `pytest tests/utils/test_file_edit_events.py tests/agent/test_loop_progress.py -x` 通过。

**Commit**：`refactor(agent): 移除单数兼容垫片 prepare_file_edit_tracker`

### T3.7 删除 `mona/agent/loop.py` 的单数参数 `image_generation_provider_config`

**TDD 循环**：
1. Red: `grep -rn "image_generation_provider_config[^s]"` 确认仅 `loop.py` 内部 + `tests/agent/test_loop_image_generation_media.py:70`。
2. Green: 
   - 删除 `loop.py` L190 的单数参数声明 + L237-241 的兼容映射代码
   - 修改 `tests/agent/test_loop_image_generation_media.py:70` 使用复数 `image_generation_provider_configs=["openrouter"]`
3. Verify: `pytest tests/agent/test_loop_image_generation_media.py -x` 通过。

**Commit**：`refactor(agent): 移除单数兼容参数 image_generation_provider_config`

### T3.8 删除 `mona/contacts/wbxml.py` 的 13 个未使用 WBXML 常量

**TDD 循环**：
1. Red: 对每个常量名执行 grep 确认仅定义处命中。
2. Green: 删除 wbxml.py 中的 13 个未使用常量。**必须保留 `STR_T`（被自身 L357 引用）和 `OPAQUE`（被 L339 引用）**。实际删除的 13 个常量为：`LITERAL_A`、`LITERAL_C`、`LITERAL_AC`、`EXT_I_0`、`EXT_I_1`、`EXT_I_2`、`PI`、`EXT_T_0`、`EXT_T_1`、`EXT_T_2`、`EXT_0`、`EXT_1`、`EXT_2`。
3. Verify: `ruff check mona/contacts/wbxml.py` + `pytest tests/` 中涉及 contacts 的测试通过。

**Commit**：`refactor(contacts): 删除 13 个未使用的 WBXML 协议常量`

### ~~T3.9 删除 `mona/email/imap_pool.py` 的未使用方法 `keepalive`、`status`~~（已撤销 — 有生产调用）

**调研结论**：`keepalive` 和 `status` 并非死代码，在 `mona/api/server.py` 中有明确的生产调用：
- `status()` 在 `server.py:2690` 的 `handle_email_pool_status` HTTP handler 中被调用
- `keepalive` 在 `server.py:4639` 作为 `threading.Thread` 的 `target` 参数被引用（注意：作为 callable 引用传递，不带括号，所以 `grep '\.keepalive\('` 会产生假阴性）

**决策**：撤销，保留原样，不处理。

### T3.10 删除 `mona/hoard/vectorstore.py` 的未使用函数 `delete_vector`、`count_vectors`

**TDD 循环**：
1. Red: grep 确认零调用方。
2. Green: 删除 `vectorstore.py` L145 的 `delete_vector` 和 L159 的 `count_vectors`。
3. Verify: `ruff check mona/hoard/vectorstore.py` + `pytest tests/` 涉及 hoard 的测试通过。

**Commit**：`refactor(hoard): 删除未使用的 delete_vector/count_vectors 函数`

### T3.11 删除 `mona/kb/ingest.py` 的未使用函数 `parse_file_blocks`

**TDD 循环**：
1. Red: grep 确认零调用方。
2. Green: 删除 `ingest.py` L14 的 `parse_file_blocks`。
3. Verify: `ruff check mona/kb/ingest.py` + `pytest tests/` 涉及 kb 的测试通过。

**Commit**：`refactor(kb): 删除未使用的 parse_file_blocks 函数`

### T3.12 删除 `mona/utils/helpers.py` 的未使用函数 `timestamp`

**TDD 循环**：
1. Red: `grep -rn "from mona.utils.helpers import.*timestamp\|helpers\.timestamp("` 确认零命中（注意排除 `datetime.timestamp()` 方法调用）。
2. Green: 删除 `helpers.py` L195-197 的 `timestamp` 函数。
3. Verify: `ruff check mona/utils/helpers.py` + `pytest tests/utils/ -x`。

**Commit**：`refactor(utils): 删除未使用的 timestamp 函数`

---

## Phase 4 — P2 Rust 侧可直接删除的死代码

### T4.1 清理 `src-tauri/src/gateway.rs` 的 `GatewayManager::port`

**TDD 循环**：
1. Red: 确认 `#[allow(dead_code)]` 标注存在，cargo check 无警告（被显式抑制）。
2. Green: 删除 `gateway.rs` L254-258 的 `port()` 方法 + L254 上方的 `#[allow(dead_code)]` 标注。
3. Verify: `cargo check` 无新增警告。

**Commit**：`refactor(gateway): 删除未使用的 GatewayManager::port 方法`

### T4.2 清理 `src-tauri/src/schedule_notifier.rs` 的 `NotificationEntry::item_id`

**TDD 循环**：
1. Red: 确认字段被反序列化但从不读取。
2. Green: 删除 `schedule_notifier.rs` L25-27 的 `item_id` 字段 + `#[serde(rename = "item_id")]` + `#[allow(dead_code)]`。
3. Refactor: 检查前端是否在构造 notification payload 时传入 `item_id`，若是则可一并清理前端。
4. Verify: `cargo check` + `tsc --noEmit`。

**Commit**：`refactor(schedule_notifier): 删除未读取的 item_id 字段`

### T4.3 修复 `src-tauri/src/lib.rs` 的死赋值 `_has_md_file`

**TDD 循环**：
1. Red: `grep -rn "_has_md_file"` 确认仅 L707 声明 + L712 赋值，无读取。
2. Green: 删除 `let mut _has_md_file = false;` 和 `_has_md_file = true;` 两行（L707, L712）。
3. Verify: `cargo check` 无 `unused variable` 警告。

**Commit**：`fix(lib): 移除 _has_md_file 死赋值`

### T4.4 删除 `src-tauri/src/python.rs` 的未使用 `is_gateway_deployed`

**TDD 循环**：
1. Red: grep 确认零调用。
2. Green: 删除 `python.rs` L26-28 的 `is_gateway_deployed` 函数。
3. Verify: `cargo check`。

**Commit**：`refactor(python): 删除未使用的 is_gateway_deployed 函数`

### T4.5 删除 `src-tauri/src/db/manager.rs` 的未使用 `connections`

**TDD 循环**：
1. Red: grep `\.connections\(\)` 确认无外部调用。
2. Green: 删除 `manager.rs` L44-46 的 `pub fn connections` 方法。
3. Verify: `cargo check` + `cargo test`。

**Commit**：`refactor(db): 删除未使用的 ConnectionManager::connections 方法`

### T4.6 删除 `src-tauri/src/db/types.rs` 的未使用 `CellValue::display`

**TDD 循环**：
1. Red: grep 确认零外部调用。
2. Green: 删除 `types.rs` L172-183 的 `impl CellValue { pub fn display }` 代码块。
3. Verify: `cargo check`。

**Commit**：`refactor(db): 删除未使用的 CellValue::display 方法`

### T4.7 清理 `src-tauri/src/terminal/` 多处未使用方法

**目标**（一次性提交，文件分散但类型相同）：
- `mod.rs` L51-53 `TerminalState::shared`
- `session.rs` L254-257 `SessionManager::get_session`
- `session.rs` L264-266 `SessionManager::pool`
- `approval.rs` L81-88 `ApprovalManager::cancel_all`
- `sftp/batch.rs` L11-12 `BatchTransferStatus::Pending`
- `sftp/batch.rs` L44-73 `BatchTransferTask` + `BatchTransferConfig` + Default impl
- `sftp/batch.rs` L117-120 `BatchTransferManager::is_active`
- `sftp/client.rs` L213-221 `SftpClient::rmdir`
- `sftp/client.rs` L342-407 `SftpClient::upload_with_progress`
- `credential_store.rs` L286-294 `delete_credential`
- `ssh/agent.rs` L132-146 `is_agent_available`
- `vnc/mod.rs` L33-35 `VncState::shared`
- `session.rs` L28 `SessionStatus::Disconnecting`（仅在转换表和字符串映射出现，从未实际设置）

**TDD 循环**：
1. Red: 对每个符号执行 grep 确认零外部调用（建立清单）。运行 `cargo check` 记录当前告警数。
2. Green: 逐个删除上述符号。
3. Refactor: 检查删除后是否产生新的"unused import"告警，清理之。检查 `SessionStatus::Disconnecting` 删除后是否需同步清理 session.rs L39, L42 的转换表条目和 commands.rs L1132 的字符串映射条目。
4. Verify: `cargo check` 告警数 ≤ 基线 - 13（即至少减少 13 处死代码）+ `cargo test`。

**Commit**：`refactor(terminal): 批量清理未使用的 pub fn/struct/枚举变体`

### T4.8 评估 `src-tauri/src/terminal/config.rs` 的死枚举变体 `Protocol::Ftp`/`Local`/`Vnc`

**TDD 循环**（决策驱动）：
1. Red: 确认这三个变体在 `commands.rs` 的 match 中走 `_ => SessionType::Ssh` fallback。
2. 决策点：
   - 选项 A（推荐）：保留枚举定义但删除 match 中的 `_ =>` fallback，改为显式 `Protocol::Ftp | Protocol::Local | Protocol::Vnc => SessionType::Ssh`，避免未来新增变体时静默走 fallback。
   - 选项 B：删除三个变体。
3. Green: 执行决策。
4. Verify: `cargo check`。

**Commit**：`refactor(terminal): 显式处理 Protocol 死分支变体`

---

## Phase 5 — P2 前端单文件死代码清理

### T5.1 删除 `webui/src/lib/` 三个未使用工具文件

**目标**：`detect-language.ts`、`keyboard-utils.ts`、`language-metadata.ts`

**TDD 循环**：
1. Red: 对每个文件的导出符号执行 grep 确认零 import。
2. Green: 删除三个文件。
3. Verify: `tsc --noEmit` + `pnpm lint` + `pnpm test`。

**Commit**：`refactor(webui/lib): 删除 3 个未使用的工具文件`

### T5.2 删除 `site/src/` 四个未使用文件

**目标**：`components/CounterAnimation.tsx`、`components/TerminalBlock.tsx`、`components/TypewriterText.tsx`、`hooks/useTheme.ts`

**TDD 循环**：
1. Red: 对每个文件名执行 grep 确认零 import。
2. Green: 删除四个文件。
3. Verify: `cd site && tsc --noEmit`。

**Commit**：`refactor(site): 删除 4 个未使用的组件和 hook`

### T5.3 清理 `webui/src/i18n/locales/en/common.json` 未使用翻译键

**目标**：`app.title`、`app.subtitle`、`app.loading.boot`

**TDD 循环**：
1. Red: 对每个 key 执行 grep 确认无 `t("app.title")` 等动态调用（注意检查字符串拼接 `t(\`app.\${x}\`)` 情况）。
2. Green: 删除 common.json L4、L5、L8 三个键。
3. Verify: `tsc --noEmit` + `pnpm test` + 手动检查应用启动无 i18n missing key 警告。

**Commit**：`chore(i18n): 删除 3 个未使用的翻译键`

---

## Phase 6 — P3 根目录临时文件清理与归档

### T6.1 删除根目录 14 个临时调试脚本

**目标**：`_build_python.ps1`、`_build_python2.ps1`、`_check_size.py`、`_create_update_pkg.ps1`、`_test_browser_capabilities.py`、`_test_browser_login.py`、`_test_cdp.py`、`_test_cdp2.py`、`_test_video_deep.py`、`_verify.py`、`_verify_tags.py`、`temp_canvas.md`、`temp_skill.md`、`pptx_test_tmp/`

**TDD 循环**：
1. Red: 对每个文件名执行全局 grep 确认零引用（排除自身）。
2. Green: `git rm` 删除所有文件和目录。
3. Verify: `ruff check` + `cargo check` + `tsc --noEmit` 均通过。

**Commit**：`chore: 删除 14 个根目录临时调试脚本和草稿`

### T6.2 归档根目录 5 个 HTML 文档到 `docs/archive/`

**目标**：`comparison_mona_vs_openakita.html`、`memory_comparison.html`、`nanobot_architecture.html`、`Mona用户手册.html`、`mona-product-guide.html`

**TDD 循环**：
1. Red: 对每个文件名执行 grep 确认零引用。
2. Green: `mkdir -p docs/archive/product-research docs/archive/user-docs`，`git mv` 5 个文件到对应子目录。
3. Verify: 文档链接无失效。

**Commit**：`docs: 归档 5 个废弃产品对比和用户文档到 docs/archive/`

### T6.3 归档或删除 `license-server/` 目录

**TDD 循环**：
1. Red: Grep `license-server` 全局确认零引用；确认 `src-tauri/src/license.rs:11` 使用的是 `mona-auth/` 而非 `license-server/`。
2. 决策点：
   - 选项 A（推荐删除）：`git rm -r license-server/`，因为 `mona-auth/` 已完全替代。
   - 选项 B（归档）：`git mv license-server/ docs/archive/license-server-legacy/`。
3. Green: 执行决策。
4. Verify: `ruff check` + `cargo check` + `tsc --noEmit` 通过。

**Commit**：`chore: 删除被 mona-auth 替代的 license-server` 或 `docs: 归档 legacy license-server`

### T6.4 整理工具脚本位置

**目标**：`core_agent_lines.sh` → `scripts/`，`prototype/index.html` → `docs/prototype/`（合并）

**TDD 循环**：
1. Red: grep 确认零引用。
2. Green: `git mv core_agent_lines.sh scripts/`；`git mv prototype/index.html docs/prototype/index.html`（若 `docs/prototype/` 已有 `db-client.html` 则无冲突）；空目录 `prototype/` 删除。
3. Verify: 脚本可正常执行（`bash scripts/core_agent_lines.sh` 输出非空）。

**Commit**：`chore: 整理 core_agent_lines.sh 和 prototype 到规范位置`

### T6.5 ESP32 资源迁移到 `hardware/esp32/` ✅ 决策已定

**当前状态**：3 个 ESP32 相关目录（esp32-assets/、esp32-firmware/、esp32-ai-character-prd/）+ 1 个根目录 esp32-screen-simulator.html。调研确认：与 Mona 核心代码零交叉引用（mona/ 仅 1 条注释、src-tauri/ 与 webui/ 为 0）；不在构建链（build-macos.yml 不含 ESP-IDF）；firmware 硬编码 WiFi/API URL 仍为占位符；单向依赖（ESP32 调 Mona API，Mona 不依赖 ESP32）。

**决策**：移到 `hardware/esp32/` 子目录（用户采纳推荐选项）。保留历史，不丢失代码，但清理根目录。Mona 构建不受影响（本就不在构建链）。若未来重启项目可轻松找到。

**TDD 循环**：
1. Red: Grep 确认零交叉引用（已验证）。运行 `cargo check` + `tsc --noEmit` + `ruff check` 建立基线。
2. Green:
   - `mkdir -p hardware/esp32/`
   - `git mv esp32-assets/ hardware/esp32/esp32-assets/`
   - `git mv esp32-firmware/ hardware/esp32/esp32-firmware/`
   - `git mv esp32-ai-character-prd/ hardware/esp32/esp32-ai-character-prd/`
   - `git mv esp32-screen-simulator.html hardware/esp32/esp32-screen-simulator.html`
   - 检查 `esp32-ai-character-prd/esp32-screen-simulator.html` 和根目录的 `esp32-screen-simulator.html` 是否重复，若是则只保留一份
3. Refactor: 检查 `esp32-ai-character-prd/esp32-ai-character-prd.html` 中引用 `esp32-firmware/` 的相对路径是否需要调整（从 `../esp32-firmware/` 改为 `../esp32-firmware/` — 移到同一父目录下后路径不变）。
4. Verify: `cargo check` + `tsc --noEmit` + `ruff check` 通过。手动打开 `hardware/esp32/esp32-ai-character-prd/esp32-screen-simulator.html` 确认图片引用路径正确。

**Commit**：`chore: 迁移 ESP32 资源到 hardware/esp32/ 子目录`

---

## Phase 7 — 代码重复消除（可选）

### T7.1 消除 `_PPT_TOOLS` 与 `_VIDEO_TOOLS` 重复定义

**TDD 循环**：
1. Red: 在 `tests/agent/` 下确认无测试直接断言 `_VIDEO_TOOLS is not _PPT_TOOLS`（若有则需先修改）。建立基线。
2. Green: 将 `mona/agent/document_loop.py` L45-59 的 `_VIDEO_TOOLS = frozenset({...})` 改为 `_VIDEO_TOOLS = _PPT_TOOLS`，保留 L41-44 的注释说明设计意图。
3. Verify: `pytest tests/agent/ -x` + `ruff check mona/agent/document_loop.py`。

**Commit**：`refactor(agent): _VIDEO_TOOLS 改为引用 _PPT_TOOLS 消除重复`

### T7.2 统一 `_tauri_invoke` 实现

**TDD 循环**：
1. Red: 在 `tests/tools/` 下若有针对 `terminal._tauri_invoke` 的测试，先确认行为契约（异常返回字符串错误 vs 抛 RuntimeError）。建立基线。
2. Green: 修改 `mona/agent/tools/terminal.py` 删除私有 `_tauri_invoke`（L43-59）和 `_read_ipc_port`（L22-30），改用 `from mona.agent.tools.tauri_ipc import tauri_invoke`。
   - 调用方 `database.py:11` 的 `from mona.agent.tools.terminal import _tauri_invoke` 需改为 `from mona.agent.tools.tauri_ipc import tauri_invoke as _tauri_invoke`（保留别名以减少改动）。
3. Refactor: 统一异常处理策略——若 terminal 工具依赖"返回字符串而非抛异常"的行为，则在 terminal.py 中包一层 try/except 将 RuntimeError 转为字符串。
4. Verify: `pytest tests/tools/test_terminal_tool.py tests/tools/test_database_tool.py -x` + `ruff check`。

**Commit**：`refactor(tools): 统一 _tauri_invoke 到 tauri_ipc 模块，消除重复实现`

---

## Phase 8 — 最终验证

### T8.1 全量测试与 lint

```bash
# Python
ruff check mona/ tests/
pytest tests/ -x

# Rust
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml

# 前端
cd webui && pnpm exec tsc --noEmit && pnpm lint && pnpm test
cd site && pnpm exec tsc --noEmit
```

### T8.2 手动冒烟测试

- 启动 gateway，确认工具列表中无 `ssh_exec`
- 运行 `mona onboard`，确认模型自动补全工作
- 启动桌面应用，确认邮件/笔记/终端/数据库模块正常
- 打开浏览器控制台，确认无 import 报错

### T8.3 Git 历史敏感信息扫描

```bash
# 扫描 git 历史中是否还有明文凭据
git log --all -p -- 'tmp_deploy_*.py' '_tmp_*.py' 'deploy_auth.py' 'start_gateway_stt.py' | grep -E "Alt34484|sk-ijxtqvlwlsdhyp"
```

若仍有命中，评估是否需要 `git filter-repo --replace-text` 重写历史（注意：会改变所有 commit 哈希，需团队协调）。**推荐替代方案**：旋转 VPS 密码和 API Key。

---

## 执行顺序建议

1. **Phase 1**（安全）— 立即执行，独立提交
2. **Phase 2**（功能性死代码）— 逐项 TDD，每项独立提交
   - T2.3 已撤销（draw.io 非死代码）
   - T2.5/T2.6/T2.7 决策已定，按文档执行
3. **Phase 3 + Phase 4 + Phase 5**（可直接删除的死代码）— 可并行推进，按语言分组提交
4. **Phase 6**（根目录清理）— 独立推进
   - T6.5 决策已定：ESP32 迁移到 hardware/esp32/
5. **Phase 7**（代码重复）— 可选，低优先级
6. **Phase 8**（最终验证）— 所有清理完成后统一执行

每个 TDD 循环必须独立提交，commit message 遵循 conventional commits 规范，便于后续 review 和回滚。

### 决策汇总

| 任务 | 决策 | 理由 |
|------|------|------|
| T2.3 draw.io 占位符 | **撤销，保留原样** | 非死代码，是运行时 fallback 体系，flowchart_runtime.py 实现完整下载机制 |
| T2.5 browser/get_page_source | **删除命令** | 前端零调用方，stub 始终返回空字符串 |
| T2.6 SSH 连接池 | **删除死代码** | 从未接入，启用需 1-2 天重构，无性能瓶颈反馈 |
| T2.7 DB 枚举变体 | **保留+显式标注** | 删除会破坏前端选项和 connections.json 兼容性，风险收益比不划算 |
| T3.9 imap_pool keepalive/status | **撤销，保留原样** | 有生产调用：status() 在 server.py:2690，keepalive 在 server.py:4639 |
| T6.5 ESP32 资源 | **移到 hardware/esp32/** | 与 Mona 零交叉引用，保留历史但清理根目录 |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 删除"死代码"后发现实际被动态调用（反射/字符串拼接） | TDD Red 阶段全局 grep 必须包含字符串拼接形式（如 `t(\`app.\${x}\`)`） |
| Rust 删除 pub fn 后外部 crate 依赖断裂 | 本项目为 application crate，无外部消费者，风险低 |
| 前端删除组件后动态路由失效 | `tsc --noEmit` 会捕获静态 import 错误；动态 `lazy(() => import(...))` 需手动验证路由 |
| git 历史中明文凭据 | 旋转凭据为根因方案；filter-repo 为可选方案 |
