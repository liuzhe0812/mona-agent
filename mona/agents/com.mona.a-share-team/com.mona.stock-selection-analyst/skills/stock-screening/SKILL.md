---
name: stock-screening
description: 先用确定性条件筛选候选，再基于候选证据生成带事实、推断、反证、失效条件和来源的机会研究线索。
---

# 选股与机会研究

本 Skill 服务于两步工作流：确定性 `screening` 产出 `selection.json`，候选 `opportunity_research` 只研究其中 Top N 并产出 `opportunity.json`。确定性服务负责全市场计算，Agent 负责可审计的策略翻译和证据解释。

## 1. 策略翻译

- 先确认观察周期：短期、波段、中期或长期。
- 将自然语言拆成 `universe`、`filters`、`ranking` 和 `limit`；`limit` 是确定性筛选输出数量，沿用服务 1–100 的范围。
- 机会研究数量使用独立的 `research_limit`，默认 1，只允许 1–8 的整数；不能用 `research_limit` 覆盖或缩小筛选 `limit`。
- 用户可同时选择 2–4 个内置方向。此时使用 `combined_discovery` 和 `included_strategy_ids`：各方向独立召回后取并集、去重并统一排序；多方向命中的候选排序更靠前。不得改成所有条件的交集。
- `field`、`op`、范围和权重只能使用后端 allowlist；不输出 SQL、Python、正则表达式或任意公式。
- 不确定的条件必须保留为待确认项，而不是猜测阈值；条件不完整时不调用空条件策略。
- “估值不过高”“经营稳健”等默认语义只能映射到已发布的内置策略（如 `quality_value`、`stable_business`）；映射结果必须写入最终 `strategy` 并在结果中披露，不能临时发明阈值。
- 只有 `stock_screen_run` 可以计算候选、排名和数据质量。不得由模型修改 selection 中的股票、排名、因子值或命中条件。

### 1.1 近期催化策略

- `recent_catalyst` 是可运行的确定性策略：服务只扫描近 7 个自然日内、已映射到 A 股证券、带公开时间和逐条来源的材料事件。
- 允许的事件事实包括业绩/定期报告、分红回购/增减持、重大合同/项目/产品/许可、并购重组/资产处置/融资，以及风险警示、问询、处罚、诉讼和停复牌等重大事项。
- 候选的 `snapshot.catalyst_events`、事件类型、标题、公开时间和 `source_ids` 是确定性事实；不要按公告数量、标题语气或当日涨幅自行扩展候选。
- `data_quality.event_capture` 必须原样保留 `complete`、`cache_status`、窗口和 `data_cutoff_at`。`unavailable`、`stale`、`partial` 与“当前窗口无命中”是不同结果，不得互相替换。

## 2. 候选研究 SOP

1. 用 `stock_screen_read` 读取当前 run 的 selection，按确定性排名计算 `actual_research_count = min(research_limit, selection_candidate_count)`；`research_limit` 必须为 1–8 的整数，候选不足时只研究实际候选。
2. selection 为 0 时如实返回无候选状态，不调用 `stock_context_read` 或 `stock_opportunity_submit`，不生成伪造的 `opportunity.json`，也不把候选研究步骤标记为失败。
3. 对每只实际候选只调用一次 `stock_context_read`，默认读取 `quote`、`kline`、`fundamentals`、`news`；禁止加入 selection 外股票。
4. 只用当前候选 context 的 `source_id` 调用 `stock_source_open`。来源记录必须保留 provider、时间和内容哈希等原始元数据。
5. 完成跨候选比较后，调用 `stock_opportunity_submit` 提交结构化研究；不要自行写报告文件或可信字段。
6. 当策略为 `recent_catalyst` 时，`stock_context_read` 返回的 `event_calendar` 必须作为同源核验入口。只有当候选事件与当前 context 的事件 `source_id`、证券和公开时间匹配时，才可把 `why_now` 写成事实或有证据的推断；不匹配时只能写 `unknown`/数据缺口并把优先级降为 `low`。

### 2.1 方向化研究计划

先确定每只候选的实际研究方向：单方向读取 `selection.strategy.strategy_id`；组合发现读取候选 `snapshot.matched_strategies`；自然语言或用户策略从已确认的筛选条件、排序因子和观察周期提取目标。组合发现不能把用户勾选但候选未命中的方向强加给该候选。

| 机会方向 | 必须优先回答的问题 |
| --- | --- |
| 经营稳健 `stable_business` | 盈利是否有质量且可持续；现金流是否匹配利润；负债、周期和估值是否破坏稳定性；什么变化代表稳定假设失效 |
| 业绩成长 `quality_growth` | 多期增长是否持续；增长来自哪里；毛利率和现金转化是否支持增长；估值是否透支；什么信号代表增速转弱 |
| 趋势机会 `trend_confirmation` | 趋势、量价、动量、波动和相对强弱是否互相确认；支撑/压力在哪里；行情是否与基本面或事件冲突 |
| 近期催化 `recent_catalyst` | 事件是否同源可核验；何时公开、是否重要；影响路径和窗口是什么；市场如何反应；什么情况代表催化未兑现 |

