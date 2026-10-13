"""Encrypted Work object upload/download, with explicit commit and lazy files.

Runs in a bounded worker thread; local API handlers must not block the event
loop. Control messages contain only ciphertext identities, sizes and versions.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from threading import Event
from typing import Callable, Iterator, Protocol

from mona.cloud.crypto import MAX_PLAINTEXT, VaultCipher
from mona.cloud.work_files import HEX64, ID32, materialize_work_file
from mona.cloud.work_snapshot import WorkExport, canonical_bytes, validate_work_snapshot

_MAX_OBJECTS = 2048
_RECORD_CHUNK = 1024 * 1024
_BUNDLE_FORMAT = "mona-encrypted-work-bundle"


class CloudTransferError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class CloudTransport(Protocol):
    def control(self, method: str, path: str, payload: dict | None = None) -> dict: ...
    def upload(self, authorization: dict, ciphertext: bytes) -> None: ...
    def download(self, authorization: dict) -> bytes: ...


@dataclass(frozen=True)
class DownloadedWork:
    snapshot: dict
    bundle: dict
    version: dict


class WorkTransfer:
    def __init__(self, cipher: VaultCipher, transport: CloudTransport,
                 cancelled: Event | None = None, progress: Callable[[str, int], None] | None = None):
        self.cipher, self.transport = cipher, transport
        self.cancelled = cancelled or Event()
        self.progress = progress
        self.transferred_bytes = 0

    def _check_cancel(self) -> None:
        if self.cancelled.is_set():
            raise CloudTransferError("cancelled", "同步已暂停，本地文件和已有云版本保持不变。")

    def _put(self, data: bytes, purpose: str) -> str:
        self._check_cancel()
        item = self.cipher.seal(data, purpose)
        response = self.transport.control("POST", "/objects/reserve", item.reservation)
        if not isinstance(response, dict) or response.get("id") != item.id or response.get("state") not in ("ready", "pending"):
            raise CloudTransferError("invalid_response", "云同步授权响应无效。")
        if response["state"] == "pending":
            self.transport.upload(response, item.ciphertext)
            self.transferred_bytes += len(item.ciphertext)
            result = self.transport.control("POST", f"/objects/{item.id}/confirm")
            if result.get("id") != item.id or result.get("state") != "ready":
                raise CloudTransferError("upload_incomplete", "云文件尚未确认上传成功。")
            if self.progress:
                self.progress("uploading", self.transferred_bytes)
        return item.id

    def _get(self, object_id: str, purpose: str) -> bytes:
        self._check_cancel()
        if not isinstance(object_id, str) or not HEX64.fullmatch(object_id):
            raise CloudTransferError("invalid_reference", "云对象标识无效。")
        authorization = self.transport.control("POST", f"/objects/{object_id}/download")
        if authorization.get("sha256") != object_id:
            raise CloudTransferError("invalid_reference", "云文件授权与请求不一致。")
        ciphertext = self.transport.download(authorization)
        if len(ciphertext) != authorization.get("size"):
            raise CloudTransferError("download_incomplete", "云文件下载不完整。")
        plaintext = self.cipher.open(object_id, ciphertext, purpose)
        self.transferred_bytes += len(ciphertext)
        if self.progress:
            self.progress("downloading", self.transferred_bytes)
        return plaintext

    def push(self, exported: WorkExport, *, base_version: int,
             previous: DownloadedWork | None = None) -> dict:
        exported.bytes()  # Reject mutation of a supposedly immutable local snapshot.
        snapshot = copy.deepcopy(exported.snapshot)
        validate_work_snapshot(snapshot, vault_id=self.cipher.vault_id)
        if type(base_version) is not int or base_version < 0:
            raise CloudTransferError("invalid_version", "同步版本无效。")
        prior_files = {}
        prior_paths = {}
        if previous is not None:
            self._validate_bundle(previous.bundle, previous.version)
            if previous.bundle["resource_id"] != snapshot["resource_id"]:
                raise CloudTransferError("foreign_reference", "上次同步记录不属于当前会话。")
            prior_files = {item["id"]: item for item in previous.bundle["files"]}
            validate_work_snapshot(previous.snapshot, vault_id=self.cipher.vault_id, resource_id=snapshot["resource_id"])
            prior_paths = {item["source_path"]: item for item in previous.snapshot["files"]
                           if isinstance(item.get("source_path"), str)}
        descriptors = {item["id"]: item for item in snapshot["files"]}
        unavailable = []
        for item in snapshot.get("unavailable_files", []):
            if item.get("reason") not in {"missing", "file_too_large"}:
                unavailable.append(item)
                continue
            source_path = item.get("source_path")
            prior = prior_paths.get(source_path) if isinstance(source_path, str) else None
            current = next((file for file in descriptors.values() if file.get("source_path") == source_path), None)
            reusable = prior or current
            old = prior_files.get(reusable["id"]) if reusable else None
            if (item.get("reason") != "missing" or not reusable or not old
                    or old["sha256"] != reusable["sha256"] or old["size"] != reusable["size"]):
                raise CloudTransferError("associated_file_unavailable",
                    "会话的关联文件缺失或超过同步上限，尚未更新云版本。请恢复缺失文件或调整会话范围后重试。")
            # Reuse only this exact file's confirmed cloud version. A same-named
            # attachment elsewhere is not evidence that the missing file exists.
            if reusable["id"] not in descriptors:
                descriptors[reusable["id"]] = {**copy.deepcopy(reusable), "availability": "cloud"}
        snapshot["files"] = list(descriptors.values())
        snapshot["unavailable_files"] = unavailable
        sources = {source.descriptor["id"]: source for source in exported.sources}
        file_parts = []
        object_ids: set[str] = set()
        for descriptor in snapshot["files"]:
            source = sources.get(descriptor["id"])
            if source is None:
                old = prior_files.get(descriptor["id"])
                if not old or old["sha256"] != descriptor["sha256"] or old["size"] != descriptor["size"]:
                    raise CloudTransferError("file_unavailable", "关联文件未下载且没有可复用的云版本，未发布不完整会话。")
                entry = copy.deepcopy(old)
            else:
                pieces = [self._put(chunk, "file") for chunk in source.chunks(MAX_PLAINTEXT)]
                # The source generator checks the entire file signature and hash
                # before a manifest can be published, including the empty file.
                entry = {"id": descriptor["id"], "sha256": descriptor["sha256"],
                         "size": descriptor["size"], "chunks": pieces}
            file_parts.append(entry)
            object_ids.update(entry["chunks"])
        header = {key: value for key, value in snapshot.items() if key not in {"messages", "display"}}
        streams = {}
        for field in ("messages", "display"):
            data = b"".join(canonical_bytes(record) + b"\n" for record in snapshot[field])
            refs = [self._put(data[start:start + _RECORD_CHUNK], "records")
                    for start in range(0, len(data), _RECORD_CHUNK)]
            streams[field] = {"chunks": refs, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            object_ids.update(refs)
        bundle = {"format": _BUNDLE_FORMAT, "version": 1, "vault_id": self.cipher.vault_id,
                  "resource_id": snapshot["resource_id"], "snapshot": header,
                  "streams": streams, "files": file_parts}
        bundle_id = self._put(canonical_bytes(bundle), "bundle")
        object_ids.add(bundle_id)
        if len(object_ids) > _MAX_OBJECTS:
            raise CloudTransferError("too_many_objects", "本次会话关联文件过多，未发布新的云版本。")
        self._check_cancel()
        operation = hashlib.sha256(f"{snapshot['resource_id']}:{base_version}:{bundle_id}".encode()).hexdigest()
        result = self.transport.control("POST", "/resources/commit", {
            "resource_id": snapshot["resource_id"], "kind": "work_conversation", "base_version": base_version,
            "operation_id": operation, "manifest_id": bundle_id, "object_ids": sorted(object_ids), "deleted": False})
        if (result.get("manifest_id") != bundle_id or result.get("resource_id") != snapshot["resource_id"]
                or result.get("version") != base_version + 1):
            raise CloudTransferError("commit_unknown", "同步提交结果尚未确认，请重试核对，勿删除本地数据。")
        return result

    def _validate_bundle(self, bundle: dict, version: dict) -> None:
        if (not isinstance(version, dict) or version.get("kind") != "work_conversation" or version.get("deleted") is not False
                or not isinstance(version.get("resource_id"), str) or not ID32.fullmatch(version["resource_id"])
                or type(version.get("version")) is not int or version["version"] < 1):
            raise CloudTransferError("invalid_version", "此云版本不是可恢复的普通会话。")
        refs = version.get("object_ids")
        if (not isinstance(refs, list) or len(refs) > _MAX_OBJECTS
                or any(not isinstance(oid, str) or not HEX64.fullmatch(oid) for oid in refs)
                or version.get("manifest_id") not in refs):
            raise CloudTransferError("invalid_reference", "云版本的对象清单无效。")
        if (not isinstance(bundle, dict) or bundle.get("format") != _BUNDLE_FORMAT
                or type(bundle.get("version")) is not int or bundle["version"] != 1
                or bundle.get("vault_id") != self.cipher.vault_id
                or bundle.get("resource_id") != version["resource_id"]):
            raise CloudTransferError("foreign_reference", "云会话不属于当前空间或记录。")
        permitted = set(refs)
        streams, files = bundle.get("streams"), bundle.get("files")
        if not isinstance(streams, dict) or set(streams) != {"messages", "display"} or not isinstance(files, list) or len(files) > _MAX_OBJECTS:
            raise CloudTransferError("invalid_bundle", "云会话内容清单无效。")
        for entry in [*streams.values(), *files]:
            chunks = entry.get("chunks") if isinstance(entry, dict) else None
            if (not isinstance(chunks, list) or len(chunks) > _MAX_OBJECTS
                    or any(not isinstance(oid, str) or oid not in permitted for oid in chunks)
                    or type(entry.get("size")) is not int or not 0 <= entry["size"] <= 10_000_000_000
                    or not isinstance(entry.get("sha256"), str) or not HEX64.fullmatch(entry["sha256"])):
                raise CloudTransferError("invalid_bundle", "云会话包含未确认的文件引用。")
        for entry in streams.values():
            if entry["size"] > 128 * 1024 * 1024:
                raise CloudTransferError("invalid_bundle", "云会话记录大小超过上限。")
        ids = [entry.get("id") for entry in files]
        if any(not isinstance(value, str) or not HEX64.fullmatch(value) for value in ids) or len(set(ids)) != len(ids):
            raise CloudTransferError("invalid_bundle", "云文件清单包含无效或重复记录。")

    def pull(self, version: dict) -> DownloadedWork:
        if (not isinstance(version, dict) or version.get("kind") != "work_conversation"
                or version.get("deleted") is not False or not isinstance(version.get("manifest_id"), str)):
            raise CloudTransferError("invalid_version", "云版本无效。")
        try:
            bundle = json.loads(self._get(version["manifest_id"], "bundle"))
            self._validate_bundle(bundle, version)
            snapshot = copy.deepcopy(bundle["snapshot"])
            for field, entry in bundle["streams"].items():
                data = bytearray()
                for oid in entry["chunks"]:
                    block = self._get(oid, "records")
                    if len(data) + len(block) > entry["size"]:
                        raise CloudTransferError("invalid_bundle", "云会话记录超出声明大小。")
                    data.extend(block)
                if len(data) != entry["size"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                    raise CloudTransferError("invalid_bundle", "云会话记录校验失败。")
                snapshot[field] = [json.loads(line) for line in data.splitlines() if line.strip()]
            validate_work_snapshot(snapshot, vault_id=self.cipher.vault_id, resource_id=version["resource_id"])
            expected = {item["id"]: (item["sha256"], item["size"]) for item in snapshot["files"]}
            actual = {item["id"]: (item["sha256"], item["size"]) for item in bundle["files"]}
            if actual != expected:
                raise CloudTransferError("invalid_bundle", "会话附件与文件清单不一致。")
            return DownloadedWork(snapshot, bundle, copy.deepcopy(version))
        except (ValueError, KeyError, TypeError, UnicodeError, RecursionError):
            raise CloudTransferError("invalid_bundle", "无法读取云会话，未修改本地内容。") from None

    def materialize(self, downloaded: DownloadedWork, file_id: str, *, workspace, media_root, before_publish=None):
        self._validate_bundle(downloaded.bundle, downloaded.version)
        validate_work_snapshot(downloaded.snapshot, vault_id=self.cipher.vault_id,
                               resource_id=downloaded.version["resource_id"])
        descriptor = next((item for item in downloaded.snapshot["files"] if item["id"] == file_id), None)
        entry = next((item for item in downloaded.bundle["files"] if item["id"] == file_id), None)
        if not descriptor or not entry or (entry["sha256"], entry["size"]) != (descriptor["sha256"], descriptor["size"]):
            raise CloudTransferError("file_unavailable", "文件不属于此会话版本。")
        def chunks() -> Iterator[bytes]:
            for oid in entry["chunks"]:
                yield self._get(oid, "file")
        def publish_check():
            self._check_cancel()
            if before_publish is not None:
                before_publish()
            self._check_cancel()
        return materialize_work_file(descriptor, chunks(), workspace=workspace,
            media_root=media_root, vault_id=self.cipher.vault_id, before_publish=publish_check)
