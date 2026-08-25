# Mona 学术研究 Agent 详细开发计划

> 文档版本：1.0  
> 状态：待执行  
> 制定日期：2026-08-22  
> 依据：[学术研究 Agent 功能方案](./academic-research-agent-functional-design.md)  
> 交付边界：单 Agent、现有对话窗口、无科研工作台、无默认多 Agent Workflow

## 1. 开发目标

在 Mona 现有 Agent、Skill、工具、会话工作区和 Artifact 能力上增加一个可见的“学术研究员”Agent，并通过真实工具调用和固定验收夹具完整落地以下八项能力：

1. 领域调研、文献检索。
2. 论文阅读、证据提取。
3. 知识地图、多视角研究。
4. 选题、假设、实验设计。
5. 科研数据库和专业工具。
6. 数据分析、代码实验。
7. 自动提出并验证算法想法。
8. 论文、基金、评审回复。

本计划中的“最小”指复用现有架构、减少新组件，不代表删减能力。八项验收任意一项失败，完整功能即未交付。

## 2. 开发纪律

1. **先失败测试，再实现**：每个任务先建立能证明缺口的最小测试，再写实现。
2. **复用现有运行时**：不引入 LangGraph、GPT Researcher、STORM、AI Scientist 或 RD-Agent 作为第二套 Agent 内核。
3. **不新增科研 UI**：不增加 `ShellView`、侧栏模块、科研首页或专用控制面板。
4. **不以 Prompt 代替能力**：学术检索、结构化记录、专业工具、实验指标必须由真实工具或确定性代码支撑。
5. **不伪造完整度**：无全文、无字段、无工具或基线失败时保留缺失状态。
6. **不覆盖原始代码和数据**：算法候选默认在隔离副本运行，获胜补丁只作为 Artifact 交付。
7. **只修改任务文件**：保留工作区已有改动，不格式化、回退或清理无关文件。
8. **阶段退出后再继续**：上一阶段测试和能力验收通过后再进入下一阶段。
9. **不编造工期**：以退出标准和测试证据判断进度，不使用未经测量的开发时长承诺。

## 3. 当前实现基线与已确认结论

| 结论 | 代码依据 | 开发影响 |
|---|---|---|
| 内置工具自动发现 | `mona/agent/tools/loader.py` 使用 `pkgutil` 扫描 | 新增 `academic.py` 后不预设修改 `registry.py` |
| 直属伙伴 Agent 使用 `subagent` 工具范围 | `mona/agent/partner_loop.py` | 三个科研工具必须声明 `_scopes={"core","subagent"}` |
| Agent 工具白名单必须引用已注册工具 | `AgentRegistry._load_manifest` | 先注册工具并通过 loader 测试，再加入 Agent manifest |
| 动态 MCP 工具不能稳定写进静态白名单 | 静态 `tool_allowlist` 与运行时 MCP 注册时序不同 | 使用一个固定 `scientific_tool` 包装科研工具生态 |
| `long_task` 当前未声明 `subagent` 范围 | `mona/agent/tools/long_task.py` | 最小扩展 scope，并增加伙伴 Agent 注册回归测试 |
| Skills 已支持包内路径 | `SkillsLoader`、`AgentRegistry.resolve_skill_dirs` | 四个科研 Skill 直接随 Agent 包交付 |
| 表格工具已支持 CSV/TSV/JSON/JSONL/XLSX | `mona/agent/tools/dataframe.py` | 不增加 pandas 只为基础数据查询 |
| 代码执行、补丁、文件和 Artifact 已存在 | `exec`、`apply_patch`、`deliver_file` | 不开发第二个执行器或实验 UI |
| 会话可绑定工作区 | `set_current_workspace` | 研究记录和实验目录写入当前工作区 |

## 4. 阶段总览

| 阶段 | 目标 | 覆盖能力 | 退出标准 |
|---|---|---|---|
| P0 契约与夹具 | 固定数据模型、验收样本和伙伴长任务能力 | 基础 | 离线夹具可重复，非法证据与实验记录被拒绝 |
| P1 学术检索与记录 | 完成学术源检索、去重、证据账本和任务目录 | 1 的工具基础 | 五类学术源可规范化，记录可恢复且路径安全 |
| P2 证据研究 Agent | 交付 Agent、论文阅读、知识地图和多视角研究 | 1、2、3 | 三项黑盒验收通过 |
| P3 研究设计与专业工具 | 落地选题、假设、实验设计和专业数据库 | 4、5 | 两项黑盒验收通过，至少一次真实专业工具运行 |
| P4 数据与算法实验 | 落地数据分析、代码运行和算法闭环验证 | 6、7 | 实际运行、复现、预算和原项目保护验收通过 |
| P5 科研写作与总验收 | 落地论文、基金、评审回复及端到端交付 | 8、全能力 | 八项能力与高校/医院端到端场景全部通过 |

依赖关系：

```text
P0 → P1 → P2 → P3 → P4 → P5
```

不并行修改 `mona/academic/*`、`mona/agent/tools/academic.py` 或 Agent prompt/Skill；这些文件在相邻任务中共享，顺序完成可以减少冲突和重复返工。

## 5. 预期最终文件结构

