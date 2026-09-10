# AI 建议：单栏就地展开原型

- 日期：2026-09-08。
- 状态：旧版参考；用户要求改为跨交流的整体分析，请按 [09 原型](ai-advice-holistic-spec.md) 和对应实现评审。
- 图片：[08-tab-ai-advice-inline.png](08-tab-ai-advice-inline.png)。
- 生成方式：内置 image_gen；07 仅作为应用外壳参考，重新绘制内容。
- 本图替代 07 的左右分栏方案。保留图片历史，不覆盖旧图。
- 对话和用户判断均为合成示例；资源链接沿用本次讨论中已查阅的官方页面。

## 本轮决定

用户明确取消内容区左侧建议列表。保留应用本身的窄模块导航和三个并列页签。

单栏按优先级展示少量建议，标题直接说明具体遗漏或值得了解的信息。首条默认展开，其他条目显示标题、简短理由和来源。数量取决于依据，不固定凑三条。

价值标准：从用户的明确表述、假设或推理中识别一个可能未察觉的问题，并说明影响与应补充的知识。不能仅把已问问题重新讲一遍，也不能仅凭对话没有提到某项知识就断言用户不会。风险型例子只是本图表达方式；生产建议也可以说明机会、限制、新信息或更合适的方法，不能把页面做成单一风险告警列表。

用户不需要旧答案推荐和出题检查；本图没有这些功能。

## 可实现的交互

| 区域或操作 | 行为 |
|---|---|
| 建议标题、了解原因 | 同一条目内展开或收起讲解；默认展开优先级最高的一条，其余收起；无需页面导航 |
| 展开的内容 | 显示所发现的问题、简短说明、需了解的知识、可选的小例子和资源 |
| 查看对话依据 | 在当前条目下展开支持判断的真实摘录和原会话链接；原会话失效时展示摘要及不可访问状态 |
| 小型图解 | 用有限步骤或对比布局渲染；可选，没有合适结构就用短例子，不依赖运行时生成图片 |
| 推荐资料 | 标题链接到核实过的实际页面，附语言与重点阅读部分；在原位展示，无独立列表侧栏 |
| 结合我的方案讲讲 | 带入所选建议、必要的原对话上下文、已验证资源，经现有 profile_advice 通路进入 Mona 会话 |
| 无可靠建议 | 普通短句“最近的交流中，暂时没有值得补充的新建议”，不生成占位建议 |
| 资料未找到或搜索失败 | 讲解仍可阅读；没有可靠链接就不显示链接，失败时用短状态说明 |
| 更新失败 | 保留已有建议并显示失败状态；不可把旧结果标为新生成 |

组件选择：现有 Tabs、PageToolbar、Button、Collapsible/Accordion 与安全 Markdown。折叠标题使用有键盘与 aria-expanded 支持的语义控件。外部链接沿用现有打开入口；小流程使用普通布局和箭头组件。

宽屏保持单栏，短文案不为填满宽度扩写；窄面板的来源与动作自然换行。展开内容按实际长度增长，禁止固定大高度；长讲解通过“结合我的方案讲讲”深入，不把全文塞进仪表盘。原型中首条示例较完整，其余两条保持短行。

## 内容示例的依据要求

本图假设用户曾明确提出“超时后自动重试，直到返回成功”，AI 据此提醒付款完成但响应丢失的可能性，再介绍幂等处理。它不假设用户主动问过“如何避免重复付款”。

生产生成仍须核对对话上下文：如果其他轮次已说明幂等处理，不继续把这个问题当遗漏；理由应限定到实际看到的方案，不能无限扩大为用户能力判断。

