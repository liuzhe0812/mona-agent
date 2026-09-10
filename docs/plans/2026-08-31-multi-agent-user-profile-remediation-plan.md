# Mona 多 Agent 用户画像收口开发计划

> 制定日期：2026-08-31  
> 状态：七项核心修复已完成；字段级共享控制与多出口 UI 作为后续增强  
> 适用范围：用户画像、Agent Runtime、协作房间、Services API、WebUI

## 1. 目标

在保留现有画像算法、评分和可视化的前提下，解决画像切换到多 Agent 架构后暴露的七类问题：

1. 画像语义上属于用户，物理上却写入 Mona 私有目录。
2. Mona、伙伴直聊、房间/工作流三条运行路径的画像注入不一致。
3. 会话和工具采集不按作者与执行来源归因。
4. 画像 Services API 未使用本地服务令牌保护。
5. 蒸馏、Dream 和人工编辑之间缺少统一写入与并发边界。
6. 前后端日期、热力图和枚举契约存在确定性错误。
7. 缺少画像专项、跨 Agent 隔离与降级路径测试。

交付完成后，画像应满足：一份用户级事实源、按权限向 Agent 投影、Agent 私有记忆继续隔离、同一 Job 固定使用同一画像版本、所有结论可追溯到真实用户信号。

## 2. 不做的事情

- 不为每个 Agent 复制一份完整画像。
- 不把 Mona 的 `MEMORY.md`、完整 `USER.md` 或原始邮件/笔记暴露给伙伴 Agent。
- 不重写现有画像页面、评分算法和图表组件。
- 不引入数据库、消息队列或新的通用权限系统。
- 不让画像自动扩大 Agent 的工具、知识库或脚本权限。

## 3. 目标架构

```text
真实用户信号
  ├─ 用户消息与纠正
  ├─ 用户明确授权的笔记聚合
  └─ 用户明确授权的邮件聚合
          │
          ▼
UserProfileStore（用户级、独立于 Agent）
  ├─ profile.rich.json
  ├─ profile_snapshots/
  ├─ schema/version/source/confidence
  └─ 兼容读取 Mona 旧画像
          │
          ▼
UserProfileSnapshot（只读、字段白名单、固定版本）
  ├─ Mona 回合
  ├─ 伙伴直聊
  └─ 房间 / AgentJob / WorkflowRun

Agent 私有 MEMORY / SOUL / USER / AGENTS 保持隔离，不作为共享画像事实源。
```

### 3.1 数据所有权

| 数据 | 所有者 | 可见范围 | 写入方 |
|---|---|---|---|
| 用户全局画像 | 用户/平台 | 画像页；经授权后的 Agent 快照 | ProfileService、用户纠正入口 |
| Agent 私有 USER/SOUL/MEMORY | 单个 Agent | 当前 Agent | 用户、该 Agent 的受控记忆流程 |
| 房间上下文 | 房间 | 当前房间成员 | 会话与工作流运行时 |
| 原始邮件/笔记 | 用户数据源 | 保持原权限 | 原数据源服务 |

### 3.2 默认共享字段

默认只允许向 Agent 投影低敏感、直接影响协作质量的字段：语言、时区、输出偏好、稳定工作背景、当前关注主题。联系人、邮件主题、痛点详情、原始证据、完整会话文本默认不共享。

每个快照至少包含：

```json
{
  "schema_version": 1,
  "profile_version": "content-hash-or-revision",
  "generated_at": "ISO-8601",
  "allowed_fields": ["preferences", "work_context", "current_focus"],
  "content": {}
}
```

## 4. 分阶段实施

### 阶段 A：修复确定性错误与安全边界

1. `/api/profile` 及子路径纳入现有 `X-Mona-Token` 保护。
2. `daily_distribution` 按真实日期聚合星期，不再把 `YYYY-MM-DD` 当作 `0..6`。
3. 删除“小时分布复制到七天、周末乘 0.4”的伪造热力图。
4. `output_style` 同时兼容历史英文值和当前中文值，内部归一为稳定枚举。
5. 为以上契约增加前后端测试。

退出标准：未授权画像请求返回 401；页面不展示推测出来的星期数据；历史画像仍可打开。

### 阶段 B：修正画像信号归因

1. 会话采集读取 `conversation` metadata、`author_type`、`author_id`、`message_type`。
2. 画像主题只接受真实用户普通消息；排除命令、UI-only、系统注入和内部任务文本。
3. 删除 assistant reasoning 的读取、截断和输出。
4. 工具统计增加 `agent_id`、conversation type、hidden/background、job/workflow 来源维度。
5. 保留兼容聚合字段，但 UI 和提示词不再把 Agent 工具调用称作“用户偏好工具”。

退出标准：同一房间中用户消息只计一次；Agent 内部任务和推理不会进入用户画像；直聊和房间统计口径可解释。

### 阶段 C：建立用户级画像存储

1. 新增独立的用户画像目录帮助函数，不依附 `agents/mona/memory`。
2. `profile.rich.json`、快照和画像运行状态迁移到用户级目录。
3. 首次读取时兼容 Mona 旧目录；迁移使用复制、校验、原子替换和 marker，不删除旧文件。
4. 画像蒸馏不再直接修改任一 Agent 的完整 `USER.md`；历史生成段落迁入画像存储。
5. 增加稳定快照构建函数和内容版本号。

退出标准：卸载/停用任一伙伴不影响画像；清空某个 Agent 私有记忆不会删除用户画像；旧用户无需手工迁移。

### 阶段 D：统一三条运行时注入路径

