import sqlite3

from app.auth import create_access_token
from app.config import settings
from app.models import User
from app.routers import admin_gateway_router


class OneApiResponse:
    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


def _admin_headers(db):
    admin = User(
        email="gateway-admin@example.com",
        account="gateway-admin",
        password_hash="x",
        is_admin=True,
    )
    db.add(admin)
    db.commit()
    token, _ = create_access_token(admin.id)
    return {"Authorization": f"Bearer {token}"}


def test_admin_manages_gateway_channels_without_returning_keys(client, db, monkeypatch):
    headers = _admin_headers(db)
    monkeypatch.setattr(settings, "one_api_admin_token", "admin-access-token")
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if method == "GET" and url.endswith("/api/channel/search"):
            return OneApiResponse(
                {
                    "success": True,
                    "data": [
                        {
                            "id": 7,
                            "name": "deepseek-primary",
                            "type": 36,
                            "key": "must-never-be-returned",
                            "status": 1,
                            "base_url": "https://api.deepseek.com",
                            "models": "deepseek-chat",
                            "group": "managed",
                            "priority": 10,
                            "response_time": 250,
                            "test_time": 123,
                        }
                    ],
                }
            )
        return OneApiResponse({"success": True, "data": {}})

    monkeypatch.setattr(admin_gateway_router.httpx, "request", request)

    listed = client.get("/admin/gateway/channels", headers=headers)
    created = client.post(
        "/admin/gateway/channels",
        headers=headers,
        json={
            "name": "deepseek-secondary",
            "channel_type": 36,
            "api_key": "sk-new-channel-key",
            "base_url": "https://api.deepseek.com",
            "models": "deepseek-chat, deepseek-reasoner",
            "group": "managed",
            "priority": 5,
            "enabled": False,
        },
    )
    updated = client.put(
        "/admin/gateway/channels/7",
        headers=headers,
        json={
            "name": "deepseek-primary",
            "channel_type": 36,
            "api_key": None,
            "base_url": "https://api.deepseek.com",
            "models": "deepseek-chat",
            "group": "managed",
            "priority": 10,
            "enabled": True,
        },
    )
    tested = client.post("/admin/gateway/channels/7/test", headers=headers)
    deleted = client.delete("/admin/gateway/channels/7", headers=headers)

    assert listed.status_code == 200
    assert listed.json() == {
        "channels": [
            {
                "id": 7,
                "name": "deepseek-primary",
                "channel_type": 36,
                "enabled": True,
                "status": 1,
                "base_url": "https://api.deepseek.com",
                "models": "deepseek-chat",
                "group": "managed",
                "priority": 10,
                "response_time": 250,
                "test_time": 123,
                "key_configured": True,
            }
        ]
    }
    assert "must-never-be-returned" not in listed.text
    assert "weight" not in listed.json()["channels"][0]
    assert created.status_code == 200
    assert updated.status_code == 200
    assert tested.json()["healthy"] is True
    assert deleted.json()["deleted"] is True
    create_payload = next(call[2]["json"] for call in calls if call[0] == "POST")
    update_payload = next(call[2]["json"] for call in calls if call[0] == "PUT")
    assert create_payload["key"] == "sk-new-channel-key"
    assert create_payload["models"] == "deepseek-chat,deepseek-reasoner"
    assert create_payload["status"] == 2
    assert update_payload["key"] == ""


