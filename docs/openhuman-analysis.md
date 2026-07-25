# OpenHuman 深度分析报告：对 Mona 的借鉴意义

> 分析对象：[tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman)（GPL-3.0，early beta，v0.63.x）
> 分析日期：2026-07-25
> 分析视角：与 Mona 的设计思路对比，提炼可借鉴的工程与产品决策
> 注：文中标注"未确认"的条目来自官方文档/仓库元数据推断，未读源码逐行验证。

---

## 1. 项目概览

OpenHuman 是 2026 年 5 月爆火的桌面优先个人 AI 智能体（发布一周约 2.3 万 star，连续多天 GitHub trending #1），定位 "Personal AI super intelligence"——不是聊天机器人，而是"融入日常生活的 AI 分身"。

| 维度 | OpenHuman | Mona |
|------|-----------|------|
| 核心语言 | Rust（`openhuman_core` lib + CLI） | Python（`mona` 包）+ Rust（Tauri 侧） |
| 桌面壳 | Tauri v2（CEF fork，支持子 webview） | Tauri（WebView2） |
| 前端 | React + Redux Toolkit + Socket.io | React（webui） |
| 进程模型 | **单进程**：核心作为 tokio task 跑在 Tauri 宿主内 | 多进程：Tauri 宿主 + Python gateway 子进程 |
| 本地服务 | 单个 `127.0.0.1:<port>/rpc`（JSON-RPC over HTTP） | 双服务：gateway HTTP(17173) + WebSocket(8765) |
| 记忆 | Memory Tree（SQLite + Obsidian vault 双写） | history.jsonl + SOUL/USER/MEMORY.md + Dream |
| 商业模式 | 托管后端经纪模型/OAuth/搜索/TTS（单订阅） | 用户自配 provider key + Pro 订阅（mona-auth） |
| 规模 | ~130 个 domain 目录、2900+ commits、PR 编号 5000+ | 精简核心 + 边缘扩展 |

两者设计思路确实相似：本地优先、桌面原生、UI-first、记忆驱动、工具丰富、渠道多元。但 OpenHuman 在**记忆管线工业化**、**token 经济学**、**发布工程**三个方向上走得更远，这正是本报告的重点。

---

## 2. 架构解析

### 2.1 进程模型：从 sidecar 到 in-process

OpenHuman 曾经也是 sidecar 架构（同 Mona 现在的 Python gateway 子进程），后在 PR #1061 中**移除 sidecar，把核心改为 Tauri 进程内的 tokio task**：

- 核心启动 `http://127.0.0.1:<动态端口>/rpc` JSON-RPC server，每次启动生成随机 bearer token
- 渲染进程直接 `fetch()` 到该端口；URL/token 通过两个 Tauri command（`core_rpc_url`/`core_rpc_token`）一次性下发
- Tauri command `relay_http_rpc` 仅作为 fallback（自托管 LAN 地址被 webview mixed-content 拦截时由 Rust 宿主代发）
- 端口冲突有恢复逻辑（`recover_port_conflict`/`force_quit_port_owner`），`OPENHUMAN_CORE_REUSE_EXISTING=1` 可复用外部核心调试

**对比 Mona**：Mona 的双端口分裂（gateway 17173 走 aiohttp 处理全部 POST；websocket 8765 只能处理 GET，因为 websockets 库的 `process_request` 无法可靠读 POST body）是历史包袱，已在 project_rules 中作为"重要勿搞混"的架构警告存在。OpenHuman 的答案是：**一个服务框架（axum）同时承载 HTTP+WS，就没有"哪个端口支持 POST"的心智负担**。

### 2.2 Agent 引擎：单引擎多入口 + 中间件栈

OpenHuman 所有 agent turn 都走同一个 `tinyagents` crate 的 `AgentHarness`，三个入口（chat turn / channel bus turn / 子 agent）共用同一个组装函数 `run_turn_via_tinyagents_shared`，差异通过适配缝注入。旧的自研引擎已整体删除——**"单引擎多入口"防止三条路径行为漂移**。

横切关注点全部做成中间件，不进循环主体：

