# Mona Office Slides 操作示例

以下 JSON 只说明当前 `office` 工具的操作字段，不提供页面设计方案。文字、字号、颜色和坐标是参数示例，实际值来自当前文稿或共享 `mona-design` 的选定设计。示例中的 `session_id`、版本、页面 ID 和元素 ID 必须替换为最近一次返回的真实值；不要把示例 ID 当成稳定 ID。

## 首次写入

`open` 回执中的 `selection.slideId` 和 `version` 可直接用于第一批写入。将最近一次结果的完整 `version` 对象传给 `expected_version`；每项操作按 `{op, payload}` 组织，所有操作参数都在 `payload` 中：

```text
action = "apply"
session_id = open.session_id
expected_version = open.version
operations = [{op: "当前操作名", payload: {slideId: open.selection.slideId, ...}}]
```

不要为已返回的 selection、ID 或版本重复 inspect。只在当前操作参数仍未知时，才对该操作名查询 `capabilities`；不必预读完整能力目录或所有操作参考。

## 1. 打开会话

修改当前打开的 PPT 直接 inspect/apply；恢复用 `open` 加当前 `session_id`，无需关闭。无活动文稿时以下调用新建；有活动文稿时默认复用原会话。只有用户明确要求另一份新文稿才增加 `new_document:true`：

```json
{
  "action": "open",
  "document_type": "slides",
  "display_name": "季度业务简报"
}
```

已有文件用工作区内路径打开：

```json
{
  "action": "open",
  "path": "reports/quarterly-brief.pptx"
}
```

打开结果提供 `session_id`、当前 `selection`、页面尺寸和 `version`。直接使用这些实时值；等待编辑器连接完成后再发下一步。

## 2. 选择性读取稳定标识

`open` 已返回尺寸时，不要为了重复取得尺寸再读 `summary`。按任务选择一个入口：已知页面用 `slides`，已有选区直接用 `selection`，需要全稿规模或 EMU 尺寸时才用 `summary`。

需要全稿规模时才读摘要：

```json
{
  "action": "inspect",
  "session_id": "<session-id>",
  "query": { "mode": "summary" }
}
```

需要规划指定页面或元素时才读页面及元素：

```json
{
  "action": "inspect",
  "session_id": "<session-id>",
  "query": {
    "mode": "slides",
    "elementIds": ["<optional-stable-element-id>"],
    "limit": 20
  }
}
```

`slides` 结果包含页面的 `id`、`index`、预览 `width`/`height`，以及元素的稳定 `id`、`type`、`text`、`x`、`y`、`width`、`height`。提供 `elementIds` 时只返回相关元素。先用这些值规划页面；几何字段是预览像素，当前入口会按真实页面尺寸换算为 EMU。`summary` 还会返回 `slideWidthEmu` 和 `slideHeightEmu`，不要把它们直接当作预览像素。

元素还可能带有轻量 `style` 摘要，例如 `fontFamily`、`fontSizePt`、`fill`、`stroke` 和 `align`；混合字体/字号会省略对应单值，混合对齐会返回 `"mixed"`。不要把这个摘要当成可回写的 AST。

读取当前编辑器选区：

```json
{
  "action": "inspect",
  "session_id": "<session-id>",
  "query": { "mode": "selection" }
}
```

结果形状为：

```json
{
  "mode": "selection",
  "documentType": "slides",
  "slideId": "<stable-slide-id>",
  "elementIds": ["<stable-element-id>"],
  "elements": [
    {
      "id": "<stable-element-id>",
      "type": "shape",
      "text": "",
      "x": 96,
      "y": 190,
      "width": 320,
      "height": 120
    }
  ],
  "slideWidth": 1280,
  "slideHeight": 720
}
```

响应外层仍带最新 `version`；局部修改优先使用 `open` 回执或一次 `selection` 取得版本、元素详情和稳定 ID。任何读取若明确返回 `partial`，只按缺失页面/元素补读，避免与已有范围重叠；完整回执不再换工具重复扫描。

只有要做新操作或已知字段不足时，才根据选中元素类型读取准确的操作字段；查询中指定具体操作名（例如 `operations: ["slide_set_font"]`），只读相关结果，不无条件加载全部能力或参考：

