<p align="center">
  <img src="webui/public/brand/mona_icon.png" alt="Mona 猫咪 Logo" width="96" />
</p>

<h1 align="center">Mona Desktop</h1>

<p align="center"><strong>从一句需求，到一份可用的成果。</strong></p>
<p align="center">把 AI、资料和工作工具放在同一个桌面工作空间。</p>

<p align="center">
  <a href="https://mona-ai.cn">官网 · mona-ai.cn</a> ·
  <a href="#开始使用">开始使用</a>
</p>

Mona 是一款 AI 原生桌面客户端。你可以用自然语言提出任务，让 AI 结合笔记、资料和工具推进工作，并在同一个工作空间中查看、编辑和保存成果。

**Mona 当前仅提供桌面客户端，不提供独立 Web 版。**

## 在 Mona 里完成什么

| 工作场景 | Mona 提供的能力 |
| --- | --- |
| 整理资料与知识 | 管理笔记和资料库，检索已有内容，为问答与写作提供参考 |
| 制作文档与汇报 | 创建、编辑和预览文档、表格、演示文稿，让 AI 参与内容整理与修改 |
| 处理日常事务 | 在统一工作空间中使用邮件、日程与待办，整理信息、安排工作 |
| 浏览网页与收集信息 | 使用内置浏览器浏览页面，结合 AI 阅读与处理网页内容 |
| 开发与技术工作 | 使用终端、SSH 和数据库工作台，执行命令、查询数据、查看结果 |
| 扩展 AI 工作方式 | 通过 Skills、专业 Agent 和 MCP 接入适合任务的能力 |

## 为什么是一个桌面工作空间

- **围绕任务组织工作。** 对话、资料、工具和交付物放在一起，减少在多个窗口之间搬运上下文。
- **成果可以继续编辑。** 从整理资料到制作文档，输出可以在工作台中继续修改、保存和导出。
- **已有知识可以复用。** 笔记和资料库为后续任务提供参考，不必每次都从头说明背景。
- **按任务连接能力。** 日常办公、内容创作和技术工作可以使用各自的工具与专业 Agent。

你可以从这些需求开始尝试：

> “从我的资料库中找出与这个主题相关的内容，整理成一份有条理的摘要。”
>
> “把这份材料整理成汇报提纲，再制作成可以继续编辑的演示文稿。”
>
> “查看这个数据库的表结构，帮我写一条查询，并解释查询结果。”

具体可用能力取决于所用版本、模型配置、已连接的服务和工具权限。

## 开始使用

1. 访问 [Mona 官网](https://mona-ai.cn)，查看客户端获取方式与产品信息。
2. 安装并打开桌面客户端，按界面引导完成模型等必要配置。
3. 从一个具体任务开始，根据需要添加资料、连接账户或启用工具。

可用安装包与系统要求以官网发布信息为准。使用桌面安装包无需自行搭建前端开发环境；模型调用及部分外部服务需要网络连接。

## 技术与开发

Mona 使用 **Tauri 2 + React + TypeScript** 构建桌面界面，由 **Python** 提供 Agent 与业务服务，**Rust** 提供桌面原生能力。

| 目录 | 用途 |
| --- | --- |
| `src-tauri/` | 桌面宿主、原生能力与安装包构建 |
| `webui/` | 桌面客户端的界面源码 |
| `mona/` | Python Agent、业务服务、工具与技能 |

`webui/` 的名称不代表独立 Web 产品。生产界面由 Tauri 嵌入桌面程序，后端不再托管网页客户端；本地 HTTP / WebSocket 用于客户端内部通信。

<details>
<summary>本地开发（面向维护者与获授权开发者）</summary>

准备 Python 3.11+、Node.js 22.12+、npm、Rust 工具链和 Tauri 2 CLI。Windows 开发还需要 C++ 构建工具与 WebView2。

在仓库根目录安装依赖：

```powershell
python -m pip install -e ".[dev]"
npm --prefix webui install
npm --prefix webui/office-editor install
cargo install tauri-cli --version "^2" --locked
```

启动桌面开发模式：

```powershell
cd src-tauri
cargo tauri dev
```

Tauri 会启动界面开发服务，并按客户端配置管理本地后端。开发模式使用系统 Python，请确保依赖安装在桌面进程能够找到的 Python 环境中。

仅构建桌面前端资源时，在仓库根目录运行：

```powershell
npm --prefix webui run build:tauri
```

完整安装包还需打包配套后端资源。Windows 正式发布入口为 [build-windows-release.ps1](src-tauri/build-windows-release.ps1)，发布签名使用有效的代码签名证书；证书私钥和密码不得写入仓库。

</details>

## 反馈与交流

欢迎通过本仓库的 **GitHub Issues** 提交问题和功能建议。

- 问题反馈请附上客户端版本、操作系统、复现步骤及预期结果；截图和日志请先移除个人信息与凭据。
- 功能建议请描述你要完成的任务，以及目前遇到的阻碍。
- 商业授权与合作请通过 [官网](https://mona-ai.cn) 联系项目维护者。

## 许可证与品牌声明

Mona 为**商业专有软件，并非开源项目**。个人学习、评估或非商业用途可在遵守 [LICENSE](LICENSE) 的前提下安装、运行；商业使用须事先取得版权方书面授权。

仓库公开不授予源代码修改、二次开发、再分发或再授权的权利。具体授权范围以 [LICENSE](LICENSE) 为准。第三方依赖和资源保留各自的许可证与 NOTICE，不改变 Mona 自有内容的授权边界。

Mona 名称及**猫咪品牌标识**为项目维护者所有，未经授权不得用于衍生产品。
