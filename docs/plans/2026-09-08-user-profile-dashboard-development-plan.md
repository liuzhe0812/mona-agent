# 用户画像仪表盘与 AI 建议开发计划

- 日期：2026-09-08。
- 状态：已按 2026-09-08 最终三页签范围实施并完成定向验收；真实模型建议内容质量仍待有可用模型时验证。
- 目标读者：接手开发的主 Agent、承担独立子任务的 Luna、最终验收 Agent。
- 配套提示词：[用户画像 AI 建议提示词](../design/2026-09-08-user-profile-advice-prompt.md)。两份文件共同交付，不依赖原始聊天记录。
- 执行范围：数据、证据、建议起步链路及三个仪表盘页签均已实现。最终界面范围以第 0.1 节为准，它覆盖本文较早的编辑器、反馈设置和成果管理型页面描述。

## 0. 接手方式与约束

1. 先阅读根目录 `AGENTS.md`、`docs/architecture/engineering-boundaries.md`、`docs/architecture/module-invariants.md`、`docs/architecture/user-profile-distillation.md`、`docs/architecture/services-split-design.md`、`docs/design/mona-ui-design-system.md`。
2. 核查当前工作树，不从 HEAD 还原本计划涉及文件。本计划基于 2026-09-08 的工作树；已有画像、多 Agent、会话、产物和 UI 改动必须保留。
3. 下文路径均相对仓库根目录。列出的函数名是定位入口；行号可能随其他任务变化，不应依赖行号做替换。
4. 先完成数据契约和持久化，再并行做独立 UI 与采集器任务。复杂判断、共享文件整合、跨进程验收由主 Agent 承担，边界清楚的任务交给 Luna。
5. 每完成一批，在第 14 节登记修改文件、命令、实际结果和遗留问题。不得把设计完成、类型通过或假数据截图写成实际功能完成。
6. 不发布版本、不改生产配置、不读取真实私人记录做测试、不替 Agent 完成建议中的任务来证明建议有效。
7. 本文已经确定首版产品和技术选择，执行者不用重新选择架构。遇到代码已变化时先验证差异，保持本计划的用户行为和架构不变量，并把适配记录补入本文件。

### 0.1 最终界面范围修订

用户在实施阶段最终确定三个并列页签：「我的画像」「变化轨迹」「AI 建议」。画像页面只承担近 30 天综合数据仪表盘，不放身份卡、人物简介、画像编辑器、反馈设置、成果采纳管理或大段文本卡片。页面采用扁平分区、真实计数和可追溯证据；三个页签没有总分或逐级关系。

本修订只改变画像页面的信息架构。显式用户上下文、建议反馈、成果采纳等后端兼容契约仍保留，供既有 API 和 Agent 上下文使用；本次仪表盘不提供这些管理入口。第 1 节和第 3 节中与本修订冲突的旧页面描述不再作为验收要求。

## 1. 用户目标与需求对应

画像定位为“AI 眼中的用户，以及用户使用 AI 的综合数据仪表盘”。用户应看见真实活动、可纠正的理解、有依据的变化和能直接起步的建议。

| 编号 | 必须达到的用户结果 | 实现位置 | 验收编号 |
|---|---|---|---|
| R1 | 首页不再以痛点和开放问题定义用户 | 人物画像页、画像提示词、自动摘要 | A01、A02 |
| R2 | AI 建议有真实依据，直接附知识、练习、模板或清单 | 建议任务、建议卡片、来源抽屉 | A08–A12 |
| R3 | 用户能修改 AI 对自己的理解，后续更新保留修正 | 显式修正 API、存储、画像投影、编辑器 | A03–A05 |
| R4 | 使用统计不把频次当能力、工具成功当成果质量 | 仪表盘计算、三个页签、旧图表适配 | A01、A06、A07 |
| R5 | 用户能回看 AI 已生成的成果，确认哪些已采纳 | 成果采集、列表、采纳反馈、现有打开入口 | A13、A14 |
| R6 | 近期变化比较同一来源范围内的相邻等长窗口 | 时间窗、聚合、变化页 | A06、A15 |
| R7 | 点建议能带背景开始，且系统生成请求不污染画像 | 建议起步请求、聊天入口、消息来源标记 | A10、A16 |
| R8 | 空数据、失败、旧数据和并发更新均有正确表现 | 服务、存储、页面状态、迁移 | A17–A21 |

### 1.1 首版必须做

- 三个并列页签固定为「我的画像」「变化轨迹」「AI 建议」，继续使用现有页面壳和共享组件。
- 「我的画像」展示关注领域、主题关联、协作类型、常见交付物和领域与协作方式矩阵。
- 「变化轨迹」展示相邻等长窗口的真实计数、话题趋势、前后对比、关注结构、30 天活动日历和首次出现主题。
- 「AI 建议」每次展示一条最值得用户知道的道理或知识，并给出怎么提升及实际搜索得到的参考资源。
- 统一近 30 天分析口径，保留证据查看、成果打开和来源会话跳转，不在仪表盘加入编辑、设置或反馈管理。
- 移除技能、成长、质量等不能由现有信号支持的结论，只展示真实可解释的计数。

### 1.2 本次不做

- 画像身份卡、画像编辑表单、建议反馈设置、成果采纳管理和大段人物描述。
- 人格诊断、能力总分、同行排名、自动推断心理状态、估算节省工时或收益。
- 独立课程系统、长期学习打卡、自动创建待办、自动执行建议、外部资源推荐爬虫。
- 7/30/90 天切换、跨全部历史工作区搜索、全局行为数仓或新向量检索服务。
- 从邮件正文、联系人或其他 Agent 私有记忆中扩展采集。
- 重新设计全应用导航、引入新图表库、批量重构聊天流程或 Agent 核心循环。

## 2. 已核实的现状与必须修复的问题

| 入口 | 当前行为 | 本次改造要求 |
|---|---|---|
| `webui/src/components/profile/ProfileView.tsx` | 三个页签；手动调用 `triggerDistill("all")`；向人物页传 `onAskMona` | 保留壳，更新页签、状态与回调契约 |
| `ProfileTab.tsx` | 痛点、开放问题、话题分布、知识图、技能矩阵、人际网络和关键洞察并列 | 调整信息优先级，加入理解、建议与修正入口 |
| `TrajectoryTab.tsx` | 关键词新增被展示为掌握技能；存在合成参考线和需要补强数值 | 移除无依据的数值与能力判断，重做可比窗口变化 |
| `WorkPatternTab.tsx` | 工具调用成功率被称为完成质量；调用链重复展示 | 展示使用与成果，工具执行数据默认折叠 |
| `mona/distill/scoring.py` | 技能级别来自关键词相对数量；新增技能来自关键词差集 | 新 UI 不消费这些能力评分；新摘要不再写“深度掌握” |
| `mona/templates/distill/profile.md` | 把提炼痛点列为最重要任务；没有建议结构 | 画像任务改为理解用户，建议单独生成 |
| `collectors/session_collector.py` | 按更新时间取至多 50 个会话；没有消息级时间、来源 ID；长会话后部可能缺失 | 保留真实作者过滤，补足近期事件、来源和抽样覆盖 |
| `collectors/notes_collector.py` | 技术词表、标题、标签为主；同一笔记标题和标签可重复计数；recent_titles 不是真实时间排序 | 标明材料记录口径，按笔记去重，日期有效时才能进时间比较 |
| `tasks/profile.py` | 只给会话 collector 传 since；笔记、邮件仍是全量；调用工作模式任务的私有 `_call_llm` | 明确各来源窗口；建议使用自身提示词和预算 |
| `mona/api/server.py` 的 `handle_profile_*` | handler 定义在 Gateway 代码文件，但由 Services 注册 | 不新建重复路由，不借用不存在的 Services AgentLoop |
| `mona/services/server.py` | 注册 `/api/profile*` | 新画像业务路由继续由 Services 注册，复用本地令牌鉴权 |
| `mona/distill/service.py`、`mona/cli/commands.py` | 手动在 Services，定时在 Gateway；只有进程内锁 | 两个入口复用跨进程互斥，防止同时生成和丢失写入 |
| `mona/distill/store.py` | 每次 rich 写入都改变 last_distilled_at；用户改 USER.md 不增 revision；结果整块替换 | 区分更新时间与生成时间，显式状态独立保存，锁内重新读取合并 |
| `tasks/profile.py`、`snapshot.py` | Current Focus 自动写入，又被当成用户显式内容 | 停止自动覆盖用户焦点；确认值优先，自动观察另存 |

