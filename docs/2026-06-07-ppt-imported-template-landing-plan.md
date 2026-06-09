# AI PPT 导入品牌/模板落地方案

## 背景

现在用户把一个 PPT 上传进 Mona 后，前端展示上容易让人以为“我导入了一个模板，后面生成 PPT 会按这个模板的版式来做”。但实际链路不是这样。

当前导入链路把上传的 PPT 存成了 `brand` 类型，也就是“品牌预设”。它主要提供颜色、字体、封面截图、原始 `template.pptx`，并不会把原 PPT 每一页的版式拆成可复用的页面模板。所以生成时 AI 只是知道“使用这个品牌”，并不会稳定使用原 PPT 的封面、目录页、章节页、内容页、结束页等结构。

这不是一个小提示词问题，本质是产品概念和模板数据结构没对齐：

- `brand`：只锁品牌视觉，不锁页面结构。
- `layout`：锁部分页面版式，适合通用版式库。
- `deck`：锁完整模板结构，最符合用户上传一套 PPT 后“按这个模板生成”的预期。

所以要真正落地，不能继续把“上传 PPT 模板”塞进 `brand` 里，需要把“品牌导入”和“完整模板导入”拆开。

## 目标

这次目标不是做一个看起来能选模板的入口，而是让用户导入的 PPT 真正影响后续生成结果。

上线后需要达到这些效果：

1. 用户上传 PPT 后，可以明确选择“只提取品牌”或“导入为完整模板”。
2. 选择“完整模板”时，系统会把源 PPT 的页面拆成可复用的 SVG 页面模板，并注册为 `deck`。
3. 生成 PPT 时，如果用户选了这个 `deck`，AI 会按模板页清单选择封面、目录、章节、内容、结束页等版式。
4. `spec_lock.md` 里能看到每页对应的模板页引用，而不是空的 `page_layouts`。
5. 生成出来的 SVG/PPTX 在版式节奏、标题区、页脚、色块、图片位、章节页风格上能明显继承导入模板。
6. 只导入品牌时，系统不再暗示“会继承页面版式”，避免用户误解。

## 推荐产品方案

### 模板类型拆分

保留三类模板，但在前端文案和后端数据里说清楚：

| 类型 | 用户看到的名字 | 作用 | 适合场景 |
| --- | --- | --- | --- |
| `brand` | 品牌 | 只控制颜色、字体、Logo、基础视觉调性 | 用户只想统一品牌，不要求照着源 PPT 排版 |
| `layout` | 版式模板 | 提供一组通用页面版式 | 公司通用版式库、行业版式库 |
| `deck` | 完整模板 | 继承一整套 PPT 的页面结构和视觉风格 | 用户上传一份现成 PPT，希望后续按它生成 |

短期默认推荐用户使用 `deck`。因为用户说“导入模板”时，大多数情况下要的是完整模板，不是单纯品牌色。

### 前端交互

现在的“导入品牌模板”建议拆成两个入口：

1. `导入品牌`
   - 当前能力保留。
   - 文案改成“只提取颜色、字体、Logo 等品牌信息，不固定页面版式”。

2. `导入完整模板`
   - 新增能力。
   - 文案写清楚“会尽量保留源 PPT 的页面结构，生成时按这些页面版式来做”。
   - 上传后默认保存为 `deck`。

导入弹窗里可以给三个选项，但默认项要简单：

| 选项 | 后端类型 | 默认 |
| --- | --- | --- |
| 保留原模板风格 | `deck` | 推荐 |
| 只提取品牌 | `brand` | 非默认 |
| 只提取版式 | `layout` | 后续增强 |

短期先做 `deck` 和 `brand` 两个模式，`layout` 可以先不开放或只给内部使用。

## 技术方案

### 当前问题链路

现在的关键问题有 7 个：

