"""Hosted conversation images remain byte-exact and scoped to one account."""
import base64
import hashlib
import io
import json
import sqlite3
from copy import deepcopy

import pytest
from PIL import Image, PngImagePlugin

from mona.hosted_work.contracts import WorkError
from mona.hosted_work.history_media import (
    externalize_media,
    init_history_media,
    measure_media,
    media_references,
    restore_media,
)

OWNER_A = "a" * 64
OWNER_B = "b" * 64
MAX_IMAGE = 1024 * 1024
MAX_STORAGE = 8 * 1024 * 1024
MAX_EXPANDED = 4 * 1024 * 1024


def picture(color="red", fmt="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (4, 4), color).save(output, format=fmt)
    raw = output.getvalue()
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp"}[fmt]
    return raw, f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def block(url, **extra):
    return {"type": "image_url", "image_url": {"url": url, "detail": "high"}, **extra}


@pytest.fixture
def db():
    conn = sqlite3.connect(":memory:", isolation_level=None)
    init_history_media(conn)
    yield conn
    conn.close()


def pack(db, owner, value, **limits):
    return externalize_media(db, owner, value, max_image_bytes=limits.get("max_image_bytes", MAX_IMAGE),
                             max_storage_bytes=limits.get("max_storage_bytes", MAX_STORAGE),
                             max_expanded_bytes=limits.get("max_expanded_bytes", MAX_EXPANDED))


def unpack(db, owner, value, **limits):
    return restore_media(db, owner, value, max_image_bytes=limits.get("max_image_bytes", MAX_IMAGE),
                         max_storage_bytes=limits.get("max_storage_bytes", MAX_STORAGE),
                         max_expanded_bytes=limits.get("max_expanded_bytes", MAX_EXPANDED))


def test_exact_roundtrip_deduplicates_and_never_transforms_text_or_remote_url(db):
    _, url = picture()
    data = [{"role": "tool", "content": [block(url, _meta={"path": "/workspace/example.png"}),
             {"type": "text", "text": url}, block("https://example.test/picture.png")]},
            {"role": "user", "content": [block(url)]}]
    original = data[0]["content"][0]["image_url"]["url"]
    db.execute("BEGIN IMMEDIATE")
    packed = pack(db, OWNER_A, data)
    db.execute("COMMIT")
    expected = "mona-history-media:sha256:" + hashlib.sha256(url.encode("ascii")).hexdigest()
    assert packed[0]["content"][0]["image_url"]["url"] == expected
    assert packed[1]["content"][0]["image_url"]["url"] == expected
    assert packed[0]["content"][1]["text"] == url
    assert packed[0]["content"][2]["image_url"]["url"] == "https://example.test/picture.png"
    assert data[0]["content"][0]["image_url"]["url"] == original
    assert db.execute("SELECT COUNT(*) FROM history_media").fetchone()[0] == 1
    assert unpack(db, OWNER_A, packed) == data
    assert packed[0]["content"][0]["image_url"]["url"] == expected


def test_nested_tuples_cannot_bypass_image_budgets(db):
    _, url = picture()
    value = {"nested": (block(url),)}
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, value)
    db.execute("COMMIT")
    assert unpack(db, OWNER_A, packed) == value
    with pytest.raises(WorkError) as error:
        unpack(db, OWNER_A, packed, max_expanded_bytes=len(url) - 1)
    assert error.value.code == "history_media_limit"


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "GIF", "WEBP"])
def test_supported_formats_preserve_original_url(db, fmt):
    _, url = picture(fmt=fmt)
    value = {"nested": [block(url)]}
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, value)
    db.execute("COMMIT")
    assert unpack(db, OWNER_A, packed) == value


@pytest.mark.parametrize("fmt, header", [
    ("PNG", "DATA:IMAGE/PNG;BASE64"),
    ("PNG", "data:image/x-png;base64"),
    ("JPEG", "data:image/jpg;base64"),
    ("JPEG", "data:image/pjpeg;base64"),
])
def test_valid_header_variants_are_restored_byte_for_byte(db, fmt, header):
    _, original = picture(fmt=fmt)
    url = header + "," + original.split(",", 1)[1]
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, [block(url)])
    db.execute("COMMIT")
    assert unpack(db, OWNER_A, packed) == [block(url)]


@pytest.mark.parametrize("padding", [1, 2])
def test_valid_noncanonical_padding_bits_are_preserved_exactly(db, padding):
    # PNG encoder output size differs across platforms. A short uncompressed
    # text chunk lets us obtain each padding case without invalid image bytes.
    for count in range(3):
        info = PngImagePlugin.PngInfo()
        info.add_text("p", "x" * count)
        output = io.BytesIO()
        Image.new("RGB", (4, 4), "red").save(output, format="PNG", pnginfo=info)
        raw = output.getvalue()
        if len(raw) % 3 == 3 - padding:
            break
    else:
        pytest.fail("PNG test image did not reach the requested Base64 padding")
    encoded = base64.b64encode(raw).decode("ascii")
    assert encoded.endswith("=" * padding) and not encoded.endswith("=" * (padding + 1))
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    index = len(encoded) - padding - 1
    alternate = encoded[:index] + alphabet[alphabet.index(encoded[index]) ^ 1] + encoded[index + 1:]
    assert alternate != encoded and base64.b64decode(alternate, validate=True) == raw
    original = "data:image/png;base64," + alternate
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, [block(original)])
    db.execute("COMMIT")
    assert unpack(db, OWNER_A, packed) == [block(original)]