```text
mona/
  academic/
    __init__.py
    models.py              # 来源、证据、知识图、实验和交付记录
    providers.py           # OpenAlex/Crossref/Europe PMC/arXiv/ClinicalTrials 适配
    store.py               # 工作区 JSONL/JSON 记录、校验、实验目录
  agent/
    tools/
      academic.py          # academic_search/scientific_tool/research_record
      long_task.py         # 仅补 partner/subagent scope
  agents/
    com.mona.academic-researcher/
      agent.json
      prompt.md
      skills/
        research-evidence/SKILL.md
        research-design/SKILL.md
        research-execution/SKILL.md
        research-writing/SKILL.md
tests/
  fixtures/academic_research/
  tools/test_academic_search.py
  tools/test_scientific_tool.py
  tools/test_research_record.py
  agent/test_academic_researcher.py
  agent/test_academic_research_acceptance.py
```

仅当 PDF 验收失败时增加：

```text
mona/academic/paper_reader.py
pyproject.toml 的 research 可选依赖
tests/tools/test_academic_paper_reader.py
```

## 6. P0：契约、夹具与运行边界

### P0-T1 建立可重复验收夹具

**依赖**：无。

**文件范围**

- `.gitignore`（只放行本功能新增测试与夹具）
- `tests/fixtures/academic_research/README.md`
- `tests/fixtures/academic_research/manifest.json`
- `tests/fixtures/academic_research/providers/**`
- `tests/fixtures/academic_research/papers/**`
- `tests/fixtures/academic_research/data/**`
- `tests/fixtures/academic_research/algorithm/**`
- `tests/fixtures/academic_research/writing/**`

**实现任务**

1. 准备计算机科学、生物医学、非医学自然科学三个检索主题，并记录必须命中的公开文献标识符。
2. 保存 OpenAlex、Crossref、Europe PMC、arXiv、ClinicalTrials.gov 的固定官方响应样本。
3. 论文阅读夹具使用自建文档、公共领域文档或许可允许再分发的开放获取材料；不得把受版权限制的论文随测试提交。
4. 在 PDF 中预埋可确定性检查的研究问题、方法、结果、局限、页码、表格和图表说明。
5. 准备 CSV、JSON、XLSX 三种内容等价的小型数据集和预期查询结果。
6. 准备一个运行时间短、固定随机种子、主指标唯一的小型 Python 算法项目。
7. 准备固定证据账本、论文模板、基金要求和编号审稿意见。
8. `manifest.json` 记录每个夹具来源、许可证、哈希和预期结果。
9. 当前根目录 `/tests/` 被忽略；在 `.gitignore` 中只为 `test_academic_*.py`、`test_academic_research*.py` 和 `tests/fixtures/academic_research/**` 增加逐级例外，不取消其他测试忽略规则。

**最小测试**

- 夹具文件存在且哈希匹配。
- 目标文献标识符、预标注页码、数据预期值和算法基线均可由确定性脚本验证。
- 算法夹具在干净环境中运行成功两次且主指标一致。

**完成定义**

- 离线测试不依赖实时网络或不稳定第三方页面。
- 每个能力至少有一个正向夹具和一个失败夹具。
- `git status --short --untracked-files=all` 能看到全部新增测试和夹具，未依赖 `git add -f`。

### P0-T2 建立科研记录模型

**依赖**：P0-T1。

**文件范围**

- `mona/academic/__init__.py`
- `mona/academic/models.py`
- `tests/tools/test_research_record.py`

**实现任务**

1. 使用项目已有 Pydantic 基类定义并版本化：
   - `SourceRecord`
   - `EvidenceClaim`
   - `KnowledgeNode`
   - `KnowledgeEdge`
   - `ExperimentRun`
   - `DeliverableRecord`
   - `ResearchManifest`
2. `SourceRecord` 保留 DOI、PMID、arXiv ID、NCT ID、URL、provider 和获取时间，不自动补全未知字段。
3. `EvidenceClaim` 强制区分 `fact`、`inference`、`hypothesis`：
   - `fact` 必须有来源和定位。
   - `inference` 必须有来源和依据。
   - `hypothesis` 必须标记待验证。
4. `KnowledgeEdge` 必须引用真实节点和至少一个 `source_id`。
5. `ExperimentRun` 区分 `planned/running/succeeded/failed/rejected/accepted`，成功结果必须有退出码和指标来源。
6. `ResearchManifest` 保存 schema 版本、任务 ID、目标、状态和各 Artifact 相对路径。
7. ID 只允许安全字符或由系统生成；禁止路径分隔符和 `..`。

**最小测试**

- 无来源事实、无依据推断、无定位全文引句被拒绝。
- 合法摘要证据允许 `locator.kind=abstract`。
- 指向不存在节点的知识边被拒绝。
- 缺少命令、退出码或指标来源的成功实验被拒绝。
- 非法 task/run ID 被拒绝。

**完成定义**

- 所有跨能力产物有唯一数据契约。
- 模型校验错误能指出具体字段，不吞掉原始错误。

### P0-T3 允许伙伴 Agent 使用长目标工具

**依赖**：无，可与 P0-T1 顺序执行但不共享文件。

**文件范围**

- `mona/agent/tools/long_task.py`
- `tests/agent/tools/test_long_task.py`
- `tests/agent/test_tool_loader_scopes.py`

**实现任务**

1. 为 `LongTaskTool` 和 `CompleteGoalTool` 增加 `subagent` scope。
2. 不改变 Mona 主 Agent 的现有行为、会话元数据或 UI 展示。
3. 验证工具只有出现在具体 Agent 的 `toolAllowlist` 时才会注册。

**最小测试**

- `scope=subagent` 且 allowlist 包含时，两工具均注册。
- allowlist 不包含时不注册。
- 伙伴直属会话的目标只写入当前会话，不污染其他会话。
- 现有 long task 测试全部通过。

**完成定义**

- 学术研究员可恢复长任务，无需创建房间或 Workflow。

## 7. P1：学术检索与结构化记录

### P1-T1 验证官方学术源契约

