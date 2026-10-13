import hashlib
from types import SimpleNamespace

import httpx
import pytest

import mona.cloud.transport as transport
from mona.cloud.coordinator import CloudCoordinator
from mona.cloud.crypto import VaultCipher
from mona.cloud.local_state import LocalCloudStore
from mona.cloud.transfer import CloudTransferError, WorkTransfer
from mona.cloud.transport import BridgeCloudTransport

BINDING = "a" * 64


def test_control_forwards_only_bound_metadata_not_account_credentials(monkeypatch):
    captured = []
    def invoke(command, args, **kwargs):
        captured.append((command, args))
        return {"status": 200, "data": {"exists": False}}
    monkeypatch.setattr(transport, "tauri_invoke", invoke)
    client = BridgeCloudTransport(BINDING)
    assert client.control("GET", "/space") == {"exists": False}
    command, args = captured[0]
    assert command == "cloud_sync_request" and args["binding"] == BINDING
    assert "token" not in args and "authorization" not in args


@pytest.mark.parametrize("method,path", [
    ("GET", "/cleanup"), ("POST", "/cleanup"),
    ("GET", "/retention"), ("POST", "/retention"),
    ("GET", "/trash"), ("GET", "/trash?before=10"), ("GET", "/usage?period=2026-10"),
    ("POST", "/trash/preview"), ("POST", "/trash/apply"),
])
def test_confirmed_management_routes_reach_the_authenticated_native_bridge(monkeypatch, method, path):
    captured = []
    def invoke(command, args, **kwargs):
        captured.append(args)
        return {"status": 200, "data": {"complete": True}}
    monkeypatch.setattr(transport, "tauri_invoke", invoke)
    payload = {"confirmed": True} if method == "POST" else None
    assert BridgeCloudTransport(BINDING).control(method, path, payload) == {"complete": True}
    assert captured == [{"binding": BINDING, "method": method, "path": path, "payload": payload}]


@pytest.mark.parametrize("method,path", [
    ("GET", "/trash/apply"), ("POST", "/trash"), ("POST", "/changes"),
    ("GET", "/resources/commit"), ("POST", "/cleanup?all=1"),
    ("GET", "/retention?user_id=1"), ("GET", "/trash?before=1&before=2"),
    ("GET", "/changes?after=" + "1" * 256 + "&limit=1"),
])
def test_management_routes_reject_wrong_methods_queries_and_oversized_paths(monkeypatch, method, path):
    monkeypatch.setattr(transport, "tauri_invoke", lambda *a, **k: pytest.fail("IPC must not be called"))
    with pytest.raises(CloudTransferError) as error:
        BridgeCloudTransport(BINDING).control(method, path)
    assert error.value.code == "invalid_request"


@pytest.mark.parametrize("path", ["https://evil.invalid", "/../../auth", "/space#fragment", "/changes?after=x&limit=1"])
def test_control_rejects_unbounded_routes_before_ipc(monkeypatch, path):
    monkeypatch.setattr(transport, "tauri_invoke", lambda *a, **k: pytest.fail("IPC must not be called"))
    with pytest.raises(CloudTransferError):
        BridgeCloudTransport(BINDING).control("GET", path)


def test_malformed_server_error_is_not_treated_as_success(monkeypatch):
    monkeypatch.setattr(transport, "tauri_invoke", lambda *a, **k: {"status": 503, "data": {"error": {"internal": "detail"}}})
    with pytest.raises(CloudTransferError) as error:
        BridgeCloudTransport(BINDING).control("GET", "/space")
    assert error.value.code == "sync_unavailable"
    assert "internal" not in str(error.value)


def test_expired_download_explains_renewal_without_exposing_server_details(monkeypatch):
    monkeypatch.setattr(transport, "tauri_invoke", lambda *a, **k: {
        "status": 403, "data": {"error": "cloud_download_expired", "detail": "internal-server-details"}})
    with pytest.raises(CloudTransferError) as error:
        BridgeCloudTransport(BINDING).control("POST", "/objects/" + "b" * 64 + "/download")
    assert error.value.code == "cloud_download_expired"
    assert "续订 Pro" in str(error.value) and "internal" not in str(error.value)


@pytest.mark.parametrize("url,upload", [
    ("http://files.qiniup.com", True), ("https://untrusted.invalid", True),
    ("https://files.qiniup.com/private?x=1", True), ("https://user:password@example.invalid", False),
    ("https://example.invalid/#fragment", False),
])
def test_storage_endpoint_shape_is_checked_before_dns(url, upload):
    with pytest.raises(CloudTransferError):
        BridgeCloudTransport._url(url, upload=upload)


def test_storage_dns_guard_is_used_and_denies_internal_address(monkeypatch):
    checked = []
    def validate(url):
        checked.append(url)
        return False, "internal address"
    monkeypatch.setattr(transport, "validate_url_target", validate)
    with pytest.raises(CloudTransferError):
        BridgeCloudTransport._url("https://files.example.invalid/data", upload=False)
    assert checked == ["https://files.example.invalid/data"]


