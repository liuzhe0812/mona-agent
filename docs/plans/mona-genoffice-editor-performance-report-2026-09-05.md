# Mona GenOffice 编辑器性能与兼容性报告

> D2-03 证据记录，2026-09-05。本文只记录当前 Windows 机器上可以自动化复现的结果，不把 Node 引擎计时外推为 WebView2 首屏或用户交互性能。

## 1. 执行环境与命令

- OS：Windows-10-10.0.26200-SP0
- Node：v24.19.0；npm：11.17.0；Vitest：4.1.11
- Python：3.11.9，`pywin32` 可用
- Microsoft Office：Word、Excel、PowerPoint COM 均可启动并完成本次验证，组件版本均为 16.0。
- WPS：未检测到安装目录，无法进行 WPS 兼容性验证。

复现命令（在 `webui/office-editor` 目录执行）：

```powershell
npx vitest run --root . --config vite.config.ts scripts/measure-office-performance.test.ts --reporter verbose
```

脚本为一次性测量入口：[measure-office-performance.test.ts](../../webui/office-editor/scripts/measure-office-performance.test.ts)。所有样本和引擎导出文件都写入系统临时目录（未提交），没有把本机用户目录或 Office 安装目录写入报告。

## 2. 样本定义

| 格式 | 样本构造 | Office 侧确认结果 |
|---|---|---|
| DOCX | Word COM 生成 100 个段落，每页一个段落并插入分页符 | 100 页、200 个段落 |
| XLSX | Excel COM 生成 `2000 × 100` 个字符串单元格，共 200,000 个单元格 | UsedRange 为 2,000 行 × 100 列，读取 200,000 个单元格 |
| PPTX | PowerPoint COM 生成 100 张空白版式幻灯片，每页 1 个文本框 | 100 张幻灯片、100 个文本框 |

这些是容量/数量基准样本，不是复杂业务文档：没有图片、公式、合并单元格、复杂样式、图表、动画或嵌入对象。因此结果不能代表所有真实 Office 文件。

## 3. 实测结果

### 3.1 文件生成与 Microsoft Office 打开/读取

生成计时包含对应 Office COM 进程启动、内容写入和首次保存；打开/读取计时包含 COM 进程启动、打开文件和读取本次验证所需的内容。

| 格式 | 生成后大小 | Office 生成 | Office 打开/读取 | 读取内容 |
|---|---:|---:|---:|---|
| DOCX（100 页） | 16,266 B | 641.6 ms | 624.9 ms | 100 页、200 段落 |
| XLSX（20 万单元格） | 1,108,818 B | 2,894.9 ms | 761.5 ms | 2,000 × 100，200,000 单元格 |
| PPTX（100 页） | 150,764 B | 4,975.7 ms | 2,130.4 ms | 100 页、100 文本框、2,600 字符 |

### 3.2 Mona/GenOffice 引擎打开、checkpoint 与导出写入

计时在已加载依赖的 Node/Vitest 进程内进行，不包含浏览器下载、WebView2 创建、iframe 首屏绘制和 Mona HTTP/WS 往返。

| 格式 | 引擎打开/读取 | checkpoint 序列化 | 导出文件写入 | 输出大小 | 自身重开 |
|---|---:|---:|---:|---:|---|
| DOCX | 85.6 ms（`parseDocx`，201 个 block） | 55.7 ms（实际 page-color 修改） | 8.2 ms | 14,556 B | `parseDocx` 后 201 个 block |
| XLSX | 143.5 ms（sidecar open）+ 484.5 ms（10 次、每次最多 20,000 单元格的读取） | 442.4 ms（JSZip + GenOffice planner，修改 A1） | 8.2 ms | 1,098,469 B | sidecar 共读到 200,000 个 cell |
| PPTX | 1,523.3 ms（100 页解析和 render tree 构建） | 100.4 ms（PPTX 重打包） | 8.2 ms | 148,311 B | 100 页 |

这里的“导出文件写入”只测量引擎产生的内存 buffer 写入系统临时文件，不包含 Services checkpoint 分块、HTTP 上传、Artifact 注册或用户选择路径。DOCX 的 page-color 修改和 XLSX 的 A1 修改用于避免无变化快路径；PPTX 测量的是当前 `savePptx` 重打包路径。

## 4. Office 兼容性验证

脚本将三种引擎输出写入临时文件，再使用 Microsoft Office 只读打开并检查结构：

