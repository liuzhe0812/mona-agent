# Scene HTML Generation Prompt

Single-scene HTML generation prompt for `/api/video/ai/scene-html`. Used when user triggers "重新生成本场景" or first-time scene HTML generation in ProducingPhase.

## Input

- Scene metadata: `{index, title, duration, visual, animation, narration, assets}`
- Style lock: `storyboard_lock.md` content (visual style, color palette, fonts, timing conventions)
- Resolution: from `meta.json` (e.g. `1920x1080`)

## Output

A single self-contained HTML file written to `scenes/scene_NN.html`. **Output only the HTML content, no markdown fences, no explanation.**

## Template

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Scene N: <title></title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
  <style>
    /* 内联样式，遵循 storyboard_lock 的配色和字体 */
  </style>
</head>
<body>
  <div class="scene" data-start="0" data-duration="<duration>">
    <!-- 场景内容，根据 visual 字段实现 -->
  </div>
  <script>
    // GSAP timeline 动画，根据 animation 字段实现
    // 必须在 DOMContentLoaded 后执行
    document.addEventListener('DOMContentLoaded', () => {
      gsap.timeline()
        // .to('.element', { duration: 0.5, opacity: 1, x: 100 })
        ;
    });
  </script>
</body>
</html>
```

## Constraints

1. **自包含**：单个 HTML 文件，不依赖外部 CSS/JS（GSAP CDN 除外）
2. **data 属性**：`.scene` 容器必须有 `data-start` 和 `data-duration`（秒）
3. **GSAP 动画**：用 GSAP timeline 实现动画，`DOMContentLoaded` 后执行
4. **分辨率**：场景尺寸匹配 meta.json 的 resolution（如 1920x1080）
5. **风格一致**：配色、字体、动效风格必须遵循 `storyboard_lock.md`
6. **素材路径**：图片用 `../assets/<filename>` 相对路径
7. **禁止**：React/Vue 框架、外部 CSS 文件、alert/confirm、localStorage
8. **动画时长**：所有动画必须在 `data-duration` 秒内完成

## Prompt Construction

System message:
```
你是视频场景 HTML 工程师。根据分镜描述和风格锁定，生成单个场景的 HTML+GSAP 动画。
只输出 HTML 内容，不要 markdown 代码块标记，不要任何解释说明。
```

User message:
```
## 场景信息
- 编号: {index}
- 标题: {title}
- 时长: {duration} 秒
- 画面描述: {visual}
- 动画说明: {animation}
- 旁白: {narration}
- 素材: {assets}

## 风格锁定
{storyboard_lock_content}

## 分辨率
{resolution}

请生成 scenes/scene_{index:02d}.html 的完整内容。
```
