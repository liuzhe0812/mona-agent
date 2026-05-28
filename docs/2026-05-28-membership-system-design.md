# Mona 会员制设计方案

## 1. 概述

### 1.1 目标

为 Mona 的 AI 功能引入会员制，用户登录并购买订阅后才能使用部分 AI 功能。登录购买后支持本地离线使用，定期联网验证订阅状态。

### 1.2 功能边界

| 功能 | 是否需要会员 |
|------|-------------|
| Agent 对话 | 否（免费） |
| 图片生成 | 否（免费） |
| DB AI 助手 | 是 |
| 笔记 AI | 是 |
| 终端 AI 面板 | 是 |
| 知识库 AI | 是 |

### 1.3 核心约束

- 用户自带 LLM API Key，Mona 不承担 AI 调用成本
- 登录购买后可离线使用，定期联网验证
- VPS 上有 MariaDB 和 Nginx 可直接使用
- 支付集成使用 Stripe
- 不修改 `agent/loop.py` 和 `agent/runner.py`，拦截在 WebSocket channel 层完成

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      VPS                                │
│                                                         │
│  ┌──────────────────┐     ┌──────────────────────────┐ │
│  │  Auth Service     │────►│  Stripe API              │ │
│  │  (FastAPI)        │     └──────────────────────────┘ │
│  │                   │                                   │
│  │  /auth/register   │  签发 JWT License（RS256 私钥）   │
│  │  /auth/login      │                                   │
│  │  /auth/device/*   │                                   │
│  │  /stripe/webhook  │                                   │
│  │                   │                                   │
│  │  MariaDB          │                                   │
│  │  RS256 私钥       │                                   │
│  └──────────────────┘                                   │
│                                                         │
│  ┌──────────────────┐     Nginx 反代                    │
│  │  用户管理页面      │◄─────────────────                │
│  │  (静态 SPA)       │     /auth/* → Auth Service       │
│  │                   │     / → 静态页面                  │
│  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────┘
         ▲  仅登录/购买/定期验证时联网
         │
┌────────┴────────────────────────────────────────────────┐
│              客户端 (Tauri 本地运行)                      │
│                                                         │
│  ┌─────────────┐   ┌─────────────────────────────────┐ │
│  │ License 存储  │   │  Mona Python Backend            │ │
│  │ (本地加密)    │──►│                                 │ │
│  │             │   │  JWT 验证（内嵌 RS256 公钥）       │ │
│  │ JWT License │   │  ├─ 有效 → 放行会员 AI 功能       │ │
│  │ 到期时间     │   │  └─ 无效 → 拦截，提示续费         │ │
│  └─────────────┘   │                                 │ │
│                    │  用户自带 API Key → LLM Provider  │ │
│                    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 3. Auth Service 设计

### 3.1 技术栈

- **框架**：FastAPI
- **数据库**：MariaDB（VPS 已有）
- **支付**：Stripe Python SDK
- **签名**：python-jose / PyJWT（RS256）
- **密码**：bcrypt

### 3.2 数据库表

```sql
CREATE TABLE users (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subscriptions (
    id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id               BIGINT NOT NULL,
    stripe_customer_id    VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    status                ENUM('active', 'past_due', 'canceled', 'expired') NOT NULL DEFAULT 'expired',
    current_period_end    DATETIME,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE devices (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id             BIGINT NOT NULL,
    device_fingerprint  VARCHAR(255) NOT NULL,
    device_name         VARCHAR(255),
    license_jti         VARCHAR(255),
    last_verified       DATETIME,
    bound_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(device_fingerprint)
);

-- 每用户最多绑定 3 台终端，应用层校验
```

### 3.3 API 端点

#### 认证相关

| 方法 | 端点 | 用途 | 认证 |
|------|------|------|------|
| POST | `/auth/register` | 注册（email + password） | 无 |
| POST | `/auth/login` | 登录，返回 access token | 无 |
| POST | `/auth/device/bind` | 绑定终端，签发 License JWT | Bearer token |
| POST | `/auth/device/unbind` | 解绑终端 | Bearer token |
| POST | `/auth/device/refresh` | 刷新 License（定期验证） | License JWT |
| GET | `/auth/device/list` | 查看已绑定终端列表 | Bearer token |

#### Stripe 相关

| 方法 | 端点 | 用途 | 认证 |
|------|------|------|------|
| POST | `/stripe/checkout` | 创建 Checkout Session | Bearer token |
| POST | `/stripe/portal` | 创建 Customer Portal Session | Bearer token |
| POST | `/stripe/webhook` | Stripe 事件回调 | Stripe 签名验证 |

### 3.4 License JWT 结构

算法：RS256（私钥签发，公钥验证）

```json
{
  "sub": "user_id:123",
  "fp": "sha256_of_machine_fingerprint",
  "plan": "pro",
  "exp": 1719500000,
  "iat": 1718900000,
  "jti": "unique_token_id"
}
```

字段说明：

- `sub`：用户 ID，格式 `user_id:<id>`
- `fp`：机器指纹 SHA256 哈希，防止 License 被拷贝到其他机器使用
- `plan`：会员等级（当前为 `pro`，预留扩展）
- `exp`：到期时间 = min(订阅到期时间, 签发时间 + 验证周期)
- `iat`：签发时间
- `jti`：唯一 ID，可用于吊销

### 3.5 验证周期策略

- 签发 License 时，`exp` 设为 `min(订阅到期时间, 当前时间 + 7天)`
- 客户端每 7 天联网一次调用 `/auth/device/refresh` 刷新 License
- 如果订阅已取消，VPS 拒绝刷新，本地 License 最多再使用 7 天后过期
- 如果用户取消订阅后重新订阅，下次 refresh 时签发新 License

### 3.6 Stripe Webhook 处理

监听以下事件：

| 事件 | 处理 |
|------|------|
| `checkout.session.completed` | 创建 subscription 记录，状态设为 active |
| `customer.subscription.updated` | 更新 subscription 状态和 current_period_end |
| `customer.subscription.deleted` | 将 subscription 状态设为 canceled |
| `invoice.payment_failed` | 将 subscription 状态设为 past_due |

## 4. Mona 客户端集成

### 4.1 新增模块

```
mona/auth/
├── __init__.py
├── license.py      # JWT 验证、公钥加载、License 状态管理
└── pubkey.pem      # RS256 公钥（编译时内嵌）
```

### 4.2 License 验证核心逻辑

```python
# mona/auth/license.py 核心接口

def verify_license(jwt_str: str, device_fingerprint: str) -> LicenseStatus:
    """验证 JWT 签名、到期时间、机器指纹匹配"""

def get_license_status() -> LicenseStatus:
    """读取本地 License 并验证，返回当前状态"""

def save_license(jwt_str: str) -> None:
    """加密存储 License JWT 到 ~/.mona/license.jwt"""

def load_license() -> str | None:
    """从本地读取并解密 License JWT"""
```

`LicenseStatus` 枚举：

- `VALID`：License 有效
- `EXPIRED`：License 已过期
- `FINGERPRINT_MISMATCH`：机器指纹不匹配
- `MISSING`：无 License 文件
- `INVALID`：签名验证失败

### 4.3 功能拦截点

拦截在 `WebSocketChannel._dispatch_envelope` 中实现，不修改 `agent/loop.py` 和 `agent/runner.py`。

```
客户端发送 message envelope
        │
        ▼
WebSocketChannel._dispatch_envelope()
        │
        ├─ 检查 metadata 中的功能类型标记
        │   ├─ 无特殊标记 → Agent 对话 ✅ 直接放行
        │   ├─ image_generation → 图片生成 ✅ 直接放行
        │   ├─ terminal_session_id → 终端 AI 🔒 检查 License
        │   ├─ db_connection_id → DB AI 🔒 检查 License
        │   └─ knowledge/note → 笔记 AI / 知识库 🔒 检查 License
        │
        ▼
License 有效 → 放行到 _handle_message
License 无效 → 返回 error event: {"event": "error", "detail": "membership_required"}
```

### 4.4 客户端使用流程

#### 首次使用

```
启动 → 检测无 License → 显示登录/购买引导
  → 调用 VPS /auth/login → 获取 access token
  → 收集机器指纹 → 调用 /auth/device/bind → 获取 License JWT
  → 本地加密存储 License → 会员 AI 功能解锁
```

#### 日常使用（离线）

```
启动 → 读取本地 License → 公钥验证签名 + 到期时间 + 机器指纹
  → 通过 → 会员 AI 功能可用
  → 失败 → 会员 AI 功能锁定，显示提示
```

#### 定期验证（联网时）

```
后台静默调用 /auth/device/refresh
  → 成功 → 刷新本地 License
  → 失败（订阅已取消）→ 本地 License 到期后锁定
```

#### 续费

```
前端跳转 Stripe Customer Portal → 支付成功
  → Stripe Webhook 通知 VPS 更新订阅状态
  → 下次 refresh 时签发新 License → 功能恢复
```

### 4.5 机器指纹生成

在 Tauri Rust 端生成，组合以下信息的 SHA256 哈希：

- 主板序列号（baseboard serial）
- CPU ID
- 磁盘序列号（系统盘）

取 2-3 个稳定标识组合，避免单一硬件更换导致指纹完全变化。指纹在 Tauri 端生成后传给 Python 后端，Python 端不做指纹采集。

### 4.6 本地 License 存储

- 路径：`~/.mona/license.jwt`
- 使用 AES-256-GCM 加密，密钥派生自机器指纹
- 防止用户手动篡改 JWT 内容（篡改后签名校验失败，加密层提供额外防护）

## 5. 用户管理页面

### 5.1 技术方案

- 轻量 SPA（Vue 3 或 React）
- Nginx 托管静态文件
- API 请求通过 Nginx 反代到 Auth Service

### 5.2 页面功能

| 页面 | 功能 |
|------|------|
| 注册/登录 | 邮箱 + 密码注册登录 |
| 仪表盘 | 显示订阅状态、到期时间 |
| 终端管理 | 查看/解绑已授权终端设备 |
| 购买订阅 | 跳转 Stripe Checkout |
| 管理支付 | 跳转 Stripe Customer Portal（修改支付方式、取消订阅） |

### 5.3 Nginx 配置示意

```nginx
server {
    listen 443 ssl;
    server_name mona.example.com;

    # 用户管理页面（静态文件）
    location / {
        root /var/www/mona-portal;
        try_files $uri $uri/ /index.html;
    }

    # Auth Service API 反代
    location /auth/ {
        proxy_pass http://127.0.0.1:8901;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /stripe/ {
        proxy_pass http://127.0.0.1:8901;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## 6. 安全设计

### 6.1 License 安全

- JWT 使用 RS256 签名，私钥只在 VPS 上存在，公钥内嵌在 Mona 代码中
- 本地存储加密，密钥派生自机器指纹，防止跨机器复制
- JWT 中包含机器指纹哈希，即使复制到其他机器也无法通过验证
- JWT 有 `jti` 字段，支持服务端吊销

### 6.2 通信安全

- VPS 上的 Auth Service 仅监听 `127.0.0.1`，通过 Nginx 提供 HTTPS
- 客户端与 VPS 之间所有通信走 HTTPS
- Stripe Webhook 使用 Stripe 签名验证，防止伪造

### 6.3 密码安全

- bcrypt 哈希存储，work factor >= 12
- 登录失败限流（IP + email 维度）

### 6.4 防护措施

- 设备绑定上限（每用户 3 台），防止 License 共享
- License 刷新限流，防止暴力刷新
- Auth Service 与 Mona 之间通过 `127.0.0.1` 通信，不暴露到公网

## 7. 部署架构

```
VPS (mona.example.com)
├── Nginx (443/80)
│   ├── / → 用户管理页面（静态 SPA）
│   ├── /auth/* → Auth Service (127.0.0.1:8901)
│   └── /stripe/* → Auth Service (127.0.0.1:8901)
│
├── Auth Service (127.0.0.1:8901)
│   ├── FastAPI + Uvicorn
│   ├── MariaDB 连接
│   └── RS256 私钥文件
│
├── MariaDB (127.0.0.1:3306)
│   └── mona_auth 数据库
│
└── Mona (用户本地运行，不部署在 VPS)
```

Auth Service 使用 systemd 管理：

```ini
[Unit]
Description=Mona Auth Service
After=network.target mariadb.service

[Service]
User=mona
WorkingDirectory=/opt/mona-auth
ExecStart=/opt/mona-auth/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8901
Restart=always

[Install]
WantedBy=multi-user.target
```

## 8. 实现优先级

### P0 — 核心闭环

1. Auth Service 基础框架（FastAPI + MariaDB + 用户注册/登录）
2. License JWT 签发与验证（RS256）
3. 设备绑定/解绑 API
4. Mona 客户端 License 验证模块（`mona/auth/`）
5. WebSocket channel 功能拦截
6. 客户端登录/绑定流程

### P1 — 支付集成

7. Stripe Checkout 集成
8. Stripe Webhook 处理
9. Stripe Customer Portal 集成
10. 定期验证刷新机制

### P2 — 用户页面

11. 用户管理 SPA（注册/登录/终端管理/订阅管理）
12. Nginx 配置与部署

### P3 — 增强

13. 机器指纹 Tauri 端实现
14. 本地 License 加密存储
15. 登录限流与安全加固
16. License 吊销机制