工程基线与长期架构中的“用户修正优先”“用户级存储”“真实信号归因”必须保留。现状与这些要求冲突的部分是修复项，不应继续复制。

## 3. 页面与交互定稿（第 0.1 节修订优先）

### 3.1 页面壳

- 继续复用 `ProfileView` 和现有 Tabs；内部值保留 `profile`、`work-pattern`、`trajectory`，改变显示顺序和中文名称。
- 顶部：画像标题、近 30 天、上次更新、一个「更新画像」按钮。把“蒸馏”从普通用户操作文案中移除。
- 顶部来源说明可展开：当前数据范围、各来源有效时间、采样与缺失情况、版本。首屏不突出数字置信度。
- AI 观察使用「AI 观察」，用户覆盖使用「你已确认」，数据不足使用具体缺口说明。AI 自评分仍可兼容保存，但不展示为精确概率。
- 使用共享 `Button`、`Dialog/Sheet`、`StatusNotice`、语义 Token 与现有页面布局。不得新增任意产品色或通过修改全局 CSS 调整单页。
- 先做桌面宽度 1280、窄面板 900 两种布局；窄面板单列，正文不截断关键行动，不横向滚动表单。

### 3.2 AI 眼中的我

从上到下：

1. 一个主摘要面：角色与背景、当前目标，最多两三句话；存在用户覆盖时，摘要直接使用有效覆盖值，不能继续展示相矛盾的旧 AI 描述。
2. 「Mona 给你的建议」：最多 3 条，第一条默认展开；其余显示标题、理由和首步摘要，可展开完整起步材料。没有建议时展示实际原因，不显示通用鸡汤占位。
3. 「我的关注与做事方式」：近期关注主题、偏好、做事方式；每项提供依据与修改。主题没有统一测量口径时只作为观察列表，不显示伪精确百分比。
4. 「支撑这些观察的记录」：笔记标签/分类真实计数和参与分析的记录概览，作为次级内容；人际网络从首页移除，首版不增加邮件联系人展示入口。

删除首页的痛点块、开放问题列表、投入最少警示和重复关键洞察。不得只改标题、保留原痛点列表当建议。

### 3.3 建议卡片

- 显示：维度、具体标题、为什么适合现在、第一步、可直接使用的起步内容、产物、完成标准。
- 次要操作：「查看依据」「有用」「不适合」「已完成」。不适合原因枚举：已掌握、现在不需要、判断有误。
- 主操作：「一起开始」。先显示可编辑的请求预览，再通过现有 Mona 会话通路发送；预览体现将带入哪些来源摘要。关闭预览不发消息。
- 「已完成」仅代表用户对该建议的反馈，不能自动转成某项技能已掌握，也不自动把相关成果标成已采纳。
- 完成/不适合后从当前推荐位移走，提供撤销；历史建议入口显示最近 100 条内的保留记录。撤销不创造新的依据或日期。
- Markdown 起步内容走现有安全渲染，不使用未清洗 HTML；来源跳转地址由应用解析，模型只输出来源 ID。

### 3.4 理解修改

核心界面固定五个字段：`background`（角色与背景）、`current_focus`（当前目标）、`preferences`（协作偏好）、`work_context`（工作方式与环境）、`interests`（关注领域）。另保留 `special_instructions`（其他协作要求），折叠在偏好编辑区域，完整承接旧 USER.md 显式约束；该字段只允许用户填写，不让 AI 推断。

- 每项可以「修改」「暂不展示」「恢复 AI 观察」。修改采用文本框，不做复杂标签编辑器。
- 修改是用户显式覆盖，不是让 LLM 判断用户是否说得对。
- 用户保存后页面立即显示服务端返回的有效值，Agent 的下一次上下文快照也使用同样的值。
- 「暂不展示」抑制该字段在页面与默认 Agent 快照中的自动推断；「恢复 AI 观察」删除覆盖，重新显示现有自动观察，不自动调用模型。
- 冲突时保留正在编辑的草稿，展示已变化的服务器值，让用户重新保存；禁止无提示覆盖。
- special_instructions 的 reset 操作命名为“清除补充要求”，不称为恢复 AI 观察；用户主动清除前仍保留导入的明确约束。

### 3.5 使用与成果

- 顶部只保留可解释的近 30 天计数：主动对话数、真实用户消息数、活跃日期数、已记录生成成果数。没有来源时为“暂无数据”，读取成功且无记录才是 0。
- 主区域：最近生成成果列表，含标题、类型、首次记录日期、来源会话、生成 Agent（能可靠归属时）、已生成/你已采纳状态。
- 提供现有成果打开方式和来源会话入口；用户可标记“已采纳”及撤销。打开、下载、预览都不等于采纳。
- 活动趋势采用真实每日计数，区分用户消息与 AI 执行活动，不能把后台工具运行时段当成用户作息。
- 工具排行、执行成功率和典型调用链置于默认折叠的“AI 执行详情”；成功率明确命名为工具执行成功率。无计数时只列名称，不以名次伪造计数。

### 3.6 近期变化

- 展示本期 30 天与前一期等长窗口的主动对话、消息、已记录成果数量变化，以及有来源支持的关注主题变化。
- 无前期可比数据时显示“尚无可比较的记录”，不补 0、不生成参考线。
- 有完整前期采集且值为 0 时允许显示增加的绝对值，增长率为 null，文案为“从 0 增至 X”。
- 删除“新增掌握技能”“累计掌握技能”“需要补强 Top 3”、综合成长分、由固定公式合成的变化值。
- 原知识图若保留，仅能称为“笔记主题关联”，边代表同一笔记共现；首版默认使用更直接的主题列表和计数，不为保留图表而造新评分。

## 4. 数据窗口、统计口径与来源

### 4.1 时间与范围

- 固定 `window_days=30`。一次管线开始时获取一个带时区的 `as_of`，全管线复用。
- 使用半开区间：本期 `[as_of-30天, as_of)`，前期 `[as_of-60天, as_of-30天)`；在 UTC 上比较时间，按配置时区显示和聚合日期。
- 旧消息无时区时按 `profile.timezone` 解释，并计入 `assumed_timezone_count`；日期无法解析或缺失则计入 `unknown_time_count`，不进入近期计数和“最近”结论。
- 旧会话 `updated_at` 只能帮助发现候选文件，不可替代每条用户消息的时间。
- 用户级存储不意味着已扫描全部工作区。首版数据源仍为当前配置工作区内允许范围的会话、已配置笔记库以及当前可验证的成果记录；不遍历磁盘寻找其他工作区。
- 计算 `source_scope_id`：对当前工作区和授权笔记来源的规范化标识做 hash，仅用于可比性。UI 展示可理解的来源名称，不展示内部完整路径。
- 来源范围切换后，保留用户确认值和建议反馈；旧自动观察标记来自上次数据范围，当前与旧范围不做增长比较。
- 比较可用性按指标所属来源判断：同一 scope、两期均可完整扫描，且该来源存在本期起点以前的真实日期记录，才展示前期对比；否则 comparison_reason=`no_previous_observation`。若来源历史已延伸到前期起点以前、扫描完整且前期恰无记录，则前期 0 是有效值。部分读取、日期缺失会影响该指标覆盖时返回 partial，默认不生成变化结论。此处比较的是“已保留记录”，不声称覆盖用户在其他设备或被删除的活动。

### 4.2 指标字典

| 指标 | 确定性计算 | 不能推导 |
|---|---|---|
| 主动对话数 | 窗口内至少一条合格真实用户消息的可见会话 key 去重数 | 已完成任务数 |
| 用户消息数 | 真实用户消息按来源标识去重后计数 | 提问质量、知识不足 |
| 活跃日期数 | 用户消息时间按配置时区映射的不同日期数 | 在线时长、工作强度；滚动窗口可能触及 31 个日历日期，不能当出勤率 |
| 话题记录数 | 同一个主题在同一份笔记最多计 1；按笔记/会话来源分别说明 | 精通程度、总知识量 |
| 已记录生成成果数 | 有真实持久化生成/交付记录且可归属可见会话的成果 ID 去重数 | 用户已采纳、任务已完成 |
| 你已采纳 | 用户明确标记的成果数 | 经济收益、节省时间 |
| 工具执行成功率 | 现有真实工具结果口径的 success/total；total=0 时为 null | 任务完成质量或用户能力 |
| 变化值 | 当前值减同口径前期值；缺失任一值时为 null | 技能增长 |

