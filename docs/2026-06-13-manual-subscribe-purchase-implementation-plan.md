# Mona 手动订阅购买流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Mona 客户端内实现手动订阅购买流程：价格从服务端动态获取，用户在应用内查看价格并联系作者购买；同时提供应用内消息中心，支持服务端发布促销/系统通知。

**Architecture:** 后端（mona-auth）新增价格配置与消息通知的数据模型、API 路由和后台管理 Tab；客户端通过 Tauri 命令获取价格配置并渲染订阅引导页，通过消息中心拉取并展示通知。不集成在线支付，后台继续人工设置订阅时间。

**Tech Stack:** FastAPI + SQLAlchemy + Alembic（后端）; React 18 + TypeScript + Tauri 2 + shadcn/ui（前端）

---

## File Structure

### 后端新增
- `mona-auth/app/models.py` — 新增 `PricingPlan`、`AppConfig`、`Notification`、`NotificationRead` 模型
- `mona-auth/app/schemas.py` — 新增价格、配置、通知相关 Pydantic schema
- `mona-auth/app/routers/config_router.py` — 公开价格配置 API
- `mona-auth/app/routers/notification_router.py` — 登录用户消息通知 API
- `mona-auth/alembic/versions/` — 新增数据库迁移脚本

### 后端修改
- `mona-auth/app/main.py` — 注册新路由
- `mona-auth/app/config.py` — 移除硬编码价格，保留其他配置
- `mona-auth/app/routers/payment_router.py` — 价格读取改为从数据库获取
- `mona-auth/app/admin/index.html` — 新增"价格配置"和"通知管理" Tab

### 前端新增
- `webui/src/components/SubscribeView.tsx` — 订阅引导页
- `webui/src/components/NotificationCenter.tsx` — 消息中心弹窗
- `webui/src/hooks/useNotifications.ts` — 通知状态管理 hook

### 前端修改
- `webui/src/components/AuthPage.tsx` — 新增 `subscribe` 视图
- `webui/src/hooks/useLicense.tsx` — 新增价格配置拉取
- `webui/src/components/Sidebar.tsx` — 新增消息中心入口铃铛
- `src-tauri/src/license.rs` — 新增 `get_pricing` Tauri 命令

### 测试
- `mona-auth/tests/test_config.py` — `/config/pricing` API 测试
- `mona-auth/tests/test_notifications.py` — 通知 API 测试
- `webui/src/hooks/useNotifications.test.ts`（可选）— 前端 hook 单元测试

---

## Task 1: 后端数据模型

**Files:**
- Modify: `mona-auth/app/models.py`

**Goal:** 新增价格配置、应用配置、通知、通知已读四张表。

- [ ] **Step 1: 添加 PricingPlan 模型**

在 `models.py` 末尾追加：

```python
class PricingPlan(Base):
    __tablename__ = "pricing_plans"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    price: Mapped[float] = mapped_column(nullable=False)
    original_price: Mapped[float | None] = mapped_column(nullable=True)
    duration_months: Mapped[int] = mapped_column(nullable=False)
    badge: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sort_order: Mapped[int] = mapped_column(default=0)
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class AppConfig(Base):
    __tablename__ = "app_config"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(128), nullable=False)
    body: Mapped[str] = mapped_column(String(512), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    action_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    published: Mapped[bool] = mapped_column(default=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class NotificationRead(Base):
    __tablename__ = "notification_reads"
    __table_args__ = (UniqueConstraint("user_id", "notification_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    notification_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True
    )
    read_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
```

- [ ] **Step 2: 提交**

```bash
git add mona-auth/app/models.py
git commit -m "feat(billing): add pricing, config and notification models"
```

---

## Task 2: 后端 Schema

**Files:**
- Modify: `mona-auth/app/schemas.py`

**Goal:** 新增价格配置、通知相关 Pydantic schema。

- [ ] **Step 1: 追加 schema 定义**

在 `schemas.py` 末尾追加：

```python
class PricingPlanInfo(BaseModel):
    id: str
    name: str
    price: float
    duration_months: int
    original_price: float | None = None
    badge: str | None = None


class ContactConfig(BaseModel):
    email: str
    wechat: str


class PricingConfigResponse(BaseModel):
    plans: list[PricingPlanInfo]
    contact: ContactConfig
    promotional_banner: str | None = None


class NotificationInfo(BaseModel):
    id: int
    title: str
    body: str
    type: str
    action_url: str | None = None
    image_url: str | None = None
    read: bool = False
    published_at: datetime | None = None
    expires_at: datetime | None = None


class NotificationListResponse(BaseModel):
    notifications: list[NotificationInfo]


class UnreadCountResponse(BaseModel):
    unread_count: int
```

- [ ] **Step 2: 提交**

```bash
git add mona-auth/app/schemas.py
git commit -m "feat(billing): add pricing and notification schemas"
```

---

## Task 3: 后端价格配置 Router

**Files:**
- Create: `mona-auth/app/routers/config_router.py`

**Goal:** 实现公开 API `/config/pricing`，从数据库读取价格与联系方式。

- [ ] **Step 1: 创建 router**

```python
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AppConfig, PricingPlan
from app.schemas import ContactConfig, PricingConfigResponse, PricingPlanInfo

router = APIRouter(prefix="/config", tags=["config"])


def _get_config_value(db: Session, key: str, default: str | None = None) -> str | None:
    row = db.query(AppConfig).filter(AppConfig.key == key).first()
    return row.value if row else default


@router.get("/pricing", response_model=PricingConfigResponse)
def get_pricing_config(db: Session = Depends(get_db)):
    plans = (
        db.query(PricingPlan)
        .filter(PricingPlan.enabled == True)  # noqa: E712
        .order_by(PricingPlan.sort_order.asc())
        .all()
    )

    return PricingConfigResponse(
        plans=[
            PricingPlanInfo(
                id=p.id,
                name=p.name,
                price=float(p.price),
                duration_months=p.duration_months,
                original_price=float(p.original_price) if p.original_price else None,
                badge=p.badge,
            )
            for p in plans
        ],
        contact=ContactConfig(
            email=_get_config_value(db, "contact_email", "support@example.com") or "",
            wechat=_get_config_value(db, "contact_wechat", "") or "",
        ),
        promotional_banner=_get_config_value(db, "promotional_banner"),
    )
```

