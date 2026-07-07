# Mona 笔记知识库完整对齐 Obsidian 社区主流玩法 + Mona Agent 平台原生能力 — 设计方案

> 日期:2026-07-06
> 范围:Mona 桌面端笔记模块完整升级为 Obsidian 风格知识库 + Mona 原生 AI Agent 集成
> 前置决策:[2026-07-03 笔记模块"知识"功能删除与 Obsidian 范式对齐](./2026-07-03-notes-knowledge-removal-design.md) 已落地,二级知识概念已移除
> 不在范围:独立的 KB RAG 功能(`mona/kb/` 项目级 RAG 链路本身不动)
> 替代文档:本方案替代 [2026-07-06-notes-vector-index-design.md](./2026-07-06-notes-vector-index-design.md),向量索引降级为本方案 L1 层的一个子模块
> 核心差异化:相比 Obsidian 生态,Mona 原生实现 L2/L3 Agent 能力,无需用户安装第三方框架

---

## 一、设计哲学

### 1.1 Mona 视角:超越 Obsidian 的三层定位

Mona 不是 Obsidian 第三方插件,**本身就是 Agent 平台**。Obsidian 用户要装 Smart Connections + Copilot + MCP Server + Hermes/OpenClaw 才能实现「AI 知识库」,Mona 可以原生做到,且能做得更深入。

本方案对齐 Obsidian 社区三层演进路径,并充分利用 Mona 的 Agent 平台优势:

| 层 | Obsidian 社区做法 | Mona 原生方案 |
|----|-----------------|--------------|
| **L1 基础** | 本地 markdown + 文件夹 + frontmatter + 双链 + MOC | 笔记模块原生实现(§3-§11) |
| **L2 智能(插件级)** | Smart Connections + Copilot 插件 | Smart Connections 风格推荐 + Vault QA(§12.1-§12.3) |
| **L3 Agent(框架级)** | Hermes/OpenClaw 把 vault 当 Agent 记忆 | Agent 主动整理 + 记忆沉淀到 vault(§12.4-§12.6) |

**关键差异**:Obsidian 的 L3 需要用户装第三方框架,Mona 的 L3 由 Agent 平台原生实现。这是 Mona 相比 Obsidian 生态的核心优势。

### 1.2 核心能力栈分四层

| 层 | 能力 | 作用 |
|----|------|------|
| L1 基础 | 本地 markdown + 文件夹 + frontmatter | 数据自主权,纯文本可迁移 |
| L2 关联(灵魂) | 双向链接 `[[xxx]]` + 反向链接 + MOC | 笔记间的显式关联,网状组织 |
| L3 检索 | 快速切换 + 全文搜索 + Dataview + Graph View | 找得到、看得见网络 |
| L4 智能 | 向量语义推荐 + Vault QA + **Agent 主动整理 + 记忆沉淀** | 隐式关联、对话式问答、自组织知识库 |

**任何一层缺失都不算完整的 AI 知识库**。Mona 当前只到 L1,L2-L4 全部缺失。

### 1.3 核心原则

1. **笔记本身就是知识原子**:不引入任何二级知识实体(2026-07-03 已确认),所有"知识库"能力都建立在笔记之上
2. **关联优先于检索**:Obsidian 的灵魂是双链网络,不是向量检索。向量是补充,不是主菜
3. **MOC 替代文件夹**:文件夹做粗分类,MOC 做灵活的多维主题组织
4. **AI 不重写,只发现与整理**:LLM 不参与内容改写,只做语义推荐、关联发现、对话问答、主动整理建议、经验沉淀
5. **数据归属**:个人原创内容走笔记模块(Obsidian 模式),外部导入资料走 KB 模块(RAG/LLM Wiki 模式),两者不混用
6. **Agent 操作需用户审核**:所有 Agent 写入操作以 diff 形式呈现,不自动执行破坏性操作
7. **Vault 是 Agent 的长期记忆**:Agent 经验沉淀到 vault,可被双链、被检索、用户可见可编辑

### 1.4 与 LLM Wiki 的边界

| 维度 | LLM Wiki 模式 | 本方案(Obsidian 模式) |
|------|--------------|---------------------|
| 适用对象 | 外部导入的原始资料 | 用户手写的笔记 |
| LLM 介入 | ingest 阶段重写为结构化 wiki | 不介入,只做关联发现和问答 |
| 目录结构 | raw/wiki/output 三层 | vault 扁平 + MOC 索引笔记 |
| 知识积累 | 每次操作让 wiki 更丰富 | 双链网络随笔记自然生长 |
| 适用场景 | 资料消化 + 问答 | 个人记录 + 关联组织 |

**两者不冲突**:KB 模块(`mona/kb/`)走 LLM Wiki 模式处理导入资料,笔记模块走本方案处理手写内容。

---

## 二、目标能力全景

完整对齐 Obsidian 社区主流玩法 + Mona Agent 平台原生能力,共 18 项核心能力:

### 2.1 L1-L3 Obsidian 主流玩法(14 项)

| # | 能力 | Obsidian 对应 | Mona 现状 | 本方案 |
|---|------|--------------|----------|--------|
| 1 | Vault 结构 | PARA + Zettelkasten 混合 | 部分 | 升级 |
| 2 | 双向链接 `[[xxx]]` | 内置核心 | ✗ | **新增** |
| 3 | 嵌入引用 `![[xxx]]` | 内置核心 | ✗ | **新增** |
| 4 | 块引用 `[[xxx#^id]]` | 内置核心 | ✗ | **新增** |
| 5 | 反向链接面板 | 内置核心 | ✗ | **新增** |
| 6 | MOC 索引笔记 | 社区主流范式 | ✗ | **新增** |
| 7 | 嵌套标签 `#a/b` | 内置核心 | 扁平 | 升级 |
| 8 | Frontmatter Properties | 内置核心 | 已有 | 标准化 |
| 9 | Dataview 查询 | 必装插件 | ✗ | **新增** |
| 10 | Graph View 知识图谱 | 内置核心 | ✗ | **新增** |
| 11 | 快速切换 Ctrl+O | 内置核心 | ✗ | **新增** |
| 12 | Templater 模板系统 | 必装插件 | ✗ | **新增** |
| 13 | Smart Connections 语义推荐 | 必装 AI 插件 | ✗ | **新增** |
| 14 | Copilot Vault QA | 必装 AI 插件 | 部分 | 升级 |

### 2.2 L4 Mona Agent 平台原生能力(4 项,超越 Obsidian)

| # | 能力 | Obsidian 对应 | Mona 现状 | 本方案 |
|---|------|--------------|----------|--------|
| 15 | Agent 主动整理 vault(孤岛发现、MOC 草稿、双链建议) | 需装 Hermes/OpenClaw | ✗ | **新增** |
| 16 | Agent 记忆沉淀到 vault(agent-experience 笔记类型) | 需装 Hermes | ✗ | **新增** |
| 17 | notes-curator 定时整理 Agent 技能 | 需装 OpenClaw 定时任务 | ✗ | **新增** |
| 18 | knowledge-extractor 对话知识提取技能 | 需装 Hermes 自改进 | ✗ | **新增** |

