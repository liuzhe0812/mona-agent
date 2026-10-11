# Mona 1.8.0 开发工作台：前后端闭环记录

> 本文件保留首次工作台增量的历史记录。后续原生执行者工作台接入、协作、确认与长会话整理的最新状态见 [原生执行者联调验收](development-1.8.0-native-integration-acceptance.md)，下文“CLI 尚未接通”不再代表当前代码状态。

- 分支：`feature/1.8.0-development`
- 本轮起点：`54992fc3`
- 正式基线：`docs/design/mona-1.8.0-development-module.md`
- 状态：工作台与内置 Coding 闭环已接通；不是整个 1.8.0 发布验收完成。
- 保留任务开始前的 `src-tauri/Cargo.toml` 用户修改，未重启用户 dev、未推送、未发布安装包。

## 已落实的使用路径

导航“开发” → 打开本地项目 → 创建任务 → Mona Coding 实际执行 → 查看代码与运行结果 → 人工修改 → 原会话继续开发。

1. `AppRail` / `Sidebar.MODULE_DEFS` / `App` 均注册开发入口。模块首次打开后保持挂载，主聊天不会同时显示。旧导航配置通过既有合并逻辑获得新模块。
2. 三栏工作台，中央单屏、双屏、四屏；左侧打开任务仅替换焦点分屏，右侧跟随焦点会话。草稿、文件编辑缓冲区、原生终端和任务身份不依赖分屏槽位。
3. 任务搜索、重命名、置顶、归档，以及主执行者能力说明。Mona Coding 可以实际发送；三个 CLI 明确标记工作台未接通，不将模型接口当作原生 CLI。
4. 右侧复用 `ArtifactSidebar` 的概览、标签、最大化与收起能力，提供文件、审查、执行日志、手动终端、浏览器和侧边聊天。
5. 文件面板真实读取和编辑 UTF-8 文本；保存使用当前 SHA 校验和原子替换，冲突保留草稿。切换文件或会话不会把迟到结果写进其他编辑器。
6. Git 状态和差异按工作区事实展示，不将同项目全部修改归因于当前 Agent。非 Git 项目仍能开发；目录树按层分页，不递归扫描整个仓库。
7. 侧边聊天独立持久化、默认只读工具装配，不自动写文件或运行命令；“加入主会话”只加入用户输入草稿。
8. 手动终端复用现有 Tauri shell 和 Xterm；与 Agent 执行日志区分。浏览器复用 App 的唯一 `useBrowserTabs` 和现有 BrowserTabView，不新增 MCP 或第二套浏览器状态源。

## 后端契约与执行

`mona/development/api.py` 注册在 Gateway，而非 Services。Tauri HTTP 桥为精确 `/api/development` 子树附加本地服务令牌，Vite 代理把该子树路由至 Gateway，不能落入普通聊天 WebSocket 服务。

- `/api/development/projects`：项目列举和打开。
- `/api/development/projects/{id}/sessions`：持续任务列举和创建。
- `/api/development/sessions/{id}/snapshot`：分页消息、事件游标、运行和流式输出快照。
- `/api/development/sessions/{id}/send`：稳定 requestId 发送；未知结果保留同一标识，禁止自动重试新任务。
- `/api/development/sessions/{id}/runs/{runId}/interrupt`：按会话与实际运行绑定中断。
- `/api/development/sessions/{id}/inputs/{inputId}`：撤回尚未派发的后续消息。
- 项目文件、目录、Git、差异和规则索引路由均进行 resolved-path 与参数校验。

`DevelopmentRuntime` 复用生产 AgentRunner、Provider、文件工具和命令工具，保存工具检查点与正常 SessionManager 历史。运行中追加消息先进入可见的后续队列，当前任务正常结束后继续；不是冒充底层已实时接受 steering。消息与工作视图解耦，不因离开模块或收起面板停止任务。

同一项目不同会话可以并行。每个会话只保护自身轮次顺序，不增加项目级单写入锁或强制工作树。

应用退出时保留历史与检查点；无法确认的运行标记 unknown，不自动重放写入请求。当前 unknown 恢复 UI、长期自动语义压缩和所有外部执行者恢复仍需后续实现，不能把基础恢复保护当作完整生命周期验收。

## 本轮验证证据

### 前端