- [ ] **Step 2: 提交**

```bash
git add mona-auth/app/routers/config_router.py
git commit -m "feat(billing): add /config/pricing endpoint"
```

---

## Task 4: 后端通知 Router

**Files:**
- Create: `mona-auth/app/routers/notification_router.py`

**Goal:** 实现登录用户消息通知 API：列表、未读数、标记已读。

- [ ] **Step 1: 创建 router**

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import Notification, NotificationRead, User
from app.schemas import NotificationListResponse, NotificationInfo, UnreadCountResponse

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    notifications = (
        db.query(Notification)
        .filter(Notification.published == True)  # noqa: E712
        .filter((Notification.expires_at == None) | (Notification.expires_at > now))  # noqa: E711
        .order_by(Notification.published_at.desc().nullslast())
        .all()
    )

    read_ids = {
        row.notification_id
        for row in db.query(NotificationRead)
        .filter(NotificationRead.user_id == user.id)
        .all()
    }

    return NotificationListResponse(
        notifications=[
            NotificationInfo(
                id=n.id,
                title=n.title,
                body=n.body,
                type=n.type,
                action_url=n.action_url,
                image_url=n.image_url,
                read=n.id in read_ids,
                published_at=n.published_at,
                expires_at=n.expires_at,
            )
            for n in notifications
        ]
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_count(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    total = (
        db.query(Notification)
        .filter(Notification.published == True)  # noqa: E712
        .filter((Notification.expires_at == None) | (Notification.expires_at > now))  # noqa: E711
        .count()
    )
    read = db.query(NotificationRead).filter(NotificationRead.user_id == user.id).count()
    return UnreadCountResponse(unread_count=max(0, total - read))


@router.post("/{notification_id}/read")
def mark_read(
    notification_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(NotificationRead)
        .filter(
            NotificationRead.user_id == user.id,
            NotificationRead.notification_id == notification_id,
        )
        .first()
    )
    if not existing:
        db.add(
            NotificationRead(
                user_id=user.id,
                notification_id=notification_id,
            )
        )
        db.commit()
    return {"success": True}
```

- [ ] **Step 2: 提交**

```bash
git add mona-auth/app/routers/notification_router.py
git commit -m "feat(billing): add notification endpoints"
```

---

## Task 5: 注册新路由并清理硬编码价格

**Files:**
- Modify: `mona-auth/app/main.py`
- Modify: `mona-auth/app/config.py`

**Goal:** 注册 config 和 notification 路由；移除 `config.py` 中不再使用的硬编码价格字段。

- [ ] **Step 1: 在 main.py 注册路由**

在现有 import 下新增：

```python
from app.routers.config_router import router as config_router
from app.routers.notification_router import router as notification_router
```

在 `app.include_router(admin_router)` 前添加：

```python
app.include_router(config_router)
app.include_router(notification_router)
```

- [ ] **Step 2: 清理 config.py**

编辑 `mona-auth/app/config.py`，删除：

```python
    price_monthly: float = 29.0
    price_yearly: float = 288.0
```

保留其他所有字段。

- [ ] **Step 3: 提交**

```bash
git add mona-auth/app/main.py mona-auth/app/config.py
git commit -m "feat(billing): register new routers and remove hardcoded prices"
```

---

## Task 6: 支付模块改用数据库价格

**Files:**
- Modify: `mona-auth/app/routers/payment_router.py:32-36`

**Goal:** `_get_price` 改为读取 `pricing_plans` 表。

- [ ] **Step 1: 修改 `_get_price` 函数**

```python
from app.models import PricingPlan

def _get_price(db: Session, duration_months: int) -> float:
    plan = db.query(PricingPlan).filter(PricingPlan.duration_months == duration_months).first()
    if plan:
        return float(plan.price)
    # fallback: find closest monthly price
    monthly = db.query(PricingPlan).filter(PricingPlan.duration_months == 1).first()
    if monthly:
        return float(monthly.price) * duration_months
    return settings.price_monthly * duration_months
```

- [ ] **Step 2: 更新调用点**

`create_payment` 函数中：

```python
amount = _get_price(db, body.duration_months)
```

- [ ] **Step 3: 提交**

```bash
git add mona-auth/app/routers/payment_router.py
git commit -m "feat(billing): read pricing from database in payment router"
```

---

## Task 7: Alembic 数据库迁移

**Files:**
- Create: `mona-auth/alembic/versions/2026_06_13_add_pricing_and_notifications.py`

**Goal:** 生成 pricing_plans、app_config、notifications、notification_reads 表，并插入默认价格数据。

- [ ] **Step 1: 创建迁移文件**

```python
"""add pricing and notifications

Revision ID: 2026_06_13_add_pricing_and_notifications
Revises:
Create Date: 2026-06-13 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "2026_06_13_add_pricing_and_notifications"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pricing_plans",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("price", sa.Numeric(10, 2), nullable=False),
        sa.Column("original_price", sa.Numeric(10, 2), nullable=True),
        sa.Column("duration_months", sa.Integer, nullable=False),
        sa.Column("badge", sa.String(32), nullable=True),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
    )

    op.create_table(
        "app_config",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", sa.String(1024), nullable=True),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
    )

    op.create_table(
        "notifications",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(128), nullable=False),
        sa.Column("body", sa.String(512), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("action_url", sa.String(512), nullable=True),
        sa.Column("image_url", sa.String(512), nullable=True),
        sa.Column("published", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("published_at", sa.DateTime, nullable=True),
        sa.Column("expires_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "notification_reads",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("notification_id", sa.BigInteger, sa.ForeignKey("notifications.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("read_at", sa.DateTime, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "notification_id"),
    )

    # 默认数据
    op.bulk_insert(
        "pricing_plans",
        [
            {
                "id": "monthly",
                "name": "月度订阅",
                "price": 29.0,
                "duration_months": 1,
                "sort_order": 1,
                "enabled": True,
            },
            {
                "id": "yearly",
                "name": "年度订阅",
                "price": 288.0,
                "original_price": 348.0,
                "duration_months": 12,
                "badge": "推荐",
                "sort_order": 2,
                "enabled": True,
            },
        ],
    )

    op.bulk_insert(
        "app_config",
        [
            {"key": "contact_email", "value": "support@example.com"},
            {"key": "contact_wechat", "value": "mona_support"},
            {"key": "promotional_banner", "value": None},
        ],
    )


def downgrade() -> None:
    op.drop_table("notification_reads")
    op.drop_table("notifications")
    op.drop_table("app_config")
    op.drop_table("pricing_plans")
```

> 注意：需要先确认当前最新迁移 revision ID，设置正确的 `down_revision`。运行 `cd mona-auth && alembic history` 查看。

- [ ] **Step 2: 运行迁移**

```bash
cd mona-auth
alembic upgrade head
```

Expected: 成功，无报错。

- [ ] **Step 3: 提交**

```bash
git add mona-auth/alembic/versions/2026_06_13_add_pricing_and_notifications.py
git commit -m "feat(billing): add migration for pricing and notifications"
```

---

## Task 8: 后端 Admin 页面新增 Tab

**Files:**
- Modify: `mona-auth/app/admin/index.html`

**Goal:** 在现有管理后台新增"价格配置"和"通知管理"两个 Tab。

- [ ] **Step 1: 修改顶部 header 增加 Tab 切换**

将 header 区域改为：

```html
<div class="header">
    <h1>Mona 管理后台</h1>
    <div style="display:flex;gap:8px;align-items:center">
        <button onclick="switchTab('users')" id="tab-users" class="tab-btn active">用户</button>
        <button onclick="switchTab('pricing')" id="tab-pricing" class="tab-btn">价格配置</button>
        <button onclick="switchTab('notifications')" id="tab-notifications" class="tab-btn">通知管理</button>
        <button onclick="doLogout()">退出</button>
    </div>
</div>
```

在 style 中添加：

```css
.tab-btn { padding: 6px 14px; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; }
.tab-btn.active { background: #4f46e5; color: #fff; border-color: #4f46e5; }
.tab-section { display: none; }
.tab-section.active { display: block; }
```

- [ ] **Step 2: 将用户列表包裹进 Tab 区域**

在 `app` div 内，将 stats 和 users 包裹：

```html
<div id="section-users" class="tab-section active">
    <div class="stats" id="stats"></div>
    <div class="users"> ... 现有用户列表 ... </div>
</div>

<div id="section-pricing" class="tab-section">
    <div class="users">
        <div class="users-header"><h2>价格配置</h2><button onclick="savePricing()" class="primary">保存</button></div>
        <table id="pricingTable"><thead><tr><th>ID</th><th>名称</th><th>价格</th><th>原价</th><th>时长(月)</th><th>角标</th><th>排序</th><th>启用</th><th>操作</th></tr></thead><tbody></tbody></table>
        <div style="margin-top:16px"><button onclick="addPlanRow()">+ 新增方案</button></div>
        <div class="users-header" style="margin-top:24px"><h2>全局配置</h2></div>
        <div style="background:#fff;padding:16px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)">
            <label>联系邮箱</label><input type="email" id="cfgEmail" style="width:300px">
            <label>微信号</label><input type="text" id="cfgWechat" style="width:300px">
            <label>促销横幅（留空不显示）</label><input type="text" id="cfgBanner" style="width:500px">
        </div>
    </div>
</div>

<div id="section-notifications" class="tab-section">
    <div class="users">
        <div class="users-header"><h2>通知管理</h2><button onclick="openNotifModal()">+ 新建通知</button></div>
        <table id="notifTable"><thead><tr><th>ID</th><th>标题</th><th>类型</th><th>状态</th><th>过期时间</th><th>已读</th><th>操作</th></tr></thead><tbody></tbody></table>
    </div>
</div>
```

- [ ] **Step 3: 添加新建通知弹窗**

在 body 末尾添加：

```html
<div id="notifModal" class="modal-overlay">
    <div class="modal" style="width:500px">
        <h3>新建通知</h3>
        <label>标题</label><input type="text" id="notifTitle">
        <label>正文</label><textarea id="notifBody" rows="3"></textarea>
        <label>类型</label>
        <select id="notifType"><option value="promotion">促销</option><option value="system">系统</option><option value="subscription">订阅</option></select>
        <label>跳转地址（subscribe 或其他 URL）</label><input type="text" id="notifAction">
        <label>过期时间</label><input type="datetime-local" id="notifExpires">
        <div class="modal-btns">
            <button onclick="closeNotifModal()">取消</button>
            <button class="primary" onclick="saveNotif()">保存并发布</button>
        </div>
    </div>
</div>
```

- [ ] **Step 4: 添加 JavaScript 逻辑**

在 script 标签内添加：

```javascript
let currentTab = 'users';

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById('section-' + tab).classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'pricing') loadPricing();
    if (tab === 'notifications') loadNotifications();
}

async function loadPricing() {
    const res = await fetch(`${API}/config/pricing`);
    const data = await res.json();
    document.getElementById('cfgEmail').value = data.contact.email;
    document.getElementById('cfgWechat').value = data.contact.wechat;
    document.getElementById('cfgBanner').value = data.promotional_banner || '';
    const tbody = document.querySelector('#pricingTable tbody');
    tbody.innerHTML = data.plans.map(p => `<tr data-id="${p.id}">
        <td>${p.id}</td>
        <td><input value="${p.name}"></td>
        <td><input type="number" value="${p.price}"></td>
        <td><input type="number" value="${p.original_price || ''}"></td>
        <td><input type="number" value="${p.duration_months}"></td>
        <td><input value="${p.badge || ''}"></td>
        <td><input type="number" value="${p.sort_order}"></td>
        <td><input type="checkbox" ${p.enabled ? 'checked' : ''}></td>
        <td><button onclick="deletePlan('${p.id}')">删除</button></td>
    </tr>`).join('';
}

function addPlanRow() {
    const tbody = document.querySelector('#pricingTable tbody');
    const id = 'plan_' + Date.now();
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    tr.dataset.new = 'true';
    tr.innerHTML = `<td><input value="${id}"></td><td><input></td><td><input type="number"></td><td><input type="number"></td><td><input type="number"></td><td><input></td><td><input type="number" value="0"></td><td><input type="checkbox" checked></td><td><button onclick="this.closest('tr').remove()">删除</button></td>`;
    tbody.appendChild(tr);
}

async function savePricing() {
    const rows = document.querySelectorAll('#pricingTable tbody tr');
    const plans = [];
    rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        plans.push({
            id: inputs[0].value,
            name: inputs[1].value,
            price: parseFloat(inputs[2].value),
            original_price: inputs[3].value ? parseFloat(inputs[3].value) : null,
            duration_months: parseInt(inputs[4].value),
            badge: inputs[5].value || null,
            sort_order: parseInt(inputs[6].value) || 0,
            enabled: inputs[7].checked,
        });
    });
    await fetch(`${API}/admin/pricing`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({
            plans,
            contact: {
                email: document.getElementById('cfgEmail').value,
                wechat: document.getElementById('cfgWechat').value,
            },
            promotional_banner: document.getElementById('cfgBanner').value || null,
        }),
    });
    alert('保存成功');
}

async function deletePlan(id) {
    if (!confirm('确定删除？')) return;
    await fetch(`${API}/admin/pricing/${id}`, { method: 'DELETE', headers: headers() });
    loadPricing();
}

async function loadNotifications() {
    const res = await fetch(`${API}/admin/notifications`, { headers: headers() });
    const data = await res.json();
    const tbody = document.querySelector('#notifTable tbody');
    tbody.innerHTML = data.notifications.map(n => `<tr>
        <td>${n.id}</td><td>${n.title}</td><td>${n.type}</td>
        <td>${n.published ? '已发布' : '未发布'}</td>
        <td>${n.expires_at ? n.expires_at.slice(0,16) : '-'}</td>
        <td>${n.read_count}</td>
        <td class="actions">
            <button onclick="toggleNotif(${n.id}, ${!n.published})">${n.published ? '取消发布' : '发布'}</button>
            <button class="btn-danger" onclick="deleteNotif(${n.id})">删除</button>
        </td>
    </tr>`).join('';
}

function openNotifModal() { document.getElementById('notifModal').style.display = 'flex'; }
function closeNotifModal() { document.getElementById('notifModal').style.display = 'none'; }

async function saveNotif() {
    const body = {
        title: document.getElementById('notifTitle').value,
        body: document.getElementById('notifBody').value,
        type: document.getElementById('notifType').value,
        action_url: document.getElementById('notifAction').value || null,
        expires_at: document.getElementById('notifExpires').value ? new Date(document.getElementById('notifExpires').value).toISOString() : null,
    };
    await fetch(`${API}/admin/notifications`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    closeNotifModal();
    loadNotifications();
}

async function toggleNotif(id, publish) {
    await fetch(`${API}/admin/notifications/${id}/${publish ? 'publish' : 'unpublish'}`, { method: 'POST', headers: headers() });
    loadNotifications();
}

async function deleteNotif(id) {
    if (!confirm('确定删除？')) return;
    await fetch(`${API}/admin/notifications/${id}`, { method: 'DELETE', headers: headers() });
    loadNotifications();
}
```

- [ ] **Step 5: 添加 Admin 后台管理 API**

在 `mona-auth/app/routers/admin_router.py` 追加：

```python
from fastapi import Body
from app.models import AppConfig, Notification, PricingPlan
from app.schemas import PricingPlanInfo

@router.get("/pricing")
def get_pricing_admin(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    plans = db.query(PricingPlan).order_by(PricingPlan.sort_order.asc()).all()
    contact_email = db.query(AppConfig).filter(AppConfig.key == "contact_email").first()
    contact_wechat = db.query(AppConfig).filter(AppConfig.key == "contact_wechat").first()
    banner = db.query(AppConfig).filter(AppConfig.key == "promotional_banner").first()
    return {
        "plans": plans,
        "contact": {
            "email": contact_email.value if contact_email else "",
            "wechat": contact_wechat.value if contact_wechat else "",
        },
        "promotional_banner": banner.value if banner else None,
    }


@router.put("/pricing")
def update_pricing(
    body: dict,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    # 全量替换方案
    db.query(PricingPlan).delete()
    for p in body.get("plans", []):
        db.add(PricingPlan(
            id=p["id"],
            name=p["name"],
            price=p["price"],
            original_price=p.get("original_price"),
            duration_months=p["duration_months"],
            badge=p.get("badge"),
            sort_order=p.get("sort_order", 0),
            enabled=p.get("enabled", True),
        ))
    for cfg in body.get("contact", {}):
        key = "contact_email" if cfg == "email" else "contact_wechat"
        row = db.query(AppConfig).filter(AppConfig.key == key).first()
        if row:
            row.value = body["contact"][cfg]
        else:
            db.add(AppConfig(key=key, value=body["contact"][cfg]))
    banner_row = db.query(AppConfig).filter(AppConfig.key == "promotional_banner").first()
    banner_value = body.get("promotional_banner")
    if banner_row:
        banner_row.value = banner_value
    else:
        db.add(AppConfig(key="promotional_banner", value=banner_value))
    db.commit()
    return {"message": "Pricing config updated"}


@router.delete("/pricing/{plan_id}")
def delete_pricing_plan(
    plan_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    db.query(PricingPlan).filter(PricingPlan.id == plan_id).delete()
    db.commit()
    return {"message": "Plan deleted"}


@router.get("/notifications")
def list_admin_notifications(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    notifications = db.query(Notification).order_by(Notification.created_at.desc()).all()
    return {
        "notifications": [
            {
                "id": n.id,
                "title": n.title,
                "type": n.type,
                "published": n.published,
                "expires_at": n.expires_at.isoformat() if n.expires_at else None,
                "read_count": db.query(NotificationRead).filter(NotificationRead.notification_id == n.id).count(),
            }
            for n in notifications
        ]
    }


@router.post("/notifications")
def create_notification(
    body: dict,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    n = Notification(
        title=body["title"],
        body=body["body"],
        type=body["type"],
        action_url=body.get("action_url"),
        expires_at=body.get("expires_at"),
        published=True,
        published_at=datetime.now(timezone.utc),
    )
    db.add(n)
    db.commit()
    return {"id": n.id}


@router.post("/notifications/{notification_id}/{action}")
def toggle_notification(
    notification_id: int,
    action: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    n = db.query(Notification).filter(Notification.id == notification_id).first()
    if not n:
        raise AuthError("not_found", "Notification not found", status_code=404)
    if action == "publish":
        n.published = True
        n.published_at = datetime.now(timezone.utc)
    elif action == "unpublish":
        n.published = False
    db.commit()
    return {"message": "Updated"}


@router.delete("/notifications/{notification_id}")
def delete_notification(
    notification_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    db.query(Notification).filter(Notification.id == notification_id).delete()
    db.commit()
    return {"message": "Deleted"}
```

- [ ] **Step 6: 提交**

```bash
git add mona-auth/app/admin/index.html mona-auth/app/routers/admin_router.py
git commit -m "feat(billing): add pricing and notification admin tabs"
```

---

## Task 9: 后端 API 测试

**Files:**
- Create: `mona-auth/tests/test_config.py`
- Create: `mona-auth/tests/test_notifications.py`

**Goal:** 为新增公开 API 和通知 API 写测试。

- [ ] **Step 1: 测试 /config/pricing**

```python
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_get_pricing_config(client, db):
    res = client.get("/config/pricing")
    assert res.status_code == 200
    data = res.json()
    assert "plans" in data
    assert "contact" in data
    assert data["contact"]["email"]
```

- [ ] **Step 2: 测试通知 API**

```python
def test_notifications_require_auth(client):
    res = client.get("/notifications")
    assert res.status_code == 401


def test_list_notifications(client, admin_user, db):
    from app.models import Notification
    n = Notification(title="Test", body="Body", type="system", published=True)
    db.add(n)
    db.commit()
    token = client.post("/auth/login", json={"email": admin_user.email, "password": "admin123"}).json()["access_token"]
    res = client.get("/notifications", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    assert len(res.json()["notifications"]) == 1
```

> 实际测试需要配合项目现有 fixtures（如 `client`, `admin_user`）。请查看 `mona-auth/tests/conftest.py` 调整。

- [ ] **Step 3: 运行测试**

```bash
cd mona-auth
pytest tests/test_config.py tests/test_notifications.py -v
```

Expected: 通过（若 fixtures 不存在，先创建或调整）。

- [ ] **Step 4: 提交**

```bash
git add mona-auth/tests/test_config.py mona-auth/tests/test_notifications.py
git commit -m "test(billing): add pricing and notification api tests"
```

---

## Task 10: Tauri 暴露 get_pricing 命令

**Files:**
- Modify: `src-tauri/src/license.rs`

**Goal:** 新增 Tauri 命令 `get_pricing`，代理调用服务端 `/config/pricing`。

- [ ] **Step 1: 在 license.rs 新增命令**

在文件顶部常量区后添加：

```rust
#[tauri::command]
pub async fn get_pricing() -> Result<serde_json::Value, String> {
    let client = build_client()?;
    let resp = client
        .get(format!("{}/config/pricing", AUTH_SERVER_URL))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;
    Ok(body)
}
```

- [ ] **Step 2: 在 lib.rs 注册命令**

在 `src-tauri/src/lib.rs` 的 `generate_handler!` 列表中添加 `license::get_pricing`。具体位置需查看当前命令列表。

示例：

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    license::get_pricing,
])
```

- [ ] **Step 3: 编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/license.rs src-tauri/src/lib.rs
git commit -m "feat(billing): expose get_pricing tauri command"
```

---

## Task 11: 前端 useLicense 增加价格配置

**Files:**
- Modify: `webui/src/hooks/useLicense.tsx`

**Goal:** 在 LicenseContext 中拉取并暴露价格配置。

- [ ] **Step 1: 扩展 LicenseContextValue 类型**

```typescript
interface PricingPlan {
  id: string;
  name: string;
  price: number;
  durationMonths: number;
  originalPrice?: number;
  badge?: string;
}

interface PricingConfig {
  plans: PricingPlan[];
  contact: { email: string; wechat: string };
  promotionalBanner: string | null;
}
```

在 `LicenseContextValue` 中新增：

```typescript
pricingConfig: PricingConfig | null;
fetchPricing: () => Promise<void>;
```

- [ ] **Step 2: 实现 fetchPricing**

```typescript
const [pricingConfig, setPricingConfig] = useState<PricingConfig | null>(null);

const fetchPricing = useCallback(async () => {
  if (!isTauri()) return;
  try {
    const result = await invokeTauri<PricingConfig>("get_pricing");
    setPricingConfig(result);
  } catch {
    setPricingConfig(null);
  }
}, [invokeTauri]);
```

- [ ] **Step 3: 在 Provider value 中暴露并初始化拉取**

```typescript
useEffect(() => {
  checkLicense();
  fetchPricing();
}, [checkLicense, fetchPricing]);
```

Provider value 新增：

```typescript
pricingConfig,
fetchPricing,
```

- [ ] **Step 4: 提交**

```bash
git add webui/src/hooks/useLicense.tsx
git commit -m "feat(billing): add pricing config to useLicense hook"
```

---

## Task 12: 前端 SubscribeView 组件

**Files:**
- Create: `webui/src/components/SubscribeView.tsx`

**Goal:** 实现订阅引导页。

- [ ] **Step 1: 实现组件**

```tsx
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLicense } from "@/hooks/useLicense";

interface SubscribeViewProps {
  userEmail: string;
  onBackToLogin: () => void;
}

export function SubscribeView({ userEmail, onBackToLogin }: SubscribeViewProps) {
  const { pricingConfig, refreshLicense, licenseActive } = useLicense();
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [machineId, setMachineId] = useState("");

  useEffect(() => {
    if (!pricingConfig) return;
    const defaultPlan = pricingConfig.plans.find((p) => p.badge) ?? pricingConfig.plans[0];
    if (defaultPlan) setSelectedPlanId(defaultPlan.id);
  }, [pricingConfig]);

  useEffect(() => {
    async function loadMachineId() {
      if (window.__TAURI_INTERNALS__) {
        const { invoke } = await import("@tauri-apps/api/core");
        const id = await invoke<string>("get_machine_id");
        setMachineId(id);
      }
    }
    loadMachineId();
  }, []);

  const selectedPlan = useMemo(
    () => pricingConfig?.plans.find((p) => p.id === selectedPlanId),
    [pricingConfig, selectedPlanId]
  );

  const contact = pricingConfig?.contact ?? { email: "", wechat: "" };

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const buildMailto = () => {
    const subject = encodeURIComponent(`Mona Pro 订阅申请 - ${userEmail}`);
    const body = encodeURIComponent(
      `你好，我已购买 Mona Pro 订阅，请开通。\n\n注册邮箱：${userEmail}\n机器 ID：${machineId}\n购买方案：${selectedPlan?.name ?? ""}\n\n谢谢！`
    );
    return `mailto:${contact.email}?subject=${subject}&body=${body}`;
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshLicense();
    setRefreshing(false);
  };

  if (!pricingConfig) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-sm text-muted-foreground">加载中...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col gap-4">
        {pricingConfig.promotionalBanner && (
          <div className="rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-center text-sm font-medium text-white">
            {pricingConfig.promotionalBanner}
          </div>
        )}

        <div className="text-center">
          <p className="text-lg font-semibold">升级至 Mona Pro</p>
          <p className="text-sm text-muted-foreground">选择订阅方案并联系作者开通</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {pricingConfig.plans.map((plan) => (
            <button
              key={plan.id}
              onClick={() => setSelectedPlanId(plan.id)}
              className={`relative flex flex-col gap-1 rounded-xl border p-4 text-left transition-colors ${
                selectedPlanId === plan.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              {plan.badge && (
                <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
                  {plan.badge}
                </span>
              )}
              <span className="text-sm font-medium">{plan.name}</span>
              <div className="flex items-baseline gap-1">
                <span className="text-xl font-bold">¥{plan.price}</span>
                <span className="text-xs text-muted-foreground">/{plan.durationMonths}个月</span>
              </div>
              {plan.originalPrice ? (
                <span className="text-xs text-muted-foreground line-through">
                  ¥{plan.originalPrice}
                </span>
              ) : null}
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={`h-3.5 w-3.5 rounded-full border ${
                    selectedPlanId === plan.id ? "border-primary bg-primary" : "border-muted-foreground"
                  }`}
                />
                选择
              </div>
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <p className="mb-1 font-medium">购买步骤</p>
          <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground">
            <li>复制联系方式并完成付款</li>
            <li>告知你的注册邮箱</li>
            <li>开通后刷新状态或重新登录</li>
          </ol>
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span>📧</span>
              <span className="text-muted-foreground">{contact.email}</span>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => handleCopy(contact.email, "email")}>
                {copied === "email" ? "已复制" : "复制"}
              </Button>
            </div>
          </div>
          <Button variant="outline" className="w-full" asChild>
            <a href={buildMailto()}>发送申请邮件</a>
          </Button>
          <div className="flex items-center justify-between pt-2">
            <div className="flex items-center gap-2">
              <span>💬</span>
              <span className="text-muted-foreground">{contact.wechat}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => handleCopy(contact.wechat, "wechat")}>
              {copied === "wechat" ? "已复制" : "复制"}
            </Button>
          </div>
        </div>

        <Button onClick={handleRefresh} disabled={refreshing} className="w-full">
          {refreshing ? "刷新中..." : "刷新订阅状态"}
        </Button>

        {licenseActive && (
          <p className="text-center text-sm text-green-600">订阅已生效，请返回主界面。</p>
        )}

        <button
          type="button"
          onClick={onBackToLogin}
          className="text-center text-xs text-muted-foreground hover:underline"
        >
          ← 返回登录
        </button>
      </div>
    </div>
  );
}
```

> 注意：`window.__TAURI_INTERNALS__` 检测方式请根据项目实际 Tauri 版本调整。也可复用 `isTauri()` from `@/lib/tauri`。

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/SubscribeView.tsx
git commit -m "feat(billing): add SubscribeView component"
```

---

## Task 13: AuthPage 集成订阅视图

**Files:**
- Modify: `webui/src/components/AuthPage.tsx`

**Goal:** 在登录/注册页新增"购买订阅"入口，并在订阅过期时显示 SubscribeView。

- [ ] **Step 1: 扩展 AuthView 类型并导入组件**

```typescript
type AuthView = "login" | "register" | "forgot" | "reset" | "subscribe";
```

```typescript
import { SubscribeView } from "./SubscribeView";
```

- [ ] **Step 2: 在登录/注册底部添加购买入口**

在登录表单底部添加：

```tsx
<div className="flex justify-between text-xs text-muted-foreground">
  <button type="button" className="hover:underline" onClick={() => { setView("forgot"); setError(""); setSuccess(""); }}>
    Forgot password?
  </button>
  <div className="flex gap-3">
    <button type="button" className="hover:underline" onClick={() => { setView("subscribe"); setError(""); setSuccess(""); }}>
      购买订阅
    </button>
    <button type="button" className="hover:underline" onClick={() => { setView("register"); setError(""); setSuccess(""); }}>
      Create account
    </button>
  </div>
</div>
```

注册表单底部同样添加"购买订阅"链接（放在"Already have an account"旁边）。

- [ ] **Step 3: 在过期提示后接入 SubscribeView**

将现有 `licenseInfo?.status === "expired"` 提示替换或补充为：

```tsx
{licenseInfo?.status === "expired" && loggedIn && (
  <div className="rounded-lg border border-border bg-muted/50 p-3 text-center text-sm text-muted-foreground">
    订阅已于 {licenseInfo.expires_at} 过期。
    <button
      type="button"
      className="ml-1 text-primary hover:underline"
      onClick={() => setView("subscribe")}
    >
      立即续费
    </button>
  </div>
)}
```

在渲染区添加 subscribe 视图分支：

```tsx
{view === "subscribe" && (
  <SubscribeView
    userEmail={licenseInfo?.email || email}
    onBackToLogin={() => setView("login")}
  />
)}
```

- [ ] **Step 4: 提交**

```bash
git add webui/src/components/AuthPage.tsx
git commit -m "feat(billing): integrate subscribe view into AuthPage"
```

---

## Task 14: 前端 useNotifications Hook

**Files:**
- Create: `webui/src/hooks/useNotifications.ts`

**Goal:** 管理通知拉取、未读数和已读状态。

- [ ] **Step 1: 实现 hook**

```typescript
import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";

export interface AppNotification {
  id: number;
  title: string;
  body: string;
  type: string;
  actionUrl?: string;
  imageUrl?: string;
  read: boolean;
  publishedAt?: string;
  expiresAt?: string;
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const invokeTauri = useCallback(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }, []);

  const fetchNotifications = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    try {
      const token = await invokeTauri<string | null>("load_auth_token");
      if (!token) {
        setNotifications([]);
        setUnreadCount(0);
        return;
      }
      const result = await invokeTauri<{ notifications: AppNotification[] }>("auth_request", {
        method: "GET",
        path: "/notifications",
        token,
      });
      setNotifications(result.notifications ?? []);
    } catch {
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }, [invokeTauri]);

  const fetchUnreadCount = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const token = await invokeTauri<string | null>("load_auth_token");
      if (!token) {
        setUnreadCount(0);
        return;
      }
      const result = await invokeTauri<{ unread_count: number }>("auth_request", {
        method: "GET",
        path: "/notifications/unread-count",
        token,
      });
      setUnreadCount(result.unread_count ?? 0);
    } catch {
      setUnreadCount(0);
    }
  }, [invokeTauri]);

  const markAsRead = useCallback(async (id: number) => {
    if (!isTauri()) return;
    const token = await invokeTauri<string | null>("load_auth_token");
    if (!token) return;
    await invokeTauri("auth_request", {
      method: "POST",
      path: `/notifications/${id}/read`,
      token,
    });
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    setUnreadCount((c) => Math.max(0, c - 1));
  }, [invokeTauri]);

  const markAllAsRead = useCallback(async () => {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    await Promise.all(unreadIds.map((id) => markAsRead(id)));
  }, [notifications, markAsRead]);

  useEffect(() => {
    fetchNotifications();
    fetchUnreadCount();
  }, [fetchNotifications, fetchUnreadCount]);

  return {
    notifications,
    unreadCount,
    loading,
    fetchNotifications,
    fetchUnreadCount,
    markAsRead,
    markAllAsRead,
  };
}
```

> 当前 `license.rs` 没有通用 HTTP 代理命令。若不想新增，可在 `license.rs` 中新增 `list_notifications`、`get_unread_notification_count`、`mark_notification_read` 三个命令，由 Rust 直接调用服务端并处理 token。本计划为简单起见假设新增 `auth_request` 命令或直接在 Rust 层封装通知命令。推荐在 Task 15 中改为 Rust 直接封装。

- [ ] **Step 2: 提交**

```bash
git add webui/src/hooks/useNotifications.ts
git commit -m "feat(billing): add useNotifications hook"
```

---

## Task 15: Tauri 封装通知命令（推荐替代 auth_request）

**Files:**
- Modify: `src-tauri/src/license.rs`

**Goal:** 在 Rust 层直接实现通知相关 Tauri 命令，避免前端直接处理 token。

- [ ] **Step 1: 新增命令**

```rust
#[tauri::command]
pub async fn list_notifications() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let client = build_client()?;
    let resp = client
        .get(format!("{}/notifications", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn get_unread_notification_count() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let client = build_client()?;
    let resp = client
        .get(format!("{}/notifications/unread-count", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn mark_notification_read(notification_id: i64) -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let client = build_client()?;
    let resp = client
        .post(format!("{}/notifications/{}/read", AUTH_SERVER_URL, notification_id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    Ok(serde_json::json!({ "success": true }))
}
```

- [ ] **Step 2: 在 lib.rs 注册命令**

```rust
.invoke_handler(tauri::generate_handler![
    // ...
    license::list_notifications,
    license::get_unread_notification_count,
    license::mark_notification_read,
])
```

- [ ] **Step 3: 更新 useNotifications 调用**

将 hook 中的 `auth_request` 调用替换为：

```typescript
const result = await invokeTauri<{ notifications: AppNotification[] }>("list_notifications");
const result = await invokeTauri<{ unread_count: number }>("get_unread_notification_count");
await invokeTauri("mark_notification_read", { notificationId: id });
```

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/license.rs src-tauri/src/lib.rs webui/src/hooks/useNotifications.ts
git commit -m "feat(billing): add tauri commands for notifications"
```

---

## Task 16: 前端 NotificationCenter 组件

**Files:**
- Create: `webui/src/components/NotificationCenter.tsx`

**Goal:** 实现消息中心弹窗。

- [ ] **Step 1: 实现组件**

```tsx
import { Bell, Check, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useNotifications } from "@/hooks/useNotifications";

interface NotificationCenterProps {
  onOpenSubscribe?: () => void;
}

export function NotificationCenter({ onOpenSubscribe }: NotificationCenterProps) {
  const {
    notifications,
    unreadCount,
    loading,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
  } = useNotifications();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  const handleAction = (url?: string) => {
    if (!url) return;
    if (url === "subscribe") {
      onOpenSubscribe?.();
    } else {
      window.open(url, "_blank");
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">消息中心</span>
          {notifications.some((n) => !n.read) && (
            <Button variant="ghost" size="sm" onClick={markAllAsRead}>
              全部已读
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">加载中...</div>
          ) : notifications.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">暂无消息</div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`border-b px-3 py-2 text-sm last:border-b-0 ${
                  n.read ? "bg-background" : "bg-muted/40"
                }`}
              >
                <div className="flex items-start gap-2">
                  {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                  <div className="flex-1">
                    <p className="font-medium">{n.title}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{n.body}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      {n.actionUrl && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-1 text-xs"
                          onClick={() => {
                            markAsRead(n.id);
                            handleAction(n.actionUrl);
                          }}
                        >
                          查看详情 <ExternalLink className="h-3 w-3" />
                        </Button>
                      )}
                      {!n.read && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-1 text-xs"
                          onClick={() => markAsRead(n.id)}
                        >
                          <Check className="h-3 w-3" /> 已读
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

> 若项目未使用 Popover，可改用 Sheet 或 Dialog。需确认组件库可用性。

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/NotificationCenter.tsx
git commit -m "feat(billing): add NotificationCenter component"
```

---

## Task 17: Sidebar 消息入口集成

**Files:**
- Modify: `webui/src/components/Sidebar.tsx`

**Goal:** 在侧边栏底部用户区域旁增加消息铃铛入口。

- [ ] **Step 1: 导入组件并添加铃铛**

```typescript
import { Bell } from "lucide-react";
import { NotificationCenter } from "./NotificationCenter";
```

在底部用户区域之前（或内部）添加：

```tsx
<div className="flex items-center gap-1 px-2.5 py-2">
  <NotificationCenter onOpenSubscribe={props.onOpenLogin} />
</div>
<Separator className="bg-sidebar-border/50" />
```

或直接在用户区域同一行右侧添加铃铛按钮。

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/Sidebar.tsx
git commit -m "feat(billing): add notification bell to sidebar"
```

---

## Task 18: 前端类型与 Lint 检查

**Files:**
- 无新增文件

**Goal:** 确保 TypeScript 类型正确，lint 无新增错误。

- [ ] **Step 1: 类型检查**

```bash
cd webui
npx tsc --noEmit
```

Expected: 无新增错误。

- [ ] **Step 2: Lint 检查**

```bash
cd webui
npm run lint
```

Expected: 无新增错误。

- [ ] **Step 3: Rust 编译检查**

```bash
cd src-tauri && cargo check
```

Expected: 无新增错误。

- [ ] **Step 4: 提交修复**

```bash
git add .
git commit -m "chore(billing): fix type and lint errors"
```

---

## Task 19: 端到端手动 QA

**Files:**
- 无新增文件

**Goal:** 验证完整流程可跑通。

- [ ] **Step 1: 启动后端服务**

```bash
cd mona-auth
uvicorn app.main:app --reload --port 8901
```

- [ ] **Step 2: 验证 /config/pricing**

```bash
curl http://127.0.0.1:8901/config/pricing
```

Expected: 返回 plans、contact、promotional_banner。

- [ ] **Step 3: 验证后台管理页面**

打开 `http://127.0.0.1:8901/admin`，登录管理员账号，确认：
- 可切换"价格配置" Tab
- 可修改价格、联系方式、促销横幅
- 可切换"通知管理" Tab
- 可新建/发布/删除通知

- [ ] **Step 4: 验证客户端订阅引导**

启动 Mona 客户端，进入登录页：
- 底部可见"购买订阅"入口
- 点击进入订阅引导页
- 价格从服务端正确显示
- 点击"发送申请邮件"可打开邮件客户端并预填内容
- 点击"刷新订阅状态"调用 license 检查

- [ ] **Step 5: 验证消息中心**

登录账号后：
- 侧边栏出现铃铛图标
- 服务端发布通知后铃铛显示未读数
- 点击铃铛弹出消息列表
- 点击"查看详情"跳转订阅页（若 action_url 为 subscribe）
- 点击"已读"后未读数减少

---

## 手动 QA 清单

- [ ] `/config/pricing` 返回正确价格和联系方式
- [ ] 管理员可修改价格配置并立即生效
- [ ] 管理员可发布/取消发布/删除通知
- [ ] 登录页底部有"购买订阅"入口
- [ ] 订阅过期用户看到"立即续费"链接
- [ ] SubscribeView 显示价格方案卡片、促销横幅、联系方式
- [ ] 选择方案后发送邮件预填方案名称
- [ ] 复制邮箱/微信有"已复制"反馈
- [ ] 刷新订阅状态按钮工作正常
- [ ] 消息中心铃铛显示未读数
- [ ] 消息中心列表展示通知标题/正文/时间
- [ ] 促销通知点击"查看详情"跳转订阅页
- [ ] 标记已读后未读数更新

---

## 计划自查

### Spec 覆盖检查
- [x] 价格从服务端获取：Task 3, 10, 11
- [x] 后台管理价格配置：Task 8
- [x] 消息通知功能：Task 4, 14, 15, 16, 17
- [x] 后台管理通知发布：Task 8
- [x] 订阅引导页 UI：Task 12, 13
- [x] 应用内消息中心：Task 16, 17
- [x] 不集成在线支付：明确不做

### Placeholder 检查
- [x] 无 TBD/TODO
- [x] 每个任务包含具体文件路径
- [x] 代码片段完整

### 类型一致性检查
- `PricingConfigResponse` / `PricingConfig` 前后端字段一致（snake_case 来自后端，前端 interface 使用 camelCase，Tauri JSON 自动转换）
- `NotificationInfo` 前后端字段一致
- Tauri 命令 `get_pricing` / `list_notifications` 等在 `lib.rs` 中注册

---

## 执行方式选择

Plan complete and saved to `docs/2026-06-13-manual-subscribe-purchase-implementation-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