**这 4 项是 Mona 相比 Obsidian 生态的核心差异化优势**:Obsidian 用户要装第三方框架才能实现,Mona 原生即可。

---

## 三、Vault 结构升级

### 3.1 推荐结构(对齐 PARA + Zettelkasten)

不强制用户采用,作为新建 vault 的默认模板:

```
<vault>/
├── .mona/                    # 配置(已有)
│   ├── vault.json           # 已有:notebooks + knowledgeBaseEnabled
│   ├── links.json           # 新增:双链关系图缓存
│   ├── vectorstore.db       # 新增:sqlite-vec 向量索引
│   ├── curator-state.json   # 新增:notes-curator 扫描状态(已处理笔记 ID + 时间)
│   └── templates/           # 新增:模板文件存放
├── assets/                   # 已有:图片附件
├── 00-Inbox/                 # 收件箱(新建 vault 默认创建)
├── 10-Projects/              # 进行中的项目(PARA P)
├── 20-Areas/                 # 长期领域(PARA A)
├── 30-Resources/             # 主题资源(PARA R)
├── 40-MOC/                   # Map of Content 索引笔记
├── 50-Notes/                 # 永久笔记(Zettelkasten)
├── 60-Agent/                 # 新增:Agent 经验沉淀(见 §12.5)
├── 90-Archive/               # 归档(PARA A)
└── 99-Daily/                 # 每日笔记
```

**`60-Agent/` 目录的定位**:Agent 沉淀的经验、学到的知识、对话总结。区别于用户的原创笔记,但同样可被双链、被检索、用户可见可编辑。详见 §12.5。

### 3.2 文件夹原则(对齐社区共识)

- **文件夹做粗分类,链接/MOC 做细分**:层级不超过 2 级,避免过度分类
- **新建 vault 时自动创建默认结构**,用户可删除/重命名
- **现有 vault 不强制迁移**,用户按需调整

---

## 四、双向链接体系(灵魂能力)

### 4.1 语法支持(完整对齐 Obsidian)

| 语法 | 含义 | 示例 |
|------|------|------|
| `[[笔记标题]]` | 链接到笔记 | `[[向量检索]]` |
| `[[笔记标题\|显示文字]]` | 别名链接 | `[[向量检索\|语义检索]]` |
| `[[笔记标题#标题]]` | 链接到笔记内某标题 | `[[RAG#混合检索]]` |
| `[[笔记标题#^id]]` | 块引用(引用某段落) | `[[RAG#^abc123]]` |
| `![[笔记标题]]` | 嵌入引用(整篇嵌入) | `![[向量化方案]]` |
| `![[笔记标题#标题]]` | 嵌入引用(某标题段) | `![[RAG#混合检索]]` |

### 4.2 编辑器集成

#### 4.2.1 输入 `[[` 触发补全

- 弹出笔记标题搜索框(模糊匹配)
- 显示最近编辑的笔记优先
- 选中后插入 `[[笔记标题]]`
- 若目标不存在,提供"创建新笔记"选项(创建占位笔记)

#### 4.2.2 输入 `![[` 触发嵌入补全

- 同上,但插入 `![[笔记标题]]`
- 渲染时显示嵌入内容预览(只读)

#### 4.2.3 点击跳转

- `[[xxx]]` Ctrl+Click 或 Cmd+Click 跳转到目标笔记
- 目标笔记不存在时,提示创建

#### 4.2.4 悬浮预览

- 鼠标悬停在 `[[xxx]]` 上,显示目标笔记的首段预览(不打开)

### 4.3 反向链接面板

笔记打开时,右侧或底部显示:

```
反向链接 (3)
├── 2026-07-06 笔记向量化方案
│   └── ...复用 [[向量检索]] 和 [[RRF 融合]]...
├── RAG 架构对比
│   └── ...都用到了 [[向量检索]]...
└── 搜索引擎选型
    └── ...底层是 [[向量检索]]...

未链接提及 (2)  ← Smart Connections 风格
├── 笔记 X 提到"向量检索"但未加链接
└── 笔记 Y 提到"semantic search"语义相近
```

- **已链接反向链接**:扫描所有 .md 找 `[[当前笔记标题]]`
- **未链接提及**:全文搜索当前笔记标题(或别名),列出未加 `[[ ]]` 的提及
- 点击任一项跳转到来源笔记并高亮位置

### 4.4 重命名同步

用户重命名笔记 A → B 时:
1. 扫描所有引用了 `[[A]]` 的笔记
2. 全部替换为 `[[B]]`
3. 提示"已更新 N 处引用"

### 4.5 后端实现

#### 4.5.1 链接关系图缓存

`<vault>/.mona/links.json`:

```json
{
  "version": 1,
  "nodes": {
    "note-uuid-1": {"title": "向量检索", "path": "技术/AI/向量检索.md", "aliases": ["向量搜索"]},
    "note-uuid-2": {"title": "RAG", "path": "技术/AI/RAG.md", "aliases": []}
  },
  "edges": {
    "note-uuid-2": [
      {"target": "note-uuid-1", "type": "link", "anchor": "混合检索"},
      {"target": "note-uuid-3", "type": "embed", "anchor": null}
    ]
  },
  "mention_index": {
    "向量检索": ["note-uuid-5", "note-uuid-7"]
  },
  "last_scan_at": "2026-07-06T12:00:00"
}
```

#### 4.5.2 扫描触发时机

- vault 打开时全量扫描
- 笔记保存时增量更新该笔记的出链
- 笔记重命名时全量更新(因为引用方都要改)
- 笔记删除时清理节点和边

#### 4.5.3 Tauri 命令

```rust
#[tauri::command] pub async fn notes_links_get_graph() -> GraphData
#[tauri::command] pub async fn notes_links_get_backlinks(note_id: String) -> Vec<BacklinkItem>
#[tauri::command] pub async fn notes_links_rename_sync(old_title: String, new_title: String) -> RenameResult
#[tauri::command] pub async fn notes_links_search_mentions(query: String) -> Vec<MentionItem>
```

---

## 五、MOC(Map of Content)索引笔记

### 5.1 MOC 的本质

MOC 是一篇**用户手写的索引笔记**,内容主要是 `[[链接]]` 的集合,用于组织某主题下的所有笔记。它解决文件夹分类的死结:**一个概念可以同时属于多个主题**。

### 5.2 MOC 笔记示例

```markdown
---
id: moc-uuid
type: moc
title: 知识管理
tags: [moc, 知识管理]
aliases: ["KM-MOC"]
created: 2026-07-06
updated: 2026-07-06
---

# 知识管理

## 核心概念
- [[双链]] - 笔记间的显式关联
- [[MOC]] - 索引笔记的组织方式
- [[Zettelkasten]] - 卡片盒笔记法
- [[PARA 方法]] - 项目/领域/资源/归档

## 工具对比
- [[Obsidian]] - 本地 markdown 编辑器
- [[Notion]] - 云端协作文档
- [[NotebookLM]] - AI 资料处理

## 实践经验
- [[2026-07-06 笔记向量化方案]]
- [[Obsidian + AI 深度阅读流水线]]
```

### 5.3 frontmatter 新增 `type` 字段

