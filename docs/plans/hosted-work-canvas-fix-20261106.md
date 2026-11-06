# 线上工作台画布修复与生产验收记录

日期：2026-11-06。画布静态发布 `20261106-canvas-work-v18` 已完成，真实普通账号浏览器验收通过。验收没有调用模型，测试网页登录凭据已撤销，测试账户余额及版本保持不变。

本记录只覆盖画布保存、导出与打印内容。v18 包不包含 harness v17 后端；画布验收完成后 Ubuntu 管理连接已恢复，harness 转入独立部署流程，其最终部署结果另行记录。

## 根因与最小修复

1. **切换时丢弃尚未发送的自动保存。** 两处画布入口使用 450 ms 防抖，切换会话、文件或卸载时直接清除定时器，最后一次编辑可能尚未写出。现在 pending Map 保留原内容、原文件或工作区的保存闭包和 Hosted 账号快照；离开前先删除 pending，再提交一次。已经派发的写入不重试；账号快照变化时取消旧未发送内容，旧保存回执或错误也不能更新新页面。
2. **读取与保存竞争导致版本或显示回退。** 较慢的旧读取可以覆盖较新的 SHA 缓存，新标签页也可能在上一笔保存完成前读到旧内容。现在沿用已有写入队列，读取先等待已有写入；版本缓存记录观察顺序，拒绝较旧读取覆盖较新版本，并在请求前后核对账号快照。
3. **浏览器导出错误处理临时 URL。** 网页导出再次 `fetch(data:/blob:)` 会受到现有 CSP 连接限制，立即撤销 Blob URL 也可能早于浏览器读取。现在直接使用已有 data/blob URL 下载，临时 URL 延迟释放；思维导图 PNG 使用共享 `downloadMediaBlob`，保留桌面保存路径。

另修复流程图 PDF 打印页的内联脚本：原打印窗口写入的 `<script>` 被 `script-src 'self'` 拦截。现在由已有脚本设置标题和图片属性，等待 `image.decode()` 后调用打印；打印页和 SVG 均无内联脚本，未放宽站点 CSP。

源码范围仅为 `tauri.ts`、`hosted-canvas-storage.ts`、`MindMapDocumentEditor.tsx`、`FlowchartDocumentEditor.tsx`、`CanvasFileView.tsx`、`useConversationCanvases.ts`。隔离构建未重建 Office，`ThreadShell.tsx` 和 `OfficeWorkbenchView.tsx` 摘要保持不变。逐文件前后 SHA 见 [source.json](../../output/hosted-work/canvas-fix-20261106/source.json)。

## 发布与收敛

增量包 `work-canvas-static-v18.delta.tar.gz` 为 2,372,989 字节，SHA256：

`2d610b20296eea1908b8f13b66199f6d41fdfa667b8d2edeb1a10737c80e8fa8`

包内变更 63 个文件；最终静态目录 4,422 个文件逐项核验，465 个 Office 文件保持不变。清单 SHA256 为 `422bec4697b074315708969689716a1e328baf894cc7547a4f3c8702a3a5a342`。依据见 [package.json](../../output/hosted-work/canvas-fix-20261106/package.json) 和 [published.json](../../output/hosted-work/canvas-fix-20261106/published.json)。

- 静态目录：`/var/www/mona/work-releases/20261106-canvas-work-v18/content`
- Work include：`/opt/mona-work-proxy-releases/20261106-canvas-work-v18/work-locations.conf`
- include SHA256：`0fb58d0b6300196eb8ded89d497bef5a958f91cdb551b5965ed1dd5b81f5ed8d`
- 回退备份：`/var/www/mona/backups/canvas-20261106-v18`