| 引擎输出 | Microsoft Office 验证 |
|---|---|
| DOCX checkpoint | Word 成功打开；100 页、200 段落 |
| XLSX checkpoint | Excel 成功打开；UsedRange 2,000 × 100 |
| PPTX checkpoint | PowerPoint 成功打开；100 张幻灯片 |

因此，本次样本证明了简单大文档在当前 Windows + Microsoft Office 环境下可以完成：Office 生成 → GenOffice/Mona 引擎打开或读取 → checkpoint/导出 → Microsoft Office 再打开。它不等价于完整 OOXML 保真验证，也没有证明 WPS、字体差异、复杂版式或图表兼容性。

## 5. 结论与未覆盖项

1. 当前样本上，Docs/PPTX 引擎解析与重打包在 Node 环境可完成；100 页 PPTX 的主要耗时是打开和构建 render tree（约 1.52 秒）。
2. 20 万单元格 XLSX 的 sidecar 分块读取约 0.48 秒，单次 checkpoint planner 约 0.44 秒；sidecar 明确限制单次读取响应不超过 20,000 个 cell，因此全表读取按 10 个请求完成。
3. 本报告没有给出 WebView2 首屏、Univer 实际绘制、用户输入延迟或 Agent apply 后可见时间。需要在最终 Mona 桌面构建中另测这些指标，不能用本表替代 500 ms 可见性门槛。
4. 本报告是单机单次测量，不提供 p50/p95、长时间编辑、内存峰值、并发会话或低配机器结论。应在发布门禁阶段至少重复多轮并记录分位数。
5. 本机没有 WPS，无法完成 WPS 回归；当前没有 macOS、Safari/WebKit、macOS sidecar 或 macOS 安装环境，无法提供 macOS 性能/兼容性数据。

## 6. 编辑器启动加载优化（2026-09-08）

当前构建配置把 `@univerjs/*` 与所有编辑器使用的 UI 放入同一个手动共享 chunk，导致 Word、PPT 也静态加载约 15.83 MB 的共享包。现已从公共 UI 的手动分组中移除 Univer，由 Rollup 按实际引用关系拆分表格依赖；React、公共 UI 和格式库继续共享。

### 6.1 同一源码修改前后的生产构建

两次构建均使用当前安装的 Vite，启用 manifest。以下统计从各 HTML 入口沿 `imports` 递归去重后的 JavaScript 字节总数，包含传递依赖，不包含动态导入、CSS、图片和文档本身。MB 按 1,000,000 字节计算。

| 入口 | 修改前静态 JS | 修改后静态 JS | 减少 |
|---|---:|---:|---:|
| Word | 19.82 MB | 4.01 MB | 79.7% |
| PPT | 19.87 MB | 4.06 MB | 79.6% |
| Excel | 20.61 MB | 11.18 MB | 45.7% |

Excel 在真实初始化过程中还会加载动态依赖，因此静态 JS 的减少不等于其全部启动加载量减少相同比例。

### 6.2 浏览器真实打开验证

本机使用 Playwright 驱动已安装的 Chromium headless shell，通过 loopback 静态 HTTP 服务加载生产构建。每次打开使用独立浏览器 context，修改前后交替测试，共 18 次（3 种格式 × 2 个构建 × 3 轮）。文件使用仓库 `tests/fixtures/office/blank.docx`、`blank.pptx`、`blank.xlsx`；Excel 调用实际内置 XLSX sidecar，三种格式均通过实际 MessageChannel 打开并收到 `office_editor_ready`，没有页面运行错误。

| 格式 | 修改前就绪时间中位数 | 修改后就绪时间中位数 | 减少 |
|---|---:|---:|---:|
| Word | 644.7 ms | 258.6 ms | 59.9% |
| PPT | 611.7 ms | 245.4 ms | 59.9% |
| Excel | 753.9 ms | 662.5 ms | 12.1% |

就绪时间从编辑器页面导航开始计至 `office_editor_ready`，包含入口加载和样例打开，不包含 Mona 外层会话创建、上传、宿主 HTTP/WS、Tauri 启动，也不保证所有像素已绘制。此结果仅表示本机空白样例的三轮中位数，不能外推为复杂文档或完整桌面首开的耗时承诺。该优化作用于生产构建，开发服务器的按需编译耗时不在测量范围内。

新增 `mona/build-chunks.test.ts` 使用真实 Vite 构建最小多入口样例并检查静态模块依赖闭包，防止表格引擎再次混入 Word/PPT，同时确认公共 UI 与 React 仍然可达。
