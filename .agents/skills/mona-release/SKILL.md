---
name: mona-release
description: Build, validate, and publish Mona Desktop Windows and macOS releases. Use for explicit Mona release requests; editing this skill does not authorize a release.
---

# Mona 发版

正式发布必须同时交付 Windows 和 macOS，并固定采用用户已选择的免费发布方式。Windows 交付 x64 NSIS 安装包、配套免费 Ed25519 `.exe.sig`、热更新包和经过线上验证的更新清单；macOS 默认交付 Apple Silicon ad-hoc 签名、未经 Apple 公证的 DMG，不构建 Intel x64 包。免费 Ed25519 签名用于防篡改，不是 Authenticode，不能宣称消除 SmartScreen；Mac ad-hoc 签名不等于 Developer ID 签名或 Apple 公证。单平台交付不算正式双端发布。修改本技能不执行构建、签名或发布。

用户已明确只使用免费发布方式：缺少 Apple Developer ID 或公证凭据时直接使用 `publish=ad-hoc`，不得每次发版再询问是否购买、配置 Apple 付费签名或是否允许未公证包。仅在已有可用且无需新增付费的正式签名、公证条件时使用 `publish=notarized`。官网下载说明必须明确 Mac 包未经公证及相应首次打开提示，不得声称已获 Apple 认可。

默认发布流程：识别全部未提交改动 → 按主题拆分提交 → 更新并提交本地更新日志 → 升版本并提交 → 打包与验收 → 上传产物 → 更新官网日志 → 更新清单并验证线上结果。明确要求发布即包含上述本地整理和提交步骤；不自动 push、打 tag、清理用户修改或升级依赖。签名是现有上传脚本的要求。已经明确授权发布时直接推进，不重复确认；授权范围外的同版本覆盖、降级或发布方式变更，才在产物可审阅后确认。

## 平台选择

- 用户明确要求“只打包/只验证”某个平台时，可以单独运行该平台构建，但不上传、不更新官网或线上清单。
- 用户要求发布、上线、上传或正式发版时，默认按本 Skill 的双端流程执行，即使用户只提到其中一个平台；不把单平台产物写成正式发布完成。
- Windows 和 macOS 共用同一版本、发布提交和更新说明。Windows 负责官网 Windows 下载、热更新包和 `update.json`；macOS 使用独立的 Apple Silicon DMG 下载对象。

## 双端正式发布门槛

1. 完成本机 Windows NSIS、`.exe.sig` 和热更新包构建，验收版本、哈希与 Ed25519 签名。此时暂不运行会写入官网日志或更新清单的完整上传 CLI。
2. 在 macOS GitHub Actions 中默认运行 `publish=ad-hoc`，构建并上传 Apple Silicon DMG；验证 App、Gateway、Office sidecar 的架构与签名完整性、DMG 内容及七牛公开下载 SHA-256。只有实际使用 `notarized` 时才要求通过公证验收。
3. 只有 Mac 阶段成功后，才运行 [references/windows-release.md](references/windows-release.md) 中的完整 Windows 发布 CLI。该步骤上传 Windows EXE、`.sig` 和热更新包，随后发布官网日志并最后更新 `update.json`。
4. 最后同时核对 Windows 安装包与 `.sig`、Windows 热更新清单，以及 macOS 版本化 DMG 的公开 URL 和 SHA-256。任一端构建、所选模式的签名验收、上传或公开下载校验失败，发布状态为未完成；ad-hoc 模式没有公证凭据不是失败。修复后从失败阶段续跑，不宣布单端成功为双端发版。

不得先运行 Windows 完整发布 CLI、再尝试 Mac：它会先发布官网日志并更新 Windows 清单，届时 Mac 失败会留下已对用户开放的半次发布。

## 整理提交与本地日志

- 在升版本和构建前，检查全部已暂存、未暂存及未跟踪改动，包括新增、修改、删除和重命名。结合 diff、引用和用途识别代码、测试、配置、资源及文档，不只处理本次会话改动。
- 按功能、修复或模块形成可解释的独立提交，相关实现、测试和文档一起提交；同一文件混有不同主题时按改动块拆分。逐批核对暂存 diff 后提交，不用一次 `git add .` 将所有内容混成一个提交，不覆盖或还原已有改动。
- 所有应入库改动均须归入提交。缓存、构建产物、临时文件和凭据不提交，保留并说明排除项；无法判断的重要改动先查清，必要时询问，不带着未整理的发布输入直接构建。
- 分类提交完成后，依据实际 diff 和提交记录更新仓库本地更新日志并单独提交。沿用已有日志路径和格式；没有独立本地日志时使用 `docs/guides/changelog.md`。先记入待发布条目，升版本时归入目标版本；内容覆盖本次改动，并核对上次发布以来已提交但未记录的变化。本地日志完成不等于官网已更新。
- 随后同步目标版本与本地日志版本标题，单独提交版本变更，记录此时 HEAD 作为构建和清单的 `git_hash`。构建前确认发布输入均已提交；剩余 dirty 项仅可为已核对的非发布输入。构建期间若发布输入变化，重新提交并重建受影响产物。