**依赖**：P0-T1。

**文件范围**

- 本计划附录 A 的实施记录，或同一 PR 描述中的可审计表格。
- 不先创建第二份来源设计文档。

**实现任务**

实施时只查阅各数据源官方文档，确认并记录：

| 来源 | 必验内容 |
|---|---|
| OpenAlex | API 入口、分页、过滤、引用关系、限流和署名要求 |
| Crossref | DOI 查询、礼貌池要求、User-Agent/mailto 和元数据许可 |
| Europe PMC | 查询语法、PMID/PMCID、全文可用字段和限流 |
| arXiv | Atom 字段、分页、请求间隔和版本语义 |
| ClinicalTrials.gov | API 版本、NCT ID、状态、日期和分页 |

**完成定义**

- 每个来源的正式 API、必要请求头、限流、许可/署名、关键字段和降级规则得到核验。
- 无法确认许可或稳定性的字段不进入实现。

### P1-T2 实现薄 Provider 适配

**依赖**：P0-T2、P1-T1。

**文件范围**

- `mona/academic/providers.py`
- `tests/tools/test_academic_search.py`

**实现任务**

1. 使用已安装的 `httpx`；arXiv Atom 使用已安装的 `defusedxml` 解析。
2. 每个来源只实现功能方案要求的 `search`、`metadata`、`citations` 子集，不开发通用 API 客户端。
3. 设置明确连接/读取超时和可识别 User-Agent。
4. 429、5xx、超时、损坏 JSON/XML 返回带 provider 的结构化错误；不转换成空列表。
5. 响应字段只做类型和格式规范化，不推测缺失作者、日期、摘要或标识符。
6. Europe PMC 用于生物医学文献和 PMID/PMCID；不重复再写一套 NCBI 客户端，除非验收发现关键字段缺失。

**最小测试**

- 五类录制响应均解析为合法 `SourceRecord`。
- 空字段保持 `null`/缺失，不出现模型或代码生成的占位值。
- 429、超时、malformed JSON/XML 可区分。
- 分页游标正确传递，达到请求上限后停止。

**完成定义**

- Provider 是无状态薄函数，没有接口/工厂或缓存框架。
- 所有测试使用官方响应夹具，不依赖实时网络。

### P1-T3 实现来源 ID、去重和合并

**依赖**：P1-T2。

**文件范围**

- `mona/academic/models.py`
- `mona/academic/providers.py`
- `tests/tools/test_academic_search.py`

**实现任务**

1. 标识符优先级：DOI → PMID/PMCID → arXiv ID → NCT ID → 规范化标题+年份哈希。
2. DOI 去除 URL 前缀、空格并统一小写；PMID、arXiv、NCT 做格式校验。
3. 同一来源多版本保留版本信息；预印本与正式发表只有存在明确标识映射时才合并。
4. 合并只补空字段，不用低质量来源覆盖已存在的正式元数据。
5. 保留 `providers` 列表，便于证明同一记录来自哪些源。

**最小测试**

- 同一 DOI 的大小写和 URL 形式合并为一条。
- 同名不同年份论文不错误合并。
- arXiv 版本号不会产生重复论文节点。
- 冲突元数据保留正式源字段并记录 provider。

**完成定义**

- 同一论文不会因多数据源查询在证据计数中重复出现。

### P1-T4 实现 `academic_search` 工具

**依赖**：P1-T3。

**文件范围**

- `mona/agent/tools/academic.py`
- `tests/tools/test_academic_search.py`
- `tests/tools/test_tool_loader.py`

**实现任务**

1. 新增 `AcademicSearchTool`，名称固定为 `academic_search`。
2. 声明 `_scopes={"core","subagent"}`、`read_only=True`。
3. 参数只包含：动作、query/identifier、providers、年份/类型过滤、结果上限和引用方向。
4. 输出 JSON，分开 `records`、`provider_errors`、`query_log`，不只输出 Markdown 文本。
5. 多 provider 查询可使用 `asyncio.gather`，但每个 provider 自己遵守限流；一个失败不取消其他来源。
6. 依赖 ToolLoader 自动发现，不修改 `registry.py`。

**最小测试**

- `search/metadata/citations` 三个动作均通过 schema 校验。
- 工具被 ToolLoader 自动发现，可在 `subagent` scope 按 allowlist 注册。
- 不支持的 provider/action 被参数校验拒绝。
- 一个 provider 失败时仍返回其他结果和失败详情。

**完成定义**

- Agent 不需要知道各来源 HTTP 参数即可完成学术检索。

### P1-T5 实现工作区记录存储

**依赖**：P0-T2。

**文件范围**

- `mona/academic/store.py`
- `mona/agent/tools/academic.py`
- `tests/tools/test_research_record.py`

**实现任务**

1. 新增 `ResearchRecordTool`，名称固定为 `research_record`，声明 `subagent` scope。
2. 最小动作：
   - `init`
   - `status`
   - `source_upsert`
   - `claim_append`
   - `map_write`
   - `experiment_start`
   - `experiment_finish`
   - `deliverable_register`
   - `validate`
   - `export`
3. 所有路径通过当前会话工作区和 `resolve_workspace_path` 解析。
4. 任务目录固定为 `research/<task_id>/`；系统生成或校验 ID，不接受路径文本。
5. manifest/map 等 JSON 使用临时文件加原子替换；JSONL 只追加完整一行并在异常时失败关闭。
6. 重复 `source_upsert` 幂等；重复 claim/run ID 拒绝，避免静默覆盖。
7. `validate` 检查 manifest 引用文件、来源 ID、知识边和实验 Artifact 是否存在。
8. `export` 只生成 Markdown/CSV/JSON 交付文件，不创建数据库或新 UI。