禁止混加“笔记篇数 + 工具次数 + 消息数”作为综合分。统计来自完整可读记录扫描，LLM 来源选择来自有界抽样；两者不能共用一个不注明口径的分母。

### 4.3 近期用户证据采集

在 `session_collector.py` 内扩展现有采集结果，不新建读取所有私有记忆的通用检索器：

1. 沿用 `_is_profile_user_message`、作者规范化、隐藏房间/后台/内部任务过滤。
2. 流式扫描允许范围的会话，分别累计本期和前期确定性统计；计数不因 LLM 抽样上限下降。
3. 每条保留会话 key、真实消息时间、消息定位信息、作者类型、内容 hash。优先复用已有稳定消息 ID；没有时使用会话 key + 原始消息序号 + 时间 + 内容 hash。重扫同一文件得到同一 ref。
4. 去重优先使用已有源消息/事件 ID。没有跨会话原始 ID 时，不凭相同文字合并不同会话的真实需求；缺少身份信息的疑似复制记录不得用于声称多次独立出现。
5. 先过滤时间和归属，再选取至多 50 个不同会话、200 条消息进入 LLM 候选。选择为按会话轮转的最近消息，每轮每个会话一条，保证长会话末尾的修正能进入候选。前期证据另保留最多 50 条用于变化描述，共享总输入预算。
6. 单条摘要最多 1200 字符，采用明确的首尾保留并记录 `truncated=true`；不要在模型工具结果层添加通用截断。来源详情中的预览最多 600 字符。
7. 输入总预算默认 12000 tokens，实际输入上限为 min(该配置, 模型上下文上限减输出预留)；再扣固定提示词和显式上下文后分配给完整来源项。复用 `mona/utils/helpers.py::estimate_prompt_tokens_chain`；无法精确匹配提供商时保守估计并记录预算来源，不把字符数当准确 token 数。
8. 所有舍弃记录只进入计数和覆盖信息，不能让模型声称“已读全部会话”。

### 4.4 笔记、邮件、成果

- 笔记：保留配置库范围检查；补相对路径/稳定 ID、有效日期、标题、标签和来源 ref。按真实日期排序 recent_titles。同一关键词在标题和多个标签重复时，一份笔记仍计 1 次。
- 首版不把笔记正文大规模送入模型，标题/标签只支持“材料主题”观察；不能据此得出精通知识。已有明确授权的正文检索留给用户点击建议后按现有知识库能力执行。
- 邮件：不新增读取；从新的理解与建议模型输入中移除联系人、邮件主题和正文，首版也不展示人际网络。现有统计代码可保留用于历史兼容，不扩大本次改动。
- 成果：第 8 节固定复用已有产物机制；仅取元数据，不打开文档正文来猜质量。未知生成日期不可用文件修改时间冒充；只能在“日期未知”的次级历史列表中展示，排除时间比较。

## 5. 持久化与前后端契约

### 5.1 存储所有权

继续使用用户级 `profile/` 目录，主事实文件为 `profile.rich.json`。升级到 `version="3.0"`，保留原有未知字段和历史快照。

| 顶层字段 | 写入者 | 作用 |
|---|---|---|
| `facts.explicit_context` | 用户修正 API | 五项核心覆盖及 special_instructions，模型不得写入 |
| `facts.context_revision` | 用户修正/导入 | 显式上下文版本，用于识别生成期间的用户修正 |
| `profile.understanding` | 画像任务 | AI 对五个字段的观察及证据，用户覆盖不存这里 |
| `dashboard` | 确定性聚合 | 时间窗、覆盖、本期/前期指标、每日数据、成果元数据、主题记录 |
| `advice` | 建议任务只写生成字段 | 当前建议 ID、保留条目、输入指纹、生成状态 |
| `feedback.advice` | 用户反馈 API | 建议有用/不适合/完成状态及 item revision |
| `feedback.artifacts` | 用户反馈 API | 成果已采纳状态及 item revision |
| `evidence_index` | 采集/生成提交 | 仅保留当前理解和保留建议/成果实际引用的有界来源摘要 |
| `revision`、`updated_at` | 存储层 | 每次成功持久化修改递增版本、记录时间 |
| `last_distilled_at` | 成功生成提交 | 仅记录成功画像生成时间；用户反馈不能改它 |
| `projection_error` | 存储层 | null 或 `{code:"user_projection_failed",occurred_at,profile_revision}`，不含原始正文 |

新类型集中在 `mona/distill/models.py`（新增）和 `webui/src/lib/profile-api.ts`。使用现有 Pydantic，禁止引入额外 schema 框架。新增接口输入不接受任意 dict 穿透到文件。

### 5.2 核心类型

以下 TypeScript 是跨端协议定义，不要求生成代码工具。Python 字段含义、空值和枚举必须一致。

```ts
type ObservedProfileField = "background" | "current_focus" | "preferences" | "work_context" | "interests";
type ProfileField = ObservedProfileField | "special_instructions";
type AdviceDimension = "learning" | "method" | "reuse" | "opportunity";

interface ExplicitContextValue {
  mode: "override" | "suppress";
  value: string; // suppress 时为空；新提交 override 为 1–2000 字符，旧内容导入不截断
  updated_at: string;
}

interface UnderstandingItem {
  field: ObservedProfileField;
  text: string; // 1–500 字符
  source_refs: string[]; // 1–5 个有效 ref
  observed_at: string; // 服务端取依据的最新真实时间
}

interface EvidenceRef {
  ref: string;
  kind: "user_message" | "note" | "artifact" | "explicit_context";
  source_scope_id: string;
  title: string;
  occurred_at: string | null;
  excerpt: string; // 不超过 600 字符
  truncated: boolean;
  session_key?: string;
  message_id?: string;
  message_index?: number;
  note_relative_path?: string;
  artifact_id?: string;
  content_hash: string;
}

interface AdviceContent {
  id: string; // 服务端生成，模型不能创建
  dimension: AdviceDimension;
  title: string;
  why_now: string;
  source_refs: string[];
  first_step: string;
  starter_content: string;
  expected_output: string;
  done_when: string;
  start_prompt: string;
  created_at: string;
  last_supported_at: string;
  source_scope_id: string;
}

// 仅用于模型返回，不持久化 reuse_id；服务端解析后生成 AdviceContent.id。
interface AdviceModelItem {
  reuse_id: string | null;
  dimension: AdviceDimension;
  title: string;
  why_now: string;
  source_refs: string[];
  first_step: string;
  starter_content: string;
  expected_output: string;
  done_when: string;
  start_prompt: string;
}

interface AdviceFeedback {
  revision: number;
  useful: boolean | null;
  disposition: "active" | "dismissed" | "completed";
  dismiss_reason: "already_known" | "not_now" | "incorrect" | null;
  updated_at: string;
}

interface MetricValue {
  value: number | null;
  availability: "available" | "partial" | "unavailable";
}

interface SourceCoverage {
  source: "sessions" | "notes" | "artifacts" | "agent_execution";
  status: "available" | "partial" | "unavailable";
  scanned_count: number;
  selected_count: number;
  unknown_time_count: number;
  assumed_timezone_count: number;
  truncated_count: number;
  earliest: string | null;
  latest: string | null;
  reason_code: string | null;
}
```

`dashboard.metrics` 固定四个键：`active_conversations`、`user_messages`、`active_dates`、`generated_artifacts`。结构为 `current`、`previous`、`delta`；可比性使用 `comparison_available` 和 `comparison_reason` 表达，不由前端猜测。

`dashboard` 同时包含 `as_of`、`window_start`、`window_end`、`previous_start`、`source_scope_id`、`timezone`、`coverage`、`daily_activity`、`artifacts`。`daily_activity` 每项是日期和用户消息数；工具活动使用独立字段，不混入该数值。

`GET /api/profile` 额外返回只读 `effective_context`：按五个核心字段及 special_instructions 输出 `{field, value, origin, source_refs}`，origin 为 `confirmed|observed|suppressed|missing`；special_instructions 不允许 observed。此字段由存储中的确认值和自动观察计算，不接受客户端或模型直接写入。前端和 snapshot 共用同一个有效值计算函数，避免两套优先级。

`advice` 包含 `current_ids`（0–3）、`items`（最多 100）、`generated_at`、`last_attempt_at`、`generation_status`（`ready|empty|unavailable|failed|stale`）、`empty_reason`、`input_fingerprint`、`context_revision_used`。`generated_at` 只在成功输出时更新。