def test_cross_account_and_forged_references_fail_closed(db):
    _, url = picture()
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, [block(url)])
    db.execute("COMMIT")
    with pytest.raises(WorkError) as error:
        unpack(db, OWNER_B, packed)
    assert error.value.code == "invalid_history_media"
    db.execute("BEGIN")
    with pytest.raises(WorkError) as error:
        pack(db, OWNER_B, packed)
    assert error.value.code == "invalid_history_media"
    db.execute("ROLLBACK")
    db.execute("BEGIN")
    own = pack(db, OWNER_B, [block(url)])
    db.execute("COMMIT")
    assert unpack(db, OWNER_B, own) == [block(url)]
    assert db.execute("SELECT COUNT(*) FROM history_media").fetchone()[0] == 2


def test_database_corruption_is_detected_even_when_digest_reference_exists(db):
    _, url = picture()
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, [block(url)])
    db.execute("COMMIT")
    db.execute("UPDATE history_media SET data=? WHERE owner=?", (b"data:image/png;base64,not-real", OWNER_A))
    with pytest.raises(WorkError) as error:
        unpack(db, OWNER_A, packed)
    assert error.value.code == "invalid_history_media"
    db.execute("BEGIN")
    with pytest.raises(WorkError):
        pack(db, OWNER_A, packed)
    db.execute("ROLLBACK")


def test_requires_outer_transaction_and_does_not_commit_caller_work(db):
    _, url = picture()
    with pytest.raises(WorkError) as error:
        pack(db, OWNER_A, [block(url)])
    assert error.value.code == "invalid_state"
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, [block(url)])
    assert db.in_transaction
    assert db.execute("SELECT COUNT(*) FROM history_media").fetchone()[0] == 1
    db.execute("ROLLBACK")
    assert db.execute("SELECT COUNT(*) FROM history_media").fetchone()[0] == 0
    with pytest.raises(WorkError):
        unpack(db, OWNER_A, packed)


def test_failed_conversion_rolls_back_only_its_inserts(db):
    _, url = picture()
    db.execute("CREATE TABLE caller_work (value TEXT)")
    db.execute("BEGIN IMMEDIATE")
    db.execute("INSERT INTO caller_work VALUES ('preserve')")
    with pytest.raises(WorkError):
        pack(db, OWNER_A, [block(url), block("data:image/png;base64,invalid")])
    assert db.in_transaction
    assert db.execute("SELECT COUNT(*) FROM history_media").fetchone()[0] == 0
    assert db.execute("SELECT value FROM caller_work").fetchone()[0] == "preserve"
    db.execute("COMMIT")
    assert db.execute("SELECT value FROM caller_work").fetchone()[0] == "preserve"


def test_per_image_and_total_limits_apply_to_inline_and_stored_references(db):
    raw, url = picture()
    db.execute("BEGIN")
    with pytest.raises(WorkError) as error:
        pack(db, OWNER_A, [block(url)], max_image_bytes=len(raw) - 1)
    assert error.value.code == "history_media_limit"
    packed = pack(db, OWNER_A, [block(url)])
    db.execute("COMMIT")
    with pytest.raises(WorkError) as error:
        unpack(db, OWNER_A, packed, max_image_bytes=len(raw) - 1)
    assert error.value.code == "history_media_limit"
    with pytest.raises(WorkError) as error:
        unpack(db, OWNER_A, packed * 2, max_expanded_bytes=2 * len(url) - 1)
    assert error.value.code == "history_media_limit"


def test_account_storage_quota_counts_unique_url_bytes_not_other_accounts(db):
    _, red = picture("red")
    _, blue = picture("blue")
    maximum = len(red.encode()) + len(blue.encode()) - 1
    db.execute("BEGIN")
    pack(db, OWNER_A, [block(red)], max_storage_bytes=maximum)
    db.execute("COMMIT")
    db.execute("BEGIN")
    assert pack(db, OWNER_A, [block(red)], max_storage_bytes=maximum)
    with pytest.raises(WorkError) as error:
        pack(db, OWNER_A, [block(blue)], max_storage_bytes=maximum)
    assert error.value.code == "history_media_limit"
    pack(db, OWNER_B, [block(blue)], max_storage_bytes=maximum)
    db.execute("COMMIT")
    assert db.execute("SELECT count(*) FROM history_media").fetchone()[0] == 2