复用笔记已有的 frontmatter,新增可选字段:

| 字段 | 类型 | 可选值 | 说明 |
|------|------|--------|------|
| `type` | string | `note`(默认) / `moc` / `daily` / `template` | 笔记类型 |

MOC 笔记的 `type: moc`,在前端:
- 笔记列表中显示特殊图标(书签或地图图标)
- 可在侧边栏"导航"区单独列出所有 MOC
- MOC 笔记的链接数会显示(帮助判断枢纽节点)

### 5.4 MOC 不强制,不自动生成

- 用户手动创建 MOC 笔记,手动添加 `[[链接]]`
- AI 可建议"该创建 MOC"(后续 Smart Connections 演进),但不自动创建
- 这是对齐社区共识:MOC 是用户的思考产物,不是机器的整理结果

---

## 六、标签系统升级(扁平 + 嵌套)

### 6.1 嵌套标签语法

对齐 Obsidian:

```
#工作/项目A
#工作/项目A/会议
#学习/编程/Python
#状态/待整理
#类型/读书笔记
```

### 6.2 实现

- 标签存储在 frontmatter 的 `tags` 数组(已有)
- 兼容现有的扁平标签(不破坏旧数据)
- 标签筛选面板按 `/` 分层级显示:

```
工作
├── 项目A
│   ├── 会议 (3)
│   └── 任务 (5)
└── 项目B
学习
├── 编程
│   ├── Python (8)
│   └── Rust (2)
└── 阅读
```

- 点击标签筛选时,自动包含所有子标签(对齐 Obsidian 行为)

---

## 七、Frontmatter Properties 标准化

### 7.1 完整字段定义

```yaml
---
# 必填
id: note-uuid              # 已有
title: 笔记标题              # 新增(目前用文件名)
created: 2026-07-06T12:00   # 已有
updated: 2026-07-06T12:00   # 已有

# 可选 - 分类
type: note                  # note | moc | daily | template | agent-experience
tags: [知识管理, 状态/草稿]   # 支持嵌套
aliases: ["别名1", "别名2"]  # 新增:用于双链匹配

# 可选 - 来源
source:
  kind: manual              # 已有:manual | agent | ssh | windows | web-clipper
  label: 手动记录            # 已有
  url: https://...          # 新增:网页剪藏来源

# 可选 - 知识库参与度(已有)
contextLevel: full          # full | summary | none

# 可选 - 自定义字段
status: 进行中               # 用户自定义,供 Dataview 查询
rating: 4                   # 用户自定义

# type: agent-experience 专属(见 §12.5)
session_id: 6a477488e4ada8e506ea0dda   # 来源会话
trigger: chat-complete                 # 触发方式:chat-complete | manual | curator
reviewed: false                        # 是否已被用户审核
---
```

### 7.2 字段可视化编辑

对齐 Obsidian 的 Properties 面板:
- 笔记顶部显示 frontmatter 字段表格
- 点击字段值可内联编辑
- 自定义字段可随时添加(下拉菜单)

---

## 八、Dataview 查询能力

### 8.1 语法(对齐 Obsidian Dataview)

在笔记中插入代码块:

````markdown
```dataview
TABLE status, updated
FROM "20-Areas"
WHERE type = "note" AND contains(tags, "进行中")
SORT updated DESC
LIMIT 10
```
````

### 8.2 支持的查询类型

| 类型 | 语法 | 示例 |
|------|------|------|
| TABLE | `TABLE field1, field2` | 列出字段表格 |
| LIST | `LIST field` | 列表 |
| TASK | `TASK WHERE !completed` | 任务列表 |
| CALENDAR | `CALENDAR file.day` | 日历视图 |

### 8.3 FROM 来源

- `"文件夹路径"`:按文件夹
- `#标签`:按标签
- `[[链接]]`:按双链
- `type = "moc"`:按类型

### 8.4 实现

- 前端解析代码块,调用后端查询
- 后端复用 frontmatter 解析器 + vault 扫描
- 查询结果渲染为表格/列表,插入到笔记中相应位置
- 笔记打开时实时执行查询(动态视图)

### 8.5 Tauri 命令

```rust
#[tauri::command] pub async fn notes_dataview_query(query: String) -> DataviewResult
```

---

## 九、Graph View 知识图谱

### 9.1 数据来源

复用第四节的双链关系图 `links.json`:
- 节点 = 笔记
- 边 = `[[链接]]` 关系
- 节点大小 = 入链数(中心度)
- 节点颜色 = 按 `type` 或 `tags` 分组

### 9.2 可视化

- 力导向图布局(d3-force 或 vis-network)
- 节点可拖拽,可缩放
- 点击节点跳转到笔记
- 双击节点展开/折叠邻居

### 9.3 视图模式

| 模式 | 用途 |
|------|------|
| 全局图 | 整个 vault 的关联网络 |
| 局部图 | 当前笔记 + 1-2 跳邻居 |
| 标签过滤 | 只显示某标签的节点 |
| 孤岛视图 | 高亮无入链的笔记(待整理) |
| 中心节点 | 高引入度节点(枢纽概念) |

### 9.4 前端组件

`webui/src/components/notes/GraphView.tsx`:
- 复用 KB 模块已有的 `graph-view.tsx` 渲染逻辑(可抽取公共组件)
- 数据来自 `notes_links_get_graph` 命令

---

## 十、快速切换(Ctrl+O)

### 10.1 功能

按 Ctrl+O(或 Cmd+O)弹出全局搜索框:
- 模糊匹配笔记标题
- 显示路径(所属笔记本)
- 回车跳转
- 支持别名匹配(从 frontmatter `aliases` 字段)

### 10.2 与现有 Ctrl+K 的区别

| 功能 | Ctrl+K(全局搜索) | Ctrl+O(快速切换) |
|------|-----------------|-----------------|
| 搜索范围 | 标题 + 正文 + 标签 | 仅标题 + 别名 |
| 匹配方式 | 子串 | 模糊匹配(按字符顺序) |
| 结果数 | 多 | 少(精准) |
| 用途 | 找内容 | 跳转笔记 |

### 10.3 实现

- 复用 `links.json` 的 `nodes` 索引(已有标题和别名)
- 前端组件:`QuickSwitcher.tsx`

---

## 十一、Templater 模板系统

### 11.1 模板存放

`<vault>/.mona/templates/` 目录,每个模板是一个 .md 文件:

```markdown
---
# 模板元数据
template_name: 读书笔记
template_triggers: [book, 读书]
---

---
# 应用模板时填充的 frontmatter
id: {{uuid}}
title: {{title}}
type: note
tags: [读书笔记, {{category}}]
source:
  kind: manual
  label: 手动记录
contextLevel: full
created: {{date}}
updated: {{date}}
---

# {{title}}

## 基本信息
- 作者:
- 评分: /5
- 状态: 未读

## 核心观点

## 摘要

## 引用与联想
- [[]]
```

### 11.2 模板变量

| 变量 | 含义 |
|------|------|
| `{{uuid}}` | 生成新 UUID |
| `{{title}}` | 笔记标题(用户输入) |
| `{{date}}` | 当前日期(YYYY-MM-DD) |
| `{{datetime}}` | 当前日期时间 |
| `{{vault_path}}` | vault 路径 |
| `{{notebook}}` | 当前笔记本名 |
| `{{cursor}}` | 编辑器光标位置 |

