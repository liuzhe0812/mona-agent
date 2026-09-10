# Mona Office 实时编辑功能设计

> 文档版本：1.7  
> 状态：Accepted / Windows 基础集成已实现；自然语言实时创作待实施  
> 日期：2026-09-06  
> 技术基线：GenOffice `v0.8.667`

> 2026-09-05 补充：用户要求普通自然语言创建 Word/Excel 时，先自动打开右侧空白编辑器，再分批写入并显示过程。具体任务和验收见 [Office 实时创作开发计划](../plans/mona-office-live-authoring-development-plan-2026-09-05.md)。本文第 6.1 节已更新目标保存语义；当前代码仍需按新计划实施，不以基础接口可用代替完整体验验收。

> 2026-09-06 决策：AI 文档模块采用固定开始页和多文档标签工作台。开始页支持新建 Word、Excel、PPT 和视频；普通 Office 文档在模块内进入实时人机协作编辑器。PPT 默认直接编辑，协作页提供“AI 制作整套 PPT”工作流入口；工作流生成的 PPTX 回到同一工作台继续编辑。主 Mona 右侧“新建 PPT”仍只创建 Office 会话，不启动工作流。

## 1. 产品结论

Mona 集成 GenOffice 的 Docs、Sheets、Slides 编辑器，形成统一的 Office 编辑会话。AI 文档模块以固定开始页和多文档标签工作台承载新建、打开和继续编辑；开始页支持 Word、Excel、PPT 和视频。用户在模块内打开或新建普通 Office 文档后，可以一边与 Agent 对话，一边在编辑器中实时看到 Agent 的修改；用户的手动修改与 Agent 修改进入同一个修订队列，最终保存或导出为原生 `.docx`、`.xlsx`、`.pptx` 文件。

PPT 在协作页默认进入直接编辑状态，同时提供“AI 制作整套 PPT”工作流入口。工作流生成的 `.pptx` 继续回到同一工作台并进入 Slides Office 会话；主 Mona 右侧的新建 PPT 只创建空白 Office 会话，不启动该工作流。

本方案不引入 GenOffice Shell、内置 AI 面板、账户体系和 Electron 桌面壳。Mona 继续拥有对话、Agent、文件权限和产物交付，GenOffice 只提供三个编辑器与格式引擎。Docs、Sheets、Slides 及共享依赖直接随 Mona 安装包交付，不要求用户首次使用时额外下载。

Mona WebUI 与 GenOffice 编辑器统一使用 React 19。正式实现仍采用独立编辑器 iframe 和 Mona Bridge，但隔离目的仅是保护 GenOffice CSS、全局状态、DOM 假设和编辑器生命周期，不承担框架版本隔离。

权威边界明确拆分：Services 进程中的 `OfficeSessionManager` 管会话、权限、命令队列、checkpoint、保存和导出；GenOffice Editor 管当前内存文档和事务提交。Manager 维护 Editor 版本的镜像，但不能代替 Editor 对 Agent 操作做最终版本校验。Gateway 中的 `office` 工具只通过受保护的跨进程契约调用 Services，不直接持有编辑会话状态。

## 2. 功能范围

### 2.1 必须支持

1. Word：新建、导入、手动编辑、Agent 编辑、实时预览、保存和导出 `.docx`。
2. Excel：新建、导入、手动编辑、Agent 编辑、实时预览、保存和导出 `.xlsx`。
3. PowerPoint：新建、导入、手动编辑、Agent 编辑、实时预览、保存和导出 `.pptx`。
4. 用户与 Agent 操作同一个打开中的编辑会话，修改后立即反映在编辑器中。
5. Agent 可以读取文档结构，提交结构化编辑操作，保存或导出文件。
6. 导入文件默认在工作副本上编辑，不静默覆盖原文件。
7. 导出的文件进入当前会话产物列表，可以继续预览、打开或交付。

### 2.2 明确不做

- PDF 编辑或 PDF 转换。
- 多用户在线协作、共享光标或云端同步。
- Git/worktree 式分支合并。
- VBA、宏、ActiveX、OLE 对象编辑。
- Office 插件、应用商店或第三方扩展体系。
- 手机端编辑。
- GenOffice 自带 AI、Genspark 登录、积分和搜索服务。
- 跨格式转换，例如 Word 转 PPT；导出只保证当前文档的原生格式。

复杂 SmartArt、宏和嵌入对象在第一版只要求未编辑部分尽量保留；无法保证保真时，导入后明确提示，不宣称可编辑。

## 3. Mona 当前基础

现有代码已经具备以下基础：

- `ArtifactSidebar` 和 `FilePreviewPanel` 已能在会话右侧打开产物标签页。
- `.docx/.xlsx/.pptx` 的文件点击入口统一通过 `OfficeFileEditor` 创建或复用会话，再由 `OfficeEditorHost` 持续预览与编辑；独立只读渲染依赖已移除。
- AI 文档模块通过固定开始页和多文档标签工作台承载 Office 编辑器；主会话右侧栏及其文件预览升级链路继续支持 Office 会话。旧“文档加工”入口不恢复，改由统一工作台承载。
- Python `office` 工具已提供 `list/open/inspect/apply/save/export/close`，通过 Services 调用实时编辑器；模型可见定义已移除旧 OfficeCLI 动作。
- Gateway 已有文档上传、产物扫描与 `artifacts_changed`；三个编辑器随包内置，不复用按需下载方式。