**最小测试**

- 初始化、追加、关闭后重开、状态读取成功。
- 路径穿越、绝对外部路径、非法 task ID 被拒绝。
- 损坏 JSON/JSONL 返回明确错误，不重建为空账本。
- 同一来源 upsert 不重复，冲突 claim ID 不覆盖。
- `validate` 能发现断开的 source ID、知识边和丢失实验文件。

**完成定义**

- 研究过程可在后台恢复和核验，但用户无需进入工作台。

### P1 阶段退出检查

- [ ] P0/P1 相关测试全部通过。
- [ ] 五类学术源固定响应可解析、去重和记录。
- [ ] `academic_search` 与 `research_record` 均能被伙伴 Agent scope 注册。
- [ ] 路径安全和损坏记录测试通过。
- [ ] 未修改 `registry.py`、WebUI 或现有会话模型。

## 8. P2：学术研究员与证据能力 1—3

### P2-T1 创建 Agent manifest 与基础 Prompt

**依赖**：P0-T3、P1 阶段完成。

**文件范围**

- `mona/agents/com.mona.academic-researcher/agent.json`
- `mona/agents/com.mona.academic-researcher/prompt.md`
- `tests/agent/test_academic_researcher.py`
- `tests/agent/test_package_skill_e2e.py`（仅在现有通用测试不能覆盖时最小扩展）

**实现任务**

1. Agent ID 固定为 `com.mona.academic-researcher`，`visibility=partner`、`model=inherit`、`canDelegate=false`。
2. manifest 只允许功能方案列出的必要工具；以实际 ToolLoader 可注册结果为准。
3. Prompt 固定四条核心纪律：
   - 先验证来源再陈述事实。
   - 区分事实、推断、假设。
   - 代码只有实际运行后才能报告结果。
   - 证据/工具不足时明确失败。
4. 长研究任务调用 `long_task`，完成或用户改变目标时调用 `complete_goal`。
5. 不在 Prompt 中复制四个 Skill 全文，只说明何时读取。

**最小测试**

- AgentRegistry 可发现且只显示一个新增 partner Agent。
- manifest 所有工具都能在 `subagent` scope 注册。
- `canDelegate` 为 false，不含 Mona-only 工具。
- 四个 Skill 路径存在且仅对该 Agent 可见。

**完成定义**

- 用户可从现有 Agent 列表创建“学术研究员”直属会话。

### P2-T2 实现 `research-evidence` Skill

**依赖**：P2-T1。

**文件范围**

- `mona/agents/com.mona.academic-researcher/skills/research-evidence/SKILL.md`
- 必要的 `references/`，仅放检索策略和证据字段说明
- `tests/agent/test_academic_researcher.py`

**实现任务**

1. 规定问题范围、检索词、来源选择、去重、全文读取、反证搜索、查漏和综合顺序。
2. 要求每次深度调研写入 `search_log.jsonl`、`sources.jsonl` 和 `claims.jsonl`。
3. 单篇论文提取研究问题、设计、样本/数据、方法、结果、统计口径、结论、局限和复现信息。
4. 全文证据必须保存页码/章节/图表/表格定位；只有摘要时标记 `abstract`。
5. 多视角必须基于真实支持、冲突和方法差异，不生成角色扮演式虚假反方。
6. 普通简短问答不强制创建完整研究目录，只有用户请求调研、论文分析或可交付成果时启动记录。

**最小测试**

- Skill frontmatter、名称、描述和引用路径合法。
- 指令明确要求 `academic_search` 和 `research_record`，不允许模型自造文献。
- 与 Prompt 不存在相互冲突的来源或输出规则。

**完成定义**

- 能力 1、2、3 的执行纪律集中在一个 Skill，不复制到三个 Skill。

### P2-T3 通过论文阅读基线并执行依赖决策门

**依赖**：P2-T2。

**文件范围**

- `tests/agent/test_academic_research_acceptance.py`
- 现有 `mona/skills/pdf/**`，只有确认根因在通用 PDF 解析时才最小修改
- 条件触发时：`mona/academic/paper_reader.py`、`pyproject.toml`

**实现任务**

1. 先用 Mona 现有 PDF Skill 和文件工具运行功能方案 10.2 的固定 PDF 验收。
2. 分别检查正文、页码、表格、图表说明和无法识别时的拒绝行为。
3. 如果全部通过，不新增 PaperQA2。
4. 如果未通过，先定位是文本提取、页码映射还是复杂版式问题：
   - 可在现有 PDF Skill 内小修则直接修。
   - 只有现有能力不能满足时，新增薄 `paper_reader.py` 适配器和 `research` 可选依赖。
5. 若引入 PaperQA2：
   - 固定已测试版本。
   - 不加载外部共享 pickle/索引。
   - 只在当前工作区建立索引。
   - 增加来源、页码和索引安全测试。

**完成定义**

- 论文阅读验收通过；依赖选择由测试结果决定并记录，不凭偏好引入大型依赖。

### P2-T4 实现知识地图交付

**依赖**：P2-T2、P2-T3。

**文件范围**

- `mona/academic/models.py`
- `mona/academic/store.py`
- `research-evidence/SKILL.md`
- `tests/tools/test_research_record.py`
- `tests/agent/test_academic_research_acceptance.py`

**实现任务**