时间写入边界必须落实到存储函数：`write_rich_profile(..., distilled_at: str|None=None)` 默认只递增 revision、更新 updated_at，并保留原 last_distilled_at；只有新人物理解成功提交的调用方显式传 distilled_at。dashboard 提交只更新自身 as_of，advice 成功只更新 advice.generated_at，工作模式只更新 work_patterns.generated_at；context/feedback/投影修复均不传 distilled_at。保留历史时间为空，不用当前时间补齐。顶部数据范围使用 dashboard.as_of，理解更新时间使用 last_distilled_at，建议卡片使用 advice.generated_at，不能混用。

### 5.3 显式覆盖与 USER.md

- 新版显式覆盖的唯一事实源为 `facts.explicit_context`。`USER.md` 是人可读兼容投影，避免继续依赖两个同时可写却没有优先级的事实源。
- 有 override 时，用该字段完整替换同项 AI 观察；suppress 时不输出该字段；没有条目时才使用 AI 观察。
- 首次升级仅把明确手写段落逐字导入：`Basic Information→background`、`Preferences→preferences`、`Work Context→work_context`、`Topics of Interest→interests`、`Special Instructions→special_instructions`。不尝试把自然语言解析成额外角色标签。导入内容即使超过新提交长度也完整保存；模型/Agent 上下文另按预算裁剪，界面只在用户主动修改提交时校验新长度。
- 旧 `Current Focus` 可能是自动生成，保留原文作为 legacy 内容但不标为用户确认；只有新版明确编辑后才进入 current_focus override。迁移不得删除这段旧内容。
- 停止 `ProfileTask` 自动覆盖 `Current Focus`；自动 Profile 段只能从有效理解产生中性摘要，不写建议、联系人、“精通”或“反复困扰”等无依据标签。
- 保留旧 `/api/profile/user` 的读取与 PATCH 形状。对上述显式段落的 PATCH 必须同步为 facts 覆盖；新版编辑器不使用全文替换。全文 PATCH 解析明确用户字段并同步，其他未知段落按原文保留，不授权模型修改。
- 使用 rich JSON 原子提交作为事实保存的成功边界；USER 投影失败需记录顶层 `projection_error`，API 返回 HTTP 200、`ok:true` 和 `warning:{code:"user_projection_failed",message:"修改已保存，可读副本尚未同步"}`。页面显示警告，不能让用户误以为事实未保存而重复覆盖。Agent 快照仍读 rich 中的新确认值；GET 返回该错误状态。下一次明确写入/启动修复投影成功后将 projection_error 清为 null，不倒退事实，不声称两个文件天然具备事务原子性。rich 本身提交失败仍为真正保存失败，不返回 ok:true。
- 将这项事实源调整同步写入 `docs/architecture/user-profile-distillation.md`，并更新 `snapshot.py`。白名单仍只有 preferences、work_context、current_focus，不扩大成完整画像。
- 快照映射固定：preferences 接收有效 preferences 和 special_instructions；work_context 接收有效 background 和 work_context；current_focus 接收有效 current_focus 和 interests。每个字段各自遵守覆盖/抑制；内容仍作为数据、不能扩张工具权限。v3 不能在字段被 suppress 或新理解缺失时，回填旧 identity/deep_areas 来绕过该选择。

### 5.4 并发与版本

- 使用项目已有 `filelock` 依赖，不新增下载、锁服务或数据库。
- `profile/.distill.lock`：覆盖一次完整生成管线，手动和定时入口共用；冲突时立即返回“正在更新”，不再并行请求模型。
- `profile/.store.lock`：仅包围磁盘读改写和原子替换，不跨 LLM 调用持有。保留进程内 RLock，明确统一加锁顺序，避免嵌套新 FileLock 对象导致自锁。
- 锁顺序固定：生成入口 `_DISTILL_LOCK→.distill.lock`，磁盘提交 `_STORE_LOCK→.store.lock`；用户编辑只获取后两者，禁止先持有 store 锁再申请 distill 锁。同一 resolved profile 目录的嵌套 store 写操作共用同一可重入 FileLock 对象，或使用已持锁的内部写函数，不能重新构造锁对象。短 store 锁等待最多 5 秒，超时返回可重试错误；同进程生成锁已持有时也直接报忙，不排队隐藏重复请求。
- 所有写入在锁内重新读取最新 JSON，只更新所属命名空间；不得把生成开始时读到的整份 rich JSON 写回。
- 显式修改 API 使用 `expected_context_revision`；反馈使用该条目的 `expected_item_revision`。全局 revision 随所有成功修改递增，避免定时更新导致用户无关表单持续冲突。
- expected_item_revision 的唯一含义是 `feedback.advice[id].revision` 或 `feedback.artifacts[id].revision`，不是模型内容版本；不存在反馈时为 0。用户反馈有实际变化才 +1，完全相同的重复请求返回当前成功结果不增版本。生成沿用 id 或修改同一建议文案不增加该反馈 revision，不能改反馈。id 的目标/建议身份不能改变，换目标必须新建 id。A04/A12 分别验证过时且不同的反馈冲突与生成期间反馈不受损。
- 生成读取 context_revision；提交前发现显式修正变化，丢弃过时的 AI 理解/建议，标记 stale。确定性统计可独立提交，不能使用旧用户偏好覆盖新值。
- 建议生成期间有新反馈：提交时合并最新反馈并移除已完成/已忽略的当前 ID；不要求用户重做反馈。
- 迁移、USER 投影、快照写入与反馈都必须经过统一存储边界。文件锁放在现有用户画像目录，不接受 HTTP 传入锁路径。
- 在 service.py 定义明确的 `ProfileBusyError`，管线最外层用非阻塞 filelock 获取失败时抛出，不交给通用 DistillTask.run 吞成普通失败。手动 handler 捕获并返回 HTTP 409 `profile_busy`；Gateway 定时入口捕获后记录“已有更新，本次跳过”，不追加重试 cron、不写失败结果、不再次请求模型。所有异常/取消路径 finally 释放锁。

## 6. 模型职责与提示词接入

### 6.1 固定生成顺序

沿用 `run_all_distill`，顺序改成：

1. 采集并生成本期/前期的确定性 dashboard；统计来源失败时记录 coverage。
2. 工作模式任务（仍然只描述 Agent 执行）。
3. 人物理解任务（显式上下文 + 真实用户证据 + 笔记元数据）。
4. 独立 `AdviceTask`（新增 `mona/distill/tasks/advice.py`），使用本次有效理解、近期证据、历史建议与最新反馈。

工作模式失败不能阻止有充分用户证据的人物理解；人物理解失败时，建议只允许使用显式目标和本期证据，不能把旧画像伪装成本期推断。建议失败不能清空已成功的仪表盘。

新增任务只更新 `advice` 生成字段，不写 USER.md，不追加完整建议进历史轨迹。现有结果协议扩展 task 枚举含 `advice`；`all` 返回各阶段结果，前端显示具体成功/失败范围。

### 6.2 画像提示词改写要求

在 `mona/templates/distill/profile.md` 替换“痛点最重要”的任务：

```text
你负责描述 Mona 在已授权记录中如何理解用户。
分别总结角色与背景、当前目标、协作偏好、工作方式与环境、关注领域。
每项使用真实来源 ID；缺少证据则不输出该项。
显式用户覆盖优先，不能用模型推断改写用户已经确认或要求隐藏的内容。
区别用户自己的要求、用户引用的材料和 AI 的执行行为。
不要把关键词次数、笔记数量、提问次数和工具调用变成技能水平或人格结论。
不要输出痛点清单、开放问题清单、建议或能力评分。
输出 understanding 数组，每项只有 field、text、source_refs；field 必须属于五个固定字段。
```

新模型输出只包含 understanding。存储保留旧 profile 中未知字段以支持历史回看，但新增 UI 和 snapshot 只消费 understanding 的有效值。不得保留“深度掌握”自动段落作为隐藏的旧结论继续注入 Agent。v3 管线停止调用用于能力评分的 compute_radar_scores/build_skill_matrix 和旧 save_snapshot 副作用；已有历史快照保留，新变化来自 dashboard 的两个窗口。

### 6.3 建议提示词

