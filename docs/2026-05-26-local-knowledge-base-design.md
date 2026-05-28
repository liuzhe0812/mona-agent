# 本地 AI 知识库 - 详细设计方案

## 概述

> **目标：** 为 Mona 开发本地 AI 知识库功能，支持两种使用场景，采用差异化策略最小化 Token 消耗，确保 Agent 能高效获取知识。

**两种场景：**

| 场景 | 描述 | 内容特征 | 核心策略 |
|------|------|---------|---------|
| **Document 模式** | 用户上传固定文档 | 稳定、不常变 | FTS5 + LLM Wiki（Wiki-First） |
| **Notebook 模式** | 联动笔记本功能 | 频繁更新 | FTS5 整篇检索（Search-First） |

**技术栈：**
- Python 3.11+，asyncio 异步
- SQLite + FTS5（全文检索）
- Markdown 文件（Wiki 存储，仅 Document 模式）
- Pydantic 数据模型
- Mona 现有 LLM Provider 系统

---

## 一、架构设计

### 1.1 整体架构

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                               Mona Agent                                      │
│                                                                               │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    knowledge.py (Tool 入口)                             │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │
│  │  │ kb_ingest  │  │  kb_query  │  │  kb_status │  │  kb_compile   │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                      │                                        │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                                   │                                    │  │
│  │  ┌────────────────────────────────▼──────────────────────────────────┐│  │
│  │  │                     knowledge/ (核心模块)                          ││  │
│  │  │  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────┐ ││  │
│  │  │  │  indexer.py   │  │   wiki.py     │  │      store.py         │ ││  │
│  │  │  │ (FTS5 索引)   │  │ (Wiki 编译器) │  │ (存储/元数据管理)     │ ││  │
│  │  │  └───────────────┘  └───────────────┘  └───────────────────────┘ ││  │
│  │  │  ┌───────────────────────────────────────────────────────────────┐││  │
│  │  │  │                  compiler.py (增量编译调度)                    │││  │
│  │  │  │              仅 Document 模式使用                              │││  │
│  │  │  └───────────────────────────────────────────────────────────────┘││  │
│  │  └──────────────────────────────────────────────────────────────────┘│  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                      │                                        │
│  ┌───────────────────────────────────▼────────────────────────────────────┐  │
│  │                          .knowledge/ 目录                               │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  index.db  (SQLite + FTS5)                                        │ │  │
│  │  │  meta.json  (元数据)                                               │ │  │
│  │  │  wiki/  (仅 Document 模式)                                         │ │  │
│  │  │    ├─ _index.md  (知识地图)                                       │ │  │
│  │  │    ├─ _relations.md  (实体关系图)                                 │ │  │
│  │  │    └─ ... (各主题 Wiki 页)                                        │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 模块职责

| 模块 | 职责 | 使用模式 |
|------|------|---------|
| `knowledge.py` | 工具入口，注册到 ToolRegistry，暴露 `kb_ingest`、`kb_query` 等工具 | 两种模式 |
| `indexer.py` | FTS5 索引管理：创建、更新、查询全文索引 | 两种模式 |
| `wiki.py` | Wiki 编译引擎：调用 LLM 生成/更新 Wiki 页 | 仅 Document |
| `compiler.py` | 增量编译调度：管理 pending 变更，批量编译，懒加载触发 | 仅 Document |
| `store.py` | 存储管理：meta.json 读写，Wiki 文件管理 | 两种模式 |

---

## 二、双模式策略

### 2.1 Document 模式（Wiki-First）

**适用场景：** 用户上传固定文档（PDF、MD 等），内容稳定不常变。

**核心思路：** 编译一次，反复使用。Wiki 是核心知识资产，FTS5 补充精确检索。

```
入库：上传文档 → FTS5 索引 + 主动编译 Wiki
查询：Wiki 页内容（结构化知识）+ FTS5 补充细节
Token：初始编译投入，后续查询几乎为零
```

**为什么 Wiki 适合固定文档：**
- 内容稳定 → Wiki 编译一次长期准确，不需要重编
- 文档可能非结构化 → Wiki 编译为结构化知识，增值明显
- 交叉引用长期有效 → 知识图谱稳定可用