### 11.3 触发方式

- 新建笔记时选择模板
- 在笔记中输入 `/` 触发模板选择(对齐 Obsidian + Templater)
- 模板可绑定快捷键

### 11.4 内置模板

新建 vault 时自动创建:
- 空白笔记
- 读书笔记
- 会议记录
- 每日笔记
- MOC 索引笔记

---

## 十二、AI Agent 集成(三层架构 — Mona 核心差异化)

本节是 Mona 相比 Obsidian 生态的核心差异化部分。Obsidian 用户需要装 Smart Connections + Copilot + MCP Server + Hermes/OpenClaw 才能实现完整 AI 知识库,Mona 原生实现三层:

| 层 | Obsidian 对应 | Mona 实现 | 章节 |
|----|--------------|----------|------|
| **L1 被动响应** | Smart Connections + Copilot 插件 | 语义推荐 + Vault QA | §12.1-§12.3 |
| **L2 主动操作** | MCP Server + 手动指令 | Agent 写入工具 + diff 审核 | §12.4 |
| **L3 记忆沉淀** | Hermes/OpenClaw 框架 | agent-experience 笔记 + curator 技能 | §12.5-§12.6 |

### 12.1 L1:Smart Connections 风格语义推荐

#### 12.1.1 定位

**双链的补充,不是替代**。双链是用户确认的显式关联(高准确),向量是机器发现的隐式关联(高覆盖)。

#### 12.1.2 能力

笔记编辑时,右侧面板实时显示"相关笔记":

```
相关笔记 (5)
├── 向量检索 (相似度 0.89)
├── RAG 架构 (0.85)
├── sqlite-vec (0.78)
├── 混合检索 (0.72)
└── Embedding 模型对比 (0.68)

未链接的提及 (2)
├── 笔记 X 提到"语义检索"但未加 [[链接]]
└── 笔记 Y 提到"embedding"语义相近
```

#### 12.1.3 实现

复用 KB 三件套:
- `mona/kb/chunker.py`:markdown 切片
- `mona/kb/embedding.py`:调用 embedding API
- `mona/kb/vectorstore.py`:sqlite-vec 存储(扩展支持自定义 db_path)

索引位置:`<vault>/.mona/vectorstore.db`

触发时机:

| 时机 | 动作 |
|------|------|
| 笔记本标记为知识库 | 批量索引整个笔记本 |
| 笔记保存 | 增量更新该笔记向量 |
| 笔记删除 | 清理向量 |
| 笔记打开 | 查询 top-K 相似笔记显示在右侧面板 |

contextLevel 映射:

| contextLevel | 索引行为 | 检索返回 |
|--------------|---------|---------|
| `full` | 索引全文 | 完整片段 |
| `summary` | 只索引首段摘要 | 摘要片段 |
| `none` | 跳过索引 | 不出现 |

后端模块 `mona/notes_kb/`(新增):
- `indexer.py`:笔记切片+向量化+入库
- `search.py`:封装混合检索,注入 vault 路径

KB 模块最小重构:`search_wiki_hybrid` 和 `vectorstore` 函数新增 `markdown_dir` / `db_path` 可选参数,默认值维持原行为。

降级策略:
- embedding 未配置:隐藏"相关笔记"面板,保留双链能力
- embedding 服务不可用:沿用 KB 现有降级,退回关键词检索
- vectorstore.db 不存在:静默不显示,不报错

### 12.2 L1:Copilot 风格 Vault QA

#### 12.2.1 定位

基于笔记库的对话式问答。区别于现有的 NoteAgentPanel(只针对当前笔记),Vault QA 检索整个标记为知识库的笔记。

#### 12.2.2 能力

- 用户在聊天面板选择"笔记知识库"作为上下文
- 提问时,后端走混合检索(双链 + 向量 + 关键词)
- Agent 返回答案 + 引用笔记链接(点击可跳转)

#### 12.2.3 实现

复用 §12.1 的 `search_notes_hybrid`,Agent 工具 `notes_search` 升级:
1. 若 embedding 已配置且 vault 有 vectorstore.db → 走混合检索
2. 否则 → 降级到现有 `tauri_invoke("notes_search_all")` 子串匹配

Agent 工具签名不变,向后兼容。

#### 12.2.4 与 NoteAgentPanel 的关系

| 功能 | NoteAgentPanel(已有) | Vault QA(本节) |
|------|---------------------|----------------|
| 范围 | 当前打开的笔记 | 整个标记为 KB 的笔记本 |
| 触发 | 笔记右侧面板 | 聊天面板选择知识库 |
| 用途 | 针对当前笔记讨论 | 跨笔记检索问答 |

两者并存,不互相替代。

### 12.3 L1:Agent 工具(只读,被动响应)

#### 12.3.1 现有工具升级

| 工具 | 改动 |
|------|------|
| `notes_search` | 智能降级:embedding 已配置走混合检索,否则子串匹配 |
| `notes_create` | 支持 `type` 和 `aliases` 字段 |
| `notes_read` | 不变 |
| `notes_save_image` | 不变 |

#### 12.3.2 新增只读工具

| 工具 | 职责 |
|------|------|
| `notes_get_backlinks` | 获取某笔记的反向链接 |
| `notes_find_related` | 获取语义相关笔记(基于向量) |

---

### 12.4 L2:Agent 主动操作 vault(diff 审核模式)

#### 12.4.1 定位

从「被动响应」升级到「主动整理」。Agent 不仅能读笔记,还能建议修改,但所有写入操作以 **diff 形式**呈现给用户审核,不自动执行破坏性操作。

这是对齐 Obsidian + MCP Server 的玩法,但比手动指令更主动——Agent 会自己发现问题并建议修复。

#### 12.4.2 Agent 写入工具(新增,6 个)

| 工具 | 职责 | 输出 |
|------|------|------|
| `notes_suggest_links` | 扫描笔记,找出应加 `[[xxx]]` 的位置 | `[{note_id, position, suggested_target, reason}]` |
| `notes_add_link` | 在指定笔记插入 `[[xxx]]`(需审核) | diff |
| `notes_create_moc_draft` | 基于主题或笔记簇自动生成 MOC 草稿 | diff(新笔记) |
| `notes_find_orphans` | 找出无入链的孤岛笔记 | `[{note_id, title, age_days}]` |
| `notes_find_duplicates` | 找出主题重复的笔记对 | `[{pair, similarity, suggested_action}]` |
| `notes_merge_tags` | 合并同义标签(需审核) | diff(多笔记 frontmatter 变更) |

#### 12.4.3 diff 审核流程

```
Agent 发现问题
  ↓
生成 diff(增加链接 / 新建 MOC / 合并标签)
  ↓
推送到笔记审核面板
  ↓
用户操作:[应用] / [修改] / [拒绝] / [全部应用]
  ↓
应用:写入 .md 文件 + 更新 links.json + 触发向量增量
拒绝:记录拒绝理由(供 Agent 学习)
```

