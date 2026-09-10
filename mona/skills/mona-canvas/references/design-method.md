# 画布设计方法

本参考把 `next-ai-draw-io/lib/system-prompts.ts` 中真正影响成图质量的经验，转换为 Mona
画布的决策规则。它指导信息结构、布局、视觉层次和路由，不复制上游的 draw.io XML 接口。

## 先定义图要回答的问题

在写 patch 前明确图的主体问题：谁做什么、请求如何流转、服务如何依赖，或某个决策如何分支。
然后确定：

- 读者和阅读方向：默认选择从上到下（`TB`）或从左到右（`LR`）；
- 图的边界：流程的开始/结束，或架构的客户端、服务、数据和外部系统边界；
- 信息粒度：节点保持同一层级，复杂子系统用一个节点表示，不把实现细节和业务步骤混在同一层；
- 节点之间的关系：每条边说明一个实际的流转、调用、依赖或责任转移。

上游提示中有助于质量的做法是先明确布局和结构，让结果保持在单页视口、留出边距并避免
对象重叠。Mona 提供 `layout: "auto"` 和 `layout: "manual"` 两种模式：一般构图把方向、分支
顺序、泳道归属和边关系交给自动布局，同时提供合理的尺寸和视觉字段；精确复刻特殊构图时，
使用 manual 并为每个节点提供坐标。

## 选择有意义的节点层次

使用与语义匹配的流程形状，不用形状替代说明。AI allowlist 包含流程语义形状、基础形状和
文本/便签类视觉节点；容器通过 groups 或泳道操作表达：

| 含义 | Mona AI 可用 kind |
| --- | --- |
| 起止 | `start`、`end`、`terminator` |
| 普通处理 | `process`、`alternate-process`、`predefined-process`、`subprocess`、`manual-operation` |
| 判断 | `decision` |
| 输入、输出和数据 | `input-output`、`manual-input`、`display`、`document`、`multi-document`、`database`、`internal-storage`、`stored-data` |
| 其它流程符号 | `preparation`、`delay`、`card`、`merge`、`extract`、`sort`、`or`、`summation`、`connector`、`off-page-connector`、`annotation` |
| 基础视觉形状 | `rectangle`、`rounded-rectangle`、`ellipse`、`circle`、`triangle`、`right-triangle`、`diamond-basic`、`pentagon-basic`、`hexagon-basic`、`octagon`、`star`、`cloud`、`callout`、`plus`、`l-shape`、`arrow-left`、`arrow-right`、`arrow-up`、`arrow-down`、`arrow-bidirectional`、`bracket-round`、`bracket-square`、`brace` |
| 文本/技术说明 | `text`、`code-block`、`note` |

普通流程通常从 `start` 开始，以 `end` 收束；若用户描述的是局部流程，不要为了形式强行
添加无意义的起止节点。判断节点的出边应体现不同结果，边标签使用用户语言，例如“是/否”
或“成功/失败”。文本要短而具体，避免一个节点包含多步操作；边标签不要重复节点标签。

架构图先按层或责任域组织，再放服务节点。常见层次是调用方/入口、编排或网关、业务服务、
数据存储和外部系统。节点标签写清组件职责，边标签写清调用或数据方向；同一层的节点保持
同等抽象级别。系统边界使用有标题的 group，责任流程使用泳道。为服务、用户、数据、网络
等节点选择语义匹配的白名单图标，图标只辅助识别，不替代标签。

## 视觉蓝图

高质量构图应在同一张图中形成可解释的视觉系统：

- 主题从 `solid`、`soft`、`outline` 中选一个，并从内置 palette 中选一个主色系；通常把
  `deep-blue`、`blue-gray` 或 `monochrome` 用作中性架构图，把其它颜色留给状态或关键路径；
- `background` 只改变画布底色；普通节点依赖主题，关键节点再使用 `style.fill`、
  `style.borderColor` 或 `style.color` 做少量强调；
- 官方 Demo 的共同配色是低饱和浅填充加中等明度描边。默认避免大面积 `#2563EB`、`#10B981`、
  `#DC2626` 等高饱和实心色；整图保持低饱和，重点用描边、字号、线型和留白表达，其余节点使用 SKILL 中的淡色板；
