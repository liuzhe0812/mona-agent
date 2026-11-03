# 可选 Skill

`github` 和 `tmux` 不再进入 Mona 默认 Skill 目录；此处保留完整源码，按需安装。
`github` 需要本机 GitHub CLI 和登录；`tmux` 需要 macOS/Linux 与 tmux 命令。

现有 Skill 创建器的 `package_skill.py` 可以将任一目录打成 `.skill` ZIP。Mona 当前没有 ZIP 导入界面；需要使用时，将受信任归档中的同名目录解压到目标 Agent 的私有技能目录（优先使用宿主返回的实际路径；主 Mona 默认通常为 `~/.mona/agents/mona/skills/`），保留目录结构，再刷新技能列表。私有技能由现有加载器发现；目标已有同名技能时先确认现有内容，不覆盖已有技能。
