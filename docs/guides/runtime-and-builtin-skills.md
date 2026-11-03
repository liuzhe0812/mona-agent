# 基础包与内置 Skill 运行环境

核对日期：2026-11-03。本文记录当前源码和已验证构建输入；尚未重新构建或发布安装包。原 Windows 1.8.4 安装包不会因为源码修改自动获得这些资源。

## 基础安装包

| 内容 | 用途 | 交付方式 |
|---|---|---|
| Gateway/Services 私有 Python 与后端依赖 | 运行 Mona 后端、内置 PDF/Office/浏览器工具 | 保持应用自身依赖，不交给任意 Skill 脚本使用 |
| Playwright 专用 Node 驱动 | 后端浏览器通信 | 保持后端实现，与共享 Node 基座隔离 |
| 原生 Office 编辑器、模板和 XLSX sidecar | Word、Excel、PPT 实时编辑、检查、原生导出 | 随 Gateway 资源树交付；普通任务不安装 LibreOffice 或另一套 Office |
| Mona 浏览器 | 普通网页浏览、观察与交互 | 使用宿主 WebView；Windows 的 WebView2 缺失时仍按既有安装配置准备 |
| `python-base@3.13.15` | Skill `.py`、共享 Agent Python 和项目虚拟环境的解释器 | 独立受管组件 ZIP 随包，启动后本地导入统一仓库 |
| `node-base@22.23.2` | Skill `.mjs`、Agent/项目 Node 命令、Windows 开发沙箱 | 独立受管组件 ZIP 随包，启动后本地导入统一仓库 |
| `python-common@1.0.0` | 下表六个常用库 | 离线 wheel 包随包，进入共享 Python 环境 |

源码已从应用主依赖和 Gateway 收集中排除 NumPy；科研助手的 NumPy、SciPy、pandas、Matplotlib 等仍在科研运行时中按需准备，不因本轮收敛删除。

| 常用 Python 库 | 固定版本 | 默认使用方 |
|---|---|---|
| defusedxml | 0.7.1 | Word OOXML 辅助处理、PPT 来源图片提取 |
| lxml | 6.1.2 | Word XML 校验、批注和受支持的修订处理 |
| Pillow | 12.3.0 | PPT 图片处理、视频图像处理 |
| PyMuPDF | 1.26.4 | 从 PDF 提取 PPT 图片及按区域裁切 |
| websockets | 17.1 | 视频画面控制与逐帧捕获 |
| PyYAML | 6.0.3 | Skill 创建器的真实 YAML 校验 |

Windows 三个随包 ZIP 合计 **85,459,984 字节，约 85.46 MB / 81.50 MiB**。这是新增压缩资源的实测大小，不等于重建后安装包的净增量；NumPy 排除和安装器再次压缩的效果仍需实际重建测量。Mac 使用对应架构输入，不打包另一架构的解释器。

这些资源打入 Gateway 的 `_internal/desktop-resources/runtime-base/`，安装包和热更新复用同一资源树。首次启动在后台本地校验、导入并建立共享环境，首次脚本等待同一任务，不下载基础解释器或六个常用库；关闭自动下载也不阻止本地准备。执行环境始终位于系统本地应用数据的统一 `runtimes/`，不会混入应用后端或用户项目。

## 继续懒加载的资源

| 资源 | 使用条件 | 管理方式 |
|---|---|---|
| 科研依赖、模型、ASR、股票等领域资源 | 相应专家安装或功能实际使用时 | 既有统一仓库、下载器和环境构建器；不纳入本轮通用 Skill 整理 |
| FFmpeg/FFprobe | 视频编码、混音、媒体检查 | 已有可用程序先复用；缺少时由统一运行时准备。补齐 macOS ARM64/x64 固定版本 |
| 无界面 Chromium | 视频任务缺少可用系统浏览器时 | 固定版本按需下载，Windows/macOS 按平台和架构区分，不进入基础安装包 |

固定原生资源目录为 `mona/runtime/native-tools.json`；与远端组件目录合并，远端目录暂不可用时仍可按固定来源、大小和 SHA 下载这些原生资源。浏览器的国内镜像与 Google 上游已逐包核对 SHA 相同；所有安装仍经过统一下载器、归一化和组件仓库。macOS FFmpeg 组件携带许可和构建来源说明。

Mona 的普通浏览器 WebView 不等于已验证的后台视频渲染器。本轮未修改 WebView 原生桥；视频沿用实际可用的 CDP 渲染路径，并增加统一运行时的无界面浏览器来源。

## 13 个默认 Skill 逐项结果

