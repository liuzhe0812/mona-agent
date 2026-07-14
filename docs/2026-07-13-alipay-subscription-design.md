# Mona 支付宝线上订阅方案设计

## 1. 背景与目标

### 1.1 现状

- 已有用户系统、License JWT 签发/验证、设备绑定、订阅状态管理（见 [2026-05-28-membership-system-design.md](./2026-05-28-membership-system-design.md)）。
- 当前支付走第三方聚合支付 xhp（见 [payment_router.py](../mona-auth/app/routers/payment_router.py)），仅支持一次性付款，**不支持自动续费**。
- 作为过渡，已有手动订阅流程（见 [2026-06-13-manual-subscribe-purchase-design.md](./2026-06-13-manual-subscribe-purchase-design.md)）。

### 1.2 目标

用户已取得个体工商户营业执照并申请支付宝商家资质，本方案目标：

1. 接入支付宝官方支付，替代 xhp 第三方支付，降低费率、提升可靠性。
2. 支持**支付宝周期扣款**（自动续费），提升续费率。
3. 保留一次性付费作为兜底，覆盖不支持自动续费的场景（如终身版）。
4. 复用现有 License / 设备绑定 / 订阅状态机制，不改动客户端拦截逻辑。

### 1.3 功能边界

| 场景 | 支付方式 | 自动续费 |
|------|----------|----------|
| 月度会员首充 | 支付宝周期扣款（签约+首期扣款） | 是 |
| 年度会员首充 | 支付宝周期扣款（签约+首期扣款） | 是 |
| 终身版购买 | 支付宝电脑网站支付 | 否 |
| 续费扣款（自动） | 支付宝周期扣款（当期扣款） | - |
| 续费扣款（手动，扣款失败兜底） | 支付宝电脑网站支付 | 否 |

### 1.4 核心约束

- 个体工商户资质，费率 0.6%。
- 客户端为 Tauri 桌面应用，支付通过浏览器拉起支付宝或展示二维码。
- 后端复用现有 FastAPI + MariaDB 架构。
- 不修改 Mona 客户端的 License 验证逻辑，只在服务端替换支付通道。
- 必须合规：扣款前通知、退订入口、规则展示。

---

## 2. 支付宝产品选择

| 产品 | 用途 | 接入方式 |
|------|------|----------|
| **周期扣款**（`alipay.user.agreement.facetopay.sign.and.pay` + `alipay.user.agreement.execution.plan`） | 自动续费订阅 | 服务端 SDK |
| **电脑网站支付**（`alipay.trade.page.pay`） | 一次性付费、续费失败兜底 | 服务端生成跳转 URL |
| **统一转账**（`alipay.fund.trans.uni.transfer`） | 退款（可选） | 服务端 SDK |

### 2.1 周期扣款流程概述

1. **签约并支付**：用户首次订阅时，调用 `sign.and.pay` 接口，返回支付宝签约 URL，用户在支付宝 App 中确认签约并完成首期扣款。
2. **异步通知签约结果**：支付宝通过 `cycle_sign` 通知后端签约成功，返回 `agreement_no`。
3. **异步通知扣款结果**：首期扣款和后续扣款均通过 `cycle_charge` 通知后端。
4. **周期扣款**：后端定时任务扫描到期订阅，调用 `execution.plan` 接口发起当期扣款。
5. **解约**：用户在 Mona 内或支付宝内解约，后端收到 `cycle_sign` 解约通知后更新订阅状态。

---

## 3. 数据模型扩展

在 [models.py](../mona-auth/app/models.py) 基础上扩展。

### 3.1 新增表

#### `payment_agreements`（周期扣款协议）

```python
class AgreementStatus(str, enum.Enum):
    ACTIVE = "active"        # 协议有效，可扣款
    CANCELLED = "cancelled"  # 用户解约
    EXPIRED = "expired"      # 协议过期

class PaymentAgreement(Base):
    __tablename__ = "payment_agreements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agreement_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    alipay_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[AgreementStatus] = mapped_column(
        Enum(AgreementStatus), nullable=False, default=AgreementStatus.ACTIVE
    )
    external_sign_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    signed_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)

    user: Mapped["User"] = relationship(back_populates="agreements")
```

#### `subscription_renewals`（续费扣款记录）

