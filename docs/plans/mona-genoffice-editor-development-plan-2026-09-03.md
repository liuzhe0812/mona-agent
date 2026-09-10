# Mona GenOffice 编辑器开发计划

> 状态：Windows 三格式基础集成已有验收；Docs 已挂载 GenOffice 完整编辑器界面；自然语言实时创作待实施，D2 平台发布门禁中
> 文档版本：1.8
> 制定日期：2026-09-03
> 功能设计：[`../design/mona-genoffice-editor-functional-design-2026-09-02.md`](../design/mona-genoffice-editor-functional-design-2026-09-02.md) v1.6
> 上游基线：GenOffice `v0.8.667`，导入时记录完整 commit

> 2026-09-05 范围修正：本文 D0/D1/D2 的完成记录仅证明对应基础集成和当时样本结果，不代表“普通自然语言新建后右侧立即打开、生成过程中持续显示内容”已经完成。该体验由 [Office 实时创作开发计划](mona-office-live-authoring-development-plan-2026-09-05.md) 接管；新的分批创作和异步保存语义以该计划为准，其任务当前均待实施。

> 2026-09-05 Docs 界面补充：Docs 入口已直接挂载 GenOffice Docs App 的完整中文功能区（文件、开始、插入、绘图、设计、布局、引用、审阅、视图），不再使用四按钮简易编辑器。AI 文档模块仍保持现有 PPT、视频入口，不纳入 Office 编辑器范围。

> 2026-09-05 Sheets/Slides 集成补充：Sheets 入口已直接嵌入 GenOffice Sheets App/ExcelShell，使用完整中文 7 个页签（开始、插入、页面布局、公式、数据、审阅、视图），不再使用 Mona 自建的三页签 Univer UI。Slides 入口增加 `slide_apply_txn`，Mona Agent 可调用 GenOffice 操作注册表；已用 `addTable`、`setTransition(fade)`、`setNotes` 和 checkpoint 重开完成回归。该回归只证明上述事务入口和操作，不代表所有 PPT 高级功能均已完成。

> 2026-09-05 宿主边界：不接入 GenOffice 云 AI、字体下载/安装、多屏演讲者视图和系统缩略图；原生打印/PDF 依赖宿主的文件选择、写入和打印能力，当前不在 Office Editor 中宣称已接通。以上能力不计入本计划已完成项，AI 仍由 Mona Agent 驱动，字体仅使用系统字体并允许 fallback。

## 1. 交付目标

在 Mona 会话右侧集成 GenOffice Docs、Sheets、Slides 编辑器，实现：

- 新建、导入和编辑 `.docx`、`.xlsx`、`.pptx`。
- Agent 读取文档局部状态并提交结构化操作。
- 用户实时看到 Agent 修改，并可继续手动编辑。
- 用户与 Agent 操作同一编辑会话，过期操作不覆盖新内容。
- 保存、另存为和原生格式导出，结果进入 Mona 产物列表。
- 三个编辑器直接进入安装包，共享公共依赖，只使用系统字体，不携带 Electron。

不在本计划中实现 PDF、云同步、多用户协作、宏、插件市场和跨格式转换。

## 2. 必须遵守的架构边界

### 2.1 进程所有权

| 模块 | 所有进程 | 职责 |
|---|---|---|
| `OfficeSessionManager` | Services | 会话、权限、Editor epoch、版本镜像、checkpoint、保存、导出、Office WebSocket |
| `office` Agent 工具 | Gateway | 解析 Agent 参数，通过受保护客户端调用 Services，不保存编辑器状态 |
| `OfficeServiceClient` | Gateway | 使用现有 Services 本地令牌完成跨进程请求 |
| `OfficeEditorHost` | WebUI | 侧边栏标签、iframe 生命周期、MessageChannel 和用户状态 |
| GenOffice Editor | iframe | 当前文档模型、事务提交、最终版本校验、序列化 |
| xlsx-sidecar | Services 子进程 | XLSX 读取、写入和 OOXML 保真处理 |

Office HTTP API 和 Office WebSocket 只注册在 Services，不在 Gateway 复制路由。WebUI 通过 `getServicesHttpBase()` 访问，不能拼接固定端口。

### 2.2 文档权威

- Manager 是会话和持久化权威。
- Editor 是当前文档模型与事务提交权威。
- Agent apply 先经 Manager 预检查，再由 Editor 对真实 `modelVersion` 做最终检查。
- 用户编辑、Undo、Redo、Agent apply 都产生新事务版本。
- checkpoint、正式保存和导出分别记录 `checkpointVersion`、`savedVersion`。

### 2.3 安全与资源

- `/api/office/*` 使用现有 Services 本地令牌保护。
- Tauri `local_http_request` 对 Office 路由自动注入令牌。
- Office WebSocket 使用受保护 HTTP API 签发的一次性短时 ticket。
- 路径使用 resolved-path containment 校验，只允许当前 workspace、上传目录和 Manager 自有会话目录。
- Office Blob 通过流式接口写入 staging，并设置明确上限；不提高整个 Services 应用的全局请求上限。
- 编辑器静态产物和 xlsx-sidecar 随应用内置，不进入可下载运行时仓库。
- 不把 Office 兼容字体或系统字体打包进安装包；缺失字体时提示 fallback。

