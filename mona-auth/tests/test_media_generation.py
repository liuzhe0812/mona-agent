import sqlite3
from datetime import datetime, timedelta

import httpx
import pytest

from app.auth import create_access_token
from app.credits import grant_topup, mark_request_uncertain, reserve_request
from app.models import (
    CreditLedger,
    CreditWallet,
    ModelPrice,
    ModelRequest,
    ModelRequestStatus,
    User,
)


class UpstreamResponse:
    def __init__(self, body, status_code=200):
        self.body = body
        self.status_code = status_code

    def json(self):
        return self.body

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError(
                "upstream failed",
                request=httpx.Request("GET", "https://bailian.test"),
                response=httpx.Response(self.status_code),
            )


@pytest.fixture(autouse=True)
def enable_managed_media(monkeypatch):
    from app.routers import model_access_router

    monkeypatch.setattr(model_access_router.settings, "model_access_enabled", True)
    monkeypatch.setattr(model_access_router.settings, "one_api_token", "internal-test-token")


def _managed_media_user(db, *, units=5_000_000):
    user = User(email="media@example.com", account="media-user", password_hash="x")
    db.add(user)
    db.commit()
    db.refresh(user)
    grant_topup(db, user_id=user.id, units=units, reference_id="payment:media")
    db.commit()
    account_token, _ = create_access_token(user.id)
    return user, account_token


def _model_token(client, account_token):
    response = client.post(
        "/model-access/token",
        headers={"Authorization": f"Bearer {account_token}"},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _channel_database(tmp_path, monkeypatch, *, models):
    from app import media_generation

    path = tmp_path / "one-api.db"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE channels ("
        "id INTEGER PRIMARY KEY, base_url TEXT, key TEXT, models TEXT, "
        "status INTEGER, priority INTEGER)"
    )
    connection.execute(
        "INSERT INTO channels (id, base_url, key, models, status, priority) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            9,
            "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode",
            "stored-media-key",
            models,
            1,
            10,
        ),
    )
    connection.commit()
    connection.close()
    monkeypatch.setattr(media_generation.settings, "one_api_database_path", str(path))