```python
class RenewalStatus(str, enum.Enum):
    PENDING = "pending"
    SUCCESS = "success"
    FAILED = "failed"
    RETRYING = "retrying"

class SubscriptionRenewal(Base):
    __tablename__ = "subscription_renewals"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    subscription_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("subscriptions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agreement_no: Mapped[str] = mapped_column(String(64), nullable=False)
    out_trade_no: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    alipay_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    amount: Mapped[float] = mapped_column(nullable=False)
    period_days: Mapped[int] = mapped_column(nullable=False)
    status: Mapped[RenewalStatus] = mapped_column(
        Enum(RenewalStatus), nullable=False, default=RenewalStatus.PENDING
    )
    retry_count: Mapped[int] = mapped_column(default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
```

### 3.2 扩展现有表

#### `Subscription` 新增字段

```python
class Subscription(Base):
    # ... 现有字段 ...
    plan_code: Mapped[str | None] = mapped_column(String(32), nullable=True)  # monthly / yearly / lifetime
    auto_renew: Mapped[bool] = mapped_column(default=False)
    agreement_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("payment_agreements.id", ondelete="SET NULL"), nullable=True
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    agreement: Mapped["PaymentAgreement | None"] = relationship()
    renewals: Mapped[list["SubscriptionRenewal"]] = relationship(
        back_populates="subscription", cascade="all, delete-orphan"
    )
```

#### `Payment` 新增字段

```python
class Payment(Base):
    # ... 现有字段 ...
    payment_channel: Mapped[str] = mapped_column(String(16), default="alipay")  # alipay / xhp
    payment_type: Mapped[str] = mapped_column(String(32), default="page")  # page / periodic_sign / periodic_deduct
    alipay_trade_no: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    agreement_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
```

### 3.3 数据库迁移

新增 Alembic 迁移文件 `alembic/versions/2026_07_13_add_alipay_subscription.py`，包含：

1. 创建 `payment_agreements` 表。
2. 创建 `subscription_renewals` 表。
3. 为 `subscriptions` 表新增 `plan_code`、`auto_renew`、`agreement_id`、`cancelled_at` 字段。
4. 为 `payments` 表新增 `payment_channel`、`payment_type`、`alipay_trade_no`、`agreement_no` 字段。

---

## 4. 套餐配置

### 4.1 预置套餐

在 [init_db.py](../mona-auth/scripts/init_db.py) 中预置：

| id | name | price | original_price | duration_months | period_days | badge | auto_renewable |
|----|------|-------|----------------|-----------------|-------------|-------|----------------|
| monthly | 月度会员 | 29.00 | null | 1 | 30 | null | true |
| yearly | 年度会员 | 288.00 | 348.00 | 12 | 365 | 推荐 | true |
| lifetime | 终身版 | 888.00 | null | null | null | 限时 | false |

> `duration_months` 用于兼容现有 `_activate_subscription` 逻辑；`period_days` 用于周期扣款的到期计算。

### 4.2 PricingPlan 模型扩展

```python
class PricingPlan(Base):
    # ... 现有字段 ...
    period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    auto_renewable: Mapped[bool] = mapped_column(default=True)
```

---

## 5. API 设计

### 5.1 配置 API（已存在，扩展返回值）

```
GET /config/pricing
```

响应新增字段：

```json
{
  "plans": [
    {
      "id": "monthly",
      "name": "月度会员",
      "price": 29.0,
      "original_price": null,
      "duration_months": 1,
      "period_days": 30,
      "auto_renewable": true,
      "badge": null
    },
    {
      "id": "yearly",
      "name": "年度会员",
      "price": 288.0,
      "original_price": 348.0,
      "duration_months": 12,
      "period_days": 365,
      "auto_renewable": true,
      "badge": "推荐"
    },
    {
      "id": "lifetime",
      "name": "终身版",
      "price": 888.0,
      "original_price": null,
      "duration_months": null,
      "period_days": null,
      "auto_renewable": false,
      "badge": "限时"
    }
  ],
  "contact": { "email": "...", "wechat": "..." },
  "promotional_banner": null
}
```

### 5.2 创建订阅（首充）

```
POST /payment/subscribe
Authorization: Bearer <token>
Body:
{
  "plan_code": "yearly",
  "payment_method": "alipay_periodic",  // 或 alipay_page（一次性）
  "client_type": "desktop"
}
```

**处理逻辑**：

1. 校验用户当前无活跃订阅。
2. 查询套餐价格。
3. 创建 `Payment` 记录（`payment_type=periodic_sign` 或 `page`）。
4. **若 `alipay_periodic`**：
   - 生成 `external_sign_no`。
   - 调用支付宝 `alipay.user.agreement.facetopay.sign.and.pay` 接口。
   - 返回签约 URL。
