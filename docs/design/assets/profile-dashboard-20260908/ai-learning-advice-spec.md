# AI 建议：根据交流推荐值得了解的知识

- 日期：2026-09-08。
- 状态：旧版参考；用户已取消内容区左侧列表，请按 [08 单栏原型](ai-advice-inline-spec.md) 评审与实施。此处保留原设计记录。
- 图片：[07-tab-ai-learning-advice.png](07-tab-ai-learning-advice.png)。
- 生成方式：内置 image_gen；用 06-tab-my-profile.png 作为应用外壳参考。
- 对话、用户情况和推荐判断均为合成示例，不代表对实际用户知识水平的判断。资源 URL 已在本次设计时查阅其官方页面。

## 用户确定的范围

核心价值：AI 从沟通过程中发现用户为当前目标值得掌握、但可能尚未理解的知识或尚不知道的信息，说明原因，并提供具体讲解与相关资源。

保留三个增强能力：
1. 排出先了解什么，说明为什么对当前工作有帮助。
2. 用用户遇到的具体问题解释知识。
3. 搜索会影响当前做法的信息与可阅读的真实资源。

用户明确不需要：找回已解决过的旧答案、出题检查掌握情况。原型也不加入考试、评分、打卡或管理设置。查看当前建议的原始对话属于依据跳转，不是旧答案推荐。

## 页面结构与可实现方式

| 区域 | 用户看到的内容 | 实现 |
|---|---|---|
| 现有顶栏 | 我的画像、变化轨迹、AI 建议；更新画像 | 继续使用 PageToolbar、Tabs、Button |
| 左侧建议列表 | 知识点、简短用途；第一条标为“先看这个” | 普通可选择列表，服务端返回排序后的建议；数量按真实内容决定 |
| 为什么推荐 | 交流中的具体困惑、与当前目标的关系 | 模型生成短理由，必须绑定真实来源 ref；可调用已有证据 API 并打开原会话 |
| 用你的问题说明 | 一段解释与短案例 | 安全 Markdown、简单顺序步骤或对比；图中两行三步可用普通布局与箭头实现，无需运行时生成图片 |
| 推荐资料 | 可点击标题、来源域名、语言、重点阅读部分 | 使用现有搜索能力取得 URL，读取页面核对相关性；搜索查询只包含一般知识点与场景 |
| 还有一条相关信息 | 与所选建议相关、能影响做法的已核实信息 | 可选字段，写明条件与来源；没有合适事实时整段隐藏 |
| 结合我的问题讲讲 | 带着解释、原问题与资源继续对话 | 复用现有 profile_advice 类型化启动链路 |

布局仍遵循紧凑要求：统计页与本页并列，本页不重复指标；主内容为约 25% / 75% 列表与详情；普通文字与图解按内容自然高度展示，不强制撑满。窄面板使用列表后接所选详情。图解标签必须保留可读字号，不用缩小全页来压缩空间。

图解仅在知识适合用步骤/对比表达且模型提供有效结构时出现。其他知识使用短解释和实际例子，不强行为每条建议造流程图。图像里的领域知识示例不能写死进生产界面。

## 尚需实现的生成逻辑

现有 AdviceTask 主要接收用户消息摘录，目标是挑选“一小步任务”，verified_resources 当前固定为空。新原型要求补以下内容，不能只修改 UI 后宣称功能已完成：

1. 在允许的会话范围内，为候选问题读取有界前后轮交流。AI 回答仅帮助理解上下文，不作为“用户已经掌握”的证据；也不能因为 AI 已经讲过就认为用户学会。
2. 根据用户明确困惑、表达出的误解、当前任务所需知识提出候选；不能把提问次数、未提及或工具失败当作不会的证据。检查后续用户表达是否已经消除该困惑。
3. 按当前相关性、依据和实用性排序。允许没有建议，不固定凑两条或三条。
4. 对选中知识搜索少量资料，核对页面相关性和适用条件，保存真实标题、URL、来源与核实时间。来源访问沿用现有 URL 安全检查。未搜索到时保留自包含解释。
5. 为新字段接入存储/API/前端契约；复用来源查看与建议启动链路。搜索失败不能清空已有解释，页面只在有合适资源时展示链接。

## 本图真实资源

