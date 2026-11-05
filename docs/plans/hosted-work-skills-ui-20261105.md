# 线上工作台：界面删减与内置 Skill 接入（2026-11-05）

## 当前生产

本轮已发布并完成所接入范围的真实验收。网页删除用户截图中的欢迎区右块（今日焦点、继续工作和主机/数据库/笔记快捷入口）、输入框上方猫形提示词入口，以及工作台左下角退出按钮。时钟、问候、输入框、模型选择及归档保留；桌面端保留原显示，现有退出 API 与登录失效清理保持。

- 后端：`/home/liuzhe/mona-hosted-work/releases/20261105-skills-ui-v10/content`，PID `34615`，NRestarts=0。状态和受限模型凭据沿用，备份 `backups/20261105-skills-ui-v10`。
- 完整包：`output/hosted-work/skills-ui-20261105-v1/work-skills-ui-v10.tar.gz`，105,590,706 字节、5,185 个文件，SHA256 `9acadecb959bc9ab562c382f5f35d0a59d3eef1fc33d8d030f0ecc529c9173c4`。
- VPS 静态产物：`/var/www/mona/work-releases/20261105-skills-ui-v9/content`，3,890 文件逐项核对摘要；v10 前端与 v9 相同。465 个 Office 产物与原 v8 完全一致，没有重新开发、编译或替换 Office 编辑器。
- Work include：`/opt/mona-work-proxy-releases/20261105-skills-ui-v9/work-locations.conf`，SHA256 `d54849cc56009a2a50f18fcd4cbc4f353984d5a1e277d478fca9477eb8190394`；回退备份 `/var/www/mona/backups/skills-ui-20261105-v9`。Nginx 仅热加载，master `420299` 不变。

账号认证继续由 VPS Auth 提供；按账号隔离的工作数据和执行仍在 Ubuntu。未改余额、订阅、支付、设备和云同步，也未开启收费 Codex 或微信。

## Skill 的实际范围

13 套内置定义和 761 个配套文件已进入只读发布包，涵盖参考文档、真实样张、源代码、脚本、模板、字体和许可。环境文件模板、解释器缓存和私有/专家 Skill 不进入该包。

模型可用 `skill_list` 发现目录，按需 `skill_read`；读取成功后提供参考、素材和脚本工具，资源仍逐 Skill 授权。后续 turn 仅从已成功的会话读取记录恢复该授权。目录和固定提示在轮次开始构建，轮内不改 system。

| 当前可直接复用的范围 | 说明 |
|---|---|
| `mona-docx`、`mona-xlsx`、`mona-pptx` | 使用原实时 Office；高级辅助脚本仍检查各自运行时和依赖 |
| `mona-canvas` | 原可编辑画布及配套示例素材 |
| `mona-design` | 设计指南、实际样张与源代码，支持现有 Office 设计；浏览器自动操作尚未接入 |
| `mona-visualizer` | 真实聊天内嵌 SVG/HTML，并可交互、持久化及刷新恢复 |
| `prd-document` | 文字和当前可用 Office 输出，其他格式依赖相应工具 |

下列 6 项的定义和资料已带入，但功能依赖尚未上线，目录明确标为不可执行：`pdf` 缺 PDF 工具；`image-generation` 缺真实生图工具和模型；`mona-motion` 缺视频服务；`memory` 缺记忆检索与来源；`long-goal` 缺持久目标工具；`skill-creator` 缺私有技能安装。不能把 13 套资料均可读取表述成 13 套全部功能已开放，也没有自动注入 `memory(always)` 或桌面私人配置。

脚本只在当前用户的 gVisor 中运行，可信资源在容器 `/tmp` 临时安装，不进入宿主执行，也不向脚本传平台密钥。标准库案例检索脚本已真实执行；声明 Python≥3.13 或缺依赖的脚本返回 `runtime_unavailable`。实时读取的公共统一运行时目录目前仅登记 Windows 基座，缺少相应 Linux 资源，不新建下载器、不复制 Windows 程序到 Ubuntu、不绕过隔离。目录证据保留于 `linux-runtime-check.json`。