5. **若 `alipay_page`**：
   - 调用支付宝 `alipay.trade.page.pay` 接口。
   - 返回支付 URL。

响应：

```json
{
  "order_id": 123,
  "trade_order_id": "mona_1_abc123",
  "payment_url": "https://...",
  "payment_method": "alipay_periodic",
  "expires_at": "2026-07-13T15:30:00Z"
}
```

### 5.3 查询订单状态（轮询）

```
GET /payment/orders/{order_id}
Authorization: Bearer <token>
```

响应：

```json
{
  "order_id": 123,
  "status": "paid",  // pending / paid / failed
  "subscription": {
    "plan_code": "yearly",
    "status": "active",
    "current_period_end": "2027-07-13T00:00:00Z",
    "auto_renew": true
  }
}
```

### 5.4 查询当前订阅

```
GET /payment/subscription
Authorization: Bearer <token>
```

响应扩展：

```json
{
  "status": "active",
  "plan_code": "yearly",
  "current_period_end": "2027-07-13T00:00:00Z",
  "auto_renew": true,
  "agreement_status": "active",
  "cancelled_at": null
}
```

### 5.5 取消自动续费

```
POST /payment/cancel-auto-renew
Authorization: Bearer <token>
Body:
{
  "reason": "用户主动取消"
}
```

**处理逻辑**：

1. 查询用户订阅和协议。
2. 调用支付宝 `alipay.user.agreement.unsign` 接口解约。
3. **不立即终止订阅**，`current_period_end` 内仍有效。
4. 标记 `auto_renew=false`，`cancelled_at=now`。

响应：

```json
{
  "cancelled_at": "2026-07-13T...",
  "current_period_end": "2027-07-13T...",
  "message": "已关闭自动续费，会员有效期至 2027-07-13"
}
```

### 5.6 支付宝异步回调

```
POST /payment/alipay/notify
Content-Type: application/x-www-form-urlencoded
```

**处理逻辑**：

1. **验签**（使用支付宝公钥，必须）。
2. 根据 `notify_type` 或 `trade_status` 分发：

| 回调类型 | 判断条件 | 处理 |
|----------|----------|------|
| 签约成功 | `notify_type=cycle_sign` 且 `status=VERIFIED` | 创建 `PaymentAgreement`，关联到 `Payment` |
| 签约解约 | `notify_type=cycle_sign` 且 `status=UNSIGN` | 更新协议状态为 `cancelled`，订阅 `auto_renew=false` |
| 周期扣款成功 | `notify_type=cycle_charge` 且 `trade_status=TRADE_SUCCESS` | 创建 `SubscriptionRenewal`（success），延长订阅 |
| 一次性支付成功 | `trade_status=TRADE_SUCCESS` 且无 `notify_type` | 更新 `Payment` 状态为 paid，激活订阅 |
| 扣款失败 | `notify_type=cycle_charge` 且 `trade_status=TRADE_FAILED` | 更新 `SubscriptionRenewal`（failed），触发重试 |

3. **幂等处理**：同一 `out_trade_no` 不重复处理。
4. 返回 `success`（支付宝要求 7 字符以内）。

### 5.7 退款（可选，P2）

```
POST /payment/refund
Authorization: Bearer <admin_token>
Body:
{
  "order_id": 123,
  "amount": 288.00,
  "reason": "用户申请退款"
}
```

调用支付宝 `alipay.trade.refund` 接口。

---

## 6. 自动续费定时任务

### 6.1 扣款任务

在 `mona-auth` 中新增 APScheduler 任务，每小时执行：