首次重载后，请求短暂仍返回旧 v16 HTML（SHA `519d7ed80b73e343919f20839a4abffe78cd988fab6eeae1ce15ef53bf165188`）；即时校验未通过，发布先回退。磁盘中的 v18 HTML 已是新摘要，说明当时公网响应尚未收敛，详见 [首次回退记录](../../output/hosted-work/canvas-fix-20261106/first-promotion-rolled-back.json)。第二次切换观察到旧响应后转为新 HTML（SHA `ecc708321cd841c856c93a743af21209a71914da21a0fb330e87f19924997786`），随后清单与真实浏览器验收均通过。

静态发布结束快照中，只有 Work include 改变；`/work/` 与 `/work/hosted-work.html` 均为 200、`Cache-Control: no-store`，原 CSP 保留。匿名 API 返回 401，动态 Widget 仍走既有代理。本次静态发布未修改 Ubuntu 服务，未重启 Docker 或其他服务。Nginx、MariaDB、Work visitor 的 PID 分别仍为 420299、420210、367299，Auth 为 389486，One API 为 310825。该快照见 [final-state.json](../../output/hosted-work/canvas-fix-20261106/final-state.json)，不代表随后独立 harness 部署的状态。

## 真实生产验收

依据 [production-acceptance.json](../../output/hosted-work/canvas-fix-20261106/production-acceptance.json)：`passed=true`、`production=true`、`synthetic_auth=false`、`mocked_responses=false`，浏览器访问 `https://mona-ai.cn`，没有替换接口响应。

流程图编辑后约 **346.8 ms** 切换，思维导图约 **316.9 ms** 切换，均早于原 450 ms 防抖期限；切换、重开和刷新后编辑内容仍在，两个 `save_switch_refresh` 检查均通过。

以下四项为真实浏览器下载，并检查文件内容：

| 下载 | 字节数 | 内容检查 |
| --- | ---: | --- |
| 流程图 PNG | 54,145 | 解码为 764 × 999 图片 |
| 流程图 SVG | 2,522,867 | 包含编辑后的节点 `FLOW_FAST_d84163041c` |
| 思维导图 PNG | 25,081 | 解码为 1074 × 454 图片 |
| 思维导图 FreeMind `.mm` | 151 | 包含 `MIND_FAST_d84163041c` 与 `CHILD_d84163041c` |

各下载文件的完整 SHA256 已保存在生产验收 JSON。PDF 额外验证的是**打印页内容**：生成 91,782 字节、1 页、612 × 792 pt 的 PDF，并渲染为 459 × 594 图片；打印窗口中的 SVG 图片成功解码，包含编辑后的节点，页面内联脚本和 SVG 脚本数量均为 0，`script_src_csp_violations=[]`。本次没有验证用户手动保存 PDF 或系统打印对话框，对应 `user_manual_save_verified=false`、`system_print_dialog_verified=false`。

验收模型调用为 **0**（`model_executed=false`，`blocked_model_requests=[]`）。测试账户验收后 `available_units=0`、`reserved_units=0`、`active_requests=0`、`version=0`，`wallet_unchanged=true`；所有测试网页登录会话已撤销。

## 已知诊断与验收边界

浏览器记录 `page_errors=[]`、`failed_requests=[]`、`unexpected_csp_violations=[]`。导出库尝试将 CSS 资源地址设置为 base URI 时，仍产生两类 `base-uri 'none'` 拦截诊断（记录次数分别为 3 和 177）；四项下载及打印内容检查均完成，现有诊断未阻断本次功能。完整控制台诊断保留在验收 JSON，站点继续禁止修改 base URI。

验收编排首次解析标准输出时遇到 `JSONDecodeError`，原因为依赖的弃用提示先于 JSON 输出。随后读取完整、无凭据的浏览器验收 JSON，确认 `browser_passed=true`，恢复经过已写入生产验收记录。

发布、源码摘要、生产验收和最终快照的汇总见 [canvas-release-20261106.json](../../deploy/hosted-work/canvas-release-20261106.json)。本记录不将画布验收扩展为模型、harness、支付或其他服务的上线结论。
