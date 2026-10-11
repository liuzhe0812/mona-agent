# macOS 发布

## 构建模式

macOS 只使用仓库 `.github/workflows/build-macos.yml`。该流程仅在 `macos-15` Apple Silicon runner 构建，产物为 `Mona-macOS-arm64` Actions artifact。不要增加 Intel x64 或 Universal 构建。

用 `publish=none` 做单平台排错时，确认 artifact 同时包含 App 与同版本 arm64 DMG。Gateway 和 XLSX sidecar 必须都是 Apple Silicon 原生构建；此模式不上传。正式免费发布使用 `publish=ad-hoc`。

工作流使用根目录 `mona-gateway.spec` 的目录模式输出。验收 App 内同时存在 Gateway、Office 清单和当前架构 sidecar；仅有 DMG 文件或 Tauri 主程序不算打包通过。

## 对外发布

正式双端发布中，Windows NSIS、`.exe.sig` 和热更新包已完成本地构建及验收后，以 `publish=ad-hoc` 手动运行本流程。用户已固定选择免费方式，允许公开发布未公证 Mac 包；不要再次询问 Apple 付费开发者账户或公证凭据。这个阶段只准备、上传和验证 Mac 包；随后仍须回到 Windows 发布步骤上传 Windows 产物、官网日志及 `update.json`。Mac 单独上传不构成正式发布。

免费模式仅需要 GitHub Secrets：`QINIU_AK`、`QINIU_SK`、`QINIU_BUCKET`、`QINIU_DOMAIN`。它使用 `codesign` ad-hoc 签名，并验证内置二进制的架构、资源和签名完整性；不要求 Apple Developer ID、公证或 Gatekeeper 自动信任。官网下载说明应写明“未经过 Apple 公证”，首次打开遵循 macOS 针对单个应用的允许打开流程，不引导用户全局关闭系统安全检查。

首次尝试打开被拦截后，可按 [Apple 官方说明](https://support.apple.com/zh-cn/102445) 到“系统设置 → 隐私与安全性”针对该应用选择“仍要打开”。不要保证所有 macOS 版本都能通过访达右键直接放行。

只有已有无需新增付费的正式签名、公证条件时，才可选 `publish=notarized`，需要以下 GitHub Secrets：

- `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`
- `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`、`KEYCHAIN_PASSWORD`
- `QINIU_AK`、`QINIU_SK`、`QINIU_BUCKET`、`QINIU_DOMAIN`

缺少 Apple 变量时继续默认 ad-hoc 发布，不将它作为阻塞项。缺少 Qiniu 凭据则报告具体变量名，不输出值。

工作流在所选模式下构建并验证 Apple Silicon DMG，使用 `.github/scripts/upload_qiniu_artifact.py` 上传。只有 notarized 模式才导入 Developer ID 证书并进行公证。构建 Job 成功后发布 Job 才开始。上传 key 为：

```text
macos/<version>/Mona_<version>_arm64.dmg
macos/Mona-latest.dmg
```

上传后从 `QINIU_DOMAIN` 下载每个文件并比对 SHA-256。上传或公共下载验证失败时，保留 Actions artifact，报告已完成的架构和对象；不要改写 Windows 的 `Mona-latest.exe`、Windows 热更新包或 `update.json`。

## 交付

报告版本、构建提交、Apple Silicon Actions artifact、七牛下载地址、所用签名模式及任何未完成阶段。ad-hoc 发布明确标为“免费 ad-hoc 签名，未经过 Apple 公证”；仅构建模式明确说明还未上传。不得将 ad-hoc 签名包装成 Apple 正式签名或公证。
