# Video Executor — HTML/GSAP Composition(占位,Phase 3 完善)

## Composition Structure

每个场景是一个 HTML 文件,包含:
- `<div class="scene" data-start="0" data-duration="5">` 声明式时序
- 内部 CSS 样式
- GSAP timeline 动画

## Hyperframes Conventions

- 使用 `data-start` / `data-duration` 声明场景时序
- GSAP timeline 在 `<script>` 标签内定义
- 所有资源使用相对路径 `../assets/`
- 画布尺寸默认 1920×1080(可配置)

## Quality Checklist

- [ ] HTML 无语法错误
- [ ] GSAP timeline 时序正确
- [ ] 所有资源路径有效
- [ ] 文字可读性(对比度、大小)
- [ ] 动画流畅(无跳帧)