#### 12.4.4 触发方式

- **用户主动触发**:笔记面板点「Agent 整理建议」按钮
- **Agent 主动发现**:在对话中,Agent 发现可整理的点时主动建议
- **定时触发**:见 §12.6 的 notes-curator 技能

#### 12.4.5 安全边界

- ✗ Agent 不能删除笔记(只能建议归档)
- ✗ Agent 不能改写笔记正文(只能在 frontmatter 加链接、加标签)
- ✗ Agent 不能批量执行(每条建议都要单独审核)
- ✓ Agent 可以创建新笔记(MOC 草稿、agent-experience)
- ✓ 用户可配置「信任级别」:低(全部审核)/ 中(只审核正文修改)/ 高(只读)

---

### 12.5 L3:Agent 记忆沉淀到 vault

#### 12.5.1 定位

这是 Mona 相比 Obsidian 生态的**核心差异化优势**。Hermes 用户需要装框架才能让 Agent 把经验沉淀到 vault,Mona 原生即可做到。

**核心理念**:Agent 经验不再是黑盒(只在 `~/.mona/memory/`),而是沉淀到 vault,可被双链、被检索、用户可见可编辑。这样形成闭环:用户写笔记 → Agent 发现关联 → Agent 沉淀经验 → 经验被双链 → 用户看到 → 用户写更多笔记。

#### 12.5.2 agent-experience 笔记类型

新增 frontmatter `type: agent-experience`,存放在 `60-Agent/` 目录:

```markdown
---
id: agent-exp-20260706-xxx
type: agent-experience
title: "用户问了笔记向量化的最佳方案,我是怎么答的"
created: 2026-07-06T15:30
updated: 2026-07-06T15:30
tags: [agent/experience, 主题/知识管理, 类型/方案设计]
source:
  kind: agent
  label: Agent 自动沉淀
contextLevel: summary
session_id: 6a477488e4ada8e506ea0dda
trigger: chat-complete
reviewed: false
---

# 用户问了笔记向量化的最佳方案,我是怎么答的

## 用户问题
笔记已经是 markdown 了,还需要 LLM 编译吗?

## 我的回答要点
- 不需要 LLM 编译(用户手写已结构化)
- 但需要索引(双链 + 向量)
- 推荐路线 3:笔记接入 KB 向量检索,但跳过编译

## 相关笔记
- [[2026-07-06 笔记向量化方案]]
- [[Obsidian 知识库原理]]

## 学到的
- 用户偏好「最小改动」原则
- 用户倾向 Obsidian 模式而非 LLM Wiki 模式
- 下次遇到类似问题,先查 vault 看有没有现成方案
```

#### 12.5.3 memory 与 vault 的分工

| 内容 | 存哪 | 用途 |
|------|------|------|
| Agent 跨会话事实(用户偏好、决策) | `~/.mona/memory/`(已有) | 快速访问,结构化,不占 vault |
| Agent 经验沉淀(对话总结、学到的) | vault `60-Agent/`(新增) | 可被双链、被检索、用户可见 |
| 用户原创笔记 | vault(已有) | 用户掌控 |

**为什么不全放 memory?**
- memory 是结构化数据,不可被双链
- vault 是 markdown,可被双链、被 Dataview 查询、被用户编辑
- agent-experience 笔记是「半结构化」的,既供 Agent 检索,也供用户审阅

**为什么不全放 vault?**
- memory 读取快,适合高频访问的事实
- vault 笔记有 frontmatter + 正文,过重
- 跨 vault 切换时,memory 保留;vault 不保留

#### 12.5.4 何时沉淀

| 触发条件 | 沉淀内容 |
|---------|---------|
| 对话结束且产生有价值结论 | 答案要点 + 相关笔记 |
| Agent 帮用户整理 vault | 整理报告 + 学到的模式 |
| Agent 发现新关联 | 关联建议 + 推理过程 |

**不沉淀的情况**:
- 闲聊
- 用户明确说「不用记」
- 内容已在现有笔记中
- 简单的读取操作(只是查笔记,没有新结论)

#### 12.5.5 用户审核

agent-experience 笔记 `reviewed: false` 表示未审核。用户可以:
- 查看并编辑(改成 `reviewed: true`)
- 加双链到现有笔记
- 删除(不需要的)
- 提升 `contextLevel` 从 `summary` 到 `full`(让 Agent 后续检索时返回完整内容)

#### 12.5.6 与 NoteAgentPanel 的关系

NoteAgentPanel 是「针对当前笔记对话」,Vault QA 是「跨笔记问答」,agent-experience 是「沉淀对话经验」。三者形成闭环:

```
用户在 NoteAgentPanel 讨论某笔记
  ↓
讨论中 Agent 检索 vault(Vault QA)
  ↓
讨论结束,Agent 沉淀经验到 60-Agent/(agent-experience)
  ↓
经验笔记被双链到原笔记
  ↓
下次打开原笔记,反向链接显示 agent-experience
  ↓
用户看到 Agent 之前的思考,继续深化
```

---

### 12.6 L3:Agent 技能

#### 12.6.1 notes-curator 技能(定时整理)

新增 Agent 技能 `mona/skills/notes-curator/`:

```markdown
---
name: notes-curator
description: 笔记库整理 Agent,主动发现关联、建议 MOC、提醒孤岛
triggers:
  - cron: "0 9 * * *"  # 每天 9 点扫描
  - manual: true
---

## 你的职责

你是一个笔记库整理助手。你的目标是让用户的笔记库更有机、更有结构,但不替代用户思考。

### 每日扫描清单

1. **孤岛发现**:找出过去 7 天新建且无入链的笔记,提示用户加双链
2. **主题簇识别**:发现 3 篇以上语义相似的笔记,建议创建 MOC
3. **重复检测**:找出主题重复的笔记对,建议合并或加双链
4. **未链接提及**:找出提到某笔记标题但未加 `[[ ]]` 的位置
5. **新兴趣点**:发现用户最近一周高频写的主题,生成「兴趣简报」
6. **晨间简报**:汇总昨天的笔记活动 + 今天的建议

### 输出格式

所有建议以 diff 形式呈现到审核面板:

```
今日整理建议 (8)

🆕 新建 MOC 草稿
└── 「知识管理」MOC - 包含 5 篇笔记 [[向量检索]] [[RAG]] ...

🔗 建议加双链 (3)
├── 笔记《2026-07-06 方案设计》第 12 行
│   └── 建议把"向量检索"改为 [[向量检索]]
├── ...

🏝️ 孤岛笔记 (2)
├── 《临时想法 2026-07-05》- 无入链,已 2 天
└── ...

📊 兴趣简报
└── 你最近 7 天写了 4 篇关于「Obsidian」的笔记,这是一个新主题
    建议创建 MOC: [[MOC-Obsidian]]

📝 晨间简报
└── 昨天:新建 3 篇,编辑 5 篇
    今天建议:整理 60-Agent/ 目录,有 2 篇未审核
