# Mona 多端同步与 Pro 设备管理：本地 Codex 交接

日期：2026-10-13

项目：`D:\liuzhe\Desktop\code\Mona`

分支：`feature/1.8.0-development`

功能基准提交：`c7a032fae67f2c94644176eeea877f6865aac83b`

任务状态：本地阶段功能已提交；真实七牛、物理多设备、正式安装包和生产迁移尚未验收。**不能按“已上线”交付。**

续作更新（2026-10-13）：下文保留交接时的历史快照。Auth 已按用户决定建立独立本地 Git 仓库并备份；真实 MariaDB 演练及私有七牛检查已完成，已修复发现的问题。用户新授权的三机隔离 Auth/数据库/HTTPS 路径已部署，公网链路检查通过；正式 Auth 未升级。用户选择自行安装另外两台 Windows，实体验收尚待执行。最新结果、测试包输入与回收边界以 `docs/guides/pro-cloud-acceptance.md` 和 `docs/guides/pro-cloud-windows-acceptance.md` 为准，不再按旧的“无独立仓库/等待测试服务授权”条目重复追问。

最新范围纠正：用户明确当前只是开发功能，整体其他开发尚未完成；完成必要测试即可停止，等用户明确要求人工测试时才打包。上面的三机安排已撤回，本轮临时服务、数据库、路径、测试账号及凭据已回收，测试对象为空。提前生成的本地包未安装或发布，不作为当前交付。后续 Agent 不得依据历史三机/打包方案再次部署或打包，保留已有功能代码与必要测试结果即可。

2026-10-14 开发续作：用户要求完成开发遗留、必要测试后汇报，再等通知打包。已修复清理/回收站控制面白名单漏项、新设备无模型配置时无法启动同步服务的条件；补入本机失败/重试下载计量、Auth 源站日志按账号账本及查询、明确截止的旧模型客户端过渡窗口。Auth 迁移最新 head 为 `cloud_download_usage`，源站真实日志尚未在生产开启/接入。详细结果见验收指南当日开发收尾；旧的“没有下载字节账本/未实现旧客户端代码兼容”快照不再作为当前代码状态，但不能将这次合成日志及 SQLite 结果当作新迁移的真实 MariaDB/生产验收。

2026-10-14 正式登录修复：用户另行明确授权更新正式账号服务，解决新版客户端设备登录接口不存在的问题。正式 Auth 已切换至独立仓库 `d85081c` 的运行源码，保留原有管理页面；正式库只升级到 `desktop_device_sessions`，设备登录接口的公网校验通过。云同步关闭且没有迁移云表，旧客户端模型服务过渡截止为北京时间 2026-10-21 14:35:52。本次没有打包客户端，也未执行真实用户登录；备份、验证和回退位置见验收指南的“正式登录修复”记录。历史“正式 Auth 未升级”仅适用于该次修复前的快照，不能据此重复部署或声称个人云已经上线。

2026-10-14 云同步正式上线：用户随后明确授权直接在生产环境启用、测试通过后保留上线。正式库已升级至 `cloud_download_usage`，现有私有七牛空间及 HTTPS S3 入口接入正式 Auth，新增 `/cloud/` 转发，云同步已开启。真实生产 HTTPS/MariaDB/七牛与本地协调器的合成验证通过，覆盖设备限制、Work 历史/增量恢复、按需附件、配额结算、权限、到期下载及回收站；本次测试账户和 19 个测试对象已清理，原账户、订阅和套餐行逐项核对一致。该空间现已承载正式云功能，不得依据旧“测试空间”记录整桶清空。最新状态与恢复位置以验收指南的“云同步生产启用与验收”记录为准；此前“云同步关闭”是历史快照。本次未打包客户端，物理设备、原生凭据库和安装包验收仍未替代用户执行。

## 1. 接手结论与第一步

本任务是 **Mona 的个人云工作空间与 Pro 设备管理**，不是 `mona-agent-core`、OE-Claw，也不是更换 Harness。不要重新设计或重复开发已完成的笔记、偏好、历史清理与回收站。

