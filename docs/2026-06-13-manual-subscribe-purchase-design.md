# Mona 手动订阅购买流程设计

## 1. 背景与目标

现有会员系统（见 [2026-05-28-membership-system-design.md](./2026-05-28-membership-system-design.md)）按 Stripe 在线支付设计，但当前没有可用的线上支付渠道。本设计改为**客户端内引导用户通过邮箱/微信联系作者，人工收款后在后台开通订阅**的轻量流程。

目标：
- 用户试用期结束后，能在应用内清楚知道如何购买订阅。
- 价格从服务端动态获取，管理员可在后台配置价格和促销活动。
- 提供复制邮箱/微信号、一键生成申请邮件等便捷操作，减少人工核对成本。
- 支持消息通知功能，有促销活动时可通过服务端发布，用户在应用内消息中心查看。
- 后台继续复用现有"设置用户订阅时间"的管理功能，不做额外订单系统。

## 2. 触发时机

订阅购买引导在以下场景出现：

1. **已登录用户订阅过期**：`licenseInfo.status === "expired"` 且 `loggedIn === true` 时，[AuthPage.tsx](../webui/src/components/AuthPage.tsx) 切换为订阅引导视图。
2. **本地试用过期用户主动升级**：本地试用过期（`localTrialExpired === true`）时，登录/注册页提供 "购买订阅" 入口；点击后先引导登录/注册，登录成功后再根据订阅状态判断是否进入订阅引导视图。
3. **直接购买入口**：登录/注册页底部始终显示 "购买订阅" 链接，方便已知产品的用户直接付费。
4. **消息通知触发**：用户在应用内消息中心查看服务端发布的通知，点击促销消息可跳转至订阅引导页。

## 3. 服务端：价格配置与消息通知

### 3.1 价格配置 API

新增公开 API（无需登录），客户端启动时调用获取最新价格和联系方式：

```
GET /config/pricing
```

响应：

```json
{
  "plans": [
    {
      "id": "monthly",
      "name": "月度订阅",
      "price": 29.0,
      "duration_months": 1,
      "original_price": null,
      "badge": null
    },
    {
      "id": "yearly",
      "name": "年度订阅",
      "price": 288.0,
      "duration_months": 12,
      "original_price": 348.0,
      "badge": "推荐"
    }
  ],
  "contact": {
    "email": "support@example.com",
    "wechat": "mona_support"
  },
  "promotional_banner": null
}
```

字段说明：
- `plans`：订阅方案列表，从服务端配置读取，支持动态增减。
- `plans[].original_price`：原价，非 null 时客户端显示划线价 + 折扣。
- `plans[].badge`：角标文案（如"推荐""限时优惠"），null 不显示。
- `contact`：联系方式，客户端用于展示和 mailto 生成。
- `promotional_banner`：促销横幅文案，null 不显示。有值时客户端在订阅页顶部展示。

### 3.2 数据库：价格配置表

新增 `pricing_plans` 表，替代 `config.py` 中的硬编码 `price_monthly` / `price_yearly`：