```python
async def auto_deduct_job():
    # 查询 3 天内到期 + auto_renew=true + status=active 的订阅
    due_subs = db.query(Subscription).filter(
        Subscription.auto_renew == True,
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.current_period_end <= datetime.now(timezone.utc) + timedelta(days=3),
    ).all()

    for sub in due_subs:
        if not sub.agreement or sub.agreement.status != AgreementStatus.ACTIVE:
            await notify_user(sub.user, "协议已失效，请重新订阅")
            continue

        plan = get_plan(sub.plan_code)
        out_trade_no = f"recur_{sub.id}_{int(time.time())}"

        # 创建 renewal 记录
        renewal = SubscriptionRenewal(
            subscription_id=sub.id,
            agreement_no=sub.agreement.agreement_no,
            out_trade_no=out_trade_no,
            amount=plan.price,
            period_days=plan.period_days,
            status=RenewalStatus.PENDING,
        )
        db.add(renewal)
        db.commit()

        # 调用支付宝周期扣款
        try:
            result = await alipy.periodic_deduct(
                agreement_no=sub.agreement.agreement_no,
                out_trade_no=out_trade_no,
                amount=plan.price,
                subject=f"Mona Pro 续费 - {plan.name}",
            )
            if result.success:
                renewal.status = RenewalStatus.SUCCESS
                renewal.alipay_trade_no = result.trade_no
                renewal.paid_at = datetime.now(timezone.utc)
                sub.current_period_end += timedelta(days=plan.period_days)
            else:
                await handle_deduct_failure(sub, renewal, result.error)
        except Exception as e:
            renewal.status = RenewalStatus.FAILED
            renewal.failure_reason = str(e)
            await handle_deduct_failure(sub, renewal, str(e))

        db.commit()
```

### 6.2 重试策略

| 重试次数 | 延迟 | 动作 |
|----------|------|------|
| 1 | 失败后立即 | 记录原因 |
| 2 | +24 小时 | 邮件通知用户 |
| 3 | +48 小时 | 站内通知 |
| ≥4 | - | 标记 `auto_renew=false`，订阅到期后过期，通知用户手动续费 |

重试通过 `next_retry_at` 字段控制，任务每小时扫描 `next_retry_at <= now` 且 `status=retrying` 的记录。

### 6.3 扣款前通知任务

每天凌晨执行，扫描 3 天内到期的自动续费订阅，发送通知：

```python
async def pre_deduct_notify_job():
    due_subs = db.query(Subscription).filter(
        Subscription.auto_renew == True,
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.current_period_end <= datetime.now(timezone.utc) + timedelta(days=3),
        Subscription.current_period_end > datetime.now(timezone.utc),
    ).all()

    for sub in due_subs:
        days_left = (sub.current_period_end - datetime.now(timezone.utc)).days
        if days_left in [3, 1]:
            await send_email(
                sub.user.email,
                subject=f"Mona Pro 会员将于 {days_left} 天后自动续费",
                body=f"您的订阅将于 {sub.current_period_end} 自动扣款 ¥{plan.price}。"
                     f"如需取消，请在 Mona 设置中关闭自动续费。"
            )
```

### 6.4 过期处理任务

```python
async def expire_job():
    # 标记已过期的订阅
    db.query(Subscription).filter(
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.current_period_end < datetime.now(timezone.utc),
    ).update({"status": SubscriptionStatus.EXPIRED})
    db.commit()
```

---

## 7. 支付宝 SDK 封装

新增 `mona-auth/app/alipay.py`：

```python
from alipay import AliPay

class AlipayService:
    def __init__(self):
        self.client = AliPay(
            appid=settings.alipay_app_id,
            app_notify_url=settings.alipay_notify_url,
            app_private_key_string=settings.alipay_app_private_key,
            alipay_public_key_string=settings.alipay_public_key,
            sign_type="RSA2",
            debug=False,  # 生产环境
        )

    async def sign_and_pay(
        self,
        external_sign_no: str,
        amount: float,
        subject: str,
        return_url: str,
    ) -> str:
        """签约并支付，返回签约 URL"""
        order_string = self.client.api_alipay_user_agreement_facetopay_sign_and_pay(
            external_agreement_no=external_sign_no,
            agreement_no=...,
            total_amount=f"{amount:.2f}",
            subject=subject,
            return_url=return_url,
        )
        return f"https://openapi.alipay.com/gateway.do?{order_string}"

    async def periodic_deduct(
        self,
        agreement_no: str,
        out_trade_no: str,
        amount: float,
        subject: str,
    ) -> DeductResult:
        """周期扣款"""
        result = self.client.api_alipay_user_agreement_execution_plan(
            agreement_no=agreement_no,
            out_trade_no=out_trade_no,
            total_amount=f"{amount:.2f}",
            subject=subject,
        )
        return DeductResult(...)

    async def unsign(self, agreement_no: str) -> bool:
        """解约"""
        result = self.client.api_alipay_user_agreement_unsign(agreement_no=agreement_no)
        return result.get("code") == "10000"

    def verify_callback(self, data: dict) -> bool:
        """验证异步回调签名"""
        return self.client.verify(data, data.pop("sign"))
```

