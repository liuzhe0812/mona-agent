# Mona Auth Service 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 VPS 上开发一个独立的 FastAPI 认证服务，支持用户注册/登录、Stripe 订阅支付、设备绑定、License JWT 签发与刷新。

**Architecture:** Auth Service 作为独立进程运行在 VPS 上（127.0.0.1:8901），通过 Nginx 反代对外提供 HTTPS 服务。使用 MariaDB 存储用户/订阅/设备数据，RS256 私钥签发 License JWT，Stripe SDK 处理支付。

**Tech Stack:** Python 3.11+, FastAPI, Uvicorn, SQLAlchemy + Alembic, PyJWT, bcrypt, Stripe Python SDK, MariaDB

---

## 文件结构

```
/opt/mona-auth/
├── pyproject.toml
├── alembic.ini
├── alembic/
│   ├── env.py
│   └── versions/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI app 入口
│   ├── config.py             # 配置（环境变量 + Pydantic Settings）
│   ├── database.py           # SQLAlchemy 引擎 + 会话
│   ├── models.py             # ORM 模型
│   ├── schemas.py            # Pydantic 请求/响应 schema
│   ├── auth.py               # 密码哈希 + access token 工具
│   ├── license.py            # License JWT 签发与验证
│   ├── deps.py               # 依赖注入（DB session, 当前用户）
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── auth_router.py    # /auth/* 端点
│   │   ├── device_router.py  # /auth/device/* 端点
│   │   └── stripe_router.py  # /stripe/* 端点
│   ├── middleware.py          # 限流等中间件
│   └── errors.py             # 统一错误处理
├── keys/
│   ├── private.pem           # RS256 私钥（gitignore）
│   └── public.pem            # RS256 公钥（也分发给 Mona 客户端）
├── scripts/
│   ├── generate_keys.py      # 生成 RSA 密钥对
│   └── init_db.py            # 初始化数据库
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_auth.py
    ├── test_device.py
    ├── test_license.py
    └── test_stripe.py
```

---

### Task 1: 项目初始化

**Files:**
- Create: `/opt/mona-auth/pyproject.toml`
- Create: `/opt/mona-auth/app/__init__.py`
- Create: `/opt/mona-auth/app/main.py`

- [ ] **Step 1: 创建项目目录和 pyproject.toml**

```bash
mkdir -p /opt/mona-auth/app /opt/mona-auth/keys /opt/mona-auth/scripts /opt/mona-auth/tests
```

```toml
# /opt/mona-auth/pyproject.toml
[project]
name = "mona-auth"
version = "0.1.0"
description = "Mona membership authentication service"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0,<1.0.0",
    "uvicorn[standard]>=0.34.0,<1.0.0",
    "sqlalchemy>=2.0.0,<3.0.0",
    "alembic>=1.14.0,<2.0.0",
    "pymysql>=1.1.0,<2.0.0",
    "cryptography>=44.0.0,<45.0.0",
    "pyjwt[crypto]>=2.10.0,<3.0.0",
    "bcrypt>=4.2.0,<5.0.0",
    "stripe>=11.0.0,<12.0.0",
    "pydantic-settings>=2.12.0,<3.0.0",
    "slowapi>=0.1.9,<1.0.0",
    "httpx>=0.28.0,<1.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=9.0.0",
    "pytest-asyncio>=0.24.0",
    "httpx>=0.28.0",
]
```

- [ ] **Step 2: 创建 app/__init__.py**

```python
# /opt/mona-auth/app/__init__.py
```

- [ ] **Step 3: 创建 FastAPI 入口 app/main.py**

```python
from fastapi import FastAPI

app = FastAPI(title="Mona Auth Service", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 4: 安装依赖并验证启动**

```bash
cd /opt/mona-auth
python -m venv venv
source venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --host 127.0.0.1 --port 8901 &
curl http://127.0.0.1:8901/health
# 期望输出: {"status":"ok"}
kill %1
```

- [ ] **Step 5: 提交**

```bash
cd /opt/mona-auth
git init
cat > .gitignore << 'EOF'
venv/
__pycache__/
*.pyc
keys/private.pem
.env
EOF
git add -A
git commit -m "feat: init mona-auth project with FastAPI skeleton"
```

---

### Task 2: 配置管理

**Files:**
- Create: `/opt/mona-auth/app/config.py`

- [ ] **Step 1: 编写配置模块**

```python
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "mysql+pymysql://mona:mona@127.0.0.1:3306/mona_auth"
    database_pool_size: int = 5

    jwt_access_secret: str = ""
    jwt_access_expire_minutes: int = 60

    license_private_key_path: str = "keys/private.pem"
    license_public_key_path: str = "keys/public.pem"
    license_expire_days: int = 7
    max_devices_per_user: int = 3

    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_id: str = ""

    cors_origins: list[str] = []

    @property
    def license_private_key(self) -> str:
        return Path(self.license_private_key_path).read_text()

    @property
    def license_public_key(self) -> str:
        return Path(self.license_public_key_path).read_text()

    model_config = {"env_file": ".env", "env_prefix": "MONA_AUTH_"}