1. `map_write` 接受节点和边，校验引用后写入 `knowledge_map.json`。
2. 同时确定性渲染 `knowledge_map.md`；优先使用 Mermaid 文本，不开发图形 UI。
3. 支持论文、概念、方法、数据集、假设五类节点。
4. 支持 `supports/conflicts/uses/extends/gap` 五类关系。
5. 每条边保留 `source_ids` 和相关 claim ID。
6. 图过大时按主题分区输出多个 Mermaid 块，避免渲染器失效；首版不做交互图。

**最小测试**

- 无来源关系、悬空节点和重复 ID 被拒绝。
- JSON 和 Markdown 节点/边数量一致。
- Markdown 可被现有 Mermaid 预览解析。

**完成定义**

- 用户在对话中收到可预览知识地图文件，无新 UI。

### P2-T5 能力 1—3 黑盒验收

**依赖**：P2-T4。

**文件范围**

- `tests/agent/test_academic_research_acceptance.py`
- `tests/fixtures/academic_research/**`

**实现任务**

1. 使用脚本化/录制模型响应验证 Agent 的工具调用顺序、记录写入和失败行为。
2. 增加可选 live marker：设置 `RUN_LIVE_RESEARCH_ACCEPTANCE=1` 时使用真实模型和真实学术源。
3. 离线 CI 验证确定性契约；发布门禁执行 live 验收并保存 Artifact。
4. 按功能方案 10.1—10.3 逐项生成通过/失败报告。

**完成定义**

- 能力 1、2、3 全部通过；出现一个伪引用或伪引文即阶段失败。

## 9. P3：研究设计与专业工具能力 4—5

### P3-T1 实现 `research-design` Skill

**依赖**：P2 完成。

**文件范围**

- `mona/agents/com.mona.academic-researcher/skills/research-design/SKILL.md`
- 必要的 `references/design-checklist.md`
- `tests/agent/test_academic_researcher.py`
- `tests/agent/test_academic_research_acceptance.py`

**实现任务**

1. 选题前强制相近论文、预印本和注册研究检索。
2. 假设模板包含：证据依据、可证伪陈述、替代解释、确认和否证条件。
3. 实验设计模板包含：变量、对照、样本/数据、终点、评价指标、混杂因素、失败模式和资源风险。
4. 医疗、动物、危险实验和正式统计方案增加伦理与专业审核边界。
5. 缺少真实设备、样本或数据时标记为需求，不写成已经具备。

**最小测试**

- Skill 包含全部强制字段和失败语义。
- 三类夹具输出字段完整，来源和假设类型合法。
- 无相近工作检索记录时，不允许把选题标记为已验证创新。

**完成定义**

- 能力 4 黑盒验收通过。

### P3-T2 验证 ToolUniverse 最小接入路径

**依赖**：P1-T1。

**文件范围**

- `pyproject.toml`（仅在确认依赖后修改）
- `mona/agent/tools/academic.py`
- `tests/tools/test_scientific_tool.py`

**实现任务**

1. 在当前 Windows/Python 3.11 环境验证 ToolUniverse Python SDK 的最小 `discover/inspect/run/status`。
2. 若 SDK 可稳定运行，放入 `research` 可选依赖，并在工具内部延迟导入。
3. 若 SDK 在当前平台不可用，使用 Mona 现有 MCP client 启动 ToolUniverse stdio 服务，但仍由固定 `scientific_tool` 暴露统一四动作；不把动态工具名加入 Agent manifest。
4. 两种路径只选择实际通过验证的一种，不同时维护双实现。
5. 保存被选版本、许可证、启动方式和最小连通性测试结果。

**完成定义**

- 接入路径在目标平台真实运行成功后才进入实现；失败方案不保留半成品代码。

### P3-T3 实现 `scientific_tool`

**依赖**：P3-T2。

**文件范围**

- `mona/agent/tools/academic.py`
- `mona/academic/models.py`
- `tests/tools/test_scientific_tool.py`

**实现任务**

1. 新增 `ScientificTool`，名称固定为 `scientific_tool`，声明 `subagent` scope。
2. 动作固定为 `discover/inspect/run/status`，不增加通用透传动作。
3. `discover` 返回少量匹配工具；`inspect` 返回参数、限制、许可和引用要求；`run` 必须基于 inspect 后的真实参数。
4. 所有运行返回工具 ID、版本、参数、数据来源、开始/结束时间和原始状态。
5. 未安装、未配置、限流、超时、许可证未知分别返回稳定错误码。
6. 外部写入、付费或敏感数据调用沿用 Mona 现有批准边界；首版发布配置优先只读和本地计算工具。

**最小测试**

- 四动作 schema 和状态转换正确。
- 未安装依赖时工具可注册但返回 `unavailable`，不会导致 ToolLoader 导入失败。
- `run` 未经过合法 inspect/参数校验时失败。
- 原始结果关键字段与 Agent 可见结果一致。

**完成定义**

- Agent 可以在不预知工具名的情况下发现并运行一个真实专业工具。

### P3-T4 能力 4—5 黑盒验收

**依赖**：P3-T1、P3-T3。

**文件范围**

- `tests/agent/test_academic_research_acceptance.py`
- `tests/fixtures/academic_research/**`

**实现任务**

1. 分别运行文献缺口、异常现象和方法迁移三个研究设计夹具。
2. 运行学术索引、生物医学数据库和一个确定性科研计算工具夹具。
3. 保存来源、参数、许可/引用、原始返回和总结。
4. 增加专业工具未配置和敏感数据拒绝场景。

**完成定义**

- 能力 4、5 全部通过，至少一次真实 ToolUniverse 或批准的等效工具执行成功。

## 10. P4：数据分析与算法实验能力 6—7

### P4-T1 实现 `research-execution` Skill 的数据分析部分

**依赖**：P3 完成。

**文件范围**

