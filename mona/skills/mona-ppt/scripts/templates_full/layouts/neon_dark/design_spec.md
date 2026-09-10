---
layout_id: neon_dark
kind: layout
summary: Dark neon tech style for product launches, tech talks, AI/digital topics, and developer-facing presentations.
canvas_format: ppt169
page_count: 11
page_types: [cover, toc, chapter, content, ending]
placeholders:
  01_cover: ["{{KICKER}}", "{{TITLE}}", "{{TITLE_ACCENT}}", "{{SUBTITLE}}", "{{PRESENTER}}", "{{ORGANIZATION}}", "{{DATE}}"]
  02_toc: ["{{KICKER}}", "{{PAGE_TITLE}}", "{{TOC_ITEM_1_TITLE}}", "{{TOC_ITEM_1_DESC}}", "{{TOC_ITEM_2_TITLE}}", "{{TOC_ITEM_2_DESC}}", "{{TOC_ITEM_3_TITLE}}", "{{TOC_ITEM_3_DESC}}", "{{TOC_ITEM_4_TITLE}}", "{{TOC_ITEM_4_DESC}}", "{{TOC_ITEM_5_TITLE}}", "{{TOC_ITEM_5_DESC}}", "{{PAGE_NUM}}"]
  02_chapter: ["{{CHAPTER_NUM}}", "{{CHAPTER_TITLE}}", "{{CHAPTER_SUB}}", "{{KICKER}}"]
  03_content: ["{{KICKER}}", "{{PAGE_TITLE}}", "{{CONTENT_AREA}}", "{{PAGE_NUM}}"]
  03a_content_two_col: ["{{KICKER}}", "{{PAGE_TITLE}}", "{{COL_LEFT_TITLE}}", "{{COL_RIGHT_TITLE}}", "{{LEFT_POINT_1}}", "{{LEFT_POINT_2}}", "{{LEFT_POINT_3}}", "{{LEFT_POINT_4}}", "{{RIGHT_POINT_1}}", "{{RIGHT_POINT_2}}", "{{RIGHT_POINT_3}}", "{{RIGHT_POINT_4}}", "{{PAGE_NUM}}"]
  03b_content_metrics: ["{{KICKER}}", "{{PAGE_TITLE}}", "{{METRIC_1_VALUE}}", "{{METRIC_1_LABEL}}", "{{METRIC_1_DESC}}", "{{METRIC_2_VALUE}}", "{{METRIC_2_LABEL}}", "{{METRIC_2_DESC}}", "{{METRIC_3_VALUE}}", "{{METRIC_3_LABEL}}", "{{METRIC_3_DESC}}", "{{METRIC_4_VALUE}}", "{{METRIC_4_LABEL}}", "{{METRIC_4_DESC}}", "{{FOOTNOTE}}", "{{PAGE_NUM}}"]
  03c_content_comparison: ["{{KICKER}}", "{{PAGE_TITLE}}", "{{OPTION_1_NAME}}", "{{OPTION_1_FEAT_1}}", "{{OPTION_1_FEAT_2}}", "{{OPTION_1_FEAT_3}}", "{{OPTION_1_FEAT_4}}", "{{OPTION_2_NAME}}", "{{OPTION_2_TAG}}", "{{OPTION_2_FEAT_1}}", "{{OPTION_2_FEAT_2}}", "{{OPTION_2_FEAT_3}}", "{{OPTION_2_FEAT_4}}", "{{OPTION_3_NAME}}", "{{OPTION_3_FEAT_1}}", "{{OPTION_3_FEAT_2}}", "{{OPTION_3_FEAT_3}}", "{{OPTION_3_FEAT_4}}", "{{PAGE_NUM}}"]
  03d_content_process: ["{{KICKER}}", "{{PAGE_TITLE}}", "{{STEP_1_TITLE}}", "{{STEP_1_DESC}}", "{{STEP_2_TITLE}}", "{{STEP_2_DESC}}", "{{STEP_3_TITLE}}", "{{STEP_3_DESC}}", "{{STEP_4_TITLE}}", "{{STEP_4_DESC}}", "{{STEP_5_TITLE}}", "{{STEP_5_DESC}}", "{{PAGE_NUM}}"]
  03e_content_timeline: ["{{KICKER}}", "{{PAGE_TITLE}}", "{{TL_1_YEAR}}", "{{TL_1_TITLE}}", "{{TL_1_DESC}}", "{{TL_2_YEAR}}", "{{TL_2_TITLE}}", "{{TL_2_DESC}}", "{{TL_3_YEAR}}", "{{TL_3_TITLE}}", "{{TL_3_DESC}}", "{{TL_4_YEAR}}", "{{TL_4_TITLE}}", "{{TL_4_DESC}}", "{{TL_5_YEAR}}", "{{TL_5_TITLE}}", "{{TL_5_DESC}}", "{{PAGE_NUM}}"]
  03f_content_quote: ["{{QUOTE_TEXT}}", "{{QUOTE_TEXT_2}}", "{{QUOTE_TEXT_3}}", "{{QUOTE_AUTHOR}}", "{{QUOTE_ROLE}}", "{{PAGE_NUM}}"]
  04_ending: ["{{THANKS_TITLE}}", "{{THANKS_SUB}}", "{{CONTACT_INFO}}", "{{ORGANIZATION}}", "{{PAGE_NUM}}"]
