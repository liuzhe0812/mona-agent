"""Versioned, account-vault-bound authenticated encryption for sync objects.

AES-SIV intentionally reveals equality only inside the same vault, enabling
cross-device deduplication without sharing plaintext hashes with the service.
Uses cryptography's RFC 5297 primitive, not a custom deterministic GCM nonce.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import zlib
from dataclasses import dataclass
from typing import Literal

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESSIV
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from mona.cloud.work_files import HEX64, ID32

MAX_PLAINTEXT = 7 * 1024 * 1024
MAX_CIPHERTEXT = 8 * 1024 * 1024
_HEADER = b"MONACLOUD\x01"
Purpose = Literal["records", "file", "bundle", "key-check"]


class CloudCryptoError(ValueError):
    pass


def qiniu_etag(data: bytes) -> str:
    block_size = 4 * 1024 * 1024
    if len(data) <= block_size:
        value = b"\x16" + hashlib.sha1(data).digest()
    else:
        pieces = b"".join(hashlib.sha1(data[start:start + block_size]).digest()
                          for start in range(0, len(data), block_size))
        value = b"\x96" + hashlib.sha1(pieces).digest()
    return base64.urlsafe_b64encode(value).decode("ascii")


@dataclass(frozen=True)
class SealedObject:
    id: str
    ciphertext: bytes

    @property
    def reservation(self) -> dict:
        return {"id": self.id, "size": len(self.ciphertext), "etag": qiniu_etag(self.ciphertext)}


class VaultCipher:
    def __init__(self, vault_id: str, master_key: bytes):
        if not isinstance(vault_id, str) or not ID32.fullmatch(vault_id) or len(master_key) != 32:
            raise CloudCryptoError("云空间恢复密钥无效。")
        self.vault_id = vault_id
        self._master = bytes(master_key)
        key = HKDF(algorithm=hashes.SHA256(), length=64,
                   salt=bytes.fromhex(vault_id), info=b"mona-cloud/aes256-siv/v1").derive(master_key)
        self._cipher = AESSIV(key)

    @classmethod
    def generate(cls) -> VaultCipher:
        return cls(secrets.token_hex(16), secrets.token_bytes(32))

    @classmethod
    def from_recovery(cls, text: str) -> VaultCipher:
        if not isinstance(text, str) or len(text) > 160:
            raise CloudCryptoError("恢复密钥格式无效。")
        parts = text.strip().split(":")
        if len(parts) != 4 or parts[0] != "mona-v1":
            raise CloudCryptoError("恢复密钥格式无效。")
        body = ":".join(parts[:3])
        checksum = hashlib.sha256(body.encode()).hexdigest()[:12]
        if not hmac.compare_digest(checksum, parts[3]):
            raise CloudCryptoError("恢复密钥校验失败，请检查是否完整复制。")
        try:
            raw = base64.b64decode(parts[2] + "=", altchars=b"-_", validate=True)
            if base64.urlsafe_b64encode(raw).decode().rstrip("=") != parts[2]:
                raise ValueError("Noncanonical encoding")
            return cls(parts[1], raw)
        except (ValueError, TypeError):
            raise CloudCryptoError("恢复密钥格式无效。") from None

    def recovery_text(self) -> str:
        body = f"mona-v1:{self.vault_id}:{base64.urlsafe_b64encode(self._master).decode().rstrip('=')}"
        return f"{body}:{hashlib.sha256(body.encode()).hexdigest()[:12]}"

    def _aad(self, purpose: Purpose) -> list[bytes]:
        if purpose not in {"records", "file", "bundle", "key-check"}:
            raise CloudCryptoError("云对象用途无效。")
        return [_HEADER, bytes.fromhex(self.vault_id), purpose.encode()]

    def seal(self, data: bytes, purpose: Purpose) -> SealedObject:
        if not isinstance(data, bytes) or len(data) > MAX_PLAINTEXT:
            raise CloudCryptoError("云对象超过分片大小上限。")
        compressed = zlib.compress(data, level=3)
        use_compression = len(compressed) < len(data)
        payload = bytes([int(use_compression)]) + len(data).to_bytes(8, "big")
        payload += compressed if use_compression else data
        encrypted = _HEADER + self._cipher.encrypt(payload, self._aad(purpose))
        return SealedObject(hashlib.sha256(encrypted).hexdigest(), encrypted)

    def open(self, object_id: str, ciphertext: bytes, purpose: Purpose) -> bytes:
        if (not isinstance(object_id, str) or not HEX64.fullmatch(object_id)
                or not isinstance(ciphertext, bytes) or not 35 <= len(ciphertext) <= MAX_CIPHERTEXT
                or not ciphertext.startswith(_HEADER)
                or not hmac.compare_digest(hashlib.sha256(ciphertext).hexdigest(), object_id)):
            raise CloudCryptoError("云文件完整性校验失败。")
        try:
            payload = self._cipher.decrypt(ciphertext[len(_HEADER):], self._aad(purpose))
        except InvalidTag:
            raise CloudCryptoError("无法解密云文件，请核对恢复密钥。") from None
        if len(payload) < 9 or payload[0] not in (0, 1):
            raise CloudCryptoError("云文件格式无效。")
        size = int.from_bytes(payload[1:9], "big")
        if size > MAX_PLAINTEXT:
            raise CloudCryptoError("云文件解压大小超过上限。")
        body = payload[9:]
        if payload[0]:
            try:
                decoder = zlib.decompressobj()
                body = decoder.decompress(body, size + 1)
                if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                    raise ValueError("Invalid compressed object")
            except (zlib.error, ValueError):
                raise CloudCryptoError("云文件压缩数据无效。") from None
        if len(body) != size:
            raise CloudCryptoError("云文件大小校验失败。")
        return body

    def key_check(self) -> str:
        return base64.urlsafe_b64encode(self.seal(b"mona-vault-key-check-v1", "key-check").ciphertext).decode()

    def matches_key_check(self, value: str) -> bool:
        return isinstance(value, str) and hmac.compare_digest(self.key_check(), value)
