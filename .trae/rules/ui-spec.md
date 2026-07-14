# UI 规范

本文件汇总前端 UI 视觉与交互规范，所有新增组件、页面调整都应遵循此处规则。已落地实现的规则以本文件为准；如与 `project_rules.md` 中的 UI 规范冲突，以本文件为准。

## 滚动条

滚动条默认必须保持安静：未悬停时完全隐藏，悬停容器时才淡入显示浅色 thumb。禁止使用浏览器原生高对比滚动条样式。

### 工具类

| 类名 | 适用场景 | 宽度 | Thumb 颜色（容器 hover） | Thumb 颜色（thumb hover） |
|------|---------|------|--------------------------|---------------------------|
| `.scrollbar-hover` | 内容区滚动首选：列表、面板、聊天、助手主体 | 8px | `hsl(var(--muted-foreground) / 0.15)` | `hsl(var(--muted-foreground) / 0.28)` |
| `.scrollbar-thin` | 紧凑滚动区：窄侧边栏、下拉、代码块、横向 tab 条 | 6px | `hsl(var(--muted-foreground) / 0.2)` | `hsl(var(--muted-foreground) / 0.32)` |
| `.scrollbar-none` | 完全隐藏滚动条（如临时滚动、自定义分页 UI） | — | — | — |

### 行为规则

1. `.scrollbar-hover` 与 `.scrollbar-thin` 默认 `scrollbar-color: transparent transparent`，仅当容器自身被 hover（`:hover`）时 thumb 才淡入。用户不交互时 UI 保持安静。
2. 轨道（track）一律 `transparent`，禁止给轨道着色。
3. Thumb 使用 `border-radius: 9999px`（胶囊形）。`.scrollbar-hover` 额外用 2px 透明 border + `background-clip: padding-box` 让 thumb 与边缘之间留出小间隙。
4. Thumb 颜色必须使用 `hsl(var(--muted-foreground) / <alpha>)`，自动适配明暗主题。禁止硬编码 `rgb()` 或 hex 值。
5. 颜色过渡：Firefox 用 `transition: scrollbar-color 0.2s ease`，WebKit 用 thumb 上的 `transition: background-color 0.2s ease`，实现柔和淡入。
6. 类名加在拥有 `overflow-y-auto` / `overflow-x-auto` 的同一元素上。示例：`<div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">`。
7. 若滚动容器需要 `scrollbar-gutter: stable` 防止布局抖动，配合 `.scrollbar-track-transparent` 让预留空间保持透明，直到 hover。
8. 禁止在同一元素上同时使用 `.scrollbar-thin` 和 `.scrollbar-hover`，根据可用宽度二选一。

### 透明度约定

- 默认隐藏（透明）：thumb 在容器未 hover 时不可见。
- 容器 hover：thumb 以低透明度（0.15 ~ 0.2）淡入，仅作为"可滚动"提示。
- Thumb hover：透明度提升到 0.28 ~ 0.32，便于用户抓取拖动。
- 任何状态都不超过 0.35，避免滚动条喧宾夺主。