本项目不重新建设上传、Office 会话或 Agent 工具注册，也不改变 Services 与 Editor 的权威边界；只补充工作台对 Office 编辑会话的编排，并替换编辑和实时状态链路。视频创建流程不属于本 Office 编辑器设计。

## 4. 设计原则

1. **单一写入通道**：文档打开后，用户和 Agent 都通过编辑会话修改；禁止 Agent 在后台直接覆盖编辑器正在打开的文件。
2. **结构化操作**：Agent 只发送经过 schema 校验的 Office 操作，不向编辑器执行任意 JavaScript。
3. **原生格式交付**：编辑过程可以使用内存模型和操作日志，但最终文件仍是 `.docx/.xlsx/.pptx`。
4. **工作副本优先**：导入文件先复制到 Mona Office 会话目录，只有用户明确保存到原路径时才覆盖源文件。
5. **编辑器隔离**：Docs、Sheets、Slides 独立打包，避免 React、CSS 和编辑器运行时污染 Mona 主界面。
6. **安装包内置**：Docs、Sheets、Slides 和共享 core 随 Mona 安装；运行时只保留一份公共依赖，不使用首次使用下载。
7. **失败可恢复**：命令失败不改变 revision；保存通过临时文件和原子替换完成。
8. **薄适配上游**：保留 GenOffice 原始应用和引擎源码，只增加 Mona Bridge、运行入口和构建目标；不为 Mona 大规模改写上游编辑逻辑。
9. **系统字体优先**：不捆绑 Office 兼容字体包，使用操作系统字体和明确的 fallback；缺失字体时提示可能存在排版差异。

## 5. 总体架构

```text
Mona Agent / office tool（Gateway）
        │
        │ 受保护的本地 OfficeServiceClient
        ▼
OfficeSessionManager（Services）
        │
        ├── 会话、权限、命令等待、checkpoint、保存和导出
        ├── lastKnownVersion（Editor 版本镜像）
        ├── 内置编辑资源版本校验
        └── Services Office WebSocket
                         │
                         ▼
WebUI OfficeEditorHost ── MessageChannel ── GenOffice Editor iframe
        │                                      ├── MonaOfficeBridge
        │                                      ├── Docs
        │                                      ├── Sheets + xlsx-sidecar
        │                                      ├── Slides
        │                                      └── modelVersion（事务权威）
        ▼
ArtifactSidebar
```

### 5.1 责任边界

#### Services OfficeSessionManager

- 校验文件路径属于当前会话 workspace 或允许的上传目录。
- 创建、恢复和关闭 Office 会话。
- 保存源文件信息、工作副本路径、文档类型、Editor epoch、版本镜像和 dirty 状态。
- 对 Agent 操作做权限、schema 和版本预检查，发送到当前编辑器，并等待结构化结果。
- 接收 Editor 提交成功后的权威 `modelVersion`，更新 `lastKnownVersion`。
- 为每个 Editor 连接签发 epoch/租约，拒绝旧 iframe 的命令结果和用户变更。
- 原子保存和导出文件。
- 超时、断线、冲突和内置运行资源损坏时返回稳定错误码。

#### WebUI OfficeEditorHost

- 在当前会话或 AI 文档工作台中维护 Office 编辑器标签页，切换文档或收起侧边栏时保持非活动编辑器会话挂载。
- 加载对应 Docs、Sheets 或 Slides iframe。
- 使用 `MessageChannel` 建立一对一桥接，不开放任意跨窗口消息。
- 转发打开、检查、应用、checkpoint、保存和状态事件。
- 显示加载、Agent 编辑中、未保存、冲突、保存失败等状态。

#### GenOffice 编辑器 iframe

- 只负责文档模型、编辑 UI、结构化操作校验和 Office 格式序列化。
- 维护当前 epoch 内单调递增的 `modelRevision`，并在原子提交前执行最终版本校验。
- 用户编辑、Undo、Redo 和 Agent apply 都作为新事务产生新 revision；revision 不回退。
- 不访问 Mona Token、用户凭证、系统文件和 Agent 配置。
- 不包含 GenOffice AI 面板、账户、更新和桌面标题栏。
- 将 Electron preload API 替换为 `MonaOfficeBridge`。

#### Sheets xlsx-sidecar

- 作为 Mona 安装资源中的平台原生组件分发，不属于 `mona.runtime` 可下载组件。
- 由 Services OfficeSessionManager 启动和终止，不依赖 Electron。
- 只接受当前会话签发的文件和操作请求。

## 6. Office 会话模型

```text
OfficeSession
├── sessionId
├── ownerSessionKey
├── type                 # docs | sheets | slides
├── sourcePath           # 可为空，新建文件没有源文件
├── workingPath          # 最近一次成功 checkpoint 的工作副本
├── displayName
├── editorEpoch          # 当前 Editor 实例租约
├── lastKnownVersion     # Manager 对 Editor 版本的镜像
├── checkpointVersion    # workingPath 对应版本
├── savedVersion         # 最近明确保存或导出的版本
├── dirty
├── editorConnected
├── saveState            # clean | dirty | saving | error
└── lastError
```

文档版本使用二元组：

