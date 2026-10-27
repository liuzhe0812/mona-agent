---
name: mona-design
description: 网页与前端视觉设计、App 原型、信息图和设计评审；提供真实风格样张、参考源码、排印、配色与素材方法。PPT 和视频通过各自制作 Skill 按需复用这些设计资料。
metadata:
  author: 花叔；Mona 接入适配
  upstream: https://github.com/alchaincyf/huashu-design
  version: 3.0.0
---

# Mona Design

从用户内容、受众和使用场景形成设计，让图像、排版和信息关系承担表达。完整上游设计知识、样张和代码按需读取，不全部塞入上下文。固定版本和逐文件校验见 `provenance.json`，上游入口原文保留在 `references/upstream-skill.md`；本文件说明 Mona 的执行边界。

## 按任务使用

| 任务 | 设计入口与制作方式 |
|---|---|
| 网页、前端、桌面界面 | 读 [前端接入](references/mona-web.md)，再读 [网页设计](references/modules/web.md)。沿用实际项目框架、组件、交互和设计系统。 |
| App 原型 | 先读前端接入，再按需读 [App 设计](references/app-prototype.md)。 |
| 原生 PPT | 使用 `mona-pptx`，读 [原生 PPT 设计接入](references/native-pptx.md)。以 Office 当前文稿为准，继续原生制作与修改。 |
| 视频 | 使用 `mona-motion` 的动画创作、导演确认、配音与导出流程；本包补充相关视觉参考。 |
| 信息图、可视化 | 读 [信息图设计](references/modules/infographic.md)，按用户要求的媒介制作。 |
| 设计评审 | 读 [设计评审](references/critique-guide.md)，依据真实画面和用途指出可执行的问题；模型评分不是质量认证。 |

用户要求、项目规则、当前设计系统和对应制作工具的契约优先。原始模块中的 HTML 外壳、Babel 起手、固定画布和转换命令只适用于相应 HTML 产物，不能覆盖真实前端项目或 Office 文稿。PPT 不执行上游 HTML deck/PDF 转换流程。

## 设计工作

1. 从已有内容出发。读 [设计上下文](references/design-context.md)：现有代码、组件、品牌资产、用户参考优先。先查找已提供的信息，只有缺失会实质改变结果时再追问。
2. 明确主信息、观看距离、信息密度与视觉主角；按需读 [创作方法](references/workflow.md)、[素材方法](references/materials.md) 和 [品牌资产](references/brand-asset-protocol.md)。实际取得真实数据、产品图和截图，示例事实不能沿用。
3. 先看样张，再读源码和规则。读 [风格库](references/design-styles.md) 与 [排印](references/typography.md)，按内容形成构图、配色和字体关系。风格库是参考，不是必须选择的模板清单，也不限定只能使用其中风格。
4. 方向未定的新设计可用有差异的实际预览帮助选择；已有方向、指定参考或局部修改直接沿用，不强制三个版本、批准文件或额外确认。用户要求原型图时遵守当前项目对交付形式的约定。
5. 根据真实画面检查主次、可读性、素材、信息完整性与交互。使用 [评审](references/critique-guide.md)、[内容规则](references/content-guidelines.md) 和 [验证参考](references/verification.md)；网页像素、幻灯片字号和示例比例不是跨媒介硬指标。移除没有表达作用的装饰，保留服务内容的视觉手法。

## 读取真实样张和源码

`assets/style-specimens/` 完整保留五组样张及同名 HTML 源码。先看当前媒介总览，再打开相关单张与源码，无需逐一读取全部风格。

- 网页：`assets/style-specimens/sheet-web.jpg`
- PPT：`assets/style-specimens/sheet-ppt.jpg`
- 信息图：`assets/style-specimens/sheet-info.jpg`
- App：`assets/style-specimens/sheet-app.jpg`
- 中文与东亚：`assets/style-specimens/sheet-east.jpg`

普通 Work 使用 `skill_reference_read(skill="mona-design", ref_path="assets/style-specimens/sheet-web.jpg")` 读取真实图片；同样可用 `assets/...html` 读取源码。参考和源码均按 `offset` 与 `limit` 分页，回执 `nextOffset` 标明未读部分；只按当前问题补读，不默认加载整个风格索引。普通参考用 `ref_path="typography.md"` 等相对 `references/` 的路径。

开发工作台使用只读 `development_design_resource`，`path` 相对本包根目录，可列目录、读取参考、样张和源码；长文本用 `offset` 与 `limit` 分页。实现文件写回用户项目，内置资源保持只读。复用文件使用宿主允许的素材复制或项目文件工具，不能把路径说明当作已看到图片。

## 资源与脚本边界

上游 `assets/`、`references/`、`demos/`、`scripts/`、许可和依赖清单完整保留，可查看和复用已有代码。示例引用的 CDN、网络字体和运行时生成的配音不是内置离线素材；实际项目沿用自己的资源与依赖管理方式。

接入不执行上游安装命令、Hooks、云配音、自动更新或 `~/.huashu-design/` 偏好写入；偏好沿用 Mona 既有机制。运行脚本仍需宿主允许的执行能力与统一受管运行时，只读资源接口不授予执行权限。PPT 制作和视频正式导出由各自 Mona 工具负责。

本设计包不提供背景配乐素材、选曲或混音流程。独立的视频工作台及 Huashu Motion 的音频能力由其自身工具管理，不受本设计包的资源裁剪影响。