## 3. 当前可复用基础

以下能力已经存在，本计划不重复建设：

- `webui/src/components/deliver/ArtifactSidebar.tsx`：右侧产物标签容器。
- `webui/src/components/deliver/FilePreviewPanel.tsx`：文件预览入口。
- `webui/src/components/office/OfficeFileEditor.tsx`：将授权文件内容打开为 Office 会话，复用已有会话并进入统一编辑器。
- `mona/agent/tools/office.py`：单一 `office` 工具，模型可见动作已为 `list/open/inspect/apply/save/export/close`；旧 OfficeCLI 分支不再作为当前创作入口。
- `mona/services/server.py` 与 `mona/office/api.py`：Office 会话、实时读写、保存与导出路由归属 Services。
- `webui/src/lib/api.ts`：已有 `getServicesHttpBase()`。
- `mona/materials/auth.py` 与 `src-tauri/src/lib.rs`：已有 Services 本地令牌及 Tauri HTTP Bridge 注入机制。
- `mona/agent/tools/path_utils.py`：现有 workspace 路径解析边界。

`DocMakerView` 保持现有 PPT、视频入口；已经隐藏的“文档”入口不属于 Office 侧边栏集成范围。

## 4. 执行方式与责任分配

### 主 Agent 负责

- 进程归属和跨进程协议。
- 版本、事务、checkpoint 和恢复语义。
- Agent DSL 与 inspect 契约。
- Services、Gateway、WebUI 三端集成。
- 安全边界、Go/No-Go 和最终验收。

### Luna 负责

只承接接口已冻结、文件边界清楚、成功标准明确的任务：

- 导入固定 GenOffice 源码快照、许可证与 NOTICE。
- 按已确定目录搭建多入口构建和 bundle 报告。
- 生成固定 Office 测试样本与数据驱动测试。
- 实现不涉及状态权威判断的 UI 状态组件。
- 按既定模式接入第二、第三个编辑器的机械部分。
- 执行构建、测试矩阵和容量报告。

Luna 修改代码时必须声明文件所有权，不与主 Agent 同时修改 `mona/services/server.py`、`mona/agent/tools/office.py`、`ThreadShell.tsx` 或共享协议文件。

## 5. 开发顺序

```text
R0 Mona WebUI 独立升级到 React 19
                       ↓
D0-01 契约冻结
   ├── D0-02 上游快照与许可         [Luna]
   ├── D0-03 多入口构建与容量报告   [Luna]
   └── D0-04 Services 会话核心      [主 Agent]
             ├── D0-05 API/WS/鉴权  [主 Agent]
             ├── D0-06 Sheets Bridge[主 Agent]
             └── D0-07 xlsx-sidecar [Luna]
                       ↓
                D0-08 Agent 工具     [主 Agent]
                       ↓
                D0-09 WebUI 集成     [主 Agent]
                       ↓
                D0-10 测试与 Go/No-Go[Luna + 主 Agent]

D0 通过
   ├── D1 Docs
   ├── D1 Slides
   └── D1 三格式统一交付

D1 通过
   └── D2 跨平台、恢复、兼容性与发布
```

### 5.1 工作量基线

| 交付级别 | 工程量估算 | 说明 |
|---|---:|---|
| D0 | 7–12 个工程日 | 只接通 Sheets，但同时完成三入口容量构建 |
| D1 | 8–12 个工程周 | 三格式基础编辑闭环，D0 后重新估算 |
| D2 | 4–7 个工程周 | macOS、恢复、兼容性和发布门禁 |

工程量不是日历承诺。Luna 只并行执行不在关键架构路径上的机械任务；D0 的实际结果决定 D1/D2 是否继续以及是否调整工作量。

### 5.2 当前实施进度（2026-09-05）

| 任务 | 状态 | 当前证据 |
|---|---|---|
| D0-01 | 已完成 | Python/TypeScript 共用 JSON fixture，冻结 version、session、inspect、apply、checkpoint 和 WS 事件 |
| D0-02 | 已完成 | GenOffice `v0.8.667` / `583a045212f871943afb8ca4503fcb5ddf99a23f` 固定快照、LICENSE、NOTICE 和 SHA 清单 |
| D0-03 | 已完成 | Docs、Sheets、Slides 三入口和共享 chunk 已建立；生产输出会先清理专属目录，避免旧内容哈希文件进入安装包 |
| D0-04 | 已完成 | Services 会话、epoch、单调版本、幂等、串行命令、原子 checkpoint、保存冲突与恢复单测 |
| D0-05 | 已完成 | Services 独占 HTTP/WS、一次性 ticket、token、双端 owner 校验、分块 checkpoint 和 Tauri token 注入测试通过 |
| D0-06 | 已完成 | Sheets 直接嵌入 GenOffice Sheets App/ExcelShell 完整中文 7 页签和 Univer 网格；使用 embedded controller 接入现有 runtime，sidecar、最终版本校验、结构操作、原子回滚和 GenOffice OOXML planner checkpoint 已验证 |
| D0-07 | 已完成 Windows | 静态 CRT x64 sidecar 8,546,304 bytes，132 个上游 Rust 测试通过，manifest 与 Tauri resource 已登记 |
| D0-08 | 已完成 | 现有 `office` 工具增加会话化 action 和 Services client，旧 OfficeCLI action 保留 |
| D0-09 | 已完成 | 结构化 UI 事件打开 Office 标签，收起侧边栏保持 iframe 挂载，中文工具栏、状态和恢复提示已接入 |
| D0-10 | Go | 真实 WebView2 中完成 Agent/用户交替编辑、约 5.8 ms 命令可见、冲突拒绝、checkpoint 恢复、导出和 Excel 重开；自动化与安装资源门禁通过 |