```text
DocumentVersion = { editorEpoch, modelRevision }
```

`modelRevision` 在同一个 Editor epoch 内按编辑事务单调递增。iframe 重建或从 checkpoint 恢复时由 Manager 签发新 epoch，旧 epoch 的命令、结果和用户变更全部失效，避免旧 iframe 重新连接后写入当前会话。

`dirty` 表示 `lastKnownVersion != savedVersion`；`checkpointVersion` 只表示可恢复程度，不能替代用户明确保存。

工作目录：

```text
~/.mona/office/sessions/<sessionId>/
├── session.json
└── working.docx|xlsx|pptx    # 最近成功 checkpoint，可直接恢复
```

状态流：

```text
opening → ready → applying → ready
                   ├── conflict → ready
                   └── error → ready

ready → saving → ready | error
ready → closed
```

规则：

1. Manager 是会话和持久化权威；Editor 是当前文档模型和事务提交权威。
2. 用户编辑、Undo、Redo 和 Agent apply 每提交一个编辑事务，Editor 的 `modelRevision` 加一；Undo/Redo 不让 revision 回退。
3. Agent 操作必须携带完整 `expectedVersion`。
4. Manager 先用 `lastKnownVersion` 快速拒绝明显过期的操作；Editor 在原子 apply 前用真实 `modelVersion` 再次校验，解决用户变更通知尚未到达 Manager 的竞态。
5. 一组 Agent operations 要么全部应用并产生一个新版本，要么全部回滚；第 N 个 operation 失败时不能保留前 N-1 个修改。
6. Editor 提交成功后返回权威新版本，Manager 再更新 `lastKnownVersion`；Manager 不能自行推算提交后的版本。
7. Manager 只接受当前 epoch 内大于 `lastKnownVersion` 的版本通知；重复或乱序的旧通知不覆盖较新镜像。
8. `operationId` 在一个会话内幂等。即使只有 WebSocket，重连和结果丢失仍不能让同一操作重复提交。
9. 编辑器断开时命令可以等待其重新连接；超过超时后返回 `EDITOR_UNAVAILABLE`，不能降级为直接写文件。

### 6.1 Checkpoint 与恢复

Editor 的内存模型不是持久文件。用户编辑后只更新版本通知还不足以恢复，必须由 Editor 对一个精确版本生成 Office 文件 checkpoint。

```text
Editor modelVersion = V
        ↓ 冻结 V 的不可变快照
serialize Office file
        ↓
Manager 写 working.tmp
        ↓ fsync + atomic rename
working.docx|xlsx|pptx
        ↓
checkpointVersion = V
```

checkpoint 触发规则（实时创作目标，待实施）：

- Agent apply 在 Editor 原子提交且 Manager 接受版本后返回成功；该结果不代表文件已经保存。
- 用户与 Agent 修改共用后台保存调度，停顿后触发，连续编辑设置最大调度间隔；每文档一个在途保存任务并合并后续请求。初始时间建议见实时创作计划，不作为现有实现或性能结论。
- 保存、导出和正常关闭前主动同步准确目标版本并等待持久化完成；不能只等待一个未发出的 checkpoint 请求。
- 后台保存失败单独反馈，不把已提交的编辑重新执行；后续用户修改不得被误标记为已保存。

原 D0 的“每批 apply 成功前必须 checkpoint”是历史实现。新方案保留每批修改的原子性，但将内存提交与文件持久化分离；相关 HTTP/Bridge 调用和测试必须同步调整。

规则：

1. `modelVersion` 表示 Editor 当前内存状态。
2. `checkpointVersion` 表示 `workingPath` 确实包含的状态。
3. `savedVersion` 表示最近一次用户明确保存或导出的状态。
4. 只有 Manager 完成临时文件写入和原子替换后，才能更新 `checkpointVersion`。
5. checkpoint 序列化期间后续编辑可以继续，但写出的文件和版本必须来自同一个不可变快照。
6. D0 不实现操作日志级零损失恢复，只验证 iframe 重建后从最近 checkpoint reconnect；Services 或应用完整重启恢复放到 D2。

## 7. Agent 能力设计

### 7.1 工具形态

继续使用现有单个 `office` 工具，不增加一组重复工具。调整为会话化 action：

| action | 作用 | 关键输入 |
|---|---|---|
| `list` | 发现当前聊天所属 Office 会话 | 由请求上下文确定 owner |
| `open` | 新建或打开 Office 会话；创作时先打开空白编辑器 | `path?`、`document_type?`、`session_id?` |
| `inspect` | 按 Agent-friendly schema 读取摘要、局部内容或变更 | `session_id`、`query` |
| `apply` | 原子应用结构化操作 | `session_id`、`expected_version`、`operations` |
| `save` | 保存工作副本或明确覆盖源文件 | `session_id`、`overwrite_source?` |
| `export` | 导出原生 Office 文件到 workspace | `session_id`、`output` |
| `close` | 关闭会话；未持久修改的处理按实时创作计划补齐 | `session_id` |

兼容规则：

- 当前模型可见工具只提供上表的实时会话动作；历史 OfficeCLI 执行分支不作为普通创作路线。
- 新建 Word/Excel 默认先打开空白会话，正文分批通过 Editor 操作写入；脚本可辅助计算数据，不能代替实时编辑主流程。
- `inspect` 读取当前 Editor 模型；主会话消息携带当前活动 Office 标签的 session ID，工具默认绑定该会话。没有活动标签时才按文档名称和上下文选择，不以 `editorConnected` 判断前台标签。