```

### 关键约束

- **不自动执行**:所有建议都需用户审核
- **不删除**:只能建议归档,不能删除
- **不改写正文**:只能在 frontmatter 加链接、加标签
- **沉淀经验**:每次扫描后,沉淀一篇 agent-experience 笔记,记录发现的模式和用户的反馈

### 学习机制

- 用户拒绝某建议时,记录拒绝理由到 agent-experience
- 下次扫描时,读取近期 agent-experience,避免重复建议被拒绝的内容
- 用户审核 agent-experience 后,提升其 `contextLevel`,供后续检索使用
```

#### 12.6.2 knowledge-extractor 技能(对话知识提取)

新增 Agent 技能 `mona/skills/knowledge-extractor/`:

```markdown
---
name: knowledge-extractor
description: 从 Agent 对话中提取值得沉淀的知识,生成笔记到 vault
triggers:
  - on_chat_complete: true
  - manual: true
---

## 你的职责

在对话结束后,分析刚结束的对话,提取值得记住的事实、决策、经验,生成笔记到 vault 的 `60-Agent/` 目录。

### 提取规则

**值得沉淀的情况**:
- 用户做了明确决策(选了某方案、定了某原则)
- Agent 给出了有价值的分析(对比、推理、设计)
- 用户表达了偏好或约束(「我不喜欢 X」「以后都按 Y 来」)
- 解决了某个 bug 或技术问题
- 产生了新的概念或方法论

**不沉淀的情况**:
- 闲聊、问候
- 用户明确说「不用记」
- 内容已在现有笔记中(去重检查)
- 简单的读取操作(查笔记、读文件)
- 临时性的代码改动(已在 git 中)

### 笔记格式

按 §12.5.2 的 agent-experience 格式生成,包含:
- 用户问题摘要
- Agent 回答要点
- 相关笔记双链
- 学到的(模式、偏好、约束)

### 自动加双链

生成 agent-experience 笔记时,自动添加到相关笔记的双链:
- 提到的笔记标题 → `[[xxx]]`
- 涉及的概念 → 已有概念笔记(若存在)

### 关键约束

- 每次对话最多生成 1 篇 agent-experience 笔记
- 笔记默认 `contextLevel: summary`(用户审核后可提升)
- 笔记默认 `reviewed: false`
- 不重复沉淀:检查 vault 中是否已有类似笔记(基于向量相似度)
```

#### 12.6.3 与现有 NoteAgentPanel 的整合

现有 NoteAgentPanel 针对单篇笔记对话,本方案不替代它,而是扩展:

| 触发点 | 行为 |
|--------|------|
| NoteAgentPanel 对话结束 | knowledge-extractor 检查是否值得沉淀 |
| Vault QA 对话结束 | 同上 |
| 每日 9 点 | notes-curator 扫描 vault |
| 用户在笔记面板点「整理建议」 | notes-curator 手动触发 |

#### 12.6.4 配置开关

用户可在设置中控制 Agent 介入程度:

| 开关 | 默认 | 说明 |
|------|------|------|
| `agent_curator_enabled` | true | 启用定时整理 |
| `agent_curator_cron` | "0 9 * * *" | 扫描时间 |
| `agent_experience_enabled` | true | 启用对话沉淀 |
| `agent_experience_auto_link` | false | 自动加双链(关闭则只生成笔记,不加链接) |
| `agent_diff_review_level` | "low" | 审核级别:low(全审)/ medium / high |

---

## 十三、数据归属边界

### 13.1 笔记模块 vs KB 模块

| 维度 | 笔记模块 | KB 模块 |
|------|---------|--------|
| 内容来源 | 用户手写 + Agent 沉淀 | 外部导入(PDF/网页/视频) |
| 组织方式 | 双链 + MOC + 标签 | LLM 编译成 wiki |
| 检索方式 | 双链 + 关键词 + 向量补充 | 关键词 + 向量 + RRF |
| AI 介入 | 关联发现 + 问答 + 主动整理 + 记忆沉淀 | 内容编译 + 问答 |
| 数据归属 | 用户绝对掌控 | 同上 |

### 13.2 不混用的原则

- 笔记不进入 KB 的 raw/wiki 目录
- KB 的 wiki 页面不进入笔记 vault
- 两者在 UI 上分离(笔记 Tab vs 知识库 Tab)
- 聊天选择器中明确区分:`notebook:xxx`(笔记)vs KB 项目 ID(导入资料)

### 13.3 memory 与 vault 的分工(回顾 §12.5.3)

| 内容 | 存哪 | 用途 |
|------|------|------|
| Agent 跨会话事实 | `~/.mona/memory/`(已有) | 快速访问,结构化 |
| Agent 经验沉淀 | vault `60-Agent/`(新增) | 可被双链、被检索、用户可见 |
| 用户原创笔记 | vault(已有) | 用户掌控 |

---

## 十四、改动清单

### 14.1 新增后端模块

| 文件 | 职责 |
|------|------|
| `mona/notes_kb/__init__.py` | 包标记 |
| `mona/notes_kb/indexer.py` | 笔记切片+向量化+入库,contextLevel 过滤 |
| `mona/notes_kb/search.py` | 混合检索封装,复用 KB search_wiki_hybrid |
| `mona/notes_kb/links.py` | 双链关系图扫描、缓存、反向链接查询 |
| `mona/notes_kb/curator.py` | Agent 整理逻辑(孤岛、重复、MOC 草稿生成) |

### 14.2 新增 Agent 技能

| 路径 | 职责 |
|------|------|
| `mona/skills/notes-curator/SKILL.md` | 定时整理 vault,生成整理建议 |
| `mona/skills/knowledge-extractor/SKILL.md` | 对话结束提取知识到 vault |

### 14.3 重构现有后端

| 文件 | 改动 |
|------|------|
| `mona/kb/search.py` | `search_wiki_hybrid` 新增 `markdown_dir` / `vectorstore_db` 可选参数 |
| `mona/kb/vectorstore.py` | 四个函数新增 `db_path` 可选参数 |
| `mona/api/server.py` | 新增 18+ 个 HTTP 路由(双链、MOC、Dataview、向量、Agent 整理、经验沉淀) |
| `mona/agent/tools/notes.py` | `notes_search` 智能降级;新增 6 个写入工具;新增 agent-experience 创建工具 |
| `mona/agent/loop.py` | 对话结束触发 knowledge-extractor(若启用) |

### 14.4 Rust 端

| 文件 | 改动 |
|------|------|
| `src-tauri/src/notes.rs` | frontmatter 新增 `type`/`aliases` 字段解析;双链扫描;重命名同步;新增 12+ Tauri 命令 |

### 14.5 前端新增组件

| 组件 | 职责 |
|------|------|
| `BacklinksPanel.tsx` | 反向链接 + 未链接提及面板 |
| `GraphView.tsx` | 知识图谱可视化(复用 KB 的 graph-view) |
| `QuickSwitcher.tsx` | Ctrl+O 快速切换 |
| `TemplatePicker.tsx` | 模板选择对话框 |
| `PropertiesPanel.tsx` | frontmatter 可视化编辑 |
| `TagTree.tsx` | 嵌套标签树 |
| `RelatedNotesPanel.tsx` | Smart Connections 风格的相关笔记推荐 |
| `DataviewRenderer.tsx` | Dataview 查询代码块渲染 |
| `AgentDiffReviewPanel.tsx` | Agent 整理建议的 diff 审核面板 |
| `AgentExperienceList.tsx` | `60-Agent/` 目录的 agent-experience 笔记列表 + 审核入口 |
| `CuratorDashboard.tsx` | notes-curator 每日简报面板 |

