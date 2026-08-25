# Mona 学术研究 Agent 最终验收报告

> 验收状态：已实现；ClinicalTrials.gov live 外部阻塞
>
> 验收日期：2026-08-22
>
> 适用范围：单 Agent、现有对话窗口、学术研究工具与科研记录

## 1. 结论

学术研究 Agent 的八项能力均有直接测试、确定性工具测试或 live 验收证据：

1. 领域调研、文献检索
2. 论文阅读、证据提取
3. 知识地图、多视角研究
4. 选题、假设、实验设计
5. 科研数据库和专业工具
6. 数据分析、代码实验
7. 自动提出并验证算法想法
8. 论文、基金、评审回复

默认 academic suite 的记录结果为 **85 passed、13 skipped**；13 个 skipped 均为显式 live 门，不代表失败或被静默跳过。

本报告不把外部服务阻塞美化为通过：ClinicalTrials.gov live 请求返回 HTTP 403，因此医院 ClinicalTrials 端到端验收标记为 `external blocked`。全量 release gate 不标记为通过。

## 2. 验收数据

### 2.1 默认套件

| 项目 | 结果 | 说明 |
|---|---:|---|
| 默认 academic suite | 85 passed | 离线契约、工具、Agent、数据与算法验收 |
| 默认 academic suite | 13 skipped | 13 项均为显式 live 门 |
| 虚构引用/伪引文门 | 通过 | 未以模型输出替代来源证据 |
| 原始代码/数据保护门 | 通过 | 实验使用隔离副本与输入哈希 |

### 2.2 独立 live 验收

| 验收项 | 结果 | 用时/外部状态 |
|---|---:|---:|
| 基础 PDF + 写作 | 2 passed | 137.40s |
| 研究设计 + 基金/评审回复 | 1 passed | 120.99s |
| 算法 live | 1 passed | 183.74s |
| PubChem/UniProt ScientificTool live | 4 passed | 外部工具调用成功 |
| OpenAlex/Crossref/Europe PMC/arXiv academic source live | 4 passed | 4 pass |
| ClinicalTrials.gov academic source live | 403 fail | HTTP 403，外部服务阻塞 |
| WebUI build | pass | 构建成功 |
| pip wheel | pass | wheel 构建成功 |

### 2.3 全量回归限制

全量 `pytest` 首先因被 ignore、未跟踪的 `test_nanobot_facade` 收集错误而不能作为有效通过证据。调整 ignore 后继续运行，约到 30% 时出现大量既有 Memory/Context 等失败，随后测试挂起并中止。

因此：全量 pytest 没有被报告为通过；这些失败与挂起不能被归因于本 Agent，也不能被忽略后当作全量绿灯。

## 3. 八项能力验收证据

| 能力 | 实现证据 | 验收证据 | 结果 |
|---|---|---|---|
| 1. 领域调研、文献检索 | `academic_search`；OpenAlex、Crossref、Europe PMC、arXiv、ClinicalTrials.gov Provider；来源去重与错误保留 | academic source 离线夹具；OpenAlex/Crossref/Europe PMC/arXiv live 4 pass | 通过；ClinicalTrials.gov live 为 external blocked |
| 2. 论文阅读、证据提取 | 现有 `DocumentTool`/PDF Skill；页码标记、证据定位、损坏 PDF 明确失败 | 三个合成 PDF 夹具；正文、页码、表格、图表说明和降级测试；基础 PDF live 2 pass 中包含写作链 | 通过 |
| 3. 知识地图、多视角研究 | `KnowledgeNode`、`KnowledgeEdge`、`map_write`；JSON + Mermaid Markdown；source/claim 可追溯 | 悬空节点/来源/claim 拒绝；JSON/Markdown 数量一致；大图分 Mermaid 块 | 通过 |
| 4. 选题、假设、实验设计 | `research-design` Skill；相近工作检索、可证伪假设、替代解释、变量/对照/终点/风险字段 | 设计 live 1 pass；离线 Skill 契约测试 | 通过 |
| 5. 科研数据库和专业工具 | `scientific_tool` 的 discover/inspect/run/status；固定 ToolUniverse 包装；真实数据源记录 | PubChem/UniProt live 4 pass；未配置工具返回 unavailable | 通过；ClinicalTrials.gov 外部服务阻塞 |
| 6. 数据分析、代码实验 | `DataframeTool` + `ExecTool` + `ResearchRecordStore`；实验命令、退出码、指标、哈希记录 | CSV/JSON/XLSX 均由真实 DataframeTool 得到 4 行、0 缺失、平均 score 0.75；真实 ExecTool 脚本生成 JSON 并重跑一致 | 通过 |
| 7. 自动提出并验证算法想法 | 隔离实验副本、基线/候选指标契约、JSON/regex 真实指标读取、maximize/minimize 比较 | 算法离线与 live 验收；提升与无提升分支；原项目未被覆盖 | 通过 |
| 8. 论文、基金、评审回复 | `research-writing` Skill；事实边界绑定 sources/claims/experiments；禁止虚构实验与伦理事实 | 基础 PDF + 写作 2 pass；设计 + 基金/评审回复 1 pass；写作契约测试 | 通过 |