### 7.1 配置项

在 [config.py](../mona-auth/app/config.py) 中新增：

```python
class Settings:
    # ... 现有配置 ...
    alipay_app_id: str
    alipay_app_private_key: str  # PEM 格式，可从文件加载
    alipay_public_key: str
    alipay_notify_url: str  # https://mona.example.com/payment/alipay/notify
    alipay_return_url: str  # https://mona.example.com/payment/return
    alipay_sandbox: bool = False  # 沙箱模式开关
```

敏感信息通过 `.env` 文件加载，不入库。

---

## 8. 客户端集成

### 8.1 新增文件

| 文件 | 用途 |
|------|------|
| `webui/src/components/SubscribePage.tsx` | 新订阅页（替代或扩展 SubscribeView） |
| `webui/src/components/PaymentDialog.tsx` | 支付弹窗（二维码/跳转 + 轮询） |
| `webui/src/components/ManageSubscription.tsx` | 订阅管理（取消续费、查看历史） |
| `webui/src/hooks/useSubscription.ts` | 订阅状态管理 hook |

### 8.2 订阅页核心流程

```typescript
// webui/src/components/SubscribePage.tsx
async function handleSubscribe(planCode: string, paymentMethod: 'alipay_periodic' | 'alipay_page') {
  // 1. 调用后端创建订阅
  const res = await fetch(`${API_BASE}/payment/subscribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan_code: planCode, payment_method: paymentMethod })
  });
  const { trade_order_id, payment_url } = await res.json();

  // 2. 打开支付页（浏览器拉起支付宝或展示二维码）
  window.open(payment_url, '_blank');

  // 3. 轮询订单状态
  const status = await pollOrderStatus(trade_order_id);
  if (status === 'paid') {
    // 刷新 License
    await refreshLicense();
    navigate('/main');
  }
}
```

### 8.3 支付弹窗设计

- 桌面端优先展示**二维码**（调用支付宝 `alipay.trade.precreate` 或从 `payment_url` 提取）。
- 提供「使用浏览器打开」按钮，跳转到系统浏览器完成支付。
- 轮询订单状态，每 3 秒一次，超时 10 分钟。
- 支付成功后自动关闭弹窗并刷新订阅状态。

### 8.4 订阅管理页

```
┌─────────────────────────────────────┐
│  当前订阅                            │
│  ──────────────────────────────     │
│  套餐：年度会员                       │
│  状态：有效                           │
│  到期：2027-07-13                    │
│  自动续费：已开启                     │
│                                     │
│  [关闭自动续费]                      │
│                                     │
│  ─── 续费记录 ───                    │
│  2026-07-13  年度会员  ¥288  已支付  │
│  ...                                │
│                                     │
│  [返回]                             │
└─────────────────────────────────────┘
```

### 8.5 Tauri 命令扩展

在 [license.rs](../src-tauri/src/license.rs) 中新增：

```rust
#[tauri::command]
async fn create_subscription(plan_code: String, payment_method: String) -> Result<...> {
    // 代理调用 /payment/subscribe
}

#[tauri::command]
async fn cancel_auto_renew() -> Result<...> {
    // 代理调用 /payment/cancel-auto-renew
}