1. 后端导入 PPT 时使用了 `--manifest-only`，只生成基础清单，没有生成完整 SVG 页面模板。
2. 导入结果放到了 `templates/brands/<name>`，类型是 `kind: brand`。
3. `design_spec.md` 里写的是“页面自由组合”，没有页面模板清单。
4. 前端 prompt 虽然传了 `--template <brand>/template.pptx`，但这个参数只在导出 PPTX 时保留母版壳子，不会让 AI 在生成 SVG 时自动继承每页版式。
5. 模板列表和预览接口目前主要支持 `layout`、`brand`，没有完整接入 `deck`。
6. 当前 `pptx_template_import.py` 实际只调用 `build_manifest()`，它不负责渲染 SVG；`svg-flat/slide_*.svg` 来自 `pptx_to_svg.py`。
7. 当前磁盘上没有 `templates/decks/` 和 `decks_index.json`，`register_template.py` 虽然支持 `deck`，但这条链路还没有真正跑过。

### 新增完整模板导入链路

新增一条 `deck` 导入链路，不破坏原有 `brand`。

完整模板导入流程要串联两个脚本，不能只靠 `pptx_template_import.py`：

1. 用户上传 PPTX。
2. 后端调用 `pptx_template_import.py <pptx> -o <workspace>`，产出：
   - `manifest.json`
   - `assets/`
3. 后端调用 `pptx_to_svg.py <pptx> -o <workspace> --inheritance-mode both`，产出：
   - `svg/master_*.svg`
   - `svg/layout_*.svg`
   - `svg/slide_*.svg`
   - `svg-flat/slide_*.svg`
4. 系统把 `svg-flat/slide_*.svg` 复制成模板页文件。
5. 生成 `design_spec.md`，类型写成 `kind: deck`。
6. 保存到 `scripts/templates_full/decks/<template_id>`，同时同步到 `templates/decks/<template_id>`。
7. 更新两边的 `decks_index.json`。
8. 模板列表接口返回这个 `deck`。
9. 生成 PPT 时，前端把 `kind: deck` 和模板路径传进 prompt。
10. Skill 在 Step 3/4/5 读取这个 `deck` 的页面清单，并把每页模板选择写入 `spec_lock.md`。

这里要特别注意：`scripts/templates_full` 是 Web UI 当前读取的模板库，`templates` 是 AI skill 执行时读取的模板库。短期最稳的做法是两边都写，沿用现在 brand 导入的同步方式。

### Deck 目录结构

建议生成后的目录长这样：

```text
mona/skills/mona-ppt/templates/decks/<template_id>/
  design_spec.md
  manifest.json
  01.svg
  02.svg
  03.svg
  04.svg
  05.svg
  06.svg
  assets/
```

MVP 阶段不要做页面类型推断，直接按源 PPT 顺序命名：`01.svg`、`02.svg`、`03.svg`。这样最稳，不依赖 `manifest.json` 的页面类型识别能力。

后续再增强成 `01_cover.svg`、`02_toc.svg`、`03_section.svg` 这类语义命名。现在 `manifest.py` 里只有一些基础关键词识别，拿它做上线主链路风险偏高。

### design_spec.md 要求

`deck` 的 `design_spec.md` 不能只写品牌信息，必须包含页面模板清单。建议格式：

```markdown
---
name: 展会PPT模版
kind: deck
canvas: 16:9
replication_mode: mirror
source_pptx: template.pptx
---

# Template Overview

这是一套从用户上传 PPTX 导入的完整模板。生成时优先复用页面结构，再替换内容。

# Page Roster

| Template SVG | Page Type | Source Slide | Use When |
| --- | --- | --- | --- |
| 01.svg | source-order | 1 | 源 PPT 第 1 页 |
| 02.svg | source-order | 2 | 源 PPT 第 2 页 |
| 03.svg | source-order | 3 | 源 PPT 第 3 页 |
| 04.svg | source-order | 4 | 源 PPT 第 4 页 |
| 05.svg | source-order | 5 | 源 PPT 第 5 页 |
| 06.svg | source-order | 6 | 源 PPT 第 6 页 |

# Usage Rules

- Strategist 必须从 Page Roster 里为每页选择模板。
- 选择结果必须写入 `spec_lock.md` 的 `page_layouts`。
- Executor 必须先读取对应 SVG，再替换内容，不要自由重画整页。
- 如果没有合适模板页，才允许自由设计，并在 `spec_lock.md` 写明原因。
```

