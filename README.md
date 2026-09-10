# Mona Desktop

Mona 是一款 AI 原生桌面客户端，将邮件、日程、笔记、终端、浏览器、数据库等功能整合为统一工作空间，通过 AI Agent 驱动日常办公任务。

## 架构概览

Mona 采用三层服务架构：

| 服务 | 端口 | 职责 |
|------|------|------|
| Gateway HTTP | 17173 | Agent 运行时（AI 对话、工具调用） |
| Services HTTP | 17174 | 业务服务（邮件、日程、素材等） |
| WebSocket | 8765 | 前端实时通信 |

技术栈：
- **前端**：React + TypeScript + Vite + Tauri WebView
- **后端**：Python 3.11+ (aiohttp) + Rust (Tauri)
- **桌面**：Tauri 2.x（Windows / macOS / Linux）

项目文档入口：

- [Agent 开发规则](AGENTS.md)
- [文档目录与分类](docs/README.md)
- [工程架构边界](docs/architecture/engineering-boundaries.md)
- [可下载运行时架构](docs/architecture/runtime-component-management.md)

## 开源范围

本项目采用**分区许可证**策略：

### 开源部分（MIT License）

以下模块采用 MIT 许可证开源，允许自由使用、修改和分发：

- `mona/email/` — IMAP/SMTP 邮件客户端
- `mona/contacts/` — CardDAV/ActiveSync 通讯录同步
- `mona/schedule/` — 日历与待办管理
- `mona/notes/` — Markdown 笔记引擎
- `mona/hoard/` — 知识库与素材管理
- `mona/channels/` — 多平台 IM 接入（钉钉、飞书、企业微信、QQ、微信）
- `mona/cron/` — 定时任务调度
- `src-tauri/src/terminal/` — 终端（SSH/SFTP/VNC/本地 Shell）
- `src-tauri/src/browser/` — 内嵌浏览器
- `src-tauri/src/db/` — 数据库客户端
- `src-tauri/src/system/` — Windows 系统优化工具
- `webui/src/components/` — 前端 UI 组件（常规功能模块）

### 闭源部分（保留所有权利）

以下模块为 Mona 的核心差异化能力，**代码可见但受专有许可证保护**，未经许可不得用于商业目的：

- `mona/agent/` — AI Agent 执行引擎（loop、runner、context、memory、subagent）
- `mona/providers/` — LLM Provider 多模型适配层
- `mona/templates/` — Agent 系统提示词与人格模板
- `mona/skills/mona-*` — 自研 AI 技能工作流（PPT 生成、视频制作、Office 自动化）
- `mona/distill/` — 用户画像蒸馏与成长轨迹分析
- `src-tauri/src/license.rs` — 订阅授权与许可证校验

### 许可证文件

- `LICENSE` — 专有软件许可证（闭源部分）
- `LICENSE-MIT` — MIT 许可证（开源部分）

使用本项目时，请遵守各文件头部标注的许可证声明。如有疑问，请联系项目维护者。

## 本地开发

### 环境要求

- Python >= 3.11
- Node.js >= 18
- Rust toolchain
- Windows 10+ / macOS 11+ / Linux

### 安装依赖

```bash
# Python 后端（可编辑模式安装）
pip install -e . --no-deps

# 前端
 cd webui && bun install
```

### 启动开发服务器

```bash
# 1. 启动 Gateway（Python）
python -m mona gateway

# 2. 启动 Services（Python，可选）
python -m mona services

# 3. 启动 Tauri 桌面客户端
cd src-tauri && cargo tauri dev
```

### 构建

```bash
# 前端生产构建
cd webui && bun run build

# Tauri 打包
cd src-tauri && cargo tauri build
```

### Windows 正式发布签名

Windows 11 的智能应用控制会拦截未知或未签名的可执行文件。正式发布必须使用受 Microsoft 信任根计划认可的 CA 代码签名证书；自签名证书不能替代它。

将证书导入当前用户的 `Cert:\CurrentUser\My` 后，使用证书指纹执行签名发布构建：

```powershell
cd src-tauri
.\build-windows-release.ps1 -CertificateThumbprint "你的证书指纹"
```

该命令会先签名 PyInstaller gateway 的可执行文件、DLL 和 PYD，再由 Tauri 签名主程序及 NSIS/MSI 安装器，并在结束时验证全部签名。证书私钥和密码不得写入仓库。

## 社区

-  issues 与功能请求请通过 GitHub Issues 提交
-  欢迎对**开源模块**提交 Pull Request

## 声明

Mona 名称及猫头鹰品牌标识为项目维护者所有，未经授权不得用于衍生产品。