Windows D1 已完成：Docs、Sheets、Slides 均支持新建/导入、Agent 结构化 inspect/apply、用户继续编辑、版本冲突拒绝、checkpoint、保存和原生导出。Docs 与 Slides 已在真实 WebView2 中完成 Agent/用户交替编辑，并分别由 Word、PowerPoint 重开导出文件。

当前可复现容量为：三入口静态产物 13,569,288 bytes（逐文件 gzip 合计 3,614,426 bytes）；加 Windows sidecar、manifest、三个原生空白模板和许可证后共 22,252,272 bytes（逐文件 gzip 合计 6,776,048 bytes）。这里的 gzip 合计是 Office 安装包增量的可比基线；最终 NSIS 总包还包含 Mona 既有 449 MB 冻结 Gateway，不能用总包大小反推 Office 增量。

Docs 最新定向回归（2026-09-05）已通过：`set_block_style` 的常用格式（加粗、对齐、标题级别、下划线、颜色、字号、段后间距）、`set_table_cell` 与二维 `rows` inspect、GenOffice 完整界面手动编辑，以及 DOCX checkpoint 重开后的内容和格式保留。

当前 Windows release NSIS 为 191,628,805 bytes（182.75 MiB），SHA-256 `024412bb040d004efd306fc97bf357219982b888ab948bcc2034fe73a2d61b83`。该本机构建未使用发布证书，Authenticode 状态为 `NotSigned`，只能作为开发验收包，不能替代正式签名发布。

后续入口统一修改已移除旧只读预览依赖及补丁，普通文件点击和资料库原文统一使用 Office 编辑器；新增受保护的二进制导入接口，以已有文件读取权限取得内容，再创建或复用同一所有者的编辑副本。以上安装包哈希对应入口统一之前的验收包，后续发布需重新冻结后端并打包前端。

### 5.3 D0 Go/No-Go 记录（2026-09-05）

| # | 验收项 | 结论 | 证据或缺口 |
|---:|---|---|---|
| 1 | 无 Electron 打开、编辑、checkpoint、保存、导出 | 通过 | WebView2 真实流程与生产 bundle 审计通过；无 Electron 运行时 |
| 2 | Agent apply 后 500ms 内可见 | 通过 | 真实 MessagePort/Editor 命令往返约 5.8 ms |
| 3 | 用户编辑后 inspect 可见，冲突可恢复 | 通过 | 真实用户键盘输入推进 revision；Agent 可读取变更，旧 revision 被拒绝且不覆盖 |
| 4 | 1000 次通知滞后竞态全部拒绝旧操作 | 通过 | Sheets entry 在 revision 已推进、Manager 仍持旧版本时连续拒绝 1000 个旧命令；Manager 镜像滞后测试同时通过 |
| 5 | 第 N 项失败时原子回滚且版本不变 | 通过 | 通过 Sheets entry 的 `office_command` 入口验证前三项中第 3 项失败后前两项恢复，revision 保持不变 |
| 6 | checkpoint 崩溃恢复、iframe reconnect、拒绝旧 epoch | 通过 | iframe 强制重建约 667 ms，使用新 epoch 从 checkpoint 恢复；旧 epoch/旧 revision 被拒绝 |
| 7 | Agent 只接触 Mona Office Schema | 通过 | Python/TypeScript 共用 contract fixture，Agent 工具和 Services client 不返回内部结构 |
| 8 | GenOffice 核心 Engine 零修改且 patch 可审计 | 通过 | 固定上游 commit、SHA 清单和独立 Mona 适配目录；vendor Engine 未修改 |
| 9 | OOXML、Excel/WPS 和未修改 entry 保真 | Windows Office 通过；WPS 待外部验证 | 固定样本和真实导出通过 Word/Excel/PowerPoint；本机未安装 WPS，不虚构结果 |
| 10 | 单份公共依赖、三编辑器容量、正式包目标 | 通过 | React/GenOffice UI/format 为共享 chunk，无字体、Electron、PDF/OCR、测试或示例资产；Office 压缩增量约 6.78 MB |

### 5.4 D1/D2 当前裁决（2026-09-05）

