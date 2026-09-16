"""Crypto / encoding swiss-army knife tool.

Pure stdlib operations for high-frequency small tasks:
    - hash      : SHA-1/256/512, MD5
    - hmac      : HMAC with the above hashes
    - encode    : base64, base32, hex, url
    - decode    : inverse of encode
    - jwt_decode: decode (not verify) a JWT header/payload
    - uuid      : generate UUID v4 / v5
    - pwd_gen   : generate a random password
    - url_safe  : URL-encode/decode

All operations are read-only / non-persistent — no secrets are stored.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import uuid as _uuid
from typing import Any
from urllib.parse import quote, unquote, urlparse

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.config.schema import Base

_HASH_ALGOS = {
    "md5": hashlib.md5,
    "sha1": hashlib.sha1,
    "sha256": hashlib.sha256,
    "sha512": hashlib.sha512,
}

_ENCODINGS = {"base64", "base32", "hex", "url"}

_PASSWORD_ALPHABET_LOWER = "abcdefghijklmnopqrstuvwxyz"
_PASSWORD_ALPHABET_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_PASSWORD_ALPHABET_DIGITS = "0123456789"
_PASSWORD_ALPHABET_SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?"


class CryptoToolConfig(Base):
    """Crypto / encoding tool configuration."""

    enable: bool = True
    max_password_length: int = 128


def _to_bytes(value: str | bytes) -> bytes:
    if isinstance(value, bytes):
        return value
    return value.encode("utf-8")


def _from_bytes(value: bytes, encoding: str = "utf-8") -> str:
    try:
        return value.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        return value.decode("utf-8", errors="replace")


def _do_hash(algo: str, data: str, encoding: str = "utf-8") -> str:
    if algo not in _HASH_ALGOS:
        raise ValueError(f"Unsupported hash algorithm: {algo}. Supported: {', '.join(_HASH_ALGOS)}")
    h = _HASH_ALGOS[algo]()
    h.update(_to_bytes(data))
    return h.hexdigest()


def _do_hmac(algo: str, key: str, message: str) -> str:
    if algo not in _HASH_ALGOS:
        raise ValueError(f"Unsupported HMAC algorithm: {algo}. Supported: {', '.join(_HASH_ALGOS)}")
    mac = hmac.new(_to_bytes(key), _to_bytes(message), _HASH_ALGOS[algo])
    return mac.hexdigest()


def _do_encode(encoding: str, data: str) -> str:
    raw = _to_bytes(data)
    if encoding == "base64":
        return base64.b64encode(raw).decode("ascii")
    if encoding == "base32":
        return base64.b32encode(raw).decode("ascii")
    if encoding == "hex":
        return raw.hex()
    if encoding == "url":
        return quote(data, safe="")
    raise ValueError(f"Unsupported encoding: {encoding}. Supported: {', '.join(_ENCODINGS)}")


def _do_decode(encoding: str, data: str) -> str:
    if encoding == "base64":
        try:
            return _from_bytes(base64.b64decode(data, validate=True))
        except Exception as e:
            raise ValueError(f"Invalid base64 input: {e}") from e
    if encoding == "base32":
        try:
            return _from_bytes(base64.b32decode(data, casefold=True))
        except Exception as e:
            raise ValueError(f"Invalid base32 input: {e}") from e
    if encoding == "hex":
        try:
            return _from_bytes(bytes.fromhex(data))
        except ValueError as e:
            raise ValueError(f"Invalid hex input: {e}") from e
    if encoding == "url":
        return unquote(data)
    raise ValueError(f"Unsupported encoding: {encoding}. Supported: {', '.join(_ENCODINGS)}")


def _do_jwt_decode(token: str) -> dict[str, Any]:
    """Decode a JWT's header and payload WITHOUT verifying the signature."""
    token = token.strip()
    # Strip "Bearer " prefix if present
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT: expected 3 parts separated by '.'")
    result: dict[str, Any] = {}
    for idx, name in enumerate(("header", "payload")):
        part = parts[idx]
        # Add padding
        padding = "=" * (-len(part) % 4)
        try:
            decoded = base64.urlsafe_b64decode(part + padding)
            result[name] = json.loads(decoded)
        except Exception as e:
            result[name] = f"<decode error: {e}>"
    result["signature"] = parts[2]
    result["note"] = "Signature NOT verified. Do not trust claims without verification."
    return result