```json
{
  "action": "inspect",
  "session_id": "<session-id>",
  "query": { "mode": "capabilities", "operations": ["slide_add", "slide_add_text", "slide_add_shape"] }
}
```

未指定 operations 时返回简短目录；指定实际名称时返回参数（最多3项，剩余 nextOperations 继续）。未知名称单独列在 unsupportedOperations，不影响已知项；availableOperations 可用于恢复。只读查询成功不代表未知操作存在，写入仍严格校验。改色见 [原位续编](in-place-editing.md)，不因查询出错关闭或新建文稿。

同一操作的准确参数读取一次后复用，直接组织 `apply.operations` 批量提交；不为常规字段反复用终端、脚本或文件补丁加工完整 schema。只在参数未知或结果明确不完整时补读所需操作。

`apply`、`inspect review` 和 `inspect visual` 可能返回布局警告。`[错误]` 会给出元素 ID 以及实际/可用文字尺寸或相互重叠范围，必须通过 `slide_set_geometry`、`slide_set_text` 或 `slide_set_font` 修复；`[需检查]` 会列出文字与图片的交叠元素，供真实画面审核。单独修改文字或字号可能改变换行，因此也会让页面重新进入视觉复核状态。`acceptWarnings: true` 只用于确有理由保留的非阻塞 `[需检查]`：必须先用同一版本、不带 `elementIds`/`region` 的 `visual` 查询获取整页画面，再以同一页面和版本传入非空 `reviewReason` 与 `acceptWarnings: true`；局部或过期截图不能代替前置观察，存在 `[错误]` 时不能接受。

## 3. 读取真实视觉画面

结构写入完成后，用真实编辑器的 `SlideCanvas` 捕获目标页。新布局、代表性内容页、复杂图表或效果可疑时，先用当前版本获取整页画面；`slideId` 可省略，省略时使用当前 selection 页面：

```json
{
  "action": "inspect",
  "session_id": "<session-id>",
  "query": {
    "mode": "visual",
    "slideId": "<stable-slide-id>",
    "elementIds": ["<stable-element-id>"],
    "padding": 16
  }
}
```

也可以用 `region: {"x": 80, "y": 160, "width": 480, "height": 260}` 捕获页面局部；`elementIds` 和 `region` 选择一种目标即可，`padding` 适用于局部捕获。局部图像只用于定位细节，不能代替整页验收或 `acceptWarnings` 的前置观察。任何变更后都要使用最新版本重新 review 和视觉检查。

返回内容是原生页面 PNG：

```json
{
  "mode": "visual",
  "dataUrl": "data:image/png;base64,<base64-png>",
  "width": 1280,
  "height": 720,
  "target": "<stable-slide-id>",
  "warnings": []
}
```

它复用编辑器的真实渲染结果，不把整页转成可交付图片，也不把图片当成可编辑图表。捕获前后会检查同一个文档版本；若返回 `VERSION_CONFLICT`，先重新 `inspect` 目标页和 selection，再决定是否继续视觉检查或重新提交局部操作。布局写入后先按 [visual-review.md](visual-review.md) 的 review 门控确定待观察页面；任何修改后必须重新获取当前版本的整页画面。

只有在上一条同版本、非局部 `visual` 查询已经成功获取整页画面，并确认 `[需检查]` 的叠放确有理由且文字可读时，才可以再次查询并明确接受：

```json
{
  "action": "inspect",
  "session_id": "<session-id>",
  "query": {
    "mode": "visual",
    "slideId": "<stable-slide-id>",
    "acceptWarnings": true,
    "reviewReason": "已检查当前版本整页画面，文字位于图片留白区且保持清晰。"
  }
}
```

局部或过期画面、空的 `reviewReason`、或任何 `[错误]` 都不能使用 `acceptWarnings`；任何后续变更都必须重新观察。

## 4. 按完整区域小批次写入

下面演示同批添加形状和文字，不能当作版式套用。一次 `apply` 最多 50 个操作；按页或完整区域批量写入，不逐对象调用。图片按使用顺序准备；图片尚未就绪时先提交已准备的文字/结构批次，不等待整套图片，也不要假设存在后台生图 API。