def test_image_generation_reserves_then_settles_actual_images(
    client,
    db,
    tmp_path,
    monkeypatch,
):
    from app import media_generation

    user, account_token = _managed_media_user(db)
    db.add(
        ModelPrice(
            model="qwen-image-3.0",
            version=1,
            input_rate=0,
            cached_input_rate=0,
            output_rate=0,
            billing_type="image",
            rates_json={
                "qima_input_1k": 20_000,
                "qima_input_2k": 20_000,
                "qima_output_1k": 180_000,
                "qima_output_2k": 180_000,
            },
            enabled=True,
        )
    )
    db.commit()
    _channel_database(tmp_path, monkeypatch, models="qwen-image-3.0")
    post_calls = []

    def post(url, **kwargs):
        post_calls.append((url, kwargs))
        assert url.endswith("/api/v1/services/aigc/image-generation/generation")
        assert kwargs["headers"]["X-DashScope-Async"] == "enable"
        assert kwargs["json"]["parameters"]["n"] == 2
        return UpstreamResponse(
            {"output": {"task_id": "image-task-1", "task_status": "PENDING"}}
        )

    def get(url, **kwargs):
        assert url.endswith("/api/v1/tasks/image-task-1")
        return UpstreamResponse(
            {
                "output": {
                    "task_id": "image-task-1",
                    "task_status": "SUCCEEDED",
                    "choices": [
                        {
                            "message": {
                                "content": [{"image": "https://result.example/image.png"}]
                            }
                        }
                    ],
                },
                "usage": {
                    "input_image_count": 0,
                    "input_image_type": "qima_input_1k",
                    "output_image_count": 1,
                    "output_image_type": "qima_output_1k",
                    "output_width": 1024,
                    "output_height": 1024,
                },
            }
        )

    monkeypatch.setattr(media_generation.httpx, "post", post)
    monkeypatch.setattr(media_generation.httpx, "get", get)
    model_token = _model_token(client, account_token)
    headers = {
        "Authorization": f"Bearer {model_token}",
        "X-Request-ID": "media-image-0001",
    }
    body = {
        "model": "qwen-image-3.0",
        "prompt": "一只白猫",
        "size": "1024*1024",
        "n": 2,
    }

    created = client.post("/v1/media/generations", headers=headers, json=body)
    duplicate = client.post("/v1/media/generations", headers=headers, json=body)
    assert created.status_code == 202
    assert duplicate.status_code == 202
    assert len(post_calls) == 1
    request = db.get(ModelRequest, "media-image-0001")
    assert request.status == ModelRequestStatus.RUNNING
    assert request.reserved_units == 360_000
    request.last_polled_at = datetime.utcnow() - timedelta(seconds=5)
    db.commit()

    completed = client.get(
        "/v1/media/generations/media-image-0001",
        headers={"Authorization": f"Bearer {model_token}"},
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "succeeded"
    assert completed.json()["spent_amount"] == "0.18"
    assert completed.json()["result"]["assets"] == [
        {"index": 0, "url": "/v1/media/generations/media-image-0001/assets/0"}
    ]
    assert "result.example" not in completed.text
    from app.routers import model_access_router

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        model_access_router.httpx,
        "AsyncClient",
        lambda **kwargs: real_client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    content=b"png-bytes",
                    headers={"content-type": "image/png"},
                )
            ),
            **kwargs,
        ),
    )
    asset = client.get(
        "/v1/media/generations/media-image-0001/assets/0",
        headers={"Authorization": f"Bearer {model_token}"},
    )
    assert asset.status_code == 200
    assert asset.content == b"png-bytes"
    assert asset.headers["cache-control"] == "private, no-store"
    db.expire_all()
    wallet = db.get(CreditWallet, user.id)
    request = db.get(ModelRequest, "media-image-0001")
    assert (wallet.available_units, wallet.reserved_units) == (4_820_000, 0)
    assert request.actual_units == 180_000
    ledger = db.query(CreditLedger).filter(CreditLedger.reference_id == request.request_id).one()
    assert ledger.metadata_json["billing_type"] == "image"
    assert ledger.metadata_json["output_image_count"] == 1


def test_video_generation_failure_releases_reservation(
    client,
    db,
    tmp_path,
    monkeypatch,
):
    from app import media_generation

    user, account_token = _managed_media_user(db)
    db.add(
        ModelPrice(
            model="wan2.6-t2v",
            version=1,
            input_rate=0,
            cached_input_rate=0,
            output_rate=0,
            billing_type="video",
            rates_json={
                "video_ratio_720p": 600_000,
                "video_ratio_1080p": 1_000_000,
            },
            enabled=True,
        )
    )
    db.commit()
    _channel_database(tmp_path, monkeypatch, models="wan2.6-t2v")
    monkeypatch.setattr(
        media_generation.httpx,
        "post",
        lambda *args, **kwargs: UpstreamResponse(
            {"output": {"task_id": "video-task-1", "task_status": "PENDING"}}
        ),
    )
    monkeypatch.setattr(
        media_generation.httpx,
        "get",
        lambda *args, **kwargs: UpstreamResponse(
            {
                "output": {
                    "task_id": "video-task-1",
                    "task_status": "FAILED",
                    "code": "InvalidParameter",
                }
            }
        ),
    )
    model_token = _model_token(client, account_token)
    created = client.post(
        "/v1/media/generations",
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "media-video-0001",
        },
        json={
            "model": "wan2.6-t2v",
            "prompt": "海边日落",
            "resolution": "720P",
            "duration": 5,
        },
    )
    assert created.status_code == 202
    request = db.get(ModelRequest, "media-video-0001")
    assert request.reserved_units == 3_000_000
    request.last_polled_at = datetime.utcnow() - timedelta(seconds=5)
    db.commit()

    failed = client.get(
        "/v1/media/generations/media-video-0001",
        headers={"Authorization": f"Bearer {model_token}"},
    )
    assert failed.status_code == 200
    assert failed.json()["status"] == "failed"
    db.expire_all()
    wallet = db.get(CreditWallet, user.id)
    assert (wallet.available_units, wallet.reserved_units) == (5_000_000, 0)


