# SSH 会话内 Docker 管理方案

- 日期：2026-09-12
- 状态：功能代码及正确性收口已实现；真实 SSH/Docker 与 macOS 冒烟验收待执行
- 修订：按范围评审收敛为五类功能；额外能力与测试边界见第 9 节
- 开发计划：[SSH Docker 开发计划](../plans/2026-09-12-ssh-docker-management-plan.md)
- 依据：当前工作树（HEAD `fe437876`，包含其他任务的未提交修改）与本次核对的官方资料

## 1. 产品决定

在 Mona 终端页面，为当前 SSH 会话打开一个“Docker · 主机名”标签。复用该会话的连接、认证、主机指纹校验和运维记录，管理这台远程 Linux 主机上的 Docker。一个 SSH 会话最多对应一个 Docker 管理标签。

开发建立在 Mona 现有 React/Tauri/SSH 能力上。Hexhub 只作为基础容器表格的交互参考；Dockge 提供 Compose 文件与项目运维流程参考；Portainer 提供资源详情与操作影响的检查清单。不移植其应用框架、登录系统或独立服务。

首版完成五类能力：运行时探测、容器运行面板、安全操作、Compose 项目管理、日常运维。分阶段交付不等于削减最终范围，全部首版验收项通过才算 V1 完成。

截至 2026-09-12，Windows 开发环境中的 Rust/TypeScript 实现、定向测试和 Tauri 前端构建已完成。正确性收口已覆盖按 Compose 动作复检、真实检查步骤、在途取消、重连代次保护、复杂配置只读和隐藏标签停流。当前机器未安装 Docker，且本次没有获准使用生产主机做破坏性测试，因此本文仍以隔离远程主机的真实验收作为发布门槛。

## 2. 范围与前提

| 项目 | V1 决定 |
|---|---|
| 桌面客户端 | Windows/macOS 上的 Mona，经 SSH 连接远程 Linux；主平台完整验收，另一平台冒烟验证 |
| 管理对象 | 当前 SSH 主机的本地 Docker Engine；支持 Docker Compose v2 |
| 多会话 | 不同 SSH 会话可各自打开管理标签；不提供跨主机聚合、批量发布 |
| 本机 Docker | 本版不接入 Windows/macOS 本机 Docker Desktop |
| Podman | 探测并明确提示；本版不承诺 Podman 操作或 Compose 兼容性，不自动回退执行 |
| 远程权限 | 支持当前用户直接访问 Docker，以及明确选择的非交互 `sudo -n` 模式 |
| 密码 sudo | 本版遇到需密码或必须分配 TTY 时返回权限状态；不收集密码，不假定终端中的 sudo 缓存可用于独立通道 |
| 安装 | 主机已有 Docker/Compose；缺失时给出原因与人工配置入口，不自动安装或修改权限 |
| 首版项目来源 | 已部署项目、用户明确选定的远程 Compose 文件；不做应用商店、从零建站向导 |
| Compose 编辑范围 | 单个 Compose 文件及同目录已有 `.env`；build、env_file、多文件、profiles、include/extends 等复杂项目仅查看状态和日志，配置管理留在终端 |
| 发布方式 | 单项目拉取、重建、启动、复检；不承诺零停机或自动数据回滚 |

Docker CLI 可能被远程 `DOCKER_HOST`、`DOCKER_CONTEXT` 或默认 context 指向另一台机器。探测后必须绑定当前主机的 Unix socket 与引擎身份（含 rootless socket 的明确选择），每次操作显式使用此目标；发现 TCP/SSH context 时提示不在本版范围，不跟随默认设置操作别的主机。重连、权限模式切换或引擎身份改变后重新探测并使旧审批失效。

不新增远程常驻 Agent、Docker TCP 监听或本地 Docker SDK/CLI 下载依赖。后续确需下载本机工具时遵循 [运行时组件管理](../architecture/runtime-component-management.md)。

## 3. 当前代码与复用边界

以下是本次只读核查结果，不把工具描述中的能力等同于 Docker 模块已实现。