### 7.2 通用操作信封

```json
{
  "operationId": "op_...",
  "expectedVersion": {
    "editorEpoch": "epoch_...",
    "modelRevision": 12
  },
  "operations": [
    { "op": "...", "payload": {} }
  ]
}
```

每个返回结果包含：

```json
{
  "ok": true,
  "sessionId": "office_...",
  "version": {
    "editorEpoch": "epoch_...",
    "modelRevision": 13
  },
  "changedTargets": ["..."],
  "summary": "..."
}
```

### 7.3 Agent-friendly inspect

`inspect` 不返回 GenOffice AST、ProseMirror JSON、Univer 对象或完整 PPTX 内部模型。统一返回稳定、分页、可限量的 Mona Office Schema。

支持查询：

| mode | 用途 |
|---|---|
| `summary` | 文档类型、名称、版本、页数/Sheet 数/Slide 数和内容规模 |
| `outline` | Word 标题结构或 PPT 页面标题列表 |
| `search` | 搜索文本并返回稳定目标 ID 和少量上下文 |
| `blocks` | 读取指定 Word block |
| `range` | 读取指定 Sheet 和单元格范围 |
| `slides` | 读取指定 PPT 页面及元素摘要 |
| `changed_since` | 返回指定版本后的用户和 Agent 变更目标 |

所有查询统一支持适用的：

```text
limit
cursor
includeStyle
includeFormula
```

`changed_since` 只保存有界的 revision 变更摘要，不保存完整 Office 操作历史。例如：

```json
{
  "version": { "editorEpoch": "epoch_1", "modelRevision": 33 },
  "changes": [
    { "actor": "user", "target": "block_93", "kind": "text" },
    { "actor": "user", "target": "销售!C17", "kind": "cell" }
  ]
}
```

请求的 epoch 已失效或 revision 早于保留窗口时返回 `RESYNC_REQUIRED`，Agent 重新读取 outline、blocks、range 或 slides，不能假装增量仍完整。

D0 Sheets 只实现 `summary` 和 `range`。冲突结果直接返回当前版本与最近修改目标，Agent 重新读取相关 range；`changed_since`、`cursor`、通用搜索和跨 revision 变更窗口从 D1 开始实现。

### 7.4 Docs 操作范围

基础操作：

- 插入、删除、替换段落文本。
- 设置标题、正文、加粗、斜体、颜色、对齐、行距。
- 插入和修改列表、表格、图片、分页符。
- 调整表格单元格内容、行列和基础样式。
- 读取全文大纲、段落、表格和指定文本范围。

Agent 以 block ID 或稳定锚点定位内容，不用易漂移的纯字符偏移量作为唯一定位方式。

### 7.5 Sheets 操作范围

复用 GenOffice `workbook-dsl` 的稳定子集。D1 必须支持：

- 设置或清除单元格、范围、公式和样式。
- 插入、删除、重命名和移动工作表。
- 插入、删除行列，合并或取消合并。
- 读取 workbook 概览、指定 Sheet、范围、公式和图表信息。

D1 后的增强能力包括排序、筛选、数据验证、条件格式、冻结窗格、表格和图表，不作为基础可用交付阻塞项。

所有范围写入必须有最大单元格数限制；大范围操作由 Agent 分批提交。

### 7.6 Slides 操作范围

- 新建、删除、复制、重排幻灯片。
- 插入和修改文本、基础形状和图片。
- 移动、缩放、对齐、分布、置顶或置底元素。
- 设置页面背景、字体、填充、描边和基础版式。
- 读取页面列表、元素树、文本和几何位置。
- 应用布局操作前执行越界、重叠和文本溢出检查。

表格和图表属于 D1 后增强能力，不作为基础可用交付阻塞项。

不允许 Agent 执行任意 HTML 或 JavaScript；需要批量布局时使用 GenOffice 受限布局解释器或等价结构化操作。

## 8. 实时编辑与预览

### 8.1 Agent 编辑流程

```text
Agent office.apply
  → Gateway OfficeServiceClient 调用 Services
  → OfficeSessionManager 校验权限、schema 和 lastKnownVersion
  → WebSocket 发送 office_command
  → OfficeEditorHost 转给 iframe
  → Editor 用真实 modelVersion 再次校验 expectedVersion
  → 编辑器原子应用 operations，失败则整组回滚
  → 当前页面立即重绘
  → iframe 返回权威新 modelVersion
  → Manager 镜像 lastKnownVersion
  → Editor 序列化该版本，Manager 原子写入 checkpoint
  → office tool 返回 Agent
```

用户能在 Agent 每一组操作完成后立即看到结果，不需要等待文件重新生成或轮询磁盘。

### 8.2 用户编辑流程

```text
用户在编辑器中修改
  → Editor 以一个本地事务应用并更新画面
  → modelRevision 单调加一
  → WebSocket 上报 user_change 和权威新 modelVersion
  → Manager 镜像版本并标记 dirty
  → Agent 下一次 apply 必须使用新 expectedVersion
```

Undo 和 Redo 使用同一流程：它们改变文档内容，因此产生新 revision，而不是把 revision 改回历史值。

