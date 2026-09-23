# 完成后的原位续编

“品牌色是橙色”“标题改一下”“字体大一点”是修改当前文稿，不是制作另一份。保持会话、页序、对象 ID、布局和用户已修改的内容。先读取当前版本，不用历史生成数据覆盖现在的文档。

## 品牌改色

用 `office` 的 `action:"inspect",query:{mode:"palette"}` 查看当前显式 RGB 颜色、出现位置和文字示例。需要确认颜色语义时看当前 visual；不要把所有绿色都当品牌色，正负值、警告及特殊标记单独保留。

`slide_replace_colors` 是现有 Office apply 中的原位操作：

```json
{"action":"apply","session_id":"<原会话ID>","expected_version":{"editorEpoch":"<当前epoch>","modelRevision":0},"operations":[{"op":"slide_replace_colors","payload":{"replacements":[{"from":"#25856B","to":"#E56B20"}],"slideIds":["<实际页面ID>"]}}]}
```

上例颜色仅演示字段。先确认真实旧色；用户未给精确橙色时可选择适合背景的橙色，不改事实、布局或图片。可省略 slideIds 修改整稿（最多50页，更多按页分批）。elementIds 是当前顶层对象 ID；组 ID 覆盖组内非图片对象。excludeElementIds 保护特定对象，fields 可限定 text/fill/stroke/chart。映射同时执行，不连锁替换；from/to 相同或无匹配时不改变 revision。

文字、数字、图表数据、透明度、渐变位置、路径和对象 ID 保持不变。colorChanges 给出实际匹配次数；没有匹配不是改色完成。此操作不改图片像素、主题/母版继承色或未展开 SmartArt；palette.note 和 inheritedReferences 提示边界。不要用重新制作绕过不支持的情况，可用已有精确对象样式工具，或如实说明剩余未修改部分。

整页组件只负责生成初始对象。修改后已有文稿是唯一权威；不通过删除页面后重新 slide_add_design 来改色。

## 出错与交付

能力名称不确定先看 capabilities 短目录，再按实际 operations 查询参数；未知名称会单独返回，不能据此推断整个编辑能力不存在。长结果文件单行过长时按 char_offset/char_limit 读取并遵守返回 SHA 和下一偏移，不反复增加行数。

版本冲突重新读取原页；断线用 open(session_id) 恢复。close 仅用于用户要求关闭，不是失败恢复。修改后检查颜色对比和语义，按 review 检查受影响页并正常保存/导出。用户确实要另一份新文稿才用 open(document_type="slides",new_document=true)，不用同名新稿代替原稿。
