# Mona 1.8.0 开发模块实施记录

- 日期：2026-09-23
- 目标基线：`docs/design/mona-1.8.0-development-module.md`
- 分支：`feature/1.8.0-development`
- 分支起点：`c5b8e8fae43bc9637cb0e0d566158add9b6595b6`（创建时 master 工作树干净）
- 当前状态：开发中，已实现并验证首批后端基础与精简 Coding 装配；**不是 1.8.0 发布完成记录**。

## 1. 本次实际实现

| 范围 | 源码 | 当前行为 |
|---|---|---|
| 开发契约 | `mona/development/contracts.py` | 项目、产品会话、执行轮次、原生绑定、输入状态、事件与单/双/四屏视图分开建模；未知原生能力默认 false。 |
| 元数据持久化 | `mona/development/store.py` | SQLite 短事务、CAS、请求幂等、单会话轮次顺序、输入派发边界、绑定停泊与恢复、事件分页。聊天正文继续由现有 SessionManager 保存。 |
| 同项目并行 | 同上 | 各执行者可以在同一项目创建多个会话并同时运行；没有项目级执行锁，不创建或强制 worktree。 |
| 视图独立 | 同上 | 保存 1/2/4 个 pane 的绑定不创建、不取消、不重放 Run。这里只实现状态契约，尚未实现分屏 UI。 |
| 重启状态核对基础 | 同上 | 显式调用恢复核对时，将未确认的执行和派发标记为 unknown；不会根据旧状态自动重跑写入。原生重连仍需后续 Adapter 和运行服务接入。 |
| 项目上下文 | `mona/development/context.py` | 读取项目 AGENTS.md，按需发现 .agents/skills；记录内容指纹；限制读取大小并检查路径范围。未自动合并供应商专用规则。 |
| 内置 Coding 装配 | `mona/development/coding.py` | 复用 AgentRunner，使用固定开发提示词及真实文件/命令工具；不实例化普通 Mona 的 ContextBuilder、MemoryStore 或全局 SkillsLoader。 |
| 只读装配 | 同上 | 只读模式只注册读取/目录工具，没有写入和命令工具，不仅靠提示词约束。 |
| 工具会话隔离 | 同上 | 文件工具绑定实际项目；每个 CodingTools 实例持有自己的 FileStates 和 ExecSessionManager，避免轮次和会话间共享长命令目标。 |
| 外部执行器契约 | `mona/development/executors/base.py` | 原生 Agent 与 Provider 分开；定义创建、恢复、发送、中断、状态和能力回执。这里是协议边界，不是三个已实现的 Adapter。 |
| 本地程序发现 | `mona/development/executors/discovery.py` | 只读检查显式路径/PATH；检测到程序不等于通过协议、认证和隔离检查；不自动安装或登录。 |
| 显式配置 | `mona/config/schema.py` | 新增 DevelopmentConfig：模型预设、三个程序路径、项目规则/Skill 读取边界。没有用户记忆、MCP、Hooks 开启开关。 |

默认工具是 `read_file / write_file / edit_file / list_dir / exec`，加上长命令继续操作所需的 `write_stdin / list_exec_sessions`。没有邮件、Office、股票、画像和私有记忆工具。外部执行者不能通过 `build_coding_run_spec` 被悄悄降级为 Mona 的模型调用。

## 2. 验证记录

### 2.1 自动化测试

初次基础状态测试：33 项通过。

补齐项目上下文和 Coding 工具装配后：57 项通过，1 项跳过。跳过项是当前 Windows 测试账户不能创建 symlink；不计作路径逃逸测试通过。

扩大到开发专项、配置读取/迁移、Runner 持久化、会话保存及长命令测试后：151 项通过，1 项跳过，2 项失败。

两项失败为既有 `tests/config/test_config_migration.py` 对已移除的 `context_window_tokens/contextWindowTokens == 65536` 的断言。使用分支起点的原始 `mona/config/schema.py`，在独立测试进程中复现相同两处失败。本次没有为了消除它们而恢复过时配置或修改旧测试。扩大回归不能标记为全量通过。

最终新增专项复跑：`python -X utf8 -m pytest tests/development -q`，63 项通过、1 项跳过，15.82 秒。跳过仍是 Windows symlink 权限限制。

