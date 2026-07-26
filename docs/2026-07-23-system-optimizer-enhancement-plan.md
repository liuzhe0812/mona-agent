# 系统优化增强方案：对标 hellzerg/optimizer

> 对标仓库：[hellzerg/optimizer](https://github.com/hellzerg/optimizer)（v16.7，已 archive）
> 立项时间：2026-07-23
> 范围：在现有 [src-tauri/src/system/](../src-tauri/src/system/) 基础上，补齐 optimizer 的高频 Win 优化能力

## 一、背景

Mona 现有系统模块在**监控、软件管理、启动项、诊断、维护审计、AI 协助**六条线已领先 optimizer。但在**网络优化、性能微调、右键菜单、进程控制、注册表修复、Defender 控制**六个方向存在空白或薄弱。本方案逐一补齐，原则：

- 复用现有 win11debloat 的 feature 目录 + apply/restore/风险分级机制，零新代码路径优先
- 所有变更必须可记录到 `maintenance_events`，可回滚的必须支持 restore
- 提权操作走 `run_elevated`（ShellExecuteExW + runas），不静默失败
- 与 [project_rules.md](../.trae/rules/project_rules.md) 安全边界一致

## 二、能力清单与落点

| # | 模块 | 后端落点 | 前端落点 | 是否可回滚 |
|---|------|---------|---------|-----------|
| P1 | 网络优化套件 | `src-tauri/src/system/network.rs`（新建） | `NetworkPanel.tsx`（新建） | DNS 是，HOSTS 增删是，flushdns N/A |
| P2 | 性能微调 | win11debloat `Features.json` 追加 | 现有 SystemOptimizationPanel | 是 |
| P3 | 右键菜单集成 | win11debloat `Features.json` 追加 | 现有 SystemOptimizationPanel | 是 |
| P4 | 进程黑名单 + 文件锁句柄 | `src-tauri/src/system/process_control.rs`（新建） | `ProcessControlPanel.tsx`（新建） | 进程黑名单是，文件锁 N/A |
| P5 | 注册表修复模式 | `src-tauri/src/system/repair.rs`（新建） | 现有 diagnostics 面板新增"系统完整性修复"分组 | 是 |
| P6 | 禁用/启用 Defender | `src-tauri/src/system/defender.rs`（新建） | 设置页"高级"区域，需二次确认 + 风险声明 | 是（需安全模式） |

## 三、模块详解

### P1. 网络优化套件

**功能**
- DNS 一键切换：预设 Cloudflare(`1.1.1.1`)/OpenDNS(`208.67.222.222`)/Quad9(`9.9.9.9`)/Google(`8.8.8.8`)/Adguard(`94.140.14.14`)/CleanBrowsing(`185.228.168.9`)/AlternateDNS/自定义
- DNS 缓存刷新：`ipconfig /flushdns`
- HOSTS 编辑器：Block(→`0.0.0.0`)/Add/Remove 域名，可选 `www.` CNAME 自动补全

**技术实现**
- DNS 切换：`netsh interface ip set dns name="<适配器>" source=static addr=<primary> validate=no` + `netsh interface ip add dns name="<适配器>" addr=<secondary> index=2 validate=no`。需列举所有物理适配器（`Get-NetAdapter -Physical`），逐个设置。提权走 `run_elevated`
- 当前 DNS 读取：`Get-DnsClientServerAddress -AddressFamily IPv4`，按接口返回
- flushdns：`run_hidden("ipconfig.exe", &["/flushdns"])`
- HOSTS 文件：`C:\Windows\System32\drivers\etc\hosts`，读写前备份到 `Mona-HostsBackup-<ts>.bak`（与 win11debloat start2.bin 备份同款机制）。增删改按行匹配，保留原注释
- 适配器名含中文，PowerShell 输出需走 `decode_windows_output`

**数据结构**
```rust
pub struct DnsPreset { id, label, primary_v4, secondary_v4, primary_v6, secondary_v6 }
pub struct DnsStatus { adapter, primary, secondary, is_custom }
pub struct HostsEntry { domain, ip, source: "user"|"system", blocked: bool }
pub struct HostsEditResult { added, removed, blocked, unblocked, backup_path }
```

**Tauri 命令**
- `system_list_dns_presets` / `system_get_dns_status` / `system_set_dns(preset_id_or_custom, adapter?)` / `system_reset_dns(adapter?)`
- `system_flush_dns`
- `system_list_hosts_entries` / `system_edit_hosts(add, remove, block, unblock, include_www)`

**风险分级**：low（DNS 可随时改回，HOSTS 有备份）

**回滚**：DNS restore = `system_reset_dns`；HOSTS restore = 从最新备份复制

---

### P2. 性能微调

**功能**（全部作为 win11debloat feature 追加，复用现有机制）
- `SvchostSplitDisable`：禁用 svchost 进程拆分，减少进程数降 RAM。注册表 `HKLM\SYSTEM\CurrentControlSet\Control\SvcHostSplitDiscriminator` = RAM GB 数（如 8GB → `8`）。需提权
- `DisableHPET`：禁用高精度事件计时器，游戏场景减延迟。`bcdedit /deletevalue useplatformclock`，需提权 + 重启
- `UnlockCpuCores`：解锁 CPU 核心数限制（注册表 `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power\EnergyEstimationEnabled` 等，按 optimizer 实际规则填充）

**技术实现**
- 在 [Features.json](../src-tauri/src/system/win11debloat/Features.json) 追加 3 个 feature，category = `"System"` 或新建 `"Performance"`
- `SvchostSplitDisable` 的 apply 需要动态计算 RAM（`sysinfo::System::total_memory()`），不能写死。在 [win11debloat.rs](../src-tauri/src/system/win11debloat.rs) 的 `apply_feature` 增加 special case：`"SvchostSplitDisable" => set_svchost_split(ram_gb)`，内部走 `run_elevated_powershell`
- `DisableHPET` 走 `run_elevated("bcdedit.exe", "/deletevalue {current} useplatformclock", ...)`，restore 用 `/setvalue useplatformclock HighPrecisionEventTimer`
- feature_risk 标记 `medium`（HPET）或 `low`（svchost），requires_reboot = true（HPET）

**回滚**：svchost 用 `/resetsvchostsplit` 等价逻辑（删除 SvcHostSplitDiscriminator 值）；HPET 用 bcdedit setvalue 恢复

---

### P3. 右键菜单集成

**功能**（同样作为 win11debloat feature 追加）
- `AddTakeOwnership`：右键"取得所有权"。注册表 `HKCR\*\shell\runas` + `HKCR\Directory\shell\runas` + `HKCR\Directory\Background\shell\runas`，command = `powershell -command "start-process cmd -argumentlist '/c takeown /f \"%1\" && icacls \"%1\" /grant administrators:F' -verb runAs"`
- `AddOpenCmdHere`：右键"在此处打开 CMD"。`HKCR\Directory\shell\cmd`（需先 remove 用户权限限制）或 `HKCR\Directory\Background\shell\cmd`
- `AddCopyPath`：右键"复制为路径"（Windows 11 已内置，可作为低版本补丁，feature 加 min_version 限制）

**技术实现**
- Features.json 追加，registry_key 指向新建的 reg 文件（如 `TakeOwnership.reg` + `Undo/TakeOwnership.reg`），放入 [win11debloat/RegistryFiles.json](../src-tauri/src/system/win11debloat/RegistryFiles.json)
- feature_risk = `low`，reversible = true
- validate_catalog 的硬编码数量断言需更新（当前 93 features，追加后 96）

**回滚**：每个 feature 都有 Undo reg 文件，走 `import_registry(feature, "restore")`

---

### P4. 进程黑名单 + 文件锁句柄

**功能**
- 进程黑名单：阻止指定 exe 运行（如游戏屏蔽、专注模式）。通过 IFEO（Image File Execution Options）`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\<exe>\Debugger` 设为不存在的程序。**注意：这是激进手段，需要明确风险提示**
- 进程白名单恢复：从 IFEO 删除对应键
- 文件锁句柄：列出占用指定文件/目录的进程句柄，支持终止。用于"文件被占用无法删除"场景

**技术实现**
- 进程黑名单：
  - 列表：枚举 IFEO 下所有子键 + 过滤出 Mona 创建的（用 `Debugger` 值含 `Mona-Block` 标记区分，避免误删第三方 IFEO 劫持）
  - 阻止：`HKLM\...\Image File Execution Options\<exe>` 新建 `Debugger` = `"C:\Windows\System32\systray.exe" /*Mona-Block*/`（指向无害进程 + Mona 标记）。提权
  - 恢复：删除子键。提权
  - 记录到 `maintenance_events`
- 文件锁句柄：
  - 不依赖 `handle.exe`（外部依赖）。Rust 侧用 `windows` crate 的 `NtQuerySystemInformation` + `SystemHandleInformation` 枚举系统句柄，匹配文件路径。实现成本较高，**建议用 PowerShell 的 `Get-Process | ForEach-Object { $_.Modules }` 近似匹配，或调用 `OpenFiles.exe /query`（Windows 内置）**
  - 终止：`Stop-Process -Id <pid> -Force`

**数据结构**
```rust
pub struct BlockedProcess { exe_name, added_at, reversible: true }
pub struct FileLockHolder { pid, name, handle_count, can_terminate }
```

**Tauri 命令**
- `system_list_blocked_processes` / `system_block_process(exe_name)` / `system_unblock_process(exe_name)`
- `system_find_file_locks(path)` / `system_terminate_lock_holder(pid)`

**风险分级**：进程黑名单 `high`（IFEO 是恶意软件常用手段，误操作会导致程序无法启动）；文件锁 `medium`

**安全约束**：
- 进程黑名单 UI 必须二次确认 + 显示"这将阻止 <exe> 启动，恢复方式：从此列表删除"
- 不允许阻止系统关键进程（`explorer.exe`/`svchost.exe`/`csrss.exe` 等白名单）
- 文件锁终止进程前显示进程名、PID、可执行路径，确认后执行

---

### P5. 注册表修复模式

**功能**（区别于 win11debloat 的"优化"，这里是"修复被破坏的系统组件"）
- 修复被恶意软件禁用的 Windows Defender 服务（恢复 `HKLM\SYSTEM\CurrentControlSet\Services\WinDefend` Start = 2）
- 修复被禁用的 UAC（`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\EnableLUA` = 1）
- 修复被禁用的注册表编辑器（`HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System\DisableRegistryTools` = 0）
- 修复被禁用的任务管理器（`HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System\DisableTaskMgr` = 0）
- 修复被禁用的 CMD（`HKCU\Software\Policies\Microsoft\Windows\System\DisableCMD` = 0）
- 修复被劫持的浏览器主页（重置 `HKCU\Software\Microsoft\Internet Explorer\Main\Start Page`）

**技术实现**
- 新建 `src-tauri/src/system/repair.rs`
- 每个修复项定义为一个 `RepairItem`，包含 id、label、检测函数（读注册表判断是否被破坏）、修复函数（写注册表）、风险
- 检测只读，不提权；修复按需提权（HKCU 不需要，HKLM 需要）
- 在 [diagnostics.rs](../src-tauri/src/system/diagnostics.rs) 的 `system_check_*` 系列旁新增 `system_check_system_integrity`，返回所有 RepairItem 的检测结果
- 前端在现有诊断面板新增"系统完整性"分组，列出被破坏项 + 一键修复按钮

**数据结构**
```rust
pub struct RepairItem {
    id, label, description,
    is_broken: bool,  // 检测结果
    risk: "low"|"medium",
    requires_administrator: bool,
    can_repair: bool,
}
pub struct RepairResult { item_id, success, detail, requires_restart }
```

**Tauri 命令**
- `system_check_system_integrity` → `Vec<RepairItem>`
- `system_repair_item(item_id)` → `RepairResult`

**风险分级**：整体 `low`（恢复系统默认值），但 Defender 服务恢复需重启

---

### P6. 禁用/启用 Windows Defender

**功能**
- 禁用 Defender 实时保护（仅 Win10 1903+ 需安全模式）
- 启用 Defender
- 自动重启到安全模式 → 执行 → 重启回正常模式

**技术实现**
- 新建 `src-tauri/src/system/defender.rs`
- 禁用逻辑：`HKLM\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection\DisableBehaviorMonitoring` = 1 + `DisableOnAccessProtection` = 1 + `DisableScanOnRealtimeEnable` = 1 + `DisableAntiSpyware` = 1（注意：`DisableAntiSpyware` 在 1903+ 客户端被忽略，需配合安全模式 + `Set-MpPreference -DisableRealtimeMonitoring $true`）
- 启用逻辑：删除上述注册表值 + `Set-MpPreference -DisableRealtimeMonitoring $false`
- 安全模式切换：`bcdedit /set {current} safeboot minimal` → 重启 → 执行 → `bcdedit /deletevalue {current} safeboot` → 重启
- **必须二次确认 + 风险声明弹窗**：明确告知"这将降低系统安全性，建议仅在安装第三方杀毒软件后操作"

**Tauri 命令**
- `system_get_defender_status` → `{ realtime_enabled, is_managed_by_policy, can_control }`
- `system_disable_defender(restart_to_safe_mode: bool)` → 触发提权 + 可选安全模式流程
- `system_enable_defender()`

**风险分级**：`critical`（最高级，UI 必须红色警告 + 强制勾选"我已了解风险"）

**安全约束**：
- Defender 状态变更必须在维护历史里记录，category = `"安全"`
- 检测到已安装第三方杀毒软件（通过 `Get-CimInstance -Namespace root\SecurityCenter2 -ClassName AntiVirusProduct`）时，UI 提示"检测到第三方杀毒软件，禁用 Defender 通常是安全的"
- 检测到未安装第三方杀毒软件时，UI 强制要求用户勾选"我确认没有其他杀毒软件保护"才能继续

---

## 四、执行计划

### 阶段 1：网络优化套件（P1）

**目标**：补齐 DNS/HOSTS/flushdns，最有用户价值

**任务**
1. 新建 `src-tauri/src/system/network.rs`，实现 DNS 预设列表、状态读取、切换、重置、flushdns
2. 实现 HOSTS 文件读写（带备份）、增删改、Block/Unblock
3. 在 [lib.rs](../src-tauri/src/lib.rs) 注册 6 个 Tauri 命令
4. 新建 `webui/src/components/system/NetworkPanel.tsx`，三个分区：DNS 切换 / DNS 缓存 / HOSTS 编辑器
5. 在 [SystemView.tsx](../webui/src/components/system/SystemView.tsx) 的 tab 列表新增"网络"
6. 单元测试：DNS 预设解析、HOSTS 行解析/备份逻辑、适配器名中文解码
7. 集成测试：DNS 切换后 `Get-DnsClientServerAddress` 验证生效

**验收**：能切换 DNS、刷新缓存、增删 HOSTS 条目，操作记录出现在维护历史

### 阶段 2：性能微调（P2）

**目标**：svchost/HPET/解锁核心，零新代码路径

**任务**
1. 在 [Features.json](../src-tauri/src/system/win11debloat/Features.json) 追加 3 个 feature
2. 在 [win11debloat.rs](../src-tauri/src/system/win11debloat.rs) 的 `apply_feature` 增加 3 个 special case（svchost 动态 RAM、HPET bcdedit、UnlockCpuCores 注册表）
3. 在 [RegistryFiles.json](../src-tauri/src/system/win11debloat/RegistryFiles.json) 追加对应 reg + Undo reg
4. 更新 [win11debloat.rs](../src-tauri/src/system/win11debloat.rs) 的 `validate_catalog` 硬编码数量断言（93 → 96）
5. 更新 [diagnostics.rs](../src-tauri/src/system/diagnostics.rs) 的 `exposes_the_complete_pinned_win11debloat_catalog` 测试
6. 前端无需改动，自动出现在 SystemOptimizationPanel

**验收**：3 项 feature 可应用、可恢复，维护历史有记录

### 阶段 3：右键菜单集成（P3）

**目标**：Take Ownership / Open CMD Here / Copy Path

**任务**
1. 编写 3 组 reg + 3 组 Undo reg，追加到 [RegistryFiles.json](../src-tauri/src/system/win11debloat/RegistryFiles.json)
2. Features.json 追加 3 个 feature，category = `"File Explorer"`
3. 更新 validate_catalog 数量断言（96 → 99）
4. Copy Path 加 min_version 限制（仅 Win10 旧版本显示）
5. 测试断言更新

**验收**：右键菜单出现/消失，可恢复

### 阶段 4：注册表修复模式（P5）

**目标**：系统完整性检查与修复

**任务**
1. 新建 `src-tauri/src/system/repair.rs`，定义 6 个 RepairItem（Defender 服务、UAC、注册表编辑器、任务管理器、CMD、浏览器主页）
2. 实现检测函数（只读注册表）和修复函数（按需提权）
3. 在 [lib.rs](../src-tauri/src/lib.rs) 注册 `system_check_system_integrity` + `system_repair_item`
4. 前端在诊断面板（[OverviewPanel.tsx](../webui/src/components/system/OverviewPanel.tsx) 或新增 IntegrityPanel）新增"系统完整性"分组
5. 单元测试：每个 RepairItem 的检测逻辑（mock 注册表状态）
6. 记录到 `maintenance_events`，category = `"修复"`

**验收**：能检测出被破坏项，一键修复生效，维护历史有记录

### 阶段 5：进程黑名单 + 文件锁句柄（P4）

**目标**：进程控制与文件锁解除

**任务**
1. 新建 `src-tauri/src/system/process_control.rs`
2. 实现进程黑名单（IFEO + Mona-Block 标记），含系统关键进程白名单
3. 实现文件锁句柄查询（`OpenFiles.exe /query` 解析 或 PowerShell `Get-Process` + 模块匹配）
4. 在 [lib.rs](../src-tauri/src/lib.rs) 注册 5 个命令
5. 新建 `webui/src/components/system/ProcessControlPanel.tsx`，两分区：进程黑名单 / 文件锁
6. 进程黑名单 UI 强制二次确认 + 系统进程白名单校验
7. 单元测试：IFEO 解析、白名单校验、Mona-Block 标记识别
8. 记录到 `maintenance_events`，category = `"进程"`

**验收**：能阻止 exe 启动、能恢复、能查询文件锁并终止进程

### 阶段 6：禁用/启用 Defender（P6）

**目标**：安全可控的 Defender 控制

**任务**
1. 新建 `src-tauri/src/system/defender.rs`
2. 实现 `system_get_defender_status`（读 `Get-MpComputerStatus` + 注册表策略）
3. 实现 `system_disable_defender` / `system_enable_defender`（注册表 + `Set-MpPreference`）
4. 实现安全模式自动重启流程（`bcdedit /set safeboot` → 重启 → 执行 → `bcdedit /deletevalue` → 重启），通过临时标记文件跨重启传递状态
5. 第三方杀毒软件检测（`Get-CimInstance -Namespace root\SecurityCenter2`）
6. 在 [lib.rs](../src-tauri/src/lib.rs) 注册 3 个命令
7. 前端在设置页"高级"区域新增 Defender 控制入口，强制二次确认 + 风险声明 + 第三方杀软检测提示
8. 记录到 `maintenance_events`，category = `"安全"`，red 级别高亮
9. 单元测试：状态解析、第三方杀软检测、安全模式标记文件逻辑

**验收**：能读取状态、能禁用/启用（含安全模式流程）、操作有醒目记录

---

## 五、跨阶段共性工作

1. **lib.rs 命令注册**：每个新模块的 `#[tauri::command]` 需在 [lib.rs](../src-tauri/src/lib.rs) 的 `invoke_handler!` 注册
2. **维护历史**：所有写操作必须调用 maintenance 的记录函数，category 按模块区分
3. **提权封装**：统一走 [mod.rs](../src-tauri/src/system/mod.rs) 的 `run_elevated`，不重复造轮子
4. **i18n**：新增 UI 文案同步到 [locales/en/common.json](../webui/src/i18n/locales/en/common.json)
5. **测试**：每个新模块必须有 `#[cfg(test)] mod tests`，覆盖解析逻辑和边界条件

## 六、不在范围内

- SHODAN IP 搜索（偏离桌面优化定位）
- 多语言扩展（按需，不对齐 optimizer 的 24 种）
- 模板自动化（Mona 已有 AI 协助，优于静态 JSON 模板）
- 硬件检测工具（Mona 已有 [mod.rs](../src-tauri/src/system/mod.rs) 的 SystemOverview）
- UWP 批量卸载（Mona 已有 [software.rs](../src-tauri/src/system/software.rs) 的 WinGet 卸载 + 残留审查，更安全）

## 七、风险与缓解

| 风险 | 缓解 |
|------|------|
| IFEO 进程黑名单被误用为恶意手段 | Mona-Block 标记 + 系统进程白名单 + 维护历史可追溯 |
| Defender 禁用后用户无防护 | 第三方杀软检测 + 强制风险声明 + 维护历史红色高亮 |
| HOSTS 编辑破坏网络 | 自动备份 + 一键恢复 |
| HPET 禁用导致系统不稳定 | 标记 medium 风险 + requires_reboot + 可恢复 |
| 安全模式重启流程卡住 | 临时标记文件 + 超时检测 + 提供手动恢复命令 |

## 八、验收总标准

1. 6 个模块全部可独立使用，互不依赖
2. 所有写操作在维护历史有记录，可回滚的必须支持 restore
3. 所有提权操作走 `run_elevated`，不静默失败
4. 单元测试覆盖率 ≥ 现有 system 模块水平
5. UI 符合 [ui-spec.md](../.trae/rules/ui-spec.md)，使用项目组件库，无浏览器原生控件
6. 不引入外部可执行文件依赖（如 handle.exe），全部用 Windows 内置命令或 Rust crate
