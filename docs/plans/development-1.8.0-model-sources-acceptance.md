# Mona 1.8.0：供应商设置与统一模型选择器

- 分支：`feature/1.8.0-development`；已提交基点：`54992fc3`。
- 用户确认：先实现 Cindy 风格的模型供应商分类、添加流程和模型选择器，不继续围绕旧的执行者路径表单扩展开发页面。
- 状态：来源优先的设置、共享选择器与开发路由已落地；本轮在已有统一来源代码上完善交互、修复刷新行为并验收。不是所有官方订阅授权完成，也不是 1.8.0 发布完成。

## 1. 产品行为

### 来源分类

固定类别为 Mona AI、OpenAI、Anthropic。用户添加的每个来源保留独立 id、显示名称、端点和模型集。Mona AI 提供的其他品牌模型仍归 Mona AI；用户自建的同名模型仍归用户来源。

设置页面左侧选择来源，右侧显示连接状态和模型。OpenAI 关联本机 Codex，Anthropic 关联本机 Claude Code。进入设置只进行发现与状态读取，不创建项目、不登录、不发送模型请求。

### 添加与连接

官方来源可从左栏连接入口直接进入相应向导，无需再选一次执行器。OpenAI 显示 ChatGPT 连接流程和 API Key 替代入口。其他来源使用既有 API 配置/模型发现/手动添加流程，不重建另一份配置存储。

本轮没有把 Anthropic 的订阅授权伪装成已实现：当前界面明确提示该链路尚未接通，可使用 Anthropic API Key。真正的三家 CLI 认证及执行验收仍需独立完成。

### 模型列表

默认模型行保留名称、真实上下文信息和显示开关。“分别调整”展示类型修正、默认模型和图片/视频设置入口；这些原有能力未删除。用户添加来源的拖动顺序和选择器使用同一展示偏好。

刷新 API 模型目录只为新出现的语言模型选择默认可见状态；已知且被用户隐藏的模型不会因刷新而重新启用。未配置 API 的来源刷新原生模型时，不错误调用 API Key 端点。原生模型可批量显示/隐藏，与同名 API 模型的可见性分离。

### 共享模型选择器

`ModelSelector` 同时用于 `ThreadComposer` 和 `DevelopmentPane`，不是两套相似界面。顶部搜索，左侧收藏/全部/来源图标栏，右侧模型，底部进入供应商设置。

触发按钮包含真实来源图标、当前模型和已知推理强度。搜索自动获得焦点，方向键可进入结果，Enter 选择；来源栏支持方向键及首尾跳转。不会因键盘聚焦第一项就强行打开详情子菜单。

模型身份由来源、模型、执行者及预设标识共同构成。收藏和原生可见性不会串到同名的其他来源。能力、价格与标签只在目录提供时展示，不虚构截图中的价格、折扣、模型列表或能力。

底层保持 Provider（模型 API）与 Executor（原生 Agent）分离。开发会话通过 `/model-source` 在原产品会话上切换，API 模型保留具体 provider，原生模型保留对应 executor。改变选择不自动发送开发任务。

## 2. 代码入口

- `mona/providers/model_sources.py`：固定官方来源与来源分组。
- `mona/development/model_selection.py`：开发可用 API 模型、精确来源和推理参数解析。
- `mona/development/api.py`、`native_manager.py`：不依赖项目创建的来源发现/连接入口，以及会话模型来源切换。
- `webui/src/components/models/model-sources.ts`：来源身份、顺序、收藏、原生显示偏好。
- `webui/src/components/models/ModelSelector.tsx`：共享选择器。
- `webui/src/components/settings/ChatProvidersSettings.tsx`：来源设置、连接向导、模型目录。
- `webui/src/components/settings/ProviderNativeConnection.tsx`：归属于供应商的本机 CLI 状态和原生模型列表。
- `webui/src/components/development/development-models.ts`：选择项到开发执行路由映射。

