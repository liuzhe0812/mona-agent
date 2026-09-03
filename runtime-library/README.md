# Mona 官方运行时源

基础安装包不包含 Python 或 Node.js。本目录只保存可复现的运行时输入与构建说明；
生成后的组件进入 `runtime-library/components/`，再由
`scripts/build_official_distribution.py` 构建后将 ZIP 上传七牛，并把目录文件发布到 VPS。

Windows x64 首版固定：

- `python-base@3.13.15`：干净的 CPython，含 `venv`、`ensurepip` 与 SSL。
- `node-base@22.23.2`：Node.js 22 LTS Windows x64 发行版。
- `python-academic@1.0.0`：科研专家共享的离线 wheelhouse，依赖 Python 基座。
- `ffmpeg@6.1.1`：FFmpeg 与 FFprobe Windows x64 可执行文件及许可证。
- `yt-dlp@2026.07.04`：固定版本的 yt-dlp Windows x64 可执行文件。
- `asr-sensevoice@0.2.6+q8`：SenseVoice runtime、模型和 VAD，依赖 FFmpeg。
- `pandoc@3.10.1`：Pandoc Windows x64 发行版。
- `cua-driver@0.23.2`：Computer Use Driver Windows x64 发行版。
- `westock-data@1.0.5`：WeStock npm 包内容，依赖 Node.js 基座。

构建机先准备官方 Python 安装目录与 Node ZIP，再执行：

```powershell
python scripts/download_runtime_inputs.py
Expand-Archive dist\runtime-inputs\python-3.13.15-amd64.zip D:\runtime-inputs\Python313
python scripts/prepare_official_runtimes.py python-base --python-home D:\runtime-inputs\Python313
python scripts/prepare_official_runtimes.py node-base --archive D:\runtime-inputs\node-v22.23.2-win-x64.zip
python scripts/prepare_official_runtimes.py python-academic

python scripts/prepare_official_runtimes.py ffmpeg `
  --ffmpeg-gz D:\runtime-inputs\ffmpeg-win32-x64.gz `
  --ffprobe-zip D:\runtime-inputs\ffprobe-6.1-win-64.zip `
  --license D:\runtime-inputs\ffmpeg-win32-x64.LICENSE
python scripts/prepare_official_runtimes.py yt-dlp --executable D:\runtime-inputs\yt-dlp-2026.07.04.exe
python scripts/prepare_official_runtimes.py asr-sensevoice `
  --runtime-zip D:\runtime-inputs\funasr-llamacpp-windows-x64.zip `
  --model D:\runtime-inputs\sensevoice-small-q8.gguf `
  --vad D:\runtime-inputs\fsmn-vad.gguf
python scripts/prepare_official_runtimes.py pandoc --archive D:\runtime-inputs\pandoc-3.10.1-windows-x86_64.zip
python scripts/prepare_official_runtimes.py cua-driver --archive D:\runtime-inputs\cua-driver-rs-0.23.2-windows-x86_64-binary.zip
python scripts/prepare_official_runtimes.py westock --package-tgz D:\runtime-inputs\westock-data-skillhub-1.0.5.tgz
```

这些子命令只读取本地输入，不访问网络，也不写入生产凭据。每个组件会生成固定版本目录、`runtime-manifest.json` 和 Windows x64 的 `distribution.json`；npm 包只提取 tarball 中的 `package/` 内容。

`runtime-library/sources.json` 将华为云/npmmirror 放在官方上游之前，但同时固定
官方同字节文件的大小和 SHA-256；镜像内容不一致会在进入组件源之前被拒绝。

客户端只从 Mona 配置的七牛公开域名下载，不需要用户申请 API Key；下载后校验
文件大小和 SHA-256，失败时不会安装或激活组件。