| 中间件 | 职责 |
|--------|------|
| `ApprovalSecurityMiddleware` | 审批/安全门 |
| `ArgRecoveryMiddleware` | 幻觉参数修复 |
| `CostBudgetMiddleware` | 每 turn USD 成本上限 |
| `RepeatedToolFailureMiddleware` | 同一工具反复失败熔断 |
| `StopHookMiddleware` | 预算/目标/迭代上限停止钩子 |
| `MessageTrimMiddleware` | 上下文修剪（microcompact/autocompact） |

**KV-cache 契约**：system prompt 只在首轮构建并冻结（含全局+项目两层 AGENTS.md 注入，各上限 ~20k chars），后续 turn 的动态上下文一律以 user 消息追加，绝不动 system prompt——最大化 provider 侧 KV-cache 命中。

### 2.3 工具系统

统一 Tool Registry（native Rust handler + Node helper 混合执行），全部受 `SecurityPolicy` 门控：命令分类 `Read/Write/Network/Install/Destructive`（未识别默认 Write）→ `Allow/Prompt/Block`。工具家族与 Mona 高度重叠（coder/web/cron/voice/memory/子 agent），两个值得注意的点：

- **幻觉工具名恢复**：`RunPolicy::unknown_tool` 捕获模型编造的工具名并引导纠正，而非直接报错中断。
- **`generate_document` 用纯 Rust（docx-rs/ppt-rs）合成字节**，不走 Python 库——对比 Mona 的 docx/pptx skills 依赖 Python 脚本 + 打包运行时。

### 2.4 渠道接入：CEF 子 webview + CDP

消息渠道（Discord/Slack/Telegram/WhatsApp/微信/iMessage）不是 API 对接，而是**每种渠道一个 scanner 模块，通过 CDP 驱动内嵌的 provider webview**，并立下红线：**禁止新增 JS 注入**，新行为一律走 CEF handler / CDP / Rust IPC hook。入站消息统一进 trigger triage（小模型分诊 → drop / notify / spawn reactor / spawn orchestrator）再进 harness。

---

## 3. 记忆系统：OpenHuman 的核心壁垒

这是 OpenHuman 与 Mona 差异最大、也最值得深挖的部分。Mona 的记忆哲学是"quiet system of attention"（Consolidator 压缩会话 → history.jsonl → Dream 精修长期文件），优雅但偏**对话内省**；OpenHuman 的记忆是**工业化数据管线**，目标是"agent 几分钟内获得你全部数据的压缩上下文"。

### 3.1 写路径管线

```
source adapters (chat/email/document)
 → canonicalize（规范化 Markdown + provenance 元数据）
 → chunker（content-addressed 确定性 ID，≤3k token 分段）
 → content_store（原子 .md 落盘）→ store persistence（SQLite）
 → score（信号打分 + embeddings + 实体抽取）
 → source/topic/global 三棵摘要树
 → retrieval（search/drill_down/cover_window/walk）
```

关键工程决策：

1. **热路径零 LLM**：canonicalize → chunk → fast-score → 单事务持久化，全程只用廉价启发式；重活（embeddings、实体抽取、seal 摘要）由后台 worker 池（默认 3 个）执行，UI 不阻塞。
2. **content-addressed chunk ID**：相同输入重复 ingest 天然去重，无幂等负担。
3. **job 队列与 chunk 同库**：job 类型 `extract_chunk/append_buffer/seal/topic_route/digest_daily/flush_stale`；worker 崩溃后 lease 过期的 job 自动重新入队。

### 3.2 打分准入門（Scoring Admission Gate）

`score_chunk` 是纯函数，信号归一化到 [0,1] 加权求和：

| 信号 | 权重 | 说明 |
|------|------|------|
| `interaction` | **3.0** | 最强信号：sent/reply/dm/mention 互动加成 |
| `metadata_weight` / `source_weight` | 1.5 | Email > Document > Chat；per-source 可调 |
| `token_count` / `unique_words` / `entity_density` | 1.0 | 长度平台曲线、词汇多样性、实体密度 |
| `llm_importance` | 0（默认关） | 仅 borderline chunk 启用 |