| 当前入口 | 已有能力 | 本次开发需要补齐 |
|---|---|---|
| `webui/src/components/terminal/TerminalView.tsx` | 按会话类型切换终端、文件、桌面等视图 | Docker 派生标签路由、父会话解析 |
| `SessionTabBar.tsx`、`Toolbar.tsx` | 会话菜单、打开和关闭入口 | Docker 入口、去重、批量关闭与父子生命周期 |
| `types/terminal.ts`、`store/terminalStore.ts` | 会话列表与当前选中会话 | 明确 Docker 标签 ID 与父 SSH session ID 的区别 |
| `src-tauri/src/terminal/ssh/client.rs` | SSH、独立命令执行、结构化执行、SFTP | Docker 流输出限额、订阅管理、专用容器 PTY |
| `src-tauri/src/terminal/maintenance.rs` | 持久任务、步骤、状态、完成复检规则 | Docker 操作元数据与语义复检接入 |
| `src-tauri/src/terminal/maintenance_cmds.rs` | 步骤执行、取消、超时、风险与计划审批 | Docker 类型化操作入口、业务风险与输出路由 |
| `src-tauri/src/terminal/approval.rs` | 现有命令审批机制 | 绑定精确资源与配置快照的 Docker 审批 |
| `src-tauri/src/ipc_bridge.rs`、`mona/agent/tools/terminal.py` | AI 调用终端维护链路 | 本期不新增 Docker 专用 AI 接口，保留原终端能力 |

当前 `SessionTabBar` 关闭 SSH 标签会触发断连；不能直接将 Docker 标签当成第二个 SSH 连接。现有结构化维护执行还会把输出回显到终端，Docker 日志订阅需要独立事件，不占用用户正在输入的 shell。

另有三个必须补齐的真实缺口：SSH Shell 的读取循环结束目前只输出关闭文本，未同步更新 SessionManager，需区分 Shell 退出与整个传输断连并发布权威状态；结构化执行的分块回调尚未标识 stdout/stderr 且无输出上限；现有通用危险规则与内存审批未绑定 Docker 资源、引擎和配置版本。这些补充限于 Docker 使用到的执行和生命周期边界。

开发遵循 [工程边界](../architecture/engineering-boundaries.md)、[模块不变量](../architecture/module-invariants.md)、[进程所有权](../architecture/services-split-design.md) 和 [UI 规范](mona-ui-design-system.md)。上述长期文档在实际实现验收后再按真实新增不变量更新。

## 4. 标签与界面

### 4.1 打开与关闭

- 在已连接 SSH 标签的右键菜单与终端工具栏提供“Docker 管理”。本地、SFTP、VNC、批量会话不提供此入口。
- Docker 是同一终端标签栏中的派生工具页，建议前端增加 `type: docker`、`parentSessionId`；它没有独立连接配置，也不注册为 Rust SSH session。
- 打开时按父 SSH session ID 去重，重复点击只激活。标题显示主机名，顶部始终显示主机、用户、引擎与权限模式。
- Docker IPC、状态栏使用解析后的父 SSH ID，不允许将 Docker 标签 ID 传给 SSH 执行器；父会话无效时明确失败，不回退到“第一个在线会话”。Docker 页不挂载独立 AI 面板，用户可返回父终端使用原有 AI。
- 关闭 Docker 页只结束其日志、事件与 PTY 订阅；有限时运维任务由后端持有并继续可查询，重新打开可查看结果。
- Docker 页切到后台时停止轮询、实时日志和 Compose 事件订阅；切回后重新读取，已经开始的有限时操作继续完成。
- SSH 意外断开时保留 Docker 页与带时间戳的旧快照，禁用操作。重连到同一受信任主机后重新探测、刷新；不重放未确认的写操作。
- 用户主动关闭父 SSH 标签时，提示正在运行的维护任务影响，关闭关联 Docker 页并释放通道；批量关闭同样遵循父子规则。
- 应用退出后不自动重连、执行任务或恢复敏感编辑内容；未结束任务按已有中断机制落状态。

### 4.2 信息组织

采用专业工具页面布局。顶部为主机状态与操作，主体为“容器 / Compose 项目 / 镜像与空间”三个分区；资源选中后展示详情，底部显示当前操作进度。网络、卷先在详情和空间页查看，不增加完整 CRUD 页面。

| 分区 | 默认信息 | 深入查看 |
|---|---|---|
| 容器 | 名称、项目、状态、健康、CPU、内存、端口 | 日志、详情、脱敏 Inspect、挂载、网络、环境变量名称与数量 |
| Compose 项目 | 项目名、服务状态、配置是否可用、更新状态 | 服务列表、文件编辑、影响预览、事件、执行过程 |
| 镜像与空间 | 引用、digest、容器引用数、占用、更新检查 | 容器/镜像/卷占用排行、候选清理明细 |