### 8.3 UI 状态

Office 文档标签的标题区（主会话侧栏或 AI 文档工作台顶部标签）只显示必要信息：

- 文件名。
- `Mona 正在编辑`、`未保存`、`已保存`、`冲突`或`保存失败`。
- 保存、导出、全屏、关闭。

编辑器内部保留原生 Undo/Redo。Mona 不再重复提供第二套 AI 面板和 Ribbon。

Agent 完成操作后，编辑器短暂定位最后修改的段落、单元格或页面；不增加复杂时间线和动画。

## 9. 导入与导出

### 9.1 导入入口

- 对话输入区附件。
- ArtifactSidebar 工作区文件。
- AI 文档工作台固定开始页的历史、收藏和新建入口。
- Agent 调用 `office.open(path=...)`。

支持格式：

| 编辑器 | 导入 | 导出 |
|---|---|---|
| Docs | `.docx` | `.docx` |
| Sheets | `.xlsx` | `.xlsx` |
| Slides | `.pptx` | `.pptx` |

新建文档由对应引擎创建最小合法 Office 文件，不通过空 ZIP 或临时 JSON 冒充 Office 文件。

### 9.2 工作副本

1. 导入后计算源文件哈希并创建工作副本。
2. 自动保存只写工作副本，不覆盖源文件。
3. 用户选择“覆盖原文件”时再次比较源文件哈希；源文件已被其他程序修改则拒绝覆盖。
4. “导出”始终写入新的 workspace 路径。

### 9.3 导出交付

- 保存或导出前强制生成目标 `modelVersion` 的 checkpoint；文件写入成功后再更新 `checkpointVersion` 或 `savedVersion`。
- 保存通过同目录临时文件和原子替换完成。
- 导出完成后生成 `ArtifactRef`，广播 `artifacts_changed`。
- 文件自动进入右侧产物列表，Agent 可以继续交付给用户。
- 导出前执行格式结构校验；失败时保留工作会话，不生成伪成功文件。

## 10. API 与事件

### 10.1 Services HTTP API

| API | 用途 |
|---|---|
| `POST /api/office/sessions` | 新建或打开会话 |
| `GET /api/office/sessions/{id}` | 读取会话状态 |
| `GET /api/office/sessions/{id}/file` | 读取当前工作副本 |
| `POST /api/office/sessions/{id}/socket-ticket` | 签发绑定当前会话的一次性短时 WebSocket ticket |
| `POST /api/office/sessions/{id}/checkpoint` | 上传并原子持久化指定版本的 Office Blob |
| `POST /api/office/sessions/{id}/save` | 明确保存当前 checkpoint |
| `POST /api/office/sessions/{id}/export` | 导出到 workspace 并登记产物 |
| `DELETE /api/office/sessions/{id}` | 关闭会话 |

这些路由只注册在 Services 进程。WebUI 通过现有 `getServicesHttpBase()` 和 Tauri 本地 HTTP Bridge 访问，`/api/office/*` 纳入现有 `X-Mona-Token` 本地服务鉴权，并绑定 owner session/workspace。前端不能提交任意绝对路径。

Gateway 中的 `office` 工具使用一个最小 `OfficeServiceClient` 和本地服务令牌调用 Services，其中 Agent apply 使用受保护的内部请求提交命令并等待结果。Services 再通过 Office WebSocket 把命令交给 Editor；Gateway 不复制 Manager 状态，也不直接连接 iframe。

浏览器与 Services 之间的实时控制和编辑状态不提供第二套 HTTP 写入口，统一使用 WebSocket，避免同一 user change 或 command result 同时从 HTTP、WebSocket 到达。HTTP 只负责会话资源、Office Blob、持久化副作用，以及 Gateway 工具到 Services 的受保护跨进程请求。

### 10.2 Services Office WebSocket

浏览器 WebSocket 不能附加 `X-Mona-Token` 请求头。OfficeEditorHost 先通过受保护 HTTP API 获取一次性短时 ticket，再建立 Services Office WebSocket；ticket 只绑定一个 Office session，成功握手后立即失效。未认证连接不能接收会话状态或提交 Editor 结果。

| 事件 | 方向 | 用途 |
|---|---|---|
| `office_session_open` | 服务端 → UI | 打开对应 Office 文档标签（主会话侧栏或 AI 文档工作台） |
| `office_session_state` | 服务端 → UI | 同步 epoch、版本镜像、dirty 和保存状态 |
| `office_command` | 服务端 → UI | 下发 Agent operations |
| `office_editor_ready` | UI → 服务端 | 携带当前 epoch 和 modelVersion 完成握手 |
| `office_user_change` | UI → 服务端 | 上报用户事务和权威新 modelVersion |
| `office_command_result` | UI → 服务端 | 返回 operationId、权威新版本或错误 |
| `office_session_closed` | 双向 | 关闭编辑器会话 |

二进制 Office 文件不通过 WebSocket base64 传输；checkpoint、保存和导出使用 HTTP Blob/ArrayBuffer。WebSocket 消息仍必须按 `operationId` 幂等去重。

## 11. 编辑器资源与安装包

三个编辑器作为常用能力直接随 Mona 安装包交付：