| 任务 | 状态 | 当前证据或限制 |
|---|---|---|
| D1-01 通用契约 | 已完成 | 三格式共用 session、MessageChannel、version、inspect、apply、checkpoint；`changed_since` 和 `RESYNC_REQUIRED` 已测试 |
| D1-02 Docs | 已完成（基础闭环及完整界面） | `docx-engine` + TipTap；直接挂载 GenOffice Docs App 完整中文功能区；稳定 block ID、outline/search/blocks、基础结构操作、Undo/Redo、checkpoint；真实 Word 往返通过 |
| D1-03 Slides | 已完成（核心高级事务入口） | `pptx-engine`/`pptx-render`；UI 适配已接通组合、批量对齐、连接线、渐变/图片填充、完整轮廓、表格、图表、SmartArt、链接、主题、版式、母版、分节、切换、动画、备注、批注和浏览器内复制；增加 `slide_apply_txn` 供 Mona Agent 调用同一 GenOffice 注册表，`addTable`、`setTransition`、`setNotes` 的 checkpoint 重开回归通过；宿主能力边界见上文 |
| D1-04 保存/导出/产物 | 已完成 | 三格式共用保存与导出；Agent 导出发布 `ArtifactRef`；失败不关闭会话，路径只能位于活动 workspace |
| D1-05 用户界面 | 已完成 | 主会话右侧栏支持新建/导入 Word、Excel、PPT；统一标签、保存、导出、最大化、关闭和中文状态；不恢复 AI 文档的“文档”入口 |
| D1-06 回归 | Windows Office 通过 | 当前 Office Editor 18 项测试通过，相关后端本轮 79 项测试通过；WPS 样本因本机未安装 WPS 待外部执行 |
| D2-01 macOS | 代码准备完成，平台产物待验 | 已提供 arm64/x64 原生 sidecar 构建脚本和平台/架构清单校验；Windows 不能生成、签名或运行 macOS 二进制/安装包 |
| D2-02 恢复与升级 | 已完成 Windows 范围 | 异常退出从最近 checkpoint 恢复并提示未持久修改；损坏 metadata、缺失 checkpoint、source hash 冲突和关闭会话不恢复均有测试；Gateway 升级改为先原子轮换旧目录、后台清理，避免同步删除 18,000 余文件阻塞启动 |
| D2-03 性能矩阵 | Windows 基线完成 | 100 页 DOCX、20 万单元格 XLSX、100 页 PPTX 已测并由 Microsoft Office 重开；详见性能报告 |
| D2-04 安全与许可 | 已完成 Windows 范围 | HTTP/WS/ticket/owner/path/Blob 边界、平台清单、冻结 Gateway、bundle 禁入项和 331 条运行时许可证索引已验证 |
| D2-05 发布门禁 | Windows 开发验收包完成；安装/签名/macOS/WPS 待外部门禁 | Windows release NSIS 已使用当前冻结 Gateway 与内置 Office 资源构建，NSIS 清单 10/10 收录关键资源，部署后冻结 Services 和原生 PPT 模板通过；未在本机覆盖现有安装执行安装/卸载，正式签名、macOS 和 WPS 兼容也尚未签收 |

性能证据见 [`mona-genoffice-editor-performance-report-2026-09-05.md`](mona-genoffice-editor-performance-report-2026-09-05.md)。未取得的平台结果保持“待外部验证”，不阻塞当前 Windows 桌面功能开发完成，但阻塞把整个 D2 标记为全平台发布完成。

Rust 定向回归 `office_http_uses_services_token_but_socket_uses_ticket` 与 `rotates_gateway_directory_without_deleting_its_contents_first` 均通过。Tauri 全量 153 项中 151 项通过；失败的 2 项是浏览器模块对当前实现文本的存量源码断言（下载 owner 与标签初始化脚本），与 Office 改动无关，本计划不越界修改浏览器模块。

## 6. R0：Mona WebUI 独立升级到 React 19

目标：在 GenOffice 代码进入主仓库前，先让现有 Mona WebUI 独立使用 React 19并通过回归，避免把框架迁移问题混入 D0 Office 调试。

实施状态（2026-09-03）：依赖升级、React 19 类型适配、npm 依赖树校验和生产构建已完成。全量单测仍有并行运行时的偶发超时和工作区断言波动，但失败文件逐个复跑全部通过，未发现稳定的 React 19 回归。UI 规则检查仍有存量问题，人工烟雾验证在进入 D0 前完成。

任务：

- 将 `react`、`react-dom`、`@types/react`、`@types/react-dom` 升级到同一 React 19 系列。
- 保留当前 Vite、React plugin 和测试框架版本，除非测试证明必须升级，不捆绑无关依赖更新。
- 修复 React 19 类型变化和实际运行不兼容，不借机重构现有组件。
- 运行 WebUI 单测、UI 规则检查和生产构建。
- 对首页、主会话、ArtifactSidebar、笔记、PPT、数据库、终端和设置做最小烟雾验证。

完成条件：

- `npm ls react react-dom` 只有 React 19，无 invalid peer dependency。
- TypeScript 和生产构建通过。
- 现有前端测试没有因升级新增失败。
- Office 方案统一规定 Mona WebUI 与 GenOffice 编辑器使用 React 19。

## 7. D0：Sheets 架构验证

目标：在完全不启动 Electron 的条件下，跑通 XLSX、Agent、用户编辑、版本冲突、checkpoint、导出和安装包构建。

### D0-01 冻结最小跨端契约｜主 Agent

新增：

```text
mona/office/
├── __init__.py
├── schemas.py
└── errors.py

webui/src/components/office/
└── types.ts
```

内容：