三段门：**≥0.85 直接收（不调 LLM）、≤0.15 直接弃、中间才调 LLM** 做语义 NER + 重要性评分，终分 ≥0.3 才 admit。dropped chunk 也写 score 行 + `drop_reason`，全程可审计。

**这个设计的精髓：用廉价信号把 80% 的 LLM 判断省掉，同时保留完整审计轨迹。**

### 3.3 三棵层级摘要树

- **Source tree**（每个来源一棵）：新 leaf 进 L0 滚动 buffer，buffer 满则 seal 成 L1 摘要，父 buffer 再满级联上卷 L2…
- **Topic tree**：按实体"hotness"惰性物化——实体出现越频繁，树建得越积极
- **Global tree**：每日一棵全局 digest 节点（UTC 日），随天数累积层级化
- 实体注册表是 Markdown 文件（`entities/<kind>/<canonical_id>.md`，YAML frontmatter：aliases/emails/handles），**vault 是唯一事实来源**；实体图 = `mem_tree_entity_index` 表自连接，无独立图库

### 3.4 SQLite + Obsidian 双写

同一份 chunk 既进 SQLite（`chunks.db`：chunks/scores/summaries/entity_index/jobs）也以原子 `.md` 落 vault（`wiki/summaries|notes|<toolkit>`）。检索走 SQLite（结构化 + embedding BLOB + FTS5，混合检索 70% 向量 + 30% FTS），人读/Obsidian 编辑走 Markdown。用户手改 `wiki/notes/` 会被同一管线重新 ingest——**"人改文件 → agent 记忆更新"回流闭环**。

### 3.5 检索：单一多模式工具

agent 只看到一个 `memory_tree` 工具，`mode` 分发：

- `search_entities`：先把"Alice"解析为 `person:alice` canonical id（**提到人名先调这个**）
- `cover_window`：覆盖时间窗的**最小节点集**（高层摘要一次覆盖整天，避免扇出到全部 leaf）
- `drill_down`：沿 `child_ids` BFS 下钻
- `walk/smart_walk`：**确定性 E2GraphRAG，不调 LLM**——实体共现图按 hop 数路由 local/global
- `fetch_leaves`：按 id 批量取原文（上限 20），用于引用

理念：**agentic retrieval（agent 主动分层探索）而非自动 RAG 注入**。

### 3.6 Auto-fetch：20 分钟同步循环

单一全局 tick 遍历所有活跃连接；每连接有 `sync_state`（cursor、去重集、**每日请求预算**），增量拉取；错误只记日志吞掉，调度器永不 panic，漏一轮下轮自然补。从 60s 改成 20min 的理由：用少量时效性换笔记本的安静。每来源还有 `max_tokens_per_sync`/`max_cost_per_sync_usd`/`sync_depth_days` 预算，防话多来源烧爆额度。

---

## 4. TokenJuice：工具结果的压缩路由器

挂在 agent 工具执行路径上，任何 tool result 到达模型前：分类（JSON/Diff/HTML/Search/Code/Log/PlainText 7 种 ContentKind）→ 路由到专用压缩器 → 永不放大（压缩后变大则透传）→ 有损压缩原文入 CCR 缓存 → 追加 `⟦tj:<hash>⟧` 恢复标记 → 按模型单价折算美元记账。

代表性规则：

- **JSON**：对象数组渲染为紧凑表格；超 40 行留 head+tail+错误行+数值离群点
- **Code**：保签名与 import，深函数体折叠 `{ … N lines … }`（可选 tree-sitter）
- **Log**：~96 条内置规则（git/npm/cargo/docker…），strip-ANSI + 去重 + head/tail
- **Diff**：保变更行与 hunk 头；lockfile hunk 缩成一行
- **HTML**：线性剥离为可读文本（教训：`html2md` 处理 10KB 邮件 HTML 峰值分配 ~894MB，换成了自写线性实现）
- CJK/emoji 按 grapheme 处理，绝不切断字符

**CCR（Compress-Cache-Retrieve）** 是点睛之笔：压缩不是丢信息，原文以 SHA-256 为键入内存层（256 条/64MiB FIFO）+ 可选磁盘层，agent 用只读工具 `tokenjuice_retrieve` 按 hash（可选 byte/line range）取回。规则三层覆盖：内置 → 用户级 → 项目级。

