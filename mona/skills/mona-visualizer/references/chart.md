# Charts

普通柱状图、折线图、散点图和饼图使用内联 SVG 与原生 JavaScript，直接交给 Mona 的 `show_widget`。不需要下载图表库、访问 CDN 或安装 Python/Node 包。按用户的真实数据生成坐标、标签和单位；下面数值仅作代码示例。

```html
<svg viewBox="0 0 480 240" width="100%" role="img" aria-labelledby="revenue-title revenue-desc">
  <title id="revenue-title">季度收入</title>
  <desc id="revenue-desc">第一至第四季度收入分别为 12、19、8、15 万元。</desc>
  <g fill="var(--color-text-secondary)" font-size="13" font-family="var(--font-sans)">
    <text x="24" y="24">收入（万元）</text>
    <text x="84" y="226">Q1</text><text x="184" y="226">Q2</text>
    <text x="284" y="226">Q3</text><text x="384" y="226">Q4</text>
  </g>
  <path d="M40 200H450" stroke="var(--color-border-secondary)"/>
  <g fill="#3266ad">
    <rect x="70" y="104" width="52" height="96"><title>Q1：12 万元</title></rect>
    <rect x="170" y="48" width="52" height="152"><title>Q2：19 万元</title></rect>
    <rect x="270" y="136" width="52" height="64"><title>Q3：8 万元</title></rect>
    <rect x="370" y="80" width="52" height="120"><title>Q4：15 万元</title></rect>
  </g>
  <g fill="var(--color-text-primary)" font-size="13" text-anchor="middle">
    <text x="96" y="96">12</text><text x="196" y="40">19</text>
    <text x="296" y="128">8</text><text x="396" y="72">15</text>
  </g>
</svg>
```

需要筛选或场景切换时，用原生按钮、滑杆和 `addEventListener` 更新同一个 SVG，不创建应用之外的服务。文字、数值、图例和悬停提示使用用户语言；页面内多个图表的元素 ID 必须唯一。

- 柱状图从零基线开始；折线图若截断坐标轴，明确标注范围。
- 坐标范围覆盖实际最大值、最小值；散点和气泡图留出约 10% 边距。
- 每个数据系列同时使用标签、线型或形状，不只靠颜色区分。
- 颜色跟随当前宿主主题，SVG 可使用宿主 CSS 变量。
- 负值写成 `-$5M`，不用 `$-5M`；单位一致。

只有任务确实需要第三方图表库且在线资源可用时，才按公共指南中的 CSP 白名单加载。库加载失败不能留下空白图表，基础图表仍使用上面的无外部依赖路径。