def test_storage_and_single_expansion_have_independent_limits(db):
    _, red = picture("red")
    _, blue = picture("blue")
    single_limit = max(len(red), len(blue))
    storage_limit = len(red) + len(blue)
    db.execute("BEGIN")
    red_ref = pack(db, OWNER_A, [block(red)], max_storage_bytes=storage_limit, max_expanded_bytes=single_limit)
    db.execute("COMMIT")
    db.execute("BEGIN")
    blue_ref = pack(db, OWNER_A, [block(blue)], max_storage_bytes=storage_limit, max_expanded_bytes=single_limit)
    db.execute("COMMIT")
    assert db.execute("SELECT sum(length(data)) FROM history_media WHERE owner=?", (OWNER_A,)).fetchone()[0] > single_limit
    assert unpack(db, OWNER_A, red_ref, max_storage_bytes=storage_limit, max_expanded_bytes=single_limit) == [block(red)]
    assert unpack(db, OWNER_A, blue_ref, max_storage_bytes=storage_limit, max_expanded_bytes=single_limit) == [block(blue)]
    with pytest.raises(WorkError) as error:
        unpack(db, OWNER_A, red_ref + blue_ref, max_storage_bytes=storage_limit, max_expanded_bytes=single_limit)
    assert error.value.code == "history_media_limit"


def test_restore_checks_expansion_budget_before_reading_blob(db):
    _, url = picture()
    db.execute("BEGIN")
    packed = pack(db, OWNER_A, [block(url)])
    db.execute("COMMIT")
    statements = []
    db.set_trace_callback(statements.append)
    try:
        with pytest.raises(WorkError) as error:
            unpack(db, OWNER_A, packed, max_expanded_bytes=len(url) - 1)
        assert error.value.code == "history_media_limit"
        assert not any(sql.lstrip().lower().startswith("select data from history_media") for sql in statements)
    finally:
        db.set_trace_callback(None)


@pytest.mark.parametrize("bad", [
    "data:image/png;base64,not-base64!",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/plain;base64,YQ==",
    "mona-history-media:sha256:NOT-A-VALID-DIGEST",
    "MONA-HISTORY-MEDIA:sha256:" + "a" * 64,
])
def test_invalid_image_urls_and_internal_references_are_rejected(db, bad):
    db.execute("BEGIN")
    with pytest.raises(WorkError) as error:
        pack(db, OWNER_A, [block(bad)])
    assert error.value.code == "invalid_history_media"
    assert db.execute("SELECT COUNT(*) FROM history_media").fetchone()[0] == 0
    db.execute("ROLLBACK")


def test_mime_mismatch_and_malformed_base64_are_not_stored(db):
    _, png = picture()
    mismatch = png.replace("data:image/png", "data:image/jpeg", 1)
    db.execute("BEGIN")
    with pytest.raises(WorkError):
        pack(db, OWNER_A, [block(mismatch)])
    assert db.execute("SELECT COUNT(*) FROM history_media").fetchone()[0] == 0
    db.execute("ROLLBACK")


def test_measure_legacy_images_counts_compact_nonmedia_json_and_leaves_value_untouched():
    _, url = picture()
    value = {"中文": [block(url), {"type": "text", "text": url}, {"nested": block(url)}]}
    projected = {"中文": [block(""), {"type": "text", "text": url}, {"nested": block("")}]}
    expected = len(json.dumps(projected, ensure_ascii=False, separators=(",", ":")).encode())
    assert measure_media(value, max_image_bytes=MAX_IMAGE, max_expanded_bytes=MAX_EXPANDED) == (expected, len(url) * 2)
    assert value["中文"][0]["image_url"]["url"] == url


def test_measure_fails_closed_for_reference_and_total_overflow():
    _, url = picture()
    with pytest.raises(WorkError) as error:
        measure_media([block("mona-history-media:sha256:" + "a" * 64)],
                      max_image_bytes=MAX_IMAGE, max_expanded_bytes=MAX_EXPANDED)
    assert error.value.code == "invalid_history_media"
    with pytest.raises(WorkError) as error:
        measure_media([block(url), block(url)], max_image_bytes=MAX_IMAGE, max_expanded_bytes=len(url) * 2 - 1)
    assert error.value.code == "history_media_limit"


def test_media_references_finds_only_image_blocks_without_mutating_value():
    first = "mona-history-media:sha256:" + "a" * 64
    second = "mona-history-media:sha256:" + "b" * 64
    value = {"history": [block(first), {"nested": (block(second), block(first))},
                         {"type": "text", "text": first}, {"url": second}]}
    before = deepcopy(value)
    assert media_references(value) == {"a" * 64, "b" * 64}
    assert value == before


@pytest.mark.parametrize("bad", [
    "mona-history-media:sha256:short",
    "mona-history-media:sha256:" + "a" * 64 + "?extra",
    "MONA-HISTORY-MEDIA:sha256:" + "a" * 64,
    "mona-history-media-without-separator",
])
def test_media_references_refuses_malformed_reserved_scheme(bad):
    with pytest.raises(WorkError) as error:
        media_references({"context": [block(bad)]})
    assert error.value.code == "invalid_history_media"


def test_media_references_refuses_recursive_data():
    value = []
    value.append(value)
    with pytest.raises(WorkError) as error:
        media_references(value)
    assert error.value.code == "invalid_history_media"
