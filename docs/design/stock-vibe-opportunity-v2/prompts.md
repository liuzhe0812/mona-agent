# 机会选股 V2 原型生成记录

- 日期：2026-10-18。
- 工具：内置 `image_gen.imagegen`；本次交付为图像原型，无产品代码实现。
- 生成原件目录：`C:/Users/liuzhe/.codex/generated_images/01a14e44-4367-75c3-a894-c10df48d49b0/`；原件保留。
- 最终图：[主界面](01-ai-opportunities.png)、[方法详情](02-method-evidence.png)。
- 参考旧图仅用于保留Mona外壳与导航；旧版行情筛选流程已被V2替代。
- 图片中的候选、行情、因子处理数量、模型选择和验证状态均是设计示例，不是运行证据。

## 1. 主界面初稿

- 参考图：`docs/design/stock-vibe-opportunity-v1/01-market-candidates.png`。
- 输出图：`exec-94aa80a7-ea19-4452-b6b8-bd74d818ea0f.png`。

```text
Use case: ui-mockup.
编辑参考图，重新设计Mona“机会选股”的高保真中文原型，完整横向桌面窗口，约2880×1700比例。参考图只保留Mona外壳/左应用竖栏/顶部五Tab的构图与样式。股票内容必须彻底换成下面的新产品，原来“行情初筛/成交额排序/候选数量/核实所选”的券商筛选器全部删除，不沿用旧表格。

核心产品：普通人表达研究目标，后台执行多因子、模型比较、样本外与费用风险验证、财报行业资料复核，前台只突出3个易懂的重点候选，方法可追溯。不让用户手选算法或478个因子。

视觉严格保持：Mona标题栏、应用侧栏、背景和全局导航为原本的中性暖白/灰色，禁止全局染蓝。顶部“股票”，五Tab“投资工作台 / 机会选股（浅灰选中） / AI投研 / 策略实验室 / 账户与复盘”，右上“研究周期 波段 / 关注与提醒 / 研究模型”，页签右端“跟进消息”。只股票区的主要动作采用既有信息蓝；普通按钮、选项、次级操作统一中性。正文深灰、清晰中文、适度留白、细边界、小圆角，无霓虹、大渐变、大色块、阴影堆叠或海报。所有正涨幅与对应价格红色，负涨幅与对应价格绿色，代码/名称深灰。

正文三栏：左约21%、中约53%、右约26%，稳定横向布局。
左栏标题“你想找什么机会？”，一个舒适的大多行输入框，已填“寻找未来5–10个交易日，量价与经营证据共同支持、风险相对可控的A股机会。”
下方“研究范围”下拉“沪深300”；“风险取向”下拉“优先控制风险”。蓝色实心主按钮“寻找机会”。浅灰小块“本次理解”，两行“波段 · 5–10个交易日”“结合多种信号，先做方法验证和风险复核。”。下面轻文字“查看研究过程 →”。不放成交额、PE、ROE阈值、TopN排行或因子选择控件。

中央标题“本次重点候选”，旁小字“3只 · 设计样例”，右侧中性文字按钮“方法与验证 →”。元信息“数据截至10-16收盘 · 本次研究10-18 16:10”。下面一个轻量信息行“本次范围：沪深300 · 可评估286/300只”；另一行小字“多因子计算 · 模型比较 · 费后样本外检验 · 风险与资料复核”。这些是示例状态，不画全绿通过。
一行中性选项“重点候选3”（浅灰选中）和“全部记录300”。

中央依次3条有留白的候选信息面，不做密集行情排行榜：
第一条浅灰选中：
“1  宁德时代   300750”，右侧小红字“398.20  +2.10%”
“入选依据：量价信号与经营资料相互支持，风险约束后仍位于前列。”
“主要风险：近期波动偏高，模型间仍有分歧。”
小字“研究排序 1/286 · 可查看方法与资料依据”
行末中性“看行情”“加入自选”。
第二条白底轻分隔：
“2  美的集团   000333”，右侧小绿字“54.60  -0.80%”
“入选依据：经营与估值资料方向一致，价格信号相对稳健。”
“主要风险：需求变化可能削弱当前判断。”
小字“研究排序 2/286 · 可查看方法与资料依据”
中性“看行情”“加入自选”。
第三条：
“3  中国移动   600941”，右侧小红字“108.50  +0.50%”
“入选依据：现金流与低波信号提供支持，与其他候选行业重叠较少。”
“主要风险：增长预期变化，部分资料仍需持续跟踪。”
小字“研究排序 3/286 · 可查看方法与资料依据”
中性“看行情”“加入自选”。
三条内容要完整、字清晰，不显示胜率、预期收益、买入按钮、目标价或凭空机会分。下方小字“排序表示本次研究优先级，不代表上涨概率。”，再轻入口“查看完整研究报告 →”。

右栏标题“为什么优先研究它”，名字“宁德时代”，代码“300750”。
局部很淡蓝的阅读面标题“支持依据”，三点简短文字：
“量价：多项信号方向一致”
“经营：财报证据提供支持”
“模型：风险约束后仍靠前”
白底下一块标题“反方检查与风险”，两点“近期波动高于部分候选”“不同模型对短期走势存在分歧”。不伪造固定成立/失效数学卡。
蓝色主按钮“查看完整研究”，下面中性按钮“加入自选”“看行情”；轻文字“问这份研究 →”；可展开“方法、数据与资料来源 ▾”。
底部准确说明“原型示意 · 候选、行情、模型与验证状态均为展示样例”。图内公司判断都是UI样例，不是现实财务或投资结论。画面精致易读，重点是自然语言目标和有解释的候选，不要算法术语满屏，不要照搬旧筛选表。
```

