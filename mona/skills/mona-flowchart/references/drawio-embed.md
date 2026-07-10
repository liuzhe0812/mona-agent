# draw.io Embed Guide(占位,Phase 4 完善)

## Embedding draw.io in WebView2

draw.io (diagrams.net) 提供嵌入模式:
- URL: `https://viewer.diagrams.net/?embed=1&proto=json&spin=1`
- 或本地部署的 draw.io

## Integration Protocol

1. WebView2 加载 draw.io embed URL
2. 通过 postMessage 协议加载 `diagram.drawio` 内容
3. 用户编辑后,draw.io 通过 postMessage 返回更新后的 XML
4. 保存更新到 `diagram.drawio`

## C Route: Agent + User Edit

- agent 生成初稿 → `diagram.drawio`
- 用户在 embed 编辑器中修改
- 保存修改回 `diagram.drawio`
- agent 可读取修改后的 XML 做后续调整
