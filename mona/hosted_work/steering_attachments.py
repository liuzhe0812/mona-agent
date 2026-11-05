"""Verify staged files before passing them to one running hosted turn."""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re

from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.desktop_store import request_id
from mona.hosted_work.sandbox_files import relative_path
from mona.utils.helpers import detect_image_mime

_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_SLOT = re.compile(r"^[a-f0-9]{32}$")
_SHA = re.compile(r"^[a-f0-9]{64}$")
_DATA = re.compile(r"^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$")
_META = frozenset({"ui_theme", "office_session_id", "office_document_type", "office_display_name",
                   "display_content", "quote", "task_id", "title"})


def _invalid() -> WorkError:
    return WorkError("invalid_request", "附件或消息信息无效。")


def validate_descriptors(values) -> list[dict]:
    if not isinstance(values, (list, tuple)) or len(values) > 8:
        raise _invalid()
    result, seen = [], set()
    for value in values:
        if not isinstance(value, dict) or set(value) != {"path", "name", "size", "sha256"}:
            raise _invalid()
        path, name, size, digest = value["path"], value["name"], value["size"], value["sha256"]
        if not isinstance(path, str) or not path.startswith("/workspace/uploads/"):
            raise _invalid()
        parts = path[len("/workspace/"):].split("/")
        if (len(parts) != 3 or parts[0] != "uploads" or not _SLOT.fullmatch(parts[1])
                or not isinstance(name, str) or not name or len(name) > 160 or name in {".", ".."}
                or any(c in name for c in "/\\:") or any(ord(c) < 32 or ord(c) == 127 for c in name)
                or parts[2] != name or type(size) is not int or not 0 <= size <= 32 * 1024 * 1024
                or not isinstance(digest, str) or not _SHA.fullmatch(digest) or path in seen):
            raise _invalid()
        try:
            if len(name.encode("utf-8")) > 240 or relative_path(path) != "/".join(parts):
                raise _invalid()
        except (UnicodeError, ValueError):
            raise _invalid() from None
        seen.add(path)
        result.append({"path": path, "name": name, "size": size, "sha256": digest})
    return result


def validate_metadata(value) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - _META:
        raise _invalid()
    result = dict(value)
    if ("ui_theme" in result and (not isinstance(result["ui_theme"], str) or result["ui_theme"] not in {"dark", "light"})
            or "office_document_type" in result and (not isinstance(result["office_document_type"], str)
                                                     or result["office_document_type"] not in {"docs", "sheets", "slides"})):
        raise _invalid()
    for key in ("office_session_id", "task_id"):
        if key in result and (not isinstance(result[key], str) or not _ID.fullmatch(result[key])):
            raise _invalid()
    for key in ("office_display_name", "display_content", "title"):
        if key in result and (not isinstance(result[key], str) or len(result[key]) > 5000):
            raise _invalid()
    if "quote" in result:
        quote = result["quote"]
        if (not isinstance(quote, dict) or set(quote) != {"author", "content"}
                or any(not isinstance(quote[key], str) or len(quote[key]) > 5000 for key in quote)):
            raise _invalid()
        result["quote"] = dict(quote)
    try:
        if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 64 * 1024:
            raise _invalid()
    except (ValueError, UnicodeError):
        raise _invalid() from None
    return result


def sandbox_target(sid: str, input_id: str, descriptor: dict) -> str:
    sid = identifier(sid)
    if not isinstance(input_id, str) or not _ID.fullmatch(input_id):
        raise _invalid()
    item = validate_descriptors([descriptor])[0]
    fingerprint = hashlib.sha256((item["path"] + ":" + item["sha256"]).encode("utf-8")).hexdigest()
    slot = request_id(fingerprint, "steering:" + sid + ":" + input_id)
    return "uploads/" + slot + "/" + item["name"]


def build_image_content(text: str, verified_bytes_items: list[dict]):
    """Build the desktop multimodal content shape without reading host paths."""
    images = []
    for item in verified_bytes_items:
        raw, path = item["data"], item["path"]
        if not isinstance(raw, bytes) or not isinstance(path, str):
            raise _invalid()
        try:
            logical = "/workspace/" + relative_path(path)
        except ValueError:
            raise _invalid() from None
        mime = detect_image_mime(raw)
        if mime:
            images.append({"type": "image_url", "image_url": {"url": "data:" + mime + ";base64," +
                           base64.b64encode(raw).decode("ascii")}, "_meta": {"path": logical}})
    return images + [{"type": "text", "text": text}] if images else text


