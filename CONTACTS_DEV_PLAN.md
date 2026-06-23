# 通讯录（地址簿）功能开发计划

> 目标：为 Mona 邮箱客户端实现 Foxmail 风格的地址簿同步，支持 CardDAV（QQ 个人邮/Gmail/iCloud）和 Exchange ActiveSync（腾讯企业邮/网易企业邮/Exchange），仅下载同步，集成到 MailComposer 收件人自动补全。

## 设计决策（已确认）

- 同步方向：**仅下载**（服务器 → 本地，本地不上传）
- 协议：**双协议并存**
  - **CardDAV**（RFC 6352）：QQ 个人邮、Gmail、iCloud
  - **Exchange ActiveSync (EAS)**（MS-ASCMD）：腾讯企业邮、网易企业邮、Exchange、Outlook.com
- UI 入口：**侧栏底部按钮**（FolderTree 底部）
- 自动补全：**输入即搜索**（MailComposer 收件人框）
- 协议选择：用户在 NewAccountDialog 填写同步地址，按协议字段（carddavUrl / easUrl）分发

## 架构

```
前端 contacts/ ──invoke──→ Rust contacts.rs (SQLite CRUD)
              ──fetch──→ Python /contacts/* (CardDAV / ActiveSync 同步)
                                    ↓
                          CardDAV 服务器 / EAS 服务器
```

## 数据模型（email.sqlite3 新增 2 表）

### contacts
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| account_id | TEXT | 来源账号 |
| source | TEXT | carddav / manual |
| remote_uid | TEXT | vCard UID |
| etag | TEXT | ETag |
| display_name | TEXT | 显示名 |
| email | TEXT | 主邮箱 |
| email_list | TEXT(JSON) | 其他邮箱 |
| phone | TEXT | 电话 |
| organization | TEXT | 公司 |
| title | TEXT | 职务 |
| note | TEXT | 备注 |
| raw_vcard | TEXT | 原始 vCard |
| last_modified | INTEGER | 服务器修改时间 |
| updated_at | INTEGER | 本地更新时间 |

唯一索引：(account_id, remote_uid)

### contact_sync_state
| 字段 | 类型 | 说明 |
|------|------|------|
| account_id | TEXT PK | 账号 |
| sync_token | TEXT | RFC 6578 sync-token |
| last_synced_at | INTEGER | 上次同步 |
| last_sync_status | TEXT | success/failed |
| last_error | TEXT | 错误信息 |

## CardDAV 默认配置（按邮箱域名）

| 邮箱后缀 | CardDAV URL |
|---------|-------------|
| qq.com / foxmail.com | https://dav.qq.com/ |
| icloud.com | https://contacts.icloud.com/ |
| gmail.com | https://www.google.com/carddav/ |
| 其他 | 用户手动填写 |

## ActiveSync 默认配置（按邮箱域名）

| 邮箱后缀 | EAS URL | 说明 |
|---------|---------|------|
| 腾讯企业邮（exmail.qq.com） | https://ex.exmail.qq.com/Microsoft-Server-ActiveSync | 腾讯企业邮 |
| 网易企业邮 | https://qiyemail.qiye.163.com/Microsoft-Server-ActiveSync | 网易企业邮 |
| Exchange / Office365 | https://outlook.office365.com/Microsoft-Server-ActiveSync | 微软托管 |
| 其他 | 用户手动填写 |

---

## 实施任务

### P1: 本地通讯录基础

- [ ] **1.1** Rust: 创建 `src-tauri/src/contacts.rs`
  - Contact / ContactSyncState 结构体
  - ContactsState（复用 email.sqlite3）
  - 建表迁移（contacts / contact_sync_state）
  - Tauri 命令: contact_list / contact_search / contact_add / contact_update / contact_delete / contact_get_sync_state / contact_save_sync_state / contact_clear_account
