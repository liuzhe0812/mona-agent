# PPT Master 集成到 Mona 的设计方案（完整 Fork 版）

> **目标：** 完整 Fork `hugohe3/ppt-master` 到 Mona 的 Skill 系统，保持所有原始文件、结构和内容不变，仅做运行环境的最小必要适配。

---

## 1. 设计概述

### 1.1 集成方式

采用 **完整 Fork 方案**：将 PPT Master 的 `skills/ppt-master/` 目录**原封不动**复制到 `mona/skills/ppt-master/`，保持：

- 完整的 SKILL.md（564 行，不做任何删减）
- 完整的 references/ 目录结构
- 完整的 scripts/ 目录结构
- 完整的 templates/ 目录结构
- 完整的 workflows/ 目录结构

### 1.2 为什么完整 Fork 是正确的

PPT Master 是一个**严格串行、上下文依赖极强**的流水线系统：

1. **8 条执行纪律**环环相扣，任何删减都可能导致失败模式重现
2. **角色切换协议**要求完整指令在上下文中，拆分反而增加 read_file 调用
3. **spec_lock 抗漂移机制**依赖完整的 Strategist/Executor 指令
4. Mona 的 `SkillsLoader` 只是读取 SKILL.md 文本丢给 LLM，不解析内容结构，行数无限制

### 1.3 核心设计原则

1. **完整保留**：所有原始文件、目录结构、内容不变
2. **最小适配**：只修改运行环境必须适配的点（路径、命令、配置）
3. **不修改核心逻辑**：不动 `agent/loop.py` 和 `agent/runner.py`
4. **跨平台兼容**：Windows 路径处理、`python` 命令兼容
5. **配置显式**：新增配置项在 `config/schema.py` 中显式声明

---

## 2. 目录结构设计

### 2.1 Skill 目录布局（完整 Fork）

```
mona/skills/ppt-master/
├── SKILL.md                          # 完整原始 SKILL.md（564 行，不做删减）
├── requirements.txt                  # PPT Master 依赖清单（完整）
├── references/
│   ├── canvas-formats.md             # 画布格式参考
│   ├── executor-base.md              # Executor 角色指令
│   ├── image-generator.md            # 图片生成参考
│   ├── image-layout-patterns.md      # 图片版式词表
│   ├── image-searcher.md             # 图片搜索参考
│   ├── shared-standards.md           # SVG 共享标准
│   ├── strategist.md                 # Strategist 角色指令
│   ├── template-architecture.md      # 模板架构
│   └── workflows/                    # 子工作流（保持原结构）
│       ├── create-brand.md
│       ├── create-template.md
│       ├── customize-animations.md
│       ├── live-preview.md
│       ├── resume-execute.md
│       ├── topic-research.md
│       ├── verify-charts.md
│       └── visual-review.md
├── scripts/
│   ├── source_to_md/
│   │   ├── pdf_to_md.py
│   │   ├── doc_to_md.py
│   │   ├── excel_to_md.py
│   │   ├── ppt_to_md.py
│   │   └── web_to_md.py
│   ├── image_backends/               # 图片生成后端实现
│   ├── tts_backends/                 # TTS 后端实现
│   ├── template_import/              # 模板导入辅助
│   ├── svg_finalize/                 # SVG 后处理辅助
│   ├── docs/                         # 脚本文档
│   ├── assets/                       # 静态资源
│   ├── project_manager.py
│   ├── analyze_images.py
│   ├── latex_render.py
│   ├── image_gen.py
│   ├── image_search.py
│   ├── svg_quality_checker.py
│   ├── total_md_split.py
│   ├── finalize_svg.py
│   ├── svg_to_pptx.py
│   ├── update_spec.py
│   ├── notes_to_audio.py
│   ├── animation_config.py
│   ├── pptx_template_import.py
│   └── update_repo.py
├── templates/
│   ├── layouts/
│   │   └── layouts_index.json
│   ├── brands/
│   │   └── brands_index.json
│   ├── charts/
│   │   └── charts_index.json
│   └── icons/                        # 图标库
└── assets/                           # 静态资源
```

### 2.2 与原仓库的对应关系

| 原仓库路径 | Mona Skill 路径 | 处理方式 |
|-----------|----------------|---------|
| `skills/ppt-master/SKILL.md` | `mona/skills/ppt-master/SKILL.md` | **完整复制，仅适配 `${SKILL_DIR}` 和 `python3`** |
| `skills/ppt-master/references/` | `mona/skills/ppt-master/references/` | **完整复制，不做任何修改** |
| `skills/ppt-master/scripts/` | `mona/skills/ppt-master/scripts/` | **完整复制，仅适配路径变量** |
| `skills/ppt-master/templates/` | `mona/skills/ppt-master/templates/` | **完整复制** |
| `skills/ppt-master/workflows/` | `mona/skills/ppt-master/references/workflows/` | **完整复制，保持原结构** |

