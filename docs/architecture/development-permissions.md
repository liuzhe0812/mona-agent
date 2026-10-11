# 开发会话权限与执行隔离

状态：Implemented

## 会话与轮次

开发会话保存 `permission_mode`：`ask`、`auto`、`full_access`。已有会话默认 `ask`；新的 Run 保存本轮权限快照，旧历史 Run 的空值不补造执行权限事实。活动轮次、待核对输入和运行中的 Mona 终端命令禁止切档。权限 API 使用会话 revision，进入完全访问需要显式确认。

侧边会话与子任务继承父会话权限。`readonly` 是独立执行约束，不能通过继承或选择完全访问取消。权限变化与审批结果属于会话事件，视图只在后端接受设置后更新。

## 统一审批

`DevelopmentPermissions` 为 Mona 和 CLI 回调提供同一审批入口，复用 `DecisionBroker` 的会话/Run/确认 ID 校验和输入区审批卡。Mona 的权限门放在开发工具 registry，动态加载的工具也经过同一个执行入口，普通 Work 使用原有 registry。

Mona 的 `ask` 模式下，普通命令直接进入工作区写沙箱，不因工具名为 `exec` 而预先弹窗；读取已运行进程输出同样不新增审批。显式扩大执行范围仍需单次确认，已有终端的新输入保持原授权边界。此豁免只用于 Mona，不放行上游引擎发出的审批请求。

自动审批采用有界审核：用户本人授权、实际工具参数、项目范围进入独立审核请求，助手正文和工具结果不作为授权。审核使用当前 Mona 模型；CLI 使用显式 `development.permissions.review_model_preset`，缺省取已有开发模型预设。不会改变主执行模型。允许与阻止回到工具调用，询问、服务不可用、无效结果和关闭失败走现有人工确认。

系统提示词在 turn 内保持稳定；审批状态记录在事件中。用户拒绝、取消、停止或原轮次失效后，不执行原操作，不将旧授权用于新轮次。原生类似命令授权只使用原生提供的范围。

Mona 与 SDK 的项目外文件审批固定到确认过的规范路径；单次确认不成为常驻授权，执行前目标变化即拒绝。Mona 命令可携带 `sandbox_permissions: danger-full-access` 和具体理由，为这一条命令请求更宽范围；授权与 Run 档位分离，不自动重试结果未知的写入。

命令结果按沙箱拒绝签名与运行器故障规则处理：非零退出且原始 stderr 命中后端签名时，向模型返回沙箱拒绝标记和单次授权引导；运行器自身故障优先返回 `SANDBOX_UNAVAILABLE`。普通命令用未裁剪的 stderr 识别，后台命令从保留的 stderr 诊断尾部识别，轮询已返回的输出不会清除诊断。成功、信号终止、主动停止和超时不产生升权引导。模型先核实已有影响，再显式提出新调用；系统不重放原调用，审批仍在现有输入区卡片中完成。

## 引擎映射

| 引擎 | 请求批准 / 自动审批 | 完全访问 | 独立只读约束 |
|---|---|---|---|
| Mona | 开发工具执行门；命令使用工作区写沙箱 | 放宽普通工具范围，跳过常规审批 | 不注册写入与执行工具 |
| Codex | `on-request`、`user`、`workspace-write`；自动档由宿主审核 | `never`、`danger-full-access` | `read-only` |
| Claude / CodeBuddy | SDK `default` 与权限回调 | SDK 明确支持的 `bypassPermissions` | 保留原生工具，由宿主 `PreToolUse` 检查只读操作和项目路径 |

Mona 的沙箱运行器只装配到 Mona Coding；Codex、Claude Code、CodeBuddy 直接使用各自上游的沙箱及权限能力。Mona 接收原生审批回调并保留用户所选审核方式，不给 CLI 再套工作区沙箱，也不把 SDK 权限模式冒称为已确认的操作系统沙箱。

SDK 只读接入沿用 Cindy Review 的执行前权限检查：允许项目内读取，拒绝命令执行与写入；搜索路径与文件选择模式同时校验，规范路径回写原生工具参数。拒绝是工具结果，不直接结束子任务。`setting_sources=[]` 和独立原生数据目录继续隔离用户及项目配置，只读会话仅注册宿主自己的检查回调，不用全局禁用 hooks 的设置遮蔽该回调。

Windows CodeBuddy 的固定附加提示使用原生 `PowerShell` 工具名；`Bash` 仅在原生工具列表包含它时调用。CodeBuddy 只读任务明确使用 `Read`、`Glob`、`Grep` 调查文件，调用仍经过执行前权限检查。原生工具集、命令参数和权限边界保持由 CLI 管理。

CLI 支持列表从适配器/SDK 签名探测，设置前核对目标档。模式变化使空闲连接重新按原 native session ID 恢复，恢复回执必须与所选模式一致；不生成重跑请求或替代 Run。

## 沙箱与运行时

Mona 的沙箱后端只承诺文件效果隔离，审批不等同于网络或读取隔离。Windows 使用 Node 运行器、受限令牌、ACL 和 Job Object，报告 `partial`；Linux 使用 bwrap / 显式 Landlock profile，macOS 使用 Seatbelt profile。缺少可用后端明确失败，不以裸执行替代。

Windows helper 为带 SHA-256 和版本记录的随应用组件 ZIP。首次使用经 `RuntimeComponentStore.install_archive` 校验导入，Node 依赖经既有官方 runtime jobs 按精确版本安装；活动版本不匹配时拒绝，不另设下载器。轮子与桌面打包都包含组件及上游许可证。普通命令和持续 stdin 命令调用同一个启动适配器，进程取消保持既有会话所有权。

Windows 使用工作区能力 ACE 与 Low integrity label，工作区授权保留供后续沙箱复用，私有临时目录授权随命令结束回收。受限令牌可能无法访问权限较紧的父目录链；此时返回沙箱拒绝并允许申请单次授权，不修改祖先目录 ACL，也不自动切换成不受限执行。获批调用使用宿主原有权限，不能绕过 Windows 本身对宿主用户的权限限制。

Windows 沙箱初始化工作区要求调用者拥有该目录并具备 `WRITE_OWNER`，用于写入 Low integrity label；目录所有者隐含的 `WRITE_DAC` 不能替代它。初始化失败仍返回 `SANDBOX_UNAVAILABLE`，不会自动修复目录 ACL 或转成不受限执行。

来源：沙箱运行器复用了 DeepSeek Harness 的沙箱组件，仓库、提交与依赖记录见 `mona/development/sandbox_node/UPSTREAM.json`；Cindy 改编声明、Apache-2.0 许可证与 NOTICE 位于 `mona/development/permissions.py` 和相邻许可证文件。