展示偏好中不存 API Key、登录凭据或原生程序路径。既有图片/视频模型设置和类型覆盖逻辑保持兼容。

## 3. Cindy 参考

使用工作区已有的锁定源码 `92294b7ead54fab8edabbf57cdc11db903c501c9`，定位并阅读相关实现段落：

- `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`：来源排序、本机 CLI 发现、连接状态与建议入口。
- `apps/desktop/src/renderer/components/settings/AddProviderWizard.tsx`：一个供应商一个入口、供应商直达连接步骤、API 替代通道、模型发现失败后的手动路径。
- `apps/desktop/src/renderer/components/new-chat/UnifiedModelRail.tsx` 及 `unifiedModelSelection.ts`：来源优先的选择器组织与独立执行路由。

原始参考在 `output/development-1.8.0/cindy-reference/`。借鉴信息结构与交互，不复制其模型清单、账户状态或计费数据；也不为了 UI 一致而把不支持的授权路径标记成可用。

## 4. 本轮验证

### 自动化

- 供应商设置、模型选择器和开发界面回归：56 项通过、0 失败。报告：`output/development-1.8.0/model-source-ui-results.json`。
- 普通会话输入区、会话壳及导航兼容回归：91 项通过、0 失败。报告：`output/development-1.8.0/model-source-chat-regression.json`。既有无图标触发器断言已按用户确认的来源图标设计更新；详情验证改为真实 pointer move/异步子菜单，不要求焦点自动弹出详情。
- 后端来源解析、持久化切换、无项目发现和模型类型覆盖：5 项通过。命令覆盖 `tests/development/test_model_sources.py` 与 `tests/test_chat_model_type_override.py`。
- Ruff：涉及的来源解析模块、后端测试和页面验收脚本通过。
- 主前端 Vite 生产构建：通过，35.30 秒；保留既有分包和大体积 chunk 警告，没有为本任务顺手调整全站打包策略。
- 独立 TypeScript 检查请求在启动前被执行环境安全检查阻止，未运行；Vite 构建和测试不能代替完整类型检查，不计为通过。

新增/更新回归包括：来源分类、同名模型隔离、原生批量可见性、无 API 凭据时只刷新原生目录、刷新保留隐藏项、简洁行与高级编辑切换、搜索焦点和键盘选择。

### 真实浏览器

使用现有独立页面验收宿主 `webui/scripts/model-sources-smoke.mjs` 和 `scripts/verify_model_sources_ui.py`，渲染生产 React 组件。API、模型目录与账户状态是明确标识的验收数据；没有读取生产密钥、调用模型、连接供应商或重启 dev。

9 项检查通过：固定来源分类、默认简洁行、来源连接向导、自定义来源过滤、键盘选择、选中后触发器更新、紧凑窗口容纳、搜索空状态、无页面异常。

产物目录：`output/development-1.8.0/model-sources-ui-verified-01/`。
该目录同时保存 `source-manifest.json`，记录本轮主要生产来源/选择器文件的最终摘要，避免将本批验收结果套用于后续不同源码。

截图包含供应商设置、OpenAI 连接向导、API Key 替代入口、共享选择器、深色模式和 920×820 紧凑窗口。它们是生产组件的实际渲染，不是文生图，也不是官方账户可用性证据。

## 5. 工作区与剩余项

已有 `.git/index.lock` 未删除，本轮未提交、未推送、未重启 dev。原有 `src-tauri/Cargo.toml` 修改摘要保持 `a0b43ee6d6829c722de456c065174a8cdb0d1bb33a0b099a0694033ac0b2dc68`。未覆盖其他模块的并行工作。

下一步继续围绕供应商连接：真实授权后的模型同步、断开/重新连接、原生执行者与 API 渠道的状态刷新及端到端验收；补齐独立类型检查。Anthropic 订阅和其他官方 CLI 的真实认证保持明确未完成，不用示例账户或握手结果替代。两块基础交互稳定后，再回到开发工作台整体交互。