- `mona/agents/com.mona.academic-researcher/skills/research-execution/SKILL.md`
- `tests/agent/test_academic_researcher.py`
- `tests/agent/test_academic_research_acceptance.py`

**实现任务**

1. 规定先检查文件、字段、类型、缺失值和分析目标。
2. 简单表格查询先使用 `dataframe_query`；只有统计、机器学习或领域软件需求才使用 `exec`。
3. 代码生成后必须实际运行并检查退出码、日志和输出文件。
4. 保存数据哈希、代码、命令、依赖版本、参数、随机种子、指标和生成文件。
5. 原始数据只读，所有输出进入 `research/<task_id>/experiments/<run_id>/`。

**完成定义**

- CSV/JSON/XLSX 和 Python 分析夹具可完成真实运行与复现。

### P4-T2 实现实验隔离和输入快照

**依赖**：P1-T5、P4-T1。

**文件范围**

- `mona/academic/store.py`
- `mona/academic/models.py`
- `mona/agent/tools/academic.py`
- `tests/tools/test_research_record.py`

**实现任务**

1. `experiment_start` 创建独立实验目录和 `run.json`。
2. 使用 Python `shutil.copytree` 复制用户指定的最小代码目录；默认忽略 `.git`、`.venv`、`node_modules`、`__pycache__`。
3. 记录输入文件 SHA-256、原路径、隔离路径和开始时间。
4. 首版使用标准库复制，不先实现容器或复杂工作树管理。
5. 对过大目录设置明确文件数/总大小上限并请求用户缩小范围；不静默跳过文件。
6. 禁止实验目录解析到原代码目录或工作区外部。

**最小测试**

- 原始目录哈希在实验结束后不变。
- 忽略目录不被复制，必要源文件完整存在。
- 超过限制、符号链接逃逸和路径穿越被拒绝。
- Windows 路径和文件锁场景通过。

**完成定义**

- 候选算法修改不会直接覆盖用户项目。

### P4-T3 实现确定性指标读取与比较

**依赖**：P4-T2。

**文件范围**

- `mona/academic/store.py`
- `mona/academic/models.py`
- `tests/tools/test_research_record.py`

**实现任务**

1. 自动验证只接受两类指标来源：
   - JSON 文件路径 + key。
   - 已保存 stdout 文件 + 正则表达式捕获组。
2. 记录主指标名称、`maximize/minimize`、基线值、候选值和比较结果。
3. 基线与候选必须使用同一指标契约、数据哈希和评价命令。
4. NaN、Infinity、缺失捕获组、多值歧义和单位变化均判定失败。
5. 不接受模型直接提交一个数值作为“已验证指标”。

**最小测试**

- JSON 和 regex 两类指标可正确读取。
- maximize/minimize 比较正确。
- 指标缺失、非有限数、方向变化和数据哈希变化被拒绝。
- 没有提升时状态为 rejected，不选择最接近成功的候选。

**完成定义**

- “算法改进”只能由实际文件中的同口径指标证明。

### P4-T4 实现算法自动实验循环

**依赖**：P4-T3。

**文件范围**

- `research-execution/SKILL.md`
- `mona/agents/com.mona.academic-researcher/prompt.md`（只增加入口规则，不复制循环）
- `tests/agent/test_academic_research_acceptance.py`

**实现任务**

1. 启动条件必须齐全：代码、固定数据、基线命令、主指标、方向、预算。
2. 先执行基线；基线失败立即停止。
3. 每次只提出一个基于论文、代码或误差分析的候选，避免一次生成大量不可测想法。
4. 在隔离副本应用候选补丁，使用同一评价命令运行。
5. 通过 `research_record.experiment_finish` 从真实日志/指标文件读取结果。
6. 保存候选依据、补丁、日志、指标、状态和决定理由。
7. 严格执行用户指定的迭代/时间/费用预算；缺少预算时使用验收配置的保守固定上限，不无限循环。
8. 最终测试集只在候选选择结束后运行一次，不参与候选生成。
9. 交付获胜补丁；用户未明确要求时不应用回原项目。

**最小测试**

- 基线失败、指标解析失败、预算耗尽、无改进、候选改进五个分支均覆盖。
- 工具调用序列确实包含基线和候选执行，不接受纯文本模拟。
- 原项目在所有分支下保持不变。

**完成定义**

- 能力 7 不是“提出算法建议”，而是完成至少一次真实候选验证。

### P4-T5 能力 6—7 黑盒验收

**依赖**：P4-T4。

**文件范围**

- `tests/agent/test_academic_research_acceptance.py`
- `tests/fixtures/academic_research/data/**`
- `tests/fixtures/academic_research/algorithm/**`

**实现任务**

1. 分别执行 CSV、JSON、XLSX 数据分析。
2. 执行 Python 分析项目并重跑验证关键结果。
3. 使用最多两次候选预算执行算法基线和改进循环。
4. 覆盖“候选提高”和“本轮无改进”两类夹具。
5. 验证所有 Artifact、命令、日志、指标和补丁存在。

**完成定义**

- 能力 6、7 全部通过；未实际运行或原项目被改写即阶段失败。

## 11. P5：科研写作、交付与总验收

### P5-T1 实现 `research-writing` Skill

**依赖**：P2—P4 完成。

**文件范围**

- `mona/agents/com.mona.academic-researcher/skills/research-writing/SKILL.md`
- 必要的 `references/`：论文、基金、评审回复最小字段清单
- `tests/agent/test_academic_researcher.py`

**实现任务**

