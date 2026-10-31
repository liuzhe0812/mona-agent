# Mona 检索架构

- 状态：Accepted
- 最后更新：2026-10-31

## 1. 信息源与产品边界

用户笔记与 Agent 私有知识是独立信息源：

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
- 旧库默认 `all` 仅由 Mona 承接；伙伴只有旧 `specific` 明确指定的库才可迁移或读取，不能把默认访问范围当成资料归属。已误迁入伙伴的旧库副本在首次恢复时撤出并保留原文存档，独立上传和明确指定的资料不受影响。
- 用户笔记和 Agent 设置中的私有知识保持独立业务概念。普通 Work、伙伴和子任务通过 `search_memory` / `read_memory` 统一发现与读取；`notes_search`、`notes_read`、`knowledge_search`、`knowledge_read` 保留为底层来源和授权名称，不再作为有统一入口时的普通模型工具。
- Agent 知识内部的上传资料、提取文本和编译 Wiki 是同一知识流水线的存储层，不作为独立用户工具。旧 `materials_*`、`wiki_*` 名称只保留内部兼容实现。
- Agent Knowledge 的底层引用使用 `ak:` 前缀；读取时再次绑定当前 Agent，并生成带 `agentId` 的 `mona:material` 链接。旧 `kb:` 引用继续经过旧知识库权限校验，只用于迁移兼容。
- 统一搜索返回工具注册表内的临时引用句柄，不保存来源正文；读取时重新校验来源授权和归属。句柄过期、注册表重建或进程重启后需重新搜索，不能把句柄当作持久引用。
- 查询保留原输入，空来源可使用 Unicode、空白和常见标点规范化版本；模型可在同一次工具调用中提供最多 3 个 `alternatives`，将翻译和同义短语作为备选而非必需同时匹配的词。每个已授权来源独立补查，不因其他来源有命中而停止；仍为空的无游标 2–4 词短查询逐词补查，结果标记 `match_mode=any_term` 和 `matched_terms`。来源失败不当作空结果，也不参与重复补查。
- 结果按来源内名次做倒数名次融合，不跨来源直接比较 BM25；引用去重后返回全局 `limit` 条，同分时优先未过时原文和已完成的用户原话。`rank_score` 不是答案置信度，返回 `matched_queries` 和来源的 `count/returned_count` 供核对；未返回完的来源须收窄来源重查，不能把源分页游标当作全局分页。
- 搜索命中只是候选，必须回读并确认其确实回答了问题；区分用户原话、原文资料、助手建议和 AI 总结，Wiki 事实跟随原文引用验证。无命中不能推断用户从未提供过信息。检索不调用额外模型或向量服务，同义备选由当前 Agent 提供；任意同义或跨语言理解不作为关键词检索的保证。
- 统一检索默认只查询当前已注册、已授权的 Notes、Knowledge、会话正文和私有记忆来源；未配置的来源不能由统一入口自行实例化。归档事件 `events` 仅在显式选择时查询，例如 `sources=['events']`；它来自旧 `history.jsonl` 记录，按摘要标识，不能当作聊天原话。来源失败与部分覆盖须明确返回，不能视为无匹配。
- 底层来源仍受各自工具授权和笔记本范围约束；`contextLevel=none` 的笔记不可读取，`summary` 只返回预览，`full` 才返回全文。统一入口不授予新权限。Dream 使用独立工具集，继续使用 `memory_read`、`memory_search` 和 `memory_edit`。

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

Mona 不把全部笔记、知识或收藏拼入 system prompt。Agent 根据任务显式调用检索工具；未经检索取得的内容不能伪装成用户知识。当前没有向量库、图数据库或查询时的模型改写，UI 和文档不得宣称未验证的语义检索能力。

## 6. 会话历史检索

桌面普通直聊的可见聊天正文由 WebUI append-only transcript 持久化，独立于用于模型回放的 `sessions/*.jsonl`。Session 的消息数量上限、上下文裁剪和交接摘要不能删除 transcript 中已经成功保存的正文。

- 会话历史使用本地 SQLite FTS5 关键词索引，不使用向量、embedding、图数据库或查询时 LLM 改写。索引是可重建派生数据，transcript 是正文事实源。
- 会话来源通过底层 `conversation_search` 只搜索当前工作区、当前运行时 Agent 所属的普通直聊；协作房间、隐藏任务、临时会话和其他 Agent 的会话不进入结果。
- `read_memory` 通过底层 `conversation_read` 使用搜索返回的服务端引用，并在读取时重新校验会话归属和原始 transcript；预览、分页和读取不能接受模型传入的路径或 Agent ID 扩大范围。没有会话来源的子任务不能自行创建该来源。
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
- `mona/agent/tools/unified_memory.py`
- `mona/config/paths.py`
- `src-tauri/src/materials.rs`
- `mona/session/conversation_history.py`
- `mona/agent/tools/conversation_history.py`
- `mona/webui/transcript.py`
