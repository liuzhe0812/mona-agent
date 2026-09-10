---
layout_id: consulting_pro
kind: layout
summary: Premium consulting style for strategy reports, board presentations, due diligence, and formal executive briefings.
canvas_format: ppt169
page_count: 11
page_types: [cover, toc, chapter, content, ending]
---

# Consulting Pro (顶级咨询风) — Design Specification

## I. Template Overview

面向战略报告、董事会汇报、尽调简报与正式高管汇报的顶级咨询风（麦肯锡/BCG 级）：白底 + Action Title（完整论断式标题）驱动叙事，每页以 kicker、Exhibit 编号、发丝线分栏与来源行构成严谨的证据链版式。识别特征是「排版纪律即装饰」——不靠色块与渐变，靠网格、发丝线与克制的双色体系营造正式感与高级感。

## II. Color Scheme

| HEX | Role | Usage |
|-----|------|-------|
| `#FFFFFF` | 背景 | 全页面底色 |
| `#005587` | 主色（咨询深蓝） | kicker、封面/目录标题、栏标题、表头、关键数字、短粗线、流程描边、时间轴主线 |
| `#F2A900` | 强调色（琥珀） | 仅极小面积：推荐标记、当前流程步/时间轴节点、关键指标 2px 下划线 |
| `#1A1A1A` | 正文文字 | Action Title、正文、条目标题、数值标签 |
| `#5B6770` | 弱化文字 | 副标题、描述、来源行、Exhibit 签、页脚 |
| `#C8CDD2` | 发丝线 | 标题下全宽线、栏间竖线、行间横线、页脚线、虚线占位框 |
| `#F4F6F8` | 浅底卡片 | 目录序号方块、流程块底色、封面网格装饰 |

**用色纪律**：一页内除黑白灰外以 `#005587` 为绝对主导；琥珀 `#F2A900` 出现不超过 2 处，且面积必须极小（标签、节点、下划线级别）；多栏之间只用竖向发丝线分隔，禁止用色块区隔。

## III. Signature Design Elements

- **Kicker + 短粗线**：页眉左上角 12px bold `#005587` 小号标签（`letter-spacing: 2`，章节/领域名），下方紧跟 28×3px `#005587` 短粗线。
- **Action Title 区**：kicker 下方为 24px bold `#1A1A1A` 完整论断式标题（支持两行），标题下 1px 全宽发丝线 `#C8CDD2`（x: 64→1216, y=126）。
- **Exhibit 编号签**：内容区右上角 `Exhibit {{EXHIBIT_NUM}}`，11px bold `#5B6770`，右对齐（x=1216, y=60）。
- **页脚三件套**：底部 0.75px 发丝线（y=664）+ 左侧来源行（`{{FOOTNOTE}} 来源：{{SOURCE}}`，11px `#5B6770`）+ 右侧页码 `{{PAGE_NUM}}`。
- **发丝线分栏**：双栏/三栏/KPI 区之间一律 1px 竖向 `#C8CDD2` 发丝线，禁止卡片底色或色块分隔。
- **封面/结尾通栏条**：顶部 4px `#005587` 全宽横条，标题区下方 80×3px 深蓝短线收束视线。

## IV. Typography

| Level | Size / Weight / Color | Usage |
|-------|----------------------|-------|
| 封面主标题 | 48px bold `#005587` | `{{TITLE}}`，支持两行 tspan |
| 章节号 | 96px bold 白色 | `{{CHAPTER_NUM}}`（深蓝竖条内） |
| 结尾致谢 | 40px bold `#005587` | `{{THANKS_TITLE}}` |
| 目录大序号 | 40px bold `#005587` | 64×64 `#F4F6F8` 方块内两位序号 |
| 章节标题 | 36px bold `#1A1A1A` | `{{CHAPTER_TITLE}}` |
| 目录页标题 | 26px bold `#005587` | `{{PAGE_TITLE}}`（目录） |
| Action Title | 24px bold `#1A1A1A` | 内容页论断式标题，上方配 12px kicker |
| 引用正文 | 24px `#1A1A1A` | `{{QUOTE_TEXT}}`，2-3 行 tspan |
| 副标题 | 18px `#5B6770` | 封面 `{{SUBTITLE}}` |
| 栏/卡片标题 | 16-17px bold `#005587` | 双栏标题、KPI 标签、时间轴年份、目录条目 17px `#1A1A1A` |
| 表头 | 15px bold 白色 | 对比页深蓝表头条内 |
| 正文 | 13-15px `#1A1A1A` | 要点、特性行、信息值 |
| 辅助/描述 | 11-12px `#5B6770` | 描述、来源行、Exhibit 签、页脚 |
| Kicker | 12px bold `#005587` | 章节/领域小标签 |
| Exhibit 签 | 11px bold `#5B6770` | `Exhibit {{EXHIBIT_NUM}}` |

字体栈：中文 `"Microsoft YaHei, SimHei, sans-serif"`；数字/拉丁优先 `"Arial, Microsoft YaHei, sans-serif"`。

## V. Page Roster

| File | Role | Description |
|------|------|-------------|
| `01_cover.svg` | cover | 封面：4px 深蓝通栏条 + kicker + 48px 主标题 + 汇报人/机构/日期左列 + 浅灰网格装饰 |
| `02_toc.svg` | toc | 目录页：5 条目（64×64 浅底序号方块 + 17px 标题 + 右侧弱化描述），条目间发丝线 |
| `02_chapter.svg` | chapter | 章节过渡页：左侧 220px 深蓝竖条（白色 CHAPTER + 96px 章节号）+ 右侧 36px 章节标题 |
| `03_content.svg` | content | 基础正文页：标准 Action Title 页眉 + Exhibit 签 + 虚线自由内容区 + 页脚三件套 |
| `03a_content_two_col.svg` | content | 双栏正文页：中缝竖发丝线，每栏 16px 深蓝栏标题 + 4 条方块 bullet 要点 |
| `03b_content_metrics.svg` | content | KPI 大数字页：4 指标竖发丝线分隔，46px 深蓝大数字，首要指标琥珀 2px 下划线 |
| `03c_content_comparison.svg` | content | 三栏对比页：深蓝表头条（中栏带琥珀推荐标签）+ 4 行特性，行间/栏间发丝线 |
| `03d_content_process.svg` | content | 五步流程页：chevron 闭合多边形（浅底深蓝描边，当前步深蓝实心白字）+ 下方描述 |
| `03e_content_timeline.svg` | content | 时间线页：2px 深蓝主线 + 5 圆环节点（当前节点琥珀实心），节点上下交错排布 |
| `03f_content_quote.svg` | content | 引用/金句页：6px 深蓝竖引用条 + 浅灰引号装饰 + 24px 引文 + 深蓝署名 |
| `04_ending.svg` | ending | 结尾页：通栏条 + 居中 40px 致谢标题 + 80px 短线 + 联系方式/机构 + 底部发丝线页脚 |