1. 写作只能把 `sources.jsonl`、`claims.jsonl` 和实验记录作为事实边界。
2. 论文支持：大纲、引言、相关工作、方法、结果、讨论和局限。
3. 基金支持：立项依据、目标、技术路线、创新点、风险、替代方案和摘要。
4. 评审回复逐条映射原评论、决定、修改位置/建议和证据。
5. 不生成不存在的实验、数据、伦理批准、利益冲突或已完成修改。
6. 默认交付 Markdown；用户明确需要 DOCX 时读取并复用现有 docx Skill。

**最小测试**

- Skill 明确引用边界、作者责任和不存在事实拒绝规则。
- 论文、基金、评审回复三类输出字段完整。

**完成定义**

- 写作是证据和实验的下游，不成为新的事实来源。

### P5-T2 实现记录校验和交付导出

**依赖**：P5-T1。

**文件范围**

- `mona/academic/store.py`
- `mona/agent/tools/academic.py`
- `tests/tools/test_research_record.py`
- `tests/tools/test_deliver_file.py`（仅在现有覆盖不足时扩展）

**实现任务**

1. `validate` 在写作前检查：
   - 每个引用 source 存在。
   - 全文事实有定位。
   - 实验结论对应成功 run 和真实指标。
   - 知识边无悬空引用。
2. `export` 生成：
   - `sources.csv`
   - `evidence.md`
   - `knowledge_map.md`（存在时）
   - `experiment_summary.md`（存在时）
   - `research_manifest.json`
3. 最终报告和写作文件登记为 `DeliverableRecord`，通过 `deliver_file` 显示。
4. 中间日志不全部推送成消息卡片，只交付用户需要的成果和审计摘要。

**最小测试**

- 断引用、缺定位和伪成功实验阻止最终导出。
- 导出文件内容和账本条目数量一致。
- 文件卡片可由现有 Artifact/preview 路径解析。

**完成定义**

- 用户只看对话和文件卡片，也能核验研究来源与实验结果。

### P5-T3 能力 8 黑盒验收

**依赖**：P5-T2。

**文件范围**

- `tests/agent/test_academic_research_acceptance.py`
- `tests/fixtures/academic_research/writing/**`

**实现任务**

1. 用固定证据账本生成论文核心章节初稿。
2. 用固定项目要求生成基金初稿。
3. 用编号审稿意见生成逐条回复。
4. 自动比对所有引用和实验声明是否存在于账本。
5. 注入一个不存在的实验/伦理批准诱导，验证 Agent 拒绝写成事实。

**完成定义**

- 能力 8 所有标准通过，虚构研究事实为 0。

### P5-T4 高校端到端验收

**依赖**：P5-T3。

**文件范围**

- `tests/agent/test_academic_research_acceptance.py`
- `tests/fixtures/academic_research/e2e_university/**`

**实现任务**

从同一个“学术研究员”直属会话完成：

```text
研究主题 + 种子论文 + 数据集 + 算法代码
→ 领域调研
→ 论文证据提取
→ 知识地图
→ 选题与假设
→ 数据分析
→ 算法候选验证
→ 论文初稿
```

验证：

- 全程不切换 Agent、不打开专用页面。
- 论文事实链接文献证据，实验结论链接真实 run。
- 无改进时能正确形成负结果讨论。
- 中断后用 manifest 和 long goal 恢复，不重复基线或覆盖已有结果。

### P5-T5 医院端到端验收

**依赖**：P5-T3。

**文件范围**

- `tests/agent/test_academic_research_acceptance.py`
- `tests/fixtures/academic_research/e2e_hospital/**`

**实现任务**

从同一个直属会话完成：

```text
临床科研问题 + 公开论文
→ PubMed/Europe PMC 与 ClinicalTrials 调研
→ 证据与冲突整理
→ 研究缺口
→ 回顾性研究方案
→ 基金初稿
```

验证：

- 来源、试验注册和日期可核验。
- 方案包含人群、纳排、变量、终点、混杂、伦理和隐私。
- 不输出患者个体诊疗建议。
- 不上传或模拟可识别患者数据。
- 基金事实来自证据，拟议内容明确标记为方案。

### P5-T6 全量回归与发布门禁

**依赖**：P5-T4、P5-T5。

**任务**

1. 运行定向测试：

```powershell
python -m pytest tests/tools/test_academic_search.py `
  tests/tools/test_scientific_tool.py `
  tests/tools/test_research_record.py `
  tests/agent/test_academic_researcher.py `
  tests/agent/test_academic_research_acceptance.py
```

2. 运行相关基础回归：

```powershell
python -m pytest tests/tools/test_tool_loader.py `
  tests/agent/test_tool_loader_scopes.py `
  tests/agent/tools/test_long_task.py `
  tests/agent/test_package_skill_e2e.py `
  tests/tools/test_deliver_file.py
```

3. 运行完整 Python 测试和 Ruff：

```powershell
python -m pytest
python -m ruff check mona tests
```

4. 按仓库现有方式执行 Python 构建；若构建工具未安装，先记录缺失，不使用临时命令掩盖。
5. 运行 WebUI 构建，证明未破坏现有应用壳：

```powershell
Set-Location webui
npm run build
```

6. 设置 live marker 运行真实模型、真实学术源和专业工具验收。
7. 生成最终八项能力验收报告，逐项链接测试日志和 Artifact。

**发布门禁**

- [ ] 八项能力全部通过。
- [ ] 高校、医院两个端到端场景通过。
- [ ] 虚构引用和伪引文为 0。
- [ ] 算法验证实际执行基线和至少一个候选。
- [ ] 原始代码和数据未被覆盖。
- [ ] 外部数据源和专业工具真实连通。
- [ ] 许可证、引用和隐私边界通过审查。
- [ ] Python 测试、构建、Ruff 和 WebUI 构建通过。
- [ ] 没有新增科研 `ShellView`、侧栏模块或专用页面。