## 发布前定位

- 以当前 Mona 仓库为根目录。检查 Git 状态，记录 HEAD、dirty 状态和构建开始时间。未跟踪文件过多时先用 `git status --short --untracked-files=no`，再完整检查未跟踪项；此快捷检查不能替代全部改动盘点。按上一节完成提交后才构建，不把用户缓存或凭据打入包。
- 用户指定从 master 等发布分支工作、保留另一开发分支时，在独立 worktree 完成修改与构建，不切换或整理原开发目录。只纳入该发布分支需要的改动；收尾保留最终产物并清理本次临时 worktree，不擅自合并回开发分支。
- 阅读项目 `AGENTS.md`、`docs/architecture/engineering-boundaries.md`、`docs/architecture/runtime-component-management.md`、`docs/architecture/module-invariants.md`。路径和命令以当前源码为准。
- 核对 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`pyproject.toml` 的产品版本，以及 `src-tauri/Cargo.lock` 中本包版本。同步用户要求的版本，不全局替换依赖版本。WebUI 和 Office 子包的独立版本不要求同步。
- 读取 `https://www.mona-ai.cn/updates/update.json` 并保存旧清单用于诊断。用户未指定版本且仓库产品版本一致、高于线上时，使用仓库版本；否则先完成独立检查，再询问目标版本。不要自行覆盖同版本的不同字节或降级；线上读取失败不代表没有已发布版本。
- 热更新只在线上版本严格高于当前客户端时触发。同版本重打只适用于手动重装、误发布修复或尚未安装的用户；要给已安装的同版本客户端推送修复，必须发布更高版本，不能把版本判断改回“不相等即更新”。
- 检查项目 Python 环境、PyInstaller、Rust/Tauri、前端依赖和当前平台需要的签名工具。Windows 免费签名默认从 `%LOCALAPPDATA%\Mona\release-keys` 读取持久密钥；macOS 发布凭据使用 GitHub Secrets。只报告缺少的变量名，不输出值或文件内容。

正式发布必须依次读取 [references/windows-release.md](references/windows-release.md) 与 [references/macos-release.md](references/macos-release.md)；单平台本地打包时只读该平台对应部分。

## 构建同一份发布输入

顺序：分类提交 → 本地日志更新并提交 → 版本同步并提交与必要检查 → Office 构建资源准备 → Gateway 重建 → 签名与资源清单刷新 → NSIS 构建 → 热更新 staging → 压缩与哈希。

- 默认重建 Gateway 和桌面端。只有证明源文件、配置、依赖和资源与成功构建时一致才复用；时间戳只能辅助判断。构建期间输入改变时重建受影响产物。
- 使用根目录 `mona-gateway.spec`，核对真实输出后完整替换 `src-tauri/resources/mona-gateway/`，不合并旧输出而残留已删除模块。删除或移动前核对 resolved-path 范围、Git 状态及引用，只操作本次生成物。
- 新 Gateway 的 `--help` 必须通过，`--version` 必须等于目标产品版本。spec 从当前 `pyproject.toml` 生成独立的 `mona-ai` metadata 并排除打包环境的旧 metadata；不要用构建机器上已安装包的版本代替成品版本验收。
- Mona 是纯桌面客户端：生产前端只由 Tauri 的 `frontendDist` 嵌入。Gateway 资源及热更新包内不得带入 `mona/web/dist/` 网页前端副本；内部 HTTP/WebSocket 通信仍是桌面功能所需。不要把第二份前端当成网页访问功能保留。
- 核对内置 Skill 的按路径执行脚本已作为真实文件进入 Gateway，至少覆盖 PPT 导出、PDF helpers、Office helpers、技能创建和视频脚本及子模块。不能仅检查 Python import 是否成功；普通模块源码、测试、缓存和开发依赖不要随之全量拷入。
- Tauri 的 `beforeBuildCommand` 已运行 WebUI `build:tauri`，包括 Office 前端，不无理由重复完整构建。另行检查 `resources/office-editor/` 的清单、sidecar 平台/架构、大小及 SHA；前端构建不代表这些外置资源已生成。按需下载运行时不塞入安装包。
- 使用已核对的 `src-tauri/build-windows-release.ps1` 构建 NSIS，再对最终安装包生成并真实验证 Ed25519 `.exe.sig`。Office sidecar 不做 Authenticode 变异，manifest 大小与 SHA 必须在打包前精确匹配。构建必须显式仅 NSIS，避免额外 MSI/WiX。
- 使用独立 staging，把同次构建的 `mona-desktop.exe` 复制为根级 `Mona.exe`，把安装包内同一份 Gateway 复制为根级 `mona-gateway/`。Windows 免费签名覆盖最终 NSIS 安装包，不意味着主程序或 Gateway 获得 Authenticode 签名。不重命名原始构建产物。