这个文件是后续生成能不能稳定的关键。没有 Page Roster，AI 很容易又回到自由发挥。

MVP 的 Page Roster 先不承诺页面类型，只承诺“源 PPT 第几页”。这会牺牲一点智能选择能力，但能显著降低导入失败率。

### Prompt 和 Skill 调整

`mona-ppt` 里已经有 `brand/layout/deck` 的概念，但前端传参和导入数据没有把 `deck` 跑通。

需要补这几条硬约束：

1. 选择 `brand` 时：
   - 只说“使用品牌视觉”。
   - 不再说“模板母版/布局会自动继承”。

2. 选择 `deck` 时：
   - 明确传路径：`mona/skills/mona-ppt/templates/decks/<template_id>`。
   - 要求读取 `design_spec.md` 的 Page Roster。
   - 要求 `spec_lock.md.page_layouts` 不得为空。
   - 要求每页生成前先读取对应模板 SVG。

3. 选择 `layout` 时：
   - 按现有通用版式模板逻辑走。

一句话规则：

```text
brand 控制视觉，deck 控制视觉 + 页面结构。不要用 brand 冒充 deck。
```

### 导出前硬校验

只靠 prompt 和 SKILL.md 不够。历史上 AI 可能会跳过规则，所以需要在导出脚本里加一道硬检查。

建议在 `svg_to_pptx/pptx_cli.py` 里加一个 deck 项目校验：

1. 如果项目的 `templates/design_spec.md` frontmatter 是 `kind: deck`。
2. 或者项目 metadata / prompt 配置里记录了 `templateKind=deck`。
3. 那么导出前必须读取 `spec_lock.md`。
4. `spec_lock.md` 里必须存在 `page_layouts`，并且至少有一条页面映射。
5. 每个映射的 SVG basename 必须能在项目 `templates/` 目录里找到。
6. 不满足就直接导出失败，提示“完整模板项目缺少 page_layouts，请先重新生成/修复 spec_lock”。

这道检查不是为了保证页面一定好看，而是防止“用户选了完整模板，但 AI 实际自由设计”的情况悄悄通过。

## 涉及文件

### 前端

| 文件 | 修改点 |
| --- | --- |
| `webui/src/components/ppt/PptMakerView.tsx` | `templateKind` 增加 `deck`；prompt 根据 `brand/layout/deck` 分支生成不同指令 |
| `webui/src/components/ppt/PptConfigPanel.tsx` | 模板选择状态支持 `deck` |
| `webui/src/components/ppt/PptTemplateDialog.tsx` | 增加完整模板分类和展示 |
| `webui/src/components/ppt/PptBrandImportView.tsx` | 建议改名或新增完整模板导入入口 |
| `webui/src/lib/types` | 模板类型从 `brand/layout` 扩展为 `brand/layout/deck` |

### 后端