- `DocumentVersion { editorEpoch, modelRevision }`。
- Office session、command、result、checkpoint 和错误码。
- D0 inspect：`summary`、`range`；冲突直接返回当前版本和最近修改目标。
- D0 apply：`set_cell`、`set_range`、`set_formula`、`clear_range`、基础样式。
- 稳定错误码：`SESSION_NOT_FOUND`、`EDITOR_UNAVAILABLE`、`VERSION_CONFLICT`、`INVALID_OPERATION`、`CHECKPOINT_FAILED`、`SAVE_CONFLICT`。`RESYNC_REQUIRED` 随 D1 的 `changed_since` 引入。

完成条件：

- Python 和 TypeScript 样例通过同一组 JSON contract fixtures。
- 契约不暴露 Univer、GenOffice AST 或 Electron IPC 类型。
- D0 后除修复缺陷外不改变字段语义。

### D0-02 导入 GenOffice 固定快照｜Luna

责任目录：

```text
webui/office-editor/vendor/genoffice/
webui/office-editor/UPSTREAM.md
webui/office-editor/LICENSE
webui/office-editor/NOTICE
```

任务：

- 从 `v0.8.667` 记录完整 commit、来源和导入日期。
- 保留 Docs、Sheets、Slides 及其必要 `packages/*` 源码结构。
- 排除 `ee/`、PDF、Markdown、Shell、Genspark AI、遥测、自动更新和品牌资源的构建入口。
- 保留 Apache-2.0、NOTICE 和第三方许可证，不使用 GenOffice/Genspark 商标。
- 生成源码清单，不改动 Engine 实现。

完成条件：源码来源可追踪、许可证完整、`git diff` 能区分上游快照与 Mona adapter。

### D0-03 建立独立多入口构建｜Luna

责任目录：

```text
webui/office-editor/
├── package.json
├── package-lock.json
├── vite.config.ts
├── entries/
├── mona/
└── scripts/report-bundle-size.mjs
```

任务：

- Docs、Sheets、Slides 作为三个 HTML 入口独立运行。
- React 19、GenOffice UI、i18n、HarfBuzz 和公共格式库输出为共享内容哈希 chunk。
- 编辑器与 Mona 主界面使用同一 React 19 版本；iframe 仅隔离 CSS、DOM、全局状态和生命周期。
- 生产构建不包含 source map、字体、Electron、Node runtime、PDF/OCR、示例和测试资产。
- 输出每个入口、共享 chunk 和总压缩增量报告。
- 最终产物写入 `webui/dist/office-editor/`，不在源码目录提交生成文件。

完成条件：三个入口能加载，依赖报告确认公共库只有一份，首次容量报告可复现。

### D0-04 实现 Services 会话核心｜主 Agent

新增：

```text
mona/office/session.py
mona/office/manager.py
mona/office/sidecar.py
tests/office/test_session_manager.py
```

任务：

- Services 创建和持有唯一 `OfficeSessionManager`。
- 会话目录位于 Mona 用户数据目录，不进入 workspace 或可下载运行时目录。
- 管理 source hash、working file、Editor epoch、lastKnown/checkpoint/saved version、dirty 和连接状态。
- Manager 只做版本预检查，Editor 返回提交后的权威版本。
- 同 epoch 版本镜像只前进；旧 epoch、重复和乱序消息被拒绝或忽略。
- `operationId` 幂等；同一 session 的 Agent command 串行。
- checkpoint 使用 staging、大小上限、SHA-256、fsync 和原子替换。
- iframe 重建时由仍在运行的 Manager 签发新 epoch，并从最近 checkpoint 恢复；Services 或应用完整重启恢复放到 D2。

完成条件：单元测试覆盖版本竞态、原子回滚、幂等、checkpoint 和恢复。

### D0-05 实现 Services API、Office WebSocket 和鉴权｜主 Agent

修改：

```text
mona/office/api.py
mona/services/server.py
mona/materials/auth.py
src-tauri/src/lib.rs
tests/services/test_office_api.py
src-tauri/src/lib.rs 内现有命令测试模块
```

任务：

- 只在 Services 注册 Office session、file、socket-ticket、checkpoint、save、export、close。
- `/api/office/*` 进入现有 Services token 保护范围。
- Tauri HTTP Bridge 为 `/api/office/*` 注入 `X-Mona-Token`。
- socket ticket 一次使用、短时有效、绑定 session 和 Editor epoch。
- 未认证 WebSocket 在收到任何会话内容前关闭。
- checkpoint Blob 流式写入，使用 Office 路由自己的大小限制，不提高全局 `client_max_size`。
- Services health capabilities 增加 `office-editor-v1`。

完成条件：HTTP、WebSocket、Tauri 调用端和服务端契约均有测试；Gateway 不注册重复路由。

### D0-06 适配 GenOffice Sheets｜主 Agent

责任目录：

```text
webui/office-editor/mona/
webui/office-editor/entries/sheets/
webui/office-editor/vendor/genoffice/apps/sheets/  # 仅必要薄 patch
```

任务：

