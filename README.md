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

## 许可证

Mona 自有代码、文档、界面设计、图标、提示词、技能和品牌资产均为商业专有内容，统一适用根目录的 `LICENSE`。本项目不以开源许可证发布，不授予复制、修改、二次开发、再分发或再授权权利。

商业使用、企业部署、嵌入产品或对外提供服务，必须事先取得版权方书面商业授权。未经授权不得将本项目或其组成部分用于商业场景。

仓库内明确属于第三方的依赖、编辑器和资源仍保留其原始许可证与 NOTICE；这些第三方许可证不构成 Mona 自有代码的开源授权，也不改变本项目的商业专有授权边界。

许可证文件：

- `LICENSE` — Mona 商业专有软件许可证
- 第三方组件目录中的 LICENSE / NOTICE — 对应第三方内容的原始许可证

如需取得商业授权，请联系版权方。

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
-  商业授权、合作与功能反馈请联系项目维护者

## 声明

Mona 名称及猫头鹰品牌标识为项目维护者所有，未经授权不得用于衍生产品。
