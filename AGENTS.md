# Mona 项目 Agent 规则

## 必读基线

开始修改前，根据任务范围阅读：

- 全局工程与安全边界：`docs/architecture/engineering-boundaries.md`
- 可下载运行时：`docs/architecture/runtime-component-management.md`
- 模块关键不变量：`docs/architecture/module-invariants.md`
- 后端进程和路由：`docs/architecture/services-split-design.md`
- 浏览器模块：`docs/architecture/browser-development-framework.md`
- 笔记/资料检索：`docs/architecture/retrieval-architecture.md`
- 用户画像与蒸馏：`docs/architecture/user-profile-distillation.md`
- UI/UX：`docs/design/mona-ui-design-system.md`

长期架构优先级高于临时设计和实施计划。发现文档与当前代码冲突时，先验证真实状态，再更新稳定文档，不能静默选择过期方案。

## 任务执行

- 长任务中，把边界清晰、可独立完成且成功标准明确的简单任务交给 Luna；复杂判断、跨模块整合和最终验收由主 Agent 负责。
- 先检查当前工作树。已有修改属于用户或其他任务，不还原、不覆盖、不顺手重构。
- 需求明确时直接完成并验证；只有关键选择无法从代码和文档确定时才追问。
- 删除前核对精确目标、Git 状态和引用；只删除用户授权范围内的内容。

## 编码规则

- 编写解决当前问题所需的最少代码，不设计范围外功能。
- 匹配现有结构和风格；单次逻辑不做抽象，不为不可能场景增加错误处理。
- 只修改必须修改的文件，不捆绑无关重构、依赖升级或格式化。
- 仅在意图不明显时添加注释；不保留注释代码、调试输出或临时兼容分支。
- 配置必须显式进入 `mona/config/schema.py`；错误必须可定位，禁止静默吞掉失败。
- Python 只运行 `ruff check`，不要对历史代码批量运行格式化。

## 架构与安全

- 新能力优先放在 channel、tool、skill、专家包或 MCP 边界；谨慎修改 Agent 核心循环。
- 所有可下载模型、解释器、浏览器和原生工具必须使用统一运行时仓库；禁止新增功能专用下载器或资源根目录。
- 用户提供的路径必须做 resolved-path 范围校验；用户提供的 URL 必须经过 SSRF 防护。
- 不在代码、文档、Skill、日志、测试或示例中写入密码、令牌、Cookie、私钥和生产凭据。
- system prompt 在单个 turn 内保持稳定；动态运行信息进入 user runtime context。

## UI/UX

- UI 符合用户心智，用户可见文本使用用户语言，不暴露内部进程、端口和工具名。
- 新 UI 使用现有共享组件和语义 Token，不新增任意产品色、字号、圆角和阴影。
- UI 改动不捆绑业务逻辑重构。
- 用户要求原型图、模拟图或线框图时使用图像生成能力，不以 HTML、CSS、Canvas、SVG 或 React 替代原型图像。

## 验证与交付

- Bug 修复增加距离故障最近的回归测试；跨进程契约同时验证生产端和调用端。
- 测试真实行为，不测试 mock 自身，不为测试向生产代码增加专用接口。
- 按风险运行相关 Python、Rust、前端测试及构建；不把窄测试描述成全量通过。
- 完成前逐项对照用户要求，以当前文件、测试、构建和真实运行结果作为证据。

## 文档位置

- `docs/architecture/`：长期跨模块架构，必须进入 Git。
- `docs/design/`：模块设计与阶段性方案。
- `docs/plans/`：实施计划和临时验收清单。
- `docs/guides/`：操作与开发指南。
- `docs/archive/`：不再指导实现但必须留档的历史材料。
- 根目录不新增开发计划；只保留 `README.md`、`AGENTS.md` 和生态要求的标准文件。