1. `ContextBuilder` 为 Mona 与伙伴直聊追加授权后的共享画像快照。
2. 命名 Agent 房间/工作流路径恢复加载自己的 `SOUL.md/USER.md/AGENTS.md`，同时追加共享画像快照。
3. AgentJob/WorkflowRun 创建时固定 `profile_version` 和允许字段；运行中画像更新不改变已启动步骤。
4. 快照只作为只读上下文，Agent 无法通过 `memory_edit` 修改全局画像。
5. 保持房间历史投影和 Agent 私有记忆隔离边界不变。

退出标准：Mona、伙伴直聊、直接 `@Agent`、工作流步骤看到相同版本的允许字段；任何路径都读不到其他 Agent 私有文件。

### 阶段 E：统一蒸馏写入与降级契约

1. 将 work-pattern → profile 合并为一个显式顺序管线。
2. 手动、定时入口共享同一异步锁；重复请求合并或返回正在运行状态。
3. 存储采用版本检查与原子替换，避免 read-modify-write 丢失更新。
4. Dream 与画像分工：Dream 只维护 Agent 私有记忆；ProfileService 只维护用户级画像。
5. 无 LLM 降级输出补齐与正常路径一致的 `evidence`、`visualizations` 和快照结构。
6. 轨迹与快照增加保留上限，避免无限增长。

退出标准：并发触发不会丢字段或轨迹；任一步失败都有明确状态；降级页面结构完整。

### 阶段 F：可解释 UI 与回归测试

1. 画像页显示作用域、画像版本、更新时间、来源覆盖与置信度。
2. 增加“共享给 Agent”的字段级控制；默认不共享敏感字段。
3. 行动出口支持交给 Mona、指定 Agent 或指定房间。
4. 增加画像专项后端测试、前端契约测试和跨 Agent 负向测试。

退出标准：用户可以知道画像来自哪里、哪些字段会共享、当前 Agent 使用了哪个版本。

## 5. 任务分工

### Luna：简单且边界明确的任务

| 任务 | 文件边界 | 交付 |
|---|---|---|
| 前端日期/热力图/枚举契约 | `WorkPatternTab.tsx`、`profile-theme.ts`、新前端测试 | 修复确定性显示错误 |
| 采集器作者归因 | 两个 distill collector、新 collector 测试 | 用户消息过滤与 Agent 维度统计 |
| Profile API 鉴权 | `mona/materials/auth.py`、`profile-api.ts`、新鉴权测试 | `/api/profile*` 使用现有本地令牌 |

### 主 Agent：核心架构任务

- 用户级画像目录、迁移和兼容读取。
- `UserProfileSnapshot`、字段白名单和版本固定。
- Mona、伙伴直聊、房间/工作流注入统一。
- 蒸馏锁、顺序管线、版本写入和 Dream 边界。
- 最终集成、冲突处理、回归测试和验收。

## 6. 测试矩阵

| 场景 | 必须验证 |
|---|---|
| Mona 直聊 | 读取允许的共享画像与 Mona 私有记忆 |
| 伙伴直聊 | 读取同版共享画像，只读自己的私有记忆 |
| 房间直接 `@Agent` | 使用 Job 固定画像版本，不能读取其他 Agent 私有数据 |
| Workflow 串行/并行 | 所有步骤使用同一画像版本 |
| 隐藏执行房间 | 内部任务文本不进入用户画像 |
| 旧 session | 无 author metadata 时安全兼容，不把 assistant 当用户 |
| 手动 + 定时并发蒸馏 | 不丢字段、不重复轨迹、不破坏快照 |
| 无 LLM | 返回完整稳定 schema，页面可正常展示 |
| 未授权 HTTP | `/api/profile*` 返回 401 |
| 历史画像迁移 | 新目录可读，旧目录保留，重复启动幂等 |

## 7. 完成定义

以下条件全部满足才算七个问题解决：

1. 画像不再以 Mona 私有目录作为唯一事实源。
2. 三条 Agent 执行路径均使用同一快照协议。
3. 用户信号与 Agent 行为有明确归因，页面不展示伪造统计。
4. 画像读写和触发接口经过本地令牌鉴权。
5. 写入有锁、有版本、可原子恢复，Dream 不再与画像争用同一职责。
6. 前后端数据契约由测试固定。
7. 画像专项、跨 Agent 隔离、迁移、并发和降级测试全部通过。

## 8. 本轮实施结果（2026-08-31）

- 已建立独立用户级画像目录、幂等兼容迁移、原子写入、revision 和保留上限。
- 已新增白名单化 `UserProfileSnapshot`，并统一注入 Mona、伙伴直聊、房间与 Workflow AgentJob。
- WorkflowRun 与 AgentJob 已持久化同一画像快照，保证并行和重启后的版本一致性。
- 会话与工具采集已按作者、会话类型、Agent、Job/Workflow 和后台来源归因；assistant reasoning 不再进入画像采集。
- Agent 工具活动已与用户偏好语义分开，不再参与用户能力雷达和输出偏好推断。
- `/api/profile*` 已纳入本地服务令牌保护，Tauri 原生桥自动附加令牌。
- 两个定时任务已收敛为一个加锁、顺序执行的画像管线；规则降级与正常路径返回同一前端契约。
- 日期、星期、热力图和中英文枚举契约已修复，画像页明确标识为全局用户画像。
- 验证结果：Python 相关回归 244 项通过，前端画像测试 11 项通过，TypeScript 编译通过，Rust `cargo check` 通过，Ruff 与 Python 编译检查通过。