真正实现依然需要补齐有界多轮上下文采集、建议判断与排序、资源搜索与核验。普通 UI 组件能实现本图，不代表这些后端能力已全部接入；详见 [上一版说明中的实现依赖](ai-learning-advice-spec.md#尚需实现的生成逻辑)。上一版左右分栏描述不再指导实现。

## 资源链接

- [MDN：幂等](https://developer.mozilla.org/zh-CN/docs/Glossary/Idempotent)：定义与重复请求示例。
- [Stripe：幂等请求](https://docs.stripe.com/api/idempotent_requests)：同键重试、结果复用与适用限制；图中使用条件句，不假设真实用户使用 Stripe。

## 完整生成提示词

```text
Use case: ui-mockup. Create ONE revised high-fidelity raster prototype by editing the supplied Mona UI screenshot. Preserve only the outer application shell and top toolbar; REPLACE THE ENTIRE PAGE BODY. The user rejected the internal left-hand navigation list and wants a single-column compact advice dashboard.

CORE VALUE: AI notices a consequential issue the user did NOT explicitly ask about, based on a specific assumption shown in their conversation, then explains the missing knowledge. Lead with the concrete overlooked issue and its consequence, NOT with course/subject names. Fictional example conversations must be labelled as examples, not claims about the actual user.

REFERENCE INVARIANTS:
Keep native slim Mona titlebar; existing narrow application rail with Chinese module icons and labels (会话、笔记、文档、终端、邮件、计划、数据库、系统、股票、画像); white main surface on warm neutral-gray app shell. App rail 画像 has thin red selected indicator.
Keep ONE 44 logical px top toolbar: left 用户画像 · 近30天; centered tabs 我的画像 / 变化轨迹 / AI 建议; AI 建议 selected by thin RED underline. Right refresh icon and small charcoal 更新画像. This outer app rail is retained. REMOVE the second sidebar inside the content, the vertical divider and master/detail composition.

OUTPUT AND STYLE:
A full front-on crisp desktop screenshot 2048x1280, implementable at 1280x800 logical size. Chinese system sans-serif, regular 14px body, 12px auxiliary text, 16px semibold suggestion titles. Avoid giant titles and inflated vertical spacing. 16px content gutters, 12px section spacing. Flat editorial rows separated by a single light-gray line. No card wall, nested panels, heavy borders, shadows, color backgrounds, avatars, cover illustrations, charts, score gauges, progress bars, settings or quizzes. Main text charcoal, metadata gray. Only tiny diagram accents subdued green or blue. Buttons charcoal or plain text. All elements must map to normal text, Accordion/Collapsible, links, buttons and simple text-arrow layouts. Diagrams are small optional illustrations of the issue, not decorative illustrations.

SINGLE-COLUMN BODY:
A shallow introductory line reads 根据近期交流，建议你留意这几件事. Small right-side 更新时间 09/08. Under it a vertical list of THREE advice rows spanning the full usable content width. First row is expanded in place. The other two are collapsed. There is no knowledge catalog and no second column. The first entry should take roughly 360–430 logical px, and each collapsed entry about 76px; all visible on one screen. No enormous white padding below any section.

FIRST ENTRY (expanded):
Small gray label 先看这个. Bold title 自动重试可能让同一笔付款执行两次. On far right aligned with title a small up chevron and 收起.
Two short lines immediately beneath:
你在方案里准备“超时后自动重试，直到返回成功”。
但超时也可能发生在付款已完成之后，这时直接重试可能重复付款。
Metadata/source line: 来自「支付重试方案」 · 查看对话依据 ›. This disclosure is a real implementable interaction; it opens quoted supporting conversation inline.
Small heading 这里容易忽略的是.
A compact one-line four-step schematic, about 55 logical px tall, aligned left with readable labels:
付款已完成 → 响应丢失 → 客户端显示超时 → 再次请求可能重复付款
Make the second/third steps show a tiny broken signal line, not a big warning illustration. Simple thin neutral arrows and plain text labels; no rounded card containers. Short caption “没有收到结果”不等于“没有执行成功”。
Then a short knowledge explanation:
建议了解：接口幂等性
同一次操作使用同一标识，由服务端识别重复请求并复用处理结果。
No exhaustive lesson, code editor, task form, expected-output checklist or completion criteria.

Resources IN THE SAME EXPANDED ENTRY:
small heading 推荐资料.
Two compact unboxed links each with source/language and precise reading hint:
MDN：什么是幂等 ↗    中文 · 先看定义和重复请求示例
Stripe：幂等请求 ↗    英文 · 重点看同键重试的适用限制
These refer to verified actual resources:
https://developer.mozilla.org/zh-CN/docs/Glossary/Idempotent
https://docs.stripe.com/api/idempotent_requests
Do not invent URLs or include credential-like strings. Show linked article titles rather than long bare URLs.
A tiny inline factual note: 如果你使用 Stripe，它已提供幂等请求支持。 This is conditional, not a new release claim.
One small charcoal button 结合我的方案讲讲 →. No second full-size button and no questionnaire.

SECOND ENTRY (collapsed, horizontal separator above):
bold title 定时备份成功，还不能确定故障后能恢复
one compact sentence 你用“备份完成”判断数据安全，还需要验证备份能否实际恢复。
small gray source 来自「数据备份方案」.
At far right a down chevron and 了解原因. Clicking expands explanation, original conversation evidence, optional verified sources and contextual chat action in this exact row.
Do not show illustrations for collapsed rows.

THIRD ENTRY (collapsed, horizontal separator above):
bold title 只看平均耗时，可能漏掉特别慢的请求
one compact sentence 你用平均耗时验收性能，少数用户遇到的长时间等待可能被掩盖。
small gray source 来自「接口性能讨论」.
At far right a down chevron and 了解原因. Same accordion interaction.

BOTTOM subtle small footer: 原型示例 · 对话与判断为示例，资料链接已核实.

CRITICAL EXCLUSIONS:
No left recommendations list, no internal navigation column, no separate right detail pane.
No 我已掌握 / 测一测 / 试一道题 / 找回旧答案.
No abstract product terms 认知缺口、知识盲区、能力画像、知识雷达.
No generic titles like 学习基础知识, no three giant cards, no decorative infographics.
The image should unmistakably show an actionable new realization inferred from conversation, not repeat an already asked question. Display only the first advice in depth; the other two remain genuinely compact. User must scan all three concrete issues without navigation.
```
