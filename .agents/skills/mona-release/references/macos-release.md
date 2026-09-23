# macOS 发布

## 构建模式

macOS 只使用仓库 `.github/workflows/build-macos.yml`。该流程仅在 `macos-15` Apple Silicon runner 构建，产物为 `Mona-macOS-arm64` Actions artifact。不要增加 Intel x64 或 Universal 构建。

用 `publish=false` 做单平台排错时，确认 artifact 同时包含 App 与同版本 arm64 DMG。Gateway 和 XLSX sidecar 必须都是 Apple Silicon 原生构建；此模式不是发布。

工作流使用根目录 `mona-gateway.spec` 的目录模式输出。验收 App 内同时存在 Gateway、Office 清单和当前架构 sidecar；仅有 DMG 文件或 Tauri 主程序不算打包通过。

## 对外发布

正式双端发布中，Windows NSIS、`.exe.sig` 和热更新包已完成本地构建及验收后，以 `publish=notarized` 手动运行本流程。这个阶段只准备、上传和验证 Mac 包；随后仍须回到 Windows 发布步骤上传 Windows 产物、官网日志及 `update.json`。Mac 单独上传不构成正式发布。

`publish=notarized` 需要以下 GitHub Secrets：

- `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`
- `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`、`KEYCHAIN_PASSWORD`
- `QINIU_AK`、`QINIU_SK`、`QINIU_BUCKET`、`QINIU_DOMAIN`

缺少任一变量时停止并报告变量名；不要使用 ad-hoc 签名产物、未公证 DMG 或本地 `.env` 替代正式发布凭据。

工作流先导入 Developer ID 证书，构建并公证 Apple Silicon DMG，然后使用 `.github/scripts/upload_qiniu_artifact.py` 上传。构建 Job 成功后发布 Job 才开始。上传 key 为：

```text
macos/<version>/Mona_<version>_arm64.dmg
```

上传后从 `QINIU_DOMAIN` 下载每个文件并比对 SHA-256。上传或公共下载验证失败时，保留 Actions artifact，报告已完成的架构和对象；不要改写 Windows 的 `Mona-latest.exe`、Windows 热更新包或 `update.json`。

## 交付

报告版本、构建提交、Apple Silicon Actions artifact、七牛下载地址、公证/签名校验结果与任何未完成阶段。若是仅构建模式，明确说明它是 ad-hoc 签名的验收包，不能作为正式公开下载。
