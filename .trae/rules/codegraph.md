# CodeGraph 代码知识图谱

本项目已配置 CodeGraph MCP 服务器，提供语义化代码智能。优先使用 CodeGraph 工具探索代码，减少 grep/read 的重复调用。

## 使用规则

1. **代码探索优先用 `codegraph_explore`** — 理解架构、追踪调用链、查找实现时，先用 `codegraph_explore` 获取语义上下文，再按需 Read 查看细节
2. **符号查找用 `codegraph_search`** — 已知函数/类名时，用 `codegraph_search` 而非 grep
3. **影响分析用 `codegraph_impact`** — 修改代码前，用 `codegraph_impact` 评估影响范围
4. **调用关系用 `codegraph_callers`/`codegraph_callees`** — 追踪谁调用了某函数，或某函数调用了谁

## 不要做的事

- 不要用多轮 grep+read 去摸索代码结构，`codegraph_explore` 一次就能返回完整上下文
- 不要忽略 CodeGraph 工具而只用内置搜索，这会浪费大量 Token

## 工具速查

| 工具 | 用途 | 重量 |
|------|------|------|
| `codegraph_explore` | 语义代码探索，一次返回相关符号+源码+关系 | 重 |
| `codegraph_search` | 按名称搜索符号 | 轻 |
| `codegraph_callers` | 查询谁调用了指定函数 | 轻 |
| `codegraph_callees` | 查询指定函数调用了谁 | 轻 |
| `codegraph_impact` | 分析修改某符号的影响范围 | 轻 |
| `codegraph_node` | 获取符号详情（含源码） | 轻 |
| `codegraph_status` | 查看索引状态 | 轻 |
