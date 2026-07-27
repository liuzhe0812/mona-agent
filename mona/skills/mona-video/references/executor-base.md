# Video Executor Base — 通用执行标准

## Scene File Naming

- `scenes/scene_01.html`, `scenes/scene_02.html`, ...
- 编号零填充两位,保证排序正确

## HTML Structure

每个场景 HTML 文件必须包含:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Scene N: <title></title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
</head>
<body>
  <div class="scene" data-start="<seconds>" data-duration="<seconds>">
    <!-- 场景内容 -->
  </div>
  <script>
    // GSAP timeline 动画
  </script>
</body>
</html>
```

## Asset Paths

- 图片: `../assets/<filename>`
- 字体: 使用系统字体或 web font
- 脚本: CDN 引用 GSAP,不下载到本地

## Forbidden

- 禁止使用 React/Vue 等框架
- 禁止使用外部 CSS 文件(内联在 `<style>` 标签)
- 禁止使用 `alert()` / `confirm()`
- 禁止访问 localStorage / sessionStorage(渲染环境无持久化)
