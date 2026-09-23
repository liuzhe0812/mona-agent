# 完整原生设计示例

这些示例是独立设计的可编辑页面，不是内容必须匹配的预设。可以改变字号、比例、模块数量、配色和图文位置，也可以只借用一个区域。页内结论和数据仅作演示，不能带入用户的真实报告。

## 选择参考

| 页面 | 适合表达 | 借鉴重点 | 完整操作资源 | 真实画面 |
|---|---|---|---|---|
| 编辑式证据页 | 变化、经营指标、评估结果 | 原生图表占主区；大数字形成焦点；原因独立排版 | `native/editorial-evidence.json` | `native/editorial-evidence.png` |
| 五项并列页 | 能力拆解、课程模块、多项分析 | 短标签与解释逐项对齐；细分隔而非卡片墙；五项全部保留 | `native/parallel-five.json` | `native/parallel-five.png` |
| 产品大图页 | 产品介绍、工作场景、案例引入 | 不对称图文比例；真实截图为视觉重心；标题与说明为原生文本 | `native/product-story.json` | `native/product-story.png` |

## 读取与使用

通过 `skill_asset_copy` 复制所需资源，再用 `read_file` 查看。例：

```json
{"skill":"mona-pptx","asset":"native/editorial-evidence.json","dest":"design-reference/editorial-evidence.json"}
```

相应 PNG 同样复制并读取，单独看到 Markdown 路径不等于看过设计。无需一次读取全部示例。

JSON 的 `operations` 是 `office.apply` 可执行的原生操作。使用前把所有 `$slideId` 替换为当前编辑器返回的真实页面 ID，将示例文字和数据换为本页内容，并根据当前页面尺寸调整坐标；然后带最新 `expected_version` 写入。不要把这些示例当成另一套整稿生成器。

产品页使用 `native/product-workspace.png`，是本仓库既有的产品历史界面截图。使用该示例时先复制图片到实际工作区，再将 `assetPath` 改成复制回执里的路径。不得把它冒充当前版本界面或用户产品的截图。其他页面不需要这张图片。

## 原生图表与自由构图

`slide_compose` 是权重网格，不规定整页风格。可以仅排一个证据区域，再用原生操作安排标题、说明、强调数字和图片。每个区域可以有自己的行列比例；元素有独立 ID，后续可局部修改。

chart 项的分类、系列、坐标单位与 `slide_add_chart` 相同。可选 `style` 与创建在同一事务内完成，例如：

```json
{
  "op":"slide_compose",
  "payload":{
    "slideId":"<真实页面ID>",
    "x":72,"y":250,"width":720,"height":340,
    "columns":[1],"rows":[1],"gap":0,
    "items":[{
      "type":"chart","column":0,"row":0,
      "kind":"bar","categories":["基期","当前"],
      "series":[{"name":"交付周期","values":[50,30]}],
      "valAxisTitle":"分钟","legendPos":"none",
      "style":{"seriesColors":["#25856B"],"axisLabelColor":"#5B6D68","axisLabelFontSize":14}
    }]
  }
}
```

无须为了获得图表主题而套整页预设。创建与调色失败会一起回滚，已有成功页面保持不变。原生操作使用最新版本和真实 ID，不能把上例占位 ID 直接提交。

## 适配不是机械缩放

五项改成六项时，先考虑行间距、说明长度和可用正文区，而不是把所有文字等比例缩小。图表页增加第二个证据时，可以改为上下两图或两图一组解释；比较不同量纲时保留独立坐标。产品页换成竖图时，应重新分配图文比例，不把图片拉伸填满原槽位。

实图审核检查实际内容，不只看参考页：标题是否仍有主次、图表是否可读、解释有没有挤压、截图是否保留关键信息。必要时局部修改，避免重建整个文档。完整操作契约与修正方法见 [Office 操作](office-operations.md)。