**作用域声明很清醒**：TokenJuice 只压缩会话内工具结果；后台 ingest 管线有自己的 canonicalize，两套互不污染。

---

## 5. 模型路由：任务选模型，不是人选模型

内置 router provider，model 参数支持 `hint:` 前缀（`hint:reasoning/fast/vision/summarize/code/burst`），查**运行时可改的路由表**解析为 `(provider, model)`。agent loop 根据接下来要做的事发出 hint。本地 Ollama 经 OpenAI 兼容端点接入，**健康门控 + 不可达透明回退远端**；轻 hint（classify/sentiment/summarize）优先本地，重 hint（reasoning/coding）留云端；embedder 有完整降级阶梯：Ollama → OpenAI 兼容端点（LM Studio）→ 托管云 → **InertEmbedder（零向量兜底，标记 degraded 以便日后重嵌）**。

---

## 6. 工程实践

### 6.1 发布工程（成熟度远超一般开源项目）

- **双长存分支**：`main`（CI Lite 门）→ maintainer 手动 dispatch promote → `release`（CI Full 门）→ production 永远从 release 切
- **CI 双速道**：ci-lite 按变更区域跑检查 + `vitest related` + **域级 diff coverage ≥80% 门**；ci-full 全量单测 + Rust mock-backend E2E + Playwright web E2E + 三 OS 桌面 E2E 矩阵
- **E2E build-once-then-fanout**：一次编译上传 artifact，shard 下载复用
- **签名/公证全覆盖**：macOS sign+notarize（连 staging 构建也公证）、Windows DigiCert、Tauri updater minisign `.sig`、GitHub release attestation
- **AI 生成 release notes**（带花名标题如 "The Composio Reliability Upgrade"），OpenAI 超时 5 分钟 + `continue-on-error` + `--no-ai` 确定性回退
- **生产发布人工审批门**（GitHub Environment）+ 失败自动清理 draft release 和 tag
- **最低版本门**：`VITE_MINIMUM_SUPPORTED_APP_VERSION` 构建期嵌入，过旧二进制无法完成 OAuth deep link

### 6.2 开发体验

- AGENTS.md 作为仓库级 agent 规则（极其详尽：运行时架构、覆盖门、CEF 禁注入红线），CLAUDE.md 是指向它的 symlink
- `CONTRIBUTING-BEGINNERS.md` 内置**可直接粘贴给 AI coding agent 的引导 prompt**，带新手完成首个 PR
- 文档即代码：`docs:generate`/`docs:check` CI 校验文档与代码漂移
- pre-push hook 跑 `rust:check` + `lint:commands-tokens`
- root package.json 内置一排 agent 工作流快捷脚本（`review`/`work`/`deep-work`/`pr:checklist`）

### 6.3 隐私安全

- 落盘敏感数据 AES-256-GCM 加密，master key 存 **OS keyring**（Keychain / Credential Manager / Secret Service）
- 双路径根：`action_dir`（agent 可读写）vs `workspace_dir`（内部状态，agent 工具禁写，`is_workspace_internal_path` **fail-closed**）
- Approval gate 默认开，**10 分钟 TTL 超时即 Deny**；后台/cron turn 直通
- Privacy Mode 单开关强制 local-only（仅 Ollama/LM Studio 端点）
- 沙箱后端多平台：Windows AppContainer / Linux Landlock / macOS Seatbelt / Docker

---

## 7. Mona 可借鉴清单

按"投入产出比"排序，分四档。原则：**借鉴机制与决策，不照搬架构**——Mona 的"核心精简、边缘扩展、less structure more intelligence"哲学应当坚守，OpenHuman 的 ~130 domain 重架构恰恰是我们不应变成的样子。

### P0：低成本高价值，可直接落地