## 4. 医院场景边界

医院科研流程的公开论文、Europe PMC 证据、研究缺口、回顾性方案字段和基金/评审写作能力已有验收路径。ClinicalTrials.gov 的 live 调研请求返回 HTTP 403，导致依赖该外部注册库实时连通性的医院端到端场景标记为：

```text
external blocked: ClinicalTrials.gov HTTP 403
```

这不表示临床研究 Agent 可以绕过该限制，也不表示医院端到端全量通过。未获取注册信息时，Agent 必须保留来源错误并报告缺口，不得把 403 转写成“没有相关试验”。

## 5. 核心交付文件

### 5.1 运行时代码

- `mona/academic/__init__.py`
- `mona/academic/models.py`
- `mona/academic/providers.py`
- `mona/academic/scientific.py`
- `mona/academic/store.py`
- `mona/agent/tools/academic.py`
- `mona/agents/com.mona.academic-researcher/agent.json`
- `mona/agents/com.mona.academic-researcher/prompt.md`
- `mona/agents/com.mona.academic-researcher/skills/research-evidence/SKILL.md`
- `mona/agents/com.mona.academic-researcher/skills/research-design/SKILL.md`
- `mona/agents/com.mona.academic-researcher/skills/research-execution/SKILL.md`
- `mona/agents/com.mona.academic-researcher/skills/research-writing/SKILL.md`

### 5.2 测试与夹具

- `tests/tools/test_academic_search.py`
- `tests/tools/test_scientific_backend.py`
- `tests/tools/test_scientific_tool.py`
- `tests/tools/test_research_record.py`
- `tests/agent/test_academic_researcher.py`
- `tests/agent/test_academic_research_acceptance.py`
- `tests/agent/test_academic_data_acceptance.py`
- `tests/agent/test_academic_algorithm_acceptance.py`
- `tests/agent/test_academic_algorithm_live_acceptance.py`
- `tests/agent/test_academic_live_acceptance.py`
- `tests/agent/test_tool_loader_scopes.py`
- `tests/agent/tools/test_long_task.py`
- `tests/fixtures/academic_research/**`

夹具包含合成 PDF、CSV/JSON/XLSX 等价数据、算法正负样例、Provider 录制响应、写作证据账本和失败样例；不包含受版权限制的论文正文。

## 6. 发布判断

当前判断为：

```text
academic agent implementation: accepted by direct/tool/live evidence
ClinicalTrials.gov live: externally blocked by HTTP 403
full release gate: not passed
```

在 ClinicalTrials.gov 官方接口恢复可访问、或配置经授权且可审计的等效公开注册源后，需重新执行医院 ClinicalTrials 端到端验收，并重新评估全量 release gate。报告不对当前外部阻塞作推测性修复或数据补写。
