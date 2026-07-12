# 邮件 AI 日程提取设计方案

> **定位**：邮件落盘后，由 AI 自动识别邮件内容中的日程信号（会议时间、截止日期、预约提醒等），按用户配置自动创建日程或弹通知确认后创建。
>
> **核心约束**：
> - 只解析"新邮件"，不批量扫描历史邮件（用户已确认不需要）
> - 单邮件重新 LLM 解析，不依赖预向量化的邮件知识库
> - 创建模式由用户配置：`auto`（直接创建）或 `confirm`（提醒确认后创建）
> - 触发范围由用户配置：仅对指定文件夹的新邮件触发

---

## 一、设计理念

### 核心问题

邮件里经常包含日程信号：

- "本周五下午 3 点开评审会"
- "请于 7 月 20 日前提交材料"
- "预约确认：7 月 15 日 10:00 牙科复诊"
- "Deadline: 2026-07-18 EOD"

传统邮件客户端要求用户手动把这些信息抄到日历里。Mona 已有 `schedule` 工具和 `ScheduleService`，缺的是把"邮件正文 → 结构化日程字段"这一步交给 LLM，并在合适的时机自动触发。

### 解决思路：配置驱动 + 新邮件触发 + LLM 精细解析

```
┌──────────────────────────────────────────────────────────────┐
│                    用户配置层（EmailScheduleConfig）            │
│   enabled │ folders │ createMode(auto/confirm) │ leadMinutes  │
├──────────────────────────────────────────────────────────────┤
│                    触发层（Rust → Python hook）                │
│   sync_folder_internal 落盘 → 上报新邮件 → 过滤配置文件夹       │
├──────────────────────────────────────────────────────────────┤
│                    解析层（schedule_extract.py）               │
│   单邮件 LLM 解析 → {title, startAt, endAt, allDay, ...}      │
├──────────────────────────────────────────────────────────────┤
│                    去重 + 创建层（ScheduleService）            │
│   source_module + source_chat_id 查重 → auto 直接创建          │
│                                              confirm 通知用户 │
└──────────────────────────────────────────────────────────────┘
```

### 三个关键设计决策

**决策一：只解析新邮件，不批量扫描历史**