- [ ] **1.2** Rust: `lib.rs` 注册 contacts 命令 + 初始化 ContactsState
- [ ] **1.3** 前端: `contacts/lib/types.ts` 类型定义
- [ ] **1.4** 前端: `contacts/lib/contactsApi.ts` API 封装
- [ ] **1.5** 前端: `contacts/ContactsView.tsx` 列表+详情界面
- [ ] **1.6** 前端: FolderTree 底部加"通讯录"入口按钮，EmailClientView 切换视图

### P2: CardDAV 同步

- [ ] **2.1** Python: `mona/contacts/__init__.py` + `vcard.py`（vCard 解析器，无依赖）
- [ ] **2.2** Python: `mona/contacts/carddav.py`（PROPFIND / REPORT sync-collection / GET）
- [ ] **2.3** Python: `mona/contacts/sync.py`（同步调度：全量/增量）
- [ ] **2.4** Python: `mona/api/server.py` 新增路由 `/contacts/sync` `/contacts/sync_status` `/contacts/test_carddav`
- [ ] **2.5** Rust: contacts.rs 增加 `contact_sync` / `contact_test_carddav` 转发命令（gateway HTTP）
- [ ] **2.6** 前端: NewAccountDialog 加 CardDAV 配置字段（carddavUrl + 同步开关）
- [ ] **2.7** 前端: ContactsView 加"同步"按钮 + 状态显示
- [ ] **2.8** 前端: contactsApi.ts 增加 syncContacts / testCarddav

### P3: MailComposer 自动补全

- [ ] **3.1** 前端: `contacts/ContactPicker.tsx` 输入即搜索下拉组件
- [ ] **3.2** 前端: MailComposer 集成 ContactPicker（收件人/抄送/密送）

### P4: Exchange ActiveSync 同步

- [x] **4.1** Python: `mona/contacts/wbxml.py` — WBXML 二进制 XML 编解码器（无依赖）
  - WBXML 解码：byte → token → XML 节点（含 code page 切换、属性、字符串表）
  - WBXML 编码：XML 节点 → byte
  - ActiveSync 代码页常量表（AirSync/Contacts/Contacts2/AirSyncBase/Provision/Settings/FolderHierarchy）
- [x] **4.2** Python: `mona/contacts/activesync.py` — EAS 客户端
  - HTTP POST 到 `/Microsoft-Server-ActiveSync?Cmd=...&User=...&DeviceId=...&DeviceType=...`
  - PROVISION → SETTINGS → FOLDERSYNC → SYNC 握手
  - DeviceId 生成与持久化（基于账号 ID 的稳定哈希）
  - 联系人解析（vCard 2.1 子集 / EAS Contacts 代码页字段）
  - SSRF 校验
- [x] **4.3** Python: `mona/contacts/sync.py` 增加 `sync_account_contacts_eas` 调度
- [x] **4.4** Python: `mona/api/server.py` 新增路由 `/contacts/sync_eas` `/contacts/test_eas`
- [x] **4.5** Rust: contacts.rs 增加 `contact_sync_eas` / `contact_test_eas` 转发命令
- [x] **4.6** Rust: EmailAccount 加 `eas_url` 字段（结构体 + DB 迁移 + 命令）
- [x] **4.7** 前端: types.ts EmailAccount 加 `easUrl`，contactsApi.ts 加 syncEas/testEas
- [x] **4.8** 前端: NewAccountDialog 加 ActiveSync URL 输入框（与 CardDAV 并存）
- [x] **4.9** 前端: ContactsView 同步逻辑按协议分发（carddavUrl → CardDAV，easUrl → EAS）

---

## 进度日志

### P1: 本地通讯录基础 ✅