在上述现有工作目录直接接手。先阅读根目录 `AGENTS.md`、`docs/architecture/pro-cloud-services.md`、`docs/architecture/engineering-boundaries.md`、`docs/architecture/services-split-design.md`；涉及其他模块时再阅读对应不变量和 UI 规范。`docs/plans/2026-10-12-pro-cloud-implementation.md` 是同机完整阶段记录，早期“未实现”描述已经被其后阶段更新，不应截取早期条目作为最新状态。

接手顺序：**确认工作树与本地 Auth 源码 → 恢复现有测试和迁移验证入口 → 列出真实联调需要的最小资源/权限 → 完成已获授权的本地准备 → 获得真实环境授权后联调与发布验收。** 不要把仍能在本地完成的检查全部转交用户，也不要在没有环境授权时操作生产。

### 工作区与版本管理警告

交接前实测 HEAD 仍为上方基准，相关独立云同步文件没有未提交业务改动。已有六次功能提交，详见第 3 节。因此这次交接不制造重复功能提交，新增提交以本交接文档为主。

工作树**不干净**：交接开始时有 216 个已跟踪变更路径，涉及其他开发任务；索引中已有 `tests/tools/test_filesystem_write_conflicts.py`，且其工作文件与暂存内容并不相同。不得使用 `git add .`、`git add -A`、无路径的全量提交、`reset --hard`、`clean` 或批量还原来“收尾”。精确检查待提交路径与差异，保留其他任务的文件、暂存版本和未跟踪内容。

**配套服务端尚未纳入版本管理：** `mona-auth/` 在本机存在，受主仓库 `.gitignore` 排除，目录内没有独立 `.git`。这六次桌面提交不包含 Auth 服务、测试和数据库迁移。重新克隆主仓库不能恢复这部分成果。不要删除、清理或覆盖现有 `mona-auth/`；建立其独立仓库/受控备份的归属方案需单独确认，不能擅自强制提交整个目录，尤其不能带入 `.env`、`keys/`、虚拟环境和生产凭据。

`docs/plans/*` 默认被忽略，本交接文档按用户明确交付要求单文件纳入 Git；没有放开整个目录或修改全局忽略规则。原实施记录和 `output/pro-cloud/` 报告仍以当前本机文件为准，不能假设它们随 Git 克隆提供。

来源：交接前实际 Git HEAD、索引、工作树和忽略规则；检查元数据在 `output/pro-cloud/handoff-72d832d0/`。本地分支当前没有配置 upstream，本次没有访问远端核验或推送。

## 2. 已确认产品与安全边界

| 范围 | 必须保留的约定 |
| --- | --- |
| 设备权益 | 免费账号 1 台、有效 Pro 账号 3 台；设置中查看和明确移除设备，达到上限后由用户选择替换，不静默挤掉其他设备。关闭应用不释放名额。 |
| 本地能力 | 本地 Agent、Office、资料、开发与运维不因 Pro 订阅被锁定；工具授权、数据范围、操作确认、模型认证及余额检查仍有效。Pro 不赠送模型 Token。 |
| 会话范围 | 首期只同步普通 Work 会话及有明确归属的关联附件/工作文件；开发会话、原生 CLI 状态、完整项目目录、依赖与模型缓存不在范围内。 |
| 其他同步类别 | Notes 笔记及关联附件、个人日程/待办、四项使用偏好均单独确认；启用 Work 同步不能自动代表授权上传其他类别。 |
| 偏好白名单 | 侧栏模块布局、启动默认页面、消息发送按键、快捷问答显示模式。主题、语言、模型、Agent 和 Skill 配置不在本阶段，不能统称“全部设置同步”。 |
| 隐私与密钥 | 客户端加密；启用有恢复密钥流程。服务端不持有可直接解密内容的密钥，React 不接收账号 JWT/七牛密钥。禁止同步 API Key、SSH 密钥/密码、Cookie、CLI 登录、目录和权限设置。 |
| 配额 | 每账号共用 10,000,000,000 字节，不是每台设备各 10GB。密文、保留历史与回收站计入占用，共享对象只计一份；上传前预留，真实确认后结算。 |
| 恢复与执行 | 恢复产生可检查的历史/新版本，不自动运行旧工具、审批、计划任务或提醒队列。并发修改保留冲突，不静默覆盖。 |
| 回收站 | Work 的“移至云回收站”只操作云副本，不删除本地会话、文件或运行任务；普通本地删除不隐式授权删除云数据。恢复/彻底删除均需预览与明确确认。 |
| 清理 | 默认 30 天历史保留窗口；过期历史退役不等于释放存储。真实对象确认删除且无引用后才减少占用。首期不启用自动清空、自动清理用户数据的任务。 |
| 服务架构 | 复用本地 Gateway、Services、Tauri 和远端 Auth；VPS 处理认证、目录/版本、配额与对象授权，文件由客户端直传/直下私有七牛，不让 VPS 代理大文件或运行用户 Agent。 |

