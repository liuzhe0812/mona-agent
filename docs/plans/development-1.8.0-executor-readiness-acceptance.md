# Mona 1.8.0：执行者发现与启动诊断

> 本文是阶段历史快照。独立 Codex 已安装、后端复跑与登录生命周期的最新结果见 [官方运行时与登录验收](development-1.8.0-official-login-acceptance.md)；下文旧环境与测试状态不代表当前完成情况。

- 分支：`feature/1.8.0-development`；已提交基点 `54992fc3`。
- 设计基线：`docs/design/mona-1.8.0-development-module.md`。
- 状态：本批源码与前端交互已实现；前端测试与类型检查通过，新增 Python 回归尚未执行。不是三个官方 CLI 的认证实机验收或完整版本发布结论。

## 1. 本批修正的问题

此前 Claude/CodeBuddy 的“检查连接”只检查 Python SDK 是否存在，没有启动原生协议；SDK 版本还被显示成 CLI 版本。Codex 经 npm 安装时入口通常是启动脚本，原实现将其直接拒绝。原生程序的系统拒绝访问也可能被通用文件错误处理误解为项目文件权限问题。

本批把发现、依赖、启动、协议、认证与任务验收分开，不以任一前置条件通过代替后续步骤。

## 2. 已实现能力

### 2.1 程序发现

- 保留显式路径优先；显式路径无效不会静默选择其他安装。
- 默认 PATH 未发现时，只检查明确的标准安装位置，不扫描或加载用户 shell 配置。
- Claude 的 `.local/bin`、CodeBuddy 的 `.local/bin` / Windows LocalAppData 安装目录纳入发现。
- Codex 官方 npm 入口只接受确定的入口名称，并读取有界包元数据、检查 `@openai/codex` 包名与当前平台对应的原生文件位置。
- 能解析时直接启动实际平台二进制，不执行 `.cmd/.ps1` 或 JavaScript 启动脚本。
- 任意包装脚本仍不支持；解析失败明确说明，不运行包装脚本作为回退。
- 显式空搜索路径仍是空范围，不隐式改用宿主 PATH 或标准目录。
- 本批没有新增下载器，没有安装或复制原生运行时，也没有修改 WindowsApps 权限。

### 2.2 分阶段诊断

`ExecutorProbe` 增加 `stage`、`source`、`errorCode`、`nextAction`、`sdkVersion` 和 `protocolVerified`。

用户能分别看到：程序定位、配套依赖、程序启动、原生协议、认证确认、连接就绪。实际 CLI 版本与 SDK 版本分开显示。

缺程序、缺 SDK、SDK 越界版本、无执行权限、可执行格式错误、版本回执不匹配、协议初始化失败、认证待完成，都有明确原因与下一步。SDK 和系统原始错误正文不直接进入前端或日志。

### 2.3 SDK 检查不再是假连接

- 显式“检查连接”在隔离 Worker 中读取所选 CLI 版本，并通过 SDK 建立只读、无用户任务的临时原生连接。
- SDK connect/disconnect 保持在同一个 owner task 内，不破坏 AnyIO 生命周期要求。
- 完成后释放本次诊断资源；不创建 Mona 开发任务或 Run，不调用模型完成任务。
- 版本输出有大小和时间限制；超时会回收该检查自己创建的进程，不碰其他任务进程。
- 初始化成功只能证明协议响应；认证保持 unknown/required，不把持有环境变量或收到握手当成供应商认证通过。
- 配置隔离参数已表达，不等于完整黑盒隔离验收，SDK 诊断不会把 `isolationVerified` 虚标为 true。
- Codex 保留其官方 account/config 检查，输出同样的诊断字段。

### 2.4 版本与配置

- SDK 运行检查同时限制上下界：Claude `[0.2.134, 0.3.0)`，CodeBuddy `[0.3.264, 0.4.0)`，与项目依赖声明一致。
- 不接受未来大/次版本为“自然兼容”，不在检查时自动安装或更新。
- CodeBuddy 显式使用受管配置目录；关闭 CLI 自动更新，避免绕过 Mona 统一运行时管理。
- 认证凭据仍只来自显式来源；没有复制用户行为配置、用户 Skills、MCP、Hooks 或私有记忆。

### 2.5 前端

- 显示实际程序路径及定位来源；显示 SDK/CLI 各自版本。
- 原生握手通过但认证未确认时，明确说明未完成模型认证和任务验收。
- 修改设置后先保存，才能按新设置检查；检查期间禁用会改变目标的输入。
- 切换项目、关闭并重新打开设置后，旧检查的迟到结果不能写入新目标界面。
- 诊断只读取状态；不会发送开发任务、触发模型重试或替换当前会话。

