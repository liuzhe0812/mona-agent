# 邮件本地优先存储方案（SQLite 作为可重建缓存）

## 核心原则

**.eml 文件是真相源，SQLite 是可重建的缓存。**

1. 所有本地操作（发送/MOVE/DELETE/标记已读）同时更新 .eml 文件和 SQLite 缓存
2. SQLite 索引可以从 .eml 文件 100% 重建
3. 启动时校验一致性，不一致就自动重建
4. 远程同步是补充，不是本地可见性的前提
5. 任何情况下，.eml 文件在，邮件就在

## 架构

```
<app_data>/mona/
├── mail/
│   └── <account_id>/
│       ├── INBOX/
│       │   ├── <uid>.eml              # RFC822 原始字节
│       │   ├── <uid>.eml.meta.json    # 头字段缓存 + 状态
│       │   └── .folder.json           # 文件夹元数据（uid_validity, last_synced_uid）
│       ├── Sent Messages/
│       │   ├── <uid>.eml
│       │   ├── <uid>.eml.meta.json
│       │   └── .folder.json
│       └── 北森/
│           ├── <uid>.eml
│           ├── <uid>.eml.meta.json
│           └── .folder.json
└── email.sqlite3                       # 可重建的缓存（索引 + FTS5）
```

### .eml 文件

完整 RFC822 原始字节，文件名 = `<uid>.eml`。
- IMAP 同步拉取的邮件：uid = IMAP UID（纯数字）
- 本地发送的邮件：uid = `L<timestamp_ms>`（L 前缀标记本地生成）

### .eml.meta.json（sidecar 状态文件）

每个 .eml 对应一个 .meta.json，存储无法从 RFC822 解析的状态：

```json
{
  "uid": "12345",
  "accountId": "37bd0f8c-...",
  "folder": "INBOX",
  "isRead": true,
  "isStarred": false,
  "hasAttachments": true,
  "bodyFetched": true,
  "messageId": "<abc@mail.example.com>",
  "emlMtime": 1735843200
}
```

**为什么需要 .meta.json**：RFC822 不含已读/星标状态，IMAP FLAGS 需要单独存储。Foxmail 存在 `Index` 二进制文件里，我们用 sidecar JSON。

### .folder.json

文件夹级元数据：

```json
{
  "uidValidity": "1234567890",
  "lastSyncedUid": "474",
  "lastSyncTime": 1735843200
}
```

## 数据流

### 1. 启动时：一致性校验

```
启动时：
1. 扫描 mail/<account_id>/<folder>/ 目录
2. 对每个文件夹：
   a. 列出所有 .eml 文件，得到文件 uid 集合 A
   b. 查 SQLite messages 表，得到索引 uid 集合 B
   c. 如果 A != B：
      - A 有 B 无：.eml 存在但索引缺失 → 解析 .eml header + .meta.json，重建索引
      - B 有 A 无：索引存在但 .eml 丢失 → DELETE 索引记录
3. 如果重建记录数 > 50（异常情况），全量重建该文件夹索引
4. 校验结果记日志，不阻塞 UI
```

**触发时机**：Mona 启动时（`email_init` 命令内），后台异步执行。

### 2. 接收邮件（IMAP 同步）

```
sync_folder_internal：
1. 调 gateway /email/sync 拉取新邮件 UID + HEADER
2. 对每个新邮件：
   a. 落盘 .eml（HEADER only，bodyFetched=false）
   b. 写 .meta.json（isRead/isStarred 从 FLAGS 解析）
   c. UPSERT SQLite 索引（uid/account_id/folder/subject/from/date/eml_path）
3. 用户点击邮件时：
   a. email_fetch_body 拉取完整 RFC822
   b. 覆盖落盘 .eml（现在是完整 RFC822）
   c. 更新 .meta.json（bodyFetched=true）
   d. UPDATE SQLite（body_fetched=1）
```

### 3. 发送邮件