| 文件 | 修改点 |
| --- | --- |
| `mona/channels/websocket.py` | 新增完整模板导入/保存事件；模板 API 支持 `deck` |
| `mona/skills/mona-ppt/scripts/pptx_template_import.py` | 继续负责 `manifest.json + assets`，不要把它当 SVG 渲染器 |
| `mona/skills/mona-ppt/scripts/pptx_to_svg.py` | 新导入链路必须调用它生成 `svg-flat/slide_*.svg` |
| `mona/skills/mona-ppt/scripts/materialize_deck_template.py` | 新增；把导入工作区物化成 `deck` 模板目录 |
| `mona/skills/mona-ppt/scripts/register_template.py` | 确保支持注册 `deck` |
| `mona/skills/mona-ppt/scripts/templates_full/decks/decks_index.json` | Web UI 模板列表读取这里 |
| `mona/skills/mona-ppt/templates/decks/decks_index.json` | AI skill 执行读取这里 |
| `mona/skills/mona-ppt/scripts/svg_to_pptx/pptx_cli.py` | 增加 deck 导出前 `page_layouts` 校验 |
| `mona/skills/mona-ppt/references/template-selection.md` | 补充 `deck` 被前端选择时的强执行规则 |
| `mona/skills/mona-ppt/SKILL.md` | 补一句：选中完整模板时，`page_layouts` 必须落地 |

### 新增建议

建议新增一个小脚本，专门把 PPTX 导入工作区转成 `deck` 模板目录：

```text
mona/skills/mona-ppt/scripts/materialize_deck_template.py
```

这个脚本只做几件事：

1. 读取导入工作区的 `manifest.json`。
2. 读取 `svg-flat/slide_*.svg`。
3. 按源 PPT 顺序生成 `01.svg`、`02.svg` 这类模板文件。
4. 生成 `design_spec.md`。
5. 复制 `assets/`。
6. 调用质量检查。

把这块做成脚本，后端事件里就不会塞太多业务逻辑，后面也方便单独测试。

## 分期计划

### 第 0 期：先把误导文案修掉

工期：0.5 天。

目标：先避免用户继续误会。

要做：

1. 把“导入品牌模板”改成“导入品牌”。
2. 品牌说明改成“提取颜色、字体、Logo，不固定页面版式”。
3. 移除 brand prompt 里的“母版/布局会自动继承”说法。

验收：

1. 用户选品牌时，不会再看到“会套用页面模板”的暗示。
2. brand 生成仍然可用，不影响现有项目。

### 第 1 期：打通 deck 模板列表

工期：1 到 1.5 天。

目标：系统能识别和展示 `deck`，但先不做上传导入。

要做：

1. 前端类型支持 `deck`。
2. 创建 `scripts/templates_full/decks/decks_index.json` 和 `templates/decks/decks_index.json`，初始内容是 `{}`。
3. 模板 SVG 预览接口支持 `kind=deck`，读取 `scripts/templates_full/decks/<id>`。
4. 模板选择弹窗新增“完整模板”分类。
5. 模板列表接口返回 `scripts/templates_full/decks/decks_index.json` 里的内容。
6. 用一个手工放进去的 `deck` 样例验证展示、预览、选择。

验收：

1. 模板弹窗能看到完整模板。
2. 选择完整模板后，生成 prompt 里出现 `templates/decks/<id>`。
3. 空 `decks_index.json` 不会导致接口报错。
4. 不影响现有 `layout` 和 `brand`。

### 第 2 期：打通完整模板导入

工期：2.5 到 3.5 天。

目标：用户上传 PPTX 后，可以生成一个可用的 `deck` 模板。

要做：

1. 新增完整模板上传事件，不复用 brand 保存逻辑。
2. 先调用 `pptx_template_import.py` 生成 `manifest.json + assets`。
3. 再调用 `pptx_to_svg.py --inheritance-mode both` 生成 `svg/` 和 `svg-flat/`。
4. 新增 `materialize_deck_template.py`，把导入工作区转成 `templates/decks/<id>`。
5. MVP 按源页顺序命名模板 SVG：`01.svg`、`02.svg`、`03.svg`。
6. 自动生成带 Page Roster 的 `design_spec.md`。
7. 同步写入 `scripts/templates_full/decks/<id>` 和 `templates/decks/<id>`。
8. 注册两边的 `decks_index.json`。
9. 返回导入结果给前端，包括模板 id、名称、封面预览、质量检查结果。

验收：

