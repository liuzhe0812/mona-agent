from datetime import datetime, timedelta, timezone

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
    from app.config import settings

    previous_secret = settings.jwt_access_secret
    settings.jwt_access_secret = "test-secret-at-least-thirty-two-characters"
    Base.metadata.create_all(bind=engine)
    # 重置 rate limiter 状态，避免测试间互相干扰
    from app.middleware import reset_limiter_state

    reset_limiter_state()
    yield
    Base.metadata.drop_all(bind=engine)
    settings.jwt_access_secret = previous_secret
    from app.middleware import reset_limiter_state

    reset_limiter_state()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def register_and_get_token(client, db):
    """Register a test user using the current verification-code contract."""

    def _register(
        *,
        email: str = "test@example.com",
        account: str = "testuser",
        password: str = "test1234",
        device_fingerprint: str = "",
    ) -> str:
        db.add(
            PasswordResetCode(
                email=email,
                code="123456",
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
            )
        )
        db.commit()
        params = {"device_fingerprint": device_fingerprint} if device_fingerprint else None
        response = client.post(
            "/auth/register",
            params=params,
            json={
                "email": email,
                "password": password,
                "code": "123456",
                "account": account,
            },
        )
        assert response.status_code == 200, response.text
        return response.json()["access_token"]

    from app.models import PasswordResetCode

    return _register


@pytest.fixture(autouse=True)
def license_keys(tmp_path, monkeypatch):
    """Give License tests an isolated RSA key pair instead of production paths."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    from app.config import settings

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    private_path = tmp_path / "private.pem"
    public_path = tmp_path / "public.pem"
    private_path.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    public_path.write_bytes(
        public_key.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    monkeypatch.setattr(settings, "license_private_key_path", str(private_path))
    monkeypatch.setattr(settings, "license_public_key_path", str(public_path))


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