- [MDN：幂等](https://developer.mozilla.org/zh-CN/docs/Glossary/Idempotent)：支持核心定义及重复请求示例。
- [Stripe：Idempotent requests](https://docs.stripe.com/api/idempotent_requests)：支持 Stripe 的幂等请求能力、同键重试及适用限制。图中明确使用“如果你使用 Stripe”，不暗示用户实际使用该产品，也不把该能力说成最新发布。

## 完整生成提示词

```text
Use case: ui-mockup. Edit the supplied Mona dashboard reference into ONE new production-feasible AI advice screen. Preserve its Mona desktop shell and visual language, replace all page body content, and activate AI 建议. This is a raster prototype for discussion, NOT an implementation screenshot.

PRIMARY PRODUCT PURPOSE: infer specific knowledge or information a user needs but has not understood from an actual multi-turn discussion, explain WHY it matters now, teach the key point using the user's own problem, and link to relevant verified learning resources. Avoid generic inspiration and vague self-improvement. Three supported functions ONLY: prioritize what to learn; explain through the user's concrete problem; supply useful factual information and resource links. NO quizzes, tests, ability scoring, progress tracking, old-answer retrieval, or settings.

REFERENCE ROLE: shell/layout/typography reference only. Keep thin native Mona titlebar, narrow gray 56px logical left icon rail, Chinese module labels, white main surface, thin neutral separators, small charcoal button. Exact top toolbar left 用户画像 · 近30天, center parallel tabs 我的画像 / 变化轨迹 / AI 建议, AI 建议 active using thin RED underline, right refresh icon and charcoal 更新画像. Discard original charts and KPI ribbon completely. No second navigation system, giant banner, identity block, or chart dashboard in this tab.

OUTPUT: one complete crisp screenshot, landscape 2048x1280, realistic 1280x800 logical desktop density with 56px sidebar, 44px toolbar, 14px Chinese body, 13px metadata, largest heading only 18px semibold. All contents readable at normal desktop size. No huge titles, shadows, nested rounded cards, excessive blank regions or oversized illustrations. Font is Chinese system sans-serif. Canvas white; outer app gray #F2F2ED; charcoal text; secondary gray. Small muted green/blue only for schematic signals, actions charcoal. Displayed diagrams are simple text-and-arrow layouts implementable with ordinary UI components, not generated artwork needed at runtime.

NEW BODY:
A compact 28px line beneath toolbar reads 根据近期交流，为你挑选值得了解的内容, far right small 更新于 09/08.
One master/detail content region: left 25% (about 270 logical px) short ranked recommendations; right 75% explanation. One thin vertical dividing line. Normal 16px gutters, no outlined card containers.
LEFT:
small heading 建议先了解.
Two compact recommendation rows (~90 logical px each), NOT enormous cards.
First selected row with barely gray background and 2px charcoal left selection marker:
small plain label 先看这个
bold title 接口幂等性
subtitle 解决请求重试导致的重复下单
Second unselected row:
small label 接着了解
bold title 数据库事务
subtitle 理解多步操作为什么会只完成一半
Then a short quiet divider and tiny neutral sentence 优先推荐当前工作用得上的知识.
No extra badges, numerical rankings, dates repeated on every row, or full-page sidebar panels.

RIGHT DETAIL:
Header title 接口幂等性：重试也不会重复下单.
Immediately below a short light-gray source line 来自「订单重试讨论」 with small link 查看对话 ↗. This is fictional example user data; make the global example label explicit.
Section 1 compact heading 为什么推荐.
Text only TWO readable short lines:
你在追问中提到，接口超时后不知道能否再次下单。
先弄清“未收到结果”和“未执行成功”的区别，才能正确处理重试。
No language like 认知缺口、知识盲区、能力不足、认知图谱.
Section 2 heading 用你的问题说明.
One sentence 幂等性：同一次操作重复请求，仍只产生一次预期的业务结果。
Small simple 2-row schematic, at most 95 logical px high, no fancy illustration:
Row 1: 首次请求 → 创建订单 → 响应丢失
Row 2: 重试同一请求 → 识别已处理 → 返回原订单
Neutral thin arrows, identical rectangular labels with no heavy outline or soft fills, green small check on 创建订单 and 返回原订单, soft gray 响应丢失. Tiny gray caption below 两次请求使用同一操作标识，由服务端识别并复用已有结果.
Do not pretend adding any HTTP header magically guarantees this for arbitrary servers.
A single separator.
Section 3 small heading 推荐资料.
Two dense resource rows (~48 logical px each). Each has a small link/document icon, a clickable title, domain + language, and a short what-to-read instruction:
1. MDN：什么是幂等 ↗
developer.mozilla.org · 中文
先看定义与重复请求示例。
2. Stripe：幂等请求的使用方式 ↗
docs.stripe.com · 英文
重点看同一个键如何复用，以及适用限制。
These are REAL VERIFIED resources: https://developer.mozilla.org/zh-CN/docs/Glossary/Idempotent and https://docs.stripe.com/api/idempotent_requests. Do NOT invent any URLs, add login keys, or show gibberish links.
Below resources a compact flat information row with small info icon and heading 还有一条相关信息.
One short sentence 如果你使用 Stripe，它已提供幂等请求支持，可先查看官方接入方法。
Small text link 查看官方说明 ↗. This is a conditional useful fact from the same verified Stripe API documentation, NOT a claim that the feature was just released, NOT a claim about actual user payment provider.
Bottom action bar with ONLY ONE charcoal primary button 结合我的问题讲讲 →. Tiny adjacent text 将带入相关对话 in gray. Clicking would start existing Mona chat with the selected explanation and source context. No 开始练习, no quizzes, no 我已经懂了 button, no 收藏旧答案, no report/template creation CTA.
Bottom whole-page micro footer: 原型示例 · 对话和推荐判断为示例，资料链接已核实.

The page must be compact and professionally polished, communicate actual practical knowledge, ground the learning recommendation in a conversation, and use verifiable information. No invented user scores, autonomous monitoring claims, elaborate interactive knowledge graphs or dashboard ornaments. This is an achievable list/detail interface, not a generic three-card recommendation wall.
```
