# Mona 官方运行时源

基础安装包包含供 Skill 和项目独立执行脚本的 Python/Node.js 基座及六个常用 Python 库；应用后端 Python 和 Playwright 专用 Node 驱动继续隔离。本目录保存可复现的运行时输入与构建说明；
生成后的组件进入 `runtime-library/components/`，再由
`scripts/build_official_distribution.py` 构建后将 ZIP 上传七牛，并把目录文件发布到 VPS。

随包资源使用 `bundled-sources.json` 的固定输入，在 Gateway 构建前执行
`python scripts/prepare_bundled_runtimes.py`，输出到被 Git 忽略的
`src-tauri/resources/runtime-base/`。Windows x64、macOS ARM64/x64 的基础 Python、
Node 和公共 wheel 均固定版本、大小和 SHA；资源准备完成后可用 `--offline` 重建。
应用首次启动只从随包 ZIP 本地导入同一统一仓库，不下载基础解释器或常用库。

大型视频资源不进入基础包。无界面浏览器与 macOS FFmpeg/FFprobe 的固定原始
ZIP 目录在 `mona/runtime/native-tools.json`，由现有统一下载器校验并归一化安装；
浏览器国内镜像与官方上游已验证同字节，FFmpeg 组件附带固定许可及来源说明。

Windows 无界面浏览器固定为 156.0.8078.80；Mac 固定为 150.0.7871.124，保持 Mona
当前最低 macOS 12 的支持。[Chrome 151 起要求 macOS 13](https://developer.chrome.com/release-notes/151)，
不能直接把较新的 Mac 浏览器包替换进目录。两种 Mac 架构的主程序及全部动态库已核对
Mach-O 最低版本为 12.0；仍须执行 Mac 构建脚本中的实际运行验收。

Windows x64 首版固定：

- `python-base@3.13.15`：干净的 CPython，含 `venv`、`ensurepip` 与 SSL。
- `node-base@22.23.2`：Node.js 22 LTS Windows x64 发行版。
- `python-academic@1.0.0`：科研专家共享的离线 wheelhouse，依赖 Python 基座。
- `ffmpeg@6.1.1`：FFmpeg 与 FFprobe Windows x64 可执行文件及许可证。
- `yt-dlp@2026.07.04`：固定版本的 yt-dlp Windows x64 可执行文件。
- `asr-sensevoice@0.2.6+q8`：SenseVoice runtime、模型和 VAD，依赖 FFmpeg。
- `pandoc@3.10.1`：Pandoc Windows x64 发行版。
- `cua-driver@0.23.2`：Computer Use Driver Windows x64 发行版。

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
```

这些子命令只读取本地输入，不访问网络，也不写入生产凭据。每个组件会生成固定版本目录、`runtime-manifest.json` 和 Windows x64 的 `distribution.json`。

`runtime-library/sources.json` 将华为云/npmmirror 放在官方上游之前，但同时固定
官方同字节文件的大小和 SHA-256；镜像内容不一致会在进入组件源之前被拒绝。

常规组件从 Mona 配置的公开目录下载，不需要用户申请 API Key；固定原生资源也可
使用随包目录列出的已核验镜像或上游。所有路径都校验文件大小和 SHA-256，失败时
不会安装或激活组件。