新稿先使用 `open` 回执中的现有空白页，按内容逐页追加并完成，不默认先建立整稿的空白页面。需要下一页时用 `slide_add`，沿用回执 `createdSlides` 的真实 ID 和最新 `version`；页数由用户要求和内容决定，不固定页数或创作批次数。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<editor-epoch>",
    "modelRevision": 0
  },
  "operations": [
    {
      "op": "slide_add_shape",
      "payload": {
        "slideId": "<slide-id>",
        "shape": "rect",
        "x": 60,
        "y": 52,
        "width": 1160,
        "height": 610,
        "fillColor": "#FFFFFF"
      }
    },
    {
      "op": "slide_add_text",
      "payload": {
        "slideId": "<slide-id>",
        "x": 96,
        "y": 78,
        "width": 1080,
        "height": 72,
        "text": "文字字段示例",
        "align": "left",
        "font": {
          "fontSize": 28,
          "bold": true,
          "color": "#000000"
        },
        "strokeColor": null,
        "strokeWidthPt": 1
      }
    },
    {
      "op": "slide_add_text",
      "payload": {
        "slideId": "<slide-id>",
        "x": 96,
        "y": 190,
        "width": 620,
        "height": 150,
        "text": "第二个独立文字对象。"
      }
    }
  ]
}
```

新增元素的稳定 ID 优先使用 `apply.createdElements` 回执；缺少时才针对相关页面 `inspect`，再做局部调整，不猜测 ID 或重复读取已返回的内容。

### 4.1 常见数据图表：优先原生入口

有分类、系列和数值的常见 `bar`、`line`、`area`、`pie` 或 `doughnut` 图表，优先使用 `slide_add_chart`；位置和尺寸使用预览像素，不需要换算 EMU。下面的数据仅用于说明字段，不代表真实业务事实：

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": { "editorEpoch": "<latest-editor-epoch>", "modelRevision": 1 },
  "operations": [
    {
      "op": "slide_add_chart",
      "payload": {
        "slideId": "<slide-id>",
        "x": 96,
        "y": 350,
        "width": 720,
        "height": 260,
        "kind": "bar",
        "title": "说明示例：各阶段完成率",
        "categories": ["阶段一", "阶段二", "阶段三"],
        "series": [{ "name": "完成率（示例）", "values": [35, 58, 76] }],
        "legendPos": "none",
        "gridlines": true,
        "dataLabels": true,
        "valAxisTitle": "百分比（示例）",
        "style": { "seriesColors": ["#808080"], "textColor": "#000000", "axisLabelColor": "#000000", "gridColor": "#CCCCCC", "axisLabelFontSize": 14 }
      }
    }
  ]
}
```

复杂图表或需要深度修改已有图表数据时，再阅读 [advanced-operations.md](advanced-operations.md) 使用已验证的高级操作。原生图表保留分类、系列和数值，字符块或图片不具备这些对象语义。

## 5. 修改已有元素

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<latest-editor-epoch>",
    "modelRevision": 1
  },
  "operations": [
    {
      "op": "slide_set_font",
      "payload": {
        "slideId": "<slide-id>",
        "elementId": "<text-element-id>",
        "font": {
          "fontSize": 28,
          "bold": true,
          "color": "#000000"
        }
      }
    },
    {
      "op": "slide_set_geometry",
      "payload": {
        "slideId": "<slide-id>",
        "elementId": "<text-element-id>",
        "x": 96,
        "y": 82,
        "width": 1080,
        "height": 80
      }
    },
    {
      "op": "slide_set_fill",
      "payload": {
        "slideId": "<slide-id>",
        "elementId": "<shape-element-id>",
        "color": "#FFFFFF"
      }
    },
    {
      "op": "slide_set_stroke",
      "payload": {
        "slideId": "<slide-id>",
        "elementId": "<shape-element-id>",
        "color": "#000000",
        "widthPt": 1
      }
    }
  ]
}
```

`font.fontSize` 是磅值；`x`、`y`、`width`、`height` 是预览像素。`slide_set_fill` 的 `color: null` 表示无填充，`slide_set_stroke` 的 `color: null` 表示无描边。

## 6. 添加图片和页面

图片操作写入 `picture` 元素。当前入口接受 `png`、`jpeg`、`gif`、`bmp`、`webp` 和通过静态校验的 SVG data URL；工作区内的大照片优先使用 `assetPath`，由 Gateway 转成 `dataUrl`：

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": { "editorEpoch": "<latest-editor-epoch>", "modelRevision": 2 },
  "operations": [
    {
      "op": "slide_add_image",
      "payload": {
        "slideId": "<slide-id>",
        "x": 760,
        "y": 190,
        "width": 420,
        "height": 300,
        "assetPath": "assets/onboarding-photo.jpg"
      }
    },
    {
      "op": "slide_add",
      "payload": { "slideId": "<slide-id>" }
    }
  ]
}
```

