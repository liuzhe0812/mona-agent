# 线上工作台：复用桌面普通会话

用户确认范围（2026-11-03）：本轮只开发与本地验证，不上线、不连接 Ubuntu。不接云同步。账号数据在 Ubuntu 隔离；会话区和右栏直接使用桌面同一份 ThreadShell、ThreadComposer、ArtifactSidebar、OfficeEditorHost、ConversationCanvasPanel，禁止复制或另写相似 UI。

## 实施边界

- 共享 UI 保持原结构；hosted bootstrap 显式安装 HTTP、WebSocket、画布文件与事件适配。isTauri 保持真实 false。
- 同源兼容 API base：`/api/work/desktop`，原桌面接口追加在该 base 后；不代理整套 Gateway/Services。
- POST `/socket-ticket`，短期单用票据绑定网站会话和账号；WS `/ws?ticket=...`，账号 JWT 不进入 URL。每帧重新校验撤销。
- POST `/platform/invoke`：`{command,args}`；仅受控文件与画布命令，结果直接返回。画布沿用原 WorkspaceCanvasDocument，版本以服务器 SHA 校验；同画布保存串行。
- 账号根：`state/users/<owner-hash>`；documents 为 `/workspace` 的 UI 文件映射；gVisor 仍保存不透明 workspace.zip，不挂宿主目录。Office Manager/cache/ticket/checkpoint 按账号和会话隔离，复用原 Office API，表格 sidecar 只能在专属 gVisor 中运行。
- Office 静态资源 `/work/office-editor/{docs,sheets,slides}/...`。其内容是同一编辑器构建；不放用户文档或凭据。
- 保留原 Work API、已有会话和用户数据。兼容会话历史使用现有 transcript replay，不从摘要编造原文，不恢复旧运行态。
- 不修改余额、支付、设备或云同步。

## 实现结果

- WorkApp 挂真实 MonaClient / ClientProvider / ThreadShell，左列复用 ChatList 和共享弹窗。空账号先创建真实空会话，不调用模型；账号切换清除 socket、预览、Office 内存镜像和临时状态。
- desktop_store / desktop_api / desktop_wire 连接原历史 replay 与真实任务状态，覆盖稳定 ID、分页、准入、停止、重连、附件、交付和已保存 Office 的恢复。恢复不会增加“处理完成”等聊天记录。
- TenantFiles 使用账号根和原画布格式，原子写入、串行保存、SHA256 冲突保护；Windows 账号目录联接越权也有实际回归。
- TenantOffice 复用原 API、Manager 和编辑器。默认桌面 API 保留，hosted 才注入逐帧授权与虚拟路径投影。浏览器导出下载当前 checkpoint；Word 文件实际解包核对编辑文字。
- SandboxedXlsxEngineFactory 复用原 sidecar 协议，以 gVisor 包裹并复制经过统一 bundle 校验的 Linux binary。没有本机执行回退；本轮未连接 Ubuntu 验证运行时。
- 模型 Canvas/Office 工具复用原实现，通过受限传输连接上述服务。两个画布编辑器的原请求/回执协议在真实浏览器通过，超时和重复请求不自动重放修改。
- 工作区普通文件改名/删除保持列表、交付索引与真实文件一致；旧 gVisor 文件通过原快照生命周期操作，不在宿主解压。删除必须校验用户已读摘要，未知回包持久阻止后续写入。

## 验证与未完成事项

- [x] 共享会话协议与权限、文件操作、编辑器适配的本地契约测试。
- [x] Word 实际输入、保存、下载解包核对文字、刷新恢复；思维导图实际修改、自动保存和恢复；思维导图/流程图原编辑协议与重复请求拒绝。
- [x] 浏览器第二账号看不到首个账号的会话/编辑器，越权 HTTP 404；退出后编辑器和临时镜像清理。认证为明确的本地测试依赖，没有冒充生产登录或真实模型调用。
- [x] 桌面会话客户端、Office、两个画布编辑器必要回归，TypeScript、Ruff，以及完整 hosted/Office 入口构建。
- [ ] Ubuntu 上新版端到端：真实账号/模型、Linux 运行时资源、gVisor 表格处理、Excel/PPT 保存与导出、断线和重启恢复。当前生产仍是之前已验收的基本 Qwen Work。
- [ ] 部署：用户本轮明确要求不执行；没有 SSH、生产权限变更、服务重启或 Docker 操作。云同步也未接入。

本地真实浏览器记录：`output/hosted-work/shared-ui-local-c0288589/acceptance.json`，截图和实际导出的 Word 在同目录。`model_executed=false`、`deployed=false`、两个画布协议通过，脚本异常与非预期失败请求均为空。退出时在途请求返回 401 是正常撤销，验证不把它当作 UI 故障，同时确认没有错误弹窗。

最终本地检查：后端 **205 passed / 7 skipped**，其中 2 项为显式 Linux/gVisor 验收、4 项为本机无符号链接权限、1 项为单独执行的浏览器验收；浏览器显式验收 **1 passed**。前端相关 13 个文件 **155 passed**，完整 TypeScript 与 Ruff 通过。`npm run build:hosted` 完整构建通过，包含 Word/Excel/PPT 三个同源入口；产物来自本地工作树，不是已审核的生产部署包。

复跑：先在 webui 执行 `npm run build:hosted`；然后设置 `MONA_HOSTED_UI_SMOKE=1`，执行 `python -m pytest tests/hosted_work/test_shared_ui_browser.py -q -s`。需要已安装的 Playwright 与本机浏览器，不下载或安装运行环境。普通后端回归为 `python -m pytest tests/hosted_work -q -rs`。

主工作树含其他任务大量未提交改动。不得 reset/stash 或全量提交；api.ts 原有视频改动与本任务平台 hunk 分开处理。其修改前副本位于 `.codex_tmp/shared-work-dev-baselines/api.ts`。本轮没有服务器变更。