---

# Neon Dark (深色霓虹科技风) — Design Specification

## I. Template Overview

`neon_dark` 是一套深色模式（dark-mode）版式库，面向产品发布会、技术分享、AI / 数字化议题与开发者向演示。识别特征：深石板蓝对角渐变画布 + 电青 / 紫罗兰霓虹点缀 + 玻璃拟态卡片（glassmorphism）+ 双层叠印发光线条，整体呈现高端科技发布会 keynote 的暗色质感。全部视觉均为 clean-room 原创：无外部模板资产、不使用滤镜元素，所有发光效果由「低透明度粗底层 + 全色细上层」双层叠印实现，保证 PPTX 导出兼容。

## II. Color Scheme

| HEX | 角色 |
|-----|------|
| `#0B1220` → `#131C2E` | 页面背景对角渐变（linearGradient 45°） |
| `#22D3EE` | 主强调（电青）：kicker、发光分隔线、序号、KPI 大数字、时间线主线 |
| `#8B5CF6` | 次强调（紫罗兰）：氛围光晕、第二/四 KPI 卡、时间线交错节点、右栏 bullet |
| `#34D399` | 成功 / 正向（保留色，仅在 metrics 涨 / 正向语义时替换 KPI 数字色） |
| `#E6EDF7` | 主文字 |
| `#C9D4E5` | 列表要点文字（略低于主文字一档） |
| `#7A8BA8` | 弱化文字（描述、页脚、脚注） |
| `#FFFFFF` @ fill-opacity 0.04 | 玻璃卡片填充 |
| `#22D3EE` @ stroke-opacity 0.18 | 玻璃卡片描边（推荐卡升至 0.5） |
| `#FFFFFF` @ stroke-opacity 0.08–0.12 | 发丝线（时间线节点引线） |

## III. Signature Design Elements

- **双层发光分隔线**：标题下方固定 160px；底层 `stroke-width="6"` + `stroke-opacity="0.15"` 电青（光晕），上层 `stroke-width="1.5"` 全色电青，`stroke-linecap="round"`。
- **点阵网格背景**：`<pattern>` 48×48 userSpaceOnUse，内部 r=1 圆 `fill="#FFFFFF" fill-opacity="0.06"`，整页 rect 引用；带 `data-pptx-pattern="dotGrid"` + `data-pptx-fg="#1C2942"` + `data-pptx-bg="#101828"` 注解，确保 PPTX 导出为深色点阵预设而非白底。
- **玻璃拟态卡片**：`rx="14"`，`fill="#FFFFFF" fill-opacity="0.04"` + `stroke="#22D3EE" stroke-opacity="0.18"`；深色底上禁止投影，层级靠描边透明度表达（对比页推荐卡 0.5）。
- **kicker 发光方块**：16×16 圆角方块 `fill-opacity="0.15"` 光晕 + 8×8 全色电青核心，右侧 12px 电青 `letter-spacing="3"` 英文标签。
- **发光圆点**：外层 r=8（页脚用小号 r=5）`fill-opacity="0.2"` + 内层 r=3.5（页脚 r=2.2）全色，用于 bullet、电路线末端、页脚三圆点（青 / 紫 / 青）。
- **电路线条装饰**：polyline 折线（`stroke-opacity="0.2"`，1.5px）+ 同色 6px `stroke-opacity="0.04"` 光晕底层，末端发光圆点收尾；用于封面右下、章节页、正文页右上、结尾页底部。
- **氛围光晕**：radialGradient 大圆（紫罗兰 / 电青），stop 由强调色过渡到背景色（渐变端点不设透明度），圆元素自身 `fill-opacity` 0.3–0.5，边缘无缝融入底色。
- **超大装饰字符**：封面 260px「»」、章节页 280px 章节数字，均 `fill="#22D3EE"` + `fill-opacity` 0.05–0.06 做底纹。