`slide_add` 可只传锚页 `slideId`，在其后插入空白页；也可在同一操作中传 `content`，一次新增页面并写入内容。`content` 复用 `slide_compose` 的 `columns`、`rows`、`gap`、`x`、`y`、`width`、`height` 和 `items` 字段，不包含 `slideId` 或 `elementId`。锚页必须是已有页面；新增页与其内容在同一原子事务中提交。展开后的新页、内容对象和图表样式写入仍受单次 `apply` 的 50 项原始操作上限约束。旧的空白页用法仍可用。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": { "editorEpoch": "<latest-editor-epoch>", "modelRevision": 3 },
  "operations": [
    {
      "op": "slide_add",
      "payload": {
        "slideId": "<existing-anchor-slide-id>",
        "content": {
          "columns": [1, 1],
          "rows": [1, 1],
          "items": [
            { "type": "text", "column": 0, "row": 0, "columnSpan": 2, "text": "页面标题" },
            { "type": "text", "column": 0, "row": 1, "text": "要点说明" },
            {
              "type": "chart",
              "column": 1,
              "row": 1,
              "kind": "bar",
              "categories": ["一", "二"],
              "series": [{ "name": "示例", "values": [3, 5] }]
            }
          ]
        }
      }
    }
  ]
}
```

新增页已包含本批内容时，后续步骤直接使用该次 `apply` 回执中的版本和新页 ID，无需再往返一次只为取得新页 ID。`slide_duplicate`、`slide_delete` 和 `slide_move` 同样以 `slideId` 为目标。删除前先核对确切 ID，并保留用户已经提交的修改。

## 7. 网格混排、SVG 和照片

新建或重排一页需要把文本、基础形状、照片、SVG 和原生图表一起落位时，可以用 `slide_compose` 一次创建。图表 item 使用 `type: "chart"`，支持与 `slide_add_chart` 相同的数据和 `style` 字段；几何由网格区域提供。图表创建与主题样式在同一个 Office 命令中成功或回滚。`column`/`row` 从 0 开始，`columns`/`rows` 必须是正权重；默认 `gap` 为 24px、内容区域距页面边缘 48px。`x`、`y`、`width`、`height` 可覆盖默认整页内容区域。`items` 按顺序叠放，同一网格区域允许重叠；每个文本 item 仍是独立可编辑文本框。操作只创建元素，不替换页面或已有元素。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": { "editorEpoch": "<latest-editor-epoch>", "modelRevision": 3 },
  "operations": [
    {
      "op": "slide_compose",
      "payload": {
        "slideId": "<slide-id>",
        "columns": [1.4, 1, 1],
        "rows": [1.15, 1],
        "gap": 24,
        "items": [
          {
            "type": "text",
            "column": 0,
            "row": 0,
            "columnSpan": 2,
            "text": "文字字段示例",
            "font": { "fontSize": 28, "bold": true, "color": "#000000" },
            "align": "left"
          },
          {
            "type": "svg",
            "column": 2,
            "row": 0,
            "rowSpan": 2,
            "svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 160 220\"><path fill=\"#000000\" d=\"M8 8h144v204H8z\"/></svg>",
            "inset": 8
          },
          {
            "type": "shape",
            "column": 0,
            "row": 1,
            "shape": "roundRect",
            "fillColor": "#FFFFFF",
            "strokeColor": "#000000",
            "strokeWidthPt": 1,
            "inset": 8
          },
          {
            "type": "text",
            "column": 0,
            "row": 1,
            "text": "第二个文字字段",
            "font": { "fontSize": 22, "bold": true, "color": "#000000" },
            "inset": 24
          },
          {
            "type": "image",
            "column": 1,
            "row": 1,
            "assetPath": "assets/onboarding-photo.jpg",
            "inset": 8
          }
        ]
      }
    }
  ]
}
```