`ruff check mona/development tests/development scripts/verify_development_coding.py mona/config/schema.py` 已通过。

### 2.2 真实模型验收

脚本：`scripts/verify_development_coding.py`。

脚本只在项目 `output/` 下建立一次性测试项目，读取实际模型配置但不改配置、不启动或重启 Mona 服务。执行路径为生产 AgentRunner + 开发装配 + 真实文件和 Exec 工具，而不是预先播放文件操作。

验证任务：

1. 修复 Python 金额合计函数，读取项目规则与测试 Skill，运行单元测试。
2. 在两轮之间人工向文件增加注释、从磁盘恢复产品会话，再要求只增加 docstring；确认保留代码行为和人工修改。
3. 宿主独立运行三个单元测试，并核对测试文件、规则和 Skill 未被改动。

- `output/development-1.8.0/coding-acceptance-01/`：验收脚本初始化遇到 Config 的导入顺序/前向引用错误；没有调用模型。脚本已按现有 loader 的做法先解析前向引用，不修改生产配置。
- `output/development-1.8.0/coding-acceptance-02/`：`qwen3.7-plus` 实际完成两轮并通过独立测试，保留两处人工注释。报告中的 Skill 读取判定为 false；核对 trace 后确认是验收脚本重复 JSON 编码 Windows 路径导致误判，实际第一轮已读取该 Skill。旧报告保留，不覆写为通过。
- 判定已改成：解码实际调用参数、匹配真实路径、核对同一 tool_call_id 的成功返回中确有 Skill 内容。新增六个证据解析回归场景。
- `output/development-1.8.0/coding-acceptance-03/`：修正后的最终脚本重跑通过；实际模型 `qwen3.7-plus`，耗时 86.2 秒，9 项检查全部为 true。包括两轮完成、独立三项测试通过、规则/Skill/测试未修改、两条人工注释保留、docstring 已添加、同一产品会话、Skill 实际成功读取、无业务工具。报告、trace、会话历史、工作文件和独立验证输出均保留在该目录。

以上不替代原生 CLI 验收，也不代表 UI、长任务自动压缩、全部恢复场景或整个 1.8.0 已通过。

## 3. CLI 环境与未完成范围

当前 Runner 的 PATH 与配置中未检测到 Codex、Claude Code、CodeBuddy 可执行程序；检查到的 Codex Web GPT 目录不作为官方 Codex CLI 已安装证据。也未发现对应 Claude/CodeBuddy Python SDK。

这只是当前执行环境的发现结果，不能推断整台机器绝对没有安装。没有修改用户登录、用户 CLI 配置或自动下载运行时。

| 正式设计阶段 | 当前状态 / 下一依赖 |
|---|---|
| D0 业务与协议 | 已实现核心数据和执行回执；协作记录、完整消息路由与生产恢复调度仍需整合。 |
| D1 三家 CLI 真实风险验证 | 已完成无副作用程序发现；需要可用官方程序、受支持版本和用户授权认证后，验证原生线程、取消、项目资源隔离。 |
| D2 工作台 | 导航、三栏、左右栏两态、单/双/四屏 UI 与 Gateway API 尚未接入。视图数据契约已可用。 |
| D3 Mona Coding | 精简装配与实际多轮执行已接通原 Runner；生产运行管理、流式 UI、自动压缩和完整侧边只读聊天仍待整合。 |
| D4 三家 Adapter | 尚未实现真实原生协议适配；不以模型 API 或假执行器充当接入完成。 |
| D5 协作与交接 | 原生绑定可停泊和恢复记录；尚未完成实际跨 CLI handoff、协作派发与回传。 |
| D6/D7 面板、压力与发布 | 尚未进行 UI/打包/完整发布验收。 |

下一实施重点是 Gateway 开发会话运行服务与工作台骨架，同时继续完成 CLI 真实接口验证；禁止用临时全局 active-session 单例将多个分屏串到一起。

## 4. 当前边界

没有改动用户现有文稿，没有重启 dev，没有推送 GitHub，没有升级产品版本号或发布安装包。

本批次是正式交付设计下的首个可验证代码增量，不把基础测试、模拟模型单测或简单 Python 样例称为最终交付。正式设计中的 70 项验收条件保持不变。
