# Mona Design → Mona 前端开发

Huashu 的设计方法、样张、源码、素材和评审可用于真实前端项目；上游 HTML 原型的文件组织不是生产应用的实现要求。

先读当前项目规则、路由、页面、共享组件、设计 Token 和依赖。已有产品沿用其视觉与交互语言，改造范围跟随用户任务。开发 Mona 自身时遵守 `docs/design/mona-ui-design-system.md`，不由参考样张另造产品色、字号或控件。

按需读 `design-context.md`、`modules/web.md`、`design-styles.md`、`typography.md`、`materials.md` 与 `critique-guide.md`。先看 `assets/style-specimens/sheet-web.jpg`（App 为 `sheet-app.jpg`），再读相关单张和 HTML 源码。用户要求原型图时遵循当前项目对图像交付的约定。

实现使用项目已有框架和组件，保持真实路由、数据、状态、表单与可访问性。浏览器窗口、设计画布、Babel 单文件与 localStorage 调参示例只在相应演示中复用，不覆盖现有业务页面，也不以静态假交互代替功能。

未定方向且选择显著影响结果时才提供有差异的实际预览；已选方向、明确参考和局部修改不增加固定三方向或批准文件。缺失信息先从项目与已有资料查找，关键缺失再追问。

网页检查复用当前已授权的 Mona 浏览器工具，按 [验证参考](verification.md) 在同一个 `tabId` 上使用 `browser_observe` 读取、截图，使用 `browser_act` 点击、输入或执行 DOM 采样。先运行项目已有测试，再检查实际交互、加载/空/错误状态、字体与素材；响应式只记录实际检查过的窗口尺寸。宿主未提供的视口切换、完整控制台历史和录屏记为未验证，不通过独立 Playwright、CDP 或浏览器安装补齐。

读取样张或执行截图不是质量通过的证明。代码写入当前项目，内置资料只读；不通过资源工具执行安装器、Hooks、云 API 或额外偏好写入。