表格使用共享 Table、Tabs、Dialog、Button、Tooltip 和语义 Token。支持浅深色、键盘焦点、加载/空/错误/过期状态以及 1440×900、1280×720、1024×720。此文定义交互，不交付原型图；后续若制作原型，按项目要求使用图像生成。

## 5. 功能要求

### F1：主机与运行时探测

检测远程 OS、Docker CLI/Server 版本、引擎 ID、socket、Compose v2、Podman 存在性、可用权限、文件读写能力和可用磁盘。区分未安装、服务未启动、权限不足、仅 Podman、Compose 缺失、连接断开和不支持的输出格式。

读取容器总数、运行数、退出数、异常数；正常退出的一次性任务不能直接算异常。缺少 Compose 仅禁用项目管理，仍可使用独立容器面板。

功能根据实际探测启用，不仅比较版本号。M0 记录一个主测试环境的精确版本并验证基础读取；Compose、事件、可选 `--wait` 与 Buildx 在各自实施阶段验证。只声明已验证的支持范围，不为历史版本兼容建立前置矩阵。

### F2：容器运行面板

- 支持全部/运行/退出/异常筛选、名称与项目搜索，显示读取时间。
- 状态来自结构化 State/Health；采集退出码、OOM 标记、重启次数、健康检查失败摘要，辅助定位失败原因。
- CPU、内存、网络和块 I/O 来自 stats；停止容器或不支持指标显示不可用，不填零。区分瞬时值与累计量。
- 展示端口映射、挂载源/目标/只读属性、网络、镜像引用与 digest、重启策略和资源限制。
- Inspect 为明确标注的脱敏视图，环境变量默认只显示名称、数量，值全部屏蔽；配置和标签中的潜在凭据同样处理。
- 最近日志支持 tail、时间范围、时间戳、搜索和暂停滚动；实时日志增量接收并有界缓存。暂停滚动与停止订阅是不同动作。
- “进入容器”使用当前 SSH 连接上的独立 PTY，先检测 bash/sh；无 shell 镜像给出可理解原因，不安装 shell。

### F3：安全操作与结果

支持独立容器启动、停止、重启、删除与终端进入。删除运行容器必须先明确停止，不默认强删。Compose 管理容器显示所属项目，配置和镜像更新走项目流程，避免只改容器而丢失声明配置。

每项变更遵循“检查目标 → 展示影响/必要确认 → 执行 → 复检”。返回命令退出码、耗时、错误类别与业务复检结果；“退出码 0”不等于服务健康。已有维护任务占用同一 SSH 会话时，提示任务正在执行，避免开启第二个冲突变更。

简单启停由后端自动完成最小执行与复检，用户只操作按钮和必要确认，无须创建或批准一份多步骤计划。复用已有执行器、审批、任务存储和完成门控，不另建通用工作流系统。AI 原有维护规则保持不变。

| 操作 | 交互与后端规则 |
|---|---|
| 读取、日志、事件、更新检查 | 不改变部署；有并发与流量上限 |
| 启动、pull | 显示明确目标与进度，遵循现有维护审批策略 |
| 停止、重启、重建、up 配置变更 | 显示受影响服务与可能中断，确认后执行 |
| 删除容器、down、删除镜像/卷 | 精确对象确认；卷额外说明不可恢复的数据影响 |
| 容器终端 | 显示所属主机/容器，沿用终端的人机执行与审批边界；不能作为 AI 绕过维护执行器的入口 |

审批必须由后端绑定 session、连接代次、引擎、动作、资源 ID、配置版本和影响范围。前端 `confirmed: true` 不能替代审批。操作参数或资源状态变化须重新检查，不能仅按字符串风险黑名单判断 Docker 行为。

### F4：Compose 项目管理

**发现与关联。** 使用 `compose ls --all --format json` 与容器 Compose labels 关联项目。它们不能发现所有磁盘上的未部署文件，也不能可靠恢复原始调用参数。提供“关联远程 Compose 文件”，由用户选择允许目录中的一个文件，确认项目名与工作目录，沿用同目录已有 `.env`；不得递归扫描整台主机。项目无容器后仍可通过已关联文件进入。