恢复/清理确认须绑定账号、设备会话代次、云空间和精确资源版本；切账号/撤销设备使旧确认失效。写入结果未知时核对或显式重试同一身份，不自动生成新请求重复执行。

历史讨论中的“每月 10GB 下载”与价格只是测算基线，不等于已有严格流量限额或获准修改生产售价。真实传输字节、URL 签发申请量、重复下载和账单必须分别处理。

本节以 `docs/architecture/pro-cloud-services.md` 为约束源。自动保留/自动回收并非本次默认必须补写的后台功能；要改变当前明确确认策略，先与用户确认。

## 3. 已完成并提交的阶段

下表六项都已在当前分支历史中核实。它们是既有提交，不能算作本次交接新写的代码；本地提交也不等于服务已发布。

| 提交 | 阶段 |
| --- | --- |
| `93bb72eb6f0336b94131a21387585533788eafc9` | Pro 设备名额/管理、本地基础能力开放、Work 会话/关联文件同步、个人日程与待办同步。 |
| `82819993c89ce39081f576f1bb4bec6956259e7b` | 上传残留预览、确认、精确对象回收及配额保护。 |
| `03872bbba9e46b9006a938d3ed75387f50b1390e` | Notes 与关联附件加密同步、仓库身份/版本保护、冲突与前端保存协调。 |
| `9ebf6135c683fa3ca5cd6323f2eebba92e7fd144` | 四项显式使用偏好同步、原生条件保存与字段合并。 |
| `feb9be89f4f539e22bb520d7aec61aa4389da80d` | 过期历史预览与明确清理，保护最新内容、已删除资源历史和共享对象引用。 |
| `c7a032fae67f2c94644176eeea877f6865aac83b` | 云回收站查看、移入、恢复、彻底删除与 Work 删除标记持久化。 |

关键行为已经有本地或组合测试：新端恢复完整 Work 历史、按需下载关联文件；缺失且未上传的附件阻止不完整版本发布；暂停后新增类别会补读历史；删除/恢复不复活旧任务；本地会话删除后显式恢复创建新会话；被撤销设备不能继续同步或下载。

Auth 配套实现也已存在并参与隔离测试，但**不在上述提交里**。不能将“桌面端已提交”写成“全部服务端源码已入库”。

## 4. 关键源码入口