## IV. Typography

字体栈：中文 `"Microsoft YaHei, SimHei, sans-serif"`；数字 / 序号 / 装饰字符 `"Arial, Microsoft YaHei, sans-serif"`。

| 角色 | 字号 | 字重 | 颜色 |
|------|------|------|------|
| 封面主标题 | 58px | bold | `#E6EDF7`（第二行强调行 `#22D3EE`） |
| 结尾致谢标题 | 46px | bold | `#E6EDF7` |
| 章节标题 | 42px | bold | `#E6EDF7` |
| KPI 大数字 | 42px | bold | 电青 / 紫罗兰交替 |
| 目录页标题 | 30px | bold | `#E6EDF7` |
| 页标题（内容页） | 28px | bold | `#E6EDF7` |
| 引用正文 | 28px | regular | `#E6EDF7` |
| 超大装饰数字 / 字符 | 200–280px | bold | `#22D3EE` @ fill-opacity 0.05–0.06 |
| 封面副标题 | 20px | regular | `#7A8BA8` |
| 卡片 / 栏目标题 | 17px | bold | 电青或 `#E6EDF7` |
| 正文 / 要点 | 14–16px | regular | `#E6EDF7` / `#C9D4E5` |
| 辅助描述 | 12–13px | regular | `#7A8BA8` |
| kicker | 12px | regular + letter-spacing 3 | `#22D3EE` |
| 页脚 / 脚注 | 11px | regular | `#7A8BA8` |

## V. Page Roster

| File | Role | Description |
|------|------|-------------|
| `01_cover.svg` | cover | 深渐变底 + 点阵 + 紫罗兰 / 电青双向氛围光；kicker + 双行 58px 主标题（第二行电青强调）+ 发光分隔线 + 20px 副标题；左下演讲者 / 机构，右下日期；右下 260px「»」底纹 + 电路线装饰 |
| `02_toc.svg` | toc | kicker + 30px 目录标题；5 张纵向玻璃条目卡（高 88px），每卡电青发光序号（01–05）+ 条目标题 18px + 描述 13px + 右端发光 › 箭头 |
| `02_chapter.svg` | chapter | 左侧 280px 超低透明章节数字底纹，右侧 kicker + 42px 章节标题 + 发光分隔线 + 16px 副述；右下紫罗兰氛围光 + 电路线装饰 |
| `03_content.svg` | content | 标准页眉（kicker + 28px 页标题 + 发光分隔线 + 右上电路线）+ 居中大玻璃卡片自由内容区（`{{CONTENT_AREA}}`）+ 标准页脚 |
| `03a_content_two_col.svg` | content | 双栏玻璃卡片（566px × 2，间距 28px）；每栏 17px 电青栏题 + 短发光线下 4 条发光圆点要点（左栏青、右栏紫 bullet） |
| `03b_content_metrics.svg` | content | 横向 4 张 KPI 玻璃卡（272px 等宽）；卡顶 2px 对应色发光线，42px 大数字（1/3 卡电青、2/4 卡紫罗兰）+ 14px 标签 + 12px 描述；底部 11px 脚注 |
| `03c_content_comparison.svg` | content | 三栏玻璃对比卡（368px 等宽）；中栏描边升至 0.5 电青表推荐 + 顶部电青胶囊标签（10px 白字）；每栏 17px 方案名 + 4 行特性（✓ 电青 / ✗ 弱化色） |
| `03d_content_process.svg` | content | 横向五步流程：发光连接线（双层）上均布 5 枚序号章（外发光 r=30 + 深底描边内圆 + 电青 18px 编号），下方 15px 步骤标题 + 12px 描述 |
| `03e_content_timeline.svg` | content | 横向时间线主线（2px 双层发光线，y=330），5 节点上下交错排布：发光圆点（青 / 紫交替）+ 18px 电青年份 + 14px 事件标题 + 12px 描述 |
| `03f_content_quote.svg` | content | 引用 / 金句页：左上 220px 紫罗兰 “ 字符底纹 + 左下紫罗兰氛围光；居中 28px 引用（3 行 tspan）+ 发光分隔线 + 15px 电青作者 + 12px 身份 |
| `04_ending.svg` | ending | 中央电青氛围光托底：46px 致谢标题 + 15px 电青副标 + 发光分隔线 + 13px 联系方式 / 机构；底部左右双电路线（青 / 紫）收尾 + 标准页脚 |