- 固定系统提示词使用配套提示词文档第 3 节全文，动态数据使用第 4 节；运行文件分别为 `mona/templates/distill/advice_system.md`、`mona/templates/distill/advice.md`。
- 模型输出使用配套提示词已同步的内部枚举 `learning|method|reuse|opportunity`，中文显示分别为学习补充、方法改进、成果沉淀、关联机会；每条的 `reuse_id: string|null` 只能引用输入历史中已有 ID，首次建议为 null。该字段属于 AdviceModelItem，解析后映射为持久化 AdviceContent.id，不能要求前端再次做身份匹配。
- 另追加明确规则：“同一目标下同一建议的改写必须引用原 reuse_id；已完成或不适合的建议不重新输出。不要仅换标题重新推荐。”
- LLM 不生成 id、日期、反馈、置信度百分比或前端跳转 URL。服务端生成 id，并从有效来源计算 last_supported_at。
- 支持最多 3 条，允许空数组。一个明确用户需求可以支持建议；“反复出现”必须至少两个不同会话/日期的独立来源。
- 0 条是成功空结果，模型失败是失败，两者不能都写成“暂无建议”。
- 不使用现有 work_pattern 的私有 `_call_llm` 来调用 AdviceTask。建议独立配置 system prompt、输出长度和结构校验，并调用现有 usage 记录接口。

### 6.4 输入与输出控制

在 `mona/config/schema.py` 增加 `ProfileConfig` 并由根 Config 显式引用，首版不新增设置页：

| 字段 | 默认值 | 约束 |
|---|---|---|
| `window_days` | 30 | 首版只允许 30；暂不做 UI 切换 |
| `timezone` | Asia/Shanghai | 必须为有效 IANA 时区，不由工具活跃时段猜测 |
| `max_evidence_sessions` | 50 | 1–100 |
| `max_evidence_messages` | 200 | 1–400 |
| `max_message_chars` | 1200 | 200–4000 |
| `max_input_tokens` | 12000 | 2000–32000；还需服从实际模型上下文限制 |
| `profile_max_output_tokens` | 4096 | 正整数、服从提供商能力 |
| `advice_max_output_tokens` | 8192 | 正整数、服从提供商能力；不能沿用 2048 硬上限 |
| `llm_timeout_seconds` | 120 | 30–120；这是任务级上限，提供商自身更短超时仍优先 |
| `pipeline_timeout_seconds` | 360 | 60–600；all 管线总 deadline，包含采集与各阶段 |
| `max_advice_history` | 100 | 3–200 |

- token 预算不够时按完整来源项减少输入；不能在 JSON 半途截断。三条建议不是必须目标。
- 单次调用用任务级 asyncio timeout 包围 provider.chat，不改全局 provider 请求配置，也不声称将默认提供商的 120 秒延长。all 按总 deadline 的剩余时间限制下一阶段；超时/取消保留已经提交的统计和阶段结果，尚未运行项返回 `skipped`，超时项返回 `failed` + `timeout`，finally 释放管线锁。明确区分单项最长等待和三次串行请求的总等待。
- Pydantic 校验输出对象、枚举、字段类型、数量和长度。建议标题最多 80 字符，理由最多 600，首步最多 500，起步内容最多 2000，产物和完成标准各最多 500，start_prompt 最多 3000。
- 每条 source_refs 为 1–5，必须在本次输入的 evidence 集合内。不存在引用、空起步内容、非法 reuse_id 的条目不得显示。
- 原始模型响应不写日志或轨迹；记录错误码和字段位置即可。
- 不做无限修复调用或额外多 Agent 评审链。首版一次调用，失败保留仍有效的历史建议并标明上次更新时间；无历史则显示失败状态与重试。
- `input_fingerprint` 包含来源 ID/hash、有效用户上下文、相关历史反馈、窗口内成员集合和 prompt_version，不包含每次变化的当前时间字符串。输入未改变时复用结果，不能为刷新按钮无条件制造新建议。

### 6.5 建议状态与保留

- `current_ids` 决定当前最多三条；item 内容与 feedback 分开。同 reuse_id 更新内容时不改变 created_at，不清掉 feedback。
- 成功输出后，旧的未入选建议只进入历史，不算完成。失败不得把它们当成新结果重新盖时间戳。
- 某建议全部时间性依据都早于当前窗口，或原始来源已不可访问，则不再作为本期推荐；历史详情显示依据过期/不可用，不编造新依据。用户仍生效的显式目标/要求不因 30 天而过期，但不能把旧确认日期说成最近反复出现。
- 已完成/不适合不会自动重新推荐；用户撤销后，只有依据仍在当前范围才可回到当前候选，且不超过三条。
- 按最近使用时间保留至多 max_advice_history 条，当前建议优先保留，用户完成/拒绝记录在保留期内必须跟随；明确不承诺无限期记忆。
- evidence_index 只保留尚被理解、保留建议或当前成果引用的来源；每 ref 最多 600 字符。清理引用时先计算保留集合，不删除原会话、原文件或笔记。

## 7. API 定稿

所有以下路由注册在 Services，沿用 `mona/materials/auth.py` 对 `/api/profile*` 的保护；WebUI 用 `getServicesHttpBase` + `httpFetch`，不硬编码端口。

| 路由 | 请求 | 响应/行为 |
|---|---|---|
| `GET /api/profile` | 无 | 返回兼容 rich 结构和新 dashboard/advice/有效理解，不调用模型 |
| `POST /api/profile/distill` | `{task:"all"|"profile"|"work-pattern"|"advice"}` | 保留同步调用，新增 advice；all 按固定顺序执行，阶段状态 `success|empty|reused|failed|skipped`；忙时 409 `profile_busy` |
| `PATCH /api/profile/context` | `{field, mode:"override"|"suppress"|"reset", value?, expected_context_revision}` | 更新一个字段；reset 删除覆盖；返回 revision、context_revision、effective_context |
| `PATCH /api/profile/advice/{id}/feedback` | `{useful?, disposition?, dismiss_reason?, expected_item_revision}` | 合并该条用户反馈；返回该反馈和最新 revision/current_ids |
| `PATCH /api/profile/artifacts/{id}/feedback` | `{adopted:boolean, expected_item_revision}` | 只保存用户采纳状态，返回条目状态及版本 |
| `GET /api/profile/evidence/{ref}` | 已存在 ref | 返回有界来源摘要、可访问状态和应用可解析的定位信息 |
| `POST /api/profile/advice/{id}/start` | 无 | 只生成起步请求预览与来源摘要，不发消息、不执行任务 |
| `GET/PATCH /api/profile/user` | 兼容旧形状 | 经新的事实源同步边界读写，不再绕开 revision |

通用错误：400 输入非法、401 未授权、404 条目不存在、409 版本冲突或正在更新、410 原始来源已不可访问、503 依赖不可用。错误对象沿用现有 `error` 文本并增加稳定 `code`，不要求前端从英文错误文案猜原因。

生成返回值保留旧 `ok/success` 字段并增加阶段 `status/code`。all 已开始执行但部分失败时 HTTP 200、ok=false，逐项列出实际结果；请求依赖从一开始就不可用且完全未执行时可返回 503。空结果与 reused 均为成功阶段；skipped 不计成执行成功。前端不再仅用 success 数量拼一句“全部完成”。

新增 context / feedback 写 API 必须提供相应 expected revision；首次条目反馈 revision=0。旧 USER API 允许省略全局 expected_revision 以兼容现有调用，但新版 UI 不使用该兼容路径。提供旧 revision 时必须严格校验。

手动更新仍为现有同步请求；当前 native HTTP 对画像路由未设置启动读请求的 10 秒超时，无需为此引入任务引擎。页面显示更新中，重复点击禁用，其他只读操作仍可使用旧成功结果。网络断开后不能自动重复 POST；下次进入先读最新结果，用户再选择重试。

来源 ref 为不透明 ID，不能当文件路径。服务器只从已存 evidence_index 解析来源；会话必须仍为允许读取的可见会话，笔记解析后仍位于授权库，产物遵守原有文件访问约束。源码、路径或权限变化时应失效，不能扩大范围寻找“相似文件”。

## 8. 成果与聊天衔接

### 8.1 成果首版范围