```text
<Mona app resources>/office-editor/
├── manifest.json
├── core/                     # 统一 React 19、GenOffice UI、i18n、公共 OOXML 依赖
├── docs/
├── sheets/
│   └── xlsx-sidecar.exe|binary
└── slides/
```

- Mona 主界面和三个编辑器声明同一 React 19 版本；iframe 各自拥有运行实例，但构建产物复用同一版本的静态依赖。
- 使用一个多入口生产构建生成 Docs、Sheets、Slides，编辑器公共依赖输出到同一 `core`，磁盘和安装包中只保留一份。
- 三个 iframe 复用同一组内容哈希 chunk；不能各自打包 React、GenOffice UI、国际化和公共格式库。
- 不捆绑 Office、Liberation、Carlito、Caladea 或 Noto CJK 字体包，使用操作系统字体枚举和平台 fallback。
- 文件引用的字体未安装时，编辑器显示缺失字体提示，并使用系统替代字体；不能声称排版完全一致。
- HarfBuzz 属于文本度量引擎而不是字体，Slides 需要时仍随共享 core 内置。
- 不分发 Electron runtime、GenOffice Shell、PDF、OCR、Genspark AI 和测试资源。

容量目标：

| 内容 | 安装包压缩增量目标 |
|---|---:|
| 共享 core | 4–8 MB |
| Docs | 2–5 MB |
| Sheets + xlsx-sidecar | 5–10 MB |
| Slides | 4–8 MB |
| 合计 | 15–30 MB |

当前 Mona Windows 安装包约 178.5 MB，预计集成后约 194–209 MB。以上是规划区间，最终值由 D0 的真实生产构建冻结；若超过 30 MB，先检查重复 chunk、source map、示例和无关资源，不能通过删除必要格式引擎换取达标。

## 12. 按交付级别实施

### D0：技术验证，不面向正式用户

目标：验证最关键、风险最高的 Agent → 编辑器 → 原生文件闭环。

范围：

- Windows。
- Sheets 单格式。
- Docs、Sheets、Slides 执行一次多入口生产构建用于容量分析，但 D0 只接通 Sheets 功能。
- 打开一个 `.xlsx` 工作副本。
- 在 ArtifactSidebar 中加载裁剪后的 GenOffice Sheets。
- Agent 通过 summary、range inspect 读取必要状态，并通过 DSL 写入单元格、公式和基础样式。
- 用户能同时修改单元格。
- Manager 预检查与 Editor 最终版本检查都生效，冲突拒绝覆盖。
- Agent apply 成功后生成 checkpoint。
- 导出新 `.xlsx`，可被 Excel/WPS 打开。

验收：

1. 完全不启动 Electron，也能打开、编辑、checkpoint、保存和导出 XLSX。
2. Agent 每次 apply 完成后，界面在 500ms 内显示结果，不重新加载整个文件。
3. 用户修改一个单元格后，Agent inspect 能读取新值；冲突结果返回当前版本和最近修改目标，Agent 能重新读取相关 range。
4. 自动制造“用户事务已提交但 Manager 尚未收到通知”的竞态 1000 次，Agent 旧版本操作全部被 Editor 拒绝，无静默覆盖。
5. 一组 operations 中第 N 个失败时，前 N-1 个操作全部回滚，modelVersion 不变化。
6. 编辑器崩溃后能恢复到最近 checkpoint；iframe 重建后 reconnect 原 session，并拒绝旧 epoch 消息。
7. inspect/apply 只暴露 Mona Office Schema，不返回 Univer 或 GenOffice 内部结构。
8. Mona 接入不修改 GenOffice 核心 Engine；Renderer 修改限于宿主接口注入、运行入口和 UI 裁剪，并形成可审计 patch 清单。
9. 导出文件通过 OOXML 结构校验，在 Excel/WPS 中显示正确；未改动 Sheet 和 OOXML entry 保持不变，或有明确兼容性报告。
10. 生产构建只生成一份 React、GenOffice UI、国际化和公共格式依赖；输出三编辑器容量报告并冻结正式安装包增量目标。

上述十项全部通过才进入 D1；任一数据一致性、无 Electron 运行、共享依赖或格式保真项失败均为 No-Go。

预估：7–12 个工程日。

### D1：基础可用交付

目标：满足 Word、Excel、PowerPoint 的基础完整闭环。

范围：

- Docs、Sheets、Slides 三个编辑器。
- 新建、导入、手动编辑、Agent 编辑、实时预览。
- Docs：文本、标题、列表、基础表格、图片。
- Sheets：值、公式、基础样式、行列和 Sheet 管理。
- Slides：文本、图片、基础形状、位置尺寸和页面管理。
- summary、outline/search、局部读取和 changed_since inspect。
- 工作副本、Editor epoch、三类版本、dirty 状态、Undo/Redo 和 checkpoint。
- 保存、另存为和原生格式导出。
- AI 文档固定开始页、多文档 Office 标签、全屏和产物登记；视频新建入口仍由其自身流程承载。
- PPT 默认直接编辑，并在协作页提供“AI 制作整套 PPT”工作流入口；工作流产出的 PPTX 回到同一工作台继续编辑。
- 对无法编辑的复杂元素给出提示。
- Windows 正式可用。

验收：

