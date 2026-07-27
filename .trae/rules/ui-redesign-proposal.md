# Mona UI 设计语言 v2 —— 基于 Buzz 分析的改造提案

> 状态：提案草案 | 适用范围：Mona Desktop 全模块 | 与 `ui-spec.md` 关系：补充 + 部分升级，不直接替换

---

## 一、设计哲学

**「工程师审美的低饱和暖中性 + Mona 品牌色在画布上发声」**

五条核心原则：

1. **画布做品牌，组件做功能** —— 99% 的 UI 用中性色，品牌识别度集中在侧边栏画布、onboarding、logo 等少数"发声位"，组件本身保持中性
2. **密度高但静谧** —— 信息密集承载，但动效安静、滚动条安静、阴影克制，不喧宾夺主
3. **平台缺陷显式 hack** —— Tauri/WKWebView 的已知问题用注释明确的 CSS hack 解决，不回避、不静默纠正
4. **字号系统治理** —— 用 rem 定义微小字号，禁字面量 px，保证 Cmd+/- 缩放跟随
5. **可访问性全局尊重** —— `prefers-reduced-motion`、`prefers-color-scheme` 必须生效，不是可选项

---

## 二、设计 Token

### 2.1 配色

#### 主色盘（保留 shadcn/zinc baseColor，调整氛围）

| Token | Light HSL | Dark HSL | 用途 |
|---|---|---|---|
| `--background` | `220 23% 95%` | `232 23% 18%` | 主背景（暖米白 / 深石板蓝） |
| `--foreground` | `234 16% 35%` | `227 68% 88%` | 主文字 |
| `--primary` | Mona 品牌色 | Mona 品牌色亮一档 | 主交互 |
| `--muted` | `223 16% 83%` | `230 19% 26%` | 次级背景 |
| `--muted-foreground` | `233 13% 41%` | `228 39% 80%` | 次级文字 |
| `--border` | `225 14% 77%` | `231 16% 34%` | 边框 |
| `--destructive` | `347 87% 44%` | `351 74% 73%` | 危险 |
| `--sidebar` | `218 25% 94%` | `232 23% 16%` | 侧边栏（比主背景冷一档） |

**关键变化**：从纯白/纯黑改为**暖米白 + 深石板蓝**，降低对比疲劳，护眼。

#### 品牌画布色（Mona 自有，不抄 Buzz chartreuse）

- 侧边栏画布：Mona 品牌色低饱和变体 → 辅助色的垂直渐变（基于现有翡翠绿/琥珀金体系，具体色值待视觉评审）
- onboarding：Mona 品牌色铺底 + 24×24 圆点网格（`rgb(0 0 0 / 0.08)` 1px 圆点）
- 私密信息（密钥、token）：橄榄褐墨色 `#717106` 类似语义色

#### 语义扩展色

- `--status-added` / `--status-deleted` / `--status-modified`：git diff 三态（笔记版本对比）
- `--ui-warning` / `--ui-warning-bg`：警告
- `--chart-1..5`：图表配色（画像/轨迹模块）

### 2.2 字体

- **主字体**：`"Inter Variable"` → `Inter` → 系统字体回退
  - 用 `@fontsource-variable/inter` 自托管可变字体，避免 FOUT
- **等宽字体**：`ui-monospace, monospace`（系统优先），用于代码块、内联代码、密钥
- **字重**：500 高频使用（chip、徽章、强调），不是 700

| Token | 大小 | 用途 |
|---|---|---|
| `text-3xs` | 8px (0.5rem) | **仅拉丁/数字/图标**，中文禁用 |
| `text-badge` | 10px (0.625rem) | 紧凑状态徽章 |
| `text-2xs` | 11px (0.6875rem) | meta 文本主力：时间戳、计数 |
| `text-xs` | 12px | 标准 |
| `text-sm` | 14px | 正文 |
| `text-title` | 40px / 1.15 / -0.02em | onboarding 标题 |

**治理规则**：
- 所有微小字号必须用 rem 定义
- 禁止 `text-[…px]` 字面量（配 lint 脚本 `check:px-text`）
- 中文最小字号 11px（笔画密度考虑）

### 2.3 圆角

**保留 Mona 现有体系**（不抄 Buzz 的 10px 全局）：

- 输入框：`rounded-full`（单行）/ `rounded-lg`（多行）
- 卡片/面板：`rounded-lg` (8px)
- 徽章/状态点：`rounded-full` (9999px)
- 抽屉/浮层：`rounded-2xl` (16px) —— 比 Buzz 的 24px 更克制

### 2.4 阴影

**整体偏扁平，1px 发丝边为主**：