---

## 3. SKILL.md 适配策略

### 3.1 保留完整内容

SKILL.md **不做任何删减**，564 行完整保留：

- 全局执行纪律（8 条规则）
- 完整的 8 步流水线
- 所有角色指令和切换协议
- 所有脚本索引表
- 所有模板索引表
- 所有子工作流引用

### 3.2 必须做的适配修改

只有以下**最小必要修改**：

#### 1. `${SKILL_DIR}` 变量替换

PPT Master 使用 `${SKILL_DIR}` 指向 skill 安装目录。Mona 没有此变量替换机制，需要替换为实际路径。

**修改方式**：在 SKILL.md 顶部添加路径定义段落：

```markdown
## Mona Environment Setup

When running in Mona, the skill directory is resolved as follows:
- Builtin skill: `<mona-install-dir>/mona/skills/ppt-master/`
- Workspace skill: `<workspace>/skills/ppt-master/`

All `${SKILL_DIR}` references in this document should be resolved to the actual skill directory path.
```

**实际执行时**：agent 通过 `read_file` 或 `exec` 的 `working_dir` 参数定位脚本。

#### 2. `python3` → `python`（Windows 兼容）

根据 Mona 项目规则，Windows 上只有 `python.exe` 没有 `python3.exe`。

**修改方式**：在 SKILL.md 的 Command Notes 部分添加：

```markdown
## Command Notes

All commands use `python3` by default. On Windows (where `python3` may not be available),
use `python` instead. The agent will automatically detect the correct command.
```

**实际执行时**：agent 根据系统检测使用 `python` 或 `python3`。

#### 3. Frontmatter 适配

添加 Mona 兼容的 frontmatter：

```yaml
---
name: ppt-master
description: >
  AI-driven multi-format SVG content generation system. Converts source documents
  (PDF/DOCX/URL/Markdown) into high-quality SVG pages and exports to PPTX through
  multi-role collaboration. Use when user asks to "create PPT", "make presentation",
  "生成PPT", "做PPT", "制作演示文稿", or mentions "ppt-master".
metadata:
  mona:
    emoji: "📊"
    requires:
      bins: ["python"]
---
```

### 3.3 与原 SKILL.md 的差异总结

| 差异点 | 原 PPT Master | Mona Fork 版 | 修改范围 |
|--------|--------------|-------------|---------|
| Frontmatter | 无 `metadata` 字段 | 添加 `metadata.mona` | 仅头部 |
| `${SKILL_DIR}` | 变量替换 | 路径说明段落 | 仅说明 |
| `python3` | 默认命令 | 添加 Windows 兼容说明 | 仅说明 |
| 内容主体 | 564 行 | **完整保留，不做任何删减** | 无修改 |

---

## 4. 依赖管理方案

### 4.1 依赖清单（完整）

完整复制 PPT Master 的 `requirements.txt`：

```txt
# PPT Master Dependencies
# Install: pip install -r requirements.txt

# ── SVG to PPTX ──
python-pptx>=0.6.21

# ── Office compatibility ──
svglib>=1.5.0
reportlab>=4.0.0

# ── PDF to Markdown ──
PyMuPDF>=1.23.0

# ── Document to Markdown ──
mammoth>=1.6.0
markdownify>=0.11.6
ebooklib>=0.18
nbconvert>=7.0.0

# ── Excel to Markdown ──
openpyxl>=3.1.0

# ── Image processing ──
Pillow>=9.0.0
numpy>=1.20.0

# ── Web to Markdown ──
requests>=2.31.0
beautifulsoup4>=4.12.0
curl_cffi>=0.7.0

# ── AI image generation ──
google-genai>=1.0.0

# ── TTS ──
edge-tts>=7.2.8

# ── SVG Editor (live preview) ──
flask>=3.0.0
```

### 4.2 安装方案

**方案：可选依赖组**

在 Mona 的 `pyproject.toml` 中添加：

```toml
[project.optional-dependencies]
ppt-master = [
    "python-pptx>=0.6.21",
    "svglib>=1.5.0",
    "reportlab>=4.0.0",
    "PyMuPDF>=1.23.0",
    "mammoth>=1.6.0",
    "markdownify>=0.11.6",
    "ebooklib>=0.18",
    "nbconvert>=7.0.0",
    "openpyxl>=3.1.0",
    "Pillow>=9.0.0",
    "numpy>=1.20.0",
    "requests>=2.31.0",
    "beautifulsoup4>=4.12.0",
    "curl_cffi>=0.7.0",
    "google-genai>=1.0.0",
    "edge-tts>=7.2.8",
    "flask>=3.0.0",
]
```

