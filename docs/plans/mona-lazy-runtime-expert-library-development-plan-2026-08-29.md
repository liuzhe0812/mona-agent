# Mona 托管运行时与专家库懒加载开发计划

> 运行时部分已由 2026-08-30 的共享 Agent 环境方案取代；本文保留为开发历史，当前实现以 `docs/design/mona-managed-skill-runtime-design-2026-08-29.md` 为准。

> 文档版本：1.0  
> 状态：执行中  
> 制定日期：2026-08-29  
> 依据：[Mona Skill 托管运行时设计方案](../design/mona-managed-skill-runtime-design-2026-08-29.md)  
> 目标：默认只内置 Mona；Python、Node、专家 Agent、Skill 与重资源按需安装并达到可上线标准

## 1. 交付目标

最终产品必须同时满足：

1. 新安装用户不下载任何扩展运行时也能使用 Mona 基础对话、文件、浏览器和记忆能力。
2. Python、Node 和后续原生组件在首次真实需要时由 Mona 展示大小与权限并按需安装。
3. 全新安装默认 Agent 列表只有 Mona；用户本地自定义专家照常显示，其他官方专家从服务端专家库发现并由七牛静态分发到本地。
4. 选择未安装专家时，Mona 完成包下载、完整性校验、依赖解析、原子安装、健康检查后再创建任务。
5. 已安装专家及运行时离线可用；专家库或七牛不可用不影响 Mona 和本地专家。
6. 专家包升级、卸载和重装不删除会话、记忆、用户设置或私有 Skill。
7. 官方 Skill 共享受控运行时；第三方 Skill 不得修改官方环境。
8. Agent 不得自行选择解释器或执行 pip/npm 修改官方环境。

## 2. 当前基线与改造点

| 当前状态 | 风险 | 改造方向 |
|---|---|---|
| `AgentRegistry` 同时扫描 `mona/agents` 与 `~/.mona/agents` | 程序包与用户数据目录混用 | 新增版本化 `packages/agents` 包仓；保留旧目录兼容读取 |
| Agent ID 已写入会话 metadata | 可作为稳定身份 | 保持 Agent ID 不变，新增包版本快照 |
| 记忆、配置、用户 Skill 位于 `~/.mona/agents/<id>` | 属于用户私有数据 | 永不随包卸载、升级和修复删除 |
| `skill_script_run` 使用 `sys.executable`/系统 PATH | 正式包不能保证脚本运行 | 强制使用 RuntimeManager 返回的绝对解释器路径 |
| Skill 仅检查 `bins`/`env` | 无法解析 Python/npm/原生组件 | 扩展受控 runtime manifest |
| 重依赖写入主 `pyproject.toml` | 安装包持续增大 | 迁移到版本化能力包 |
| 已存在下载、热更新和文件锁能力 | 可复用部分基础设施 | 提取无 UI、无业务耦合的安全下载/原子安装能力 |

## 3. 目标目录

```text
<mona-data>/
├── packages/
│   └── agents/<agent-id>/
│       ├── current.json
│       └── v/<version>/p/
├── runtimes/
│   ├── state.json
│   ├── downloads/
│   ├── python/
│   ├── node/
│   ├── native/
│   └── locks/
└── agents/<agent-id>/
    ├── config.json
    ├── memory/
    └── skills/
```

`packages/` 和 `runtimes/` 是可重建缓存；`agents/` 是用户数据。

## 4. 包与目录契约

### 4.1 专家目录条目

```json
{
  "schemaVersion": 1,
  "id": "com.mona.academic-researcher",
  "displayName": "学者",
  "description": "...",
  "version": "2.1.0",
  "minMonaVersion": "1.6.0",
  "downloadUrl": "https://<qiniu-domain>/agents/...zip",
  "size": 1234567,
  "sha256": "...",
  "runtimePacks": ["python-base@3.12", "scientific@1"],
  "requiredTools": ["academic_search", "skill_script_run"]
}
```

### 4.2 专家包

归档中只有一个与 Agent ID 同名的根目录：

```text
<agent-id>/
├── agent.json
├── prompt.md
├── package-manifest.json
├── skills/
├── licenses/
└── assets/
```

归档禁止绝对路径、`..`、设备文件、符号链接、重复规范化路径和超出限额的文件。

### 4.3 运行时包

运行时包只引用 Mona 受信注册表中的组件 ID；Agent 包不得提交任意 pip/npm URL 或安装命令。

## 5. 阶段与任务

### P0：契约、路径和安全包仓

目标：在不接网络和 UI 的情况下，建立可测试的本地专家包闭环。

任务：

- 新增专家目录/包 manifest 模型与严格校验。
- 新增 `get_agent_packages_dir()` 与运行时目录函数。
- 新增版本化 AgentPackageStore。
- 实现 SHA-256、安全 ZIP 检查和解压限额。
- 实现同 Agent 安装锁、临时目录、原子激活、旧版本保留和回滚。
- `AgentRegistry` 增加已激活包仓来源，优先级低于 Mona、高于 legacy installed Agent。
- 增加包仓损坏、缺失 current、重复 ID、路径逃逸和并发安装测试。