### 14.6 前端改动

| 文件 | 改动 |
|------|------|
| `NoteEditor.tsx` | `[[xxx]]` 补全、跳转、悬浮预览;`![[xxx]]` 嵌入渲染;Dataview 代码块渲染 |
| `NotesView.tsx` | 集成反向链接面板、相关笔记面板、Graph View Tab、Agent 整理建议按钮 |
| `NoteList.tsx` | MOC 类型图标;标签树筛选;agent-experience 类型标识 |
| `notes-storage.ts` | 保存触发增量索引;删除触发清理;重命名触发同步 |
| `notes-data.ts` | 新增 `type`/`aliases`/`reviewed` 字段 |
| `lib/kb-api.ts` | 新增 notes-kb API 方法 |
| `lib/agent-api.ts` | 新增 Agent 整理 API 方法 |
| `App.tsx` | Ctrl+O 快速切换全局快捷键 |
| `ThreadShell.tsx` | `notebook:` 前缀路由到笔记检索 |
| `settings/NotesSettings.tsx` | 新增 Agent 开关配置区 |

---

## 十五、HTTP 路由清单

在 `mona/api/server.py` 注册(gateway HTTP server,前端走 `getGatewayHttpBase()`):

### 15.1 双链

| 方法 | 路径 | 职责 |
|------|------|------|
| GET | `/api/notes-links/graph` | 获取双链关系图 |
| GET | `/api/notes-links/backlinks/{note_id}` | 获取反向链接 |
| GET | `/api/notes-links/mentions/{note_id}` | 获取未链接提及 |
| POST | `/api/notes-links/rename-sync` | 重命名同步 |

### 15.2 MOC

| 方法 | 路径 | 职责 |
|------|------|------|
| GET | `/api/notes-moc/list` | 列出所有 MOC 笔记 |

### 15.3 Dataview

| 方法 | 路径 | 职责 |
|------|------|------|
| POST | `/api/notes-dataview/query` | 执行 Dataview 查询 |

### 15.4 向量索引

| 方法 | 路径 | 职责 |
|------|------|------|
| POST | `/api/notes-kb/reindex-notebook` | 批量索引某笔记本 |
| POST | `/api/notes-kb/reindex-note` | 单条笔记增量 |
| POST | `/api/notes-kb/unindex-note` | 删除单条笔记向量 |
| POST | `/api/notes-kb/unindex-notebook` | 删除整笔记本向量 |
| POST | `/api/notes-kb/search` | 混合检索 |
| GET | `/api/notes-kb/related/{note_id}` | 获取相关笔记 |

### 15.5 模板

| 方法 | 路径 | 职责 |
|------|------|------|
| GET | `/api/notes-templates/list` | 列出模板 |
| POST | `/api/notes-templates/apply` | 应用模板生成笔记 |

### 15.6 Agent 整理(L2)

| 方法 | 路径 | 职责 |
|------|------|------|
| POST | `/api/notes-agent/suggest-links` | 扫描笔记,建议加双链位置 |
| POST | `/api/notes-agent/create-moc-draft` | 生成 MOC 草稿 |
| GET | `/api/notes-agent/find-orphans` | 找出孤岛笔记 |
| GET | `/api/notes-agent/find-duplicates` | 找出重复主题笔记 |
| POST | `/api/notes-agent/apply-diff` | 应用 diff(用户审核后) |
| POST | `/api/notes-agent/reject-diff` | 拒绝 diff(记录理由) |

### 15.7 Agent 经验沉淀(L3)

| 方法 | 路径 | 职责 |
|------|------|------|
| POST | `/api/notes-agent/experience/create` | 创建 agent-experience 笔记 |
| GET | `/api/notes-agent/experience/unreviewed` | 列出未审核的 agent-experience |
| POST | `/api/notes-agent/experience/{id}/review` | 审核笔记(标记 reviewed=true) |
| POST | `/api/notes-agent/curator/run` | 手动触发 notes-curator 扫描 |
| GET | `/api/notes-agent/curator/dashboard` | 获取今日简报 |

---

## 十六、Embedding 配置归属

### 决策:全局共享

- 复用 KB 现有的 embedding 配置 UI(存储在 localStorage `mona-kb-embed-draft`)
- 笔记模块不另存配置
- 前端调用 notes-kb 接口时,把 `embedDraft` 作为请求体字段传给后端
- 后端 `mona/notes_kb/` 完全无状态

---

## 十七、Agent 工具清单

### 17.1 现有工具升级(L1)

| 工具 | 改动 |
|------|------|
| `notes_search` | 智能降级:embedding 已配置走混合检索,否则子串匹配 |
| `notes_create` | 支持 `type` / `aliases` 字段 |
| `notes_read` | 不变 |
| `notes_save_image` | 不变 |

### 17.2 新增只读工具(L1)

| 工具 | 职责 |
|------|------|
| `notes_get_backlinks` | 获取某笔记的反向链接 |
| `notes_find_related` | 获取语义相关笔记(基于向量) |

### 17.3 新增写入工具(L2,需审核)

| 工具 | 职责 | 输出 |
|------|------|------|
| `notes_suggest_links` | 扫描笔记,建议加 `[[xxx]]` 的位置 | suggestion list |
| `notes_add_link` | 在指定笔记插入 `[[xxx]]` | diff |
| `notes_create_moc_draft` | 基于主题生成 MOC 草稿 | diff(新笔记) |
| `notes_find_orphans` | 找出孤岛笔记 | list |
| `notes_find_duplicates` | 找出主题重复笔记对 | list |
| `notes_merge_tags` | 合并同义标签 | diff(多笔记变更) |

### 17.4 新增经验沉淀工具(L3)

| 工具 | 职责 |
|------|------|
| `notes_create_experience` | 创建 agent-experience 笔记(对话沉淀) |
| `notes_create_moc` | 创建 MOC 索引笔记(用户手动创建时) |

---

## 十八、风险与对策

| 风险 | 对策 |
|------|------|
| 双链扫描性能 | 增量更新 + 缓存 `links.json`,只在保存时更新当前笔记的出链 |
| 重命名同步失败 | 全量扫描前先备份 `links.json`,失败可回滚 |
| 向量索引成本 | 增量优先,只在标记 KB 时批量 |
| embedding 不可用 | 隐藏相关笔记面板,保留双链(双链不依赖 embedding) |
| 用户不写双链 | 不强制,Smart Connections 自动发现关联作为补充 |
| MOC 概念门槛 | 提供模板和引导,但不强制使用 |
| vault 兼容性 | 现有 vault 不破坏,新功能可选启用 |
| **Agent 自动整理的噪音** | diff 审核机制,用户可拒绝;拒绝理由被 Agent 学习 |
| **agent-experience 泛滥** | 每次对话最多 1 篇;去重检查;用户可关闭沉淀 |
| **Agent 学习失败** | 拒绝理由沉淀到 agent-experience,下次扫描时读取 |
| **定时扫描打扰** | 只在审核面板显示,不弹窗;用户可关闭 curator |
| **60-Agent/ 目录污染** | 默认 `contextLevel: summary`,不参与主检索;用户审核后可提升 |