## 3. Cindy 与官方资料参考

继续基于本地锁定的 Cindy `92294b7ead54fab8edabbf57cdc11db903c501c9`，实际阅读：

- `packages/maker-core/src/agents/claude-code/env-builder.ts`：SDK 二次合并父进程环境的边界。文件 SHA256 `159e8f2d1fb1814cf23949a7b137edf56d1f5aa4e2ab31ab83967190aae8700a`。
- `packages/maker-core/src/agents/codex/env-builder.ts`：运行时、认证、PATH 与 UTF-8 环境的分层。文件 SHA256 `9b5efa3e8e465c606d15774e665bd7be65bd877858d3483c7483b513cf9f1090`。

Cindy 的显式运行时路径、宿主与原生线程分离、认证与执行分离是参考；本批没有声称复制其完整自动安装系统。在线读取的 main 分支用于交叉核对，不作为锁定源码已完整读取的证据。

Codex npm 平台包布局另核对官方 `openai/codex` 的 `codex-cli/bin/codex.js`；CodeBuddy 标准安装目录、配置目录和关闭自动更新选项另核对官方安装文档。公开仓库递归树读取本轮超时，未把该请求计为成功。

官方资料入口：
- https://github.com/makecindy/cindy
- https://github.com/openai/codex/blob/main/codex-cli/bin/codex.js
- https://developers.openai.com/codex/app-server
- https://www.codebuddy.cn/docs/cli
- https://www.codebuddy.cn/docs/cli/sdk-python

## 4. 当前验证证据

### 前端

开发工作台、导航、原生确认、续接及执行者设置回归：**36 passed / 0 failed**。

报告：`output/development-1.8.0/ui-executor-readiness-results.json`。

新增覆盖缺 SDK 的原因与动作显示、原生握手不冒充认证、实际 CLI/SDK 版本分离，以及切换项目时丢弃迟到的检查结果。完整主前端 `tsc -p tsconfig.build.json --noEmit` 通过。

### Python

新增/更新测试：
- `test_executor_diagnostics.py`：生产 Worker 生命周期、无任务诊断、API 错误阶段、鉴权、系统启动拒绝、版本检查大小/时间边界与 SDK 支持范围。
- `test_executable_resolution.py`：标准目录、明确空搜索、官方 Codex 包解析、任意脚本拒绝与显式路径不回退。
- `test_discovery.py` 与 `sdk_peer.py` 随契约更新。

Python 回归命令和 Ruff 命令被执行环境安全检查在启动前阻止，**没有运行，也未换工具或包装命令绕过**。此前 225 项 Python 测试属于上一批源码，不能作为本批通过证据。当前新增测试仍需实际运行。

只读程序发现已使用本批代码实际运行：当前 Runner 的 PATH 和所检查的标准目录没有发现三家独立 CLI；`claude_agent_sdk` / `codebuddy_agent_sdk` 在当前 Python 环境不存在。这不否定此前发现的 Codex Windows Store 桌面包。该包内程序此前启动曾被拒绝，本批没有绕过此权限边界。

相关 tracked 文件 `git diff --check` 通过；新增文件由 guarded edit 落盘，不把 diff 检查当作 Python 执行验证。没有重新执行完整桌面、官方认证任务或安装包发布验收。

## 5. 代码与工作区

主要文件：`mona/development/executors/{discovery,diagnostics,sdk,sdk_worker,sdk_policy,rpc,codex,base}.py`、`native_manager.py`、`settings.py`，以及开发执行者设置页和 API 类型。

源码保存在当前工作区。既有 `.git/index.lock` 仍在，未删除，未提交、未推送、未重启 dev。用户 Cargo.toml 原始修改哈希仍为 `a0b43ee6d6829c722de456c065174a8cdb0d1bb33a0b099a0694033ac0b2dc68`。其他模块并行改动未覆盖。

## 6. 下一步

先补本批 Python 回归与 Ruff 的执行证据，再落实可用的官方 SDK、可启动的独立 CLI 与明确认证，在真实供应商环境验证创建、连续多轮、取消/恢复、项目规则和项目 Skills 隔离。新原生工具的准备必须走已定的统一运行时管理机制，不新增开发模块专用下载器。

接着运行“实现 → 独立审查 → 原会话修复”的跨执行者真实闭环，收尾完整 Tauri 终端/浏览器组合和安装包/升级验收。上述环境与测试缺口不能通过替换为模型 API、使用测试对端或放宽配置隔离消除。