### 2.2 Notebook 模式（Search-First）

**适用场景：** 联动笔记功能，文件和内容频繁更新。

**核心思路：** FTS5 定位笔记，整篇读取返回。不做 Wiki 编译。

```
入库：笔记变更 → FTS5 索引更新（零 Token）
查询：FTS5 搜索 → 定位相关笔记路径 → 读取整篇笔记 → 返回给 Agent
Token：持续为零（FTS5 索引）+ 按需（Agent 读取文件）
```

**为什么 Notebook 不用 Wiki：**
- 内容频繁更新 → Wiki 永远滞后，编译跟不上节奏
- 笔记本身已是结构化文字 → 再编译成 Wiki 增值有限
- 持续编译消耗 Token → 投入产出比差

**为什么返回整篇笔记而非片段：**
- 片段缺乏上下文，Agent 可能误解
- 片段经常需要再调 `read_file` 补读，不如一次给全
- 笔记通常不会太长（几百到几千字），整篇注入上下文窗口完全可行
- 实现更简单：FTS5 只负责"找"，文件读取负责"取"

### 2.3 多知识库实例

> **参考来源：** [Khoj](https://github.com/khoj-ai/khoj) 的多数据源管理模式。

一个 workspace 可以有多个知识库实例，每个实例独立配置模式。例如：

```
workspace/
├── .knowledge/
│   ├── project-docs/            # Document 模式：项目文档
│   │   ├── index.db
│   │   ├── meta.json
│   │   └── wiki/
│   └── dev-notes/               # Notebook 模式：开发笔记
│       ├── index.db
│       └── meta.json
```

**配置方式：**

```json
{
  "tools": {
    "knowledge": {
      "instances": {
        "project-docs": {
          "mode": "document",
          "paths": ["docs/"]
        },
        "dev-notes": {
          "mode": "notebook",
          "paths": ["notes/"]
        }
      }
    }
  }
}
```

**查询时指定实例：**

```
kb_query(query="装饰器", instance="dev-notes")
kb_query(query="API 规范", instance="project-docs")
kb_query(query="装饰器")  # 不指定则搜索所有实例
```

### 2.4 两种模式对比

| 维度 | Document 模式 | Notebook 模式 |
|------|--------------|---------------|
| 入库行为 | FTS5 索引 + 主动编译 Wiki | 只建 FTS5 索引 |
| 查询优先级 | Wiki → FTS5 补充 | FTS5 定位 → 整篇读取 |
| 编译触发 | 入库即编译 + 增量更新 | 不编译 |
| Wiki 定位 | 核心知识资产 | 不使用 |
| Token 消耗 | 初始高，后续极低 | 持续为零 |
| 返回内容 | Wiki 页（结构化） | 整篇笔记（完整） |
| 上下文占用 | 低（Wiki 已压缩） | 按需控制（max_tokens 预算） |

---

## 三、核心功能设计

### 3.1 Document 模式工作流

#### 3.1.1 入库流程

```
用户上传文档
      ↓
  计算文件哈希
      ↓
  与 meta.json 比对
      ↓
  哈希不变 → 跳过（零 Token）
  哈希变化 → 记入 pending_changes
      ↓
  立即更新 FTS5 索引（零 Token，毫秒级）
      ↓
  主动触发 Wiki 编译
```

#### 3.1.2 查询流程

```
用户提问
      ↓
  FTS5 在 Wiki 页中搜索（<10ms）
      ↓
  返回匹配的 Wiki 页完整内容
      ↓
  如需细节 → FTS5 在原文中补充检索
      ↓
  组装上下文：Wiki 内容 + 原文片段
      ↓
  返回给 Agent
```

#### 3.1.3 增量编译流程

```
触发编译（入库触发 / 手动触发 / 懒加载）
      ↓
  获取 pending_changes 队列
      ↓
  分析变更影响范围
      ↓
  批量调用 LLM：
      - 新增文件 → 创建新 Wiki 页
      - 修改文件（重大）→ 更新相关 Wiki 页
      - 修改文件（微调）→ 下次批量处理
      - 删除文件 → 标记失效
      ↓
  更新交叉引用和 _index.md
      ↓
  清空 pending_changes
```

### 3.2 Notebook 模式工作流

#### 3.2.1 入库流程

```
笔记新增/修改
      ↓
  计算文件哈希，与 meta.json 比对
      ↓
  哈希不变 → 跳过
  哈希变化 → 更新 FTS5 索引（零 Token，毫秒级）
      ↓
  完成（不做 Wiki 编译）
```

#### 3.2.2 查询流程

```
用户提问
      ↓
  FTS5 搜索 → 返回匹配的笔记路径列表（按相关度排序）
      ↓
  读取 Top-K 篇笔记的完整内容
      ↓
  检查总 token 数是否超预算
      ├─ 未超 → 返回全部完整内容
      └─ 超了 → 按相关度截断：保留前 N 篇完整 + 后续篇截断
      ↓
  格式化返回给 Agent
```

**查询返回格式示例：**

```
## 知识库搜索结果：装饰器

### 📄 Python 学习笔记 (notes/python-learn.md)

# Python 学习笔记

## 装饰器

装饰器是 Python 中一种强大的语法糖，它允许我们在不修改
函数代码的情况下扩展函数的行为。

常见用法：
- @staticmethod
- @classmethod
- @property

## 生成器

生成器是另一种...

---

### 📄 Flask 开发笔记 (notes/flask-dev.md)

# Flask 开发笔记

## 路由装饰器

Flask 使用 @app.route() 装饰器将 URL 绑定到视图函数...

---

共 2 篇笔记匹配，总约 3200 tokens
```

### 3.3 增量编译策略（仅 Document 模式）

#### 3.3.1 变更分类

| 变更类型 | 判断标准 | 处理方式 |
|----------|----------|----------|
| **新增文件** | hash 不存在于 meta | 加入 pending，标记为新增 |
| **微调** | diff_ratio < 0.1 | 加入 pending，标记为 minor，暂不编译 |
| **中等变更** | 0.1 ≤ diff_ratio < 0.5 | 加入 pending，标记为 moderate |
| **重大变更** | diff_ratio ≥ 0.5 | 加入 pending，标记为 major，高优先级 |
| **删除文件** | 文件不存在，meta 中有 | 标记为 deleted |

#### 3.3.2 编译触发时机（优先级从高到低）

| 时机 | 说明 |
|------|------|
| **入库触发** | Document 模式入库时主动编译 |
| **手动触发** | 用户调用 `kb_compile` 工具 |
| **查询触发** | 用户提问命中 pending 变更的相关主题（懒加载） |
| **阈值触发** | pending_changes 数量 ≥ batch_compile_threshold |

### 3.4 LLM Wiki 编译（仅 Document 模式）

#### 3.4.1 Wiki 页面结构

> **参考来源：** [LLM Wiki](https://github.com/nashsu/llm_wiki) 的 Wiki 页面结构设计和反向链接规范。

每个 Wiki 页使用 YAML frontmatter 存储元数据，正文使用 Markdown，底部自动维护反向链接。

```
wiki/
├── _index.md                    # 知识地图首页
├── _relations.md                # 实体关系图（Mermaid）
├── python-decorator.md          # 主题页（示例）
└── ...
```

**单页结构示例：**

```markdown
---
title: Python 装饰器
source_files:
  - docs/python/decorator-guide.md
  - docs/python/advanced-patterns.md
tags: [python, 设计模式, 语法糖]
compiled_at: 2026-05-26T10:00:00
---

# Python 装饰器

## 概念
装饰器是 Python 中一种强大的语法糖...

## 用法
- @staticmethod
- @classmethod
- @property

## 示例
```python
@timer
def slow_function():
    ...
```

## 相关链接
- [设计模式](python-patterns.md)
- [异步编程](python-async.md)

## 反向链接
_以下页面引用了本页：_
- [Flask 路由](flask-routing.md)
- [缓存策略](caching-strategies.md)
```

**页面元数据规范（frontmatter）：**

| 字段 | 说明 |
|------|------|
| `title` | 页面标题 |
| `source_files` | 编译来源的原始文件路径列表 |
| `tags` | 主题标签，用于分类和检索 |
| `compiled_at` | 最后编译时间 |

**反向链接机制：**

编译时自动扫描所有 Wiki 页的 `## 相关链接` 部分，在目标页面底部生成 `## 反向链接` 列表。无需手动维护，每次编译后自动更新。

#### 3.4.2 编译 Prompt 设计

```jinja
你是一个知识库编译器。请根据以下输入编译 Wiki 页面。

## 本次变更
{% for change in changes %}
- {{ change.type }}: {{ change.path }}
  {% if change.content %}内容摘要: {{ change.content[:200] }}...{% endif %}
{% endfor %}

## 现有 Wiki 页
{% for page in existing_pages %}
- {{ page.title }}: {{ page.summary[:100] }}...
{% endfor %}

请执行以下操作：
1. 为新增文件创建 Wiki 页，与现有主题重叠则合并
2. 更新受影响的现有 Wiki 页
3. 更新交叉引用链接
4. 更新 _index.md 的相关条目

以 JSON 格式返回：
{
  "pages": [
    {
      "title": "",
      "filename": "",
      "content": ""
    }
  ],
  "update_index": true/false
}
```

---

## 四、数据模型设计

### 4.1 配置模型（扩展 schema.py）

```python
class KnowledgeMode(Enum):
    DOCUMENT = "document"
    NOTEBOOK = "notebook"

class KnowledgeInstanceConfig(Base):
    """单个知识库实例配置."""

    mode: KnowledgeMode = KnowledgeMode.DOCUMENT
    paths: list[str] = Field(default_factory=list)  # 关联的目录路径

    # FTS5 配置（两种模式共用）
    fts5_enabled: bool = True
    fts5_tokenizer: Literal["simple", "porter", "unicode61"] = "unicode61"

    # Document 模式配置
    wiki_enabled: bool = True
    wiki_model_preset: str | None = None
    auto_compile_on_ingest: bool = True
    batch_compile_threshold: int = Field(default=10, ge=1)
    lazy_compile_enabled: bool = True
    diff_ratio_minor: float = Field(default=0.1, ge=0.0, le=1.0)
    diff_ratio_moderate: float = Field(default=0.5, ge=0.0, le=1.0)

    # Notebook 模式配置
    query_max_tokens: int = Field(default=8000, ge=1000)
    query_top_k: int = Field(default=5, ge=1, le=20)

class KnowledgeConfig(Base):
    """本地 AI 知识库配置."""

    knowledge_dir: str = ".knowledge"  # 相对于 workspace
    instances: dict[str, KnowledgeInstanceConfig] = Field(default_factory=dict)

    # 默认实例配置（当 instances 为空时使用）
    default_mode: KnowledgeMode = KnowledgeMode.DOCUMENT

# 在 ToolsConfig 中添加
class ToolsConfig(Base):
    ...
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
```

### 4.2 Meta 数据模型（meta.json）

```python
from datetime import datetime
from enum import Enum

class ChangeType(Enum):
    ADDED = "added"
    MODIFIED = "modified"
    DELETED = "deleted"

class ChangePriority(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

class FileMeta(Base):
    hash: str
    compiled_at: datetime | None = None
    wiki_pages: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)

class PendingChange(Base):
    path: str
    type: ChangeType
    priority: ChangePriority
    old_hash: str | None = None
    new_hash: str | None = None
    detected_at: datetime = Field(default_factory=datetime.utcnow)

class KnowledgeMeta(Base):
    version: int = 1
    mode: KnowledgeMode = KnowledgeMode.DOCUMENT
    files: dict[str, FileMeta] = Field(default_factory=dict)
    pending_changes: list[PendingChange] = Field(default_factory=list)
    last_batch_compile: datetime | None = None
```

### 4.3 FTS5 数据库 Schema

```sql
-- 文档表（两种模式共用）
CREATE TABLE docs (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    hash TEXT NOT NULL,
    content TEXT NOT NULL,
    last_updated TIMESTAMP NOT NULL
);

-- FTS5 虚拟表
-- title 和 content 都参与搜索，提升命中率
CREATE VIRTUAL TABLE docs_fts USING fts5(
    title,
    content,
    content=docs,
    content_rowid=id,
    tokenize='unicode61'
);

-- Triggers 保持 FTS 表同步
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
END;

CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts(docs_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
    INSERT INTO docs_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
```

---

## 五、工具接口设计

### 5.1 kb_ingest - 入库工具

```python
@register_tool
async def kb_ingest(
    paths: list[str] | str | None = None,
    recursive: bool = False,
    exclude: list[str] | None = None,
    instance: str | None = None,
) -> str:
    """将文件/目录添加到知识库.

    Document 模式：入库后自动触发 Wiki 编译。
    Notebook 模式：仅更新 FTS5 索引。

    Args:
        paths: 要添加的文件/目录路径（相对于 workspace），留空则扫描整个 workspace
        recursive: 是否递归扫描子目录
        exclude: 要排除的路径模式列表（glob 语法）
        instance: 知识库实例名，留空则使用默认实例

    Returns:
        操作摘要
    """
```

### 5.2 kb_query - 查询工具

```python
@register_tool
async def kb_query(
    query: str,
    top_k: int | None = None,
    max_tokens: int | None = None,
    instance: str | None = None,
) -> str:
    """查询知识库.

    Document 模式：优先搜索 Wiki 页，FTS5 补充细节。
    Notebook 模式：FTS5 定位笔记路径，读取整篇笔记返回。
    不指定 instance 则搜索所有实例。

    Args:
        query: 查询字符串
        top_k: 返回的最大结果数（默认使用配置值）
        max_tokens: 返回内容的最大 token 预算（默认使用配置值，仅 Notebook 模式生效）
        instance: 知识库实例名，留空则搜索所有实例

    Returns:
        查询结果（格式化文本）
    """
```

### 5.3 kb_status - 状态查看

```python
@register_tool
async def kb_status(
    instance: str | None = None,
) -> str:
    """查看知识库状态.

    Args:
        instance: 知识库实例名，留空则显示所有实例

    Returns:
        状态摘要（模式、文档数、索引大小、pending 变更数等）
    """
```

### 5.4 kb_compile - 手动编译（仅 Document 模式）

```python
@register_tool
async def kb_compile(
    paths: list[str] | None = None,
    all: bool = False,
    instance: str | None = None,
) -> str:
    """手动编译 Wiki（仅 Document 模式可用）.

    Args:
        paths: 指定路径编译，留空则编译 pending_changes
        all: 是否强制全量重新编译（慎用）
        instance: 知识库实例名，留空则使用默认实例

    Returns:
        编译摘要
    """
```

---

## 六、文件结构

### 6.1 新增文件

```
mona/
├── agent/
│   └── tools/
│       └── knowledge.py          # 新增：知识库工具
├── knowledge/                   # 新增：知识库核心模块
│   ├── __init__.py
│   ├── indexer.py               # FTS5 索引管理（两种模式共用）
│   ├── wiki.py                  # Wiki 编译引擎（仅 Document 模式）
│   ├── compiler.py              # 增量编译调度（仅 Document 模式）
│   ├── store.py                 # 存储管理（两种模式共用）
│   └── models.py                # 数据模型
├── config/
│   └── schema.py                # 扩展：KnowledgeConfig
└── templates/
    └── knowledge/               # 新增：编译 Prompt（仅 Document 模式）
        ├── compile.md
        └── update.md

docs/
└── 2026-05-26-local-knowledge-base-design.md  # 本文档
```

### 6.2 .knowledge/ 目录结构

```
workspace/
└── .knowledge/
    ├── project-docs/             # Document 模式实例
    │   ├── index.db              # SQLite + FTS5 数据库
    │   ├── meta.json             # 元数据
    │   └── wiki/
    │       ├── _index.md
    │       ├── _relations.md
    │       └── ... (Wiki 页面)
    └── dev-notes/                # Notebook 模式实例
        ├── index.db              # SQLite + FTS5 数据库
        └── meta.json             # 元数据
```

---

## 七、与现有系统集成

### 7.1 Tool Registry 集成

直接在 `agent/tools/__init__.py` 中注册 knowledge 工具，无需修改 loop.py 或 runner.py，符合 Mona 架构原则。

### 7.2 路径安全校验

复用 `agent/tools/filesystem.py` 的 `_resolve_path` 校验，确保所有操作在 workspace 内。

### 7.3 LLM Provider 集成

Wiki 编译使用 Mona 现有的 LLM Provider 系统，通过 config 配置编译用的 model preset。

### 7.4 笔记功能联动

Notebook 模式可关联到 Mona 现有的笔记功能（`webui/src/components/notes/`），笔记变更时自动触发 FTS5 索引更新。

---

## 八、实现计划

### Phase 1: 基础框架 + FTS5 索引
- [ ] 创建 `knowledge/` 模块骨架
- [ ] 实现数据模型（models.py）和存储管理（store.py）
- [ ] 实现 FTS5 索引管理（indexer.py）
- [ ] 实现 knowledge.py 工具注册和基础接口（kb_ingest, kb_query, kb_status）
- [ ] 实现 Notebook 模式的完整查询流程（FTS5 定位 → 整篇读取 → 预算控制）

### Phase 2: Wiki 编译（Document 模式）
- [ ] 实现 wiki.py 编译引擎
- [ ] 编写编译 Prompt 模板
- [ ] 实现增量编译逻辑（compiler.py）
- [ ] 实现批量编译和懒加载
- [ ] 实现 Document 模式的完整查询流程（Wiki → FTS5 补充）

### Phase 3: 集成与完善
- [ ] 集成 KnowledgeConfig 到 ToolsConfig
- [ ] 笔记功能联动（Notebook 模式自动索引）
- [ ] 测试和优化
- [ ] 文档完善

---

## 九、验收标准

### 功能验收
- [ ] 可以添加文件/目录到知识库
- [ ] 可以选择 Document 或 Notebook 模式
- [ ] Document 模式：FTS5 检索 + Wiki 编译，入库即编译
- [ ] Notebook 模式：FTS5 检索，返回整篇笔记，零 Token 消耗
- [ ] FTS5 检索响应 <10ms
- [ ] 文件变更后 FTS5 立即更新
- [ ] Document 模式 Wiki 按需增量编译
- [ ] Notebook 模式查询有 max_tokens 预算控制

### 性能验收
- [ ] 支持 1000+ 文档入库
- [ ] FTS5 检索延迟 <50ms（p99）
- [ ] Document 模式批量编译 10 个文件 ≤ 3 次 LLM 调用
- [ ] Notebook 模式查询零 LLM 调用

### 安全验收
- [ ] 所有文件操作在 workspace 内
- [ ] 不会暴露敏感文件到 Wiki（配置 exclude）

---

## 十、参考开源项目

| 项目 | 参考点 | 方案落地 | 后续增强 | 链接 |
|------|--------|---------|---------|------|
| **Graphify** | 多子代理并行编译 Wiki | 增量更新策略 → §3.3 | MVP 用单次批量调用；大量文档时引入 Mona subagent 并行编译 | https://github.com/SafirShams/Graphify |
| **LLM Wiki** | Wiki 页面结构、反向链接 | 页面结构 + frontmatter + 反向链接 → §3.4.1 | — | https://github.com/nashsu/llm_wiki |
| **LightRAG** | 双层检索（实体+关系）、知识图谱 | Mermaid 实体关系图 → §3.4.1 `_relations.md` | 在 FTS5 之上加实体索引层，支持语义关联检索 | https://github.com/HKUDS/LightRAG |
| **Khoj** | Agent + 知识库集成、多数据源 | Tool 集成 → §7.1；多实例管理 → §2.3 | — | https://github.com/khoj-ai/khoj |

**未纳入 MVP 的增强方向：**

1. **并行编译**（来自 Graphify）：当单次批量编译文档数 > 20 时，使用 Mona 的 subagent 机制并行编译多个 Wiki 页，降低编译延迟
2. **实体索引**（来自 LightRAG）：在 FTS5 之上增加实体提取和关系索引，支持"查找与 X 相关的所有概念"类语义查询，无需向量数据库
