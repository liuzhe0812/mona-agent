# GenOffice 上游快照

本目录的上游源码快照固定于 GenOffice `v0.8.667`，用于 Mona Office Editor 的后续独立构建和适配。

## 来源与固定版本

- 来源仓库：<https://github.com/genspark-ai/genoffice>
- Tag：`v0.8.667`
- 完整 commit：`583a045212f871943afb8ca4503fcb5ddf99a23f`
- 上游 commit 页面：<https://github.com/genspark-ai/genoffice/commit/583a045212f871943afb8ca4503fcb5ddf99a23f>
- 导入日期：`2026-09-04`
- 上游 commit 时间：`2026-08-27T10:14:38Z`
- 固定依据：`git ls-remote --tags` 返回上述 tag commit；本地 detached checkout 的 `HEAD` 与该 commit 完全一致。
- `LICENSE` SHA-256：`68e32334df324ef4fc79fad3a26487e5abac36055a484bb6c8d7ecf9d8350885`
- `NOTICE` SHA-256：`ff1ad79ed52b0f5c1d0e10a9370c22c0c0e6ee83074b6a9b644b25ab7b129f94`

`vendor/genoffice/SOURCE-MANIFEST.sha256` 为导入文件清单。每一行同时记录上游 Git blob SHA、导入文件 SHA-256、字节数和相对路径，清单本身不包含在清单条目中。

## 导入范围

以下目录最初从固定 commit 按原始字节导入；后续本地改动见下方补丁记录，导入清单保留为原始基线：

| 路径 | 文件数 | 字节数 |
| --- | ---: | ---: |
| `vendor/genoffice/apps/docs` | 361 | 19,531,029 |
| `vendor/genoffice/apps/sheets` | 398 | 9,946,815 |
| `vendor/genoffice/apps/slides` | 233 | 7,417,821 |
| `vendor/genoffice/packages/agent-core` | 11 | 97,548 |
| `vendor/genoffice/packages/ai-provider` | 28 | 146,267 |
| `vendor/genoffice/packages/ai-search` | 11 | 77,364 |
| `vendor/genoffice/packages/docx-engine` | 123 | 1,791,132 |
| `vendor/genoffice/packages/electron-utils` | 24 | 86,655 |
| `vendor/genoffice/packages/file-parse` | 18 | 510,443 |
| `vendor/genoffice/packages/font-metrics` | 11 | 35,415 |
| `vendor/genoffice/packages/i18n` | 5 | 13,871 |
| `vendor/genoffice/packages/pptx-engine` | 122 | 1,461,705 |
| `vendor/genoffice/packages/pptx-render` | 25 | 502,709 |
| `vendor/genoffice/packages/project-store` | 8 | 70,914 |
| `vendor/genoffice/packages/ui` | 20 | 67,841 |
| `vendor/genoffice/LICENSE-UNICODE.txt` | 1 | 1,995 |
| **上游文件合计（不含本地清单/索引）** | **1,399** | **41,759,524** |

本地元数据文件 `SOURCE-MANIFEST.sha256` 和 `THIRD-PARTY-NOTICES.txt` 不计入上表；前者用于完整性校验，后者用于许可证索引。

`LICENSE` 和 `NOTICE` 位于 `webui/office-editor/`，均为上游固定 commit 中的原文副本。上游根目录的工作区脚本、锁文件和构建工具不作为 Mona 编辑器的构建输入，因此未导入；D0-03 使用独立的 `webui/office-editor/package.json` 与 Vite 入口。

`agent-core`、`ai-provider` 和 `ai-search` 虽随上游编辑器源码保留，但只用于保持快照的源码闭合；Mona 入口不解析或启动其中的 Genspark AI 能力。

## 明确排除项

### 2026-09-21 图表主题补丁

为原生 PPT 明暗主题补齐 `setChart.patch` 的 `gridColor`、`axisLineColor` 和 `axisLabelFontSize`（pt），修改了 `packages/pptx-engine/src/chart-style.ts`、`packages/pptx-engine/src/index.ts`、`apps/slides/src/main/ops/table-ops.ts` 和 `apps/slides/src/shared/op-docs.ts`。使用 OOXML 的轴文字与线条属性，复用既有解析、渲染与保存路径；不改变数据模型。对应回归为 `mona/chart-style-roundtrip.test.ts`。`SOURCE-MANIFEST.sha256` 仍描述原始导入内容，不冒充已修改文件的当前摘要。

- `ee/`：企业模块。
- `apps/pdf/`、`apps/markdown/`、`apps/shell/`：不属于 Mona 三编辑器入口。
- `packages/pdf2docx/`：PDF 转换能力不在本计划范围内。
- 上游根目录的 PDF、Markdown、Shell、示例、E2E 和发布构建入口。
- `node_modules/`、`out/`、`dist/`、`release/`、Rust `target/` 等生成或下载目录；本次未提交构建产物。

Docs/Sheets/Slides 源码中原有的 Electron main/preload、AI、更新器、遥测相关代码和品牌资源保持为上游来源的一部分，但不被 Mona 的独立入口引用；Mona 不使用这些能力，也不复制其桌面壳、账户、云服务或品牌 UI。后续 adapter/build patch 必须继续保持该边界。

## 2026-09-23 原生图表创建回执

`apps/slides/src/main/ops/insert-ops.ts` 在 `addChart` 创建时立即返回原生对象的 durable ID，避免同一事务中后续图表插入重解析页面后使前一个 `chart_N` 临时 ID 失效。数据与保存格式不变；`mona/slides-entry.test.ts` 覆盖双图表创建、独立样式、保存重开及失败回滚。导入清单仍保留原始基线。

## 2026-09-23 原生自由形状与文字体属性

为数据驱动的可编辑信息图形新增 `packages/pptx-engine/src/custom-path.ts`，只接受有限、归一化的 M/L/C/Z 指令，生成原生 `a:custGeom`，不接受任意 XML/SVG 或外部资源。`insert.ts` 与 `apps/slides/src/main/ops/insert-ops.ts` 将该结构接入既有原子插入和保存路径；同时使创建时的正文内边距、换行与垂直对齐在内存模型和保存文件中一致。原始导入清单保持不变。对应回归见 `mona/slides-design.test.ts` 与 `mona/slides-entry.test.ts`，包括原生曲线保存重开及拒绝畸形输入。

## 许可证与品牌

- 上游 Apache License 2.0：`webui/office-editor/LICENSE`。
- 上游归属与 Unicode 数据说明：`webui/office-editor/NOTICE`、`vendor/genoffice/LICENSE-UNICODE.txt`。
- 快照内第三方许可证索引：`vendor/genoffice/THIRD-PARTY-NOTICES.txt`。
- 源码内随附的第三方许可证原文仍保留在其上游路径，例如 `apps/docs/src/renderer/fonts/LICENSE-OFL.txt`、`apps/docs/tests/encrypted-fixtures/LICENSE-msoffcrypto-tool.txt`、`packages/docx-engine/src/vendor/emf-converter/LICENSE` 和 `packages/pptx-engine/tests/fixtures/LICENSE-python-pptx.txt`。

上游名称和标识仅在未修改的来源文件及 Apache 要求的归属文本中出现。Mona 的产品、入口、安装包和用户界面不得使用 GenOffice 或 Genspark 商标、图标或品牌资源。