退出标准：

- 本地 fixture 可安装、激活、切换版本、回滚并被 `AgentRegistry` 读取。
- 所有恶意归档 fixture 在写入最终目录前被拒绝。
- 用户私有 Agent 目录在安装/卸载测试后字节不变。

### P1：VPS 专家目录与七牛文件分发

目标：从 Mona VPS 读取专家目录，从七牛下载官方 Agent 文件。

任务：

- VPS `mona-auth` 提供专家与运行组件目录接口，目录文件由官方发布流程维护。
- 新增专家目录客户端、缓存和 ETag/更新时间处理。
- 专家 ZIP 与运行组件支持七牛主域名、备用域名、超时、断点续传和大小上限。
- 下载完成后校验大小和 SHA-256。
- 目录与包同时校验 `minMonaVersion`、平台、架构、requiredTools。
- 实现安装、更新、修复、卸载、失败重试和磁盘空间预检 API。
- 已安装专家在目录不可达时使用本地包和缓存元数据。

退出标准：

- 断网、限流、半包、错误哈希和版本不兼容均有确定状态。
- 下载失败不改变 active version。

### P2：RuntimeManager 与 Python/Node

目标：官方 Skill 不再依赖系统环境或 `sys.executable`。

任务：

- 定义 RuntimePack、组件索引和安装状态模型。
- 实现 Python/Node 发行版下载、版本目录和健康检查。
- 创建一个官方共享 Python venv 和一个官方共享 Node 项目。
- 能力包生成统一锁文件，安装新代并原子切换。
- `skill_script_run` 读取 Skill runtime manifest，固定使用托管绝对路径。
- 注入 `PATH`、`VIRTUAL_ENV`、`PYTHONNOUSERSITE`、pip/npm 私有缓存。
- 禁止官方 Skill 通过 `exec` 调用包内脚本绕过 RuntimeManager。
- 增加 `dependency_required`、`installing`、`integrity_failed` 等结构化状态。

退出标准：

- 无系统 Python/Node 的干净环境可运行官方 Python/Node Skill。
- 第二个 Skill 复用已安装依赖，不重复下载。
- 第三方 Skill 无法修改官方环境。

### P3：Agent/Skill 依赖迁移

目标：把现有显式 Agent 变成可下载专家包。

任务：

- 为所有带脚本 Skill 补 runtime manifest。
- 建立首批官方能力包：`python-base`、`node-base`、`document`、`scientific`。
- 从主依赖移出仅供 Skill 使用的重库。
- 为学者、种草家和股票专家生成 Agent 包与官方目录条目。
- 保持所有现有 Agent ID、package ID 和用户配置迁移映射。
- 会话 metadata 增加可选 package version，不修改旧 schema 的解释结果。

退出标准：

- 旧会话、记忆、用户设置、私有 Skill 与新下载包组合运行。
- 删除内置副本后已有用户首次升级不出现 AgentNotFound。

### P4：专家库与安装 UI

目标：用户可以在新建任务时按需召唤专家。

任务：

- 新建任务入口默认突出 Mona，并提供“召唤专家”入口。
- 召唤面板展示 VPS 上全部官方专家，并始终提供仅保存在本机的“自定义专家”选项。
- 展示已安装、可安装、需更新、不可兼容、离线缓存状态。
- 安装确认展示专家包、运行时包、下载量、磁盘占用和权限。
- 安装中显示分包进度、当前步骤、速度、取消和重试。
- 安装成功后创建任务并自动提交原始消息。
- 安装失败不留下不可用正式任务；保留可重试卡片。
- Agent 设置页显示能力就绪摘要并跳转全局运行组件页。
- 全局运行组件页支持查看、修复、更新、卸载和离线导入。

退出标准：

- 键盘、鼠标、浅色/深色、窗口缩放和重启恢复均通过 UI 验收。

### P5：第三方 Skill 隔离

目标：用户安装 Skill 不污染官方环境。

任务：

- 第三方 Skill 脚本保持默认禁用。
- 为第三方 Python Skill 创建隔离 venv；Node Skill 创建隔离项目。
- 共享下载缓存但不共享可写 site-packages/node_modules。
- 安装脚本、源码构建和原生扩展单独披露并确认。
- 依赖冲突、无平台 wheel、安装失败均返回可解释状态。
- 设置磁盘配额、引用计数和安全清理策略。

退出标准：

- 恶意/冲突第三方 Skill 无法改变官方 runtime hash。

### P6：发布、迁移与上线

目标：默认安装包只包含 Mona，并安全迁移存量用户。

任务：

- 先发布包管理器，再发布云端专家包，最后移除内置专家副本。
- 升级时把存量内置专家登记为已安装或静默迁移到包仓。
- 发布 VPS 专家目录、运行时索引和七牛包文件的 CI/CD。
- 七牛先上传不可变版本 ZIP，VPS 目录文件最后更新。
- 建立回滚目录和服务端下架开关；已安装包不远程删除。
- 更新 NSIS、热更新 manifest、SBOM、第三方 notices 和许可证。
- 完成干净机、升级机、离线机、弱网机和并发任务矩阵。