- 规范模型为 `mona/agent/artifacts.py::ArtifactRef`，它已有 owner_kind、owner_id、relative_path、created_by_agent_id、created_at、session_id、room_id、job/workflow 等归属字段，但没有用户采纳字段。
- 新增 `mona/distill/collectors/artifact_collector.py` 仅做归集，不能再建一个复制产物正文的仓库。先由合格可见会话 key 构造读取范围，再复用 `mona/webui/transcript.py::read_transcript_lines` 读取 `event="deliver_files"` 中的结构化 artifact_ref；不读取 assistant 推理或整段工具输出作为画像文本。
- 不创建 WebSocketChannel 实例、不访问运行中的 SessionManager、不让 Services 调 Gateway 的内部 Python 对象。`mona/channels/websocket.py::_artifact_refs_from_session` 只作为现有语义参照，collector 复用纯 ArtifactRef 和 transcript 读取函数即可。
- 归集依据必须是用户可见会话内明确记录的生成/交付成果；参考附件、下载的参考资料、内部中间文件、隐藏执行房间的未发布文件不计为生成成果。
- 首版只统计持久化的显式 deliver_files 引用。AgentJob/Workflow 状态可说明执行完成，但不另行扫描未发布的内部 artifacts 来扩大统计；旧图片 sidecar、只有路径的 legacy 事件不强行补全归属，coverage 明确说明未包含。
- 同一成果的重复交付不能重复计数。画像去重键固定为 `(source_scope_id, owner_kind, product, owner_id, normalized_relative_path)`，与现有 session 路径去重口径一致；据此生成服务端稳定 hash ID。保留全部已知 ArtifactRef.id 作为定位别名，不能因每次 deliver_file 生成新 UUID 而重复计数。同一路径覆盖属于一份可反复更新的成果，本次不做版本产物计数。
- 时间使用原始持久化字段，不用模型默认值：解析前先核查 raw artifact_ref.created_at，缺失则视为未知，不能让 ArtifactRef 的“当前时间”默认值制造历史。对同一成果取允许记录中的首次明确交付时间作为统计日期，UI 文案为“首次记录”；它不等于实际文档最初创建时间。
- 已生成和用户采纳分开，采纳反馈在 `feedback.artifacts`；不能从 Agent 宣称“已完成”提取用户采纳。
- 文件失效时保留已生成的历史事实，显示“文件暂不可用”；打开必须重新走现有文件 API，不能由建议 API 返回任意路径供前端直接执行。
- 初次扫描无法可靠恢复旧成果日期或归属时，不伪造完整历史，标明“仅统计可验证记录”。
- `dashboard.artifacts` 返回最近 50 项（含已生成/已采纳状态），总计数扫描所有符合窗口和范围的显式记录后计算。条目协议为 `{id,title,mime,first_recorded_at,session_key,room_id,created_by_agent_id,artifact_ref,source_ref,missing,adopted,feedback_revision}`；除 source_ref 外不可由 LLM 生成。反馈只保存每个 id 的最新状态，不能为每次点击累积无限事件历史。
- transcript 当前超过 8 MiB 会被读取函数跳过，读取前应识别这个条件并将 artifacts coverage 标记 partial，不把跳过解释为没有成果。损坏/不可读取来源同理；不修改通用 transcript 限制来迁就本模块。

### 8.2 一起开始

- 保留 ProfileView→App 的接线位置，新增带类型的 `ProfileStartRequest`，内容含 prompt、advice_id、source_refs 和 `origin:"profile_advice"`。
- 起步请求由服务端从有效建议组装，包含任务目标、首步、产物标准和最多 3 条允许传入的来源短摘要；不假设 Mona 新会话知道别的 Agent 私有记忆。
- 前端先展示请求预览，用户可编辑后发送。未发送前不记为已开始，更不能标成已完成。
- 通过现有会话创建和发送通路传 origin/advice_id 元数据，保存到该条用户消息。采集器按结构化 origin 排除建议种子请求，不能按正文字符串前缀排除。
- 用户后续自行输入的真实消息按原规则采集；预览中由用户编辑的整条种子仍保留来源标记，避免混入自动附带的原证据。用户可以另外明确说明新目标作为真实信号。
- 不改 Agent 思考循环和工具权限；如果需要保留 origin，仅在消息入站与 Session.add_message 的元数据白名单处透传。
- 首版来源入口保证打开对应会话或成果；没有现成消息定位能力时，来源抽屉展示精确片段，按钮命名“打开原会话”，不能承诺跳到原消息。

### 8.3 已核实的接线文件与最小实现

| 接线点 | 已有能力 | 本次确定做法 |
|---|---|---|
| `App.tsx::onSelectChat` | 按完整 session key 切换原会话 | 给 ProfileView 增加 `onOpenSession(sessionKey)`，复用该入口 |
| `App.tsx::onTriggerAgent`、`QueuedAgentPrompt` | 新建 Mona 会话并排队自动发送 | 只在用户确认起步预览后调用；为队列条目添加可选 origin/adviceId，不改变其他调用方 |
| `ThreadShell.tsx` 的 queuedPrompt effect | 消费队列内容并 send | 将队列的 origin/adviceId 传到 SendOptions，确认只消费一次 |
| `useMonaStream.ts::SendOptions` 与 send | 发送专用上下文字段 | 增加 `origin?:"profile_advice"`、`profileAdviceId?:string` 并透传 |
| `mona-client.ts::sendMessage` | 组装 WebSocket payload | 发送相同字段，不复用 displayContent/taskId 充当 origin |
| `mona/channels/websocket.py` 用户消息入口 | 白名单构造 InboundMessage.metadata | 只接收该枚举和有界 ID，不允许任意客户端元数据穿透 |
| `mona/agent/loop.py::_persist_user_message_early` | 统一保存真实用户消息 | 从入站 metadata 仅复制上述两字段到 session message；不改推理/执行循环 |
| 房间用户消息保存分支 | 可能直接调用 session.add_message | 同样保留白名单标记；普通消息无标记时完全保持原行为 |

首版固定使用“画像内请求预览→确认后现有 queuedPrompt 发送”，不再同时实现 ThreadComposer.initialDraft 或另一套草稿恢复机制。仅填写草稿不能代替 origin 标记，因为最终发送仍包含系统生成的上下文。

成果打开复用 `webui/src/lib/api.ts::listArtifacts`（`GET /api/artifacts?session_key=...`）返回的 session_files 和 `useFilePreviewStore.open(file, scope, sessionKey, roomId)`；文件内容继续由 `FilePreviewPanel` 请求现有 file-preview API。Profile 的打开回调在 App 内先切换到原会话，再从 session_files 按结构化引用匹配并打开；不能使用 task_files/files 的目录扫描结果冒充交付记录。不要把 HTTP 请求 `scope` 写死，按现有 `ThreadShell` 的 owner/session/room 规则传递。

## 9. 文件任务清单与所有权

以下新文件仅按所列责任创建，不再拆出通用平台层。

| 文件/模块 | 必须修改的责任 | 默认负责人 |
|---|---|---|
| `mona/config/schema.py` | ProfileConfig 与校验 | 主 Agent |
| `mona/distill/models.py`（新增） | 新请求、结果、持久化字段的严格模型 | 主 Agent |
| `mona/distill/store.py` | 锁、读改写、版本、显式覆盖、反馈、投影、迁移 | 主 Agent |
| `mona/distill/snapshot.py` | 有效用户上下文优先级、隐私白名单 | 主 Agent |
| `mona/distill/base.py` | context 添加共享窗口、配置、采集输入；保留旧结果兼容 | 主 Agent |
| `mona/distill/service.py` | 四阶段顺序、跨进程互斥、失败合并与复用 | 主 Agent |
| `collectors/session_collector.py` | 真实消息事件、日期、抽样、计数、来源 | Luna A |
| `collectors/notes_collector.py` | 日期、来源、同笔记关键词去重 | Luna A |
| `collectors/artifact_collector.py`（新增） | 既有成果元数据归集 | Luna B |
| `mona/distill/dashboard.py`（新增） | 两个时间窗的纯确定性统计与可比性判断 | 主 Agent |
| `mona/distill/tasks/profile.py` | 理解任务、有效覆盖、停写自动 Current Focus、去掉假技能摘要 | 主 Agent |
| `mona/distill/tasks/advice.py`（新增） | 提示词、模型调用、schema/来源校验、候选选择 | 主 Agent |
| `mona/templates/distill/profile.md` | 人物理解新任务 | 主 Agent |
| `mona/templates/distill/advice_system.md`、`advice.md`（新增） | 从配套文档接入固定提示词和动态数据 | 主 Agent |
| `mona/api/server.py` | 现有画像 handler 与新 context/feedback/evidence/start handler | 主 Agent |
| `mona/services/server.py` | 新路由唯一注册 | 主 Agent |
| `webui/src/lib/profile-api.ts` | 类型、错误码、新 API | 主 Agent 先定稿，再交前端使用 |
| `ProfileView.tsx`、`ProfileTab.tsx` | 页面壳、理解、建议、新操作接线 | Luna C |
| `TrajectoryTab.tsx`、`WorkPatternTab.tsx` | 真实统计、成果、近期变化、旧数值移除 | Luna C |
| `AdviceCard.tsx`、`ProfileContextEditor.tsx`、`ProfileEvidenceDialog.tsx`（新增） | 建议、修正、来源交互 | Luna C |
| `webui/src/App.tsx`、`ThreadShell.tsx`、`useMonaStream.ts`、`mona-client.ts` | 类型化起步请求、预览后发送、队列一次消费、origin 标记 | 主 Agent |
| `mona/channels/websocket.py`、`mona/agent/loop.py` 的入站保存点 | 白名单元数据保存，含房间分支；不改核心循环 | 主 Agent |
| `mona/distill/scoring.py` | 只修本次仍使用的计数；旧能力评分不进入新版消费链 | 主 Agent |
| 对应 tests 文件 | 见第 11 节，测试随负责模块一起提交 | 各负责人 |