项目身份包括当前目标、项目名、规范化工作目录与单个配置文件。labels 中的路径是不可信候选，需验证存在、权限和目录范围；无法还原时只允许看容器与日志。需要多个 `-f`、profiles、自定义插值 env 文件、include/extends 的项目明确显示“暂不支持配置管理”，不丢弃这些参数后尝试部署。

**文件编辑。** 编辑单个原始 YAML，保留注释与顺序，不把 Compose 解析后的完整输出覆盖原文件。首版不提供 env 文件内容编辑，沿用远端已有文件。配置包含秘密时，原文只在用户主动打开的编辑器内短暂持有，不进入日志、维护数据库、遥测或 AI；脱敏预览不能作为保存内容。

保存前读取 hash；使用同目录临时文件、受限权限、原权限保持与原子替换，替换前再次核对版本和远程 resolved-path 范围。保存失败禁止继续部署。同目录 `.env` 的版本与 YAML 一起形成输入指纹，保存、确认和部署前变化均使操作失效；env_file 等额外输入当前只读，不建立多文件事务或外部编辑器锁。

**校验。** 在远端以显式工作目录和单个文件运行 Compose config 校验，使用原有 `.env`。草稿文件位置与 project-directory 必须保持相对路径语义。build、env_file、多文件依赖、profiles、include/extends 或远程引用在部署前明确拒绝并保持只读。语法与展开由 Compose 完成，不自行实现完整 Compose 解析器；错误按其回执展示，解析输出脱敏后才用于预览。

**影响预览。** 展示目标项目、受影响服务、配置文本差异和可能的停机；突出镜像、端口、挂载、privileged 等明显风险字段。基于 Compose config 输出提取必要摘要，不另建部署推演或完整策略引擎；无法说明影响的 hooks 等配置明确限制自动部署。

