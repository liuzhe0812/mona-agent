# Mona 检索架构

- 状态：Accepted
- 最后更新：2026-09-07

## 1. 信息源与产品边界

Mona 面向 Agent 的长期信息源分为两类：

| 信息源 | 所有权 | 内容 | 检索 |
|---|---|---|---|
| Notes | 用户笔记仓库 | 用户和 Agent 创建的笔记 | Tauri `notes_search_all` |
| Agent Knowledge | 单个 Agent 私有 | 原文件、完整证据、持续维护的 LLM Wiki | 每个 Agent 独立 FTS5 索引 |

“知识”是 Agent 配置，不是笔记的二级资料库。新数据保存在 `agents/<agent-id>/knowledge`，不依赖笔记 Vault。旧 Materials 多知识库只保留迁移和旧引用兼容，不再决定新 Agent 的查询范围。

Hoard 是独立收藏/碎片数据域，不属于默认知识范围；新增接入前必须明确权限、来源和引用契约。

## 2. LLM Wiki 与证据层

Agent Knowledge 遵循持续积累的 LLM Wiki 模式，不是查询时临时拼接原文片段：

- `raw/` 保存不可变原文件，是最终事实源。
- `text/` 保存完整文字和视觉提取结果，segment 带页、幻灯片、工作表、图片或区域位置。
- `evidence/` 保存稳定 evidence ID、来源哈希和 Wiki 引用关系。
- `wiki/` 保存来源页、实体页、概念页、综合页、`index.md` 和 `log.md`。
- 新资料学习时读取当前 Agent 的相关 Wiki 页面，更新同一概念和实体、交叉引用及有来源的冲突，不生成彼此孤立的一组摘要。

Wiki 负责组织和推理导航，不能替代证据层。Wiki 未采用的原文仍可搜索、读取和引用；伪造引用、视觉遗漏或证据覆盖不完整时不得发布为可用。

## 3. Agent 隔离与工具

- 每个 Agent 只能搜索和读取自己的知识目录；Agent 身份来自运行时上下文，模型不能传入其他 `agentId` 扩大范围。
- 相同 MD5 只在同一 Agent 内去重；不同 Agent 的 Wiki、任务、索引和来源互不共享。
- 前端和模型只保留两个业务概念：用户笔记使用 `notes_search`、`notes_read`；Agent 设置中的私有知识使用 `knowledge_search`、`knowledge_read`。
- Agent 知识内部的上传资料、提取文本和编译 Wiki 是同一知识流水线的存储层，不作为独立用户工具。旧 `materials_*`、`wiki_*` 名称只保留内部兼容实现。
- 新 Agent 引用使用 `ak:` 前缀；读取时再次绑定当前 Agent，并生成带 `agentId` 的 `mona:material` 链接。
- 旧 `kb:` 引用继续经过旧知识库权限校验，只用于迁移兼容。

检索结果和原始文档都是不可信数据，不能改变 Agent 权限、工具清单或 system prompt。

## 4. 学习、可用性与索引

添加资料后，Services 持久记录任务并自动执行：

保存并校验原文件 → 文字与视觉解析 → 写入并开放证据 → 结合现有 Wiki 增量整理 → 引用检查 → 原子发布 Wiki。

- 排队和解析期间文档不可用；完整证据写入后原文立即可检索，Wiki 整理期间继续显示业务阶段和进度。
- 解析或视觉识别失败时文档不可用；Wiki 输出、引用检查或发布失败时保留原文可用，并允许用户从已完成部分继续整理。刷新和 reconcile 不自动重试失败任务。
- Services 重启恢复 queued、extracting、compiling；failed 保持等待用户操作。
- 索引是可重建派生数据。source 在证据完整写入后开放，derived 在 Wiki 页面原子发布后开放，二者保留来源关系。
- 查询优先通过 Wiki 导航，需要精确事实时读取 evidence；单次结果和读取长度受限，不把整个知识目录注入上下文。