前提：桌面应用成功启动，模型及所用服务账号、授权正常。下表区分本地执行依赖与业务本身的在线条件；不以模型账号未配置推断为缺 Python 库。

| Skill | 执行入口 | 本轮处理及剩余条件 |
|---|---|---|
| `memory` | Mona 记忆工具 | 无外部脚本依赖 |
| `long-goal` | Mona 目标工具 | 无外部脚本依赖，保留显式目标语义 |
| `skill-creator` | `skill_script_run` + 共享 Python | 声明 PyYAML；校验支持真实 `always`、`short_description` 和 `metadata`，脚本模板只推荐 `.py`/`.mjs`；已离线验证创建、校验、打包 |
| `mona-docx` | 原生 `office`，高级处理走共享 Python | 解包、校验、打包、批注复用随包库；常见段落内文本/格式修订使用 lxml，去除 LibreOffice/Xvfb 依赖；复杂结构修订明确拒绝且不产生输出。旧 `.doc`、DOCX 转 PDF 不宣称支持 |
| `mona-xlsx` | 原生 `office` 与内置 XLSX sidecar | 无额外 Node/Office 安装；数据及模型服务另按实际任务使用 |
| `mona-pptx` | 原生 `office`，来源提图走共享 Python | 已用真实 `skill_script_run` 离线验证 Word/PDF 提图；原始素材保留，不需科研包 |
| `pdf` | Mona 内置 `pdf` | 使用后端自带库；不准备 Skill Python 或 Poppler |
| `prd-document` | 内容指引，按输出格式调用 Office 或项目已有 HTML 流程 | 无独立依赖 |
| `mona-design` | 设计资料、真实样张、Mona 浏览器/Office/视频 | 网页检查通过现有 `browser_observe` / `browser_act` 完成，无额外运行库或懒加载；上游脚本仅为参考，未提供的多视口、控制台历史和录屏明确记为未验证 |
| `mona-motion` | Mona `video` | 常用库随包；浏览器和 FFmpeg/FFprobe 接入统一懒加载，已有程序直接复用；Windows 真实受管浏览器已完成逐帧及 H.264 成片检查，Mac 实际执行仍待 Mac runner |
| `mona-canvas` | Mona 原生画布 | 无外部脚本依赖；由当前会话绑定画布 |
| `mona-visualizer` | Mona `show_widget` | 普通图表改为内联 SVG/原生 JS，不再强制 CDN Chart.js；地图使用真实数据，可内嵌已取得的边界，在线地图库仍为可选路线 |
| `image-generation` | Mona `generate_image`，案例检索走共享 Python | 案例检索仅需标准库，已离线验证；生图仍需启用的图片能力、有效图片模型账号及服务网络，不使用外部图片 CLI |

`my`、`cron`、`summarize`、`weather`、`clawhub` 及独立 HTML 报告 Skill 已从默认目录移除，底层诊断、日程和会话摘要能力保留。GitHub、tmux 已移到 `expert-library/skills/`，作为可选资源；按既有 Agent 私有 Skill 目录安装，不增加市场或新的配置工具。其他 Agent 的专属 Skill 未在本轮改动范围内。

## 验证与发布边界

- 在全新临时统一仓库中，关闭自动下载、禁止 pip 索引、拒绝目录网络请求，约 27 秒完成六库离线初始化；Word/PDF 提图、Word 解包回包、Skill 初始化校验、案例检索和 Node/npm/npx 共 11 项实际检查通过。
- Skill 创建/校验/打包、Word 文本修订又分别经真实 `skill_script_run` 与该共享 Python 验证，覆盖中文路径、源文件不变及明确失败。
- 官方 Windows 无界面浏览器经归一化、统一仓库安装后实际运行；同一渲染器生成红蓝两种正确画面，并产出 320×180、1 秒 H.264 MP4，FFprobe 检查通过。
- macOS Python/Node、公共库、无界面浏览器和 FFmpeg/FFprobe 已完成两架构真实资源与安装格式检查；Windows 无法证明 Mac 实际运行及所选模式的签名校验通过。Mac 发布脚本已加入隔离环境的解释器、浏览器和编码检查，必须在 Mac runner 完成后才能宣称该平台验收完成。
- 安装包和热更新构建校验随包资源的清单、平台、架构、大小和 SHA，缺失或损坏即失败；不允许以开发机缓存代替随包输入。
- Mona Design 改为调用现有浏览器后，资源读取、来源校验及 DOM 采样调用链等 49 项检查通过，1 项跳过；另一个既有浏览器提示词用例对旧英文句子的断言与当前模板不一致，相关模板和用例均未在本次修改。
- 本轮未发布安装包或原生资源，不将源码就绪描述为现有用户已更新。