## 可视化传输与安全

复用原 `ShowWidgetTool`、Widget 事件、MonaClient、InlineWidget 和沙箱工厂。子进程仅新增允许明确的 `widget` 事件，未知帧继续拒绝；账号、会话、实际执行和客户端逻辑任务编号仍由宿主绑定，完成事件持久化并去重。

网页 iframe 从固定 URL 取得原工厂生成的 bootstrap，公开模板只包含随机通信 channel，不含用户图形代码或凭据；实际内容继续经既有 postMessage 发送。主页面严格脚本 CSP 未放宽，iframe 仅 `allow-scripts`，没有同源、表单、弹窗或顶层导航权限。本地真实浏览器已验证计数器可交互，iframe 访问父文档被拒绝。

## 验收与失败留档

- 前端相关 7 项、Widget 相关 6 项、只读 loader DI 相关 6 项、Wire 相关 3 项通过；Windows 路由 28 项通过、链接权限 1 项跳过。Ubuntu Skill/runner 16 项通过，补齐实际符号链接安全检查；Executor 新协议在 Windows/Ubuntu 各 4 项通过。类型检查和独立构建通过，只打包本任务修改，其他未提交代码未带入。
- 真实 gVisor 运行 `image-generation/find_upstream_cases.py`，读出真实配套案例；`skill_asset_copy` 的字节摘要与源文件一致；高级依赖缺失明确拒绝；精确容器清理通过。记录 `linux-skills-acceptance.json`。
- 公网 `production-v1.json` 已验证截图三处移除、真实 `skill_list` 和正文读取。首次 Widget 回传因父进程事件白名单遗漏而失败，记录保留为 unknown；停止自身服务、确认原进程与精确容器结束后，对唯一自有 QA 任务 `417ef98f379041d4e21cd2ac2be1f58b` 使用既有 offline reconcile 结束跟踪。其结果仍不确定，状态为 interrupted，不标成功，不重派原调用。
- 单行传输修正后，`production-v2.json` 为 passed=true、mocked_responses=false：新会话真实读取可视化 Skill 和参考，调用 `show_widget` 创建计数器，点击 0→1；刷新后 iframe 唯一、可继续点击且不新增模型消息。实际素材复制及交付 SHA256 `3f1f1a39a6564577a1781c3b458552aa723bd82b8d9cd05d3d03469c6d68ade1` 与源文件相同。另一账号 404，现有退出 API 撤销后 401、工作台清空并返回登录。页面异常和 HTTP 失败均为 0，QAtoken 全撤销，钱包及版本仍为 0。

最终两条新模型消息仅用于新的 Widget 和素材验收，已通过的目录发现复用原证据。实际会话历史确认调用过 `skill_list`、`skill_read`、`skill_reference_read`、`show_widget`、`skill_asset_copy`、`deliver_file`，真实目录为 13 项，其中 7 项满足当前工具范围、6 项缺服务。

## 最终状态与提交

v9 切换前 12 个会话、18 条任务、5 条文件的所有字段与备份一致，验收新增至 14/22/6。无运行、取消中、unknown 任务或未确认文件操作。Docker `78383`、Work 隧道 `423172`、原 8 容器 ID/状态/启动时刻及四个暂停 Worker 均保持，无额外 Work 容器；VPS 原 Auth、One API、MariaDB、Nginx master、FRPS、Relay、Work visitor 的 PID/启动时刻与基线相同。其他站点配置逐字节不变。

代码分类提交：`d6d26b421`（只读 loader 注入）、`f6be94e49`（网页删减）、`9c0e81b03`（Skill 与 Widget）、`8671ffbf1`（父子传输修正）。完整事实见 `deploy/hosted-work/skills-ui-release-20261105.json` 和 `output/hosted-work/skills-ui-20261105-v1/`。剩余 6 项底层能力及 Linux 高级运行时均明确保留为未完成，不冒充全量桌面功能已迁移。