安装命令：
```bash
pip install mona[ppt-master]
```

### 4.3 运行时依赖检查

Skill frontmatter 声明 `requires: {bins: ["python"]}`，Mona 自动检查。

Python 包依赖在 SKILL.md 中保留原始的前置检查说明：
```markdown
## Prerequisites

Install dependencies:
```bash
pip install -r skills/ppt-master/requirements.txt
```
```

---

## 5. 配置设计

### 5.1 配置模型

在 `mona/config/schema.py` 的 `ToolsConfig` 中添加：

```python
class PPTMasterConfig(Base):
    """PPT Master skill configuration."""

    enabled: bool = False
    projects_dir: str = "ppt-projects"
    default_format: str = "ppt169"
    # 图片生成：true=复用 Mona generate_image, false=使用 PPT Master image_gen.py
    use_mona_image_gen: bool = True
    # 实时预览
    live_preview: bool = True
    preview_port: int = 5050
```

在 `ToolsConfig` 中注册：

```python
class ToolsConfig(Base):
    # ... existing fields ...
    ppt_master: PPTMasterConfig = Field(default_factory=PPTMasterConfig)
```

### 5.2 配置示例（config.json）

```json
{
  "tools": {
    "pptMaster": {
      "enabled": true,
      "projectsDir": "ppt-projects",
      "defaultFormat": "ppt169",
      "useMonaImageGen": true,
      "livePreview": true,
      "previewPort": 5050
    }
  }
}
```

### 5.3 环境变量

当 `use_mona_image_gen: false` 时，PPT Master 使用 `.env` 文件管理 API Keys：

```bash
# AI Image Generation (only needed when use_mona_image_gen=false)
OPENAI_API_KEY="sk-..."
GEMINI_API_KEY="..."
MINIMAX_API_KEY="..."
IMAGE_BACKEND="openai"

# Image Search
PEXELS_API_KEY="..."
PIXABAY_API_KEY="..."

# TTS
ELEVENLABS_API_KEY="..."
```

**推荐**：保持 `use_mona_image_gen: true`（默认），复用 Mona 已配置的图片生成 provider，无需额外配置 `.env`。

`.env` 文件读取优先级（PPT Master 原始设计）：
1. 当前工作目录
2. Skill 目录
3. 仓库根目录
4. `~/.ppt-master/`

---

## 6. 图片生成方案

### 6.1 默认方案：复用 Mona generate_image

**默认行为是复用 Mona 的 `generate_image` 工具**，理由：

1. 用户已在 Mona 中配置了图片生成 provider（OpenRouter、OpenAI、Gemini 等）和 API Key
2. 不需要为 PPT Master 单独维护 `.env` 文件和 API Key 配置
3. 统一图片生成行为、日志、错误处理和 artifact 管理
4. Mona 的 `generate_image` 已支持多 provider，功能覆盖 PPT Master 的 `image_gen.py`

SKILL.md 中指导 agent 使用 `generate_image`：

```markdown
## Image Generation

When the design spec requires AI-generated images, use Mona's built-in `generate_image` tool:

```
generate_image(
  prompt="[assembled prompt from spec_lock.md rendering + palette + type]",
  aspect_ratio="16:9",
  image_size="1K"
)
```

Save the returned artifact path to the project's `images/` directory and update `image_manifest.json`.
```

### 6.2 回退方案：PPT Master image_gen.py

当 Mona 的 `generate_image` 未启用时，回退到 PPT Master 原生的 `image_gen.py`：

```bash
python skills/ppt-master/scripts/image_gen.py "prompt" --backend openai
```

**配置控制**：`use_mona_image_gen: true`（默认）使用 Mona `generate_image`；`false` 使用 PPT Master `image_gen.py`。

---

## 7. 跨平台兼容设计

### 7.1 Windows 兼容

| 问题 | 解决方案 |
|------|----------|
| `python3` 命令 | SKILL.md 保留 `python3`，agent 自动检测并替换为 `python` |
| 路径分隔符 | PPT Master 脚本已使用 `pathlib.Path`，无需修改 |
| 长路径 | Python 3.6+ 自动处理 |
| 沙箱 | Mona 的 sandbox 在 Windows 上已标记不支持，直接运行 |

### 7.2 路径解析

PPT Master 的 `${SKILL_DIR}` 在 Mona 中通过以下方式解析：

```python
# 在 agent 执行时，通过工具上下文获取 skill 路径
from mona.agent.skills import BUILTIN_SKILLS_DIR

skill_dir = BUILTIN_SKILLS_DIR / "ppt-master"
# 或 workspace skill
skill_dir = Path(workspace) / "skills" / "ppt-master"
```

---

## 8. 安全设计

### 8.1 文件系统边界

