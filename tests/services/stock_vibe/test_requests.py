from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest

from mona.services.stock_vibe.requests import (
    RequestConflictError,
    RequestStore,
    normalize_request_id,
)


def _source(*, instance_id: str = "a" * 32, root_hash: str = "b" * 64) -> dict[str, Any]:
    return {
        "data_root_sha256": root_hash,
        "instance_id": instance_id,
        "snapshot_id": "sha256:" + "c" * 64,
        "patches": [
            {
                "path": "0001-host-isolation.json",
                "category": "host-integration",
                "sha256": "d" * 64,
            },
            {
                "path": "0004-host-requests.json",
                "category": "host-integration",
                "sha256": "e" * 64,
            },
        ],
    }


def test_claim_normalizes_uuid_hashes_canonical_request_and_never_persists_payload(tmp_path: Path) -> None:
    store = RequestStore(tmp_path / "host" / "requests.sqlite3")
    request_id = uuid.uuid4()
    payload = {"title": "private request text", "settings": {"model": "qwen", "temperature": 0.1}}

    record, claimed = store.claim(str(request_id), "post", "/sessions", payload)
    replay, replay_claimed = store.claim(request_id.hex, "POST", "/sessions", {
        "settings": {"temperature": 0.1, "model": "qwen"},
        "title": "private request text",
    })

    assert claimed is True
    assert replay_claimed is False
    assert record["request_id"] == request_id.hex
    assert replay["request_id"] == request_id.hex
    assert record["payload_sha256"] == replay["payload_sha256"]
    assert record["status"] == "unknown"
    assert replay["status"] == "unknown"

    database = store.path.read_bytes()
    assert b"private request text" not in database
    with sqlite3.connect(store.path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(requests)")}
    assert not {"payload", "request_body", "authorization", "api_key"} & columns


def test_concurrent_same_id_has_exactly_one_claimant(tmp_path: Path) -> None:
    store = RequestStore(tmp_path / "requests.sqlite3")
    request_id = uuid.uuid4().hex
    payload = {"session_id": "session-1", "content": "one message"}

    def claim() -> tuple[dict[str, Any], bool]:
        return store.claim(request_id, "POST", "/sessions/session-1/messages", payload)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: claim(), range(8)))

    assert sum(claimed for _, claimed in results) == 1
    assert {record["request_id"] for record, _ in results} == {request_id}
    assert {record["payload_sha256"] for record, _ in results}.__len__() == 1


def test_same_id_different_payload_is_a_conflict(tmp_path: Path) -> None:
    store = RequestStore(tmp_path / "requests.sqlite3")
    request_id = uuid.uuid4().hex
    store.claim(request_id, "POST", "/sessions", {"title": "first"})

    with pytest.raises(RequestConflictError):
        store.claim(request_id, "POST", "/sessions", {"title": "second"})
    with pytest.raises(RequestConflictError):
        store.claim(request_id, "PATCH", "/sessions", {"title": "first"})
    with pytest.raises(RequestConflictError):
        store.claim(request_id, "POST", "/sessions/session-1", {"title": "first"})

    assert store.get(request_id)["payload_sha256"] != ""


def test_completed_receipt_and_source_are_immutable_and_referenceable(tmp_path: Path) -> None:
    store = RequestStore(tmp_path / "requests.sqlite3")
    request_id = uuid.uuid4()
    request_hex = request_id.hex
    source = _source()
    receipt = {
        "request_id": str(request_id),
        "status": "completed",
        "receipt": {"status_code": 201, "body": {"session_id": "native-session-1"}},
    }
    store.claim(str(request_id), "POST", "/sessions", {"title": "safe"})
    store.bind_source(request_hex, source)

    completed = store.complete(
        request_hex,
        status="completed",
        receipt=receipt,
        source=source,
    )
    replayed = store.complete(
        request_hex,
        status="completed",
        receipt=receipt,
        source=source,
    )

    assert completed["status"] == "completed"
    assert completed["receipt"] == receipt
    assert completed["receipt_sha256"] == hashlib.sha256(
        json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert completed["source"] == source
    assert completed["source_sha256"] == replayed["source_sha256"]
    assert store.bind_source(request_hex, source) == completed | {"updated_at": completed["updated_at"]}

    changed_receipt = {**receipt, "receipt": {"status_code": 201, "body": {"session_id": "different"}}}
    with pytest.raises(RequestConflictError):
        store.complete(request_hex, status="completed", receipt=changed_receipt, source=source)
    with pytest.raises(RequestConflictError):
        store.complete(request_hex, status="completed", receipt=receipt, source=_source(instance_id="f" * 32))

    store.record_reference("session", "native-session-1", request_hex, source)
    store.record_reference("session", "native-session-1", request_hex, source)
    assert store.reference("session", "native-session-1") == source

    other_source = _source(instance_id="f" * 32)
    with pytest.raises(RequestConflictError):
        store.bind_source(request_hex, other_source)
    other_id = uuid.uuid4().hex
    store.claim(other_id, "POST", "/sessions", {"title": "second"})
    store.bind_source(other_id, other_source)
    with pytest.raises(RequestConflictError):
        store.record_reference("session", "native-session-1", other_id, other_source)


def test_restart_unknown_is_lookup_only_and_not_reclaimable(tmp_path: Path) -> None:
    database = tmp_path / "host" / "requests.sqlite3"
    request_id = str(uuid.uuid4())
    first_store = RequestStore(database)
    first, claimed = first_store.claim(request_id, "POST", "/sessions", {"title": "one"})
    first_store.bind_source(first["request_id"], _source())
    first_store.mark_unknown(first["request_id"], "connection_lost")

    restarted_store = RequestStore(database)
    recovered = restarted_store.get(request_id)
    replay, claimed_after_restart = restarted_store.claim(
        request_id, "POST", "/sessions", {"title": "one"}
    )

    assert claimed is True
    assert recovered["status"] == "unknown"
    assert replay["status"] == "unknown"
    assert replay["error_category"] == "connection_lost"
    assert claimed_after_restart is False


@pytest.mark.parametrize("request_id", ["arbitrary text", "{}", "1234", "00000000-0000-0000-0000-00000000000g"])
def test_request_id_rejects_non_uuid_values(request_id: str) -> None:
    with pytest.raises(ValueError):
        normalize_request_id(request_id)


def test_unknown_records_only_an_error_category(tmp_path: Path) -> None:
    store = RequestStore(tmp_path / "requests.sqlite3")
    request_id = uuid.uuid4().hex
    store.claim(request_id, "POST", "/sessions", {"token": "never persist this"})
    record = store.mark_unknown(request_id, "native_timeout")

    assert record["status"] == "unknown"
    assert record["error_category"] == "native_timeout"
    assert b"never persist this" not in store.path.read_bytes()
    with pytest.raises(ValueError):
        store.mark_unknown(request_id, "timeout: raw exception detail")