```sql
CREATE TABLE pricing_plans (
    id              VARCHAR(32) PRIMARY KEY,       -- 'monthly', 'yearly' 等
    name            VARCHAR(64) NOT NULL,          -- 显示名称
    price           DECIMAL(10,2) NOT NULL,        -- 当前价格
    original_price  DECIMAL(10,2) NULL,            -- 原价（用于划线价展示）
    duration_months INT NOT NULL,                  -- 时长（月）
    badge           VARCHAR(32) NULL,              -- 角标文案
    sort_order      INT NOT NULL DEFAULT 0,        -- 排序
    enabled         BOOLEAN NOT NULL DEFAULT TRUE, -- 是否启用
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

新增 `app_config` 表，存储全局配置（联系方式、促销横幅等）：

```sql
CREATE TABLE app_config (
    `key`   VARCHAR(64) PRIMARY KEY,
    value   TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 预置数据
INSERT INTO app_config (`key`, value) VALUES
    ('contact_email', 'support@example.com'),
    ('contact_wechat', 'mona_support'),
    ('promotional_banner', NULL);
```

### 3.3 消息通知

#### 数据模型

新增 `notifications` 表：

```sql
CREATE TABLE notifications (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    title       VARCHAR(128) NOT NULL,       -- 通知标题
    body        VARCHAR(512) NOT NULL,       -- 通知正文
    type        VARCHAR(32) NOT NULL,        -- 'promotion' | 'system' | 'subscription'
    action_url  VARCHAR(512) NULL,           -- 点击跳转地址（如 'subscribe'）
    image_url   VARCHAR(512) NULL,           -- 可选配图
    published   BOOLEAN NOT NULL DEFAULT FALSE,
    published_at DATETIME NULL,
    expires_at  DATETIME NULL,               -- 过期后不再展示
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

新增 `notification_reads` 表，记录用户已读状态：

```sql
CREATE TABLE notification_reads (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    notification_id BIGINT NOT NULL,
    read_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
    UNIQUE(user_id, notification_id)
);
```

#### 消息通知 API

```
GET /notifications
Authorization: Bearer <token>
```

响应：

```json
{
  "notifications": [
    {
      "id": 1,
      "title": "限时优惠：年度订阅 8 折",
      "body": "即日起至 6 月 30 日，年度订阅享 8 折优惠，仅需 ¥230/年。",
      "type": "promotion",
      "action_url": "subscribe",
      "image_url": null,
      "read": false,
      "published_at": "2026-06-13T10:00:00Z",
      "expires_at": "2026-06-30T23:59:59Z"
    }
  ]
}
```

逻辑：
- 只返回 `published = true` 且 `expires_at > now` 的通知。
- 标记该用户是否已读（通过 `notification_reads` 关联）。
- 按发布时间倒序。

```
POST /notifications/{id}/read
Authorization: Bearer <token>
```

标记通知为已读。

```
GET /notifications/unread-count
Authorization: Bearer <token>
```

返回未读消息数量，用于在应用入口处显示角标。

### 3.4 后台管理页面新增

在现有 [admin/index.html](../mona-auth/app/admin/index.html) 中新增两个 Tab：

#### Tab 1：价格配置

- 列表展示所有 `pricing_plans`，支持：
  - 编辑价格、原价、角标、排序、启用/禁用。
  - 新增方案。
  - 删除方案（软删除，设 enabled=false）。
- 全局配置区：
  - 编辑联系邮箱、微信号。
  - 编辑促销横幅文案（留空则不显示）。

#### Tab 2：通知管理

- 列表展示所有 `notifications`，支持：
  - 创建通知：填写标题、正文、类型、跳转地址、过期时间。
  - 发布/取消发布。
  - 删除通知。
- 展示每条通知的已读人数统计。

## 4. 客户端：订阅引导页 UI 交互

### 4.1 页面结构

页面整体采用居中卡片式布局，最大宽度 420px，与现有 AuthPage 风格一致。

```
┌─────────────────────────────────────┐
│         [促销横幅 - 可选]            │
│    "限时优惠：年度订阅 8 折"          │
├─────────────────────────────────────┤
│                                     │
│         升级至 Mona Pro              │
│                                     │
│  ┌─────────────┐  ┌─────────────┐  │
│  │  月度订阅     │  │  年度订阅    │  │
│  │  ¥29/月      │  │  ¥288/年    │  │
│  │             │  │  ¥348 划线   │  │
│  │             │  │  [推荐] 角标  │  │
│  │  ○ 选择      │  │  ● 选择     │  │
│  └─────────────┘  └─────────────┘  │
│                                     │
│  ─── 购买步骤 ───                   │
│  1. 复制联系方式并完成付款            │
│  2. 告知你的注册邮箱                 │
│  3. 开通后刷新状态或重新登录          │
│                                     │
│  ─── 联系方式 ───                   │
│  📧 support@example.com  [复制]     │
│     [发送申请邮件]                   │
│  💬 mona_support         [复制]     │
│                                     │
│  [我已付款，发送申请邮件]             │
│  [刷新订阅状态]                      │
│                                     │
│  开通后若状态未更新，请退出重新登录    │
│                                     │
│  ← 返回登录                         │
└─────────────────────────────────────┘
```

### 4.2 交互细节

#### 方案选择卡片

- 横向排列（2-3 个方案），每个卡片包含：名称、价格、原价（划线）、角标。
- 默认选中第一个带 `badge` 的方案，无 badge 则选第一个。
- 选中状态：卡片边框高亮 + 圆形实心指示器。
- 点击卡片切换选中状态。

#### 促销横幅

- 仅当 `promotional_banner` 非 null 时显示。
- 位于页面顶部，渐变背景色，文字居中。
- 可关闭（本次会话内不再显示，不持久化）。

#### 联系方式

- 邮箱行：显示邮箱地址 + "复制" 按钮（点击后显示 "已复制" 反馈 2 秒）。
- "发送申请邮件" 按钮：调用 `mailto:` 打开系统邮件客户端，预填内容。
- 微信行：显示微信号 + "复制" 按钮。

#### 邮件模板

点击 "发送申请邮件" 或 "我已付款，发送申请邮件" 后，`mailto:` 预填：

- **收件人**：从 `/config/pricing` 返回的 `contact.email`
- **主题**：`Mona Pro 订阅申请 - {userEmail}`
- **正文**：
  ```
  你好，我已购买 Mona Pro 订阅，请开通。

  注册邮箱：{userEmail}
  机器 ID：{machineId}
  购买方案：{selectedPlanName}

  谢谢！
  ```

其中 `selectedPlanName` 为当前选中方案的 `name` 字段。

#### 刷新订阅状态

- 点击 "刷新订阅状态" 按钮调用 `refreshLicense()`。
- 刷新成功后：
  - 若 `licenseActive === true`，显示成功提示并自动跳转至主界面。
  - 若仍过期，显示 "订阅尚未开通，请稍后再试"。
- 按钮在请求期间显示 loading 状态。

#### 返回登录

- 底部 "← 返回登录" 链接，切回登录视图。

### 4.4 消息通知 UI

#### 消息中心入口

- 在应用主界面提供固定消息入口（铃铛图标 + 未读数角标），位置在侧边栏底部或右上角用户头像旁。
- 点击入口打开消息中心弹窗/Sheet，列出当前用户的未读/已读消息。
- 列表项显示标题、发布时间、未读状态圆点；点击后展开正文，显示“查看详情”和“标记已读”按钮。
- `action_url === "subscribe"` 时，点击“查看详情”跳转订阅引导页；其他外部 URL 在系统浏览器打开。
- 消息中心底部提供“全部标记已读”按钮。
- 空态显示“暂无消息”占位。

#### 消息同步时机

- 应用启动、登录成功、进入消息中心时调用 `GET /notifications` 和 `GET /notifications/unread-count`。
- 标记已读后刷新本地未读数。

## 5. 用户流程

```
启动 Mona
  │
  ├─ 本地试用中 / 订阅有效 → 正常使用
  │   └─ 后台拉取消息 → 铃铛图标显示未读数
  │
  └─ 试用过期 或 订阅过期
        │
        ▼
   AuthPage 显示订阅引导
        │
        ├─ 用户查看价格，选择方案
        ├─ 复制邮箱/微信，联系作者付款
        │
        ├─ 作者收款后，在管理后台设置该用户的订阅到期时间
        │
        └─ 用户点击"刷新状态"或重新登录
              │
              ▼
        客户端调用 /license/check 获取最新订阅状态
              │
              ▼
        订阅有效 → 解锁会员 AI 功能
```

## 6. 与现有系统集成

### 6.1 复用组件

- [AuthPage.tsx](../webui/src/components/AuthPage.tsx)：新增 `subscribe` 视图，处理过期/试用过期状态。
- [useLicense.tsx](../webui/src/hooks/useLicense.tsx)：复用 `licenseInfo`、`loggedIn`、`localTrialExpired`、`refreshLicense`。
- [license.rs](../src-tauri/src/license.rs)：复用 `check_license`、`get_machine_id`，新增 `get_pricing` 命令代理 `/config/pricing`。
- [payment_router.py](../mona-auth/app/routers/payment_router.py)：现有支付模块保留。新增 `config_router.py` 和 `notification_router.py` 分别提供 `/config/pricing` 和 `/notifications` 路由。
- [admin/index.html](../mona-auth/app/admin/index.html)：新增价格配置和通知管理 Tab。

### 6.2 新增文件

| 文件 | 用途 |
|------|------|
| `webui/src/components/SubscribeView.tsx` | 订阅引导页组件 |
| `webui/src/components/NotificationCenter.tsx` | 消息中心弹窗组件 |
| `webui/src/hooks/useNotifications.ts` | 消息拉取与已读管理 hook |
| `mona-auth/app/routers/config_router.py` | `/config/pricing` API |
| `mona-auth/app/routers/notification_router.py` | `/notifications` API |

### 6.3 修改文件

| 文件 | 改动 |
|------|------|
| `webui/src/components/AuthPage.tsx` | 新增 `subscribe` 视图路由，集成 SubscribeView |
| `webui/src/hooks/useLicense.tsx` | 新增 `pricingInfo` 状态和 `fetchPricing` 方法 |
| `src-tauri/src/license.rs` | 新增 `get_pricing` Tauri 命令 |
| `mona-auth/app/models.py` | 新增 `PricingPlan`、`AppConfig`、`Notification`、`NotificationRead` 模型 |
| `mona-auth/app/schemas.py` | 新增对应 Pydantic schema |
| `mona-auth/app/main.py` | 注册新路由 |
| `mona-auth/app/admin/index.html` | 新增价格配置和通知管理 Tab |
| `mona-auth/app/config.py` | 移除 `price_monthly`/`price_yearly` 硬编码，改为从数据库读取 |

## 7. 管理员流程

1. 在管理后台 "价格配置" Tab 设置订阅方案和联系方式。
2. 有促销活动时，在 "通知管理" Tab 创建并发布通知。
3. 用户通过邮件/微信联系作者并付款。
4. 作者在管理后台 "用户列表" 中找到对应用户，设置订阅到期时间。
5. 用户端刷新或重新登录后生效。

## 8. 安全与边界

- `/config/pricing` 为公开 API，不暴露敏感信息。
- `/notifications` 需登录，只返回当前用户的通知。
- 不改动现有 License 验证逻辑；人工开通后仍然走服务器 `/license/check` 验证。
- `mailto:` 中的机器 ID 仅用于辅助核对，不作为授权依据。
- 消息通知为拉取模式（客户端轮询），不做 WebSocket 实时推送，保持简单。

## 9. 明确不做

- 不集成 Stripe、支付宝、微信等在线支付。
- 不建立订单、发票、退款系统。
- 不做 WebSocket 实时消息推送。
- 不在客户端做自动开通逻辑。