邮件同步流程在 `sync_folder_internal`（[email.rs](file:///d:/liuzhe/Desktop/code/Mona/src-tauri/src/email.rs)）落盘新邮件时已经知道哪些是真正新增的 UID。把这些 UID 上报给 Python hook 即可，不需要遍历历史数据库。

好处：

- 成本可控：只对增量邮件消耗 LLM token
- 语义清晰：用户启用功能后只对"启用之后到达的邮件"生效
- 无需额外的"已处理"标记字段

**决策二：单邮件重新 LLM 解析，不做缓存复用**

每封邮件单独调一次 LLM。理由：

- 邮件正文长度通常在 LLM 上下文范围内，单封成本可接受
- 不需要为"同一封邮件多次解析"做缓存（同步流程只触发一次）
- LLM 模型升级时无需清理旧缓存

**决策三：去重基于 `source_module + source_chat_id`，不引入新表**

`ScheduleItem` 已有 `source_module` 和 `source_chat_id` 两个字段（[types.py](file:///d:/liuzhe/Desktop/code/Mona/mona/schedule/types.py)）。直接复用：

- `source_module = "email_schedule_ai"`
- `source_chat_id = "{accountId}:{uid}"`

`ScheduleService.list_items` 已能按时间范围查询，前端 / hook 调用前先 `list_items` 过滤同 source 即可去重，无需新增数据库表。

---

## 二、整体架构

### 数据流

```
┌─────────┐  IMAP SYNC   ┌──────────────┐  new_uids   ┌──────────────┐
│ IMAP    │ ───────────> │ Rust         │ ──────────> │ Python hook  │
│ Server  │               │ email.rs     │             │ (HTTP /email │
└─────────┘               │ sync_folder  │             │  /schedule   │
                          │ _internal    │             │  /extract)   │
                          └──────┬───────┘             └──────┬───────┘
                                 │ .eml 落盘                   │
                                 │ SQLite INSERT               │
                                 v                             v
                          ┌──────────────┐   read body   ┌──────────────┐
                          │ email.sqlite │ <───────────  │ schedule_    │
                          │ messages     │               │ extract.py   │
                          └──────────────┘               │  (LLM)       │
                                                         └──────┬───────┘
                                                                │ ScheduleItem
                                                                v
                         ┌──────────────┐  list_items    ┌──────────────┐
                         │ Schedule     │ <────────────  │ 去重判定      │
                         │ Service      │                │ (source_*)   │
                         │ .add_item    │ <────────────  │              │
                         └──────┬───────┘                └──────┬───────┘
                                │                               │
                                │ auto 模式                     │ confirm 模式
                                v                               v
                         ┌──────────────┐           ┌──────────────────────┐
                         │ 直接落 JSON  │           | Tauri 通知 / 待确认队列│
                         │ + 起定时器    │           | 用户点击 → Schedule   │
                         │              │           | Dialog 预填 → 确认    │
                         └──────────────┘           └──────────────────────┘
```

### 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| 配置 | `mona/email_intel/config.py` | 新增 `EmailScheduleConfig` 子模型 |
| 触发 | `src-tauri/src/email.rs` | `sync_folder_internal` 落盘后调 gateway hook |
| Hook 路由 | `mona/api/server.py` | `POST /email/schedule/extract` 接收新邮件 UID |
| 解析 | `mona/email_intel/schedule_extract.py`（新增）| 单邮件 LLM 解析 |
| 去重 + 创建 | `mona/schedule/service.py`（复用） | `list_items` 查重 + `add_item` |
| 确认队列 | `mona/email_intel/schedule_extract.py` | pending 队列 + HTTP 接口 |
| 前端配置 | `webui/src/components/email/...Settings.tsx` | 文件夹多选 + 模式切换 |
| 前端确认 | `webui/src/components/schedule/ScheduleDialog.tsx` | 预填打开 |

---

## 三、配置层

### 配置模型扩展

在 [mona/email_intel/config.py](file:///d:/liuzhe/Desktop/code/Mona/mona/email_intel/config.py) 中新增：

```python
class EmailScheduleConfig(Base):
    """邮件 AI 日程提取配置。"""

    # 总开关
    enabled: bool = False

    # 启用 AI 提取的文件夹列表，格式为 "{accountId}:{folderName}"
    # 如 ["37bd0f8c-...:INBOX", "37bd0f8c-...:会议预约"]
    # 空列表表示不启用任何文件夹（即使 enabled=True 也不触发）
    # 颗粒度到每个邮箱账号的每个文件夹，支持多账号多文件夹独立勾选
    folders: list[str] = []

    # 创建模式：
    #   "auto"    —— LLM 解析成功后直接创建日程
    #   "confirm" —— 弹通知让用户确认后再创建
    create_mode: Literal["auto", "confirm"] = "confirm"

    # 提醒提前量（分钟）。仅对 personal 类型日程生效。
    # 实际日程的 start_at_ms = 邮件中提到的事件时间 - lead_minutes
    # 例如邮件说"周五下午 3 点开会"，lead_minutes=15，则日程 start_at = 周五 14:45
    # 目的：让 ScheduleService 的 personal reminder 在事件前 15 分钟弹通知
    lead_minutes: int = 15

    # 跳过的发件人域名（避免自动化邮件反复触发）
    # 例如 ["noreply.github.com", "notifications@slack.com"]
    skip_senders: list[str] = []

    # 单邮件解析超时（秒），防止 LLM 卡住整个同步流程
    parse_timeout_seconds: int = 30
```

`EmailIntelConfig` 增加字段：

```python
class EmailIntelConfig(Base):
    search_limit: int = 50
    schedule: EmailScheduleConfig = Field(default_factory=EmailScheduleConfig)
```

### 配置 JSON 示例

```json
{
  "emailIntel": {
    "searchLimit": 50,
    "schedule": {
      "enabled": true,
      "folders": ["37bd0f8c-...:INBOX", "37bd0f8c-...:会议预约"],
      "createMode": "confirm",
      "leadMinutes": 15,
      "skipSenders": ["noreply.github.com"],
      "parseTimeoutSeconds": 30
    }
  }
}
```

---

## 四、LLM 解析模块

### 文件：`mona/email_intel/schedule_extract.py`（新增）

#### 输入

单封邮件的完整内容（subject + from + to + date + bodyText），由 `email_intel/db.get_message` 读取。

#### 输出（结构化 JSON）

```python
@dataclass
class ExtractedSchedule:
    """LLM 从邮件中提取的日程信息。"""

    title: str               # 日程标题，简洁（≤50字）
    start_at: str            # ISO 8601，含时区偏移（如 2026-07-15T15:00:00+08:00）
    end_at: str | None       # 可选，ISO 8601
    all_day: bool            # 是否全天事件
    description: str         # 详细描述（含原始邮件片段、链接）
    confidence: float        # 0.0~1.0，LLM 自评的把握度
    has_schedule: bool       # False 表示邮件中没有日程信号
```

#### Prompt 设计

```
你是一个日程提取助手。从下面这封邮件中识别"用户需要记住并按时处理的时间相关事件"。

需要识别的信号：
- 会议/通话/预约的时间
- 截止日期（deadline）
- 活动报名确认
- 航班/火车/酒店时间
- 预约确认（医院、餐厅等）

不需要识别的信号：
- 邮件本身的发送时间
- 历史事件的回顾
- 模糊的"尽快""早日"等无明确时间
- 营销邮件中的"限时优惠截止 X 月 X 日"

当前时间：{now_iso}（{tz}）
邮件发件时间：{date}
邮件主题：{subject}
邮件正文：
---
{body_text}
---

输出 JSON（只输出 JSON，不要其他文字）：
{{
  "has_schedule": true/false,
  "title": "...",
  "start_at": "ISO 8601 with timezone offset",
  "end_at": "ISO 8601 or null",
  "all_day": false,
  "description": "原始邮件中的关键句 + 必要背景",
  "confidence": 0.0~1.0
}}

规则：
1. start_at 必须是明确的时间点，不能是"明天""下周"这种相对时间——你需要结合邮件发件时间换算成绝对时间
2. 如果邮件里只有日期没有具体时间，all_day=true，start_at 用 00:00:00
3. 如果邮件里没有任何日程信号，has_schedule=false，其他字段填 null 或默认值
4. confidence < 0.6 的结果会被丢弃
```

#### 调用流程

```python
async def extract_schedule_from_email(
    msg: dict,
    *,
    config: EmailScheduleConfig,
    now_iso: str,
    tz: str,
) -> ExtractedSchedule | None:
    """从单封邮件提取日程。返回 None 表示没有日程信号或置信度过低。"""

    # 1. 跳过黑名单发件人
    if _should_skip(msg["fromAddress"], config.skip_senders):
        return None

    # 2. 调 LLM（复用 mona.agent.llm 或直接 httpx 调 provider）
    prompt = _build_prompt(msg, now_iso, tz)
    try:
        raw = await asyncio.wait_for(
            _call_llm(prompt), timeout=config.parse_timeout_seconds
        )
    except asyncio.TimeoutError:
        logger.warning("schedule extract timeout: uid={}", msg["uid"])
        return None

    # 3. 解析 + 校验
    parsed = _parse_llm_json(raw)
    if not parsed or not parsed.get("has_schedule"):
        return None
    if parsed.get("confidence", 0) < 0.6:
        return None
    if not parsed.get("start_at"):
        return None

    return ExtractedSchedule(**parsed)
```

---

## 五、触发流程

### Rust 侧 Hook

在 [email.rs](file:///d:/liuzhe/Desktop/code/Mona/src-tauri/src/email.rs) 的 `sync_folder_internal` 中，新邮件落盘完成后追加：

```rust
// 在 sync_folder_internal 函数末尾，返回 SyncResult 之前
if !new_uids.is_empty() {
    // 异步触发，不阻塞 sync 返回（用户感知的"收取"不应被 AI 解析拖慢）
    let app_handle = state.app_handle.clone();
    let account_id = req.account_id.clone();
    let mailbox = req.mailbox.clone();
    let uids = new_uids.clone();
    tokio::spawn(async move {
        let _ = trigger_schedule_extract(
            &app_handle, &account_id, &mailbox, &uids
        ).await;
    });
}
```

`trigger_schedule_extract` 通过 gateway HTTP 调 Python hook：

```rust
async fn trigger_schedule_extract(
    app: &AppHandle,
    account_id: &str,
    mailbox: &str,
    uids: &[String],
) -> Result<(), String> {
    let gateway_url = get_gateway_url(app)?;
    let url = format!("{}/email/schedule/extract", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let body = json!({
        "accountId": account_id,
        "mailbox": mailbox,
        "uids": uids,
    });
    // 不等返回，fire-and-forget；hook 内部异步处理
    let _ = client.post(&url).json(&body).send().await;
    Ok(())
}
```

### Python 侧 Hook 路由

在 [mona/api/server.py](file:///d:/liuzhe/Desktop/code/Mona/mona/api/server.py) 的 `create_app()` 注册：

```python
async def _email_schedule_extract(request: web.Request) -> web.Response:
    """新邮件日程提取 hook。由 Rust sync 流程触发。"""
    body = await request.json()
    account_id = body["accountId"]
    mailbox = body["mailbox"]
    uids = body["uids"]

    config = request.app["config"].email_intel.schedule
    if not config.enabled:
        return web.json_response({"skipped": True, "reason": "disabled"})

    if mailbox not in config.folders:
        return web.json_response({"skipped": True, "reason": "folder_not_configured"})

    # 异步处理，立即返回 202，不阻塞 Rust sync
    asyncio.create_task(_process_schedule_extract(
        account_id, mailbox, uids, config
    ))
    return web.json_response({"accepted": True, "count": len(uids)})


async def _process_schedule_extract(
    account_id: str,
    mailbox: str,
    uids: list[str],
    config: EmailScheduleConfig,
) -> None:
    """实际处理：读邮件正文 → LLM 解析 → 去重 → 创建/入队。"""
    from mona.email_intel.db import get_message
    from mona.email_intel.schedule_extract import extract_schedule_from_email
    from mona.schedule.service import ScheduleService

    svc: ScheduleService = request.app["schedule_service"]  # 从 app 取
    tz = request.app["config"].timezone

    for uid in uids:
        try:
            msg = get_message(uid, account_id, mailbox)
            if not msg:
                continue

            extracted = await extract_schedule_from_email(
                msg, config=config, now_iso=datetime.now().isoformat(),
                tz=tz,
            )
            if not extracted:
                continue

            # 去重
            source_chat_id = f"{account_id}:{uid}"
            if await _already_extracted(svc, source_chat_id):
                continue

            # 构造 ScheduleItem
            item = _build_schedule_item(
                extracted, account_id, uid, config.lead_minutes, tz
            )

            if config.create_mode == "auto":
                await svc.add_item(item)
                logger.info("schedule auto-created: {} from email {}", item.title, uid)
            else:
                # confirm 模式：入待确认队列，前端轮询
                _enqueue_pending_confirmation(item, msg)

        except Exception:
            logger.exception("schedule extract failed: uid={}", uid)


async def _already_extracted(svc: ScheduleService, source_chat_id: str) -> bool:
    """检查同 source_chat_id 的日程是否已存在。"""
    items = await svc.list_items()
    return any(
        it.source_module == "email_schedule_ai"
        and it.source_chat_id == source_chat_id
        for it in items
    )
```

---

## 六、去重机制

### 字段约定

| 字段 | 值 |
|------|-----|
| `source_module` | `"email_schedule_ai"` |
| `source_chat_id` | `"{accountId}:{uid}"` |

### 去重时机

1. **创建前查重**：`_already_extracted` 调用 `list_items` 过滤同 source 的记录
2. **天然去重**：sync 流程对同一封邮件只触发一次 hook（新 UID 只在第一次同步时进入 `new_uids`）
3. **重复同步保护**：即使 IMAP MOVE 产生新 UID，`sync_folder_internal` 的 message_id 去重会删除旧 UID 版本，新 UID 触发 hook 时 `_already_extracted` 不会命中（旧日程的 source_chat_id 是旧 UID）——这是预期行为：邮件被移动到目标文件夹后，相当于"重新出现在配置文件夹中"，应当重新解析

### 失败重试

LLM 调用失败不重试，避免对同一封邮件反复消耗 token。日志记录失败，用户可在 MailView 手动点"重新提取"按钮重试。

---

## 七、创建模式

### `auto` 模式

LLM 解析成功 → 去重通过 → 直接 `ScheduleService.add_item`：

```python
def _build_schedule_item(
    extracted: ExtractedSchedule,
    account_id: str,
    uid: str,
    lead_minutes: int,
    tz: str,
) -> ScheduleItem:
    start_dt = datetime.fromisoformat(extracted.start_at)
    start_ms = int(start_dt.timestamp() * 1000)

    # 提前 lead_minutes 分钟，让 personal reminder 在事件前提醒
    if not extracted.all_day and lead_minutes > 0:
        start_ms -= lead_minutes * 60 * 1000

    end_ms = None
    if extracted.end_at:
        end_dt = datetime.fromisoformat(extracted.end_at)
        end_ms = int(end_dt.timestamp() * 1000)

    return ScheduleItem(
        id=create_schedule_item_id(),
        title=extracted.title,
        start_at_ms=start_ms,
        end_at_ms=end_ms,
        all_day=extracted.all_day,
        kind="personal",
        description=extracted.description,
        source_module="email_schedule_ai",
        source_chat_id=f"{account_id}:{uid}",
        tz=tz,
    )
```

### `confirm` 模式

#### 待确认队列

```python
# mona/email_intel/schedule_extract.py

import time

_pending_confirmations: list[dict] = []  # 进程内队列，重启丢失（可接受）

def _enqueue_pending_confirmation(item: ScheduleItem, msg: dict) -> None:
    _pending_confirmations.append({
        "id": item.id,
        "title": item.title,
        "startAtMs": item.start_at_ms,
        "endAtMs": item.end_at_ms,
        "allDay": item.all_day,
        "description": item.description,
        "emailUid": msg["uid"],
        "emailAccountId": msg["accountId"],
        "emailFolder": msg["folder"],
        "emailSubject": msg["subject"],
        "emailFrom": msg.get("fromName") or msg["fromAddress"],
        "enqueuedAtMs": int(time.time() * 1000),
    })


def pop_pending_confirmations() -> list[dict]:
    pending = _pending_confirmations
    _pending_confirmations = []
    return pending


def discard_pending_confirmation(item_id: str) -> None:
    global _pending_confirmations
    _pending_confirmations = [
        p for p in _pending_confirmations if p["id"] != item_id
    ]
```

#### HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/email/schedule/pending` | 前端轮询待确认列表 |
| POST | `/api/email/schedule/confirm` | body: `{itemId}`，将待确认项转为正式日程 |
| POST | `/api/email/schedule/discard` | body: `{itemId}`，丢弃待确认项 |

#### 前端交互

1. 前端定时（30s）轮询 `/api/email/schedule/pending`
2. 有新项时，主窗口显示一个非阻塞的"待确认日程"提示条（或在日程模块显示红点）
3. 用户点击提示 → 打开 `ScheduleDialog`，`item` 字段预填待确认项，`onSave` 调 `/confirm` 接口
4. 用户点"忽略" → 调 `/discard` 接口

#### Tauri 通知（可选增强）

`confirm` 模式下额外弹一个系统通知（复用 [schedule_notifier.rs](file:///d:/liuzhe/Desktop/code/Mona/src-tauri/src/schedule_notifier.rs) 的机制），通知文案：

```
发现可能的日程
{title}
点击查看 →
```

点击通知打开主窗口并跳转到待确认列表。

---

## 八、前端改动

### 1. 配置 UI

在邮件设置页（`webui/src/components/email/...Settings.tsx`）新增"AI 日程提取"卡片：

| 控件 | 类型 | 说明 |
|------|------|------|
| 启用 | Switch | 总开关 |
| 启用文件夹 | 多选 Checkbox | 列表来自 `email_list_folders`，默认 INBOX 勾选 |
| 创建模式 | Radio | "直接创建" / "提醒后确认" |
| 提醒提前量 | Input number | 分钟，默认 15 |
| 跳过的发件人 | Textarea | 一行一个域名/邮箱 |

配置保存到 `config.json` 的 `emailIntel.schedule` 节，通过 gateway `/config` 接口读写。

### 2. MailView 手动触发按钮

在邮件详情页工具栏新增"提取日程"按钮（图标 `CalendarPlus`）：

- 点击后调 `POST /api/email/schedule/extract-manual`，body: `{uid, accountId, folder}`
- 后端忽略 `config.folders` 限制，强制对这封邮件解析
- 解析成功后：
  - `auto` 模式：直接创建，toast 提示"已创建日程：{title}"
  - `confirm` 模式：直接打开 `ScheduleDialog` 预填，不进入待确认队列
- 解析失败（`has_schedule=false` 或 confidence 低）：toast 提示"未发现日程信号"

### 3. 日程模块待确认入口

在 `ScheduleView` 顶部增加"待确认"角标：

- 轮询 `/api/email/schedule/pending` 获取数量
- 点击展开列表，每项显示标题 + 邮件主题 + 时间 + "确认"/"忽略"按钮

---

## 九、边界与隐私

### 性能边界

- **LLM 调用串行**：同一批 `new_uids` 内部串行调用 LLM（避免并发打爆 provider），但 hook 本身异步返回不阻塞 Rust sync
- **超时保护**：单邮件解析 30s 超时（`parse_timeout_seconds` 可配置）
- **失败不重试**：避免对同一封邮件反复消耗 token

### 隐私边界

- 邮件正文发送给 LLM provider 处理——与现有 AI 对话使用同一 provider，不引入新的数据流出路径
- 用户可在 `skip_senders` 中排除敏感发件人（如银行、HR）
- 总开关 `enabled=false` 时，Rust hook 不调 Python，Python 不调 LLM，零额外开销

### 用户体验边界

- `confirm` 模式是默认值——避免 LLM 误判后用户日程列表被垃圾条目污染
- `lead_minutes` 提前量只是"提醒提前"，不改变事件本身的开始时间
- 删除由 AI 创建的日程：和普通日程一样在 `ScheduleDialog` 里删除，无需特殊逻辑

---

## 十、实施清单

### 后端（Python）

- [ ] `mona/email_intel/config.py`：新增 `EmailScheduleConfig` + 扩展 `EmailIntelConfig`
- [ ] `mona/email_intel/schedule_extract.py`：新建，含 `ExtractedSchedule` + `extract_schedule_from_email` + pending 队列
- [ ] `mona/api/server.py`：注册 4 个路由
  - `POST /email/schedule/extract`（Rust hook 触发）
  - `GET /api/email/schedule/pending`
  - `POST /api/email/schedule/confirm`
  - `POST /api/email/schedule/discard`
  - `POST /api/email/schedule/extract-manual`（MailView 手动触发）

### 后端（Rust）

- [ ] `src-tauri/src/email.rs`：`sync_folder_internal` 末尾追加异步触发 `trigger_schedule_extract`
- [ ] （可选）`src-tauri/src/schedule_notifier.rs`：扩展支持自定义通知文案，用于 confirm 模式弹通知

### 前端

- [ ] 邮件设置页新增"AI 日程提取"卡片
- [ ] `MailView.tsx` 工具栏新增"提取日程"按钮（`CalendarPlus` 图标）
- [ ] `ScheduleView.tsx` 顶部新增"待确认"角标 + 展开列表
- [ ] `ScheduleDialog.tsx` 支持外部预填（已支持 `item` prop，需确认字段对齐）

### 配置迁移

- [ ] 旧 `config.json` 无 `emailIntel.schedule` 节时，Pydantic 默认值自动生效（`enabled=false`），无需显式迁移

---

## 十一、与现有功能的关系

| 现有功能 | 关系 |
|---------|------|
| `ScheduleTool`（agent 工具） | 互不干扰。AI 对话中用户说"帮我加个日程"走 `ScheduleTool`；邮件落盘自动提取走本方案。两者 `source_module` 不同（`agent` vs `email_schedule_ai`） |
| `email_search` / `email_read` | 本方案直接读 `email_intel.db.get_message`，不经过 agent 工具层 |
| `EmailTaskExtractTool` | **已删除**（批量扫描历史邮件，用户确认不需要） |
| `schedule_notifier.rs` | confirm 模式可复用其通知通道 |
| `ScheduleDialog.tsx` | 复用，支持外部预填 |

---

## 十二、未来扩展（不在本期范围）

- **多日程提取**：一封邮件里多个时间点（如"周一、周三、周五各开一次会"）——当前 prompt 只提取一个，未来可扩展为返回数组
- **重复事件识别**：邮件里说"每周三下午 3 点"——当前 `recurrence` 字段已支持，prompt 升级后可识别
- **跨邮件聚合**：同一项目多封邮件关联到同一日程——需要邮件聚类，超出本期范围
- **冲突检测**：新创建的日程与已有日程时间冲突时提示用户
