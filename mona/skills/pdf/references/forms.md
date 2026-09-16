# PDF 表单填写

1. 使用 `pdf(action="forms", path="input.pdf")` 读取字段列表。使用返回的字段名称、类型和可选值，不凭页面标签猜字段名。
2. 存在交互字段时，用 `fill` 写入新文件：

```json
{"action":"fill","path":"input.pdf","output":"filled.pdf","values":{"name":"张三"}}
```

3. 如果没有交互字段，先用 `render` 查看目标页，确定填写区域。用 `annotate` 填写普通文字：

```json
{"action":"annotate","path":"input.pdf","output":"filled.pdf","annotations":[{"page":1,"rect":[80,120,250,150],"text":"张三"}]}
```

`rect` 是 PDF 点坐标 `[左,上,右,下]`，不是截图像素坐标。根据工具返回的页面尺寸换算；不要直接套用截图坐标。遇到旋转页先核对坐标方向。该操作添加可见文字，不创建交互字段，也不清除原有内容。

4. 重新读取输出字段值，并渲染填写页确认文字、勾选状态、换行和位置。字段值已写入不等于查看器中显示正确。失败时根据具体错误调整后重试，不能报告填写成功。