def _do_uuid(version: int, name: str | None = None, namespace: str | None = None) -> str:
    if version == 4:
        return str(_uuid.uuid4())
    if version == 5:
        ns = _uuid.NAMESPACE_DNS
        if namespace:
            # Allow custom namespace UUID
            try:
                ns = _uuid.UUID(namespace)
            except ValueError:
                # Treat as a DNS name → use NAMESPACE_DNS with the string
                ns = _uuid.uuid5(_uuid.NAMESPACE_DNS, namespace)
        if not name:
            raise ValueError("name is required for UUID v5")
        return str(_uuid.uuid5(ns, name))
    raise ValueError(f"Unsupported UUID version: {version}. Supported: 4, 5")


def _do_password(
    length: int,
    *,
    upper: bool = True,
    lower: bool = True,
    digits: bool = True,
    symbols: bool = True,
    no_ambiguous: bool = False,
) -> str:
    if length < 4 or length > 256:
        raise ValueError("length must be between 4 and 256")

    alphabet = ""
    required: list[str] = []
    ambiguous = set("Il1O0o")

    if lower:
        chars = _PASSWORD_ALPHABET_LOWER
        if no_ambiguous:
            chars = "".join(c for c in chars if c not in ambiguous)
        alphabet += chars
        required.append(secrets.choice(chars))
    if upper:
        chars = _PASSWORD_ALPHABET_UPPER
        if no_ambiguous:
            chars = "".join(c for c in chars if c not in ambiguous)
        alphabet += chars
        required.append(secrets.choice(chars))
    if digits:
        chars = _PASSWORD_ALPHABET_DIGITS
        if no_ambiguous:
            chars = "".join(c for c in chars if c not in ambiguous)
        alphabet += chars
        required.append(secrets.choice(chars))
    if symbols:
        alphabet += _PASSWORD_ALPHABET_SYMBOLS
        required.append(secrets.choice(_PASSWORD_ALPHABET_SYMBOLS))

    if not alphabet:
        raise ValueError("at least one character class must be enabled")

    # Fill the rest randomly
    remaining = length - len(required)
    if remaining < 0:
        # Length too small to include one of each required class; just pick randomly
        return "".join(secrets.choice(alphabet) for _ in range(length))

    chars = list(required) + [secrets.choice(alphabet) for _ in range(remaining)]
    # Shuffle using secrets
    for i in range(len(chars) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        chars[i], chars[j] = chars[j], chars[i]
    return "".join(chars)


@tool_parameters(
    tool_parameters_schema(
        action=StringSchema(
            "Operation to perform",
            enum=[
                "hash", "hmac", "encode", "decode",
                "jwt_decode", "uuid", "pwd_gen", "url_parse",
            ],
        ),
        algo=StringSchema(
            "Hash algorithm (for hash/hmac): md5, sha1, sha256, sha512",
            enum=["md5", "sha1", "sha256", "sha512"],
        ),
        encoding=StringSchema(
            "Encoding (for encode/decode): base64, base32, hex, url",
            enum=["base64", "base32", "hex", "url"],
        ),
        data=StringSchema("Input data (text to hash/encode/decode, JWT token, etc.)"),
        key=StringSchema("HMAC key (for hmac action)"),
        message=StringSchema("HMAC message (for hmac action)"),
        version=IntegerSchema(
            4,
            description="UUID version (for uuid action): 4 or 5",
            minimum=4,
            maximum=5,
        ),
        name=StringSchema("Name (for UUID v5) or URL to parse (for url_parse)"),
        namespace=StringSchema("Optional namespace UUID or DNS name (for UUID v5)"),
        length=IntegerSchema(
            16,
            description="Password length (for pwd_gen): 4-256",
            minimum=4,
            maximum=256,
        ),
        upper=StringSchema(
            "Include uppercase in password (for pwd_gen): true/false (default true)",
            enum=["true", "false"],
        ),
        lower=StringSchema(
            "Include lowercase in password (for pwd_gen): true/false (default true)",
            enum=["true", "false"],
        ),
        digits=StringSchema(
            "Include digits in password (for pwd_gen): true/false (default true)",
            enum=["true", "false"],
        ),
        symbols=StringSchema(
            "Include symbols in password (for pwd_gen): true/false (default true)",
            enum=["true", "false"],
        ),
        no_ambiguous=StringSchema(
            "Exclude ambiguous chars (Il1O0o) from password: true/false (default false)",
            enum=["true", "false"],
        ),
        required=["action"],
    )
)
class CryptoTool(Tool):
    """Encoding / hashing / crypto utility tool (pure stdlib)."""

    _scopes = {"core", "subagent"}
    config_key = "crypto"
    requires_explicit_permission = True

    name = "crypto"
    description = (
        "Encoding and crypto utility: hash (md5/sha1/sha256/sha512), hmac, "
        "encode/decode (base64/base32/hex/url), jwt_decode (no signature verify), "
        "uuid (v4/v5), pwd_gen (random password), url_parse. "
        "Pure stdlib, no external dependencies. Use this instead of shell one-liners "
        "for these high-frequency small operations."
    )

    @classmethod
    def config_cls(cls):
        return CryptoToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return ctx.config.crypto.enable

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(config=ctx.config.crypto)

    def __init__(self, *, config: CryptoToolConfig | None = None) -> None:
        self.config = config or CryptoToolConfig()

    @property
    def read_only(self) -> bool:
        # pwd_gen / uuid produce non-deterministic output, but no side effects
        return True

    async def execute(
        self,
        action: str,
        algo: str | None = None,
        encoding: str | None = None,
        data: str | None = None,
        key: str | None = None,
        message: str | None = None,
        version: int = 4,
        name: str | None = None,
        namespace: str | None = None,
        length: int = 16,
        upper: str | None = None,
        lower: str | None = None,
        digits: str | None = None,
        symbols: str | None = None,
        no_ambiguous: str | None = None,
        **kwargs: Any,
    ) -> str:
        try:
            if action == "hash":
                if data is None:
                    return "Error: data is required for hash action"
                return _do_hash(algo or "sha256", data)
            if action == "hmac":
                if key is None or message is None:
                    return "Error: key and message are required for hmac action"
                return _do_hmac(algo or "sha256", key, message)
            if action == "encode":
                if data is None:
                    return "Error: data is required for encode action"
                return _do_encode(encoding or "base64", data)
            if action == "decode":
                if data is None:
                    return "Error: data is required for decode action"
                return _do_decode(encoding or "base64", data)
            if action == "jwt_decode":
                if data is None:
                    return "Error: data (JWT token) is required for jwt_decode action"
                result = _do_jwt_decode(data)
                return json.dumps(result, indent=2, ensure_ascii=False)
            if action == "uuid":
                return _do_uuid(version, name=name, namespace=namespace)
            if action == "pwd_gen":
                length = max(4, min(256, length))
                pwd = _do_password(
                    length,
                    upper=_str_to_bool(upper, default=True),
                    lower=_str_to_bool(lower, default=True),
                    digits=_str_to_bool(digits, default=True),
                    symbols=_str_to_bool(symbols, default=True),
                    no_ambiguous=_str_to_bool(no_ambiguous, default=False),
                )
                return pwd
            if action == "url_parse":
                if data is None:
                    return "Error: data (URL) is required for url_parse action"
                parsed = urlparse(data)
                result = {
                    "scheme": parsed.scheme,
                    "netloc": parsed.netloc,
                    "hostname": parsed.hostname,
                    "port": parsed.port,
                    "path": parsed.path,
                    "params": parsed.params,
                    "query": parsed.query,
                    "fragment": parsed.fragment,
                    "username": parsed.username,
                    "password": "***" if parsed.password else None,
                }
                return json.dumps(result, indent=2, ensure_ascii=False)
            return f"Error: unknown action '{action}'"
        except ValueError as e:
            return f"Error: {e}"
        except Exception as e:
            logger.exception("crypto tool error")
            return f"Error: {type(e).__name__}: {e}"


def _str_to_bool(value: str | None, *, default: bool) -> bool:
    if value is None:
        return default
    return value.lower() in ("true", "1", "yes")