1. 三种格式分别通过“新建 → Agent 编辑 → 用户编辑 → 再次 Agent 编辑 → 导出”用例。
2. 导入现有文件不会在用户确认前修改原文件。
3. 侧边栏收起再展开，编辑器状态和 Undo 栈不丢失。
4. Agent 操作失败时文档 modelVersion 和内容不变化。
5. iframe 关闭或重建后能重新连接当前会话并恢复最近 checkpoint；Services 或应用完整重启恢复不作为 D1 门槛。
6. 导出的三种文件在 Office/WPS 中可以打开，核心内容、布局和公式正确。
7. 内置 Office 编辑资源缺失或损坏时显示可恢复错误，不回退为静默后台覆盖。
8. AI 文档开始页新建或打开多个 Office 文档后，标签切换仍绑定各自会话；PPT 工作流生成的 PPTX 能在同一工作台继续编辑。

工期在 D0 通过后按三个编辑器的真实适配差异重新估算；当前仅作规划参考，预计 8–12 个工程周。

### D2：正式发布交付

目标：达到可以随 Mona 正式版本长期维护的质量。

范围：

- macOS 支持。
- Windows/macOS 安装包均包含对应平台的三个编辑器和 Sheets sidecar。
- 崩溃恢复、断线重连和未保存关闭确认。
- 常见 Office 文件兼容性矩阵和自动回归样本。
- 大文件加载与操作限额。
- Docs 表格/图片、Sheets 表格/图表/筛选、Slides 表格/图表/图片的常用场景完善。
- 文件导入、Agent 操作、保存和导出的端到端测试。

验收：

1. Windows/macOS 均通过三种格式的完整回归。
2. 100 页 Word、20 万单元格 Excel、100 页 PPT 在规定设备基线内可打开和编辑，具体性能阈值由 D0 实测后冻结。
3. 异常关闭后恢复到最近一次自动保存，不覆盖更新后的源文件。
4. 应用升级后内置编辑器版本与 Mona 版本一致，不加载旧版本残留资源。
5. 安装包不内置 Electron 和字体包，三个编辑器共享公共依赖，Windows 安装包增量以 15–30 MB 为目标并由 D0 实测冻结。
6. 所有文件路径、命令和 iframe 消息通过权限与 schema 校验。

预估：在 D1 基础上增加 4–7 个工程周。

## 13. 最小代码落点

### WebUI

```text
webui/src/components/office/
├── OfficeEditorHost.tsx
├── OfficeEditorFrame.tsx
├── OfficeEditorToolbar.tsx
├── office-bridge.ts
├── office-session-store.ts
└── types.ts
```

修改：

- `ArtifactSidebar.tsx`：支持 Office 编辑器标签类型。
- `ThreadShell.tsx`：接收 `office_session_open/state` 并保持 iframe 挂载。
- `FilePreviewPanel.tsx`：Office 文件统一转到 OfficeEditorHost；无活动会话时从授权取得的二进制内容创建会话，相同所有者和文件身份复用会话。PDF 保留原生预览。
- `DocMakerView.tsx`/AI 文档工作台：维护固定开始页和多文档标签；Word、Excel、PPT 新建或打开后进入 OfficeEditorHost，PPT 协作页保留“AI 制作整套 PPT”工作流入口，工作流产出的 PPTX 回到同一工作台继续编辑。
- `lib/office-client.ts`：通过 `getServicesHttpBase()` 访问 Office HTTP API 和 Services Office WebSocket。
- `lib/types.ts`：增加 Office 会话、版本、命令和事件类型。

### Python

```text
mona/office/
├── client.py              # Gateway → Services 受保护客户端
├── api.py                 # Services HTTP 与 Office WebSocket handlers
├── session.py
├── manager.py
├── sidecar.py             # 内置资源定位、manifest 校验、sidecar 生命周期
├── schemas.py
└── errors.py
```

修改：

- `mona/agent/tools/office.py`：改为会话化 action，通过 `mona.office.client` 调用 Services，保留旧 action 兼容。
- `mona/services/server.py`：持有 OfficeSessionManager，只在 Services 注册 Office HTTP API 和独立 Office WebSocket。
- `mona/materials/auth.py`：把 `/api/office` 纳入现有 Services 本地令牌保护范围。
- `mona/api/server.py`、`mona/channels/websocket.py`：不注册新的 Office session 状态或 Editor 命令通道。
- `mona/api/officecli_runtime.py`：保留旧任务兼容；打开中的 Office 会话不再依赖或下载 OfficeCLI。

### Tauri 与打包

- `src-tauri/src/lib.rs`：本地 HTTP Bridge 对 `/api/office` 自动附加 `X-Mona-Token`，新增最小调用测试。
- `src-tauri/tauri.conf.json` 和 Windows/macOS 发布脚本：包含 Office 编辑器静态产物与对应平台的 xlsx-sidecar。
- `webui/package.json` 和 Office 编辑器独立构建脚本：先构建 Mona WebUI，再构建多入口 Office 编辑器并写入最终 `dist/office-editor`。

### GenOffice 薄适配 fork

保留完整上游源码快照，Mona 构建只选择需要的目标，不通过删除源码形成大规模分叉：

```text
Upstream GenOffice snapshot
├── apps/docs
├── apps/sheets
├── apps/slides
└── packages/*
          │ 尽量不修改
          ▼
Mona adapter layer
├── mona-bridge
├── mona-runtime-entry
└── mona-build
```

