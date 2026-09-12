# SSH Docker 管理使用指南

- 状态：功能代码已实现，真实 SSH/Docker 发布验收待完成
- 适用范围：Windows/macOS Mona 连接远程 Linux Docker 主机
- 功能方案：[SSH 会话内 Docker 管理方案](../design/2026-09-12-ssh-docker-management-design.md)

## 使用前提

远程主机已安装 Docker CLI 和 Docker Engine。Compose 项目管理要求 Docker Compose v2。当前 SSH 用户需要直接访问 Docker，或具备无需输入密码的 `sudo -n docker` 权限；Mona 不收集 sudo 密码，也不自动安装 Docker 或修改用户组。

Docker 管理始终绑定当前 SSH 主机的 Unix socket。如果远程默认 context 指向 TCP 或另一台 SSH 主机，Mona 会拒绝进入，避免操作到错误主机。Podman 只做检测和提示。

## 打开与关闭

1. 在终端页面连接一台 SSH 主机。
2. 点击工具栏“Docker”，或在 SSH 标签右键菜单选择“Docker 管理”。
3. 同一个 SSH 会话重复打开时会复用已有 Docker 标签。

关闭 Docker 标签不会关闭 SSH。切回其他标签会暂停 Docker 轮询、实时日志和 Compose 事件，切回时再刷新；已经开始的有限时操作不会因隐藏页面而中断。关闭父 SSH 标签会一并关闭关联的日志、事件和容器终端。连接意外断开时，Docker 页保留最后快照并禁用操作；重新连接后刷新即可。结果不确定的写操作不会自动重放。

## 容器管理

“容器”页提供全部、运行中、已停止和异常筛选，可按名称、ID、镜像或 Compose 项目搜索。列表显示状态、健康摘要、CPU、内存、端口和读取时间；详情展示退出码、OOM、重启策略、资源限制、挂载、网络和环境变量名称。

- “最近日志”读取有限行数；“实时日志”离开页面后自动退订，缓存达到上限时只保留最近内容并明确提示。
- “进入终端”为容器单独建立 PTY，优先使用 bash，其次使用 sh。关闭它不会停止容器或父 SSH。
- 启动、停止、重启和删除都返回真实执行结果并复检状态。运行中的容器不能直接删除。
- 停止、重启和删除会显示一次操作确认；拒绝后不执行。
- 变更执行期间可点击“取消操作”。取消会关闭当前执行通道，但不能证明 Docker daemon 已撤销已开始的动作，因此完成后必须刷新确认实际状态。

## Compose 项目

Mona 自动列出 Docker Engine 已发现的 Compose 项目。执行过 `down` 或未运行的项目可以通过“关联 Compose 文件”加入，关联记录按 SSH 目标和 Engine ID 保存在桌面客户端中。

V1 管理单个 `compose.yaml`/`compose.yml`：

- 编辑原始 YAML，保留注释；使用同目录已有 `.env`，不显示或编辑环境文件内容；`.env` 变化会使保存或部署确认失效。
- 保存前核对 SHA-256；文件被外部修改时拒绝覆盖。
- 草稿先经远端 `docker compose config` 校验，再通过同目录临时文件和原子替换保存。
- 为避免改变文件所有权，配置文件必须属于当前 SSH 用户；复杂权限文件继续在终端中编辑。
- build、env_file、多个 `-f` 文件、profiles、include/extends 等复杂调用当前只提供状态、日志和事件查看，不省略参数执行部署。

操作包括拉取镜像、启动、停止、重启、强制重建和 down。修改未保存时禁止执行。pull 完成后不会自动重建；确认重建后才执行 up。up 禁止隐式 build 和再次 pull。

Compose 重建可能中断服务。状态“运行中”不等于业务健康；配置了健康检查时以容器 health 为准。down 默认移除项目容器与网络，不附加 `--volumes`、`--rmi` 或 `--remove-orphans`，也不删除 YAML。

## 镜像、空间与清理

“镜像与空间”页显示镜像、卷和 Docker 空间统计。镜像更新检查读取远程 registry manifest，与本地 RepoDigest 比较；未认证、Buildx 不可用、本地构建镜像或 digest 不可比时显示“未知”，不会偷偷 pull。

Mona 不提供全局 prune。删除镜像或卷时只处理明确选择的单项，操作前和确认后都重新检查容器引用。未挂载的卷仍可能保存业务数据，请根据业务备份和 Compose 配置自行判断；被容器引用的资源会被拒绝删除。

## 常见状态

| 状态 | 处理方式 |
|---|---|
| 未安装 Docker CLI | 在远程主机按其发行版方式安装，完成后刷新 |
| Docker Engine 不可访问 | 检查 daemon、socket 与当前用户权限 |
| sudo 需要密码或 TTY | 在原终端完成运维，或由管理员配置受控的非交互权限 |
| 当前 context 指向其他主机 | 切换为当前主机 Unix socket 后重新探测 |
| Compose v2 不可用 | 容器管理仍可用；安装 Compose v2 后刷新 |
| Compose 文件已变化 | 重新读取、合并修改，再次校验和保存 |
| 操作超时或 SSH 断开 | 先刷新实际资源状态，不直接重复删除或重建 |
| 更新检查为未知 | 根据页面原因检查 Buildx、仓库认证和镜像来源 |

生产发布前应先在隔离环境验证目标项目的备份、健康检查、停止影响和恢复步骤。
