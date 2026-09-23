# 原生设计组件

随本次读取附带真实 Office 组件渲染。它们是完成度的参照，不是最终目标、待临摹的画面或必须采用的版式。可以从用户内容出发形成不同于参考的构图、视觉重点和阅读路径。默认只是一个中性设计方向；用户品牌优先，palette 可自由设置。卡片、对称与重复版式不是禁用项，它们应服务内容。

## 同一个 Office 入口

`action: "apply"`，`expected_version` 使用最新回执；`operations` 中加入 `slide_add_design`。payload 为：

- `slideId`：当前真实 ID。
- `design`：下表的组件名称。
- `content`：标题与该构图真正需要的数据。`title` 必填；`summary`、`eyebrow`、`source`、`pageLabel` 可选，不为形式感强加副标题、眉标或页码。
- `palette` 可选：`background/ink/muted/accent/surface/line/positive/negative`，颜色为 `#RRGGBB`。它只用于创建；已有文稿改品牌色使用 [原位续编](in-place-editing.md) 的 palette 查询与 slide_replace_colors，不重建页面，也不是整稿动态主题系统。
- `focusIndex` 可选：要强调的条目，从0开始。
- `region` 可选：`{x,y,width,height}` 当前预览像素；`metric/items/waterfall/sankey/evidence` 可以作为局部组件组合，使用正常字号，不缩成整页微缩图。局部 `title` 可留空。其它构图是完整页面，可先生成后修改原生对象，或直接原生重组。省略 region 时创建完整设计页，要求目标为空白。已有页按真实对象 ID 局部修改。

`items` 的每项用 `{label, detail?, value?, unit?}`。label是短标题，detail是解释；value与unit分开，由组件完成大小和基线关系。不把段落塞进value，不让程序替你改事实。

| design | 内容字段 | 适用与变化 |
|---|---|---|
| statement | emphasis?、items?（0–4项） | 大观点或开场。emphasis必须是title中的原文。|
| metric | metric、items?（0–6项） | metric的value必填；detail成为独立解读；辅助项缺少数值时可用其他构图。|
| evidence | chart、items（1–4项）、metric? | chart含kind、categories、series；unit/title/style可选。原生数据图表与旁侧解读。|
| waterfall | steps（1–12项）、start?、unit?、totalLabel? | steps为{label,value}增减量；start为{label,value}。累计起止和合计自动计算，支持正负与零。|
| sankey | sources、targets、links、unit? | 两侧节点{id,label}；links为{source,target,value}。value是非负流量，不是比例字符串。|
| agenda | items（1–12项）、columns? | 编号信息地图，1–4列可选；重点项突出但其余项保持可读。|
| comparison | groups（恰好两组） | 每组{label,detail?,items}，每组1–5项；同维度对照。|
| roadmap | items（2–6项） | 有真实先后/时间关系；并列内容不硬画成路线。|
| matrix | items（4项）、axes:{x,y} | 四象限必须提供实际比较维度；items按左上、右上、左下、右下排列。|
| image | image、items（1–4项） | image优先{assetPath:真实工作区路径}；编辑器读取实际比例，避免拉伸。|
| items | items（1–8项） | 编号、标签与说明按行对齐，保留所有内容。|

## 两个字段示例（数字仅用于说明）

指标页：
```json
{"op":"slide_add_design","payload":{"slideId":"<当前真实ID>","design":"metric","content":{"title":"持续投入，建设可复用能力","metric":{"label":"研发投入","value":2052.51,"unit":"万元","detail":"将一次性交付经验沉淀为可复用产品能力。"},"items":[{"label":"研发人员","value":119,"unit":"人"},{"label":"团队占比","value":63.98,"unit":"%"}],"source":"示例数据，真实任务必须替换"}}}
```
图表页：
```json
{"op":"slide_add_design","payload":{"slideId":"<当前真实ID>","design":"evidence","content":{"title":"交付周期缩短，流程改造开始见效","chart":{"kind":"bar","categories":["改造前","改造后"],"series":[{"name":"交付周期","values":[50,30]}],"unit":"分钟"},"items":[{"label":"减少重复确认","detail":"资料统一归档，让跨岗位协作更连贯。"},{"label":"下一步验证","detail":"检查不同团队和项目下是否仍然有效。"}],"source":"演示，非实际业务数据"}}}
```

不要逐页生成一堆同等权重的彩色框。优先把真正重要的数值、证据或结论作为视觉主体；素材没有证据意义时不为凑图而添加。选择组件不需要提交审批报告。

## 自由构图与排版

例如，一页解释效率变化，可以左侧放一个局部主指标、右侧放变化瀑布，底部用原生编号和文字提出后续行动；也可以只用一张大图表搭配贴近证据的注释。先想清楚这一页为什么存在，再决定怎么画，不要求与参考的颜色、位置或元素数量一致。

这些组件不是唯一合法答案。特殊内容可用`slide_compose`或原生文字/形状/图表；使用同一套palette和字体层级即可。版式数量不匹配时调整区域、排列或改用其他表达，不删事实、不做隐藏截断，也不把所有文字无限缩小。

原生`slide_add_text`/`slide_set_text`支持`paragraphs`，与`text`二选一：
```json
{"paragraphs":[{"runs":[{"text":"970","fontSize":100,"bold":true,"color":"#516B30"},{"text":" 万元","fontSize":22,"color":"#172621"}],"lineHeight":110,"spaceAfter":0}],"body":{"insets":{"l":0,"t":0,"r":0,"b":0},"anchor":"top","wrap":true}}
```
上例`body`只用于创建，不用于`slide_set_text`；字号/字距/段距为pt，位置与内边距为预览像素。run可含`letterSpacing`、`baseline`。组件用编辑器相同的文字布局测量后适配，不能把字符数量当成真实宽度。

桑基、瀑布等是数据驱动的原生形状与文本，不是截图，也不冒充标准图表；节点和曲线可单独修改。原生`slide_add_path`支持归一化M/L/C/Z指令，精确字段按需查capabilities，不传任意SVG/XML/脚本。

## 看成品再交付

总览`query:{mode:"visual",slideIds:[...],columns:2}`适合比较整稿，单页`slideId`用于看细节；均来自真实SlideCanvas并绑定版本。先解决真实硬错误，再判断视觉主次，不把“返回了图片”视为设计合格。用户手动修改后以当前文档为准，不能按旧计划自动重排整个文稿。