---

## 十九、验证清单

### 19.1 双链

- [ ] 输入 `[[` 弹出补全
- [ ] 点击 `[[xxx]]` 跳转
- [ ] 悬停显示预览
- [ ] 反向链接面板显示引用方
- [ ] 未链接提及显示
- [ ] 重命名笔记后引用方自动更新
- [ ] 嵌入 `![[xxx]]` 正确渲染

### 19.2 MOC

- [ ] 创建 `type: moc` 笔记
- [ ] 笔记列表显示 MOC 图标
- [ ] 侧边栏导航区列出所有 MOC

### 19.3 标签

- [ ] 嵌套标签 `#a/b` 正确解析
- [ ] 标签树层级显示
- [ ] 点击父标签包含子标签

### 19.4 Dataview

- [ ] `TABLE` 查询返回表格
- [ ] `FROM "folder"` 按文件夹过滤
- [ ] `WHERE` 条件过滤
- [ ] `SORT` 排序

### 19.5 Graph View

- [ ] 全局图显示所有节点
- [ ] 局部图显示当前笔记邻居
- [ ] 孤岛节点高亮
- [ ] 中心节点识别

### 19.6 快速切换

- [ ] Ctrl+O 弹出
- [ ] 模糊匹配
- [ ] 别名匹配

### 19.7 模板

- [ ] 新建笔记选择模板
- [ ] 变量正确填充
- [ ] 内置模板存在

### 19.8 Smart Connections (L1)

- [ ] 相关笔记面板显示
- [ ] 标记 KB 后向量索引构建
- [ ] 笔记保存后增量更新
- [ ] 删除笔记后向量清理
- [ ] contextLevel=none 不被索引

### 19.9 降级

- [ ] embedding 未配置:隐藏相关面板,双链正常
- [ ] vectorstore.db 不存在:不报错
- [ ] KB 模块行为完全不受影响

### 19.10 Agent 主动整理 (L2)

- [ ] `notes_suggest_links` 扫描笔记返回建议
- [ ] `notes_create_moc_draft` 生成 MOC 草稿
- [ ] `notes_find_orphans` 找出孤岛笔记
- [ ] `notes_find_duplicates` 找出重复主题
- [ ] diff 审核面板:应用 / 修改 / 拒绝
- [ ] 拒绝理由被记录
- [ ] Agent 不自动执行破坏性操作

### 19.11 Agent 记忆沉淀 (L3)

- [ ] 对话结束触发 knowledge-extractor
- [ ] 生成 agent-experience 笔记到 60-Agent/
- [ ] 笔记自动添加相关双链
- [ ] 重复内容不沉淀(去重检查)
- [ ] 用户可审核(标记 reviewed=true)
- [ ] 未审核笔记不参与主检索(contextLevel=summary)

### 19.12 notes-curator 技能 (L3)

- [ ] 每天 9 点触发扫描
- [ ] 生成整理建议(孤岛 / 重复 / MOC 草稿)
- [ ] 晨间简报显示在面板
- [ ] 用户拒绝某建议后,下次扫描不重复建议
- [ ] 扫描结束沉淀 agent-experience

---

## 二十、不做的事

- ✗ 不让 LLM 重写笔记内容
- ✗ 不自动生成 MOC(MOC 是用户思考产物,Agent 只生成草稿)
- ✗ 不在 vault 内建 raw/wiki/output 三层(那是 LLM Wiki 模式)
- ✗ 不引入 GraphRAG(Karpathy 已证明小规模不需要)
- ✗ 不强制用户采用 PARA 结构
- ✗ 不破坏现有 vault 数据
- ✗ 不让笔记和 KB 模块互相访问对方数据
- ✗ 不让 Agent 自动执行破坏性操作(必须 diff 审核)
- ✗ 不让 agent-experience 笔记默认参与主检索(需用户审核提升)
- ✗ 不每条对话都沉淀(只提取有价值的)
- ✗ 不强制启用 L3(用户可关闭 Agent 记忆沉淀)

---

## 二十一、与社区主流方案的对照

### 21.1 L1-L3 Obsidian 主流玩法(14 项)

| Obsidian 主流玩法 | 本方案对应能力 |
|------------------|---------------|
| 双向链接 `[[xxx]]` | 第四节 |
| 反向链接面板 | 第四节 4.3 |
| 嵌入引用 `![[xxx]]` | 第四节 4.1 |
| 块引用 `[[xxx#^id]]` | 第四节 4.1 |
| MOC 索引笔记 | 第五节 |
| 嵌套标签 `#a/b` | 第六节 |
| Properties (YAML) | 第七节 |
| Dataview 查询 | 第八节 |
| Graph View | 第九节 |
| 快速切换 Ctrl+O | 第十节 |
| Templater 模板 | 第十一节 |
| Smart Connections | §12.1 |
| Obsidian Copilot Vault Chat | §12.2 |

### 21.2 L4 Mona Agent 平台原生能力(4 项,超越 Obsidian)

| 能力 | Obsidian 对应 | 本方案对应 |
|------|--------------|----------|
| Agent 主动整理 vault | 需装 MCP Server + 手动指令 | §12.4 |
| Agent 记忆沉淀 | 需装 Hermes 框架 | §12.5 |
| notes-curator 定时整理 | 需装 OpenClaw 定时任务 | §12.6.1 |
| knowledge-extractor 对话沉淀 | 需装 Hermes 自改进 | §12.6.2 |

**完整对齐 Obsidian 社区 14 项主流玩法 + 4 项 Mona 原生差异化能力,共 18 项**。

---

## 二十二、实施路线图

### 阶段 1:基础能力(双链 + MOC + 标签 + Frontmatter)

- 双向链接语法解析与补全
- 反向链接面板
- MOC 类型支持
- 嵌套标签
- Frontmatter `type`/`aliases` 字段
- 重命名同步

### 阶段 2:可视化与查询(Graph View + Dataview + 快速切换)

- Graph View 知识图谱
- Dataview 查询
- 快速切换 Ctrl+O

### 阶段 3:模板系统(Templater)

- 模板存放与变量填充
- 内置模板
- 触发方式

### 阶段 4:L1 智能(Smart Connections + Vault QA)

- 向量索引(复用 KB 三件套)
- 相关笔记推荐
- Agent 只读工具升级
- Vault QA

### 阶段 5:L2 Agent 主动整理(diff 审核模式)

- Agent 写入工具(6 个)
- diff 审核面板
- 整理建议按钮

### 阶段 6:L3 Agent 记忆沉淀(Mona 核心差异化)

- agent-experience 笔记类型
- `60-Agent/` 目录
- knowledge-extractor 技能
- notes-curator 技能(定时扫描)
- Agent 学习机制(拒绝理由沉淀)

每阶段可独立验证,不互相阻塞。阶段 1-3 是 Obsidian 风格基础,阶段 4 是 AI 辅助,阶段 5-6 是 Mona 的核心差异化能力。