**1. 工具结果压缩层（Mona 版 TokenJuice）**
Mona 的 email/web/shell/search 工具经常返回大 payload，目前只有会话级 autocompact，缺少**单次工具结果级**压缩。建议：
- 在 tool result 进入消息历史前加一个纯函数压缩器：JSON→紧凑表格、log 去重+head/tail、HTML→线性文本、长输出留 head+tail+错误行
- "永不放大"原则 + CJK grapheme 安全
- CCR 思想：被截断的原文落盘（workspace 下 cache 目录），返回里带引用标记，agent 可用现有文件工具按区间取回——不需要新工具
- 这与 Mona "简单优于框架"兼容：一个 `compress_result(kind, text)` 纯函数即可起步，不需要管线框架

**2. 重复工具失败熔断**
OpenHuman 的 `RepeatedToolFailureMiddleware`：同一工具连续 N 次失败后在 system 层面注入"该工具当前不可用，换路径"提示并短路。Mona 的 IMAP 场景中已有类似痛点（认证错误重试耗尽连接配额的教训），通用化为 loop 边缘的一个 hook，改动小、防烧 token 效果明显。

**3. AI 生成 release notes + 确定性回退**
Mona 发版目前是手工整理。可做一个脚本：`git log` 两个 tag 之间的 conventional commits → LLM 生成带 Highlights 的 notes → 失败回退纯列表。与现有 release skill 结合即可。

**4. KV-cache 契约显式化**
检查 Mona 各入口是否在多轮中复用冻结的 system prompt、动态上下文是否以 user 消息追加。把"system prompt 首轮回合后不可变"写成 design.md 的一条契约，配合 provider 的 prompt caching（Anthropic cache_control）可显著降本。

**5. html2md 教训：审计 Mona 的 HTML→文本路径**
OpenHuman 实测 html2md 对 10KB 邮件 HTML 峰值分配 ~894MB。Mona 邮件 HTML 正文处理（Rust mailparse + Python 侧清洗）应确认用的是线性实现，避免同类内存炸弹。

### P1：中等投入，机制级借鉴

**6. 廉价信号打分准入門（用于 distill/hoard 管线）**
Mona 的 distill collectors（session/tool_call/email/notes）目前对输入数据缺少"值不值得蒸馏"的预判。OpenHuman 的三段门可直接套用：
- 廉价信号（长度、互动标记、来源权重）归一化加权
- ≥阈值直接收、≤阈值直接弃、中间才调 LLM
- drop 也记 `drop_reason` 可审计
预期能省掉大部分 distill LLM 调用，且与用户画像"隐私边界显式"的诉求一致（弃用的数据根本不进管线）。

**7. 实体注册表 + 实体优先检索**
Mona 的人物画像/成长轨迹正在做"AI 眼中的我"，OpenHuman 的实体层是成熟参照：
- 实体落 Markdown（`entities/person/<id>.md`，frontmatter 带 aliases/emails/handles），**文件即事实来源**，人类可读可改——与 Mona 画像"双存储 + 人类可改"的要求完全同构
- 检索先 `search_entities` 把人名解析为 canonical id 再查内容，避免"Alice 是哪个 Alice"的幻觉
- 实体图不需要图库，倒排索引自连接即可

**8. 层级摘要：给 hoard/笔记加 source 树与每日 digest**
Mona 的 history.jsonl 是扁平时间流，hoard 是扁平知识块。OpenHuman 的 L0 buffer → seal → 级联上卷机制适合：
- 邮件场景：每邮箱文件夹一棵 source 树，每日 digest 节点（"今天邮件讲了什么"一键可得）
- 笔记场景：vault 文件夹即 source，周/月摘要上卷
- 检索用 `cover_window`（最小节点集覆盖时间窗）替代全量扇出
热路径零 LLM、后台 worker seal 的调度模式，与 Mona 现有 cron 服务天然契合。

**9. 同步状态机（sync_state）模式**
Mona 的邮件走 IMAP IDLE（推送，优于 OpenHuman 的轮询，不要改），但通讯录 CardDAV/ActiveSync、未来的日历/第三方集成会需要周期同步。借鉴 per-connection `sync_state`（cursor + 去重集 + 每日预算 + per-provider 间隔）+ "错误吞掉、下轮自然补"的调度器设计——比每个集成各写一套重试逻辑干净。

**10. Approval TTL fail-closed**
审批请求挂起超 10 分钟自动 Deny（而非永久挂起），后台/cron turn 直通。Mona 的审批交互可引入 TTL 语义，避免无人值守时 agent 卡死。