- group 用浅色填充和低对比边框建立区域层次，成员节点保持足够内边距；不要让分组颜色压过
  节点标签和主路径；
- `size` 应能容纳实际 label、字号和 icon。通常让本地自动尺寸计算生效；只有需要卡片式
  统一宽度、manual 构图或明确的视觉节奏时才写相同尺寸；
- 节点样式可设置字体、字号、颜色、填充、描边、对齐、行高和圆角；边样式可设置颜色、宽度、
  虚实线、路由和箭头。样式要少而稳定，不要彩虹配色或为每个节点随机设置颜色；
- 通用图标白名单为 `user`、`users`、`browser`、`mobile`、`server`、`database`、`file`、
  `folder`、`cloud`、`network`、`message`、`mail`、`search`、`lock`、`check`、`warning`、
  `settings`、`code`、`cpu`、`ai`。

## 让布局器得到可读的拓扑

上游提示中的关键布局规则是：元素放在单一视口内，靠近合理边距，按行或列紧凑组织；复杂图
优先使用垂直堆叠或网格；相邻层之间保留足以让连线通过的通道。Mona 的 `replaceGraph` 和
新增节点会使用 Dagre，并根据现有锚点和包围盒做确定性避让，所以应遵循这些拓扑规则：

1. 同一主流程沿同一个方向排列；不要把一条主链故意折成来回穿越的形状。
2. 分支放在同一层的相邻位置，汇合点放在分支之后；多个分支按语义顺序稳定排列。
3. 远距离关系尽量通过重新安排节点缩短路径。若无法避免跨区连线，使用泳道或中间节点
   明确边界，而不是增加无意义的折返边。
4. 对有多个入边或出边的节点，先保证主路径清楚，再加入次要关系；不要让同一对节点出现
   没有语义区别的重复边。
5. 只有确实表示循环、重试或双向依赖时才创建回边；能用线性顺序表达的内容不要制造环。

上游 draw.io 经验要求每条边有自然的入口和出口，避免角点连接；需要绕过中间形状时沿图的
外侧走，并为拐点保留约 20–30px 的视觉间隙。Mona 自动路由会根据布局分配连接点，并为
需要避障或分流的边补充正交控制点；同侧多条关系使用不同的 `sourcePort` / `targetPort` 比例。
需要精确路线时，可以显式提供合法的 `sourceHandle`、`targetHandle`、端口比例、`style.route` 和 `controlPoints`。
本地保留这些显式连接设计；已有路线有问题时再做局部修改。显式控制点应形成清楚的
L/U 形折线，不要使用穿过节点的捷径。

## 自动与手动布局

`auto` 适合绝大多数流程图和架构图：Dagre 使用节点实际尺寸，完成整图或泳道内布局；随后
本地算法分配自然连接点、生成 `smoothstep` 路由并检查节点包围盒。模型应通过方向、拓扑、
分组、泳道和尺寸影响布局，不要添加虚假边来“撑”出位置。

`manual` 适合复刻用户给出的版式、固定系统分区或需要对齐的海报式图。所有节点必须提供
有限的 `position`，边可提供 handles/control points；应用后仍要接受质量检查。分组的位置和
尺寸由成员包围盒计算，不能通过额外的容器节点伪造。

## 局部修改

改名、改节点语义、调整样式、图标、尺寸或连接时，保留原 ID，并携带当前文本/关系作为
expected。只改用户点名的节点和边，保留其它拓扑与分区。删除子图前列出所有要删除的节点
及其全部关联边，然后在一次原子 patch 中完成；不要通过重建整图来掩盖不确定的目标。视觉
修改必须使用当前 `baseDocumentHash`，避免覆盖用户刚做的位置或样式编辑。

来源：本地参考仓库 `D:\liuzhe\Desktop\code\next-ai-draw-io\lib\system-prompts.ts` 的
布局约束（约第 77–96 行）、连线路由规则（约第 140–186 行）及样式说明（约第 193–199 行）；
Mona 的 `webui/src/components/notes/flowchart/flowchart-patch.ts`、
`flowchart-document.ts` 和 `flowchart-quality.ts`。
