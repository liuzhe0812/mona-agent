# Windows 发布命令与续跑

相对路径以 Mona 仓库根目录为起点，使用 PowerShell。变量须从本次实际路径赋值；Python 使用已有项目环境。先核对当前脚本，不临时升级全部依赖。

## Gateway 与签名构建

先准备 `src-tauri/resources/office-editor/` 的清单、当前平台 sidecar、三个空白模板和许可证。根目录 `mona-gateway.spec` 将它们一起放入 Gateway 的 `_internal/desktop-resources/office-editor/`，无需再手工往热更新包加独立 Office 目录。

根目录 spec 与 `src-tauri/mona-gateway.spec` 不同，不因名称相同互换。根目录 spec 默认输出 `dist/mona-gateway/`；可指定独立输出避免混入旧产物：

```powershell
$ErrorActionPreference = 'Stop'
& $releasePython -m PyInstaller --noconfirm --clean --distpath $gatewayDist --workpath $gatewayWork mona-gateway.spec
if ($LASTEXITCODE -ne 0) { throw 'Gateway build failed' }
```

把新 onedir 输出完整放入 `src-tauri/resources/mona-gateway/`，运行其中的 `mona-gateway.exe --help`。检查技能脚本和内置 Office 目录存在，并确认 `_internal/mona/web/dist/` 不存在。不将该目录直接用作热更新 staging，因为打包函数会清理测试和缓存文件。

## 免费 Ed25519 签名与固定密钥

Mona 复用 OE-Claw 的免费 Tauri/Minisign Ed25519 更新签名。它证明安装包字节未被替换，不是 Windows Authenticode，不会显示受信任发布者，也不能保证消除 SmartScreen。

2026-09-22 用户已授权初始化 Mona 长期发布密钥，后续版本复用同一对：

- 固定目录：`%LOCALAPPDATA%\Mona\release-keys`
- 当前机器路径通过 PowerShell `Join-Path $env:LOCALAPPDATA 'Mona\release-keys'` 解析，不在项目文件中固定个人账户目录。
- 私钥：`mona-update.key`
- 公钥：`mona-update.key.pub`
- 口令文件：`mona-update.key.password`
- Key ID：`5394c143d085143b`
- 42 字节公钥包 SHA-256：`6a5e0ce1de7c921b42f30de5f99cfbffefb19956e3af44df4b4b4dd15f8fba26`

私钥和口令文件绝不进入仓库、Skill、日志或聊天；路径、Key ID 和公钥指纹可以记录。该目录 ACL 仅当前用户、SYSTEM、Administrators。迁移机器时恢复三个文件并恢复 ACL；本机持久目录不等于异机备份。

