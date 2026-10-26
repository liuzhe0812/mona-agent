# Mona 思维导图协议

本参考只适用于 `canvas(action="open")` 返回 `kind="mindmap"` 的画布。不要把流程图的 `replaceGraph`、节点/边字段或 flowchart patch 用到思维导图。

## 读取与修改

`open` 返回 MindMapNode 文档及 `semanticHash`、`documentHash` 和选区。节点以 `id`、`topic`、`children` 表示层级，并可能包含 `note`、`icons`、`hyperLink`、`image`、`style`、`metadata` 等扩展字段。局部编辑必须保留不相关节点和扩展字段。

修改调用 `canvas(action="apply", patch=...)`，patch 是对象，包含 `baseHash`、`baseDocumentHash` 和 `ops`。两个哈希必须逐字复制自最近一次 `canvas(action="open")` 的 `semanticHash`、`documentHash`；修改发生冲突或内容已变化时先重新 `open`，再按新文档重算 patch。不要猜测、复用旧哈希或用占位值调用。

每个 patch 最多 50 个操作，序列化后不超过 64 KiB。操作按顺序原子执行；后续 path 以之前操作完成后的树为准。没有 `replaceGraph` 操作，局部编辑不得重建整棵树。

路径操作使用 `name` 字段：

- `addChild`: `{ name, path, topic, expectedTopic? }`，在 path 指定的父节点下新增子节点。
- `insertSibling`: `{ name, path, topic, expectedTopic? }`，在 path 指定节点前新增同级节点；根节点不能插入同级。
- `updateTopic`: `{ name, path, topic, expectedTopic? }`，修改节点标题。
- `removeNode`: `{ name, path, expectedTopic? }`，删除节点；不能删除根节点。
- `moveNode`: `{ name, from, to, expectedTopic? }`，把 from 指定的节点移到 to 指定的父节点下；不能移动根节点，也不能移到自身或后代下。

根节点路径为 `[]`；每层子节点索引从 `0` 开始。可选 `expectedTopic` 用于校验操作定位到的节点或父节点标题。新建导图优先用 path 操作，便于在同一批次中创建多层分支。

也可以统一使用稳定 ID：`addChild(parentId, topic)`、`insertSibling(nodeId, topic)`、`updateTopic(nodeId, topic)`、`removeNode(nodeId)`、`moveNode(fromId, toParentId)`。ID 形式的 `insertSibling` 在目标节点后新增同级；同一批次不得混用 path 与 ID 定位方式。新建多层分支推荐 path 操作，因为新节点 ID 由编辑器生成。

## 首次创建示例

先调用 `canvas(action="open")`，从这次返回值中复制 `semanticHash` 和 `documentHash` 到 `baseHash`、`baseDocumentHash`。下面只展示 `ops`；实际调用仍须带上这两个最新哈希：

```json
{
  "ops": [
    { "name": "updateTopic", "path": [], "topic": "产品发布计划" },
    { "name": "addChild", "path": [], "topic": "准备阶段", "expectedTopic": "产品发布计划" },
    { "name": "addChild", "path": [0], "topic": "确认发布范围", "expectedTopic": "准备阶段" }
  ]
}
```

`updateTopic` 命名根节点，第二步创建第一条主分支，第三步基于更新后的树在该分支下创建叶节点。不能直接提交上面的片段；将它放入 patch 对象并填入刚从 `open` 复制的哈希。

## 验收与导出

写入后调用 `canvas(action="inspect", include_visual=true)`。只有工具返回实际图像并且检查完成，才能说明画面已验收；没有图像或检查失败时报告未完成，不用 SVG 或文本结构冒充视觉检查。

用户需要图片文件时再调用 `canvas(action="export", format="png")` 或 `canvas(action="export", format="svg")`。导出失败时说明失败，不用另行生成的 SVG 替代现有可编辑画布。