### P2：方向性参考，长期再看

**11. 单服务化：终结双端口分裂**
OpenHuman 移除 sidecar、单 `/rpc` 端口的演进验证了 Mona gateway(17173)+websocket(8765) 分裂是技术债。Mona 因 Python 运行时必须独立进程，无法照搬 in-process，但可以：
- 中期：把 websocket channel 的 GET 路由全部并入 aiohttp gateway（aiohttp 同时支持 HTTP+WS），只留一个端口
- 启动时下发"端口+一次性 bearer token"给前端（替代当前固定端口约定），顺带解决端口冲突与局域网嗅探
- 这是架构级改动，需单独 PR，符合"最小变更"原则

**12. workload hint 模型路由形式化**
Mona 已有 model_presets 和 dream.modelOverride 等分散的按场景选模型能力。可收敛为统一的 hint 语义（`reasoning/fast/summarize/vision`）+ 一张运行时可改的路由表，让"任务选模型"成为一等概念。配合国内 provider 的价差（如 qwen 不同档位），降本空间实在。

**13. Mascot 情绪状态机**
OpenHuman 的 mood（idle/thinking/listening/talking/dreaming）+ 每轮结束读 conversation cue（success→happy / uncertainty→confused / failure→concerned）很便宜。Mona 已有 AgentLogo 多状态（welcome 等），把"轮次结果 → 情绪 cue"的映射接上，AI 侧"活人感"立刻提升——这符合 Mona 的产品气质。

### 不建议借鉴

- **~130 domain 的重架构与自研 crate 家族（tinyagents/tinycortex/tinyjuice…）**：与 Mona "核心精简、允许重复、拒绝过早抽象"的红线直接冲突。我们要的是它的机制，不是它的框架。
- **CEF fork + 渠道 CDP scanner**：Mona 渠道走协议/API（IMAP、飞书/企业微信开放平台）更干净，维护成本远低于 webview 扫描器；微信渠道的现状已是特例，不应推广。
- **托管后端经纪模式（Composio 代理 OAuth/token）**：与 Mona "完全自包含、用户自管 key、零额外配置"的红线冲突。Mona 的 Pro 订阅只应做能力门控，不应成为数据必经之地。
- **20 分钟轮询 auto-fetch**：Mona 邮件用 IMAP IDLE 推送已更优，不要为了统一心智退回到轮询。

---

## 8. 总结

OpenHuman 验证了 Mona 产品方向的正确性：本地优先 + 桌面原生 + 记忆驱动 + 全工具链是个人 AI 的确定性形态。它真正领先的三个点——**记忆管线的工业化（打分门/层级树/双写 vault）、token 经济学（结果级压缩 + workload 路由）、发布工程的成熟度（双分支 + 覆盖率门 + 签名公证）**——恰好都是 Mona 当前路线图（画像蒸馏、hoard 知识库、发版流程）的下一站。

建议按 P0 清单先做"工具结果压缩 + 失败熔断 + KV-cache 契约"三个小改，再以"实体注册表 + 打分准入门"反哺画像蒸馏管线。架构层面保持克制：OpenHuman 用 2900 个 commit 走到了 130 个 domain，Mona 应该用更少的代码守住同样的能力。

---

## 附：主要信息来源

- [GitHub 仓库与 README](https://github.com/tinyhumansai/openhuman)
- [GitBook 官方文档](https://tinyhumans.gitbook.io/openhuman/)（architecture / agent-harness / tauri-shell / memory-tree / scoring / retrieval / auto-fetch / token-compression / model-routing / release-policy / privacy-and-security / mascot / meeting-agents / voice）
- [AGENTS.md](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/AGENTS.md)、[CONTRIBUTING.md](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/CONTRIBUTING.md)、[Cargo.toml](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/Cargo.toml)、[package.json](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/package.json)
- CI/Release workflows：ci-lite / ci-full / e2e / build-desktop / release-production
- 未确认事项（chunker 具体切分算法、SQLite 完整 DDL、检索注入侧 token 预算等）已在正文相应处标注，深入落地前建议读对应源码验证。
