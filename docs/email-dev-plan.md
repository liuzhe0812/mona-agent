# Mona 邮箱功能产品级开发计划

> 目标：从可用 MVP 升级到产品级邮箱客户端，对标 foxmail/Outlook 基础体验。
> 原则：渐进式改造，每一步可编译可验证，避免大爆炸式重构。

## 现状基线

**已具备**：
- IMAP 持久连接池 + IDLE 实时推送
- SQLite 缓存 + FTS5 全文搜索
- AES-256-GCM 密码加密
- 虚拟列表渲染 + 增量 prepend
- 收件规则（3 条件 / 4 动作）
- CardDAV / Exchange 联系人同步
- 删除账号清理 IDLE + 连接池
- 中文认证错误识别

**核心短板**：
1. 无后台定时同步、不同步 FLAGS、仅 INBOX 同步
2. 正文按需拉取、附件无缓存 → 离线不可用
3. 单连接模型易触发风控（每账号 2 条连接）
4. 规则系统单薄，IDLE 推送的邮件不应用规则
5. 测试覆盖 < 5%

---

## P0 — 同步完整性（必做，基础体验）

### P0-1 后台静默同步引擎
- [ ] 新增 `mona/email/sync_engine.py`：定时同步调度器
- [ ] 启动时全账号全文件夹增量同步
- [ ] 5 分钟定时器：拉取所有订阅文件夹增量
- [ ] IDLE 断开时自动回退到 30s 轮询
- [ ] gateway 启动时启动 sync_engine
- [ ] gateway 关闭时停止 sync_engine

### P0-2 全文件夹同步策略
- [ ] 同步范围扩展：INBOX + Sent + Drafts + Trash + Junk + 订阅文件夹
- [ ] 识别 SPECIAL-USE 文件夹（RFC 6154：`\Sent` `\Drafts` `\Junk` `\Trash`）
- [ ] 每账号同步文件夹列表持久化到 SQLite `folders` 表
- [ ] 文件夹 hierarchy 自动同步（`LIST (SUBSCRIBED)`）

### P0-3 服务器端删除同步
- [ ] 同步时检测服务器已删除的 UID
- [ ] 本地 SQLite 删除对应记录
- [ ] 定期清理（避免 DB 单调增长）

### P0-4 UIDVALIDITY 检测
- [ ] SELECT 时记录 UIDVALIDITY
- [ ] UIDVALIDITY 变化时重置该文件夹本地缓存
- [ ] 持久化 UIDVALIDITY 到 SQLite `folders` 表

---

## P1 — 离线能力（必做，可用性）

### P1-1 正文预下载
- [ ] 后台任务：预下载最近 50 封未读邮件正文
- [ ] LRU 淘汰（超过 500 封缓存时淘汰最旧）
- [ ] 用户可配置预下载数量

### P1-2 附件本地缓存
- [ ] 缓存目录：`app_data_dir/email_attachments/{account_id}/{uid}/{filename}`
- [ ] 流式下载（FETCH BODY[n] → 文件流，避免 base64 内存膨胀）
- [ ] 缓存大小限制 2GB + LRU 淘汰
- [ ] 前端附件点击：先查本地，命中直接打开

### P1-3 离线发信队列
- [ ] outbox 处理移到 Rust 后台任务（不依赖前端定时器）
- [ ] 离线时邮件入 outbox，状态 `pending_offline`
- [ ] 联网后自动发送，失败重试上限 5 次
- [ ] 前端显示待发邮件状态

---

## P2 — 连接模型与防风控（重要，可靠性）

### P2-1 单连接复用模型
- [ ] 合并 IDLE 连接与操作连接为 1 条
- [ ] 操作时 `DONE` 退出 IDLE → 执行操作 → 重新 IDLE
- [ ] 操作排队等待 < 100ms

### P2-2 分级错误恢复
- [ ] 密码错误：黑名单 1h + 前端徽标
- [ ] 频率限制：黑名单 15min
- [ ] 网络断开：指数退避 1s→30min（带抖动）
- [ ] 账号配置变更：自动 reset_pool

### P2-3 CAPABILITY 协商
- [ ] 检测 IDLE / CONDSTORE / MOVE / QUOTA 能力
- [ ] 不支持 IDLE 时回退 30s 轮询
- [ ] 不支持 MOVE 时回退 COPY + STORE + EXPUNGE

---

## P3 — 规则系统扩展（重要，功能完整）

### P3-1 条件 DSL + 动作扩展
- [ ] 条件结构：`{field, op, value}` + AND/OR 组合
- [ ] field 扩展：from / subject / to / cc / body / attachments / size
- [ ] op 扩展：contains / not_contains / equals / regex / gt / lt
- [ ] 新增动作：forward / auto_reply / stop_processing

### P3-2 IDLE 推送即时应用规则
- [ ] IDLE 收到新邮件通知后立即同步并应用规则
- [ ] 规则应用范围扩展到所有订阅文件夹

---

## P5 — 性能与体验（优化）

### P5-1 游标分页 + 并行同步
- [x] `WHERE uid < ? ORDER BY uid DESC LIMIT 50` 替代 OFFSET
- [x] `syncAllAccounts` 并行（Promise.all）

### P5-2 统一收件箱
- [x] 虚拟聚合所有账号 INBOX
- [x] 账号颜色标识

---

## 执行顺序

```
P0-1 → P0-2 → P0-3 → P0-4  （同步完整性，基础体验）
  ↓
P1-1 → P1-2 → P1-3  （离线能力）
  ↓
P2-1 → P2-2 → P2-3  （连接模型）
  ↓
P3-1 → P3-2  （规则扩展）
  ↓
P5-1 → P5-2  （性能优化）
```

## 验证标准

每个 P 完成后：
1. `cargo check` 通过
2. `python -c "import mona.api.server"` 通过
3. `npx tsc --noEmit` 通过
4. 功能手动验证（启动应用测试）
