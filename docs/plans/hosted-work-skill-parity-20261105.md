# 网页与应用 Skill 接入差异

状态：排查及两项最小修正已完成本地验证，**未上线**；完整风格问答/样张预览仍未接入。

## 已核实

生产 v15 清单与当前应用三文件 SHA 一致：

| 文件 | SHA256 |
|---|---|
| mona-pptx/SKILL.md | 121b701a94345e61cf24ef113a499ead53087fd900b8a723037481064518deae |
| mona-design/SKILL.md | d36618f770d08a0bed9728cad8348944d558cf09d309089b3bd2c43944290c8d |
| mona-design/references/native-pptx.md | 2d63726a858a07a24ed07f320c543582ff4c680db5f4ad6bc4f29395739fe302 |

PPT 的正常技能入口是 mona-pptx，再按需引用 mona-design 的原生设计资料与样张；不一定单独出现 skill_read(mona-design)。普通改字/数字不重新走完整设计。未指定风格的新稿则应按 Skill 要求先提出适配方向、展示真实样张并等待用户选择后再制作。

当前不能读取用户刚才那一单的最新后台记录：172.31.3.176 SSH 超时。下述为已从代码确认的接入差异，不能替代对某一次真实调用的归因。

## 已做的最小修正

1. HostedSkills.summary 复用应用 skills_section.md，恢复 Office 编辑/分析前先加载对应 Skill 的明确规则，不再维护简化版指令。
2. 修正跨 Skill 的公开只读参考访问：加载 mona-pptx 后可以直接读取它引用的 mona-design/native-pptx.md。资源仍限定平台内置目录并做路径/链接校验；没有加载私人 Skill。素材复制和脚本执行仍须成功读取对应 Skill，不通过引用开放执行权限。
3. 目录如实标注结构化风格提问和用户可见样张预览尚未接入。

只改 Hosted 适配，没有改 Skill 文件、Runner 或 Office。Windows 必要测试 tests/hosted_work/test_skills.py 与 test_runner.py：17 passed、1 skipped；Ruff 通过，不代表 Linux 或生产模型流程验收。尚未发布生产，不能声称问题已在线修复。

## 尚缺的配套链路

- 前端已有 UserQuestionPanel 和 MonaClient.answerUserQuestion。Hosted 未注册 AskUserQuestionTool、未处理 answer_user_question/result，也不在 attach 时提供 user_questions 快照；只把工具名字加进去仍无法回答和恢复。
- 应用是在等待选择前发送 question_preview 图片，再展示提问面板。Hosted skill_reference_read 的 image_url 是模型输入，不等于用户已看到样张；现有 gVisor artifact 要到任务结束、保存校验后才交付，不能直接用作等待中的预览。
- 后续应复用 AskUserQuestionTool、UserQuestions 和既有面板，仅补 owner/会话/活动 run 的后端协调、回答、取消及重连。等待超时不得自动替用户选方向或重派任务。
- 安全预览必须校验账号、会话、大小和 SHA，复用受控文件票据；短期票据不持久化，刷新时重新签发。不能为预览调用会 quiesce/停止沙箱内进程的 sandbox.save，也不能将预览伪称最终交付。
- 是否实际视觉读取要通过真实模型验证，不能只依据读取工具成功。该流程尚未完成，不为满足设计而加载私人配置或另造一套 harness。

恢复 Ubuntu 管理连接后才能发布已完成的后端修正；VPS 菜单静态发布不影响上述后端状态。