这里演示 columnSpan/rowSpan、同一区域叠放与独立对象的字段关系，不是推荐页面骨架。`assetPath` 由 Gateway 在工作区范围内解析并转成图片 `dataUrl`；不要让模型为大照片直接输出 base64。SVG 需要是通过静态校验的封闭资源，不能把其中的路径描述为可逐项编辑。

单独添加 SVG 时使用 `slide_add_svg`，payload 需要 `slideId`、`svg`、`x`、`y`、`width`、`height`；它同样创建整体图片。单独添加照片可以使用 `slide_add_image` 的 `assetPath`，或在已准备好的图片 data URL 场景使用 `dataUrl`。图片和 SVG 都不能代替原生文本、形状或原生数据图表。

## 7.0 富文本、路径与总览

`slide_add_text` 支持 `paragraphs`/`runs`、混合字号、局部颜色、基线与字距；创建时可明确 `body.insets`。`slide_add_path` 创建原生可编辑曲线形状，只接受结构化 M/L/C/Z，不接受任意 XML。数据驱动的信息图形与标准原生数据图表的编辑能力不同，交付时按实际对象说明。

`paragraphs` 与 `text` 二选一，例如 `paragraphs:[{runs:[{text:"字段",bold:true},{text:"示例",baseline:0}],spaceAfter:0}]`。字号、字距和段距是 pt，位置与内边距为预览像素；`body` 是创建参数，不传给 `slide_set_text`。

整稿总览使用 `query:{"mode":"visual","slideIds":["<ID1>","<ID2>"],"columns":2}`，由真实编辑器捕获，不是第二套画法。它不解除单页待检查状态；细节仍使用单页 `slideId` 检查。未完成时可以保存；模型不得自行使用 `allow_unreviewed` 跳过 PPT 验收，用户仍可直接从编辑器导出草稿。

## 8. 版本、冲突和交付

`apply` 成功会返回新的 `version`，以及可用时的 `createdElements`、`updatedElements` 和 `warnings`。下一批使用回执里的稳定 ID 和版本即可，不为重复取得同一信息而重新扫描；版本冲突、需要未返回的元素详情或回执缺少继续操作所需信息时，再 `inspect` 最新页面。版本冲突表示用户或其他操作已经改变文档：读取最新页面和元素后重算目标，不强行重试旧批次。会话断开或暂时失败时，用 `office` 的 `open` 携带原 `session_id` 恢复同一会话；不要新开会话或重建整份演示文稿。

保存示例：

```json
{
  "action": "save",
  "session_id": "<session-id>",
  "expected_version": { "editorEpoch": "<latest-editor-epoch>", "modelRevision": 3 }
}
```

导出示例：

```json
{
  "action": "export",
  "session_id": "<session-id>",
  "expected_version": { "editorEpoch": "<latest-editor-epoch>", "modelRevision": 3 },
  "output": "exports/quarterly-brief.pptx"
}
```

`output` 使用工作区相对路径。除非用户明确要求覆盖源文件，不要设置 `overwrite_source`。表格、原生图表、SmartArt 和段落格式的已验证 payload 见 [advanced-operations.md](advanced-operations.md)；没有当前注册表的确切 payload 时不要猜字段，也不要用图片伪装成这些对象。

交付前按“结构 → 视觉 → 微调”顺序完成：`inspect slides`/`selection` 确认结构，`inspect visual` 确认真实画面，局部 `apply` 后再次视觉检查，最后使用最新版本 `save` 或 `export`。
