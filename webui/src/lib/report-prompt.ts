export const HTML_REPORT_PROMPT = `此外，请将结果输出为一份完整的 HTML 报告，严格遵循以下设计规范：

【色彩体系】
- 主色：#1d6feb（Mona 蓝），用于封面、表头、标题装饰
- 主色浅：#4d8df5，用于渐变和悬停
- 点缀色：#c9a84c（金色），用于序号、分隔线、强调
- 背景：#ffffff（白），#f8f7f4（柔白），#faf9f6（区块背景）
- 文字：#2c2c2c（正文），#5a5a5a（次要），#8a8a8a（辅助）
- 边框：#e0ddd5（主边框），#eeece6（轻边框）
- 状态色：🟢 #16a34a / 🟡 #ca8a04 / 🔴 #dc2626

【封面区域】
- 全屏高度居中布局，背景渐变：linear-gradient(160deg, #0f172a 0%, #1e293b 40%, #1d6feb 100%)
- 顶部金色边框徽章（border: 1px solid rgba(201,168,76,0.5); border-radius: 30px），内容为报告类型（如"运维报告"）
- 标题 48px 加粗白色，关键词用点缀色高亮
- 副标题 18px 浅白色，字间距 6px
- 金色分隔线 80px 宽 2px
- 底部元信息（服务器名、时间）14px 半透明白色
- 两个装饰性径向渐变圆形（::before 右上角金色光晕，::after 左下角蓝色光晕），position absolute

【内容区域】
- 最大宽度 960px，居中，padding 80px 60px
- 章节编号：13px 金色字母间距 3px
- h2 标题：32px 加粗主色，字间距 2px，使用衬线字体风格
- h3 标题：20px 加粗主色，左边框 3px 金色，padding-left 16px
- 段落：15px 行高 1.8，次要文字色

【摘要卡片】
- 使用 2 列 grid 布局，gap 24px
- 每张卡片：圆角 10px，1px 轻边框，padding 28px
- 状态卡片背景色：🟢 #dcfce7 / 🟡 #fef9c3 / 🔴 #fee2e2
- 卡片内含指标名、数值、状态图标，悬停时边框变金色加阴影

【数据表格】
- 100% 宽度，border-collapse
- 表头：主色背景白色文字，padding 12px 16px，13px 字号，字母间距 1px
- 单元格：padding 12px 16px，底边框 1px 轻边框，次要文字色
- 偶数行：区块背景色
- 状态列使用对应颜色文字标注 🟢🟡🔴

【建议区域】
- 左边框 4px 主色，圆角 10px，区块背景，padding 28px
- 每条建议前加序号，建议标题加粗主色，说明文字次要色

【对比区域】（适用于前后对比、正常 vs 异常）
- 2 列 grid 布局
- 左侧（问题/异常）：#fef2f2 背景，#fecaca 边框，圆角左侧
- 右侧（方案/正常）：#f0fdf4 背景，#bbf7d0 边框，圆角右侧

【高亮框】
- 柔白背景 + 轻边框，圆角 8px，padding 28px 32px
- 用于关键结论、问题本质等强调内容

【页脚】
- 深色渐变背景 linear-gradient(160deg, #0f172a, #1e293b)
- 半透明白色文字，居中
- 显示"Mona AI · 报告标题 · 生成时间"

【技术要求】
- 所有样式使用内联 CSS（不依赖外部样式表和字体）
- font-family 使用系统字体栈：-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
- 响应式：768px 以下单列布局，封面标题缩小，grid 改为单列
- 不使用 JavaScript

将完整的 HTML 内容放在 \`\`\`html 代码块中。`;