def test_media_request_id_payload_change_is_rejected(client, db, tmp_path, monkeypatch):
    from app import media_generation

    _, account_token = _managed_media_user(db)
    db.add(
        ModelPrice(
            model="qwen-image-3.0-pro",
            version=1,
            input_rate=0,
            cached_input_rate=0,
            output_rate=0,
            billing_type="image",
            rates_json={"qima_output_1k": 250_000},
            enabled=True,
        )
    )
    db.commit()
    _channel_database(tmp_path, monkeypatch, models="qwen-image-3.0-pro")
    monkeypatch.setattr(
        media_generation.httpx,
        "post",
        lambda *args, **kwargs: UpstreamResponse(
            {"output": {"task_id": "image-task-2", "task_status": "PENDING"}}
        ),
    )
    model_token = _model_token(client, account_token)
    headers = {
        "Authorization": f"Bearer {model_token}",
        "X-Request-ID": "media-image-0002",
    }
    first = client.post(
        "/v1/media/generations",
        headers=headers,
        json={"model": "qwen-image-3.0-pro", "prompt": "第一张"},
    )
    changed = client.post(
        "/v1/media/generations",
        headers=headers,
        json={"model": "qwen-image-3.0-pro", "prompt": "第二张"},
    )
    assert first.status_code == 202
    assert changed.status_code == 409