- `store.test.ts`、`DevelopmentView.test.tsx`、`AppRail.test.tsx`：最终 21 项通过。收尾增加“关闭终端视图不结束进程”的回归，只有明确的“结束终端”操作才停止手动终端。
- 覆盖：真实导航回调、三栏和四屏、焦点绑定、输入草稿、稳定请求重试、文件冲突保留、隐藏模块不取消、外部 CLI 不假装可用。
- React 测试仍有异步 `act` 提示与既有清理日志；没有将它们隐藏或算作浏览器运行错误。
- TypeScript 构建类型检查通过；之后只修改了关闭终端视图的处理并补上测试，该修改后的 21 项前端回归通过。
- 主前端生产构建：`node node_modules/vite/bin/vite.js build` 通过，65 秒；产物包含独立 `DevelopmentView` 分包。保留已有动态/静态导入与大包体积提示；没有改变依赖或批量重构分包。本轮没有重建无修改的 Office 编辑器，也未声称正式安装包已通过。
- Tauri 本地令牌桥定向编译/测试：`cargo test --manifest-path src-tauri/Cargo.toml --locked --offline --lib local_http_auth_tests::office_http_uses_services_token_but_socket_uses_ticket -- --exact` 通过；实际运行 1 项、过滤 237 项，编译耗时 3 分 16 秒。保留原有编译警告，未改用户 Cargo.toml，也未启动桌面 dev。这不是完整桌面 UI 验收。
- 最后一处终端视图关闭修正后，重复进行 TypeScript + 主前端构建的工具请求被安全检查阻止，未执行。此前通过的构建与该修正后的前端回归分别保留，不宣称最终全量构建/回归已全部完成。

### Python

新增工作台运行服务/API 测试曾完成 9 项通过，包含真实文件工具、后续消息派发、相同项目多会话、只读装配、请求防重、认证和编辑冲突。

最后扩大运行开发专项及既有 Runner/会话回归的请求被执行环境安全检查拦截，未启动，不能计为最终全量通过。新增 Git 子项目路径和无 HEAD 暂存差异用例已写入，但本轮未获得运行结果。

最终 `ruff check mona/development tests/development scripts/verify_development_workbench.py` 通过。

### 真实页面 + 当前配置模型

脚本：`scripts/verify_development_workbench.py`；测试宿主：`webui/scripts/development-smoke-server.mjs`。

测试使用真实 React 开发工作台、浏览器、带令牌的本地 HTTP、生产 Coding runtime/工具和当前配置 `qwen3.7-plus`。仅在 `output/` 创建一次性项目；没有预先给 Agent 播放文件修改，没有修改用户源码项目或认证配置。

- `output/development-1.8.0/workbench-live-01/`：全部功能检查完成，但冷启动 Vite 在首次加载 Markdown 依赖时重新优化并刷新，出现动态 import 错误，报告保留为失败。测试宿主改为提前扫描/加载真实 Markdown 依赖，没有忽略 pageerror。
- `output/development-1.8.0/workbench-live-02/`：通过，耗时 106.36 秒，10 项检查为 true，浏览器未捕获异常列表为空。

第二次实测完成：

1. UI 打开项目、创建任务。
2. 模型读取项目 Skill、修复金额计算并运行测试。
3. 用户通过右侧文件编辑器加入人工注释并保存。
4. 同一会话继续添加 docstring，保留两条人工注释、测试文件、规则和 Skill。
5. 宿主独立运行三个单元测试通过。
6. UI 创建并显示四条独立会话，切换双屏和文件面板，没有重复执行任务。

该目录保留 `report.json`、真实工作文件、会话记录、独立测试输出，以及 `01-completed-chat.png`、`02-four-panes.png`、`03-file-and-split.png`。

## 未计为完成的部分

- Codex/Claude Code/CodeBuddy 工作台生产接入与三个官方原生二进制的真实验收；现有 Codex 协议适配仍是独立基础。
- 完整跨执行者协作、切换、接力与权限确认界面。
- Tauri 原生浏览器、手动终端在完整桌面中的逐项手动验证。本轮真实页面测试是独立浏览器宿主，不伪称桌面原生面板已测。
- 全部长历史、自动压缩、大仓库压力、unknown 运行恢复和正式安装包发布矩阵。
- 全部 70 项交付验收。本轮结果不能替代整个 1.8.0 发布准入。

## 使用说明

代码已包含导航和页面，重新运行完整 dev 会加载新的 Gateway 路由及 Rust 本地令牌路径。仅刷新旧页面不能替代旧后端和桌面桥的更新。用户原有项目、Office 会话和 CLI 登录状态没有被本轮测试修改。

## Git 收尾状态

本轮尝试仅暂存工作台相关文件时，Git 返回现有 `.git/index.lock`，未能暂存或提交。只读检查发现该锁为 0 字节，检查时已存在约 62 分钟；未自行删除锁，也未结束其他 Git 进程。本轮源码、测试和文档留在工作区，HEAD 仍为 `54992fc3`。

已再次核对任务开始前的 `src-tauri/Cargo.toml` 字节摘要保持不变。由于仓库忽略部分 `tests/`、`scripts/`、`docs/` 路径，后续提交应显式包含本轮新增测试、验收脚本和本记录，不包含 `output/` 下的测试项目、截图、运行数据或缓存。