#[tauri::command]
async fn poll_payment_status(order_id: i64) -> Result<...> {
    // 代理调用 /payment/orders/{order_id}
}
```

---

## 9. 与现有系统集成

### 9.1 替换 xhp 支付

- 保留 [payment_router.py](../mona-auth/app/routers/payment_router.py) 的 `/payment/create` 接口作为兼容入口，内部根据 `payment_channel` 配置切换 xhp 或支付宝。
- 新增 `/payment/subscribe` 作为支付宝订阅专用入口。
- xhp 相关代码标记为 deprecated，待观察支付宝稳定性后移除（预计 3 个月后）。

### 9.2 复用 License 机制

- 支付成功后，`_activate_subscription` 函数复用现有逻辑。
- 客户端通过 `/license/check` 拉取最新订阅状态，签发 License JWT。
- **无需修改**客户端 `verify_license`、`get_license_status` 等逻辑。

### 9.3 复用通知系统

- 扣款前通知、扣款失败通知复用 [notification_router.py](../mona-auth/app/routers/notification_router.py)。
- 通知类型新增 `subscription`（已在 Notification.type 字段支持）。

### 9.4 后台管理扩展

在 [admin/index.html](../mona-auth/app/admin/index.html) 中新增：

- **订单列表 Tab**：展示所有支付订单，支持按状态、渠道筛选。
- **续费记录 Tab**：展示自动续费扣款记录，监控失败情况。
- **协议列表 Tab**：展示所有周期扣款协议，支持手动解约（异常处理）。

---

## 10. 安全与合规

### 10.1 必须做

1. **签名验证**：所有支付宝回调必须使用支付宝公钥验签，防止伪造。
2. **幂等处理**：同一 `out_trade_no` 重复回调不重复处理。
3. **HTTPS 全程**：支付相关接口强制 HTTPS（Nginx 已配置）。
4. **密钥管理**：支付宝私钥通过环境变量加载，不入库、不入日志。
5. **订阅规则展示**：购买页必须明确显示
   - 套餐价格、周期
   - 自动续费说明（"到期前 3 天自动扣款"）
   - 退订入口位置
6. **退订功能**：客户端和支付宝 App 内均提供退订入口。
7. **扣款前通知**：续费前 3 天和 1 天发送邮件通知。

### 10.2 建议做

- 订单金额用整数分存储，避免浮点误差（当前用 float，后续可迁移到 Decimal）。
- 敏感操作（取消续费、退款）记录审计日志。
- 限制单用户单日扣款次数（防异常）：≤3 次。
- 退款走人工审核流程。

---

## 11. 测试方案

### 11.1 沙箱测试

- 使用支付宝沙箱环境（`alipay_sandbox=True`）。
- 沙箱账号：买家账号 + 商家账号。
- 测试场景：
  - 签约 + 首期扣款成功
  - 签约失败（用户拒绝）
  - 周期扣款成功
  - 周期扣款失败（余额不足）
  - 解约
  - 异步回调验签
  - 幂等处理

### 11.2 单元测试

新增 `tests/test_alipay_payment.py`：

- 测试签约 URL 生成
- 测试回调验签
- 测试幂等处理
- 测试自动续费任务
- 测试重试策略

---

## 12. 实施步骤

### P0 — 核心闭环（1 周）

1. **支付宝 SDK 集成**：`mona-auth/app/alipay.py`，配置密钥。
2. **数据模型扩展**：新增 `PaymentAgreement`、`SubscriptionRenewal`，扩展 `Subscription`、`Payment`。
3. **一次性支付接口**：`/payment/subscribe`（`alipay_page` 方式），先上线终身版购买。
4. **支付宝回调处理**：`/payment/alipay/notify`，验签 + 幂等。
5. **客户端支付弹窗**：二维码展示 + 轮询。

### P1 — 自动续费（1 周）

6. **周期扣款签约接口**：`/payment/subscribe`（`alipay_periodic` 方式）。
7. **周期扣款执行**：`alipay.periodic_deduct`。
8. **自动续费定时任务**：扣款 + 重试 + 通知。
9. **取消自动续费接口**：`/payment/cancel-auto-renew`。
10. **客户端订阅管理页**。

### P2 — 管理后台与增强（3 天）

11. **后台订单管理**：订单列表、续费记录、协议列表。
12. **扣款前通知**：邮件 + 站内通知。
13. **退款接口**（可选）。

### P3 — 清理与优化（2 天）

14. **移除 xhp 支付代码**：确认支付宝稳定运行 3 个月后。
15. **金额存储迁移**：float → Decimal（可选）。

---

## 13. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| 周期扣款审核不通过 | 无法上线自动续费 | 先上线一次性付费，运营 1-2 月后再申请周期扣款 |
| 支付宝回调延迟 | 订阅状态更新滞后 | 客户端轮询 + 主动查询接口兜底 |
| 用户余额不足导致扣款失败 | 订阅中断 | 重试 3 次 + 通知用户手动续费 |
| 协议被用户在支付宝侧解约 | 下次扣款失败 | 定时任务检查协议状态，失败后通知用户 |
| 密钥泄露 | 资金安全风险 | 私钥仅存 VPS 环境变量，不入日志，定期轮换 |

---

## 14. 明确不做

- 不集成微信支付（支付宝优先，微信委托代扣门槛高）。
- 不做发票系统（用户需要时人工开具）。
- 不做优惠码系统（P3 阶段视运营需求决定）。
- 不做 Stripe（国内用户为主，支付宝体验更好）。
- 不修改客户端 License 验证逻辑。
