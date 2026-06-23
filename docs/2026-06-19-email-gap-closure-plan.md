# 邮箱功能差距补齐计划

> 对标 Foxmail / Outlook / Thunderbird，补齐中高优先级差距。
> 创建日期：2026-06-19
> 状态标记：`[ ]` 待办 / `[x]` 已完成 / `[~]` 部分完成 / `[-]` 本迭代不做

## 一、差距清单与执行计划

### 批次 1：安全与 Bug 修复（P0）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 1.1 | HTML 邮件 sanitize（iframe sandbox） | 高 | [x] | 用 sandbox iframe 渲染，脚本完全隔离 |
| 1.2 | MailAgentPanel 端口修复 | 高 | [x] | getApiBase → getGatewayHttpBase |
| 1.3 | replyAll Cc 处理 bug | 高 | [x] | 原 Cc 放到新 Cc，原 To+from 放新 To |
| 1.4 | inReplyTo 用 Message-ID | 中 | [x] | EmailMessage 加 messageId，Python 提取，Rust 存储 |

### 批次 2：IMAP 标志回写（P0）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 2.1 | markRead 回写 IMAP `\Seen` | 高 | [x] | 新增 /email/set_flag，Rust 调用回写 |
| 2.2 | 星标接通 toggleStarred + IMAP `\Flagged` | 高 | [x] | 新增 email_toggle_starred 命令 |

### 批次 3：附件功能（P0）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 3.1 | 附件列表显示 | 高 | [x] | 详情页显示附件名/大小/类型，EmailAttachment 字段贯通 |
| 3.2 | 附件下载 | 高 | [x] | IMAP FETCH BODY.PEEK[] + base64 + 保存对话框 |

### 批次 4：删除安全化（P0）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 4.1 | 删除改为 MOVE 到回收站 | 高 | [x] | 优先 MOVE 到 Trash/Deleted Messages/已删除，失败才 expunge |

### 批次 5：未读数显示（P1）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 5.1 | 文件夹未读数显示 | 高 | [x] | IMAP STATUS UNSEEN + 前端 badge |
| 5.2 | 账号未读总数 | 中 | [x] | syncMail 时累加各文件夹未读数 |

### 批次 6：自动收取与通知（P1）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 6.1 | 定时自动收取 | 高 | [x] | 5 分钟 polling，syncing 状态防重入 |
| 6.2 | 新邮件桌面通知 | 中 | [x] | Notification API + requestPermission |

### 批次 7：搜索（P1）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 7.1 | 列表内搜索框 | 高 | [x] | MailListView 顶部搜索输入框 |
| 7.2 | 本地全文搜索 | 高 | [x] | subject/from/bodyText 即时过滤 |

### 批次 8：草稿（P1）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 8.1 | 草稿保存 | 高 | [x] | IMAP APPEND 到 Drafts，含 \Draft 标志；自动查找草稿文件夹 |

### 批次 9：账号管理（P1）

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 9.1 | 账号编辑 | 高 | [x] | NewAccountDialog 支持编辑模式，密码留空则不修改 |
| 9.2 | 连接测试 | 高 | [x] | /email/test_connection 测试 IMAP 登录，返回文件夹数 |

### 批次 10：中优先级补齐

| # | 任务 | 优先级 | 状态 | 说明 |
|---|------|--------|------|------|
| 10.1 | 邮件列表排序切换 | 中 | [x] | 按日期/发件人/主题/大小/星标，DropdownMenu 切换 |
| 10.2 | 邮件列表筛选 | 中 | [x] | 全部/未读/星标/附件 四种筛选 |
| 10.3 | 列表项星标图标 | 中 | [x] | 列表项显示星标+附件图标 |
| 10.4 | 邮件头完整信息 | 中 | [x] | Cc 已显示；Message-ID 为技术字段不展示 |
| 10.5 | 回复引用格式 | 中 | [x] | RFC 3676 风格 `> ` 前缀引用 |
| 10.6 | 密送 Bcc | 中 | [x] | SendRequest 加 bcc，SMTP 收件人含 Bcc |
| 10.7 | 邮箱格式校验 | 中 | [x] | 收件人/抄送/密送发送前校验 |
| 10.8 | 移动到文件夹 | 中 | [x] | 复用批次4的 moveMessage 命令 |
| 10.9 | 批量操作 | 中 | [x] | 多选+批量标记已读/删除 |

### 本迭代不做（复杂度高，后续迭代）

| 任务 | 原因 |
|------|------|
| IMAP IDLE 实时推送 | 需要长连接管理，架构改动大 |
| OAuth2 | 需要 OAuth 流程，复杂度高 |
| 富文本编辑 | 需要 editor 集成 |
| 会话线程视图 | 需要 References 头解析与分组 |
| 全量重同步 | 需要冲突处理策略 |
| 拖拽移动邮件 | 需要 dnd 库集成 |
| 自定义文件夹管理 | 需要 IMAP CREATE/RENAME/DELETE |
| 联系人自动收集 | 需要联系人模块 |
| 邮件规则/过滤器 | 需要规则引擎 |

## 二、完成记录

（执行过程中在此记录每批次完成情况）

### 2026-06-19 全部批次完成

**批次 1-2（P0 安全与标志回写）**：iframe sandbox 隔离 HTML、端口修复、replyAll Cc 修复、inReplyTo 用 Message-ID、markRead/toggleStarred 回写 IMAP。

**批次 3-4（P0 附件与删除）**：附件列表显示+下载（IMAP FETCH BODY.PEEK[] + base64 + 保存对话框）、删除优先 MOVE 到回收站。

**批次 5-7（P1 未读数/通知/搜索）**：IMAP STATUS UNSEEN + 前端 badge、5 分钟定时 polling + Notification API、本地搜索过滤。

**批次 8（P1 草稿）**：IMAP APPEND 到 Drafts 文件夹，含 `\Draft` 标志，自动查找草稿文件夹。

**批次 9（P1 账号管理）**：NewAccountDialog 支持编辑模式（密码留空则不修改）、`/email/test_connection` 测试 IMAP 登录。

**批次 10（中优先级补齐）**：排序切换（日期/发件人/主题/大小/星标）、筛选（全部/未读/星标/附件）、RFC 3676 引用格式、Bcc 密送、邮箱格式校验、批量操作（多选+批量已读/删除）。

**批次 11（最终验证）**：
- Rust `cargo check`：编译成功（仅预存警告）
- Python `ruff check`：仅预存的 `subprocess` 未使用导入
- TypeScript `tsc --noEmit`：邮箱模块无错误（预存测试文件错误无关）

### 新增的 gateway 路由

| 路由 | 方法 | 用途 |
|------|------|------|
| `/email/set_flag` | POST | 设置/清除 IMAP 标志（\Seen/\Flagged） |
| `/email/move` | POST | 移动邮件到目标文件夹 |
| `/email/fetch_attachment` | POST | 下载附件（base64 返回） |
| `/email/save_draft` | POST | 保存草稿到 Drafts |
| `/email/test_connection` | POST | 测试 IMAP 登录连接 |

### 新增的 Tauri 命令

| 命令 | 用途 |
|------|------|
| `email_toggle_starred` | 切换星标并回写 IMAP \Flagged |
| `email_move_message` | 移动邮件 |
| `email_fetch_attachment` | 下载附件 |
| `email_save_draft` | 保存草稿 |
| `email_test_connection` | 测试连接 |

### SQLite 迁移

- `messages` 表新增 `cc_addresses`、`message_id`、`attachments_json` 列
- 主键升级为 `(uid, account_id, folder)`
- UPSERT 保留用户本地 `is_read` 状态