- **1.1** ✅ 创建 [src-tauri/src/contacts.rs](file:///d:/liuzhe/Desktop/code/Mona/src-tauri/src/contacts.rs)
  - Contact / ContactSyncState / SyncedContact / ContactSyncResult 结构体
  - ContactsState 复用 email.sqlite3，建 contacts / contact_sync_state 表
  - 8 个 Tauri 命令：contact_list / contact_search / contact_add / contact_update / contact_delete / contact_clear_account / contact_get_sync_state / contact_save_sync_state
- **1.2** ✅ [lib.rs](file:///d:/liuzhe/Desktop/code/Mona/src-tauri/src/lib.rs) 注册 contacts 模块 + 10 个命令，cargo check 通过
- **1.3** ✅ [contacts/lib/types.ts](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/contacts/lib/types.ts)：Contact/ContactSyncState/ContactSyncResult 类型 + getAllEmails/inferCarddavUrl 工具
- **1.4** ✅ [contacts/lib/contactsApi.ts](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/contacts/lib/contactsApi.ts)：CRUD + syncContacts/testCarddav
- **1.5** ✅ [ContactsView.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/contacts/ContactsView.tsx)：列表+详情+编辑器+同步按钮+搜索
- **1.6** ✅ [FolderTree.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/FolderTree.tsx) 底部加通讯录入口，[EmailClientView.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/EmailClientView.tsx) view 状态切换

### P2: CardDAV 同步 ✅

- **2.1** ✅ [mona/contacts/vcard.py](file:///d:/liuzhe/Desktop/code/Mona/mona/contacts/vcard.py)：轻量 vCard 解析器（行折叠/参数/转义），无第三方依赖
- **2.2** ✅ [mona/contacts/carddav.py](file:///d:/liuzhe/Desktop/code/Mona/mona/contacts/carddav.py)：CardDAV 客户端（PROPFIND/sync-collection/GET），SSRF 校验，defusedxml 防 XXE
- **2.3** ✅ [mona/contacts/sync.py](file:///d:/liuzhe/Desktop/code/Mona/mona/contacts/sync.py)：同步调度（全量/增量），返回 SyncedContact 列表
- **2.4** ✅ [server.py](file:///d:/liuzhe/Desktop/code/Mona/mona/api/server.py) 新增 handle_contacts_sync / handle_contacts_test_carddav 路由并注册
- **2.5** ✅ contacts.rs contact_sync 命令重写：读旧 token → 调 Python → 写入 SQLite 联系人 + sync_token，全量/增量处理
- **2.6** ✅ EmailAccount 加 carddavUrl 字段（Rust 结构体 + DB 迁移 + 前端 types），[NewAccountDialog.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/NewAccountDialog.tsx) 加 CardDAV 配置输入框
- **2.7** ✅ ContactsView 同步按钮（P1 已实现）
- **2.8** ✅ contactsApi.ts syncContacts/testCarddav（P1 已创建）
- **依赖** ✅ pyproject.toml 添加 defusedxml>=0.7.1

### P3: MailComposer 自动补全 ✅

- **3.1** ✅ [ContactPicker.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/contacts/ContactPicker.tsx)：输入即搜索（防抖 200ms）、键盘导航（↑↓Enter）、点击插入为 "显示名 <邮箱>" 格式
- **3.2** ✅ [MailComposer.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/MailComposer.tsx) 收件人/抄送/密送 Input 替换为 ContactPicker

### P4: Exchange ActiveSync 同步 ✅

- **4.1** ✅ [mona/contacts/wbxml.py](file:///d:/liuzhe/Desktop/code/Mona/mona/contacts/wbxml.py)：WBXML 二进制 XML 编解码器
  - 解码：bytes → Node 树（支持 SWITCH_PAGE/STR_I/OPAQUE/ENTITY/STR_T/LITERAL）
  - 编码：Node 树 → bytes（自动处理代码页切换）
  - 7 个 ActiveSync 代码页常量表（AirSync/Contacts/Contacts2/AirSyncBase/FolderHierarchy/Settings/Provision）
  - Node 数据类带 find/findall/get_text/add_child 辅助方法
- **4.2** ✅ [mona/contacts/activesync.py](file:///d:/liuzhe/Desktop/code/Mona/mona/contacts/activesync.py)：EAS 客户端
  - EASClient 异步上下文管理器，Basic Auth + WBXML body
  - provision()：两步握手（请求策略 → 确认策略 → 获取 PolicyKey）
  - folder_sync()：FolderSync 命令，返回文件夹列表
  - find_contacts_folder()：查找 Type=9 的联系人文件夹
  - sync_contacts()：Sync 命令，支持全量/增量，处理 MoreAvailable 分页
  - _parse_contact()：解析 ApplicationData（Contacts + AirSyncBase 代码页）
  - generate_device_id()：基于账号 ID 的 SHA-256 截断生成稳定 DeviceID
  - SSRF 校验 + 错误处理（401/403/449/5xx）
- **4.3** ✅ [mona/contacts/sync.py](file:///d:/liuzhe/Desktop/code/Mona/mona/contacts/sync.py) 增加 sync_account_contacts_eas + test_eas_connection
  - PROVISION → find_contacts_folder → SYNC 循环（max 50 次防死循环）
  - 全量/增量自动判断（sync_key == "0" 为全量）
  - 返回统一 AccountSyncResult 结构（与 CardDAV 共用）
- **4.4** ✅ [server.py](file:///d:/liuzhe/Desktop/code/Mona/mona/api/server.py) 新增 handle_contacts_sync_eas / handle_contacts_test_eas 路由并注册
- **4.5** ✅ contacts.rs 增加 contact_sync_eas / contact_test_eas 命令（source='eas'，与 CardDAV 逻辑独立）
- **4.6** ✅ EmailAccount 加 eas_url 字段（Rust 结构体 + DB 迁移 + email_list_accounts/get_imap_credentials 查询更新）
- **4.7** ✅ 前端 types.ts EmailAccount 加 easUrl，contactsApi.ts 加 syncContactsEas/testEas + EASSyncRequest/EASTestRequest，contacts/lib/types.ts 加 inferEasUrl + ContactSource 加 'eas'
- **4.8** ✅ [NewAccountDialog.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/NewAccountDialog.tsx) 加 ActiveSync URL 输入框，邮箱地址变化时自动推断 EAS URL（腾讯企业邮/网易企业邮/Office365）
- **4.9** ✅ [ContactsView.tsx](file:///d:/liuzhe/Desktop/code/Mona/webui/src/components/email/contacts/ContactsView.tsx) 同步逻辑按协议分发：easUrl 优先 → ActiveSync，否则 carddavUrl → CardDAV

### 验证结果

- ✅ Rust `cargo check` 通过
- ✅ Python `ruff check mona/contacts/` 全部通过
- ✅ Python 导入 `from mona.contacts import ...` 正常
- ✅ 前端 `tsc --noEmit` contacts 相关无错误（预先存在的 tests/mona-client 错误与本次改动无关）

### 新增/修改文件清单

**新增**：
- `src-tauri/src/contacts.rs`
- `mona/contacts/__init__.py`
- `mona/contacts/vcard.py`
- `mona/contacts/carddav.py`
- `mona/contacts/wbxml.py`（P4 新增：WBXML 编解码器）
- `mona/contacts/activesync.py`（P4 新增：EAS 客户端）
- `mona/contacts/sync.py`
- `webui/src/components/email/contacts/ContactsView.tsx`
- `webui/src/components/email/contacts/ContactPicker.tsx`
- `webui/src/components/email/contacts/lib/types.ts`
- `webui/src/components/email/contacts/lib/contactsApi.ts`

**修改**：
- `src-tauri/src/lib.rs`（注册 contacts 模块和命令，含 EAS 命令）
- `src-tauri/src/email.rs`（EmailAccount 加 carddavUrl + easUrl + DB 迁移）
- `mona/api/server.py`（新增 /contacts/* 路由，含 sync_eas/test_eas）
- `pyproject.toml`（添加 defusedxml 依赖）
- `webui/src/components/email/lib/types.ts`（EmailAccount 加 carddavUrl + easUrl）
- `webui/src/components/email/EmailClientView.tsx`（view 切换）
- `webui/src/components/email/FolderTree.tsx`（通讯录入口按钮）
- `webui/src/components/email/NewAccountDialog.tsx`（CardDAV + ActiveSync 配置字段）
- `webui/src/components/email/MailComposer.tsx`（集成 ContactPicker）