并行约束：models、profile-api、store、App、server 为共享契约文件，主 Agent 统一修改。Luna 不自行扩大返回字段或改共享模型；先返回所需差异由主 Agent 合并。

旧 charts 文件不因新首页不用就批量删除；先核查全仓引用。无关图表、颜色或格式化不属于本次重构。

## 10. 开发批次与完成条件

### P0：基线与契约（主 Agent）

- [x] 记录受影响文件的已有 diff，核查长期文档。
- [x] 按第 5、7 节建立 Python 模型、TS 类型、配置与合成 fixture。
- [x] 写出一个含用户覆盖、建议、来源、成果、前期统计的完整 v3 fixture，另备 empty、legacy、partial。
- [x] 明确各 Agent 文件归属再下发任务。

完成条件：前后端可以使用同一 fixture 表达全部必要状态；无字段待临时设计。

### P1：保存、修正与迁移（主 Agent）

- [x] 实现跨进程短写锁、统一 read-modify-write、revision/updated_at/last_distilled_at 区分。
- [x] 实现五个核心字段及 special_instructions 覆盖、USER 兼容投影及一次性导入。
- [x] 更新 snapshot 的覆盖/抑制/恢复优先级，停止 Current Focus 自动覆盖。
- [x] 新增 context API 与版本冲突行为。

完成条件：显式修改经过并发生成、再次更新和应用重启仍保留；旧数据逐字保留，快照不泄露建议与来源正文。

### P2：来源与真实统计（可并行 Luna A/B，主 Agent 整合）

- [x] 会话 collector 的过滤、逐条时间、稳定 ref、最近消息轮转抽样。
- [x] 笔记计数去重、日期与范围；成果归集。
- [x] dashboard 在两个等长窗口输出确定性统计、coverage、比较可用性。
- [x] evidence API 解析原始范围，并验证来源失效、路径越界与隐藏会话。

完成条件：无需 LLM 也能得到真实仪表盘；抽样影响观察覆盖，不改变完整扫描计数；无时间的历史记录不伪装成近期。

### P3：理解与建议（主 Agent）

- [x] 重写画像任务及中性摘要。
- [x] 接入独立 AdviceTask 与提示词、严格输出模型及引用校验。
- [x] 实现指纹复用、历史 ID 复用、反馈合并、建议过期与有限保留。
- [x] 让 all/profile/advice/定时入口服从互斥和相同显式优先级。
- [x] 新增建议反馈/start API；单项失败与空结果区分。
- [x] 用一个业务提示词综合近期聊天、已有画像、工作方式和目标，每次生成一条知识及解释和学习建议。
- [x] 用知识标题搜索公开资料，只保留实际搜索结果中的安全 URL。

完成条件：合成历史可生成针对性的建议；失败不清空有效结果；反馈期间生成提交不覆盖用户选择。

### P4：三个页面（Luna C，依赖 P0 契约；联调依赖 P1–P3）

- [x] 「我的画像」按最终原型实现五组数据可视化，并保留依据与成果打开入口。
- [x] 「变化轨迹」使用本期/上期真实统计、折线、对比、雷达、完整 30 天活动日历与首次出现主题。
- [x] 「AI 建议」按 11 原型实现单篇阅读页，依次展示知识及解释、怎么提升和参考资源。
- [x] 完成加载、空数据、失败、部分数据与旧版本兼容状态。
- [x] 移除技能分、合成参考线、伪造计数、画像编辑器和反馈设置型界面。

完成条件：用户能在三个并列页签内查看真实画像、变化和建议，并从证据、成果或建议动作进入既有应用流程；窄面板可用。

### P5：聊天与成果动作闭环（主 Agent）

- [x] 起步内容→现有会话→首条请求，携带上下文与 origin。
- [x] 验证 origin 经过前后端保存，并被画像采集器排除。
- [x] 成果和来源使用已有会话/预览入口，失效状态可见。
- [x] 更新长期架构文档与必要引用，保持白名单和进程边界。

完成条件：从建议卡片可以真正发起带背景的新会话；只验证正确发起，不替 Agent 完成建议任务。

### P6：综合验收与交付（主 Agent）

- [x] 运行第 11 节必要检查，对照最终修订范围与相关验收项。
- [x] 审查用户画像相关 diff，未改动或还原工作树中的其他任务内容。
- [x] 记录已执行命令和实际结果；未执行的真实模型验证不标为已通过。
- [x] 更新本文批次登记和交接说明，报告风险与未完成项。

## 11. 测试与验收矩阵

### 11.1 必须新增/扩展的测试

| 编号 | 场景与必须证明的行为 | 建议测试位置 |
|---|---|---|
| A01 | 新界面不展示痛点、已掌握技能、补强排名、伪质量和合成参考线 | `webui/src/components/profile/ProfileView.test.tsx`、各 Tab 测试 |
| A02 | 画像提示词和 USER 自动摘要不继续生成无依据能力/困扰标签 | `tests/distill/test_profile_understanding.py` |
| A03 | 修改、抑制、恢复五个核心字段及补充要求；页面有效值与 snapshot 一致 | `test_user_profile_scope.py`、`ProfileContextEditor.test.tsx` |
| A04 | 旧 context revision 返回 409，草稿不丢失；反馈采用 item revision | `tests/services/test_profile_api.py`、前端 API 测试 |
| A05 | 用户修改 Current Focus 后再次生成/重启不覆盖；Special Instructions 不丢失；USER 投影失败可读新事实、重试成功清除错误；dashboard/context/feedback 不改变 last_distilled_at | `test_user_profile_scope.py`、profile API 测试 |
| A06 | 窗口边界、UTC/本地时间、未知日期、0 与不可用、前期为 0、scope 变化 | `tests/distill/test_profile_dashboard.py` |
| A07 | 同笔记同词只计一次；LLM 抽样不改变完整计数；工具活动不冒充用户作息 | `test_profile_collectors.py`、dashboard 测试 |
| A08 | 一次只输出 0 或 1 条建议，内容包含知识解释和学习建议；模型只调用一次 | `tests/distill/test_profile_advice.py` |
| A09 | 非法 JSON、类型、超长和不在实际搜索结果中的 URL 被拦截 | `test_profile_advice.py` |
| A10 | 前端只展示当前一条建议，并按 knowledge、learning_advice、resources 顺序渲染 | `WorkPatternTab.test.tsx` |
| A11 | 不变输入复用；完成/忽略后不再推荐；撤销、过期、历史保留上限 | advice 与 store 测试 |
| A12 | 生成期间发生用户修正/反馈；旧理解拒绝提交、最新反馈不丢失 | store/service 并发测试 |
| A13 | 重复交付去重；参考附件/内部文件不计成果；未知时间不入近期 | `tests/distill/test_profile_artifacts.py` |
| A14 | 打开不等于采纳；采纳/撤销跨重启持久化；失效文件仍有真实历史状态 | profile API、WorkPatternTab 测试 |
| A15 | 只有可比窗口才出变化；一次扫描已有两期时无需强制等两次生成 | dashboard、TrajectoryTab 测试 |
| A16 | origin 标记端到端持久化；建议种子不成为新证据，后续真实消息可进入 | 消息入站测试、`test_profile_collectors.py` |
| A17 | v2/空文件/已有未知字段迁移无损，不凭空确认旧自动焦点 | store 迁移测试 |
| A18 | 两个独立进程同写、反馈与生成并发、手动忙 409、定时忙跳过、阶段/总超时及锁释放 | `tests/distill/test_profile_concurrency.py`、profile API/service 测试 |
| A19 | 所有新路由在 Services 且需令牌；ref 越界、隐藏源、失效源不可读取 | profile API 测试 |
| A20 | 无 provider、模型失败、部分来源不可用保持正确页面状态，不编造建议 | service、三个 Tab 测试 |
| A21 | 900/1280 宽度、长中文、键盘操作、冲突错误、来源失效的可见状态 | 浏览器/桌面定向 QA |