### macOS 构建与发布

- 只通过 `.github/workflows/build-macos.yml` 构建 macOS 产物。`publish=none` 只生成 Actions artifact；免费正式发布使用 `publish=ad-hoc` 上传七牛；`publish=notarized` 是已有正式签名、公证条件时的可选模式。输入是这三个字符串，不使用 true/false。
- 只在 Apple Silicon runner 构建 `arm64` DMG，不构建 Intel x64 或 Universal DMG。内置 XLSX sidecar 的 manifest 必须为 `platform=macos`、`arch=arm64`，不匹配时拒绝发布。
- 每个 macOS 包必须使用目录模式的 `mona-gateway`，并在其 `_internal/desktop-resources/office-editor/` 中包含当前平台 sidecar、清单、模板和许可证。不得退回单文件 PyInstaller，也不得依赖未打包的 Python 运行时。
- macOS Apple Silicon 包通过所选模式的签名和资源验收后，才允许上传七牛。默认 ad-hoc 模式不运行公证门槛；对象使用版本化路径及独立 Mac 固定下载对象，不覆盖 Windows 的固定对象或更新清单。

## 发布验收门槛

- 检查本次明确路径的 NSIS、主程序版本及同名 `.exe.sig`，并执行真实密码学验签；不用目录里“最新文件”猜测产物。
- 用 `scripts/build_update_package.py` 打包后实际读取归档，检查根级 `Mona.exe`、`mona-gateway/mona-gateway.exe`、必需资源，并对解包后的 Gateway 做 smoke test。脚本会清理 staging，且不验证版本参数，退出码不等于内容验收。
- Office 的模板、许可证、sidecar 及清单必须位于 `mona-gateway/_internal/desktop-resources/office-editor/`。安装包与热更新复用同一份 Gateway 资源树，旧更新器复制 Gateway 时也会带上 Office。发布版 Services 必须读取这份资源，不能回退到旧安装遗留的独立 Office 目录。用旧更新器的目录复制行为验证升级，不仅测试全新安装。
- 记录两个最终产物的路径、字节数、SHA-256、版本、HEAD 和 dirty 状态；签名、重打包或修改后重新计算哈希。
- 按实际改动运行相关测试与构建检查。相同输入的已有验证可复用，不为了发版重复全量测试，不把 `--help` 描述为完整运行验收。

## 上传、恢复与线上验证

本节的 `release_upload.py`、官网日志与 `update.json` 步骤只适用于 Windows 发布。macOS 的七牛上传和公共下载 SHA-256 校验按 [references/macos-release.md](references/macos-release.md) 执行，且不会改写 Windows 更新渠道。

- 上传前说明具体版本、产物及检查结果。复用 `scripts/release_upload.py`。完整 CLI 依次覆盖 `Mona-latest.exe` 与 `Mona-latest.exe.sig`、上传版本包、发布官网日志、改写清单，不能试跑或用于部分失败后的整流程重试。
- 两个对象上传成功且公共下载内容与本地一致后才更新清单。用参考文件的函数入口分阶段执行；它支持清单前验证和失败续跑，不必重写上传器。
- 单次上传超时后先核对远端对象，跳过已成功对象，仅重试未完成对象。可设置七牛连接超时为 600 秒；一次针对性重试仍失败时报告阶段与原因并保留产物，不盲目循环。
- 每次发布都必须从已完成的本地日志提炼面向用户的更新条目 JSON 文件，保持版本和事实一致。调用 `scripts/release_upload.py` 时传入 `--changelog-items-file`；它会更新 `official-site/public/changelog.json`、构建官网静态站点、备份并原子切换 VPS 站点。两个下载对象和官网更新日志成功后，才允许写入 `update.json`。官网日志在本地仓库产生的应入库变更单独提交为发布记录，不将这个构建后提交冒充产物的 `git_hash`。
- 清单写入失败或结果不确定时，先读线上清单，再补做必要阶段。不要自动回滚已上线版本，或通过重传大文件解决清单故障。
- 最后 GET 公共清单，比对 `version`、`url`、`size`、`sha256`、`git_hash`；两条下载链接 HEAD 大小须匹配。下载最终公共 URL 的字节计算 SHA-256，尤其注意固定安装包 URL 或曾覆盖的同版本 URL。再获取 `/changelog` 的当前静态 bundle，确认页面包含本次版本；只看到 `changelog.json` 文件更新不足以证明用户页面已经更新。
- CDN 返回旧内容时报告尚未生效；prefetch 成功不代表缓存刷新或内容验证通过。不得将“上传成功”写成“发布完成”。

交付简述分类提交、本地日志路径、版本、下载链接、验证结果和未完成阶段。列出仍未提交的排除项，清单 `git_hash` 必须对应实际构建输入的提交。