| Token | 值 | 用途 |
|---|---|---|
| `shadow-hairline` | `-1px -1px 0 0 hsl(var(--border) / 0.45)` | 内容边缘代替阴影 |
| `shadow-panel-left` | `-1px 0 0 0 hairline, -16px 0 32px -12px rgb(0 0 0 / 0.18)` | 右锚面板 |
| `shadow-content-edge` | `-1px -1px 0 0 hairline, 0 0 4px 0 rgb(0 0 0 / 7%)` | 内容卡片浮起 |
| `shadow-drawer` | `0 10px 24px -12px rgb(0 0 0 / 62%), 0 2px 7px -4px` | 抽屉打开 |
| `shadow-popover` | `0 6px 18px rgb(0 0 0 / 0.02), 0 3px 9px rgb(0 0 0 / 0.04)` | 弹层 |

### 2.5 间距

- 新增 `spacing.4.5 = 1.125rem`（4 与 5 之间的精细档位）
- 列表行 `contain-intrinsic-size: auto 60px`（timeline）/ `auto 2rem`（侧边栏）

### 2.6 动效

| Token | 值 | 用途 |
|---|---|---|
| `--ease-primary` | `cubic-bezier(0.32, 0.72, 0, 1)` | 主缓动（抽屉、面板） |
| `--ease-secondary` | `cubic-bezier(0.22, 1, 0.36, 1)` | 弹性 overshoot |
| `--duration-fast` | 260ms | 抽屉/面板 |
| `--duration-medium` | 300ms | 淡入 |
| `--duration-slow` | 500ms | 揭示动画（比 Buzz 760ms 更快） |

- 全局 `prefers-reduced-motion: reduce` → `animation/transition: none`
- `will-change` 显式标注 `transform, opacity`
- 动画库用 `motion`（Framer Motion 新包名）

---

## 三、组件规范补充

### 3.1 App Shell

```css
html, body {
  overflow: hidden;
  overscroll-behavior: none;
  height: 100%;
}
```

- 文档自身永不滚动，所有滚动内化到子容器
- 禁止橡皮筋效果（桌面应用标准）

### 3.2 Cursor 恢复（Tailwind v4 升级必备）

Tailwind v4 preflight 默认移除了 button 的 `cursor: pointer`，必须在 base 层显式恢复：

```css
@layer base {
  button, a, summary, [role="button"] {
    cursor: pointer;
  }
  button:disabled, [aria-disabled="true"] {
    cursor: default;
  }
}
```

### 3.3 滚动条（与现有 ui-spec.md 一致，补充 WKWebView hack）

现有 `.scrollbar-hover` / `.scrollbar-thin` / `.scrollbar-none` 规范保留。

**补充**：在 sticky blurred chrome 内嵌场景，用 `scrollbar-gutter: stable` + 自定义 overlay 指示器，避免 `backdrop-filter` 子元素盖住原生滚动条（Tauri WKWebView 已知问题）。

### 3.4 长列表虚拟化

```css
.timeline-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 60px;
}
.timeline-row:hover,
.timeline-row:focus-within {
  content-visibility: visible;
}
```

比 `@tanstack/react-virtual` 更轻，保留 DOM 状态（open details、拖拽、深链）。hover/focus-within 例外避免交互行被跳过渲染。

### 3.5 Mention Chip

```css
.mention-chip {
  border-radius: calc(var(--radius) - 4px);
  background: hsl(var(--primary) / 0.15);
  color: hsl(var(--primary));
  font-weight: 500;
  min-height: 1.5rem;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  transition: background-color 150ms;
}
.mention-chip:hover {
  background: hsl(var(--primary) / 0.25);
  color: hsl(var(--primary) / 0.9);
}
```

`box-decoration-break: clone` 保证多行换行时胶囊样式不破。

### 3.6 品牌画布策略

- 侧边栏：渐变画布（Mona 品牌色 → 辅助色），子 chrome 透明让渐变穿透
- 选中项：light `rgb(0 0 0 / 7%)`，dark `color-mix(in srgb, white 16%, transparent)`
- Hover 非 active：light `rgb(0 0 0 / 4%)`，dark `rgb(255 255 255 / 4%)`
- active pill 去掉 shadow 强调扁平

### 3.7 HDR Gain Map 限幅

用户上传的头像在某些显示器上会"过亮发光"，一行 CSS 防护：

```css
img {
  dynamic-range-limit: standard;
}
```

---

## 四、与现有 ui-spec.md 的差异