def mock_http(monkeypatch, handler):
    real = httpx.Client
    captured_options = []
    def client(**kwargs):
        captured_options.append(kwargs)
        return real(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr(transport.httpx, "Client", client)
    monkeypatch.setattr(transport, "validate_url_target", lambda value: (True, ""))
    return captured_options


def test_download_has_no_account_auth_and_never_follows_redirect(monkeypatch):
    requests = []
    def handler(request):
        requests.append(request)
        assert "authorization" not in request.headers
        return httpx.Response(302, headers={"location": "https://127.0.0.1/private"})
    options = mock_http(monkeypatch, handler)
    with pytest.raises(CloudTransferError):
        BridgeCloudTransport(BINDING).download({"url": "https://files.example.invalid/object?e=1", "size": 40})
    assert len(requests) == 1
    assert options[0]["follow_redirects"] is False and options[0]["trust_env"] is False


def test_oversized_download_is_rejected(monkeypatch):
    mock_http(monkeypatch, lambda request: httpx.Response(200, content=b"x" * 41))
    with pytest.raises(CloudTransferError) as error:
        BridgeCloudTransport(BINDING).download({"url": "https://files.example.invalid/object", "size": 40})
    assert error.value.code == "download_size_mismatch"


def test_download_returns_only_exact_expected_bytes(monkeypatch):
    payload = VaultCipher.generate().seal(b"file", "file").ciphertext
    mock_http(monkeypatch, lambda request: httpx.Response(200, content=payload))
    result = BridgeCloudTransport(BINDING).download({"url": "https://files.example.invalid/object", "size": len(payload)})
    assert result == payload


def test_interrupted_download_records_observed_bytes_and_a_retry_is_not_deduplicated(monkeypatch, tmp_path):
    store = LocalCloudStore(tmp_path / "sync.db")
    observed = []
    class Interrupted(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * 17
            raise httpx.ReadError("synthetic interruption")
    attempts = []
    def handler(request):
        attempts.append(str(request.url))
        return httpx.Response(200, stream=Interrupted()) if len(attempts) == 1 else httpx.Response(200, content=b"x" * 40)
    mock_http(monkeypatch, handler)
    def record(size, complete):
        observed.append((size, complete))
        store.record_download("1", size, complete)
    client = BridgeCloudTransport(BINDING, download_recorder=record)
    authorization = {"url": "https://files.example.invalid/object", "size": 40}
    with pytest.raises(CloudTransferError):
        client.download(authorization)
    assert client.download(authorization) == b"x" * 40
    assert observed == [(17, False), (40, True)]
    assert attempts == [authorization["url"]] * 2
    reopened = LocalCloudStore(tmp_path / "sync.db")
    usage = reopened.download_usage("1")
    assert usage["received_bytes"] == 57 and usage["complete_downloads"] == 1 and usage["incomplete_downloads"] == 1
    assert reopened.download_usage("2")["received_bytes"] == 0


def test_download_recording_stays_with_original_account_after_a_switch(monkeypatch, tmp_path):
    store = LocalCloudStore(tmp_path / "sync.db")
    owner = SimpleNamespace(store=store, transport_factory=BridgeCloudTransport)
    context = {"account_id": "1", "binding": BINDING}
    client = CloudCoordinator._transport(owner, context)
    context["account_id"] = "2"
    mock_http(monkeypatch, lambda request: httpx.Response(200, content=b"x" * 40))
    client.download({"url": "https://files.example.invalid/object", "size": 40})
    assert store.download_usage("1")["received_bytes"] == 40
    assert store.download_usage("2")["received_bytes"] == 0


def test_upload_posts_encrypted_bytes_and_scoped_object_authorization_only(monkeypatch):
    plaintext = b"PRIVATE_DOCUMENT_CONTENT"
    item = VaultCipher.generate().seal(plaintext, "file")
    captured = []
    def handler(request):
        captured.append(request.read())
        assert "authorization" not in request.headers
        return httpx.Response(200)
    mock_http(monkeypatch, handler)
    BridgeCloudTransport(BINDING).upload({"upload_url": "https://upload.qiniup.com", "upload_token": "synthetic-object-authorization",
        "key": f"cloud/v1/{'b' * 32}/{item.id}.{'c' * 32}"}, item.ciphertext)
    assert item.ciphertext in captured[0] and plaintext not in captured[0]


def test_code_snapshot_is_rejected_before_any_download():
    class NoNetwork:
        def control(self, *args):
            pytest.fail("Code data must not be requested")
    with pytest.raises(CloudTransferError):
        WorkTransfer(VaultCipher.generate(), NoNetwork()).pull({"kind": "development", "deleted": False,
            "manifest_id": hashlib.sha256(b"example").hexdigest()})