def test_video_generation_settles_actual_seconds(client, db, tmp_path, monkeypatch):
    from app import media_generation

    user, account_token = _managed_media_user(db)
    db.add(
        ModelPrice(
            model="wan2.6-t2v",
            version=1,
            input_rate=0,
            cached_input_rate=0,
            output_rate=0,
            billing_type="video",
            rates_json={"video_ratio_720p": 600_000},
            enabled=True,
        )
    )
    db.commit()
    _channel_database(tmp_path, monkeypatch, models="wan2.6-t2v")
    monkeypatch.setattr(
        media_generation.httpx,
        "post",
        lambda *args, **kwargs: UpstreamResponse(
            {"output": {"task_id": "video-task-2", "task_status": "PENDING"}}
        ),
    )
    monkeypatch.setattr(
        media_generation.httpx,
        "get",
        lambda *args, **kwargs: UpstreamResponse(
            {
                "output": {
                    "task_id": "video-task-2",
                    "task_status": "SUCCEEDED",
                    "video_url": "https://result.example/video.mp4",
                },
                "usage": {"duration": 4.5, "SR": "720P", "video_count": 1},
            }
        ),
    )
    model_token = _model_token(client, account_token)
    created = client.post(
        "/v1/media/generations",
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "media-video-0002",
        },
        json={
            "model": "wan2.6-t2v",
            "prompt": "海边日落",
            "resolution": "720P",
            "duration": 5,
        },
    )
    assert created.status_code == 202
    request = db.get(ModelRequest, "media-video-0002")
    assert request.reserved_units == 3_000_000
    request.last_polled_at = datetime.utcnow() - timedelta(seconds=5)
    db.commit()

    completed = client.get(
        "/v1/media/generations/media-video-0002",
        headers={"Authorization": f"Bearer {model_token}"},
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "succeeded"
    assert completed.json()["spent_amount"] == "2.7"
    db.expire_all()
    wallet = db.get(CreditWallet, user.id)
    assert (wallet.available_units, wallet.reserved_units) == (2_300_000, 0)


def test_insufficient_media_balance_never_calls_upstream(client, db, tmp_path, monkeypatch):
    from app import media_generation

    _, account_token = _managed_media_user(db, units=100_000)
    db.add(
        ModelPrice(
            model="qwen-image-3.0",
            version=1,
            input_rate=0,
            cached_input_rate=0,
            output_rate=0,
            billing_type="image",
            rates_json={"qima_output_1k": 180_000},
            enabled=True,
        )
    )
    db.commit()
    _channel_database(tmp_path, monkeypatch, models="qwen-image-3.0")
    called = False

    def post(*args, **kwargs):
        nonlocal called
        called = True
        return UpstreamResponse({})

    monkeypatch.setattr(media_generation.httpx, "post", post)
    model_token = _model_token(client, account_token)
    response = client.post(
        "/v1/media/generations",
        headers={
            "Authorization": f"Bearer {model_token}",
            "X-Request-ID": "media-image-low-balance",
        },
        json={"model": "qwen-image-3.0", "prompt": "白猫"},
    )
    assert response.status_code == 402
    assert called is False


def test_admin_can_resolve_uncertain_media_amount(client, db):
    admin = User(
        email="media-admin@example.com",
        account="media-admin",
        password_hash="x",
        is_admin=True,
    )
    user = User(email="media-settle@example.com", account="media-settle", password_hash="x")
    db.add_all([admin, user])
    db.commit()
    db.add(
        ModelPrice(
            model="qwen-image-3.0",
            version=1,
            input_rate=0,
            cached_input_rate=0,
            output_rate=0,
            billing_type="image",
            rates_json={"qima_output_1k": 180_000},
            enabled=False,
        )
    )
    grant_topup(db, user_id=user.id, units=1_000_000, reference_id="media-admin-topup")
    reserve_request(
        db,
        request_id="media-admin-uncertain",
        user_id=user.id,
        model="qwen-image-3.0",
        reserved_units=250_000,
        price_version=1,
        billing_type="image",
        request_hash="a" * 64,
    )
    db.commit()
    mark_request_uncertain(
        db,
        request_id="media-admin-uncertain",
        error_code="missing_usage",
    )
    db.commit()
    admin_token, _ = create_access_token(admin.id)

    response = client.post(
        "/admin/credits/requests/media-admin-uncertain/resolve",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "action": "settle",
            "actual_units": 180_000,
            "usage": {"output_image_count": 1, "output_image_type": "qima_output_1k"},
            "reason": "已向百炼账单核实",
        },
    )
    assert response.status_code == 200
    request = db.get(ModelRequest, "media-admin-uncertain")
    wallet = db.get(CreditWallet, user.id)
    assert request.status == ModelRequestStatus.SETTLED
    assert (wallet.available_units, wallet.reserved_units) == (820_000, 0)


def test_admin_can_version_media_rates(client, db):
    admin = User(
        email="media-rate-admin@example.com",
        account="media-rate-admin",
        password_hash="x",
        is_admin=True,
    )
    db.add(admin)
    db.commit()
    token, _ = create_access_token(admin.id)
    headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/admin/credits/model-prices",
        headers=headers,
        json={
            "model": "qwen-image-3.0-pro",
            "input_rate": 0,
            "cached_input_rate": 0,
            "output_rate": 0,
            "billing_type": "image",
            "rates": {
                "qima_input_1k": 26_000,
                "qima_output_1k": 325_000,
                "qima_output_2k": 650_000,
            },
            "enabled": True,
        },
    )
    listed = client.get("/admin/credits/model-prices", headers=headers)

    assert created.status_code == 200
    assert created.json()["billing_type"] == "image"
    price = listed.json()["prices"][0]
    assert price["billing_type"] == "image"
    assert price["rate_amounts"] == {
        "qima_input_1k": "0.026",
        "qima_output_1k": "0.325",
        "qima_output_2k": "0.65",
    }
