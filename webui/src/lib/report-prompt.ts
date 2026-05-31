export const HTML_REPORT_PROMPT = `此外，请将结果生成为一份 HTML 报告。严格遵循以下设计规范：

【重要】不要在聊天回复中输出 HTML 代码。必须使用 generate_report 工具来保存报告，参数：title（报告标题）和 content（完整 HTML 字符串）。在聊天中只需告诉用户报告已生成即可。

【色彩体系】
- 主色：#1a3a5c（深蓝），用于封面、表头、标题装饰、侧边栏标题
- 主色浅：#2c5f8a，用于渐变和悬停
- 点缀色：#c9a84c（金色），用于序号、分隔线、强调
- 背景：#ffffff（正文白），#f8f7f4（侧边栏/高亮框），#faf9f6（卡片/偶数行）
- 文字：#2c2c2c（正文），#5a5a5a（次要），#8a8a8a（辅助）
- 边框：#e0ddd5（主边框），#eeece6（轻边框）
- 状态色：🟢 #16a34a / 🟡 #ca8a04 / 🔴 #dc2626

【整体布局】
- 使用 content-wrapper（display: flex）包裹侧边栏和内容区
- 左侧 sidebar：宽度 240px，position: sticky，top: 0，height: 100vh，overflow-y: auto，背景 #f8f7f4，右边框 1px #eeece6
- 右侧 page 区域：flex: 1，最大宽度 960px，padding 80px 60px，背景 #ffffff（纯白）
- 768px 以下：sidebar 隐藏（display: none），content-wrapper 改为 display: block

【侧边栏目录】
- sidebar-title：padding 32px 24px 16px，16px 主色衬线字体，letter-spacing 2px，内容为"目录"
- sidebar-link：display: block，padding 10px 24px，13px 次要文字色，text-decoration: none，border-left: 3px solid transparent，transition: all 0.2s
- sidebar-link:hover：color 主色，background #faf9f6
- sidebar-link.active：color 主色，border-left-color 金色，background #faf9f6，font-weight 600
- 每个链接对应一个 h2 章节，href 指向对应 id（如 #s1, #s2）
- 使用 IntersectionObserver 监听 h2 元素，自动高亮当前章节的 sidebar-link

【封面区域】
- 全屏高度居中布局，背景渐变：linear-gradient(160deg, #0d1b2a 0%, #1b2d45 40%, #1a3a5c 70%, #2c5f8a 100%)
- 顶部金色边框徽章（border: 1px solid rgba(201,168,76,0.5); border-radius: 30px），内容为报告类型（如"运维报告"）
- 标题 52px 加粗白色衬线字体，letter-spacing 6px，关键词用点缀色高亮
- 副标题 20px 浅白色，letter-spacing 8px，opacity 0.85
- 金色分隔线 80px 宽 2px
- 底部元信息（服务器名、时间）14px 半透明白色
- 两个装饰性径向渐变圆形（::before 右上角金色光晕 rgba(201,168,76,0.12)，::after 左下角蓝色光晕 rgba(44,95,138,0.2)），position absolute

【内容区域】
- 章节之间用 .divider 分隔：width 100%，height 1px，background #e0ddd5，margin 80px 0
- 章节编号：13px 金色衬线字体，letter-spacing 3px
- h2 标题：32px 加粗主色衬线字体，letter-spacing 2px，带 id 属性供侧边栏锚点跳转
- h2 后跟 .section-desc：16px 次要文字色，margin-bottom 48px
- h3 标题：20px 加粗主色衬线字体，左边框 3px 金色，padding-left 16px
- h4 标题：16px 加粗主色浅，margin-top 28px
- 段落：15px 行高 1.8，次要文字色

【摘要卡片】
- 使用 2 列 grid 布局，gap 24px
- 每张卡片：圆角 10px，1px 轻边框，padding 28px，background #faf9f6
- 状态卡片背景色：🟢 #dcfce7 / 🟡 #fef9c3 / 🔴 #fee2e2
- 卡片内含指标名、数值、状态图标，悬停时边框变金色加阴影
- 卡片图标：44px 圆角 10px，背景渐变 linear-gradient(135deg, #1a3a5c, #2c5f8a)，白色图标

【数据表格】
- 100% 宽度，border-collapse
- 表头：主色（#1a3a5c）背景白色文字，padding 12px 16px，13px 字号，letter-spacing 1px
- 单元格：padding 12px 16px，底边框 1px #eeece6，次要文字色
- 偶数行：background #faf9f6
- 状态列使用对应颜色文字标注 🟢🟡🔴

【建议区域】
- 左边框 4px 主色，圆角 10px，background #faf9f6，padding 28px
- 每条建议前加序号，建议标题加粗主色，说明文字次要色

【对比区域】（适用于前后对比、正常 vs 异常）
- 2 列 grid 布局
- 左侧（问题/异常）：#fef2f2 背景，#fecaca 边框，圆角左侧
- 右侧（方案/正常）：#f0fdf4 背景，#bbf7d0 边框，圆角右侧

【高亮框】
- background #f8f7f4 + 1px #eeece6 边框，圆角 8px，padding 28px 32px
- 用于关键结论、问题本质等强调内容

【页脚】
- 深色渐变背景 linear-gradient(160deg, #0d1b2a, #1a3a5c)
- 半透明白色文字（rgba(255,255,255,0.6)），居中
- 金色高亮品牌名（color: #e8d59a; font-weight: 600）
- 显示"Mona AI · 报告标题 · 生成时间"

【技术要求】
- 所有样式写在 <style> 标签中（不依赖外部样式表和字体）
- font-family 使用系统字体栈：-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
- 响应式：768px 以下单列布局，封面标题缩小，grid 改为单列，sidebar 隐藏
- 允许使用少量 JavaScript 实现 IntersectionObserver 侧边栏高亮`;