- `MonaOfficeBridge` 实现 GenOffice Sheets 原 preload interface 的必要子集。
- 启动时接收 session、epoch、工作文件和 MessagePort。
- Editor 本地事务维护 `modelRevision`。
- apply 前检查 `expectedVersion`，整组 operation 失败全部回滚。
- 用户编辑、Undo、Redo 生成新 revision 和 changed targets。
- 实现 summary、range inspect；冲突结果返回当前版本和最近修改目标。
- 将指定不可变版本序列化为 XLSX checkpoint。
- 系统字体缺失时使用 fallback，不加载字体包。

完成条件：独立 harness 中能打开、修改、Undo/Redo、checkpoint 和重新加载 XLSX。

### D0-07 接入 xlsx-sidecar 与安装包｜Luna

在 D0-03 和 D0-06 接口冻结后执行。

责任文件：

```text
webui/office-editor/vendor/genoffice/apps/sheets/native/xlsx-engine/
webui/office-editor/scripts/build-xlsx-sidecar.*
src-tauri/tauri.conf.json
src-tauri/tauri.windows.release.conf.json
```

任务：

- 构建 Windows x64 sidecar，并生成版本、大小、SHA-256 和入口 manifest。
- 将 sidecar 作为 Tauri resource 内置。
- Services `sidecar.py` 只定位和验证内置资源，不创建下载器，也不进入 `mona.runtime`。
- 应用退出、命令超时和 session 关闭后回收 sidecar。
- 构建脚本不覆盖用户现有发布配置。

完成条件：开发和 release 构建均能定位同一版本 sidecar，停止后无残留进程。

### D0-08 接入 Gateway office 工具｜主 Agent

新增或修改：

```text
mona/office/client.py
mona/agent/tools/office.py
tests/agent/test_office_tool.py
```

任务：