1. 上传 `展会PPT模版.pptx` 后，能在完整模板列表看到它。
2. 目录里能看到多个模板 SVG，而不是只有一个封面预览文件。
3. `design_spec.md` 是 `kind: deck`，并且有 Page Roster。
4. Page Roster 使用 `01.svg`、`02.svg` 这种源顺序命名，不依赖页面类型推断。
5. 质量检查能跑完，严重错误会提示用户。

### 第 3 期：让生成过程真正使用 deck

工期：1 到 2 天。

目标：不是“能选”，而是真的用上。

要做：

1. 前端 prompt 针对 `deck` 增加硬要求。
2. Skill Step 3/4 要求 Strategist 读取 Page Roster。
3. `spec_lock.md.page_layouts` 必须记录每页模板选择。
4. Executor 每页生成前必须读取对应模板 SVG。
5. 如果没有合适模板页，必须在 `spec_lock.md` 写原因。
6. `svg_to_pptx/pptx_cli.py` 在导出前校验 deck 项目的 `page_layouts`，缺失时直接失败。

验收：

1. 生成项目里的 `spec_lock.md.page_layouts` 不为空。
2. 日志能看到每页选用了哪个模板页。
3. 生成 SVG 视觉上继承导入模板的版式。
4. 人工删掉 `page_layouts` 后，deck 项目导出会失败。
5. 不再出现“选择了完整模板，但实际自由设计”的情况。

### 第 4 期：质量验证和兜底

工期：1 天。

目标：把常见失败场景挡住，别让用户拿到明显坏模板。

要做：

1. 导入后跑 SVG 质量检查。
2. 检查缺失图片、空白页、画布尺寸不对、严重越界。
3. 有严重问题时提示“导入成功但部分页面不可用”，不要静默失败。
4. 保留源 PPTX，方便后续重新导入。
5. 中文文件名统一转安全 id，展示名保留中文。

验收：

1. 损坏 PPTX 不会注册成可用模板。
2. 图片缺失会在导入结果里提示。
3. 中文模板名在 Windows 路径、接口、前端展示里都正常。

## 最小可上线版本

最小版本建议只做这些：

1. 保留现有品牌导入，但改名为“导入品牌”。
2. 新增“导入完整模板”。
3. 初始化 `scripts/templates_full/decks` 和 `templates/decks`。
4. 完整模板默认保存为 `deck`。
5. `deck` 采用 `mirror` 模式，直接复用 `pptx_to_svg.py` 转出来的 `svg-flat/slide_*.svg`。
6. 模板页按源顺序命名：`01.svg`、`02.svg`、`03.svg`。
7. 生成 `design_spec.md + Page Roster`。
8. 生成时强制 `page_layouts` 写入模板页选择。
9. 导出前检查 deck 项目的 `page_layouts`。

这版已经能解决用户最关心的问题：上传的 PPT 不再只是品牌，而是真的成为页面模板。

先不要急着做“自动抽象成通用布局库”和“页面类型自动识别”。那两件事更复杂，容易做成半成品。先让 `deck mirror + 源顺序命名 + 导出硬校验` 稳定落地，再做更聪明的抽象。

## 风险和处理方式

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 误以为 `pptx_template_import.py` 能产出 SVG | 第 2 期实现会卡住 | 明确串联 `pptx_template_import.py` 和 `pptx_to_svg.py` |
| `decks/` 目录不存在 | 模板列表和注册失败 | 第 1 期先初始化目录和空索引 |
| 页面类型推断不稳定 | 导入模板命名错、AI 选错页 | MVP 只按源顺序命名，不做类型推断 |
| 源 PPT 有 SmartArt、复杂动画、OLE 对象 | SVG 还原可能不完整 | 导入时提示质量问题；先保证静态视觉 |
| mirror 替换文字后变长 | 文字可能溢出或压住其他元素 | 明确第一版是“视觉继承 + 文字替换”，不是智能重排；后续再做文本适配 |
| 源 PPT 页面不适合复用 | 后续生成可能像“改字版” | MVP 接受这个结果，因为用户上传完整模板本来就想继承结构 |
| AI 忘记读取模板页 | 又变成自由设计 | 用前端 prompt、SKILL.md、导出前检查三重约束 |
| 中文模板名路径问题 | 预览或接口可能出错 | 使用安全 slug 做目录名，中文只做展示名 |
| brand 和 deck 混淆 | 用户继续误解 | 前端文案、类型、prompt 全部拆清楚 |
| `--template` 被误认为套版式 | 生成效果不稳定 | 只在导出层解释它是 PPTX 壳子，不当作页面模板能力 |