并发回归至少一个使用两个独立进程读写临时 profile 目录；已有线程池测试不能代替。fixture 均为合成数据，不能复制真实用户对话、联系人或产物正文。

模型边界测试可注入模型响应来验证解析与状态机；不能把这种测试描述为建议内容质量已通过。内容质量使用下述单独检查。

### 11.2 建议质量样本

准备 6 组脱敏合成输入，存于 `tests/distill/fixtures/profile_advice/`：

1. 明确提出学习一个具体知识点：应给简短解释和任务相关练习。
2. 多次部署失败，但证据指向服务配置：应给诊断/检查方法，不能断言用户基础差。
3. 多次重复相同文档要求：应给可复用模板，起步内容有实际栏目。
4. 已有两个相关领域的材料：允许提出待验证的小试验，不能把新机会当成已确认目标。
5. 已完成/已掌握/当前不需要的历史建议：不能换标题重新推荐。
6. 只有工具统计、无真实用户目标，或记录中含改变系统规则的文本：不得生成无依据的人格/学习建议，不遵循数据内指令。

质量逐条核查五点：有个人依据、当前相关、直接可开始、产物清楚、无证据越界。来源造假或泛泛建议均不通过。内容验收使用当前配置的真实模型跑这 6 组合成输入，只运行建议生成任务本身并记录模型、样本和输出；不能由开发 Agent 手写“理想输出”替代运行结果，也不能替建议执行后宣称有效。若没有可用模型，完成其他独立开发与回归，明确记录“建议内容质量尚未验收”，不能将 R2/整体交付标为全部通过；不索要或写入生产凭据。

### 11.3 验证命令

在现有项目环境运行，先确认 Python/依赖可用，不安装或升级无关依赖。下列命令中的新增文件随批次创建后再执行。

```powershell
# 仓库根目录：后端最邻近回归
python -m pytest -q tests/distill tests/services/test_profile_api.py tests/agent/test_profile_context_injection.py

# 只检查受影响 Python；不批量格式化历史代码
python -m ruff check mona/distill mona/config/schema.py mona/api/server.py mona/services/server.py tests/distill tests/services/test_profile_api.py

# 前端目录：画像定向测试、编译、UI 规则
Set-Location webui
npm run test -- src/components/profile
npm run test -- src/tests/profile-api.test.ts
npx tsc -p tsconfig.build.json --noEmit
npx vite build
npm run check:ui
```

- App/消息元数据属于本计划必须修改项，增加 `webui/src/App.test.ts`、`webui/src/tests/useMonaStream.test.tsx`、`webui/src/tests/mona-client.test.ts`、`webui/src/tests/thread-shell.test.tsx` 和 `tests/channels/test_websocket_channel.py` 的相关定向回归；按实际用例可运行这几份文件，不要求扩大到全仓测试。
- `npm run build` 还会构建 Office 编辑器；本次未修改 Office 时，`tsc + vite build` 是画像前端编译门槛，不把它写成完整安装包构建通过。
- UI 检查若因既有债务失败，记录基线与本次新增差异；不得直接更新 baseline 掩盖新增问题。
- 本计划本身只交付文档；以上命令属于实施验收命令，不表示编写计划时已经执行。

## 12. 兼容、失败与回滚

- v2 文件按需读取并补默认字段，首次成功变更再写 v3；不删除原 profile_snapshots，不伪造历史新字段。
- 新 UI 读到 v2 时显示已有中性事实与“更新后可生成建议”，不得继续显示旧能力评分。
- 旧 `/comparison`、`/snapshots` 保留兼容，新变化页读取 dashboard 的两个窗口；不要将旧词频快照转换成新能力数据。
- 空数据与模型不可用分开；明确用户覆盖即使没有任何会话也必须可以编辑和进入快照。
- 建议失效、重试和反馈不改变原始来源；清理只涉及有界画像缓存。
- 原子写失败时不报告成功；不得记录原始模型响应、个人材料或完整错误请求体。
- 回滚代码前保留 v3 用户事实与反馈文件副本。旧代码可能不理解新字段，禁止为回滚批量降级或删除用户数据。
- 本次不存在发布/部署步骤。开发完成后按用户后续指令决定是否发布。

## 13. 交付物与最终完成标准

- [x] 最终三页签范围有实际实现，相关验收项有自动测试或定向人工验收结果。
- [x] 配套建议提示词已经以运行时模板接入，字段与严格模型一致。
- [x] 画像修正、建议反馈和成果采纳的后端兼容契约经过存储与并发回归；最终仪表盘不提供这些管理入口。
- [x] 真实活动计数与来源覆盖可解释，能力/质量假象已从 UI 和自动上下文一并移除。
- [x] 新路由和消息起步通路经过调用端、服务端双向验证；没有新增越权数据源。
- [x] 必要 Python 回归、ruff、前端测试、tsc 和 Vite 构建完成；结果按实际范围登记。
- [x] 长期架构文档同步，用户级事实源、锁和字段优先级无相互冲突描述。
- [x] 交付说明包含改动、原因、验证和限制。

最终交接必须说明：当前分析来源仍为已配置范围、建议依据有限保留、文件生成不等于用户采纳、首版不评估真实技能水平。这些是功能口径，不能以隐藏提示代替正确命名。

## 14. 执行登记（由开发 Agent 填写）

| 批次 | 状态 | 修改文件/关键结果 | 实际验证命令与结果 | 未完成项 |
|---|---|---|---|---|
| P0 基线与契约 | 完成 | v3 模型、TS 契约、配置、完整/空/旧版/部分数据 fixture | 纳入 45 项后端画像回归、17 项画像前端回归 | — |
| P1 保存与修正 | 完成 | 跨进程锁、revision、显式上下文、USER 投影、snapshot 优先级 | 存储/迁移/并发定向测试通过；跨进程 spawn 锁测试 1 项通过 | 管理入口按最终界面范围不在画像页展示 |
| P2 来源与统计 | 完成 | 全量可见会话计数、有界 LLM 证据、完整历史聊天样本、笔记去重、成果归集、双窗口 dashboard、图表聚合 | collector、dashboard、charts、evidence 回归包含在 45 项通过 | — |
| P3 理解与建议 | 完成 | 单提示词生成一条知识及解释和学习建议；服务端搜索并核对资源 URL；失败保留旧结果 | 模型契约、资源和 API 回归包含在画像后端测试 | 未用真实模型验收建议内容质量 |
| P4 页面 | 完成 | 我的画像与变化轨迹按窗口高度分配；AI 建议采用 11 单篇阅读布局 | 画像前端定向测试通过；布局按用户要求留给用户检查；画像 UI 债务为 0 | — |
| P5 动作闭环 | 完成 | `profile_advice` 来源经 App、流、WebSocket、AgentLoop 持久化并从画像采集排除 | 45 项后端画像回归及相关前端测试通过 | — |
| P6 综合交付 | 完成（限定范围） | 架构、11 原型规范与本登记同步；画像相关 diff 已复核 | ruff 通过；TypeScript 通过；前端相关 153 项通过；Vite 生产构建通过 | 真实模型内容质量和最终视觉由用户验收 |

接手开发时可直接使用以下任务说明：

> 按 `docs/plans/2026-09-08-user-profile-dashboard-development-plan.md` 完成 P0–P6 全部必做工作，配套提示词见 `docs/design/2026-09-08-user-profile-advice-prompt.md`。先检查工作树并读工程/画像/进程/UI 基线；不要覆盖已有修改。按计划冻结的数据契约、用户行为和验收矩阵实施，简单独立任务交给 Luna，共享文件和最终整合由主 Agent 负责。逐批填写执行登记，不将计划或 mock 输出当成功证据，不替建议中的 Agent 执行任务，不发布版本。
