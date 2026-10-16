# 按内容选择创作资料

知识讲解和产品展示同等重要，由内容决定采用何种表达，也可以在一条视频里组合。
先把意思写成具体对象与变化，再选择风格和实现。内置资源是可复用知识与代码，
不是固定场景菜单。

| 内容需要 | 优先资料 |
| --- | --- |
| 中文概念、机制、步骤、因果 | Dashi 的扁平流程图、手绘笔记、立体卡通风格卡与源码 |
| 专题、观点、认知与证据 | Dashi 的复古报刊、超现实拼贴、复古剪纸 |
| 科技展示、产品功能 | Dashi 黑底科技，以及 Huashu 的 keynote_ui、Vox；真实界面和操作素材作为主体 |
| 数据比较、权重、推导 | Huashu finance_chart、3b1b，连续显示数据与结论的关系 |
| 角色与连续故事 | Huashu storytime 和角色库；Dashi 卡通、剪纸画法可组合使用 |
| 新风格或参考图 | Dashi 风格词典和风格卡模板，再按这次内容适配，保留已确认的风格选择 |

## Dashi 原始资料与代码

原稿直接复制自 dashi-animationstyle aa620f3b859aa5d191b783b2eb0fb59263731c76，
没有按截图重写。风格卡可用 skill_reference_read 读取
`dashi/styles/<风格名>/风格卡.md`；知识在 `dashi/knowledge/`，包括
`风格词典.md`、`讲解动画通用规则.md`、`动效和画面变化.md`。实际文件名以目录为准。

实现已确认的画面时，用 skill_asset_copy 从 mona-video 的
`dashi-animationstyle/styles/<风格名>/模板.html` 或 `示例_Token.html` 复制到
本项目 drafts/reference/，然后读取并复用其中的绘图底座、角色、材质和运动函数。
改稿从原代码开始，只适配本片内容、画幅、字体、颜色与帧时间；不要照风格说明
重新发明同一套效果。模板中的 Token 故事、关键词和坐标是样片，须替换为本片。

上游 SKILL 和 pipeline 是来源资料。Mona 使用自身导演确认、TTS、字幕、运行时
和 Remotion，不执行原稿的 Mac 安装或第二套生产命令。原稿里的变化频率、
转场数量、常驻背景效果是样片经验，不作为所有视频的硬门槛。

`mona-video` 导出 `Dashi` 公共动效对象，MotionCanvas 的 kit.DASHI 是同一能力。
其绘制参数和秒级时间沿用原代码，时间由 frame/fps 和真实 cue 提供。
细节见 runtime.md，原函数源码可复制 `dashi-animationstyle/pipeline/动效部件.js`。
静帧与动图用于风格参考，作者示例声音已排除。