## 测试策略

按当前项目习惯，测试不用铺太大，只测核心复杂逻辑。

### 单元测试

只建议给新增的模板物化脚本写极简测试：

1. 输入一个带 `manifest.json` 和 3 个 `svg-flat/slide_*.svg` 的临时目录。
2. 执行物化逻辑。
3. 断言输出目录有：
   - `design_spec.md`
   - `01.svg`、`02.svg`、`03.svg`
   - Page Roster
   - `kind: deck`

再给导出前校验写 2 个极简测试：

1. `kind: deck` 且没有 `page_layouts`，期望校验失败。
2. `kind: deck` 且 `page_layouts` 引用了存在的 `01.svg`，期望校验通过。

简单接口透传、普通状态更新不用写单测。

### 手工验收

用同一个上传模板跑完整链路：

1. 上传 `展会PPT模版.pptx`，选择“导入完整模板”。
2. 模板列表出现该模板，分类是“完整模板”。
3. 打开预览，至少能看到封面和内容页。
4. 用它生成一份 6 到 8 页 PPT。
5. 检查项目文件：
   - `templates/design_spec.md` 是 `kind: deck`
   - `spec_lock.md.page_layouts` 不为空
   - 每页有对应模板 SVG 名称，例如 `01`、`02`
6. 检查结果：
   - 封面继承源模板封面结构
   - 内容页继承标题区、正文区、页脚、色彩节奏
   - 结束页继承源模板结束页风格
7. 手动清空 `spec_lock.md.page_layouts` 再导出，确认导出失败并提示原因。

## 排期建议

| 阶段 | 时间 | 结果 |
| --- | --- | --- |
| 第 0 期 | 0.5 天 | 先修文案，避免误导 |
| 第 1 期 | 1 到 1.5 天 | 初始化 `deck` 目录、索引、列表和预览 |
| 第 2 期 | 2.5 到 3.5 天 | 上传 PPTX 能通过双脚本链路生成完整模板 |
| 第 3 期 | 1 到 2 天 | 生成过程真正使用完整模板 |
| 第 4 期 | 1 天 | 质量检查和兜底 |

总计大约 5.5 到 8.5 个工作日。

如果只做最小可上线版本，压缩后大约 4 到 5 个工作日：

1. 文案修正。
2. `deck` 目录和类型接入。
3. PPTX 通过 `pptx_template_import.py + pptx_to_svg.py` 导入成 `deck mirror`。
4. 模板页按源顺序命名。
5. 生成 prompt 强制写 `page_layouts`。
6. 导出前检查 `page_layouts`。
7. 用一个真实模板做端到端验收。

## 最终结论

这个问题的正确修法不是继续优化 brand prompt，而是把“品牌”和“完整模板”拆开。

短期先把误导文案修掉；中期把上传 PPTX 通过双脚本链路导入成 `deck mirror`；长期再做更高级的模板抽象和自动页面类型识别。

最值得优先做的是 `deck mirror`。它不追求一上来就把模板理解得特别智能，第一版效果也要明确成“视觉继承 + 文字替换”，不是“智能重排”。但它能稳定解决用户最直接的诉求：我上传了一套 PPT 模板，生成时就应该按这套模板的页面结构来做。
