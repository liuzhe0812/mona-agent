"""Tests for the crypto / encoding tool."""

from __future__ import annotations

import hashlib
import json

import pytest

from mona.agent.tools.crypto import CryptoTool, CryptoToolConfig


@pytest.fixture
def tool():
    return CryptoTool(config=CryptoToolConfig())


# --- hash ---

@pytest.mark.asyncio
async def test_hash_sha256(tool):
    result = await tool.execute(action="hash", algo="sha256", data="hello")
    expected = hashlib.sha256(b"hello").hexdigest()
    assert result == expected


@pytest.mark.asyncio
async def test_hash_md5(tool):
    result = await tool.execute(action="hash", algo="md5", data="hello")
    expected = hashlib.md5(b"hello").hexdigest()
    assert result == expected


@pytest.mark.asyncio
async def test_hash_default_algo_is_sha256(tool):
    result = await tool.execute(action="hash", data="hello")
    expected = hashlib.sha256(b"hello").hexdigest()
    assert result == expected


@pytest.mark.asyncio
async def test_hash_unsupported_algo(tool):
    result = await tool.execute(action="hash", algo="crc32", data="hello")
    assert "Error" in result


@pytest.mark.asyncio
async def test_hash_missing_data(tool):
    result = await tool.execute(action="hash")
    assert "Error" in result


# --- hmac ---

@pytest.mark.asyncio
async def test_hmac_sha256(tool):
    import hmac as _hmac
    result = await tool.execute(action="hmac", algo="sha256", key="secret", message="msg")
    expected = _hmac.new(b"secret", b"msg", hashlib.sha256).hexdigest()
    assert result == expected


# --- encode / decode ---

@pytest.mark.asyncio
async def test_encode_base64(tool):
    result = await tool.execute(action="encode", encoding="base64", data="hello")
    assert result == "aGVsbG8="


@pytest.mark.asyncio
async def test_decode_base64(tool):
    result = await tool.execute(action="decode", encoding="base64", data="aGVsbG8=")
    assert result == "hello"


@pytest.mark.asyncio
async def test_encode_hex(tool):
    result = await tool.execute(action="encode", encoding="hex", data="AB")
    assert result == "4142"


@pytest.mark.asyncio
async def test_decode_hex(tool):
    result = await tool.execute(action="decode", encoding="hex", data="4142")
    assert result == "AB"


@pytest.mark.asyncio
async def test_encode_url(tool):
    result = await tool.execute(action="encode", encoding="url", data="hello world&foo=bar")
    assert result == "hello%20world%26foo%3Dbar"


@pytest.mark.asyncio
async def test_decode_url(tool):
    result = await tool.execute(action="decode", encoding="url", data="hello%20world")
    assert result == "hello world"


@pytest.mark.asyncio
async def test_decode_invalid_base64(tool):
    result = await tool.execute(action="decode", encoding="base64", data="!!!not-base64!!!")
    assert "Error" in result


@pytest.mark.asyncio
async def test_encode_decode_roundtrip(tool):
    original = "Hello, World! 123 中文"
    for enc in ("base64", "base32", "hex", "url"):
        encoded = await tool.execute(action="encode", encoding=enc, data=original)
        decoded = await tool.execute(action="decode", encoding=enc, data=encoded)
        assert decoded == original, f"roundtrip failed for {enc}"


# --- jwt_decode ---

@pytest.mark.asyncio
async def test_jwt_decode(tool):
    # A real JWT (header.payload.signature) — header + payload are base64url JSON
    # Header: {"alg":"HS256","typ":"JWT"}
    # Payload: {"sub":"1234567890","name":"John Doe","iat":1516239022}
    import base64
    header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(b'{"sub":"1234567890","name":"John Doe","iat":1516239022}').rstrip(b"=").decode()
    token = f"{header}.{payload}.signature123"

    result = await tool.execute(action="jwt_decode", data=token)
    data = json.loads(result)
    assert data["header"]["alg"] == "HS256"
    assert data["payload"]["name"] == "John Doe"
    assert data["signature"] == "signature123"
    assert "NOT verified" in data["note"]


@pytest.mark.asyncio
async def test_jwt_decode_strips_bearer_prefix(tool):
    import base64
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(b'{"x":1}').rstrip(b"=").decode()
    token = f"Bearer {header}.{payload}.sig"

    result = await tool.execute(action="jwt_decode", data=token)
    data = json.loads(result)
    assert data["payload"]["x"] == 1


@pytest.mark.asyncio
async def test_jwt_decode_invalid_format(tool):
    result = await tool.execute(action="jwt_decode", data="not.a.jwt.format")
    assert "Error" in result


# --- uuid ---

@pytest.mark.asyncio
async def test_uuid_v4(tool):
    result = await tool.execute(action="uuid", version=4)
    assert len(result) == 36  # standard UUID format
    assert result.count("-") == 4


@pytest.mark.asyncio
async def test_uuid_v5_deterministic(tool):
    r1 = await tool.execute(action="uuid", version=5, name="example.com")
    r2 = await tool.execute(action="uuid", version=5, name="example.com")
    assert r1 == r2
    assert len(r1) == 36


@pytest.mark.asyncio
async def test_uuid_v5_requires_name(tool):
    result = await tool.execute(action="uuid", version=5)
    assert "Error" in result


# --- pwd_gen ---

@pytest.mark.asyncio
async def test_pwd_gen_default(tool):
    result = await tool.execute(action="pwd_gen")
    assert len(result) == 16
    # Should contain chars from all four classes by default
    assert any(c.isupper() for c in result)
    assert any(c.islower() for c in result)
    assert any(c.isdigit() for c in result)
    assert any(c in "!@#$%^&*()-_=+[]{};:,.?" for c in result)


@pytest.mark.asyncio
async def test_pwd_gen_custom_length(tool):
    result = await tool.execute(action="pwd_gen", length=32)
    assert len(result) == 32


@pytest.mark.asyncio
async def test_pwd_gen_only_letters(tool):
    result = await tool.execute(
        action="pwd_gen",
        length=20,
        digits="false",
        symbols="false",
    )
    assert len(result) == 20
    assert not any(c.isdigit() for c in result)
    assert not any(c in "!@#$%^&*()-_=+[]{};:,.?" for c in result)


@pytest.mark.asyncio
async def test_pwd_gen_no_ambiguous(tool):
    result = await tool.execute(action="pwd_gen", length=50, no_ambiguous="true")
    # None of the ambiguous chars should appear
    for c in "Il1O0o":
        assert c not in result


@pytest.mark.asyncio
async def test_pwd_gen_uniqueness(tool):
    passwords = {await tool.execute(action="pwd_gen") for _ in range(20)}
    assert len(passwords) == 20  # all unique


# --- url_parse ---

@pytest.mark.asyncio
async def test_url_parse(tool):
    result = await tool.execute(
        action="url_parse",
        data="https://user:pass@example.com:8080/path/to/page?q=1&z=2#frag",
    )
    data = json.loads(result)
    assert data["scheme"] == "https"
    assert data["hostname"] == "example.com"
    assert data["port"] == 8080
    assert data["path"] == "/path/to/page"
    assert data["query"] == "q=1&z=2"
    assert data["fragment"] == "frag"
    assert data["username"] == "user"
    assert data["password"] == "***"  # masked


# --- unknown action ---

@pytest.mark.asyncio
async def test_unknown_action(tool):
    result = await tool.execute(action="encrypt")
    assert "Error" in result
    assert "unknown action" in result