def test_bailian_compatible_channels_use_one_api_openai_protocol(client, db, monkeypatch):
    headers = _admin_headers(db)
    monkeypatch.setattr(settings, "one_api_admin_token", "admin-access-token")
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if method == "GET" and url.endswith("/api/channel/search"):
            return OneApiResponse(
                {
                    "success": True,
                    "data": [
                        {
                            "id": 9,
                            "name": "阿里云百炼",
                            "type": 8,
                            "status": 1,
                            "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode",
                            "models": "qwen3.8-max",
                            "group": "managed",
                            "priority": 0,
                        }
                    ],
                }
            )
        return OneApiResponse({"success": True, "data": {}})

    monkeypatch.setattr(admin_gateway_router.httpx, "request", request)
    created = client.post(
        "/admin/gateway/channels",
        headers=headers,
        json={
            "name": "阿里云百炼",
            "channel_type": 17,
            "api_key": "stored-bailian-key",
            "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            "models": "qwen3.8-max",
            "group": "managed",
            "priority": 0,
            "enabled": True,
        },
    )
    listed = client.get("/admin/gateway/channels", headers=headers)

    assert created.status_code == 200
    create_payload = next(call[2]["json"] for call in calls if call[0] == "POST")
    assert create_payload["type"] == 8
    assert create_payload["base_url"] == (
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode"
    )
    assert listed.json()["channels"][0]["channel_type"] == 17
    assert listed.json()["channels"][0]["base_url"] == (
        "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    )


def test_channel_test_uses_an_explicit_model_and_preserves_one_api_error(client, db, monkeypatch):
    headers = _admin_headers(db)
    monkeypatch.setattr(settings, "one_api_admin_token", "admin-access-token")
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if url.endswith("/api/channel/17"):
            return OneApiResponse({
                "success": True,
                "data": {"id": 17, "models": "qwen3.7-plus,qwen3-coder-plus"},
            })
        if url.endswith("/api/channel/test/17"):
            return OneApiResponse({
                "success": False,
                "message": "百炼 API Key 无效或模型无权限",
            })
        raise AssertionError(url)

    monkeypatch.setattr(admin_gateway_router.httpx, "request", request)
    response = client.post("/admin/gateway/channels/17/test", headers=headers)

    assert response.status_code == 502
    assert response.json() == {
        "error": "gateway_rejected",
        "detail": "One API：百炼 API Key 无效或模型无权限",
    }
    test_call = next(call for call in calls if call[1].endswith("/api/channel/test/17"))
    assert test_call[2]["params"] == {"model": "qwen3.7-plus"}


def test_media_channel_test_uses_catalog_without_paid_generation(
    client,
    db,
    monkeypatch,
    tmp_path,
):
    headers = _admin_headers(db)
    one_api_db = tmp_path / "one-api.db"
    connection = sqlite3.connect(one_api_db)
    connection.execute("CREATE TABLE channels (id INTEGER PRIMARY KEY, key TEXT NOT NULL)")
    connection.execute("INSERT INTO channels (id, key) VALUES (?, ?)", (19, "media-key"))
    connection.commit()
    connection.close()
    monkeypatch.setattr(settings, "one_api_database_path", str(one_api_db))
    monkeypatch.setattr(settings, "one_api_admin_token", "admin-access-token")
    one_api_calls = []

    def request(method, url, **kwargs):
        one_api_calls.append((method, url, kwargs))
        assert url.endswith("/api/channel/19")
        return OneApiResponse(
            {
                "success": True,
                "data": {
                    "id": 19,
                    "type": 8,
                    "base_url": "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode",
                    "models": "qwen-image-3.0-pro",
                },
            }
        )

    def get(url, **kwargs):
        assert url.endswith("/compatible-mode/v1/models")
        assert kwargs["headers"]["Authorization"] == "Bearer media-key"
        return OneApiResponse({"data": [{"id": "qwen-image-3.0-pro"}]})

    monkeypatch.setattr(admin_gateway_router.httpx, "request", request)
    monkeypatch.setattr(admin_gateway_router.httpx, "get", get)
    response = client.post("/admin/gateway/channels/19/test", headers=headers)

    assert response.status_code == 200
    assert response.json()["test_mode"] == "catalog"
    assert len(one_api_calls) == 1


def test_gateway_admin_rejects_unsafe_or_unconfigured_requests(client, db, monkeypatch):
    headers = _admin_headers(db)
    monkeypatch.setattr(settings, "one_api_admin_token", "")

    unavailable = client.get("/admin/gateway/channels", headers=headers)
    unsafe = client.post(
        "/admin/gateway/channels",
        headers=headers,
        json={
            "name": "unsafe",
            "channel_type": 8,
            "api_key": "unsafe-key",
            "base_url": "http://example.com/v1",
            "models": "model-a",
            "enabled": False,
        },
    )

    assert unavailable.status_code == 503
    assert unsafe.status_code == 422


def test_admin_discovers_provider_models_without_returning_key(client, db, monkeypatch):
    headers = _admin_headers(db)
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return OneApiResponse(
            {
                "data": [
                    {"id": "qwen3.8-max"},
                    {"id": "deepseek-v4-pro"},
                    {"id": "qwen3.8-max"},
                ]
            }
        )

    monkeypatch.setattr(admin_gateway_router.httpx, "get", get)
    response = client.post(
        "/admin/gateway/channels/models",
        headers=headers,
        json={
            "channel_type": 8,
            "api_key": "sk-bailian-test-key",
            "base_url": "https://coding.dashscope.aliyuncs.com",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"models": ["qwen3.8-max", "deepseek-v4-pro"]}
    assert calls[0][0] == "https://coding.dashscope.aliyuncs.com/v1/models"
    assert calls[0][1]["headers"]["Authorization"] == "Bearer sk-bailian-test-key"
    assert "sk-bailian-test-key" not in response.text

    rejected = client.post(
        "/admin/gateway/channels/models",
        headers=headers,
        json={
            "channel_type": 8,
            "api_key": "sk-custom-test-key",
            "base_url": "https://127.0.0.1/v1",
        },
    )
    assert rejected.status_code == 422


def test_admin_reuses_stored_channel_key_without_returning_it(
    client,
    db,
    monkeypatch,
    tmp_path,
):
    headers = _admin_headers(db)
    one_api_db = tmp_path / "one-api.db"
    connection = sqlite3.connect(one_api_db)
    connection.execute("CREATE TABLE channels (id INTEGER PRIMARY KEY, key TEXT NOT NULL)")
    connection.execute(
        "INSERT INTO channels (id, key) VALUES (?, ?)",
        (7, "stored-channel-key"),
    )
    connection.commit()
    connection.close()
    monkeypatch.setattr(settings, "one_api_database_path", str(one_api_db))
    monkeypatch.setattr(settings, "one_api_admin_token", "admin-access-token")

    def request(method, url, **kwargs):
        assert method == "GET"
        assert url.endswith("/api/channel/7")
        return OneApiResponse(
            {
                "success": True,
                "data": {
                    "id": 7,
                    "type": 8,
                    "base_url": "https://coding.dashscope.aliyuncs.com",
                },
            }
        )

    def get(url, **kwargs):
        assert url == "https://coding.dashscope.aliyuncs.com/v1/models"
        assert kwargs["headers"]["Authorization"] == "Bearer stored-channel-key"
        return OneApiResponse({"data": [{"id": "qwen3.7-plus"}]})

    monkeypatch.setattr(admin_gateway_router.httpx, "request", request)
    monkeypatch.setattr(admin_gateway_router.httpx, "get", get)
    response = client.post(
        "/admin/gateway/channels/models",
        headers=headers,
        json={
            "channel_id": 7,
            "channel_type": 8,
            "api_key": None,
            "base_url": "https://coding.dashscope.aliyuncs.com",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"models": ["qwen3.7-plus"]}
    assert "stored-channel-key" not in response.text


def test_admin_fetches_bailian_official_price_and_rejects_coding_plan(
    client,
    db,
    monkeypatch,
    tmp_path,
):
    headers = _admin_headers(db)
    one_api_db = tmp_path / "one-api.db"
    connection = sqlite3.connect(one_api_db)
    connection.execute("CREATE TABLE channels (id INTEGER PRIMARY KEY, key TEXT NOT NULL)")
    connection.execute(
        "INSERT INTO channels (id, key) VALUES (?, ?)",
        (9, "stored-bailian-key"),
    )
    connection.commit()
    connection.close()
    monkeypatch.setattr(settings, "one_api_database_path", str(one_api_db))
    monkeypatch.setattr(settings, "one_api_admin_token", "admin-access-token")
    channel_base = {
        "value": "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    }
    get_calls = []

    def request(method, url, **kwargs):
        assert method == "GET"
        assert url.endswith("/api/channel/9")
        return OneApiResponse(
            {
                "success": True,
                "data": {
                    "id": 9,
                    "name": "bailian-general",
                    "type": 8,
                    "base_url": channel_base["value"],
                },
            }
        )

    def get(url, **kwargs):
        get_calls.append((url, kwargs))
        return OneApiResponse(
            {
                "success": True,
                "output": {
                    "models": [
                        {
                            "model": "qwen3.7-plus",
                            "model_info": {"context_window": 1_000_000},
                            "prices": [
                                {
                                    "range_name": "Input<=256k",
                                    "prices": [
                                        {"type": "input_token", "price": "2", "price_unit": "每百万tokens"},
                                        {"type": "cache_input_token", "price": "0.4", "price_unit": "每百万tokens"},
                                        {"type": "output_token", "price": "8", "price_unit": "每百万tokens"},
                                    ],
                                },
                                {
                                    "range_name": "256k<Input<=1m",
                                    "prices": [
                                        {"type": "input_token", "price": "6", "price_unit": "每百万tokens"},
                                        {"type": "cache_input_token", "price": "1.2", "price_unit": "每百万tokens"},
                                        {"type": "output_token", "price": "24", "price_unit": "每百万tokens"},
                                    ],
                                },
                            ],
                        }
                    ]
                },
            }
        )

    monkeypatch.setattr(admin_gateway_router.httpx, "request", request)
    monkeypatch.setattr(admin_gateway_router.httpx, "get", get)
    response = client.get(
        "/admin/gateway/channels/9/official-price",
        params={"model": "qwen3.7-plus"},
        headers=headers,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["model"] == "qwen3.7-plus"
    assert payload["safe_cost"] == {
        "input_amount_per_million": "6",
        "cached_input_amount_per_million": "1.2",
        "output_amount_per_million": "24",
    }
    assert len(payload["tiers"]) == 2
    assert payload["context_window"] == 1_000_000
    assert get_calls[0][0] == "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/models"
    assert get_calls[0][1]["params"]["model"] == "qwen3.7-plus"
    assert get_calls[0][1]["headers"]["Authorization"] == "Bearer stored-bailian-key"
    assert "stored-bailian-key" not in response.text

    channel_base["value"] = "https://coding.dashscope.aliyuncs.com/v1"
    rejected = client.get(
        "/admin/gateway/channels/9/official-price",
        params={"model": "qwen3.7-plus"},
        headers=headers,
    )
    assert rejected.status_code == 422
    assert len(get_calls) == 1


def test_bailian_official_price_ignores_explicit_cache_pricing():
    for automatic_hit, explicit_creation, explicit_read in (
        ("0.1", "1.25", "0.1"),
        ("1.5", "15", "1"),
    ):
        payload = admin_gateway_router._official_price_payload(
            {
                "model": "qwen-cache-model",
                "prices": [
                    {
                        "range_name": "Default",
                        "prices": [
                            {
                                "type": "input_token",
                                "price_name": "输入",
                                "price": "0.8",
                                "price_unit": "每百万tokens",
                            },
                            {
                                "type": "input_token_cache",
                                "price_name": "输入（缓存命中）",
                                "price": automatic_hit,
                                "price_unit": "每百万tokens",
                            },
                            {
                                "type": "input_token_cache_creation_5m",
                                "price_name": "显式缓存创建",
                                "price": explicit_creation,
                                "price_unit": "每百万tokens",
                            },
                            {
                                "type": "input_token_cache_read",
                                "price_name": "显式缓存命中",
                                "price": explicit_read,
                                "price_unit": "每百万tokens",
                            },
                            {
                                "type": "output_token",
                                "price_name": "输出",
                                "price": "2.7",
                                "price_unit": "每百万tokens",
                            },
                        ],
                    }
                ],
            }
        )

        assert payload["safe_cost"]["cached_input_amount_per_million"] == automatic_hit


def test_bailian_official_price_supports_image_and_video_units():
    image = admin_gateway_router._official_price_payload(
        {
            "model": "qwen-image-3.0-pro",
            "prices": [
                {
                    "range_name": "Default",
                    "prices": [
                        {
                            "type": "qima_input_1k",
                            "price_name": "1K图片输入",
                            "price": "0.02",
                            "price_unit": "每张",
                        },
                        {
                            "type": "qima_output_1k",
                            "price_name": "1K图片生成",
                            "price": "0.25",
                            "price_unit": "每张",
                        },
                    ],
                }
            ],
        }
    )
    video = admin_gateway_router._official_price_payload(
        {
            "model": "wan2.6-t2v",
            "prices": [
                {
                    "range_name": "Default",
                    "prices": [
                        {
                            "type": "video_ratio_720p",
                            "price_name": "视频生成（720P）",
                            "price": "0.6",
                            "price_unit": "每秒",
                        },
                        {
                            "type": "video_ratio_1080p",
                            "price_name": "视频生成（1080P）",
                            "price": "1",
                            "price_unit": "每秒",
                        },
                    ],
                }
            ],
        }
    )

    assert image["billing_type"] == "image"
    assert image["price_items"][1] == {
        "key": "qima_output_1k",
        "label": "1K图片生成",
        "amount": "0.25",
        "unit": "每张",
        "range_name": "Default",
    }
    assert image["safe_cost"] == {}
    assert video["billing_type"] == "video"
    assert [item["key"] for item in video["price_items"]] == [
        "video_ratio_720p",
        "video_ratio_1080p",
    ]
