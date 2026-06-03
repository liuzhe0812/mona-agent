## 1. 架构设计

```mermaid
flowchart TB
    subgraph "前端层"
        "React 18 + TypeScript"
        "Vite 构建工具"
        "Tailwind CSS 样式"
        "Framer Motion 动画"
    end
    subgraph "动画层"
        "Canvas 矩阵代码雨"
        "Canvas 粒子网络"
        "CSS Transitions"
        "Intersection Observer"
    end
    subgraph "静态资源"
        "平台/模型 Logo 图标"
        "产品截图"
        "字体资源"
    end
    "前端层" --> "动画层"
    "前端层" --> "静态资源"
```

## 2. 技术说明

- **前端框架**：React@18 + TypeScript + Vite
- **初始化工具**：vite-init (react-ts 模板)
- **样式方案**：Tailwind CSS@3 + CSS Modules（动画关键帧）
- **动画库**：Framer Motion（滚动动画、页面过渡）
- **Canvas 动画**：原生 Canvas API（矩阵代码雨、粒子网络）
- **后端**：无（纯静态网站）
- **数据库**：无

## 3. 路由定义

| 路由 | 用途 |
|------|------|
| / | 单页应用首页，包含所有内容区域 |

## 4. 组件架构

```mermaid
flowchart TD
    "App" --> "HeroSection"
    "App" --> "ChannelsSection"
    "App" --> "ModelsSection"
    "App" --> "ToolsSection"
    "App" --> "SkillsSection"
    "App" --> "DesktopSection"
    "App" --> "QuickStartSection"
    "App" --> "CommunitySection"
    "App" --> "Footer"
    "App" --> "MouseGlow"
    "HeroSection" --> "MatrixRain"
    "HeroSection" --> "TypewriterText"
    "ChannelsSection" --> "ChannelCard"
    "ModelsSection" --> "ModelCard"
    "ToolsSection" --> "ToolCard"
    "SkillsSection" --> "SkillCard"
    "QuickStartSection" --> "TerminalBlock"
    "CommunitySection" --> "CounterAnimation"
```

## 5. 关键组件说明

### 5.1 MatrixRain（矩阵代码雨）
- Canvas 全屏背景动画
- 随机生成 0/1 字符列，不同速度下落
- 透明度渐变，营造深度感
- 使用 requestAnimationFrame 驱动

### 5.2 ParticleNetwork（粒子网络）
- Canvas 绘制随机分布的节点
- 节点间距离小于阈值时绘制连线
- 鼠标位置作为引力源，节点被吸引
- 性能优化：限制节点数量（50-80个）

### 5.3 MouseGlow（鼠标光晕）
- 跟随鼠标的径向渐变光晕
- 使用 CSS radial-gradient + pointer-events: none
- 光晕颜色为微弱青色 (#00FFCC)，低透明度

### 5.4 TypewriterText（打字机效果）
- 逐字显示文本，带光标闪烁
- 支持多行文本循环播放
- 使用 CSS animation + JS 定时器

### 5.5 ScrollReveal（滚动动画）
- 基于 Intersection Observer
- 元素进入视口时添加动画类
- 支持淡入、滑入、缩放等效果
- 可配置延迟和持续时间

### 5.6 TerminalBlock（终端代码块）
- 模拟终端界面样式
- 绿色光标闪烁
- 命令逐行出现动画
- 黑底绿字/白字风格

### 5.7 CounterAnimation（计数器动画）
- 数字从 0 递增到目标值
- 使用 requestAnimationFrame
- 缓动函数实现自然减速

## 6. 性能优化策略

- Canvas 动画使用 requestAnimationFrame，避免 setInterval
- 粒子网络限制节点数量
- 图片使用 WebP 格式 + 懒加载
- CSS 动画优先使用 transform 和 opacity（GPU 加速）
- 组件按需渲染，使用 React.memo 避免不必要的重渲染
- 字体使用 font-display: swap 避免阻塞渲染