settings = Settings()
```

- [ ] **Step 2: 创建 .env 模板**

```bash
cat > /opt/mona-auth/.env.example << 'EOF'
MONA_AUTH_DATABASE_URL=mysql+pymysql://mona:your_password@127.0.0.1:3306/mona_auth
MONA_AUTH_JWT_ACCESS_SECRET=your-random-secret-here
MONA_AUTH_STRIPE_SECRET_KEY=sk_test_xxx
MONA_AUTH_STRIPE_WEBHOOK_SECRET=whsec_xxx
MONA_AUTH_STRIPE_PRICE_ID=price_xxx
MONA_AUTH_CORS_ORIGINS=["https://mona.example.com"]
EOF
```

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat: add config module with pydantic-settings"
```

---

### Task 3: 数据库模型与迁移

**Files:**
- Create: `/opt/mona-auth/app/database.py`
- Create: `/opt/mona-auth/app/models.py`
- Create: `/opt/mona-auth/alembic.ini`
- Create: `/opt/mona-auth/alembic/env.py`
- Create: `/opt/mona-auth/scripts/init_db.py`

- [ ] **Step 1: 编写 database.py**

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import settings

engine = create_engine(
    settings.database_url,
    pool_size=settings.database_pool_size,
    pool_recycle=3600,
    echo=False,
)

SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```

- [ ] **Step 2: 编写 models.py**

```python
import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SubscriptionStatus(str, enum.Enum):
    ACTIVE = "active"
    PAST_DUE = "past_due"
    CANCELED = "canceled"
    EXPIRED = "expired"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    subscriptions: Mapped[list["Subscription"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    devices: Mapped[list["Device"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    stripe_customer_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    status: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus), nullable=False, default=SubscriptionStatus.EXPIRED
    )
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    user: Mapped["User"] = relationship(back_populates="subscriptions")


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("device_fingerprint"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    device_fingerprint: Mapped[str] = mapped_column(String(255), nullable=False)
    device_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    license_jti: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_verified: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    bound_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="devices")
```

- [ ] **Step 3: 初始化 Alembic**

```bash
cd /opt/mona-auth
source venv/bin/activate
pip install alembic
alembic init alembic
```

- [ ] **Step 4: 编辑 alembic/env.py**

```python
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.database import Base
from app.models import User, Subscription, Device  # noqa: F401

config = context.config
config.set_main_option("sqlalchemy.url", settings.database_url)
target_metadata = Base.metadata


def run_migrations_offline():
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

- [ ] **Step 5: 编辑 alembic.ini**

将 `sqlalchemy.url` 行改为：
```ini
sqlalchemy.url = mysql+pymysql://mona:mona@127.0.0.1:3306/mona_auth
```

- [ ] **Step 6: 创建数据库和初始迁移**

```bash
# 在 MariaDB 中创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS mona_auth CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON mona_auth.* TO 'mona'@'localhost' IDENTIFIED BY 'your_password'; FLUSH PRIVILEGES;"

cd /opt/mona-auth
source venv/bin/activate
alembic revision --autogenerate -m "initial tables"
alembic upgrade head
```

- [ ] **Step 7: 编写 scripts/init_db.py（便捷初始化脚本）**

```python
from app.database import Base, engine
from app.models import User, Subscription, Device  # noqa: F401


def init_db():
    Base.metadata.create_all(bind=engine)
    print("Database tables created.")


if __name__ == "__main__":
    init_db()
```

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: add database models, Alembic migration, and init script"
```

---

### Task 4: Pydantic Schemas

**Files:**
- Create: `/opt/mona-auth/app/schemas.py`

- [ ] **Step 1: 编写请求/响应 schema**

```python
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class DeviceBindRequest(BaseModel):
    device_fingerprint: str = Field(min_length=8, max_length=255)
    device_name: str | None = Field(default=None, max_length=255)


class DeviceUnbindRequest(BaseModel):
    device_fingerprint: str = Field(min_length=8, max_length=255)


class DeviceInfo(BaseModel):
    id: int
    device_fingerprint: str
    device_name: str | None
    last_verified: datetime | None
    bound_at: datetime

    model_config = {"from_attributes": True}


class DeviceListResponse(BaseModel):
    devices: list[DeviceInfo]


class LicenseResponse(BaseModel):
    license_jwt: str
    expires_at: datetime


class LicenseRefreshRequest(BaseModel):
    device_fingerprint: str = Field(min_length=8, max_length=255)


class CheckoutRequest(BaseModel):
    success_url: str
    cancel_url: str


class CheckoutResponse(BaseModel):
    checkout_url: str


class PortalRequest(BaseModel):
    return_url: str


class PortalResponse(BaseModel):
    portal_url: str


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
```

- [ ] **Step 2: 提交**

```bash
git add -A
git commit -m "feat: add pydantic request/response schemas"
```

---

### Task 5: 密码哈希与 Access Token

**Files:**
- Create: `/opt/mona-auth/app/auth.py`

- [ ] **Step 1: 编写 auth.py**

```python
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def create_access_token(user_id: int) -> tuple[str, int]:
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_access_expire_minutes)
    payload = {
        "sub": str(user_id),
        "exp": expires,
        "iat": datetime.now(timezone.utc),
    }
    token = jwt.encode(payload, settings.jwt_access_secret, algorithm="HS256")
    return token, settings.jwt_access_expire_minutes


def decode_access_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.jwt_access_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None
```

- [ ] **Step 2: 提交**

```bash
git add -A
git commit -m "feat: add password hashing and access token utilities"
```

---

### Task 6: License JWT 签发与验证

**Files:**
- Create: `/opt/mona-auth/app/license.py`
- Create: `/opt/mona-auth/scripts/generate_keys.py`

- [ ] **Step 1: 编写密钥生成脚本**

```python
# scripts/generate_keys.py
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def generate_keys():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    with open("keys/private.pem", "wb") as f:
        f.write(private_pem)
    with open("keys/public.pem", "wb") as f:
        f.write(public_pem)

    print("Keys generated: keys/private.pem, keys/public.pem")


if __name__ == "__main__":
    generate_keys()
```

- [ ] **Step 2: 生成密钥对**

```bash
cd /opt/mona-auth
source venv/bin/activate
python scripts/generate_keys.py
# 确认 keys/private.pem 和 keys/public.pem 已生成
```

- [ ] **Step 3: 编写 license.py**

```python
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import jwt

from app.config import settings


def issue_license(
    user_id: int,
    device_fingerprint: str,
    subscription_end: datetime | None = None,
) -> tuple[str, datetime]:
    now = datetime.now(timezone.utc)
    license_max_expiry = now + timedelta(days=settings.license_expire_days)

    if subscription_end and subscription_end > now:
        if subscription_end.tzinfo is None:
            subscription_end = subscription_end.replace(tzinfo=timezone.utc)
        exp = min(subscription_end, license_max_expiry)
    else:
        exp = license_max_expiry

    fp_hash = hashlib.sha256(device_fingerprint.encode()).hexdigest()

    jti = uuid.uuid4().hex

    payload = {
        "sub": f"user_id:{user_id}",
        "fp": fp_hash,
        "plan": "pro",
        "exp": exp,
        "iat": now,
        "jti": jti,
    }

    token = jwt.encode(payload, settings.license_private_key, algorithm="RS256")
    return token, exp


def verify_license(token: str, device_fingerprint: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.license_public_key, algorithms=["RS256"])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None

    fp_hash = hashlib.sha256(device_fingerprint.encode()).hexdigest()
    if payload.get("fp") != fp_hash:
        return None

    return payload
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat: add License JWT issue and verify with RS256"
```

---

### Task 7: 依赖注入

**Files:**
- Create: `/opt/mona-auth/app/deps.py`

- [ ] **Step 1: 编写 deps.py**

```python
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.auth import decode_access_token
from app.database import get_db
from app.models import User

bearer_scheme = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    payload = decode_access_token(credentials.credentials)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user
```

- [ ] **Step 2: 提交**

```bash
git add -A
git commit -m "feat: add dependency injection for current user"
```

---

### Task 8: 错误处理

**Files:**
- Create: `/opt/mona-auth/app/errors.py`

- [ ] **Step 1: 编写统一错误处理**

```python
from fastapi import Request
from fastapi.responses import JSONResponse


class AuthError(Exception):
    def __init__(self, error: str, detail: str | None = None, status_code: int = 400):
        self.error = error
        self.detail = detail
        self.status_code = status_code


async def auth_error_handler(request: Request, exc: AuthError):
    body = {"error": exc.error}
    if exc.detail:
        body["detail"] = exc.detail
    return JSONResponse(status_code=exc.status_code, content=body)
```

- [ ] **Step 2: 提交**

```bash
git add -A
git commit -m "feat: add unified error handling"
```

---

### Task 9: 认证路由（注册/登录）

**Files:**
- Create: `/opt/mona-auth/app/routers/__init__.py`
- Create: `/opt/mona-auth/app/routers/auth_router.py`

- [ ] **Step 1: 创建 routers/__init__.py**

```python
```

- [ ] **Step 2: 编写 auth_router.py**

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth import create_access_token, hash_password, verify_password
from app.database import get_db
from app.errors import AuthError
from app.models import User
from app.schemas import LoginRequest, RegisterRequest, TokenResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == body.email).first()
    if existing:
        raise AuthError("email_exists", "This email is already registered", status_code=409)

    user = User(email=body.email, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)

    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise AuthError("invalid_credentials", "Invalid email or password", status_code=401)

    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)
```

- [ ] **Step 3: 注册路由到 main.py**

更新 `app/main.py`：

```python
from fastapi import FastAPI

from app.errors import AuthError, auth_error_handler
from app.routers.auth_router import router as auth_router

app = FastAPI(title="Mona Auth Service", version="0.1.0")

app.add_exception_handler(AuthError, auth_error_handler)
app.include_router(auth_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 4: 手动测试注册和登录**

```bash
cd /opt/mona-auth
source venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8901 &

# 注册
curl -X POST http://127.0.0.1:8901/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test1234"}'

# 登录
curl -X POST http://127.0.0.1:8901/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test1234"}'

kill %1
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: add register and login endpoints"
```

---

### Task 10: 设备路由（绑定/解绑/刷新/列表）

**Files:**
- Create: `/opt/mona-auth/app/routers/device_router.py`

- [ ] **Step 1: 编写 device_router.py**

```python
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.license import issue_license, verify_license
from app.models import Device, Subscription, SubscriptionStatus, User
from app.schemas import (
    DeviceBindRequest,
    DeviceInfo,
    DeviceListResponse,
    DeviceUnbindRequest,
    LicenseRefreshRequest,
    LicenseResponse,
)

router = APIRouter(prefix="/auth/device", tags=["device"])


def _get_active_subscription(db: Session, user_id: int) -> Subscription | None:
    return (
        db.query(Subscription)
        .filter(
            Subscription.user_id == user_id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        )
        .first()
    )


@router.post("/bind", response_model=LicenseResponse)
def bind_device(body: DeviceBindRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sub = _get_active_subscription(db, user.id)
    if sub is None:
        raise AuthError("no_subscription", "Active subscription required to bind a device", status_code=403)

    existing_device = db.query(Device).filter(Device.device_fingerprint == body.device_fingerprint).first()
    if existing_device:
        if existing_device.user_id != user.id:
            raise AuthError("device_bound_other", "This device is bound to another account", status_code=409)
        jti = uuid.uuid4().hex
        existing_device.license_jti = jti
        existing_device.device_name = body.device_name or existing_device.device_name
        existing_device.last_verified = datetime.now(timezone.utc)
        db.commit()
        license_jwt, exp = issue_license(user.id, body.device_fingerprint, sub.current_period_end)
        return LicenseResponse(license_jwt=license_jwt, expires_at=exp)

    user_device_count = db.query(Device).filter(Device.user_id == user.id).count()
    if user_device_count >= settings.max_devices_per_user:
        raise AuthError(
            "device_limit",
            f"Maximum {settings.max_devices_per_user} devices allowed",
            status_code=403,
        )

    jti = uuid.uuid4().hex
    device = Device(
        user_id=user.id,
        device_fingerprint=body.device_fingerprint,
        device_name=body.device_name,
        license_jti=jti,
        last_verified=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()

    license_jwt, exp = issue_license(user.id, body.device_fingerprint, sub.current_period_end)
    return LicenseResponse(license_jwt=license_jwt, expires_at=exp)


@router.post("/unbind")
def unbind_device(body: DeviceUnbindRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    device = db.query(Device).filter(
        Device.device_fingerprint == body.device_fingerprint,
        Device.user_id == user.id,
    ).first()
    if not device:
        raise AuthError("device_not_found", "Device not found in your account", status_code=404)
    db.delete(device)
    db.commit()
    return {"unbound": True}


@router.post("/refresh", response_model=LicenseResponse)
def refresh_license(body: LicenseRefreshRequest, db: Session = Depends(get_db)):
    from app.auth import decode_access_token
    from fastapi import Request
    import jwt as pyjwt

    sub = None
    user_id = None

    payload = verify_license(body.__dict__.get("_license_jwt", ""), body.device_fingerprint)

    if payload is None:
        raise AuthError("invalid_license", "License verification failed", status_code=401)

    sub_str = payload.get("sub", "")
    if not sub_str.startswith("user_id:"):
        raise AuthError("invalid_license", "Invalid license subject", status_code=401)
    user_id = int(sub_str.split(":")[1])

    subscription = _get_active_subscription(db, user_id)
    if subscription is None:
        raise AuthError("no_subscription", "Active subscription required", status_code=403)

    device = db.query(Device).filter(
        Device.device_fingerprint == body.device_fingerprint,
        Device.user_id == user_id,
    ).first()
    if not device:
        raise AuthError("device_not_bound", "Device is not bound to this account", status_code=404)

    device.last_verified = datetime.now(timezone.utc)
    device.license_jti = uuid.uuid4().hex
    db.commit()

    license_jwt, exp = issue_license(user_id, body.device_fingerprint, subscription.current_period_end)
    return LicenseResponse(license_jwt=license_jwt, expires_at=exp)


@router.get("/list", response_model=DeviceListResponse)
def list_devices(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    devices = db.query(Device).filter(Device.user_id == user.id).all()
    return DeviceListResponse(devices=devices)
```

> **注意**：`/refresh` 端点需要客户端在请求中附带 License JWT。实际实现中，客户端通过 `Authorization: Bearer <license_jwt>` 头传入，设备指纹在请求体中发送。上面的 `verify_license` 调用需要从请求头提取 JWT，下面在集成到 main.py 时会完善。

- [ ] **Step 2: 更新 refresh 端点，从 Authorization 头读取 License JWT**

替换 `refresh_license` 函数：

```python
from fastapi import Request


@router.post("/refresh", response_model=LicenseResponse)
async def refresh_license(request: Request, body: LicenseRefreshRequest, db: Session = Depends(get_db)):
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise AuthError("missing_token", "Authorization Bearer token required", status_code=401)
    license_jwt = auth_header[7:]

    payload = verify_license(license_jwt, body.device_fingerprint)
    if payload is None:
        raise AuthError("invalid_license", "License verification failed", status_code=401)

    sub_str = payload.get("sub", "")
    if not sub_str.startswith("user_id:"):
        raise AuthError("invalid_license", "Invalid license subject", status_code=401)
    user_id = int(sub_str.split(":")[1])

    subscription = _get_active_subscription(db, user_id)
    if subscription is None:
        raise AuthError("no_subscription", "Active subscription required", status_code=403)

    device = db.query(Device).filter(
        Device.device_fingerprint == body.device_fingerprint,
        Device.user_id == user_id,
    ).first()
    if not device:
        raise AuthError("device_not_bound", "Device is not bound to this account", status_code=404)

    device.last_verified = datetime.now(timezone.utc)
    device.license_jti = uuid.uuid4().hex
    db.commit()

    new_license_jwt, exp = issue_license(user_id, body.device_fingerprint, subscription.current_period_end)
    return LicenseResponse(license_jwt=new_license_jwt, expires_at=exp)
```

- [ ] **Step 3: 注册路由到 main.py**

更新 `app/main.py`：

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.errors import AuthError, auth_error_handler
from app.routers.auth_router import router as auth_router
from app.routers.device_router import router as device_router

app = FastAPI(title="Mona Auth Service", version="0.1.0")

app.add_exception_handler(AuthError, auth_error_handler)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(auth_router)
app.include_router(device_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat: add device bind/unbind/refresh/list endpoints"
```

---

### Task 11: Stripe 路由（Checkout/Webhook/Portal）

**Files:**
- Create: `/opt/mona-auth/app/routers/stripe_router.py`

- [ ] **Step 1: 编写 stripe_router.py**

```python
from datetime import datetime, timezone

import stripe
from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.models import Subscription, SubscriptionStatus, User
from app.schemas import CheckoutRequest, CheckoutResponse, PortalRequest, PortalResponse

router = APIRouter(prefix="/stripe", tags=["stripe"])

stripe.api_key = settings.stripe_secret_key


@router.post("/checkout", response_model=CheckoutResponse)
def create_checkout(body: CheckoutRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    existing_sub = (
        db.query(Subscription)
        .filter(Subscription.user_id == user.id, Subscription.status == SubscriptionStatus.ACTIVE)
        .first()
    )
    if existing_sub:
        raise AuthError("already_subscribed", "You already have an active subscription", status_code=409)

    customer = stripe.Customer.list(email=user.email, limit=1)
    if customer.data:
        customer_id = customer.data[0].id
    else:
        new_customer = stripe.Customer.create(email=user.email)
        customer_id = new_customer.id

    session = stripe.checkout.Session.create(
        customer=customer_id,
        mode="subscription",
        line_items=[{"price": settings.stripe_price_id, "quantity": 1}],
        success_url=body.success_url,
        cancel_url=body.cancel_url,
    )

    sub = Subscription(
        user_id=user.id,
        stripe_customer_id=customer_id,
        status=SubscriptionStatus.EXPIRED,
    )
    db.add(sub)
    db.commit()

    return CheckoutResponse(checkout_url=session.url)


@router.post("/portal", response_model=PortalResponse)
def create_portal(body: PortalRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sub = (
        db.query(Subscription)
        .filter(Subscription.user_id == user.id, Subscription.stripe_customer_id.isnot(None))
        .first()
    )
    if not sub or not sub.stripe_customer_id:
        raise AuthError("no_customer", "No Stripe customer found", status_code=404)

    session = stripe.billing_portal.Session.create(
        customer=sub.stripe_customer_id,
        return_url=body.return_url,
    )
    return PortalResponse(portal_url=session.url)


@router.post("/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(body, sig_header, settings.stripe_webhook_secret)
    except stripe.error.SignatureVerificationError:
        raise AuthError("invalid_signature", "Webhook signature verification failed", status_code=400)
    except Exception:
        raise AuthError("webhook_error", "Failed to parse webhook", status_code=400)

    event_type = event["type"]
    data = event["data"]["object"]

    if event_type == "checkout.session.completed":
        _handle_checkout_completed(db, data)
    elif event_type == "customer.subscription.updated":
        _handle_subscription_updated(db, data)
    elif event_type == "customer.subscription.deleted":
        _handle_subscription_deleted(db, data)
    elif event_type == "invoice.payment_failed":
        _handle_payment_failed(db, data)

    return {"received": True}


def _handle_checkout_completed(db: Session, data: dict):
    customer_id = data.get("customer")
    subscription_id = data.get("subscription")
    if not customer_id or not subscription_id:
        return

    sub = db.query(Subscription).filter(Subscription.stripe_customer_id == customer_id).first()
    if not sub:
        return

    stripe_sub = stripe.Subscription.retrieve(subscription_id)
    sub.stripe_subscription_id = subscription_id
    sub.status = SubscriptionStatus.ACTIVE
    sub.current_period_end = datetime.fromtimestamp(stripe_sub.current_period_end, tz=timezone.utc)
    db.commit()


def _handle_subscription_updated(db: Session, data: dict):
    subscription_id = data.get("id")
    if not subscription_id:
        return

    sub = db.query(Subscription).filter(Subscription.stripe_subscription_id == subscription_id).first()
    if not sub:
        return

    status_map = {
        "active": SubscriptionStatus.ACTIVE,
        "past_due": SubscriptionStatus.PAST_DUE,
        "canceled": SubscriptionStatus.CANCELED,
        "incomplete_expired": SubscriptionStatus.EXPIRED,
    }
    stripe_status = data.get("status", "")
    sub.status = status_map.get(stripe_status, SubscriptionStatus.EXPIRED)

    period_end = data.get("current_period_end")
    if period_end:
        sub.current_period_end = datetime.fromtimestamp(period_end, tz=timezone.utc)

    db.commit()


def _handle_subscription_deleted(db: Session, data: dict):
    subscription_id = data.get("id")
    if not subscription_id:
        return

    sub = db.query(Subscription).filter(Subscription.stripe_subscription_id == subscription_id).first()
    if not sub:
        return

    sub.status = SubscriptionStatus.CANCELED
    db.commit()


def _handle_payment_failed(db: Session, data: dict):
    subscription_id = data.get("subscription")
    if not subscription_id:
        return

    sub = db.query(Subscription).filter(Subscription.stripe_subscription_id == subscription_id).first()
    if not sub:
        return

    sub.status = SubscriptionStatus.PAST_DUE
    db.commit()
```

- [ ] **Step 2: 注册路由到 main.py**

更新 `app/main.py`：

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.errors import AuthError, auth_error_handler
from app.routers.auth_router import router as auth_router
from app.routers.device_router import router as device_router
from app.routers.stripe_router import router as stripe_router

app = FastAPI(title="Mona Auth Service", version="0.1.0")

app.add_exception_handler(AuthError, auth_error_handler)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(auth_router)
app.include_router(device_router)
app.include_router(stripe_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat: add Stripe checkout, webhook, and portal endpoints"
```

---

### Task 12: 限流中间件

**Files:**
- Create: `/opt/mona-auth/app/middleware.py`

- [ ] **Step 1: 编写限流中间件**

```python
from fastapi import FastAPI, Request, Response
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.middleware import SlowAPIMiddleware
from slowapi.errors import RateLimitExceeded


limiter = Limiter(key_func=get_remote_address)


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> Response:
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=429,
        content={"error": "rate_limit_exceeded", "detail": str(exc.detail)},
    )


def setup_rate_limit(app: FastAPI):
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)
```

- [ ] **Step 2: 在 main.py 中启用限流**

更新 `app/main.py`：

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.errors import AuthError, auth_error_handler
from app.middleware import setup_rate_limit
from app.routers.auth_router import router as auth_router
from app.routers.device_router import router as device_router
from app.routers.stripe_router import router as stripe_router

app = FastAPI(title="Mona Auth Service", version="0.1.0")

app.add_exception_handler(AuthError, auth_error_handler)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

setup_rate_limit(app)

app.include_router(auth_router)
app.include_router(device_router)
app.include_router(stripe_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 3: 给关键端点加限流装饰器**

更新 `app/routers/auth_router.py`，在 register 和 login 上加速率限制：

```python
from app.middleware import limiter

@router.post("/register", response_model=TokenResponse)
@limiter.limit("5/minute")
def register(request: Request, body: RegisterRequest, db: Session = Depends(get_db)):
    ...

@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
def login(request: Request, body: LoginRequest, db: Session = Depends(get_db)):
    ...
```

注意：slowapi 的 `@limiter.limit` 需要 `request: Request` 作为第一个参数。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat: add rate limiting middleware"
```

---

### Task 13: 测试

**Files:**
- Create: `/opt/mona-auth/tests/__init__.py`
- Create: `/opt/mona-auth/tests/conftest.py`
- Create: `/opt/mona-auth/tests/test_auth.py`
- Create: `/opt/mona-auth/tests/test_device.py`
- Create: `/opt/mona-auth/tests/test_license.py`

- [ ] **Step 1: 编写 conftest.py**

```python
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app


SQLALCHEMY_DATABASE_URL = "sqlite://"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client():
    return TestClient(app)
```

- [ ] **Step 2: 编写 test_auth.py**

```python
class TestRegister:
    def test_register_success(self, client):
        resp = client.post("/auth/register", json={"email": "test@example.com", "password": "test1234"})
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    def test_register_duplicate_email(self, client):
        client.post("/auth/register", json={"email": "test@example.com", "password": "test1234"})
        resp = client.post("/auth/register", json={"email": "test@example.com", "password": "test1234"})
        assert resp.status_code == 409

    def test_register_short_password(self, client):
        resp = client.post("/auth/register", json={"email": "test@example.com", "password": "short"})
        assert resp.status_code == 422


class TestLogin:
    def test_login_success(self, client):
        client.post("/auth/register", json={"email": "test@example.com", "password": "test1234"})
        resp = client.post("/auth/login", json={"email": "test@example.com", "password": "test1234"})
        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_login_wrong_password(self, client):
        client.post("/auth/register", json={"email": "test@example.com", "password": "test1234"})
        resp = client.post("/auth/login", json={"email": "test@example.com", "password": "wrong"})
        assert resp.status_code == 401

    def test_login_nonexistent_user(self, client):
        resp = client.post("/auth/login", json={"email": "no@example.com", "password": "test1234"})
        assert resp.status_code == 401
```

- [ ] **Step 3: 编写 test_license.py**

```python
from app.license import issue_license, verify_license


class TestLicense:
    def test_issue_and_verify(self):
        token, exp = issue_license(user_id=1, device_fingerprint="fp123")
        payload = verify_license(token, "fp123")
        assert payload is not None
        assert payload["sub"] == "user_id:1"
        assert payload["plan"] == "pro"

    def test_verify_wrong_fingerprint(self):
        token, _ = issue_license(user_id=1, device_fingerprint="fp123")
        payload = verify_license(token, "fp456")
        assert payload is None

    def test_verify_expired(self):
        import jwt as pyjwt
        from app.config import settings
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        payload = {
            "sub": "user_id:1",
            "fp": "abc",
            "plan": "pro",
            "exp": now - timedelta(hours=1),
            "iat": now - timedelta(hours=2),
            "jti": "test",
        }
        expired_token = pyjwt.encode(payload, settings.license_private_key, algorithm="RS256")
        result = verify_license(expired_token, "fp_not_checked_due_to_expiry")
        assert result is None
```

- [ ] **Step 4: 运行测试**

```bash
cd /opt/mona-auth
source venv/bin/activate
pip install pytest httpx
python -m pytest tests/ -v
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: add tests for auth and license"
```

---

### Task 14: 部署配置

**Files:**
- Create: `/opt/mona-auth/deploy/mona-auth.service`
- Create: `/opt/mona-auth/deploy/nginx.conf`

- [ ] **Step 1: 编写 systemd 服务文件**

```ini
# deploy/mona-auth.service
[Unit]
Description=Mona Auth Service
After=network.target mariadb.service

[Service]
User=mona
Group=mona
WorkingDirectory=/opt/mona-auth
ExecStart=/opt/mona-auth/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8901 --workers 2
Restart=always
RestartSec=5
EnvironmentFile=/opt/mona-auth/.env

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: 编写 Nginx 配置**

```nginx
# deploy/nginx.conf
server {
    listen 443 ssl http2;
    server_name mona.example.com;

    ssl_certificate     /etc/letsencrypt/live/mona.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mona.example.com/privkey.pem;

    # 用户管理页面（静态文件，后续 Task 15 实现）
    location / {
        root /var/www/mona-portal;
        try_files $uri $uri/ /index.html;
    }

    # Auth Service API
    location /auth/ {
        proxy_pass http://127.0.0.1:8901;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /stripe/ {
        proxy_pass http://127.0.0.1:8901;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check
    location /health {
        proxy_pass http://127.0.0.1:8901;
    }
}

server {
    listen 80;
    server_name mona.example.com;
    return 301 https://$host$request_uri;
}
```

- [ ] **Step 3: 编写部署脚本**

```bash
# deploy/deploy.sh
#!/bin/bash
set -e

echo "Installing mona-auth service..."
sudo cp deploy/mona-auth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mona-auth
sudo systemctl restart mona-auth

echo "Installing nginx config..."
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mona-auth
sudo ln -sf /etc/nginx/sites-available/mona-auth /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo "Done! Auth Service is running on https://mona.example.com"
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "feat: add deployment config (systemd + nginx)"
```

---

### Task 15: 用户管理页面

**Files:**
- Create: `/var/www/mona-portal/index.html`（单文件 SPA，Vue 3 CDN）

- [ ] **Step 1: 编写用户管理 SPA**

这是一个轻量单文件 SPA，使用 Vue 3 + Tailwind CDN，无需构建工具。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mona 会员中心</title>
    <script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">
<div id="app">
  <div class="max-w-md mx-auto py-12 px-4">
    <h1 class="text-2xl font-bold text-center mb-8">🐈 Mona 会员中心</h1>

    <!-- 未登录 -->
    <div v-if="!token">
      <div v-if="mode === 'login'">
        <div class="bg-white rounded-lg shadow p-6 mb-4">
          <h2 class="text-lg font-semibold mb-4">登录</h2>
          <input v-model="email" type="email" placeholder="邮箱" class="w-full border rounded px-3 py-2 mb-3" />
          <input v-model="password" type="password" placeholder="密码" class="w-full border rounded px-3 py-2 mb-4" />
          <button @click="login" class="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700">登录</button>
        </div>
        <p class="text-center text-sm text-gray-500">没有账号？<a href="#" @click.prevent="mode='register'" class="text-blue-600">注册</a></p>
      </div>

      <div v-else>
        <div class="bg-white rounded-lg shadow p-6 mb-4">
          <h2 class="text-lg font-semibold mb-4">注册</h2>
          <input v-model="email" type="email" placeholder="邮箱" class="w-full border rounded px-3 py-2 mb-3" />
          <input v-model="password" type="password" placeholder="密码（至少8位）" class="w-full border rounded px-3 py-2 mb-4" />
          <button @click="register" class="w-full bg-green-600 text-white py-2 rounded hover:bg-green-700">注册</button>
        </div>
        <p class="text-center text-sm text-gray-500">已有账号？<a href="#" @click.prevent="mode='login'" class="text-blue-600">登录</a></p>
      </div>
    </div>

    <!-- 已登录 -->
    <div v-else>
      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <h2 class="text-lg font-semibold mb-2">订阅状态</h2>
        <p v-if="subscription" class="text-sm">
          <span :class="subscription.status === 'active' ? 'text-green-600' : 'text-red-600'" class="font-medium">
            {{ subscription.status === 'active' ? '✅ 已激活' : '❌ 未激活' }}
          </span>
          <span v-if="subscription.current_period_end" class="text-gray-500 ml-2">
            到期：{{ new Date(subscription.current_period_end).toLocaleDateString() }}
          </span>
        </p>
        <p v-else class="text-sm text-gray-500">未订阅</p>
        <div class="mt-4 flex gap-2">
          <button v-if="!subscription || subscription.status !== 'active'" @click="checkout" class="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 text-sm">购买订阅</button>
          <button v-if="subscription?.stripe_customer_id" @click="portal" class="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700 text-sm">管理支付</button>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow p-6 mb-4">
        <h2 class="text-lg font-semibold mb-2">授权终端</h2>
        <div v-if="devices.length === 0" class="text-sm text-gray-500">暂无绑定设备</div>
        <div v-for="d in devices" :key="d.id" class="flex items-center justify-between py-2 border-b last:border-0">
          <div>
            <p class="text-sm font-medium">{{ d.device_name || '未命名设备' }}</p>
            <p class="text-xs text-gray-400">{{ d.device_fingerprint.slice(0, 12) }}...</p>
          </div>
          <button @click="unbind(d.device_fingerprint)" class="text-red-500 text-sm hover:text-red-700">解绑</button>
        </div>
      </div>

      <button @click="logout" class="w-full text-center text-sm text-gray-500 hover:text-gray-700 mt-4">退出登录</button>
    </div>

    <div v-if="error" class="mt-4 bg-red-50 text-red-600 text-sm rounded p-3">{{ error }}</div>
  </div>
</div>

<script>
const API = '';

const { createApp, ref, onMounted } = Vue;

createApp({
  setup() {
    const mode = ref('login');
    const email = ref('');
    const password = ref('');
    const token = ref(localStorage.getItem('mona_access_token') || '');
    const subscription = ref(null);
    const devices = ref([]);
    const error = ref('');

    const headers = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.value}` });

    async function register() {
      error.value = '';
      try {
        const resp = await fetch(`${API}/auth/register`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: email.value, password: password.value }) });
        const data = await resp.json();
        if (!resp.ok) { error.value = data.detail || data.error; return; }
        token.value = data.access_token;
        localStorage.setItem('mona_access_token', token.value);
        loadDashboard();
      } catch (e) { error.value = '网络错误'; }
    }

    async function login() {
      error.value = '';
      try {
        const resp = await fetch(`${API}/auth/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: email.value, password: password.value }) });
        const data = await resp.json();
        if (!resp.ok) { error.value = data.detail || data.error; return; }
        token.value = data.access_token;
        localStorage.setItem('mona_access_token', token.value);
        loadDashboard();
      } catch (e) { error.value = '网络错误'; }
    }

    function logout() {
      token.value = '';
      localStorage.removeItem('mona_access_token');
      subscription.value = null;
      devices.value = [];
    }

    async function loadDashboard() {
      try {
        const devResp = await fetch(`${API}/auth/device/list`, { headers: headers() });
        if (devResp.ok) devices.value = (await devResp.json()).devices;
      } catch {}
    }

    async function checkout() {
      error.value = '';
      try {
        const resp = await fetch(`${API}/stripe/checkout`, { method: 'POST', headers: headers(), body: JSON.stringify({ success_url: window.location.href, cancel_url: window.location.href }) });
        const data = await resp.json();
        if (!resp.ok) { error.value = data.detail || data.error; return; }
        window.location.href = data.checkout_url;
      } catch (e) { error.value = '网络错误'; }
    }

    async function portal() {
      error.value = '';
      try {
        const resp = await fetch(`${API}/stripe/portal`, { method: 'POST', headers: headers(), body: JSON.stringify({ return_url: window.location.href }) });
        const data = await resp.json();
        if (!resp.ok) { error.value = data.detail || data.error; return; }
        window.location.href = data.portal_url;
      } catch (e) { error.value = '网络错误'; }
    }

    async function unbind(fp) {
      error.value = '';
      try {
        const resp = await fetch(`${API}/auth/device/unbind`, { method: 'POST', headers: headers(), body: JSON.stringify({ device_fingerprint: fp }) });
        if (resp.ok) loadDashboard();
        else { const data = await resp.json(); error.value = data.detail || data.error; }
      } catch (e) { error.value = '网络错误'; }
    }

    onMounted(() => { if (token.value) loadDashboard(); });

    return { mode, email, password, token, subscription, devices, error, register, login, logout, checkout, portal, unbind };
  }
}).mount('#app');
</script>
</body>
</html>
```

- [ ] **Step 2: 部署到 Nginx**

```bash
sudo mkdir -p /var/www/mona-portal
sudo cp /opt/mona-auth/deploy/portal/index.html /var/www/mona-portal/index.html
sudo systemctl reload nginx
```

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "feat: add user portal SPA (Vue 3 CDN)"
```

---

### Task 16: 端到端验证

- [ ] **Step 1: 启动 Auth Service**

```bash
cd /opt/mona-auth
source venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 8901 &
```

- [ ] **Step 2: 测试完整流程**

```bash
# 1. 注册
TOKEN=$(curl -s -X POST http://127.0.0.1:8901/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e@test.com","password":"test1234"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "Access token: $TOKEN"

# 2. 绑定设备（应失败，因为没有订阅）
curl -s -X POST http://127.0.0.1:8901/auth/device/bind \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"device_fingerprint":"test-fp-001","device_name":"测试设备"}'
# 期望: 403 no_subscription

# 3. 查看设备列表
curl -s http://127.0.0.1:8901/auth/device/list \
  -H "Authorization: Bearer $TOKEN"
# 期望: {"devices":[]}

# 4. 健康检查
curl -s http://127.0.0.1:8901/health
# 期望: {"status":"ok"}

kill %1
```

- [ ] **Step 3: 运行全部测试**

```bash
cd /opt/mona-auth
source venv/bin/activate
python -m pytest tests/ -v
```

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "chore: e2e verification complete"
```

---

## 自检清单

| 设计文档要求 | 对应 Task |
|---|---|
| 用户注册/登录 | Task 9 |
| MariaDB 数据库表（users, subscriptions, devices） | Task 3 |
| RS256 License JWT 签发 | Task 6 |
| 设备绑定/解绑 | Task 10 |
| License 刷新（定期验证） | Task 10 |
| Stripe Checkout | Task 11 |
| Stripe Webhook | Task 11 |
| Stripe Customer Portal | Task 11 |
| 限流 | Task 12 |
| 用户管理页面 | Task 15 |
| Nginx 反代配置 | Task 14 |
| systemd 服务 | Task 14 |
| 测试 | Task 13 |