- 构建 Docs renderer + `docx-engine`。
- 构建 Sheets renderer + 允许的 Univer OSS 包 + `xlsx-sidecar`。
- 构建 Slides renderer + `pptx-engine` + `pptx-render`。
- `MonaOfficeBridge` 尽量实现 GenOffice 原 preload 的同一 TypeScript interface，让 Renderer 不感知 Electron 或 Mona 宿主差异。
- Electron main/preload、Shell、PDF、Markdown、GenOffice AI、自动更新、遥测和品牌资源保留在上游快照中，但不进入 Mona 构建产物。
- Mona 对 Renderer 的必要 patch 单独维护清单和回归测试；核心 Engine 原则上零修改。
- 升级上游时重新应用薄 patch 并跑兼容性测试，不直接追踪滚动 `main`。

## 14. 测试方案

### 14.1 合同测试

- Office operation schema。
- Manager 预检查、Editor 最终版本检查和 editorEpoch 失效。
- 用户编辑、Undo、Redo、Agent apply 的 modelRevision 单调性。
- Agent operation 原子回滚与 operationId 幂等。
- checkpointVersion、savedVersion 和精确快照序列化。
- action 权限与 workspace 路径。
- MessageChannel 来源和 session ID 校验。
- Agent 命令超时、重连和重复 result 去重。

### 14.2 格式测试

每种格式维护三组样本：

1. Mona 新建文件。
2. Microsoft Office 新建文件。
3. WPS 新建文件。

每个样本执行：

- 无修改导入导出。
- 用户修改后导出。
- Agent 修改后导出。
- 用户和 Agent 交替修改后导出。
- Office/WPS 打开验证和结构校验。

### 14.3 UI 测试

- 侧边栏打开、收起、恢复和全屏。
- 三种编辑器切换不丢失状态。
- Agent 操作时定位修改目标。
- 保存、冲突、内置资源加载失败和恢复提示。
- 未保存关闭确认。
- 系统缺少文档字体时显示 fallback 提示，仍可继续编辑和导出。

### 14.4 构建产物测试

- Docs、Sheets、Slides 共用单份 React、GenOffice UI、i18n 和公共格式库。
- 安装包不包含 Electron、Node runtime、PDF/OCR 和字体文件。
- Windows/macOS 安装包都包含正确平台的 xlsx-sidecar，并通过 manifest 校验。
- 生成各 chunk、各编辑器和总安装包增量报告，防止公共依赖回归为重复打包。

## 15. 风险与处理

| 风险 | 处理 |
|---|---|
| GenOffice 是快速更新的镜像仓库，内部 API 不稳定 | 固定 `v0.8.667` 对应 commit，保留上游快照并维护薄 adapter patch，不跟随 main 自动升级 |
| GenOffice CSS、Univer、全局状态与 Mona 主界面冲突 | 全部统一 React 19，但继续使用 iframe 隔离编辑器 DOM、样式和生命周期 |
| 用户和 Agent 同时写导致覆盖 | Manager 预检查 + Editor 原子最终校验 + expectedVersion |
| 旧 iframe 或重连消息写入当前文档 | editorEpoch/租约 + operationId 幂等 |
| Editor 内存已更新但恢复文件落后 | model/checkpoint/saved 三类版本 + 精确快照 checkpoint |
| 编辑器断开时 Agent 工具悬挂 | editor ready 握手、命令超时、reconnect 和稳定错误码 |
| Agent inspect 占用大量 token 或依赖内核结构 | 稳定 Mona Office Schema + 局部查询 + changed_since + RESYNC_REQUIRED |
| Office 高级对象保真不足 | 未支持对象保留或提示；兼容性矩阵不通过不宣称支持 |
| Sheets 原生 sidecar 跨平台复杂 | 随各平台安装包构建、签名并用 manifest 校验 |
| 安装包增大 | 共享 core、系统字体、不携带 Electron/PDF/OCR，D0 冻结 15–30 MB 目标 |
| 系统缺少文档指定字体 | 显示缺失字体与 fallback，不承诺缺失字体下的像素级排版一致 |

## 16. 最终实施建议

1. 先完成 D0 Sheets 垂直闭环，严格执行十项 Go/No-Go 验收，验证无 Electron 运行、双重版本校验、Agent-friendly inspect、checkpoint、共享依赖构建和原生文件保存。
2. D0 通过后同时抽出通用 OfficeSessionManager、OfficeEditorHost 和薄适配层，再接入 Docs、Slides，避免三个编辑器各自建设会话协议。
3. D1 达到三格式基础闭环后接入主会话右侧栏和 AI 文档多文档工作台；统一开始页负责新建/打开，旧“文档加工”入口不恢复。
4. D2 只补正式发布所需的跨平台、恢复、兼容性和运行时交付，不扩展多用户在线协作、PDF 和跨格式转换。

完成标准是：用户能从 AI 文档固定开始页新建或打开 Word、Excel、PPT 和视频；Word、Excel、PPT 在多文档标签工作台中进入实时人机协作编辑，PPT 默认可直接编辑并可从协作页启动整套 PPT 工作流，工作流生成的 PPTX 能回到同一工作台继续编辑，最后导出可由 Office/WPS 正确打开的原生文件。主 Mona 右侧新建 PPT 始终只创建 Office 会话。
