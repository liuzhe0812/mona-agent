# Mona 小程序原型 v2：生成说明

- 日期：2026-09-07。
- 生成方式：内置 ImageGen，使用参考图生成新版本。
- 头像：用户本轮提供的人像，原始参考副本为 `mona-avatar-reference.png`。
- 风格：Mona 现有桌面界面与 UI 规范；暖灰外壳、米白内容面、炭黑按钮。
- 输出：`miniapp-overview-v2.png`。四个页面分别为笔记、日程与待办、云端对话、电脑任务。
- 本图是设计示例，消息、日程、任务与连接状态为示例数据；不表示功能已经上线或 P2P 已验证。
- 本轮检查：人像替换、笔记列表层级、日程创建、会话历史与新建入口、空闲输入区、任务等待确认状态及修改/保存/取消动作。
- v1 保留在 `../mona-miniapp-v1/miniapp-overview-v1.png`，本轮未覆盖。

## 最终生成提示词

```text
Use case: ui-mockup
Create a NEW, carefully designed high-fidelity WeChat mini program UI prototype board for Mona. This is a substantive redesign of the previous concept, with usable mobile task flows and refined typography. Deliver an actual raster image, a wide high-resolution landscape board with FOUR equal, large, sharp portrait app screens side by side, approximately 390:844 viewport proportions. Screens should occupy most of the board with modest gutters and minimal outer margins. Flat front view, subtle device boundary only, no 3D phone hardware, no perspective.

REFERENCE IMAGE 1 IS THE USER'S REQUIRED MONA AVATAR. Reuse the exact illustrated woman identity, black hair, red and cyan rim-light accents, black outfit and warm ivory square background. Show this woman in small rounded-square Mona brand/avatar positions, especially next to the assistant answer. Do NOT use a cat avatar. Do NOT make the woman a full-screen illustration. Reference image 2 shows the existing Mona desktop visual language only: warm neutral surfaces, charcoal controls, fine separators. Do not copy its desktop layout.

VISUAL SYSTEM:
Board background #EEEEE9, app body #FFFEFA, page headers subtly #F2F2ED, pure white editing surfaces, main ink #1A1A1A, secondary text #6B6B67, hairline #E4E4DF, primary buttons #3C3F43 with white labels. Tiny red #E53935 navigation signature only, green small success/connected checkmarks, amber small waiting-for-confirmation status. Cyan reserved for genuinely running AI, not generic connectivity. No blue primary buttons. No gradients, glow, radar rings, glass, heavy shadows, bright decorative illustrations, or piles of outlined cards.
Typography: modern system Chinese sans-serif, confident 22px-equivalent page headings, clear 16px-equivalent body, readable metadata. Crisp simplified Chinese. Lists organized by space, baseline alignment, thin separators, and selective soft-gray backgrounds. Compact but comfortable touch controls. 8-12px control corners, generous mobile safe areas. Consistent 4-item bottom bar on all screens with monochrome icons and labels "笔记", "日程", "对话", "电脑". The active item alone has darker icon/text and a tiny red underline. Each screen has subtle 9:41 status bar and authentic top-right WeChat ellipsis/circle capsule, never overlapping the product toolbar.

Board heading small and restrained: "Mona 小程序 · 界面方案 02". Small captions below screens: "笔记", "日程与待办", "云端对话", "电脑任务".

SCREEN 1 — NOTES, polished native-feeling library:
Header "笔记" with small supplied Mona woman avatar as brand mark.
Under header, a slim collection row: folder icon "工作笔记" chevron, small "24 篇"; right-aligned tiny green check and "已同步". No red dot beside sync.
Full-width quiet search "搜索笔记内容".
Text filters "全部" "收藏" "最近", subtly selected "全部".
Group "置顶" then one elegant flat row:
Title "小程序三端方案"; preview "笔记与日程同步，手机连接电脑处理任务"; metadata "产品设计 · 09:20"; small pin.
Group "最近" then three uniform rows separated by hairlines:
"客户拜访记录" / "交付周期、实施安排与后续跟进" / "客户沟通 · 昨天"
"本周工作复盘" / "项目进展、问题与下一步安排" / "工作记录 · 9月5日"
"会议记录" / "已确认的事项与待办清单" / "工作记录 · 9月4日"
Each row has the same title-preview-metadata hierarchy, not arbitrary card heights. No big enclosing card borders.
Above bottom navigation, a restrained charcoal rounded-rectangle primary action with plus icon "新建笔记", and a separate outlined microphone action of matching height for voice capture.

SCREEN 2 — SCHEDULE, use an AGENDA LIST, not a misleading time-proportional axis:
Header "日程". Date row "9月7日  周一", small "今天" control.
A seven-day Monday-first strip "一 二 三 四 五 六 日", numbers "7 8 9 10 11 12 13"; 7 selected in a small charcoal circle.
A section heading "今日日程" with right aligned plus "新增".
Two calm agenda rows with aligned time column and thin separators:
"10:00" with "11:00" below; "产品方案评审", secondary "会议室 A".
"14:30" with "15:00" below; "联系王经理", secondary "确认实施安排".
This is a list with no continuous ruler, no invented proportional timeline.
Section heading "今日待办 · 3" with right aligned "+ 添加".
Three unchecked rows: "确认小程序原型"; "整理会议记录"; "补充客户资料".
Near bottom a small quiet note "与桌面同步", and a charcoal primary button "+ 新增日程".
No missing creation affordance.

SCREEN 3 — CLOUD CHAT, useful content and complete input controls:
Native page header "云端对话".
Product toolbar beneath native header: left history/list icon with label "历史"; center conversation title "今天的工作安排"; right compose/new-chat icon.
Small removable context attachment pill: "已添加：今日日程与待办". This clearly denotes the user supplied the context, not autonomous private-data access.
Right aligned light gray user bubble: "帮我安排今天的工作重点".
Assistant starts with the EXACT supplied woman avatar, small, and label "Mona".
Answer is clean editorial text on the page, no boxed bubble, with:
"先处理这三件事："
"1. 10:00 参加产品方案评审"
"2. 午前确认原型，整理会议记录"
"3. 14:30 联系王经理，补充客户资料"
Small secondary line "根据你添加的日程和待办整理".
Below answer, two small outlined explicit action chips "保存为笔记" and "创建日程"; subtle copy/regenerate outline icons underneath if space.
Composer fixed above bottom navigation: attachment plus icon, a clearly empty text field "继续聊聊…", microphone icon, and distinct charcoal upward send-arrow button. NO waveform in an idle text field. NO account balance dominating header. Account/balance may be accessible through menu, not drawn prominently.

SCREEN 4 — REMOTE MONA TASK, focus on actionable confirmation:
Header "电脑任务".
Toolbar "任务列表" with back/list icon on left, "+ 新任务" ghost action on right.
Slim device strip: monitor icon, "办公电脑" chevron, small green dot "已连接 · 直连". Direct P2P state is communicated quietly, not a radar or hero card.
Task title "整理项目资料".
Prominent current status in small amber text: "等待你确认".
Two already-completed compact steps with small checkmarks:
"已读取项目资料"
"已生成摘要"
One restrained light-gray confirmation surface, the only substantial card:
Title "保存摘要"
Destination "目标笔记：小程序三端方案"
Preview label "内容预览"
Preview text "同步笔记、日程和待办，支持手机连接电脑处理任务。"
Actions: outline "返回修改"; charcoal "保存到笔记".
Below, modest ghost text action "取消任务".
Fixed bottom secondary composer above nav: "补充要求…" with send icon, allows additional direction. No fake percentage progress. No simultaneous "正在处理" state. Do not show an inactive future 'waiting for confirmation' while confirmation is already active. The whole screen must unambiguously be awaiting this user's approval, and connect state must not compete with the primary action.

QUALITY REQUIREMENTS:
This should feel like a finished, thoughtful mobile productivity product. All four screens share spacing, typography, icons, nav heights and surface tones. Different modules have appropriate layouts instead of identical stacks of cards. Avoid gigantic blank voids, while preserving breathing room. Render readable Chinese exactly as specified, no gibberish. Use the supplied woman avatar wherever Mona's identity appears; no cat, no generic circular user photo, no additional character. No source code, no VPS/ASR/server/port words on product screens. "直连" is the user-visible P2P status. Do not use English except the brand Mona.
```

