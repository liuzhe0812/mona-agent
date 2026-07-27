import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import User

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
    # 重置 rate limiter 状态，避免测试间互相干扰
    from app.middleware import reset_limiter_state
    reset_limiter_state()
    yield
    Base.metadata.drop_all(bind=engine)
    from app.middleware import reset_limiter_state
    reset_limiter_state()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def admin_user(client, db):
    from datetime import datetime, timedelta, timezone

    from app.models import PasswordResetCode

    email = "admin@example.com"
    code = "123456"
    db.add(
        PasswordResetCode(
            email=email,
            code=code,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
        )
    )
    db.commit()

    resp = client.post(
        "/auth/register",
        json={"email": email, "password": "admin123", "code": code, "account": "adminuser"},
    )
    assert resp.status_code == 200

    user = db.query(User).filter(User.email == email).first()
    user.is_admin = True
    db.commit()
    db.refresh(user)
    return user