```
email_send：
1. gateway /email/send 同步执行 SMTP + IMAP APPEND，返回 rawBytes + messageId
2. Rust 收到响应：
   a. base64 解码 rawBytes
   b. 生成 uid = "L" + timestamp_ms
   c. 落盘 .eml 到 mail/<account_id>/Sent Messages/<uid>.eml
   d. 解析 header（subject/from/to/date/message_id/has_attachments）
   e. 写 .meta.json（isRead=true, bodyFetched=true, messageId=...）
   f. INSERT SQLite 索引
3. 返回成功
4. UI 发送成功后，用户切到"已发送"立即看到这封邮件

IMAP APPEND 失败不影响本地可见性：SMTP 成功即落盘 + 写索引。
```

### 4. MOVE 邮件

```
email_batch_action（move 分支）：
1. 调 gateway /email/move（IMAP MOVE）
2. 成功后本地操作：
   a. 移动 .eml 文件：old_folder/<uid>.eml → new_folder/<uid>.eml
   b. 移动 .meta.json 文件
   c. 更新 .meta.json 的 folder 字段
   d. UPDATE SQLite：folder = new_folder, eml_path = new_path
3. UI 立即反映（目标文件夹可见，源文件夹消失）

如果 IMAP MOVE 返回新 uid（某些服务器会），则：
   a. 重命名 .eml 文件：old_uid.eml → new_uid.eml
   b. 更新 .meta.json 的 uid 字段
   c. DELETE 旧索引 + INSERT 新索引
```

### 5. DELETE 邮件

```
email_delete_message：
1. 调 gateway /email/delete（IMAP STORE \Deleted + EXPUNGE）
2. 成功后本地操作：
   a. 删除 .eml 文件
   b. 删除 .meta.json 文件
   c. DELETE SQLite 索引
3. UI 立即反映
```

### 6. 标记已读/星标

```
toggleRead / toggleStarred：
1. 调 gateway 更新 IMAP FLAGS
2. 成功后本地操作：
   a. 更新 .meta.json（isRead/isStarred）
   b. UPDATE SQLite（is_read/is_starred）
3. UI 立即反映
```

### 7. uid 去重（同步时）

```
sync_folder_internal UPSERT 前：
1. 检查同文件夹内是否有 "L" 开头的本地记录
2. 按 message_id 匹配：
   - 有 "L" 记录且 message_id 相同 → DELETE "L" 记录 + 删除 "L" .eml + INSERT IMAP 版本
   - 无 → 正常 INSERT
3. 避免本地版本与 IMAP 版本重复
```

## 列表加载（不变）

```
loadMessages → email_get_messages → SELECT * FROM messages
WHERE account_id=? AND folder=? ORDER BY date DESC LIMIT 50
```

依然秒开（SQLite 本地查询 <10ms）。SQLite 是缓存，所以始终有数据。

## 一致性保证

### 三重保证

1. **写入原子性**：每个操作同时更新 .eml + .meta.json + SQLite，任一步失败回滚
2. **启动校验**：每次启动扫描 .eml 目录与 SQLite 对比，不一致就重建
3. **手动重建命令**：`email_rebuild_index` 命令，全量扫描 .eml 重建 SQLite

### 不一致场景与处理

| 场景 | 处理 |
|---|---|
| .eml 存在，SQLite 缺失 | 启动校验时解析 .eml + .meta.json 重建索引 |
| .eml 丢失，SQLite 有记录 | 启动校验时删除孤儿索引记录 |
| .meta.json 丢失 | 从 .eml header 重新解析状态（已读/星标丢失，需重新同步 FLAGS） |
| SQLite 文件损坏 | 删除 email.sqlite3，全量扫描所有 .eml 重建 |
| .eml 文件名与 uid 不符 | 启动校验时报错，需手动处理 |

### 写入顺序

所有本地操作遵循**先文件后索引**原则：
1. 先写 .eml 文件（真相源）
2. 再写 .meta.json（状态）
3. 最后 UPDATE SQLite（缓存）

如果中途崩溃：
- .eml 写了，.meta.json 没写 → 启动校验时从 .eml 重建 .meta.json
- .eml + .meta.json 写了，SQLite 没写 → 启动校验时重建 SQLite 索引
- SQLite 写了，.eml 没写 → 不会发生（先文件后索引）

## 实施清单

### Rust 侧（email.rs）

#### 新增函数