| 层级 | 入口与用途 |
| --- | --- |
| 本地协调与接口 | `mona/cloud/coordinator.py`、`api.py`、`local_state.py`：同步循环、状态、账户/类别范围、本地受保护接口。 |
| 加密与传输 | `mona/cloud/crypto.py`、`transfer.py`、`transport.py`：密文对象、控制面与上传下载边界。 |
| Work 数据 | `mona/cloud/work_snapshot.py`、`work_files.py`、`file_access.py`：会话投影/恢复、精确归属文件及按需下载。 |
| 其他类别 | `mona/cloud/notes.py`、`planning.py`、`preferences.py`；日程本地服务边界在 `mona/schedule/sync.py`、`sync_api.py`。 |
| 历史与回收站 | `mona/cloud/history_retention.py`、`recycle.py`。 |
| 原生账号与云桥 | `src-tauri/src/license/device_sessions.rs`、`cloud_bridge.rs`；负责账号凭据、绑定与受控操作，不把凭据暴露给 React。 |
| 原生资料所有者 | `src-tauri/src/notes/sync.rs`、`sync_tests.rs` 与 `src-tauri/src/settings/sync.rs`。笔记和 settings 文件读写仍归 Tauri。 |
| 设置与交互 | `webui/src/components/account/AccountDevices.tsx`、`CloudSyncSettings.tsx`、`CloudHistoryDialog.tsx`、`CloudCleanupDialog.tsx`、`CloudHistoryRetentionDialog.tsx`、`CloudTrashDialog.tsx`、`LoginDeviceSelection.tsx`。 |
| 前端契约与刷新 | `webui/src/lib/cloud-sync.ts`、`account-devices.ts`；`webui/src/hooks/useCloudUpdates.ts`、`useDesktopPreferenceUpdates.ts`。 |
| Auth 设备 | `mona-auth/app/device_sessions.py`、`device_models.py`、`routers/desktop_auth_router.py`、`routers/device_router.py`。 |
| Auth 云协议 | `mona-auth/app/cloud_sync.py`、`cloud_models.py`、`cloud_contracts.py`、`cloud_limits.py`、`routers/cloud_router.py`。 |
| Auth 存储/清理 | `mona-auth/app/cloud_storage.py`、`cloud_cleanup.py`、`cloud_retention.py`、`cloud_trash.py`。 |
| Auth 配置/就绪 | `mona-auth/app/config.py`、`main.py`、`database.py`。只检查配置来源及是否齐备，不打印配置值或读取生产私钥作为测试数据。 |

涉及 `mona/config/schema.py`、API server、会话管理、`App.tsx`、`src-tauri/src/lib.rs` 等共享文件时，必须先区分其他任务差异，不能因它们含同步入口就整文件提交。

### 数据库迁移链

本机已核实文件与 revision 关系：

```text
promotion_singleton
  -> desktop_device_sessions   # 2026_10_12_add_desktop_device_sessions.py
  -> cloud_sync_metadata       # 2026_10_12_add_cloud_sync_metadata.py
  -> cloud_history_retention   # 2026_10_13_add_cloud_history_retention.py
  -> cloud_trash               # 2026_10_13_add_cloud_trash.py
```

全部位于 `mona-auth/alembic/versions/`。这是源码链，不是生产数据库当前 revision；上线前必须读取目标数据库真实版本并核对完整祖先链。已有阶段只记录隔离 SQLite 升级/回退，不能据此宣称 MariaDB 的锁、并发或迁移兼容性已验证。

## 5. 最新实际验证与证据边界

以下四项是在本次交接前一轮对当前工作源码执行，交接时已重新读取相同 Job 的终态/日志确认；**这次只写文档，没有再运行全套测试，也没有新增通过数量。**

| 验证 | 结果 | WebCodex Job |
| --- | --- | --- |
| `tests/cloud` | 229 passed，1 skipped，34 warnings | `7e1ef91b-8393-4c3d-9bb3-128600dbffbf` |
| Auth 设备/云协议与真实协调器组合 | 83 passed | `8653da6a-b179-4b46-81b6-033f11ae403c` |
| 前端账号/设备/云同步相关 | 17 个测试文件，159 passed | `57f09c19-8eda-4feb-9991-8bce5071138b` |
| 主前端生产 TypeScript 检查 | exit code 0 | `39190ff8-ba8a-4c66-98a9-cee40375395e` |