`src-tauri/release-signing.mjs` 自动读取固定目录，也支持显式覆盖：`MONA_RELEASE_KEY_DIR`、`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`MONA_UPDATE_PUBLIC_KEYS`。禁止构建时自动生成或覆盖密钥。`src-tauri/init-release-signing-key.ps1` 只用于用户明确授权的首次初始化或轮换，并会拒绝覆盖已有文件。

使用免费签名构建入口：

```powershell
& ./src-tauri/build-windows-release.ps1
```

该入口校验 Office 清单，显式构建 NSIS，然后用 `src-tauri/sign-update-artifact.mjs` 对最终安装包签名、验签并规范化同名 `.exe.sig`。签名后改动安装包任何字节都必须验签失败。不要用全目录扫描到的旧安装包冒充当次构建。

签名失败不得删除 `.sig` 门槛或绕过上传前验签。原生程序失败需显式检查退出码。`-NoBundle` 只用于已有明确要求的无安装包构建，不代表完整发布。

默认主程序为 `src-tauri/target/release/mona-desktop.exe`，安装包在 `src-tauri/target/release/bundle/nsis/`。有自定义 target dir 时以入口实际支持和真实输出为准。核对平台架构和目标版本。

把同次构建的主程序复制为 staging 根级 `Mona.exe`，把完整 Gateway 复制为根级 `mona-gateway/`。staging 只含这两项，输出文件必须在 staging 外：

```powershell
& $releasePython scripts/build_update_package.py $releaseVersion $releaseStaging $releaseArchive
if ($LASTEXITCODE -ne 0) { throw 'Update packaging failed' }
Get-FileHash -Algorithm SHA256 -LiteralPath $releaseInstaller, $releaseArchive
```

热更新构建会在写出前检查 Office 完整性与 sidecar 哈希、文件路径及重复 WebUI；验证失败时修复构建输入，不绕过检查。安装包和热更新必须使用同次构建的同一份 Gateway，后续若修改资源需要重新打包两份产物；免费 Ed25519 `.sig` 对最终 NSIS 安装包验签，不给 Gateway 或主程序添加 Authenticode。

## 分阶段上传与恢复

正式双端发布时，先完成本节前述 Windows 本地构建、免费签名与热更新包验收，然后执行 [macOS 发布](macos-release.md)，默认使用已获用户授权的免费 `publish=ad-hoc`，并验证 Apple Silicon DMG 已可从七牛下载。Mac 成功前不要运行下面的完整 Windows 上传 CLI；Mac 通过后再继续本节，以便官网日志和 Windows 更新清单在两端产物均可用后再更新。

完整 CLI 有六个位置参数，且必须提供更新条目 JSON 文件，无 dry-run/resume 参数：

```powershell
& $releasePython scripts/release_upload.py $releaseVersion $releaseInstaller $releaseArchive $releaseSha $releaseNotes $releaseGitHash --changelog-items-file $releaseChangelogItems
```

更新条目文件是一个非空 JSON 字符串数组，只写用户可感知的变化。完整 CLI 会依次上传两个产物、构建并以备份切换官网静态站点、更新清单。需要先验证公共下载或恢复部分上传时，用短小的一次性 Python 入口导入现有脚本，仅调用仍需执行的阶段。通过 argv 传路径，不拼接 shell 字符串，不在临时文件写凭据。

```python
import qiniu.config
from scripts import release_upload as release

qiniu.config.set_default(connection_timeout=600)
release.upload_to_qiniu(local_path, object_key)
```

安装包 key 为 `Mona-latest.exe`，签名 key 为 `Mona-latest.exe.sig`，热更新包 key 为包文件名。CLI 会调用 Node 验签器确认 `.sig` 与安装包字节匹配。直接调用上传函数会绕过该门槛，须先执行相同验签。超时先查远端，再决定是否重传。

两份公共对象验证通过后，先调用 build_and_publish_changelog，确认官网 changelog 已显示本次版本；随后才单独调用：

```python
release.update_vps_manifest(
    version=version,
    update_pkg_filename=archive_name,
    sha256_hash=sha256,
    size=size,
    notes=notes,
    git_hash=git_hash,
)
```

`notes` 是清单里的简短中文更新说明，从发布前已更新并提交的本地日志提炼；官网更新条目使用同一份已核实事实。它不能替代本地日志，也不要求调用 AI 生成脚本。多行内容用结构化参数或真实临时文件传递。

脚本从已有环境或根目录 `.env` 加载 `QINIU_AK`、`QINIU_SK`、`QINIU_BUCKET`、`QINIU_DOMAIN`、`VPS_HOST`、`VPS_PASSWORD`。只核对存在性，不打印值。下载地址使用实际配置域名，不照搬历史示例。

当前清单是直接写入；连接中断可能留下不完整 JSON。读回确认后仅恢复清单阶段，别重新上传成功的大文件。线上校验要访问实际公共 URL，prefetch 不可当成 CDN 刷新成功的证据。

当前版本与线上版本不相等不是更新判断。客户端只在线上版本严格高于当前版本时下载，避免 CDN 旧清单把新客户端误判为需要降级。相同版本的重发不会触发已安装客户端的热更新；只能供手动重装或未安装用户使用。

