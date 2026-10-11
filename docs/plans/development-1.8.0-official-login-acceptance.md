# Mona 1.8.0：官方运行时与登录生命周期验收

> 2026-10-08 边界更新：Mona 只管理本机已有 CLI，不再下载、打包或保存程序副本。下方 CLI 组件安装及 SDK 来源清单是历史验收记录，相关安装代码已移除；当前规则见 `docs/architecture/runtime-component-management.md` 和 `docs/guides/development-executors.md`。

- 分支：`feature/1.8.0-development`；已提交基点：`54992fc3`。
- 正式设计：`docs/design/mona-1.8.0-development-module.md`。
- 状态：独立官方 Codex 的当前生产适配器连接检查通过；原生登录生命周期前后端已接通。三个供应商的授权账户开发任务、完整桌面和发布矩阵尚未全部验收。
- 使用指南：`docs/guides/development-executors.md`。

## 1. 修正中断前后进度

本轮检查发现，前次中断前已经完成了统一运行时仓库中的 Codex 组件安装及一次官方程序连接检查，但没有完成最终汇报。因此，旧记录中的“尚未找到独立 Codex”只代表当时状态，不是当前事实。

现有受管组件为 `codex-cli@0.156.1+win32.x64`，由 `RuntimeComponentStore` 及现有可复现构建/安装链路管理。它是独立的官方平台二进制，不是复制 Windows Store 应用文件或绕过访问权限。

工作台的环境准备复用 `mona/development/resources.py`、`mona/runtime/executors.py`、全局运行时任务和 `DevelopmentRuntimeResources`。这些代码在本轮开始前已位于工作区；本文件不把它们全部重新算为本轮新增。

本轮重新使用当前生产代码验证，官方 Codex 可以启动、回答协议和配置请求、返回需要认证，并正确回收宿主进程。正式运行时目录未由本轮发布到远端，不能据此承诺所有客户端已能下载。

## 2. 本轮新增和修正

### 2.1 原生登录有实际生命周期

新增轻量 `NativeLogin` 状态，区分 starting、waiting、cancelling、succeeded、cancelled、failed、unknown。登录是执行者账户操作，不进入代码项目聊天、模型上下文或交接摘要。

- Codex 使用官方 `account/login/start`、`account/login/completed`、`account/login/cancel` 和 `account/read`。
- CodeBuddy 使用官方 SDK 认证流程，经隔离 Worker 处理完成、失败和取消；连接与释放仍在同一 owner task。
- Claude 保持显式 API Key 来源，不增加个人订阅模拟登录。
- URL 只在等待登录时返回；完成、失败、取消或失去连接后不继续显示旧链接。
- 原生错误正文不直接向用户回显，不写认证凭据、Cookie 或令牌。

### 2.2 重复、迟到和多项目

执行者受管凭据目录跨项目共享，因此登录 owner 按执行者管理。两个项目窗口同时点击登录，会关联同一正在进行的登录，不启动相互覆盖的两个流程。

产品登录标识与原生登录标识分离。取消必须携带当前确切产品登录标识，旧请求不能取消新登录。Codex 的完成通知可能早于 start 回执，按原生 ID 缓冲匹配；其他 ID、错误类型及迟到终态不污染当前流程。

发送结果未知时，先读取现有状态，不自动重新登录。关闭设置页或切换项目不取消后台认证，也不停止开发任务。原回调连接实际结束后可以重新检查账户；不能把旧流程未确认等同于账户认证失败或成功。

### 2.3 查询、取消与界面

新增受本地服务令牌保护的接口：

- `GET /api/development/projects/{project_id}/executors/{executor}/login`
- `DELETE /api/development/projects/{project_id}/executors/{executor}/login/{login_id}`

GET 只观察现有 owner，不启动原生 Agent，不创建开发会话或 Run。DELETE 只取消匹配的认证流程，不 logout、不 interrupt 开发轮次。

新 `DevelopmentLogin` 组件恢复当前登录状态，等待时观察原生结果，提供刷新和明确取消。系统浏览器打开官方链接，不要求用户在 Mona 聊天中提供凭据。代际检查防止切换项目或设置后，旧异步结果覆盖新界面。登录成功后只更新连接信息，不发送开发请求。

`CodexExecutor.probe` 每次重新读取实际账户状态，不继续依赖初始化时的旧缓存。API 的已知错误使用固定、可执行的说明，不把“需要登录”全部压成笼统的协议异常；结果未知仍不自动重跑。

### 2.4 环境和回归前提

新增 `runtime-library/sources-coding-sdks.json`，固定 Claude SDK 0.2.134 与 CodeBuddy SDK 0.3.264 的 Windows x64 wheel 官方来源、大小和 SHA256。只表示构建输入已经核对，不表示已下载或安装。

现有两项测试默认“开发机器未安装 CLI”。Codex 进入受管仓库后，这个假设失效。测试改为在程序发现依赖边界显式指定不存在的路径，继续验证无原生程序时不调用 Mona 模型作为替代，不修改生产能力或减弱断言。

## 3. 当前验证证据

### 3.1 后端与已有执行链路

最终命令：