唯一跳过项是 `tests/cloud/test_work_snapshot.py` 的 Windows 符号链接权限限制，不是跳过同步主流程。前端首次执行只指定 `--maxWorkers 2`，导致 min/max worker 冲突、没有运行用例；补充 `--minWorkers 1` 后上述 159 项全部实际通过。原失败 Job 为 `5ed42b82-8ffa-44cd-a1b9-057510b23142`，不要把它与成功结果相加。

Auth 组合使用真实 Auth 路由、设备/云逻辑、本地协调器、加密和临时 SQLite，仅替代原生凭据存储与七牛对象存储等边界。它能验证跨层契约，**不能代表真实物理双机、系统凭据库、七牛或生产 MariaDB 已验收**。前端是 Happy DOM 测试，仍有共享弹窗 body-lock 调试日志，不等于正式桌面视觉验证。

### 先前阶段报告，不计入上述最新结果

- `output/pro-cloud/trash-stage6-6e3d6710/build-report.json`：回收站阶段精确暂存主前端输入的 TypeScript、预构建与生产构建报告，状态 passed。
- `output/pro-cloud/trash-native-20261013-a/report.json`：原生账号与受控路由 11 项，报告记载源码未变；引用前仍应核对报告中的源码 SHA。
- `output/pro-cloud/trash-auth-final-9bb2a812/report.json`：上一阶段 Auth 55 项及源码指纹，不与本轮 83 项累计。
- Notes 原生 21 项、偏好原生 13 项及各阶段提交/构建证据入口见原实施记录。

先前构建仍有字体资源、混合导入与大分包警告。最近一轮没有重新构建 Office 编辑器、Tauri 正式安装包，也没有重新执行所有 Rust 测试。其他会话还在改共享文件，未来验证必须绑定当时源码，不能长期沿用本报告的数字。

## 6. 本地复验方法与已知环境问题

先确认命令的 cwd。使用已有项目环境，不为交接任务批量升级依赖或重新创建环境；下面命令仅作用于本地测试，不构成连接生产或运行收费服务的授权。

### 云模块