**操作。** 支持 pull、启动/up、停止、重启、强制重建、down。禁止隐式 build；需要 build 的项目本版提示先在终端构建。down 确认为“停止并移除项目容器和网络”，不删除 YAML，不默认加 volumes/rmi/remove-orphans。提醒匿名卷即使保留，下一次 up 也不保证重新关联。[Docker down 语义](https://docs.docker.com/reference/cli/docker/compose/down/)

**单项目更新。** 配置检查 → pull → 展示拉取结果与待重建服务 → 确认重建 → up → 状态与健康复检。pull 失败不进入 up；拉取本身不重建运行容器。up 使用已拉取的本地镜像并禁止隐式 build/再次 pull，缺失镜像明确失败。记录实际运行的镜像 ID/digest 供排障，不改写配置生成 digest 锁定文件，不增加漂移重审或版本发布系统；外部操作仍可能更改本地 tag，不承诺强一致发布。

Compose 重建可能停止并重新创建容器，不提供通用零停机保证。带健康检查的服务等待 healthy；无健康检查的服务仅报告“运行中，未配置健康检查”。一次性服务按声明预期退出验证；失败后保留现场及诊断信息，恢复旧配置或镜像需要独立确认，不把配置回退当成数据库回滚。[Docker up 语义](https://docs.docker.com/reference/cli/docker/compose/up/)

### F5：日常运维

**镜像更新可用性。** 用户手动检查选中项目或镜像，借助远端可用 Buildx 等受控 CLI 查询 registry manifest，复用远端已配置认证，不读取或传回凭据文件。按匹配平台比较同层级 digest，不能将本地 image ID 与 registry index digest 直接比较。结果为“有更新 / 当前一致 / 未知”，显示检查时间；限流、未认证、工具缺失、只有本地构建镜像或无法建立可比关系时为未知。固定 digest 不因同 tag 改动报更新。检查不偷偷 pull，也不自动发布。

**故障定位。** 在容器详情汇总退出码、OOM、重启次数、health、近期事件与日志，供用户定位故障。用户仍可返回原终端使用已有 AI 能力；本期不开发 Docker 专用 AI 接口、自动摘要转发或自动修复。

**项目事件。** 显示选中 Compose 项目的事件流，区分运行事件与 Mona 维护历史；断连期间存在观察缺口时明确标记，不宣称持久完整审计。[Compose events](https://docs.docker.com/reference/cli/docker/compose/events/)

**空间与清理。** 展示主机磁盘与 Docker 容器/镜像/卷占用排行、共享层和可回收估计。共享层不能简单求和，卷无法统计时显示未知，bind mount 不混入命名卷统计。JSON 详细空间输出需按能力验证；无法结构化采集的字段显示限制，不解析本地化表格凑数。[Docker system df](https://docs.docker.com/reference/cli/docker/system/df/)

先生成候选清单，展示镜像/卷的精确标识、引用与数据风险；用户逐项选择并确认，执行前重新检查全部容器和已关联项目的引用，逐项删除并复检。未挂载的卷仍可能有业务数据，不能称为“安全垃圾”。禁止全局 prune、默认删除卷、强制删除被引用镜像与直接删除 Docker 数据目录。

## 6. 实现架构与契约

### 6.1 所有权

前端 Docker 页通过 Tauri IPC 调用终端模块内的 Docker 服务，后者复用已有 `SshClient`，在独立 exec channel 上运行远端 CLI；PTY 仅用于容器交互。连接生命周期归原 SSH session，Docker 作业、订阅和类型化校验归 Rust 终端模块。无需新增 Python Services 路由或远程服务。

本期通过 Tauri 调用终端模块内现有执行、审批与记录能力，补充最小 Docker 适配。Python Gateway、IPC Bridge 的 AI 接口和通用 terminal_exec 风险规则不因本功能扩展；Docker 页不提供新的 AI 执行入口。

### 6.2 拟新增边界

拟在 `src-tauri/src/terminal/docker/` 集中 types、命令构造/解析、Compose、操作编排；在 `webui/src/components/terminal/Docker/` 放管理页与领域组件，并提供 `docker-ipc.ts`。这些是拟新增路径，按实际复杂度拆分，不为每个命令创建类或通用插件框架。

| 契约 | 必需信息 |
|---|---|
| `DockerTarget` | 父 SSH ID、连接代次、引擎 ID、Unix endpoint、权限模式、能力集 |
| `DockerSnapshot` | 目标、读取时间、数据、部分失败与字段不可用原因 |
| `ComposeProject` | 目标、项目名、目录、单个配置文件、输入版本、可管理性与限制原因 |
| `DockerOperation` | 请求 ID、维护任务 ID、动作、精确目标、审批引用、状态、复检结果 |
| `DockerStreamEvent` | 目标、订阅/任务 ID、单调序号、时间、stdout/stderr 或事件类型、截断/缺口标志 |
| `DockerResult` | exitCode 可空、duration、timedOut、cancelled、错误码、verification、远端结果是否待确认 |

拟提供 probe、list/inspect、subscribe/unsubscribe、preview、execute 等必要的类型化接口，任务查询和取消优先复用现有入口，参数是允许动作与对象，不接受任意 Shell 文本。Rust/TypeScript 一起验证字段命名及调用契约；已有结果类型可直接复用，不按表格机械新增六套模型。

内部使用参数数组构造命令，再对 SSH Shell 边界的每个参数做可靠 POSIX 引用；禁止将资源名、目录、YAML 内容拼接为可执行脚本。结构化结果从独立 stdout 读取，stderr 独立保存于短期缓冲；登录 banner 或额外文本导致解析失败时给出诊断，不显示空列表。

### 6.3 操作和订阅生命周期

- 复用现有每 SSH session 一个活跃维护任务限制，读取有限并发；提交与执行前重新检查目标状态。本期不建立跨会话同引擎资源锁，不保证与其他会话或外部工具互斥。
- 请求 ID 去重；结果未知的变更不得自动重试。重连后先查询资源事实，再决定是否需要新任务。
- 后台管理页暂停 stats/列表轮询；有限时写任务继续；日志与事件在切离目标后退订，返回时按时间重新拉取并标记可能缺口。
- 关闭 exec channel、超时或取消不能证明 Docker daemon 已撤销操作。维护任务落 cancelled/failed/interrupted，同时附 `needsReconcile`；重连后复检，绝不提示“已回滚”。
- PTY 关闭只结束容器交互，不杀容器，不关闭父 SSH；stdout 订阅不得混入父交互终端。

### 6.4 限额与配置

复用现有执行超时及可用配置。仅缺失的内部限额使用 Docker 后端命名常量，初值如下，按对应阶段真实行为调整；本期不新增设置界面或 Python→Rust 配置同步。后续确需用户配置时，必须显式进入 `mona/config/schema.py`。

| 内部限额 | 初值 |
|---|---|
| 有限读取超时 | 15 秒 |
| 更新操作超时 | 按已有执行器参数传入 600 秒，上限沿用现有 1800 秒 |
| 列表刷新间隔 | 前台 5 秒，后台停止 |
| 日志缓存 | 每订阅 2 MiB，有序裁剪并显示已裁剪 |
| YAML 文件大小 | 单个文件 1 MiB |
| 读取并发 | 每会话 2 个有限读取 |

限额由后端强制执行。维护历史仅存目标、动作类型、状态、验证结果及必要摘要，不保存完整输出、原始命令、Compose/env 内容或秘密；已关联项目仅保存路径与非敏感参数，跟随现有用户数据目录。

## 7. 版本兼容与验收原则

选择一个隔离 Linux 主测试环境，记录 Docker Engine/CLI、Compose v2、发行版和架构；功能阶段按需验证对应能力，可选能力失败不能掩盖核心错误。权限、断连、参数与文件边界用针对性用例验证，不构造发行版×版本×权限×桌面平台的全排列。

正式 V1 必须能在隔离测试主机完成：连接 SSH → 打开/复用 Docker Tab → 定位异常容器 → 看日志 → 编辑已关联 Compose 配置 → 校验与审批 → 拉取/重建 → 复检服务 → 查看事件及空间 → 精确删除指定闲置测试资源。覆盖成功、拒绝、命令失败、超时、取消、断连、配置冲突与日志持续输出。

主桌面平台完成一次端到端流程，另一桌面平台做 SSH、Tab、日志、一次变更与关闭的冒烟验证；UI 使用代表组合。阶段已通过且未被后续改动影响的结果直接复用，相关检查通过即停止扩测。未验证平台或能力明确记录，不能宣称通过；具体分层与停止条件见开发计划。

## 8. 借鉴依据与边界

核对日期：2026-09-12；Hexhub 代码依据此前本任务核查的 master 提交 `2ef94ea42f389803dcba1bf6f349deb183d1e804`。此处是产品和协议参考，当前文档工作未复制第三方实现。

- [Hexhub 容器面板](https://github.com/EdikKing/hexhub/blob/2ef94ea42f389803dcba1bf6f349deb183d1e804/components/ssh/ServerInfoWidget.vue)：已有 UI、RPC 请求与 Shell 操作；所核查快照未包含对应 Docker 数据采集服务端，不能据此宣称端到端源码齐全。
- [Dockge](https://github.com/louislam/dockge)：借鉴以原始 Compose 文件为事实源、项目级操作与实时进度；不采用其多 Agent 部署形态。
- [Portainer](https://github.com/portainer/portainer)：参考容器/镜像/网络/卷的资源组织；不把商业版本功能或其整体平台当作 Mona 首版需求。
- [Docker Compose ls](https://docs.docker.com/reference/cli/docker/compose/ls/) 与 [config](https://docs.docker.com/reference/cli/docker/compose/config/)：用于项目发现边界、配置合并与变量解析规则。
- [Docker 镜像元数据](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)：用于 registry manifest 与平台匹配，不作为隐式安装 Buildx 的授权。
- [Docker daemon 访问保护](https://docs.docker.com/engine/security/protect-access/)：支持通过 SSH 保护远程访问；Mona 本方案采用已有 SSH 连接运行远端 CLI，不要求本机 Docker context。

如后续复制任何源码或资源，先记录具体上游 commit、文件许可证、署名和分发要求，再决定是否引入；单纯参考产品行为不引入上游应用依赖。

## 9. 收敛后的开发边界

五类用户功能全部保留，包括镜像更新检查、项目事件、空间排行与精确清理。以下内容从本期开发移出：Docker 专用 AI 集成、多 Compose 文件编辑及 profiles/include/extends 管理、跨 SSH 会话资源锁、digest 锁定发布与漂移重审、六项配置的跨进程同步、通用 AI 命令安全改造。

文件路径与参数校验、保存冲突检测、真实执行结果、危险操作确认、执行后复检、日志有界与断连禁用仍是必需工作。精简不改变现有 AI 维护审批与复检不变量，也不新增完整流程设计器、策略引擎或配置解析框架。
