"""Authenticated control-plane bridge plus encrypted direct object transfers."""
from __future__ import annotations

import re
from typing import Callable
from urllib.parse import urlsplit

import httpx

from mona.agent.tools.tauri_ipc import tauri_invoke
from mona.cloud.crypto import MAX_CIPHERTEXT
from mona.cloud.transfer import CloudTransferError
from mona.security.network import validate_url_target

_CONTROL_PATHS = {
    "GET": re.compile(r"^/(?:space|cleanup|retention|usage(?:\?period=[1-9][0-9]{3}-(?:0[1-9]|1[0-2]))?|trash(?:\?before=[0-9]+)?|changes(?:\?after=[0-9]+&limit=[0-9]+)?|resources/[a-f0-9]{32}/history(?:\?before=[0-9]+)?)$"),
    "POST": re.compile(r"^/(?:space|cleanup|retention|trash/(?:preview|apply)|objects/reserve|objects/[a-f0-9]{64}/(?:confirm|download|release)|resources/commit)$"),
}


class BridgeCloudTransport:
    def __init__(self, account_binding: str, *, download_recorder: Callable[[int, bool], None] | None = None):
        if not isinstance(account_binding, str) or not re.fullmatch(r"[a-f0-9]{64}", account_binding):
            raise CloudTransferError("account_required", "请先登录并开启云同步。")
        self.binding = account_binding
        self.download_recorder = download_recorder

    def control(self, method: str, path: str, payload: dict | None = None) -> dict:
        allowed = _CONTROL_PATHS.get(method)
        if allowed is None or len(path) > 256 or not allowed.fullmatch(path):
            raise CloudTransferError("invalid_request", "云同步请求无效。")
        result = tauri_invoke("cloud_sync_request", {
            "binding": self.binding, "method": method, "path": path, "payload": payload,
        }, timeout=65)
        if not isinstance(result, dict) or type(result.get("status")) is not int or not isinstance(result.get("data"), dict):
            raise CloudTransferError("invalid_response", "云同步服务响应无效。")
        if result["status"] >= 400:
            body = result["data"]
            raw_code = body.get("error")
            code = raw_code if isinstance(raw_code, str) else "sync_unavailable"
            messages = {
                "cloud_pro_required": "云同步需要 Pro，本地工作不受影响。",
                "cloud_download_expired": "云内容下载期已结束，续订 Pro 后可再次下载；本地资料仍可使用。",
                "cloud_quota_exceeded": "云空间不足，请清理空间后重试。",
                "cloud_version_conflict": "另一台设备已修改此会话，已保留本地版本。",
                "cloud_unavailable": "云同步服务暂未开放。",
                "cloud_not_configured": "云同步服务尚未配置完成。",
                "cloud_space_exists": "已有云空间，请使用原恢复密钥。",
            }
            raise CloudTransferError(code,
                                     messages.get(code, "云同步暂未完成，请稍后重试。"))
        return result["data"]

    @staticmethod
    def _url(value: object, *, upload: bool) -> str:
        if not isinstance(value, str) or len(value) > 8192:
            raise CloudTransferError("invalid_storage_url", "云文件地址无效。")
        try:
            parsed = urlsplit(value)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                    or parsed.port not in (None, 443) or parsed.fragment):
                raise ValueError("Invalid HTTPS address")
            if upload and (not any(parsed.hostname.endswith(suffix) for suffix in (".qiniup.com", ".qiniu.com", ".qiniuapi.com"))
                           or parsed.path not in ("", "/") or parsed.query):
                raise ValueError("Invalid upload endpoint")
            allowed, _ = validate_url_target(value)
            if not allowed:
                raise ValueError("Unsafe address")
        except (ValueError, TypeError):
            raise CloudTransferError("invalid_storage_url", "云文件地址未通过安全校验。") from None
        return value

    def upload(self, authorization: dict, ciphertext: bytes) -> None:
        url = self._url(authorization.get("upload_url"), upload=True)
        token, key = authorization.get("upload_token"), authorization.get("key")
        if (not isinstance(token, str) or not 20 <= len(token) <= 8192 or not isinstance(key, str)
                or not re.fullmatch(r"cloud/v1/[a-f0-9]{32}/[a-f0-9]{64}\.[a-f0-9]{32}", key)
                or not isinstance(ciphertext, bytes) or len(ciphertext) > MAX_CIPHERTEXT):
            raise CloudTransferError("invalid_authorization", "云文件上传授权无效。")
        try:
            with httpx.Client(timeout=httpx.Timeout(60, connect=10), follow_redirects=False, trust_env=False) as client:
                with client.stream("POST", url, data={"token": token, "key": key},
                                   files={"file": ("encrypted.bin", ciphertext, "application/octet-stream")}) as response:
                    # A prior timed-out upload may already exist. The subsequent
                    # independent stat/confirm checks exact size and content etag.
                    if response.status_code not in {200, 614}:
                        raise CloudTransferError("upload_unconfirmed", "文件上传结果尚未确认，请重试同步。")
        except httpx.HTTPError:
            raise CloudTransferError("upload_unconfirmed", "文件上传结果尚未确认，请重试同步。") from None

    def download(self, authorization: dict) -> bytes:
        url = self._url(authorization.get("url"), upload=False)
        expected = authorization.get("size")
        if type(expected) is not int or not 35 <= expected <= MAX_CIPHERTEXT:
            raise CloudTransferError("invalid_authorization", "云文件下载大小无效。")
        result = bytearray()
        received, complete = 0, False
        try:
            with httpx.Client(timeout=httpx.Timeout(60, connect=10), follow_redirects=False, trust_env=False) as client:
                with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
                    if response.status_code != 200 or response.headers.get("content-encoding", "identity") != "identity":
                        raise CloudTransferError("download_unavailable", "云文件暂时无法下载。")
                    for chunk in response.iter_bytes():
                        received += len(chunk)
                        if len(result) + len(chunk) > expected:
                            raise CloudTransferError("download_size_mismatch", "云文件下载大小不一致。")
                        result.extend(chunk)
            if len(result) != expected:
                raise CloudTransferError("download_incomplete", "云文件下载不完整，请重试。")
            complete = True
        except httpx.HTTPError:
            raise CloudTransferError("download_unavailable", "云文件暂时无法下载。") from None
        finally:
            if self.download_recorder is not None:
                self.download_recorder(received, complete)
        return bytes(result)
