# 原生设计参考资源

这些页面由 Mona 独立设计，JSON 是可修改的 Office 原生操作，不是必须填写的模板。

`$slideId` 替换为当前编辑器返回的真实 ID；坐标按真实画布同比例调整。图片引用必须先通过 skill_asset_copy 复制到当前工作区，再替换 assetPath。

product-workspace.png 来源于本仓库既有产品历史界面截图；不得当成当前产品版本的证据。所有示例数据仅作演示。

生成：node webui/office-editor/scripts/native-design-fixtures.mjs
渲染：node webui/office-editor/scripts/preset-visual.mjs --fixture mona/skills/mona-pptx/assets/native/validation.json --output output/ppt-office-redesign-20260923/native