只研究候选实际命中的方向，但所有方向共用数据时效与质量、支持证据、反对证据、相对候选特点和失效条件五项审计底线。命中多个方向时分别取证：相互强化项进入 `supporting_evidence`，冲突项进入 `counter_evidence` 和 `invalidation_conditions`；不得因为命中方向更多而自动提高研究优先级，也不得机械输出未命中方向的完整检查表。

### 2.2 三周期候选研究

每只候选必须在 `horizon_views` 中同时提交 `short_term`、`medium_term`、`long_term`，不能只填写 `strategy.horizon`。三周期口径固定：

| 周期 | 口径 | 优先回答 |
| --- | --- | --- |
| `short_term` | 1—10 个交易日 | 当前市场环境、板块/相对强弱、量价波动、事件窗口与可交易性风险 |
| `medium_term` | 2 周—6 个月 | 行业景气、政策兑现、盈利预期上修/下修、估值与事件兑现 |
| `long_term` | 6 个月以上 | 商业质量、现金流、资本配置/治理、行业生命周期与估值约束 |

每个周期都必须包含 `status`、结构化 `summary`、`supporting_evidence`、`counter_evidence`、`watch_items`、`invalidation_conditions` 和 `data_gaps`。`available` 必须有当前候选 context 来源支持的摘要、支持证据、反对证据、观察项和失效条件；达不到时使用 `insufficient_data`，摘要说明不能判断的原因并填写非空 `data_gaps`。不把缺失写成中性结论。

### 2.3 事件传导链

当 selection snapshot 存在 `catalyst_events` 时，候选必须提交 `event_transmission`，并按“事件事实 → 直接影响 → 行业/产业链环节 → 公司业务敞口 → 收入/利润验证路径”逐段填写 `event`、`direct_impact`、`industry_chain`、`business_exposure` 和 `earnings_path`，另填 `validation_window`、`priced_in`、`priced_in_basis`、`counter_evidence`、`invalidation_conditions` 与 `data_gaps`。每个事实或推断只能引用当前候选 context 的来源，事件事实的来源必须与 `catalyst_events.source_ids` 相交。

`event_transmission.status=available` 仅在整条链有来源支持、至少有一条反证和一条失效条件时使用：事件标题或主题联想不等于业务受益，业务涉及也不等于收入/利润受益。`priced_in` 不是 `unknown` 时必须用来源支持的 `inference` 填写 `priced_in_basis`。任一环节不能核验时使用 `insufficient_data` 并填非空 `data_gaps`，不得编造产业链或盈利路径；服务会将事件候选记录为 `partial` 并把研究优先级降为 `low`。非事件候选可将 `event_transmission` 置空；不得用它冒充全市场主题受益选股，`theme_beneficiary` 仍不可用。

## 3. 研究声明协议

每条 `why_now`、`thesis`、证据、相对优势、观察项和失效条件都必须标注：

- `fact`：来自当前 context 的事实，至少一个 `source_id`；
- `inference`：基于事实的推断，必须有支持来源并显式标注“推断”；
- `unknown`：无法确认、数据缺失或待验证问题，可以没有来源。

每只候选必须包含：

- `why_now`；
- `thesis`（机会假设）；
- `supporting_evidence`；
- `counter_evidence`（反证，不能省略）；
- `relative_edge`（仅限本次候选集合）；
- `watch_items`；
- `invalidation_conditions`；
- `data_gaps`；
- `horizon_views`：同时包含 `short_term`、`medium_term`、`long_term` 三个独立周期；
- `context_id` 和来源 `source_ids`。

`research_priority` 仅表示继续研究优先级。若没有至少一条支持证据和一条反对证据，必须降为 `low`。不输出买入/卖出、仓位、目标价、止盈止损、收益承诺、胜率或不透明 AI 分数。

## 4. 数据边界与缺失处理

- 缺失因子不填零；`partial`、`stale`、`insufficient_data` 和 `unavailable` 必须如实保留。
- 没有资讯不能解释为没有风险；不得用新闻标题、涨跌幅或模型常识伪造热点、催化、产业链、事件或预期差。
- 近期催化的事件影响只能是带来源的 `inference`：必须同时结合行情/基本面/公告等其他证据，给出影响窗口、最重要反证和失效条件；公告标题本身、事件数量或涨跌幅不等于机会质量。
- 仅有聚合公告源时，明确注明来源边界；事件源 `partial`/`stale` 时，结论必须降级并保留数据截止点，不得写成完整覆盖。
- 行业比较优先使用同口径同行数据，不能把跨行业估值差异包装成相对优势。
- 真实历史数据不足时验证状态为 `unavailable`，不倒推、不使用幸存者股票池。
- 事实与推断都要带数据时间和来源；未知项要写明待验证问题。

## 5. 合规与提交

- `stock_opportunity_submit` 从当前 workflow run 读取 selection、注入 deterministic rank、报告 ID、时间和质量摘要；Agent 不得指定或改写这些字段。
- 提交失败必须返回可操作错误，不声称生成完整报告，不伪造 `completed`。
- 机会研究只提供研究线索，不能构成投资建议。六 Agent 深度投研由用户主动触发，不在候选工作流中自动启动。