## 2. 主界面局部修订

- 参考图：`exec-94aa80a7-ea19-4452-b6b8-bd74d818ea0f.png`。
- 输出图：`01-ai-opportunities.png`。

```text
Edit this UI prototype with exactly one localized change: remove the tiny text '0/300' in the lower-right corner inside the filled natural-language goal textarea at the upper left. Leave its space empty. Preserve the entire rest of this Mona opportunity-selection page unchanged: same Chinese labels, candidate cards, stock prices, risk explanations, blue primary actions, neutral ordinary buttons, top navigation, left rail, page size and layout. Do not redesign, recolor, crop or change any other text.
```

## 3. 方法详情初稿

- 参考图：`01-ai-opportunities.png`。
- 输出图：`exec-69ed5ab2-7490-4d3c-85b6-67e9297aec35.png`。

```text
Create the SECOND state of this exact Mona desktop stock-module UI prototype: the user has clicked “方法与验证” on the opportunity-selection page. Use the reference as the visual anchor. Preserve the outer Mona window, icon rail, stock header, five main tabs and their neutral styling, and only change the stock-module content below its tab bar. Keep “机会选股” selected. This is a design mockup, not an implemented or real financial result.

Render a crisp, polished Chinese desktop UI screenshot, landscape 1633x963 or similar. Warm white canvas, charcoal typography, thin cool-gray borders, very subtle pale-blue accents. Ordinary buttons neutral gray/white, no rainbow colors. Blue only for restrained links or one main action. No charts or performance numbers, no fabricated win rate, no green all-passed badges. The screen must be readable and thoughtfully spaced.

Inside the stock content area show a method-detail view, not a new top-level tab:
Header at top left: “本次方法与验证”
Subline: “波段组合 v1.4 · 设计样例”
At top right a neutral outlined “返回候选” button.
Small scope strip: “沪深300研究池 · 可评估286只 / 共300只 · 14只资料不足”
Small explanatory sentence: “先在训练与验证期选择方法，再用独立测试期检查；不会按最后测试结果挑选模型。”

Below, use two clean columns, left about 55%, right about 45%, separated by a generous gutter.

LEFT upper card titled “因子如何参与”
Small line “原生目录478项，先核对适用性和数据，再筛选入模信号。”
A compact horizontal four-cell metric row with these exact, mutually exclusive counts:
“478 目录总量” ; “412 可评价” ; “46 待补数据” ; “20 本次不适用”.
Under it show “412项可评价因子中，本次入模12项” as a pale-blue inset. Make the 12 clearly a subset, not another bucket to add.
A compact family breakdown, text or small table: “Qlib 154 · GTJA191 191 · Alpha101 101 · 学术 12 · 基本面 20”.
Bottom neutral text links “查看因子清单 →” and “查看剔除原因 →”.
This is an illustrative task audit, not a claim all 478 work in A shares.

LEFT lower card titled “比较后采用哪种方法”
A three-row simple table with columns “候选方法” and “本次处理”.
Rows:
“等权多因子” / “作为基线参照”
“IC权重多因子” / “验证期选用（示例）”
“树模型” / “验证期改进不稳定，未采用”
No invented numerical metrics or universal best-model claim.
Under table compact sentence “比较、选用与权重都有对应研究记录。”

RIGHT upper card titled “验证记录”
Small subdued subtitle “状态来自实际产物；这里展示交互样例”
Six rows, each with left label, middle restrained text status, right neutral “查看” link:
“时间切分与标签隔离” / “有切分记录” / “查看”
“同池随机对照” / “有对照记录” / “查看”
“多次试验修正” / “有检验记录” / “查看”
“费用、滑点与换手” / “已计入示例回测” / “查看”
“行业与风险暴露” / “有核对记录” / “查看”
“前向跟踪” / “记录不足” / “查看”
The “记录不足” is soft amber text, not green. Other statuses neutral dark-gray, not all passed. No shield or success icons.

RIGHT lower compact card titled “数据与方法时点”
Three clearly separate rows:
“训练期” / “2022—2024”
“方法选择期” / “2025”
“独立测试期” / “2026-01 至 2026-09”
Small line “本次选股数据截至 10-16 收盘”
Small disclosure “数据来源、版本与研究产物” with chevron.

At the bottom, a quiet footer row with a neutral outlined “查看研究产物” button and text link “在策略实验室查看方法 →”. This link is for deeper inspection, not a prerequisite to use opportunity selection.
At very bottom inside stock-module panel, legible muted text:
“设计样例 · 数量、模型选择与验证状态均为展示示意，尚非真实执行结果。”
The view should feel like transparent evidence behind a simple AI opportunity product, not a technical control panel requiring users to configure factors. No buy/sell/order buttons. No new global navigation. Use natural sharp Chinese typography and preserve the established Mona shell exactly.
```