## 12. 需求—任务—验收追踪矩阵

| 需求 | 主实现任务 | 直接验收 | 端到端验收 |
|---|---|---|---|
| 1. 领域调研、文献检索 | P1-T1～T5、P2-T2 | P2-T5 / 功能方案 10.1 | 高校、医院 |
| 2. 论文阅读、证据提取 | P2-T2、P2-T3 | P2-T5 / 功能方案 10.2 | 高校、医院 |
| 3. 知识地图、多视角研究 | P2-T2、P2-T4 | P2-T5 / 功能方案 10.3 | 高校、医院 |
| 4. 选题、假设、实验设计 | P3-T1 | P3-T4 / 功能方案 10.4 | 高校、医院 |
| 5. 科研数据库和专业工具 | P3-T2、P3-T3 | P3-T4 / 功能方案 10.5 | 医院 |
| 6. 数据分析、代码实验 | P4-T1～T3 | P4-T5 / 功能方案 10.6 | 高校 |
| 7. 自动提出并验证算法想法 | P4-T2～T4 | P4-T5 / 功能方案 10.7 | 高校 |
| 8. 论文、基金、评审回复 | P5-T1～T3 | P5-T3 / 功能方案 10.8 | 高校、医院 |

任何需求若没有“主实现任务 + 直接验收 + 端到端验收”三项证据，不能标记完成。

## 13. 外部项目采用边界

| 项目 | 使用方式 | 不采用内容 |
|---|---|---|
| K-Dense Scientific Agent Skills | 参考和改写检索、实验设计、科研写作方法 | 不整库安装，不默认执行第三方脚本 |
| ToolUniverse | 通过固定 `scientific_tool` 接入已批准工具 | 不把 1000+ 动态工具全部暴露给模型 |
| PaperQA2 | 仅在 P2-T3 PDF 验收失败后作为薄适配器 | 不加载外部共享索引，不接管 Agent 运行时 |
| STORM | 参考多视角和知识整理方式 | 不复制 UI、服务或独立编排框架 |
| GPT Researcher/Open Deep Research | 参考检索与查漏循环 | 不引入 LangGraph 或其服务端 |
| AI Scientist/RD-Agent | 参考基线—候选—指标比较纪律 | 不直接运行其自动科研系统 |

所有第三方代码、Skill、模型、数据库和工具在引入前必须核对许可证、版本、更新状态和安全边界；只参考思想时不得复制受限制代码。

## 14. 风险与决策门

| 风险 | 触发信号 | 处理 |
|---|---|---|
| 学术 API 限流或不稳定 | live 验收持续失败 | 保留 provider 错误，切换到已核验官方替代源；不抓取未授权页面 |
| PDF 复杂版式解析不足 | 固定夹具页码/表格验收失败 | 先修现有 PDF 能力；仍失败才引入 PaperQA2 适配器 |
| ToolUniverse Windows 不兼容 | SDK 最小调用失败 | 只选择经验证的 stdio MCP 路径，不维护双实现 |
| 专业数据库许可不明确 | 官方条款无法确认 | 该工具不进入发布配置，标记 unavailable |
| Agent 上下文过长 | 来源多时丢失早期证据 | 依赖结构化账本和分段读取，不增加第二个 Agent |
| 算法项目过大 | 复制超限或执行超预算 | 要求用户缩小代码/数据范围，不静默抽样或跳过 |
| 研究记录损坏 | JSON/JSONL 校验失败 | 失败关闭并保留损坏文件，不重建为空记录 |
| 医疗敏感数据泄露 | 输入包含可识别信息 | 阻止外部调用，要求脱敏和授权 |

## 15. 每个任务的交付模板

每个任务完成时必须报告：

```text
任务 ID：
修改文件：
新增/改变的行为：
运行的测试：
测试结果：
验收 Artifact：
未验证项：
是否影响原始数据/代码：否/是（说明）
```

不接受只有代码 diff、没有测试结果的交付；也不接受只有模型输出截图、没有来源或实验记录的交付。

## 16. 最终完成定义

- [ ] P0—P5 所有任务完成。
- [ ] 功能方案第 10 节八项能力全部通过。
- [ ] 功能方案第 11 节高校、医院和对话式交付验收通过。
- [ ] `academic_search`、`research_record`、`scientific_tool` 有确定性测试和真实连通性证据。
- [ ] 论文全文证据可定位，找不到全文时真实降级。
- [ ] 数据与算法实验可复现，原项目和原数据保持不变。
- [ ] 论文、基金和评审回复只使用已有证据和实验记录。
- [ ] 安全、隐私、许可证和科研诚信门禁通过。
- [ ] Python 测试、Ruff、构建和 WebUI 构建通过。
- [ ] 用户只使用现有对话、附件和文件卡片即可完成全部能力。

## 附录 A：实施时的数据源核验记录模板

| 来源 | 官方 API | 鉴权 | 限流 | 许可/署名 | 使用字段 | 降级策略 | 核验日期 |
|---|---|---|---|---|---|---|---|
| OpenAlex | 待实施核验 |  |  |  |  |  |  |
| Crossref | 待实施核验 |  |  |  |  |  |  |
| Europe PMC | 待实施核验 |  |  |  |  |  |  |
| arXiv | 待实施核验 |  |  |  |  |  |  |
| ClinicalTrials.gov | 待实施核验 |  |  |  |  |  |  |

该表只填写已从官方文档核验的信息；不使用记忆、二手博客或猜测补齐。