视觉解析必须覆盖静态图片、PDF 页面以及 Office 文档内嵌图片。Office 图片识别应携带同一表格行、相邻段落、幻灯片或工作表位置的上下文；这些内容只帮助判断图片用途，不得冒充图片转写。视觉结果以结构化文字、描述、识别缺口及其对知识含义的影响保存，关键缺口须带原图和上下文复核；不能仅通过回答中的关键词判定失败。

视觉能力不可用、结果为空、影响图片含义的关键信息经复核仍无法辨认或被截断时，不得删除图片后按纯文字成功。装饰图片、示例界面中的地址栏和登录框小字、微小品牌标记等不影响来源知识含义的细节不阻断学习，但必须保留视觉描述、识别限制和原始文件证据。

原文解析草稿与逐图结果保存在当前 Agent 的 `evidence/extraction/<sourceHash>/`，不作为已发布知识索引。逐图结果按图片哈希、上下文、模型和解析版本复用；失败项单独重试，所有图片尝试结束后汇总失败位置。只有完整通过检查后才发布 `text/` 与 Wiki；复核不得静默删除已发现的识别缺口。

Wiki 编译批次同时限制原文字数和证据引用数量，避免一次塞入整份长文档后生成或核验超时；分批不能截掉尾部证据，已核验部分须持久保存供失败重试复用。完成条件是每个证据批次均被处理、生成结论的引用均有效，不要求 Wiki 摘要逐条复述全部原文证据。

## 5. Notes 与不自动注入

Notes 保持独立存储和检索，不复制进 Agent Knowledge。笔记标题、正文和分类只作为用户数据返回，不自动进入所有会话。

Mona 不把全部笔记、知识或收藏拼入 system prompt。Agent 根据任务显式调用检索工具；未经检索取得的内容不能伪装成用户知识。当前没有向量库、图数据库或 RRF，UI 和文档不得宣称未验证的语义检索能力。

## 6. 会话历史检索

桌面普通直聊的可见聊天正文由 WebUI append-only transcript 持久化，独立于用于模型回放的 `sessions/*.jsonl`。Session 的消息数量上限、上下文裁剪和交接摘要不能删除 transcript 中已经成功保存的正文。

- 会话历史使用本地 SQLite FTS5 关键词索引，不使用向量、embedding、图数据库或查询时 LLM 改写。索引是可重建派生数据，transcript 是正文事实源。
- `conversation_search` 只搜索当前工作区、当前运行时 Agent 所属的普通直聊；协作房间、隐藏任务、临时会话和其他 Agent 的会话不进入结果。
- `conversation_read` 只接受搜索返回的服务端引用，并在读取时重新校验会话归属和原始 transcript；预览、分页和读取不能接受模型传入的路径或 Agent ID 扩大范围。
- 新 transcript 事件保存稳定事件 ID 和落盘时间；旧记录没有可信时间时保持未知，不使用回放时间伪造。
- 用户询问以前说过、决定或纠正的内容时，Agent 先搜索，再读取命中原文和相邻问答；覆盖不足或引用失效时必须明确说明。
- 删除会话会删除 transcript；下一次搜索或读取同步移除派生索引，已经删除的正文不得从索引返回。`/new` 只重置当前上下文，不等于删除历史聊天。
- 工具轨迹、推理、运行时提示和内联二进制不属于普通聊天正文；transcript 对这些数据的裁剪不应被描述为完整工具审计。

## 7. 关键实现

- `mona/materials/knowledge.py`
- `mona/materials/vision.py`
- `mona/materials/compile.py`
- `mona/materials/index.py`
- `mona/agent/tools/knowledge_search.py`
- `mona/config/paths.py`
- `src-tauri/src/materials.rs`
- `mona/session/conversation_history.py`
- `mona/agent/tools/conversation_history.py`
- `mona/webui/transcript.py`