## 4. 方法详情局部修订

- 参考图：`exec-69ed5ab2-7490-4d3c-85b6-67e9297aec35.png`。
- 输出图：`exec-da4f51b6-1c94-40cb-bdc2-45a2a1dead73.png`（进一步修订见第5节）。

```text
Make exactly one localized Chinese text correction in the supplied Mona UI screenshot. In the left factor card, replace the small heading '因子家族分布（可评价项）' with '原生目录家族分布（共478项）'. The row below lists all 478 catalog factors, not only the 412 evaluable subset. Keep every other count, label, table row, color, spacing, button, sidebar and window frame unchanged. Preserve exact full screenshot composition, no redesign or cropping.
```

## 5. 方法详情示例状态澄清

- 参考图：`exec-da4f51b6-1c94-40cb-bdc2-45a2a1dead73.png`。
- 输出图：`02-method-evidence.png`（生成原件：`exec-137fdf26-ce04-4779-9ccc-aabe7e2fd103.png`）。

```text
Make exactly one localized text correction in this Mona opportunity-selection method-detail UI. Under the card title '验证记录', replace the subtitle '状态来自实际产物；这里展示交互样例' with the exact text '状态字段对应研究产物；本图状态为示例'. This clarifies that the pictured validation statuses are illustrative, not actual completed runs. Preserve every other text, count, factor-family heading, table, status, color, button, sidebar, spacing and outer window unchanged. Keep the bottom design-example disclaimer. No cropping or redesign.
```