- PPT Master 的所有文件操作限制在 `workspace/ppt-projects/` 目录内
- 复用 Mona 的 `_resolve_path` 机制（`filesystem.py`）
- `import-sources --move` 操作的目标路径需通过路径校验

### 8.2 网络请求

- 图片搜索（`image_search.py`）的 HTTP 请求需通过 `validate_url_target`（`security/network.py`）
- 网页抓取（`web_to_md.py`）复用 Mona 的 SSRF 防护

### 8.3 命令执行

- 所有脚本通过 Mona 的 `ExecTool` 执行，继承其安全策略
- `deny_patterns` 和 `allow_patterns` 自动生效

---

## 9. 测试与验证方案

### 9.1 验证清单

| 检查项 | 验证方式 |
|--------|----------|
| Skill 结构合法 | 运行 `quick_validate.py mona/skills/ppt-master/` |
| 文件完整性 | 对比原仓库文件列表，确认无遗漏 |
| 依赖安装完整 | `pip install -r requirements.txt` 成功 |
| 脚本可执行 | 每个脚本 `--help` 正常输出 |
| 端到端流程 | 用示例 Markdown 内容生成一份 PPT |
| 跨平台 | Windows + Linux 各跑一次 |

### 9.2 文件完整性检查

```bash
# 对比原仓库和 Fork 的文件列表
diff <(cd ppt-master/skills/ppt-master && find . -type f | sort) \
     <(cd mona/skills/ppt-master && find . -type f | sort)
```

---

## 10. 实施计划

### Phase 1：完整 Fork（0.5 天）

1. **复制文件**
   ```bash
   # 从 PPT Master 仓库复制
   cp -r ppt-master/skills/ppt-master/* mona/skills/ppt-master/
   ```

2. **适配 Frontmatter**
   - 在 SKILL.md 顶部添加 `metadata.mona` 字段

3. **添加路径说明**
   - 在 SKILL.md 顶部添加 `${SKILL_DIR}` 解析说明段落
   - 添加 `python3` / `python` 兼容说明

### Phase 2：配置集成（0.5 天）

4. **配置模型**
   - 在 `config/schema.py` 添加 `PPTMasterConfig`
   - 在 `ToolsConfig` 中注册

5. **依赖配置**
   - 在 `pyproject.toml` 添加 `[ppt-master]` 可选依赖组

### Phase 3：测试验证（0.5 天）

6. **完整性检查**
   - 对比文件列表确认无遗漏
   - 运行 `quick_validate.py`

7. **功能验证**
   - 安装依赖
   - 执行端到端测试（生成示例 PPT）

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 模型上下文不足 | PPT Master 需要大上下文窗口 | SKILL.md 中明确模型推荐；支持断点续执行 |
| 依赖冲突 | PyMuPDF 等包可能与现有依赖冲突 | 使用可选依赖组，隔离安装 |
| 上游更新 | PPT Master 活跃迭代，需跟进 | 完整 Fork 后 diff 对比，选择性合并 |
| 生成质量不稳定 | 依赖模型能力 | 在 SKILL.md 中明确模型推荐；质量检查步骤强制 |
| Windows 脚本兼容 | 部分脚本可能有 Unix 假设 | 全面测试；使用 pathlib |

---

## 12. 附录

### 12.1 与原仓库的同步策略

完整 Fork 后的同步策略：

1. 将 PPT Master 作为参考仓库跟踪
2. 定期（如每月）检查上游更新
3. 使用 `diff` 对比变更
4. 选择性合并到 Mona 的 Skill 中

**不推荐使用 git submodule**，因为需要维护 Mona 特定的适配修改（frontmatter、路径说明）。

### 12.2 适配修改清单

以下是 Mona Fork 相对于原仓库的所有修改：

| 文件 | 修改内容 | 修改原因 |
|------|---------|---------|
| `SKILL.md` | 添加 `metadata.mona` frontmatter | Mona Skill 系统要求 |
| `SKILL.md` | 添加 `${SKILL_DIR}` 路径说明段落 | Mona 无变量替换机制 |
| `SKILL.md` | 添加 `python3` / `python` 兼容说明 | Windows 兼容 |
| `config/schema.py` | 添加 `PPTMasterConfig` | Mona 配置系统 |
| `pyproject.toml` | 添加 `[ppt-master]` 可选依赖 | Mona 依赖管理 |

**总计：5 处修改，均为必要适配，不涉及任何业务逻辑变更。**

### 12.3 未来扩展方向

1. **MCP Server 封装**：将 PPT Master 脚本封装为 MCP 工具，供外部调用
2. **Web UI 集成**：在 Mona WebUI 中增加 PPT 生成入口和预览
3. **模板市场**：集成 ClawHub，支持用户分享和下载 PPT 模板
4. **批量生成**：支持一次生成多份 PPT（如季度报告系列）