`python -X utf8 -m pytest tests/development tests/agent/test_runner_persistence.py tests/agent/test_session_atomic.py tests/tools/test_exec_session_tools.py -q --tb=short`

结果：**265 passed、1 skipped、5 warnings，144.63 秒**。警告为既有 aiohttp AppKey 提示。跳过项未计为通过。

此前一次扩大回归在 CodeBuddy 测试依赖的跨进程信号上出现竞态：新文件已出现但正文尚未写完。已将测试信号改为先写临时文件再原子替换，保留严格成功/失败断言；最终全组复跑通过。

`test_native_login.py` 验证：原生早到回执、匹配 ID、多个项目共享待登录状态、未知结果不重发、取消与开发任务分离、错误/非官方 URL 拒绝、认证状态重读、SDK owner 回收及 HTTP 鉴权。

这些测试使用生产 Adapter、Worker、真实子进程管道和持久化，供应商响应由测试对端或 SDK 依赖替身提供。**不是三个供应商账户的真实登录或开发验收。**

最终 Ruff：`mona/development`、`mona/runtime/executors.py`、`tests/development`、运行时准备脚本和新官方连接验证脚本全部通过。

### 3.2 官方 Codex 当前代码实测

脚本：`scripts/verify_development_codex_connection.py`。

报告：`output/development-1.8.0/codex-official-probe-02/report.json`。

结果：**通过，1.02 秒，实际 CLI 版本 0.156.1**。七项检查均为 true：

1. 官方原生协议两次响应；
2. 当前项目配置检查通过；
3. 如实返回未认证，没有伪造认证成功；
4. 没有开始登录；
5. 没有创建原生线程；
6. 隔离测试项目未变化；
7. 检查结束后所属 App Server 主进程已退出。

本次使用新的隔离 native home，不复制用户已有 CLI 登录与配置，不调用模型、不发送开发任务。`isolationVerified` 在此表示适配器的有效配置校验通过，不代表所有 Skills、Hooks 和真实任务黑盒场景均已验收。

### 3.3 前端与构建

- 当前主前端 TypeScript：`tsc -p tsconfig.build.json --noEmit` 通过。
- 当前主前端 Vite 生产构建：通过，1 分 18 秒。生成 `DevelopmentView` 分包；保留已有动态/静态混合导入和大 chunk 警告，未顺带做全站分包重构。
- 新增 `DevelopmentLogin.test.tsx` 五项交互测试，并更新原设置面板测试。
- **本轮 Vitest 请求在进程启动前被执行环境安全检查阻止，没有执行。**没有改用其他工具或命令包装绕过，不将旧前端通过数量当成新登录 UI 已通过。
- TypeScript 和构建通过不是实际登录 UI 点击、系统浏览器回调或完整桌面验收的替代。

### 3.4 依赖准备限制

两份 SDK wheel 已从官方 PyPI 发行元数据核对大小和摘要。但通过现有共享下载脚本发起的下载请求在启动前被安全检查阻止，当前环境仍未安装 `claude_agent_sdk` 和 `codebuddy_agent_sdk`，两份 wheel 也未落盘。

没有使用 pip、另一个下载器或复制运行时来绕过被阻止操作。没有拿源码或元数据存在来替代 SDK 可运行证明。

## 4. Cindy 与官方接口参考

继续锁定 Cindy 提交 `92294b7ead54fab8edabbf57cdc11db903c501c9`。本轮检查：

- `scripts/ensure-agent-binaries.mjs`：原生完整目录和必要文件验证；
- `tools/claude/update.mjs`：固定版本官方发布清单、大小与 SHA 校验；
- `apps/desktop/src/main/maker-ipc/sessionAgentSwitchHandler.ts`：产品会话、原生绑定、交接和真实提交边界。

Mona 复用自己的统一运行时仓库，不照搬 Cindy 的独立缓存或用户配置加载方式。登录协议字段和取消语义以供应商官方接口为准，不宣称 Cindy 的任意行为都适用于 Mona。

官方接口：
- https://developers.openai.com/codex/app-server
- https://www.codebuddy.cn/docs/cli/sdk-python
- https://github.com/makecindy/cindy

## 5. 尚未完成的交付项

- 用户在 Mona 受管环境中完成官方 Codex 登录后的真实持续开发、测试、取消与恢复。
- Claude Code、CodeBuddy 的可用官方 SDK/CLI 与授权账户任务；项目规则/Skills 黑盒隔离。
- 跨执行者“实现 → 审查 → 原会话修复”的真实供应商闭环。
- 本批前端交互测试，完整 Tauri 浏览器/终端/多会话重启及安装包升级验收。
- 正式 1.8.0 剩余发布准入，不以本批连接或合约通过宣布整个版本完成。

## 6. 工作区和下一步

代码在当前开发分支工作区。未重启用户 dev、未登录或退出用户账户、未推送或发布。现有 `.git/index.lock` 仍在；没有删除锁，也没有把其他任务的并行修改加入本次提交。

下一步先完成当前可用 Codex 的用户官方认证并运行真实多轮开发验收，同时补齐 SDK 安装与原生兼容验证。在执行环境允许时运行新增前端交互回归，然后推进跨执行者协作和最终桌面/安装包验收。用户只需在官方页面完成认证，不向聊天提供凭据。