| 维度 | 现有 ui-spec.md | v2 提案 | 说明 |
|---|---|---|---|
| 背景 | 纯白/纯黑 | 暖米白/深石板蓝 | 护眼 |
| 主色 | shadcn 默认 | Mona 品牌色 + 画布发声 | 品牌识别 |
| 字号 | 标准 Tailwind | + 三档亚微小字号 + 治理脚本 | 信息密度 |
| 阴影 | Tailwind 默认 | 自定义 token（hairline/panel-left 等） | 精准控制 |
| 间距 | 标准 Tailwind | + spacing.4.5 | 精细档位 |
| 动效 | 未明确 | 缓动/时长 token + reduced-motion | 可访问性 |
| App shell | 未明确 | fixed-height + overscroll-behavior | 桌面应用标准 |
| 长列表 | 未明确 | content-visibility: auto | 性能 |
| Tailwind v4 | 未提及 | cursor 恢复规则 | 升级必备 |
| 滚动条 | 已有完善规范 | 补充 WKWebView hack | 平台适配 |

---

## 五、分模块改造建议

### 5.1 聊天模块（高优先级）
- 消息流用 `content-visibility: auto` 虚拟化
- 时间戳/计数徽章用 `text-2xs` / `text-badge`
- Mention chip 用 3.5 节规范
- 滚动条已有规范，补充 WKWebView hack

### 5.2 笔记模块（高优先级）
- 笔记列表行用 `content-visibility: auto`
- 笔记版本对比用 git diff 三态色
- 编辑器光标颜色已有规范（跟随 `--foreground`）

### 5.3 邮件模块（中优先级）
- 邮件列表虚拟化
- 联系人 mention chip 规范化
- 链接预览品牌色策略（各服务定义 token，如 GitHub `#24292f`、Linear `#5e6ad2`）

### 5.4 画像/轨迹模块（中优先级）
- 图表用 `--chart-1..5` token
- 可视化沿用现有翡翠绿/琥珀金/珊瑚橙/青蓝配色（已有规范）
- 动效用 `--ease-secondary` 弹性缓动

### 5.5 视频模块（低优先级）
- 项目列表虚拟化
- 不需要 Huddle 那种独立深色 token 集
- 局部深色容器即可

### 5.6 Onboarding（低优先级）
- 用 `mask-reveal-up` 动画（blur + translate + scale），时长压到 500ms
- 品牌色铺底 + 点阵网格
- 不需要 Buzz 那种 460 行私钥备份叙事

---

## 六、落地路线图

### 阶段 1：基础设施（必备，不破坏现有视觉）
- [ ] App shell：fixed-height + overscroll-behavior
- [ ] Tailwind v4 cursor 恢复规则
- [ ] 字号治理：定义 `text-2xs` / `text-badge` / `text-3xs`，加 lint 脚本
- [ ] 动效 token：缓动/时长 + reduced-motion
- [ ] 阴影 token：hairline / panel-left / content-edge

### 阶段 2：性能与密度（中风险，需测试）
- [ ] 长列表 `content-visibility: auto`
- [ ] 暖米白/深石板蓝背景切换
- [ ] spacing.4.5 引入

### 阶段 3：品牌强化（视觉变化大，需评审）
- [ ] 侧边栏画布渐变
- [ ] active pill 去 shadow
- [ ] onboarding 动画升级

### 阶段 4：模块级落地（按模块推进）
- [ ] 聊天 mention chip + 滚动条 hack
- [ ] 笔记 git diff 色 + 列表虚拟化
- [ ] 邮件链接预览品牌色
- [ ] 画像图表 token 统一

---

## 七、不采纳的 Buzz 元素（明确排除）

- ❌ **chartreuse 黄绿 + 浅蓝渐变** —— Buzz 品牌指纹，照搬等于抄 logo 色
- ❌ **`--radius: 10px` 全局** —— 破坏 Mona 现有圆角体系
- ❌ **`text-3xs = 8px` 用于中文** —— 笔画密度高，不可读，仅适用拉丁/数字/图标
- ❌ **Huddle 独立深色 token 集** —— 视频会议场景特殊需求，Mona 视频模块局部深色容器即可
- ❌ **Onboarding 460 行专属 CSS** —— 为私钥备份强叙事写的，Mona onboarding 更轻量
- ❌ **双图层渐变 hack** —— 无 WKWebView fixed-background raster bug 不需要
- ❌ **`lucide-react ^1.0.0` 追新升级** —— 与现有版本可能不兼容，不为追新而升级

---

## 八、参考文件路径（Buzz 源码）

供进一步深入研究：

- 主题 token：`desktop/src/shared/styles/globals/theme.css`
- 滚动条：`desktop/src/shared/styles/globals/scrollbars.css`
- 组件样式：`desktop/src/shared/styles/globals/components.css`
- Markdown 渲染：`desktop/src/shared/styles/globals/markdown.css`
- Tailwind 配置：`desktop/tailwind.config.js`
- shadcn 配置：`desktop/components.json`（`style: new-york`, `baseColor: zinc`）
