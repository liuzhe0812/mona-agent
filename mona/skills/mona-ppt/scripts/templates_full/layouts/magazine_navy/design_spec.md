---
layout_id: magazine_navy
kind: layout
summary: Business magazine editorial style for executive briefings, industry research, annual reviews, and premium business presentations.
canvas_format: ppt169
page_count: 11
page_types: [cover, toc, chapter, content, ending]
---

# Magazine Navy (深蓝杂志风) — Design Specification

## I. Template Overview

| Property | Description |
| --- | --- |
| **Template Name** | magazine_navy |
| **Use Cases** | Executive briefings, industry research reports, annual reviews, premium business presentations |
| **Design Tone** | Editorial, restrained, high-end; generous whitespace, hairline rules, oversized ghost numerals, masthead-style kickers, asymmetric grid |
| **Theme Mode** | Mixed: warm paper-white content pages + deep navy feature pages (cover/chapter/quote/ending) |

一眼可辨的三件事：金色 kicker 短线、超大低透明度装饰数字、无处不在的发丝线分割。

## II. Color Scheme

| Role | HEX | Usage |
| --- | --- | --- |
| Background (light) | `#FAF7F2` | 暖纸白，内容页整页底色 |
| Primary | `#16264C` | 深海军蓝：标题、大色块、深色页底色 |
| Accent | `#C9A227` | 暖金，仅小面积：kicker 短线、序号、bullet、装饰点/块 |
| Body text | `#3C4657` | 正文、特性列表 |
| Muted text | `#8A94A6` | 辅助说明、页脚、来源行 |
| Hairline | `#D8D2C4` | 0.75–1px 发丝分割线、浅描边 |
| Card wash | `#F4F1EA` | KPI 卡极浅底（可选，配发丝线描边） |

深色页反白规则：底色 `#16264C`，主文字 `#FAF7F2`，次级文字 `#FAF7F2` + fill-opacity 0.55–0.6，点缀仍用 `#C9A227`。禁止纯白 `#FFFFFF` 文字。

## III. Signature Design Elements

- **Kicker（刊头标签）**：36×2px 金色短线 + 右侧 13px 金色全大写英文标签（letter-spacing 3），出现在封面、目录、章节页与所有内容页页眉。
- **超大装饰数字**：180–260px bold，fill-opacity 0.04–0.15；浅色页用深蓝/金色低透明，深色页用金色 `#C9A227` 0.15 或白色 0.06（如章节号、结尾年份）。
- **发丝线分割**：1px `#D8D2C4`，用于页眉下、页脚上、目录条目间、双栏中缝、流程连接段。
- **标准页脚**：底部 1px 发丝线（y=664）+ 左侧 8×8 金色小方块与 `{{SECTION_NAME}}`（11px）+ 右侧 `{{PAGE_NUM}}`（12px 弱化色）。
- **不对称网格**：内容偏左 2/3，右侧 1/3 留白或放置装饰（封面右侧金色矩形色块、目录左侧 1/3 深蓝竖块）。

## IV. Typography

| Level | Size | Weight | Color | Notes |
| --- | --- | --- | --- | --- |
| 封面主标题 | 60px | bold | `#16264C` | 两行 tspan 预分行 |
| 章节标题 / 目录页标题 | 44px | bold | 反白 / 白 | 深色页 |
| 结尾致谢 | 48px | bold | `#FAF7F2` | 居中 |
| 页标题（action title） | 30px | bold | `#16264C` | 内容页页眉 |
| 引用正文 | 30px | regular | `#FAF7F2` | 2–3 行 tspan |
| KPI 大数字 | 44px | bold | `#16264C` | Arial 数字优先 |
| 栏标题 / 选项名 | 18px | bold | `#16264C` | 中栏推荐项反白 |
| 正文 / 要点 | 15–16px | regular | `#3C4657` | 要点配金色 bullet |
| 辅助说明 | 12–13px | regular | `#8A94A6` | |
| 页脚 / 来源行 | 11–12px | regular | `#8A94A6` | |
| Kicker | 13px | regular | `#C9A227` | 全大写 + letter-spacing 3 |
| 超大装饰数字 | 120–260px | bold | 见 III | 仅装饰，不承载信息 |

中文字体栈 `"Microsoft YaHei, SimHei, sans-serif"`；纯数字/英文可用 `"Arial, Microsoft YaHei, sans-serif"`。

## V. Page Roster

| File | Role | Description |
| --- | --- | --- |
| `01_cover.svg` | cover | 纸白底 + 网格纹理；kicker、`{{TITLE}}`（两行 tspan）、`{{SUBTITLE}}`、发丝线、`{{PRESENTER}}`/`{{ORGANIZATION}}`/`{{DATE}}`，右下金色矩形色块 |
| `02_toc.svg` | toc | 左 1/3 深蓝竖块（`{{PAGE_TITLE}}` + 低透明 CONTENTS 装饰）；右侧 5 条目录（金色序号 01–05 + `{{TOC_ITEM_N_TITLE}}` + `{{TOC_ITEM_N_DESC}}` + 发丝线） |
| `02_chapter.svg` | chapter | 深蓝底；kicker + 260px 金色低透明 `{{CHAPTER_NUM}}` + `{{CHAPTER_TITLE}}`/`{{CHAPTER_SUB}}` + 底部金色短线 |
| `03_content.svg` | content | 标准页眉页脚 + 虚线框自由内容区 `{{CONTENT_AREA}}` |
| `03a_content_two_col.svg` | content | 双栏：中缝竖发丝线，`{{COL_LEFT_TITLE}}`/`{{COL_RIGHT_TITLE}}` 各带 4 条金色方块 bullet 要点 |
| `03b_content_metrics.svg` | content | 4 张 KPI 卡（金线 + `{{METRIC_N_VALUE}}` 44px + label + desc），底部 `{{FOOTNOTE}}` 来源行 |
| `03c_content_comparison.svg` | content | 三栏对比：中栏深蓝顶条 + 深蓝描边突出推荐，左右浅顶条；每栏 4 行金色圆点特性 |
| `03d_content_process.svg` | content | 横向 5 步：48px 深蓝描边圆章（金色序号）+ 发丝线连接 + `{{STEP_N_TITLE}}`/`{{STEP_N_DESC}}`（2 行 tspan） |
| `03e_content_timeline.svg` | content | 横向 2px 深蓝主线，5 个金色圆点节点上下交错，`{{TL_N_YEAR}}`/`{{TL_N_TITLE}}`/`{{TL_N_DESC}}` |
| `03f_content_quote.svg` | content | 深蓝底；240px 金色低透明引号 + `{{QUOTE_TEXT}}` 30px 反白多行 + 金线 + `{{QUOTE_AUTHOR}}`/`{{QUOTE_ROLE}}` |
| `04_ending.svg` | ending | 深蓝底；居中 `{{THANKS_TITLE}}`/`{{THANKS_SUB}}` + 金线 + `{{CONTACT_INFO}}`/`{{ORGANIZATION}}`，右下同心圆 + `{{YEAR}}` 低透明装饰 |