- [ ] `write_eml_file`（已存在，确认）：落盘 .eml
- [ ] `write_meta_json(account_id, folder, uid, meta)`：写 sidecar 状态
- [ ] `read_meta_json(account_id, folder, uid) -> Meta`：读 sidecar 状态
- [ ] `move_eml_file(account_id, uid, old_folder, new_folder)`：移动 .eml + .meta.json
- [ ] `delete_eml_file(account_id, folder, uid)`：删除 .eml + .meta.json
- [ ] `parse_eml_header(eml_bytes) -> HeaderInfo`：解析 RFC822 header
- [ ] `rebuild_folder_index(state, account_id, folder)`：扫描 .eml 重建该文件夹 SQLite 索引
- [ ] `rebuild_all_indexes(state)`：全量重建所有文件夹索引
- [ ] `verify_consistency_on_startup(state)`：启动时一致性校验

#### 修改函数

- [ ] `email_init`：启动时调用 `verify_consistency_on_startup`（后台异步）
- [ ] `email_send`：解析 gateway 返回的 rawBytes，落盘 .eml + 写 .meta.json + 写 SQLite
- [ ] `sync_folder_internal`：落盘 .eml + 写 .meta.json + UPSERT SQLite；UPSERT 前按 message_id 去重
- [ ] `email_fetch_body`：拉取完整 RFC822 后覆盖落盘 .eml + 更新 .meta.json
- [ ] `update_local_cache` move 分支：移动 .eml + .meta.json + UPDATE SQLite
- [ ] `email_delete_message`：删除 .eml + .meta.json + DELETE SQLite
- [ ] `toggleRead`/`toggleStarred`：更新 .meta.json + UPDATE SQLite
- [ ] `email_get_messages`：无改动（依然读 SQLite）

#### 新增 Tauri 命令

- [ ] `email_rebuild_index`：手动触发全量重建（给用户的兜底工具）

### Python 侧（server.py）

- [ ] `handle_email_send`：同步 SMTP + APPEND，返回 rawBytes + messageId（已实现）
- [ ] 其他无改动

### 前端（基本无改动）

- [ ] `loadMessages`：读 SQLite，无改动
- [ ] `syncMail`：触发远程同步，无改动
- [ ] 可选：设置页加"重建邮件索引"按钮，调 `email_rebuild_index`

## 预期效果

1. **发送邮件后**：立即可见（.eml + .meta.json + SQLite 同步写入）
2. **切换文件夹再切回**：列表稳定（SQLite 始终有数据）
3. **MOVE 邮件后**：目标文件夹立即可见（.eml 移动 + SQLite UPDATE）
4. **DELETE 邮件后**：立即消失（.eml 删除 + SQLite DELETE）
5. **SQLite 损坏**：启动时自动重建（从 .eml + .meta.json）
6. **远程同步失败**：不影响本地可见性
7. **全文搜索**：保留 FTS5，性能不倒退

## 边界与风险

### 已知边界

- **.meta.json 丢失**：已读/星标状态会丢失（需重新同步 FLAGS），但邮件本身可见
- **大邮箱启动校验**：几千封邮件的扫描可能耗时 1-2 秒，后台异步不阻塞 UI
- **并发写入**：同一文件夹的 .eml 写入需加锁（SQLite 已有锁，.eml 写入用 `tokio::sync::Mutex`）

### 不支持的场景

- **多进程同时操作**：Mona 同时开两个实例会冲突（Foxmail 也不支持）
- **手动修改 .eml 文件**：启动校验时会按新内容重建索引，状态以 .meta.json 为准

## 与 Foxmail 的对齐

| 维度 | Foxmail | 本方案 |
|---|---|---|
| 邮件正文存储 | `Mails/<n>/<n>/<n>` 加密二进制 | `<folder>/<uid>.eml` 明文 RFC822 |
| 索引存储 | `Index` 自定义二进制 | SQLite（可重建缓存） |
| 状态存储 | `Index` 二进制 | `.eml.meta.json` sidecar |
| 落盘即可见 | ✅ | ✅ |
| 不依赖远程同步 | ✅ | ✅ |
| 索引可重建 | ✅（从 Mails 重建） | ✅（从 .eml 重建） |

本方案比 Foxmail 更开放（明文 .eml），达到相同的"本地优先"体验，且保留 SQLite 的查询性能优势。