class SteeringAttachments:
    def __init__(self, desktop):
        self.desktop = desktop

    def stage_media(self, owner: str, sid: str, input_id: str, media) -> list[str]:
        self.desktop.state.session(owner, identifier(sid))
        if not isinstance(input_id, str) or not _ID.fullmatch(input_id):
            raise _invalid()
        if not isinstance(media, list) or len(media) > 8:
            raise _invalid()
        config = self.desktop.service.config
        decoded = []
        for index, item in enumerate(media):
            if not isinstance(item, dict) or set(item) - {"name", "data_url"}:
                raise _invalid()
            value = item.get("data_url")
            match = _DATA.fullmatch(value) if isinstance(value, str) and len(value) <= 2 * config.max_file_bytes + 100 else None
            try:
                raw = base64.b64decode(match[2], validate=True) if match else None
            except (ValueError, binascii.Error):
                raw = None
            if raw is None or len(raw) > config.max_file_bytes or detect_image_mime(raw) != match[1]:
                raise WorkError("unsupported_media", "请使用 PNG、JPEG、WebP 或 GIF 图片；其他文件请作为附件上传。", 400)
            suffix = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}[match[1]]
            name = item.get("name") or f"image-{index + 1}.{suffix}"
            digest = hashlib.sha256(raw).hexdigest()
            if not isinstance(name, str):
                raise _invalid()
            validate_descriptors([{"path": "/workspace/uploads/" + "0" * 32 + "/" + name,
                                   "name": name, "size": len(raw), "sha256": digest}])
            fingerprint = hashlib.sha256(f"{index}:{name}:{digest}".encode("utf-8")).hexdigest()
            slot = request_id(fingerprint, "media:" + sid + ":" + input_id)
            logical = f"/workspace/uploads/{slot}/{name}"
            descriptor = {"path": logical, "name": name, "size": len(raw), "sha256": digest}
            validate_descriptors([descriptor])
            decoded.append((descriptor, match[1], raw))
        if sum(len(raw) for _, _, raw in decoded) > config.workspace_bytes:
            raise WorkError("file_limit", "附件总大小超过工作区限制。", 413)
        if not decoded:
            return []
        root = self.desktop.files.root(owner)
        uploads = root / "uploads"
        if uploads.is_symlink():
            raise WorkError("invalid_state", "附件目录不可用。", 503)
        uploads.mkdir(mode=0o700, exist_ok=True)
        if not uploads.is_dir() or uploads.resolve().parent != root:
            raise WorkError("invalid_state", "附件目录不可用。", 503)
        result = []
        for item, mime, raw in decoded:
            slot = item["path"].split("/")[3]
            directory = uploads / slot
            directory.mkdir(mode=0o700, exist_ok=True)
            if directory.is_symlink() or not directory.is_dir() or directory.resolve().parent != uploads:
                raise WorkError("invalid_state", "附件目录不可用。", 503)
            path = self.desktop.files._path(root, item["path"])
            stored = self.desktop.state.get(owner, "upload:" + item["path"])
            if stored is not None and (not isinstance(stored, dict) or
                    any(stored.get(key) != item[key] for key in ("path", "name", "size", "sha256"))):
                raise WorkError("file_changed", "附件已变化，请重新上传后发送。", 409)
            if path.exists():
                existing = self.desktop.files._read_bytes(path, config.max_file_bytes)
                if existing != raw:
                    raise WorkError("file_changed", "附件已变化，请重新上传后发送。", 409)
            else:
                self.desktop.files._save_atomic(path, raw, create=True)
            self.desktop.state.set(owner, "upload:" + item["path"], {**item, "mime": mime, "scope": sid})
            result.append(item["path"])
        return result

    def _verified(self, owner: str, descriptor: dict) -> bytes:
        item = validate_descriptors([descriptor])[0]
        path, logical = self.desktop._logical(owner, item["path"])
        stored = self.desktop.state.get(owner, "upload:" + logical)
        if (logical != item["path"] or not isinstance(stored, dict)
                or any(stored.get(key) != item[key] for key in ("path", "name", "size", "sha256"))):
            raise WorkError("not_found", "附件尚未上传或不属于当前账号。", 404)
        data = self.desktop.files._read_bytes(path, self.desktop.service.config.max_file_bytes)
        if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise WorkError("file_changed", "附件已变化，请重新上传后发送。", 409)
        return data

    def prepare(self, owner: str, sid: str, input_id: str, paths) -> list[dict]:
        self.desktop.state.session(owner, identifier(sid))
        if not isinstance(input_id, str) or not _ID.fullmatch(input_id):
            raise _invalid()
        if not isinstance(paths, (tuple, list)) or len(paths) > 8 or not all(isinstance(path, str) for path in paths):
            raise _invalid()
        result = []
        for raw in dict.fromkeys(paths):
            path, logical = self.desktop._logical(owner, raw)
            stored = self.desktop.state.get(owner, "upload:" + logical)
            if not isinstance(stored, dict):
                raise WorkError("not_found", "附件尚未上传或不属于当前账号。", 404)
            item = {key: stored.get(key) for key in ("path", "name", "size", "sha256")}
            if logical != item["path"] or path.name != item["name"]:
                raise WorkError("not_found", "附件尚未上传或不属于当前账号。", 404)
            self._verified(owner, item)
            result.append(item)
        return validate_descriptors(result)

    def enrich(self, owner: str, sid: str, batch: dict) -> dict:
        self.desktop.state.session(owner, identifier(sid))
        if not isinstance(batch, dict) or not isinstance(batch.get("inputs"), list):
            raise _invalid()
        result = {**batch, "inputs": []}
        for item in batch["inputs"]:
            if not isinstance(item, dict) or not isinstance(item.get("input_id"), str):
                raise _invalid()
            output = dict(item)
            if item.get("attachments"):
                attachments = []
                for descriptor in validate_descriptors(item["attachments"]):
                    raw = self._verified(owner, descriptor)
                    attachments.append({**descriptor, "target_path": sandbox_target(sid, item["input_id"], descriptor),
                                        "data": base64.b64encode(raw).decode("ascii")})
                output["attachments"] = attachments
            result["inputs"].append(output)
        try:
            # aiohttp.json_response uses json.dumps' ASCII escaping by default.
            encoded = json.dumps({"result": result}, allow_nan=False).encode("utf-8")
        except (ValueError, UnicodeError):
            raise _invalid() from None
        if len(encoded) > self.desktop.service.config.max_history_bytes:
            raise WorkError("file_limit", "追加附件超过本轮传输上限，请缩小后重新上传。", 413)
        return result
