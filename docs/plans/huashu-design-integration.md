# Huashu Design 集成与 PPT 设计指导替换

日期：2026-10-24。已完成代码、资源、协议和一次真实模型读取验收；未发布客户端。

名称更新：集成后的产品入口现统一为 **Mona Design**，目录和调用名为 `mona-design`。下文 Huashu 名称与旧路径属于当时的来源及验收记录；上游原始文件、署名、许可与校验清单保留，不再提供旧名称的运行入口。

资源裁剪：按后续用户要求，仅移除 **Mona Design 包内**的 6 首背景音乐和纯配乐脚本，并清理该包的相关说明。来源清单记录 382 个保留资源、7 个明确排除项及必要补丁，原始来源哈希仍保留。**Huashu Motion 和独立视频工作台的配乐界面、接口与混音能力保持原样。**

## 交付范围

- 内置 `huashu-design`，固定上游 `alchaincyf/huashu-design` commit `4fc7bfdbd5ec3fa2d43ce7a6433de60976a5e4b1`。
- 完整保留 389 个上游 Git blob，合计 41,740,432 bytes；包含 84 组风格 JPG/HTML、5 张总览，以及素材、示例、脚本、文档、依赖清单和 MIT 许可。原始 `SKILL.md` 保存在 `references/upstream-skill.md`。
- `provenance.json` 逐文件记录原始路径、目标路径、长度和 SHA-256。`.gitattributes` 禁止该目录的自动换行转换，保持原始字节。
- Mona 仅新增任务入口、原生 PPT 接入和真实前端项目接入三份适配说明；上游资源不改写。上游 CDN、网络字体、远程视频和运行时生成的音频不属于仓库内置离线文件。

## 执行方式

PPT 继续使用 `mona-pptx` 与当前原生 Office 文稿。设计知识统一读取 Huashu 的样张、源码、排印、素材和评审；新建与修改共享设计判断。不执行 HTML/PDF 中转，不增加三方向批准和另一套偏好存储。

删除旧 `design-method.md`、`visual-recipes.md`、`dashi-design-profiles.md`。现有组件、预设和模板保留为原生制作工具，场景和来源说明不再承担独立的默认配色或设计规则。

普通 Work 可用 `skill_reference_read` 按需读取 Huashu 图片、HTML 和脚本源码；返回真实图片内容，长源码显式分页。开发工作台的 Mona、Codex、Claude、CodeBuddy 共用固定白名单的只读资源工具，项目规则和既有设计系统优先。不引入私人 Skills、记忆、任意外部 MCP 或脚本执行权限。

## 验证记录

- 资源、PPT Skill、目录、跨 Skill 访问和打包相关回归：65 passed。
- 开发运行器、三个原生执行通道、只读/子任务边界和既有权限/协作回归：194 passed、2 skipped。协议进程验收不等同于真实模型调用。
- Ruff、TypeScript 类型检查和范围差异检查通过；Skill 结构校验通过。
- 构建实际 wheel，逐个核对 389 个上游文件和 4 个 Mona 入口/清单文件：393 个文件全部存在且 SHA-256 一致。两个 Gateway 打包入口显式包含完整资源目录；本次未构建桌面安装器。
- 一次隔离的真实 `gpt-6.1-sol`、`high`、只读 Codex 调用成功。读取入口、两份适配说明、实际 JPG 和同名 HTML；模型正确识别现有 React/共享控件/语义 Token，以及 PPT 原生 Office 路径。未写入用户项目，未生成成品。
- 真实调用证据：`C:/Users/liuzhe/AppData/Local/Temp/mona-huashu-live-audit-d45e5315c3474cc09a9506441e771f15/acceptance-report.md`。
- wheel 资源证据：`C:/Users/liuzhe/AppData/Local/Temp/mona-huashu-final-package-adhz0taj/resource-check.json`。

以上验证证明资源完整、模型可实际读取、执行入口与权限契约有效，不代表已经完成同题 PPT 成品设计质量对照或四种引擎的真实账号验收。运行中的旧开发后端需要重新加载后才能提供新工具。
