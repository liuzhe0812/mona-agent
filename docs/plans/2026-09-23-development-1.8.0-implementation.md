# Mona 1.8.0 开发模块实施记录

- 日期：2026-09-23
- 目标基线：`docs/design/mona-1.8.0-development-module.md`
- 分支：`feature/1.8.0-development`
- 分支起点：`c5b8e8fae43bc9637cb0e0d566158add9b6595b6`（创建时 master 工作树干净）
- 当前状态：开发中，已实现并验证首批后端基础与精简 Coding 装配；**不是 1.8.0 发布完成记录**。
- 后续进展：工作台导航、三栏与内置 Coding 的真实前后端闭环已经接通，最新证据见 `docs/plans/development-1.8.0-workbench-acceptance.md`。下文第 1–4 节保留首批实施时的历史状态。

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

## 5. 后续工作台增量

在 `54992fc3` 基础上新增开发导航、三栏界面、单/双/四屏、项目与任务管理、真实 Coding 运行服务及受保护 Gateway API。右栏复用既有 Agent 侧栏，接入项目文件与差异、执行记录、独立只读侧边聊天，以及 Tauri 终端/浏览器组件。三个原生 CLI 尚未接到工作台，能力列表明确禁用，不用模型调用冒充。

真实浏览器通过界面完成创建任务、修改代码、手动编辑、原会话续做和四屏切换；`workbench-live-02` 的 `qwen3.7-plus` 测试 10 项检查全部通过，106.36 秒。测试范围不包含完整 Tauri 原生面板或正式安装包。详细验证、未完成项和运行方式见最新工作台验收记录。

## 6. 原生执行者与连续开发增量

原生执行者已接到开发工作台的 Gateway 调度链路，包含 Codex App Server、Claude/CodeBuddy 隔离 SDK Worker、问题与权限确认、主执行者切换、协作派发/回传和原会话续编。内置 Coding 增加当前会话的语义整理，不引入普通 Mona 长期记忆。当前源码自动化为 Python 210 项通过、1 项跳过，前端 25 项通过；这些不等于三个官方 CLI 实机认证验收。

最新实现、Cindy 源码参考、证据范围、环境限制与发布缺口统一记录于 [原生执行者联调验收](development-1.8.0-native-integration-acceptance.md)。此前各阶段进度保留为历史快照，不作为当前完成状态。

## 7. 原生会话续接与恢复边界

已补齐 Codex 精确缺失历史的自动续接，以及三种执行者在空闲状态由用户明确触发的重新连接。原产品会话、文件和旧绑定保留；新绑定、模型选择、full 交接与续接事件原子保存。超时、认证/配置错误和未知轮次不会被当成历史缺失。界面提供真实确认与能力边界，不以重建冒充原轮次结果核对。

本轮 Python 开发及相关回归 225 项通过、1 项跳过，前端 33 项通过，TypeScript 检查通过。Ruff 与 Vite 构建请求在执行前被安全检查拦截；三个官方 CLI 认证实机验收仍未完成。详情及下一步计划见 [会话续接验收](development-1.8.0-session-continuity-acceptance.md)。

## 8. 执行者发现与启动诊断

补齐标准安装目录发现、官方 Codex npm 平台二进制解析、SDK 上下界检查及真正的只读原生握手诊断。UI 区分程序定位、依赖、启动、协议和认证，CLI/SDK 版本分开展示，切换项目丢弃旧诊断结果。没有自动安装、继承用户配置或发送模型任务。

本批前端 36 项通过，主前端 TypeScript 检查通过；Python 回归与 Ruff 被执行环境在启动前阻止，未计为通过。只读实查仍未找到三家独立 CLI，两个配套 SDK 未安装。详见 [执行者启动诊断验收](development-1.8.0-executor-readiness-acceptance.md)；历史测试数字不替代本批后端验证。

## 9. 官方运行时核对与登录生命周期

中断前已安装到统一运行时仓库的独立 Codex 0.156.1 本轮重新核实可启动，生产协议与配置检查通过，准确返回需要认证；不再将“未找到独立 Codex”作为当前状态。新增原生登录状态查询、早到/迟到回执处理、跨项目复用待登录流程、确切取消及前端观察。登录不进入代码任务历史，不自动发起开发。

最终 Python 开发及相关回归 265 项通过、1 项跳过；Ruff、TypeScript、主前端 Vite 生产构建通过。当前官方 Codex 无任务连接检查七项通过，1.02 秒。本批 Vitest 与两份配套 SDK 下载请求在启动前被安全检查阻止，未计为完成；真实账户开发任务仍未验收。

最新证据和发布缺口见 [官方运行时与登录验收](development-1.8.0-official-login-acceptance.md)，操作步骤见 [执行者连接指南](../guides/development-executors.md)。

## 10. 优先收敛供应商设置与统一模型选择器

按用户重新确认的优先级，固定来源为 Mona AI、OpenAI、Anthropic，其他来源以用户供应商独立呈现。本机 Codex / Claude 检测归入对应来源；普通对话与开发复用统一选择器，不再围绕独立 CLI 设置表单扩展主页面。

本轮来源/开发 UI 回归 56 项通过，后端来源相关 5 项通过，生产组件真实浏览器 9 项检查通过，Ruff 与主前端生产构建通过。独立 TypeScript 检查被执行环境在启动前阻止；Anthropic 订阅授权和三家官方真实账户开发验收未完成。详见 [模型来源验收](development-1.8.0-model-sources-acceptance.md)，原始设计已新增最新来源优先决策。

## 11. 单主会话工作台与真实子智能体

最新业务决策改为项目/会话树、单主会话和概览优先工作栏，取消全部多屏入口；不修改全局导航与其他任务负责的原生连接。现有配置、运行与回传完成真实页面验收，本轮进一步完善工具结果配对、真实活动流、稳定历史渲染、阅读时不抢滚动、子智能体草稿与修订冲突保护。

最终开发模块/导航回归 65 项通过，相关后端 18 项通过；TypeScript、Ruff 与 Vite 生产构建通过。当前配置 qwen3.7-plus 的真实页面与文件任务 19 项检查通过，110.95 秒，包括子智能体实际只读执行和回传。记录与明确剩余项见 [单主会话工作台验收](development-1.8.0-single-workspace-acceptance.md)。本轮未重启 dev、未提交或推送，未删除既有 Git 锁。

## 12. 按确认原型继续对齐

开发主会话改为真实消息/工具时间线，变更胶囊和 Git 浮层进入主区域；右侧使用开发专用概览首标签、按需工作标签及统一子智能体区域。快照观察由实际变化唤醒，保留本地鉴权；差异审查携带完整选定版本并在派发前复核，不再只是填入问答草稿。

当前前端回归 83 项通过，开发后端 239 项通过、1 项跳过；最终 TypeScript 与 Vite 构建通过。全部实现、真实模型验收和明确剩余项见 [原型对齐验收](development-1.8.0-prototype-alignment-acceptance.md)。用户要求暂不提交，本批不修改 Git 暂存，不改 App、导航及原生连接认证代码。