在 Mona 根目录执行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/cloud -q --disable-warnings
```

### 前端与类型检查

在 `webui/` 目录执行，沿用成功的 worker 配置，并排除旧 `.tmp-verify` 副本：

```powershell
node node_modules/vitest/vitest.mjs run src/components/account src/components/settings/AccountSettings.test.tsx src/hooks/useLicense.devices.test.tsx src/hooks/useCloudUpdates.test.tsx src/hooks/useDesktopPreferenceUpdates.test.tsx src/lib/account-devices.test.ts src/lib/cloud-sync.test.ts src/lib/cloud-cleanup-api.test.ts src/lib/cloud-retention-api.test.ts src/lib/cloud-trash-api.test.ts src/lib/cloud-file-open.test.ts --exclude ".tmp-verify/**" --maxWorkers 2 --minWorkers 1
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json --incremental false
```

不要重用正在运行的 dev 的 Vite 缓存/输出。`webui/vite.config.ts` 已区分测试与应用缓存；另建验证服务仍须使用独立 cacheDir 和产物目录，不重启用户 dev。完整构建需运行已有正常预构建，不绕过视频运行时/共享样式生成；不能将 `tsc` 成功说成生产打包成功。

### Auth 组合测试

成功范围是 `mona-auth/tests/` 下这八个文件：

```text
test_desktop_sessions.py
test_device_management.py
test_cloud_sync.py
test_cloud_cleanup.py
test_cloud_retention.py
test_cloud_trash.py
test_work_sync_integration.py
test_trash_sync_integration.py
```

不要直接在 Auth 目录用未知 `.env` 运行集成测试。前轮成功方式是：使用 `mona-auth/.venv/Scripts/python.exe`；在新的临时目录作为 cwd；清除该子进程继承的 `MONA_AUTH_*`，重新设置临时 SQLite 数据库、随机测试 JWT secret、临时 uploads/attachments；`sys.path` 前部放 Auth 与 Mona 根目录，再附加 Mona `.venv/Lib/site-packages`；通过 `pytest.main` 指定 Auth 的 `pyproject.toml`、`--rootdir`、`--confcutdir` 和上述八个绝对测试路径，禁用缓存插件。完成后关闭数据库 engine，再回收该次临时目录。

这个隔离启动方式已经得到 83 项通过，不是要求把整套 Mona 依赖安装到服务器。直接在 Auth 虚拟环境运行曾因缺 Mona 包收集失败；也不要让主仓库的 `tests` 包遮蔽 Auth 自己的 `tests` 包。接手方可将此成功方式整理为安全的可重复本地验收入口；不得读取生产配置来“补齐测试依赖”。

Rust 测试曾遇到 Windows Common Controls v6 测试入口问题，前阶段通过隔离宿主解决。检查上述原生报告/入口后再执行，不以此为理由跳过断言、修改生产逻辑或冒称全量通过。

### WebCodex 观察问题

本会话的结构化 Git 观察曾误报 unavailable、项目文本搜索执行失败，但同一项目内实际 `git` 命令可正常读取 HEAD、diff 和索引。`finish_coding_task` 的历史工具失败/脏工作树汇总不等于业务测试失败，也不证明工作区干净。本地 Codex 直接以实际 Git 和进程输出核实；遇到命令结果未知，先查 HEAD/原 Job，不重复提交或重放写入。

## 7. 未完成事项及明确验收标准

### A. 真实七牛私有空间与下载计量

需要接通专用测试环境，验证真实授权上传、存储 stat、内容完整性、按需下载、授权过期/重试、暂停与恢复、对象删除确认，以及共享对象/未过期授权不会被误清理。用小型合成数据，不上传真实用户资料；容量边界可在独立测试环境下调配额验证，不为模拟 10GB 耗尽盲目上传 10GB 数据。

真实 Range/重复使用签名 URL/重试传输、客户端记录与七牛账单需要逐项核对。目前尚没有“严格真实流量配额已交付”的证据；先检查当前代码和账单接入是否完整，缺口列为待实现，而不是把一次 URL 授权当作一次实际下载。真实存储及流量收费开始前先获得用户许可。

### B. 物理双机/三机与正式安装包

至少两台物理设备验证：新设备登录与恢复密钥、完整 Work 对话与懒加载附件、增量继续编辑、两端离线冲突、笔记正文/附件、日程待办、四项偏好、回收站恢复与永久删除、账号切换、撤销设备后的拒绝及本地资料保留。Pro 3 台名额还需三端及第 4 台拒绝/明确替换的证据；同机模拟身份不能标为物理三机验证。

构建并安装正式桌面包，验证 Tauri 系统凭据、本地桥接、Gateway/Services 路由、资源随包交付与账户 UI。测试 Pro 到期后保留设备规则、重新登录替换、暂停自动同步但允许明确管理已有云历史/回收站。还需核对到期保留/下载期的真实实现与对外说明是否一致；不要仅凭架构文字判断完整落地。

### C. MariaDB 迁移、并发与受控发布

先做隔离 MariaDB 演练，保留既有账户/订阅/设备数据，核对当前 revision 与完整迁移链。验证并发登录设备名额、云对象预留、版本条件提交和幂等，不把 SQLite 的行为当成 MariaDB 并发证据。

生产前明确服务端源代码版本归属、数据库备份/恢复计划、发布目标、故障回退和客户端兼容性。顺序应为迁移并部署配套 Auth、验证就绪能力，再发布新客户端。服务器未升级时客户端应明确失败，不能退回无限制设备登录。生产回退不得简单执行会删除新云数据的 downgrade。

### D. 不应趁收尾扩大的范围

不新增 Code 项目同步、长期在线云 Agent、多人审批、全部设置同步或自动清空数据。当前手动历史/对象回收已经实现；自动策略是否进入后续版本需另行确认，不能为“完成所有任务”静默启用。

## 8. 真实联调所需最小信息与授权

先从本机既有配置和可用资源确认存在性，只汇报缺项/目标身份，不输出凭据值。用户尚未授权本轮使用生产账号、生产七牛、真实收费模型或执行生产发布。

| 资源 | 最小需要与约束 |
| --- | --- |
| Auth 测试目标 | 明确测试服务目标、可部署范围、隔离数据库与测试账号；不把默认生产域名当作已授权目标。 |
| 七牛测试空间 | 独立私有空间、对应 HTTPS 上传入口与下载源、限定该测试空间的凭据和费用授权；不能复用公共安装包分发空间承载私人数据。 |
| 配置来源 | 当前 Auth 字段包括 `MONA_AUTH_CLOUD_SYNC_ENABLED`、`MONA_AUTH_CLOUD_PRIVATE_BUCKET_CONFIRMED`、`MONA_AUTH_CLOUD_BUCKET`、`MONA_AUTH_CLOUD_ACCESS_KEY`、`MONA_AUTH_CLOUD_SECRET_KEY`、`MONA_AUTH_CLOUD_UPLOAD_URL`、`MONA_AUTH_CLOUD_DOWNLOAD_ORIGIN`。这是字段清单，不含配置值；以 `app/config.py` 的当前定义为准。 |
| 设备和身份 | 至少两个获准测试的设备/用户数据目录及测试账号，Pro/免费状态由明确测试方式提供，不更改真实用户套餐。 |
| 发布权限 | 数据库迁移、服务部署、正式客户端发布、桶权限调整、价格变更分别需要明确目标与授权；本次“提交 Git”不包含这些操作，也不包含 push。 |

开发执行继续遵守用户已指定的 **gpt-6.1 sol** 限制；不能未经告知换成 astra。新启动会消耗额外模型额度的任务先征得用户同意，不因项目通用规则提到 Luna 就擅自派发额外付费任务。本次交接没有启动代理模型执行。

## 9. 本次交接证据与交付方式

本次只核对已有提交/结果、写交接文档并按精确路径提交；不改业务逻辑，不推送、不部署、不重启 dev。新文档提交 SHA 可用下列只读命令取得，文档不填写会形成自引用的自身提交 SHA：

```powershell
git log -1 --format="%H %s" -- docs/plans/2026-10-13-pro-cloud-handoff.md
```

交接辅助记录在 `output/pro-cloud/handoff-72d832d0/`：`baseline.json`、`index-before.bin`、`status-before.bin`、`worktree-sha256-before.json`、`task-source-sha256.json`。前四项用于检查原有暂存和工作文件是否被改动；最后一项记录 27 个云模块/服务端/迁移文件的交接时 SHA，只是交接快照，**不是新测试报告**。这些辅助文件不进入功能提交，不包含凭据。

交接前四个复验 Job 已全部完成；本次不保留需要 Codex 接管的模型任务。其他会话自己的任务/进程不属于本交接，不要统一停止。未来进度报告请区分“已编码”“已提交”“本地自动化验证通过”“真实环境验收通过”“已部署上线”，不能互相替代。

## 10. 可直接交给本地 Codex 的任务说明

> 在当前 Mona 工作目录继续多端同步与 Pro 设备管理任务。先读本 handoff、AGENTS.md 和 pro-cloud-services.md，核对分支、已有六个阶段提交、其他任务的工作区/暂存差异，以及被 Git 忽略但必须保留的 mona-auth 本地源码。不要重新开发已完成的偏好、历史清理与回收站。先完成无需生产权限的本地验收准备、源代码归属风险核对与隔离迁移/测试入口整理，再列出真实七牛、物理多设备和正式安装包联调所需最小缺项。只在明确获准的环境执行后续验证，修复实际发现的问题并补回归。保留 Work-only、独立类别确认、客户端加密、1/3 台设备、账号共用 10GB、恢复不重跑旧任务等约束；不擅自扩大同步范围、启动收费模型任务、push、部署或清理生产数据。按阶段精确提交，不混入别的任务改动。
