# Video Storyboard Strategist(占位,Phase 3 完善)

## Storyboard Structure

每个 storyboard 包含:
- **Video Metadata**: 总时长、分辨率、帧率、背景音乐
- **Scene List**: 每个场景的详细描述
- **Visual Style**: 配色方案、字体、视觉风格
- **Narration**: 旁白文本

## Scene Schema

```
### Scene N: <title>
- Duration: <seconds>s
- Visual: <description>
- Animation: <GSAP timeline description>
- Narration: <text>
- Assets: <images/icons needed>
```

## Narration Rules

- 当 `<project_path>/meta.json` 中 `narrationEnabled: true` 时,**每个场景的 `Narration` 字段必填**;否则 Step 6.5 会因找不到 narration 文本而失败。
- 当 `narrationEnabled` 为 false 或不存在时,`Narration` 字段可省略。
- 旁白文本应与场景时长匹配(中文约 4 字/秒)。例:5 秒场景 ≈ 20 字以内。
- 旁白用于 TTS 合成,不要在文本中嵌入 Markdown 标记或时间戳;只写要朗读的纯文本。

## Timing Rules

- 单个场景建议 3-10 秒
- 总时长建议 30-120 秒(社交媒体)或 2-5 分钟(演示)
- 场景间过渡 0.5-1 秒