- `OfficeServiceClient` 使用 Services base URL 和本地服务令牌。
- 现有单个 `office` 工具增加 `open`、`inspect`、`apply`、`save`、`export`、`close`。
- D0 只允许 Sheets 操作子集。
- 旧 OfficeCLI action 保留兼容；活动编辑会话禁止使用 OfficeCLI 写入同一文件。
- 原 D0 实现：apply 在 Editor commit 和 checkpoint 都成功后才向 Agent 返回成功。后续实时创作实施改为提交成功先返回、checkpoint 后台合并；save/export 强制等待目标版本，详见 [实时创作计划第 4.5 节](mona-office-live-authoring-development-plan-2026-09-05.md#45-提交成功保存与导出)。此调整当前待实施。
- 冲突时返回当前版本和最近修改目标，提示 Agent 重新 inspect 相关 range，不能自动覆盖。

完成条件：工具测试覆盖成功、冲突、Editor 不在线、Services 不可用、checkpoint 失败和取消。

### D0-09 接入 WebUI 右侧编辑器｜主 Agent

新增：

```text
webui/src/components/office/
├── OfficeEditorHost.tsx
├── OfficeEditorFrame.tsx
├── OfficeEditorToolbar.tsx
├── office-bridge.ts
└── office-session-store.ts

webui/src/lib/office-client.ts
```

修改：

```text
webui/src/components/deliver/ArtifactSidebar.tsx
webui/src/components/deliver/FilePreviewPanel.tsx
webui/src/components/thread/ThreadShell.tsx
webui/src/lib/types.ts
```

任务：

- 通过受保护 HTTP 获取 socket ticket，建立 Services Office WebSocket。
- iframe 只接受父窗口传入的 MessagePort，校验 session 和 epoch。
- 收到 `office_session_open` 后打开 Sheets 标签。
- 侧边栏收起时保持 iframe 挂载；切换会话时断开错误 owner。
- 工具栏只显示文件名、编辑状态、保存、导出、全屏和关闭。
- 使用共享 Button、Tooltip、`RightSidebarToggleIcon`、语义 Token 和专业密度。
- Docs 直接使用 GenOffice 自带的完整功能区和文件页签；Mona 不额外叠加第二套文件菜单。GenOffice AI 面板和桌面标题栏仍不带入 Mona。
- 无活动 Office session 时创建编辑会话；文件点击和资料库原文均使用同一 Office 编辑器，不保留独立只读回退。PDF 由桌面 WebView 预览。

完成条件：1440×900、1280×720、1024×720，浅色/深色和中文界面可用；键盘焦点、状态文本和最小宽度符合 UI 基线。

### D0-10 测试与 Go/No-Go｜Luna 执行机械测试，主 Agent裁决

Luna 负责：

- 固定 XLSX 样本和 contract fixtures。
- 1000 次用户事务/Agent apply 人工竞态自动测试。
- operation 第 N 项失败的原子回滚测试。
- iframe 重建、epoch 失效、WebSocket 重连和 operationId 去重测试。
- bundle 重复依赖和安装包容量报告。

主 Agent 负责：

- 审核测试覆盖真实生产端和调用端。
- 在 Excel/WPS 手工检查导出文件。
- 检查 GenOffice patch 清单和核心 Engine 零修改。
- 对照功能设计十项 D0 验收作 Go/No-Go 决定。

D0 任一以下问题未解决，不进入 D1：

- 必须启动 Electron。
- 发生静默覆盖或原子回滚失败。
- iframe 重建不能从最近 checkpoint reconnect。
- Agent 收到 GenOffice/Univer 内部结构。
- XLSX 无法在 Excel/WPS 正确打开。
- 三编辑器公共依赖被重复打包。
- 安装包容量无法解释或包含字体、Electron、PDF/OCR。

## 8. D1：三格式基础可用

目标：完成 Word、Excel、PowerPoint 的基础编辑闭环，并复用 GenOffice 已有的完整编辑器界面；未经过当前回归验证的高级功能不视为已完成。

### D1-01 固化通用 Editor Adapter｜主 Agent

- 将 D0 的 session、MessageChannel、version、inspect、apply 和 checkpoint 契约抽成三个编辑器共用接口。
- 只抽取已经被 Sheets 验证的逻辑，不预建插件系统或通用文档框架。
- 锁定 D1 Agent DSL 版本和兼容策略。

### D1-02 Docs 构建与宿主适配｜Luna 机械接入，主 Agent事务集成

Luna 责任目录：`webui/office-editor/entries/docs/` 和 Docs adapter 构建文件。

- 复用 GenOffice Docs renderer 和 `docx-engine`。
- 直接挂载 GenOffice Docs App 的完整中文功能区：文件、开始、插入、绘图、设计、布局、引用、审阅、视图；不以四按钮简易 UI 替代上游界面。
- 适配打开、系统字体、checkpoint 和导出入口。
- 不修改 `docx-engine` 核心写入逻辑。

主 Agent完成：

- block ID 稳定定位。
- summary、outline、search、blocks、changed_since inspect。
- 文本、标题、列表、基础表格、图片的结构化 apply。
- 用户事务、Undo/Redo 和 Agent apply 的版本一致性。

### D1-03 Slides 构建与宿主适配｜Luna 机械接入，主 Agent事务集成

Luna 责任目录：`webui/office-editor/entries/slides/` 和 Slides adapter 构建文件。

- 复用 GenOffice Slides renderer、`pptx-engine` 和 `pptx-render`。
- 适配打开、系统字体、HarfBuzz、checkpoint 和导出入口。
- 不修改 PPTX 核心读写逻辑。

主 Agent完成：

- summary、outline、search、slides、changed_since inspect。
- 文本、图片、基础形状、位置尺寸和页面管理 apply。
- 受限布局操作和越界、重叠、文本溢出检查。
- 用户事务、Undo/Redo 和 Agent apply 的版本一致性。

### D1-04 统一保存、导出和产物登记｜主 Agent

- 三种格式共用 source hash、checkpoint、save、export 和覆盖冲突流程。
- 导出成功后创建 `ArtifactRef` 并广播 `artifacts_changed`。
- 导出失败不生成文件卡，不关闭编辑会话。
- 旧 OfficeCLI 不写入活动会话文件。

### D1-05 完成用户界面｜Luna

在主 Agent 冻结 OfficeEditorHost props 和状态机后执行。

- 三种文件使用相同标签、状态、保存、导出、全屏和关闭行为。
- 不修改 `DocMakerView` 的产品入口；OfficeEditorHost 只接入主会话右侧栏。
- 缺失字体、格式不完全支持、保存冲突和恢复状态使用现有 Alert/Toast 规则。
- 用户可见文本使用中文，不出现 Editor epoch、WebSocket、sidecar 等内部名称。
- 增加浅色/深色、三种视口和键盘操作测试。

### D1-06 三格式回归与验收｜Luna 执行，主 Agent签收

每种格式至少准备：

- Mona 新建文件。
- Microsoft Office 新建文件。
- WPS 新建文件。

覆盖：

```text
新建 → Agent 编辑 → 用户编辑 → Agent 局部 inspect → 再次编辑 → checkpoint → 导出
导入 → 无修改导出
导入 → 用户与 Agent 交替编辑 → 保存为新文件
源文件外部变化 → 覆盖保存被拒绝
iframe 重建 → 恢复 session
```

D1 完成门槛：

- 三格式基础操作全部通过。
- Office/WPS 可以打开导出文件，核心内容、公式和布局正确。
- 用户与 Agent 无静默覆盖。
- 侧边栏状态与服务端 session 一致。
- 安装包内三个编辑器共用公共依赖，没有字体和 Electron。

## 9. D2：正式发布

目标：补齐跨平台、恢复、兼容性和发布质量，不扩大产品范围。

### D2-01 macOS 适配｜主 Agent + Luna

- Luna 构建和登记 macOS xlsx-sidecar、manifest 和安装包资源。
- 主 Agent 验证 Services 生命周期、路径、权限和系统字体 fallback。
- Windows/macOS 使用同一 Office Schema 和 Editor Adapter。

### D2-02 恢复与升级｜主 Agent

- 异常退出恢复最近 checkpoint。
- checkpoint 后未持久修改丢失时明确提示。
- Mona 升级后只加载当前应用内置编辑器，不加载旧资源残留。
- session.json 损坏、文件缺失和 source hash 冲突返回可定位错误。

### D2-03 兼容性与性能矩阵｜Luna

- 维护 Word、Excel、PowerPoint 的 Office/WPS 样本矩阵。
- 运行无修改、用户修改、Agent 修改和交替修改往返测试。
- 测量 100 页 Word、20 万单元格 Excel、100 页 PPT，形成加载、编辑、checkpoint 和导出报告。
- 性能阈值以 D0/D1 实测冻结，不为了达成数字删减格式正确性。

### D2-04 安全与发布审计｜主 Agent

- 验证 Office HTTP/WS 鉴权、socket ticket、路径和 Blob 上限。
- 验证 Agent 无法发送任意 JavaScript、HTML 或文件路径。
- 检查日志、错误、测试快照和产物不包含本地令牌、完整文档内容和内部绝对路径。
- 检查 Apache LICENSE、NOTICE、第三方许可证和 Mona 自有品牌。
- 检查安装包不包含 Electron、Node runtime、PDF/OCR、字体和无关 GenOffice 模块。

### D2-05 发布门禁｜Luna 执行构建，主 Agent裁决

- Windows/macOS 安装、升级、卸载和启动。
- 三编辑器首次打开、重复打开、并行标签和关闭。
- Services 单独停止时错误可恢复；Gateway 存活不能掩盖 Services 故障。
- 安装包增量目标 15–30 MB；最终数字记录在发布报告。
- 所有 D1/D2 验收均有当前构建证据。

## 10. 测试与构建命令

以下命令随实现逐步启用；只运行相关范围，不批量格式化历史代码。

### Python

```powershell
ruff check mona/office mona/agent/tools/office.py mona/services/server.py mona/materials/auth.py tests/office tests/services/test_office_api.py tests/agent/test_office_tool.py
pytest -q tests/office tests/services/test_office_api.py tests/agent/test_office_tool.py
```

### Office Editor

```powershell
npm --prefix webui/office-editor test
npm --prefix webui/office-editor run build
cargo test --manifest-path webui/office-editor/vendor/genoffice/apps/sheets/native/xlsx-engine/Cargo.toml
```

### WebUI

```powershell
npm --prefix webui test -- src/components/office src/tests/file-preview-panel.test.tsx src/tests/artifact-sidebar.test.tsx
npm --prefix webui run check:ui
npm --prefix webui run build:tauri
```

### Tauri

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

### 发布构建

```powershell
powershell -File src-tauri/build-windows-release.ps1
```

发布构建只在 D2 使用；D0/D1 不把开发构建描述为正式安装包通过。

## 11. 并行开发批次

### 批次 A：可以并行

- 主 Agent：D0-01、D0-04。
- Luna：D0-02；完成后执行 D0-03。

文件不重叠：主 Agent 不修改 `webui/office-editor/vendor/`；Luna 不修改 `mona/office/schemas.py` 和 Manager。

### 批次 B：接口冻结后并行

- 主 Agent：D0-05、D0-06。
- Luna：D0-07 构建与资源脚本。

`mona/office/sidecar.py` 由主 Agent先定义接口，Luna 只修改 sidecar 构建和打包文件。

### 批次 C：集成后并行

- 主 Agent：D0-08、D0-09 集成。
- Luna：D0-10 fixtures、测试和容量报告。

测试暴露缺陷后由对应生产文件所有者修复，Luna 不为通过测试修改未授权生产模块。

### D1 并行

- Luna 可并行处理 Docs 和 Slides 的构建入口，但不能同时修改共享 bridge。
- 主 Agent完成每个编辑器的 inspect/apply/transaction 后，Luna 再补对应回归测试和 UI 状态。
- `ThreadShell.tsx`、`OfficeEditorHost.tsx` 和共享协议同一时间只允许一个所有者。

## 12. 交付物

### D0

- GenOffice 固定源码快照与许可证记录。
- Sheets 无 Electron 编辑器。
- OfficeSessionManager、Services API/WS、Gateway tool 和 WebUI Host。
- Windows xlsx-sidecar 和内置资源 manifest。
- 十项 Go/No-Go 报告、XLSX 兼容报告和 bundle 容量报告。

### D1

- Docs、Sheets、Slides 三编辑器。
- 三格式 Agent DSL、inspect、checkpoint、保存和导出。
- 主会话 ArtifactSidebar 编辑标签；AI 文档模块入口保持不变。
- 三格式 Office/WPS 回归报告。

### D2

- Windows/macOS 安装包。
- 崩溃恢复、升级、权限和安全验证。
- 性能、兼容性、容量和第三方许可报告。

## 13. 完成定义

只有同时满足以下条件才算整个计划完成：

- Word、Excel、PowerPoint 均支持新建、导入、用户编辑、Agent 编辑、实时预览、保存和原生导出。
- Editor 是文档事务权威，Manager 是会话和持久化权威；双重版本校验、epoch、幂等和 checkpoint 有跨端测试。
- Agent 只使用稳定 Mona Office Schema，支持局部 inspect 和 changed_since，不读取内核 AST。
- Office 路由只归属 Services，Gateway 通过受保护客户端调用，没有重复状态源。
- 所有路径、HTTP、WebSocket、MessageChannel 和 Blob 入口通过安全测试。
- GenOffice 核心 Engine 未被 Mona 定制修改，薄 patch 可审计。
- 安装包内置三个编辑器、共享公共依赖、只使用系统字体，不包含 Electron、PDF/OCR 和 GenOffice AI。
- Windows/macOS 的 Office/WPS、构建、测试和安装包证据均为当前版本结果。
- 未扩展到 PDF、在线协作、云同步、宏和跨格式转换。