退出标准：

- 主安装包不包含显式专家和扩展运行时。
- Mona 基础功能在运行时/专家库完全不可达时仍可用。
- 发布、更新和回滚演练均有记录。

## 6. API 设计

当前首版 API：

```text
GET    /api/experts/catalog
POST   /api/experts/install/start?expert_id=<id>&version=<version>
GET    /api/experts/install/status?job_id=<job-id>
POST   /api/experts/install/cancel?job_id=<job-id>
GET    /api/runtimes/status
POST   /api/runtimes/install/start?component=python|node
GET    /api/runtimes/install/status?job_id=<job-id>
POST   /api/runtimes/install/cancel?job_id=<job-id>
```

安装为持久化异步 job，首版按现有视频运行时模式以 650ms polling 展示进度；
后端按专家/组件和目标版本去重，避免双击和重连重复安装。

## 7. 安全不变量

1. 远端 catalog、ZIP 内容和 Agent 文本均为不可信输入。
2. 官方专家下载只读取 Mona 固定目录；用户可创建本地自定义专家，但不能上传到官方专家库，也不能把自定义源混入官方目录。
3. 下载 URL 不能决定本地安装路径。
4. 不执行归档中的安装脚本。
5. 激活前必须完成 manifest、工具、版本、大小、哈希和健康检查。
6. package cache 与用户数据目录不能互相覆盖、移动或递归删除。
7. 只有 Mona 官方发布流程可以写入服务端官方专家库与运行组件仓库；本地自定义专家保存在独立用户目录。
8. 更新失败、进程取消和客户端崩溃后 active version 保持可启动。
9. 日志不记录访问凭据、API key、包内 secret 或用户路径内容。

## 8. 测试矩阵

### 单元测试

- manifest/schema/path 校验。
- catalog 合并、缓存和兼容性判断。
- ZIP 路径逃逸、符号链接、重复路径、压缩炸弹限额。
- 大小/哈希校验失败。
- Runtime dependency resolution、引用计数、冲突和状态机。

### 集成测试

- 本地 HTTP fixture 的断点续传和备用域名。
- 安装中取消、进程中断、磁盘不足、锁竞争和原子回滚。
- AgentRegistry 在 builtin、package store、legacy installed 之间的优先级。
- 安装专家后创建任务、重启恢复和卸载后保留数据。
- Python/Node 无系统环境运行。

### 端到端测试

- 全新安装只使用 Mona。
- 新建任务召唤未安装专家。
- 弱网下载专家与运行时后自动提交原消息。
- 已安装专家离线启动。
- 旧版升级后继续历史专家会话。
- 第三方 Skill 冲突依赖隔离。

## 9. 发布门禁

- Python、前端、Rust、Tauri 和安装器测试全部通过。
- 专家目录与所有官方包大小、SHA-256 验证通过。
- SBOM/许可证检查通过。
- NSIS 安装包、运行时包和专家包大小记录在发布报告。
- 七牛主/备域名在中国大陆网络完成下载 smoke。
- 干净 Windows 机器无系统 Python/Node 的专家任务验收通过。
- 旧版本升级、回滚和断网启动验收通过。

## 10. 当前实现状态（2026-08-29）

已完成：

- P0/P1 核心：版本化专家包仓、安全 ZIP、SHA-256、断点续传、
  多源、SSRF 重定向校验、离线目录缓存、回滚和 Windows 长路径。
- P2 核心：Python/Node 组件目录、共享官方 Python venv 代际、离线
  `--require-hashes` wheelhouse、绝对解释器解析、失败恢复旧环境。
- P4 首版：新建会话中的“召唤专家”、本地自定义专家、设置页 Python/Node 管理、
  后台进度、取消、失败重试、重启恢复、历史专家待重装提示。
- P3 部分：科研、小红书和股神专家源已移出基础包；科研 Skill 已声明固定运行时包；
  股票自动工作流仅保留 7 个真正执行任务的内部角色。
- P6 工具：确定性专家/运行时仓构建、七牛 ZIP 上传、VPS catalog 最后发布。

发布前仍须完成的外部制品步骤：

1. 使用 `scripts/prepare_official_runtimes.py` 生成 Windows x64 Python、Node 和
   `python-academic` 离线组件。
2. 运行 `scripts/build_official_distribution.py` 构建并上传七牛 ZIP，然后执行大陆网络
   smoke；确认包可下载后，再把两个 catalog 文件发布到 VPS。

已完成的真实制品 smoke：

| 组件 | 压缩下载量 | 验证结果 |
|---|---:|---|
| `python-base@3.13.15` | 17.21 MiB | 从完整官方 Windows ZIP 创建 venv 成功 |
| `node-base@22.23.2` | 35.49 MiB | `node --version` 返回 `v22.23.2` |
| `python-academic@1.0.0` | 112.26 MiB | 33 个哈希锁 wheels 离线安装及科学/PDF 导入通过 |

三项均为安装后按需下载，不进入基础 NSIS。科研与小红书专家包的实际压缩大小
分别约 1.0 MiB 与 5.1 MiB。
