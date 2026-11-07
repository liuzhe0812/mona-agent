"""Per-image billing checkpoints: no provider, wallet, or network calls."""
import copy
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.image_billing_journal import ImageBillingJournal
from mona.hosted_work.image_coordinator import ImageCoordinator
from mona.hosted_work.store import WorkStore

OWNER, OTHER = owner_key("1"), owner_key("2")
SESSION, RUN = "a" * 32, "b" * 32
FINGERPRINT = hashlib.sha256(b"request data never persisted").hexdigest()
PRICE = {"amount_per_image": "0.000006"}
RESULT = {"sha256": hashlib.sha256(b"verified image bytes").hexdigest(), "image_count": 1}


@pytest.fixture
def journal(tmp_path):
    store = WorkStore(tmp_path / "work.sqlite3", HostedWorkConfig(max_concurrent_runs=4))
    for owner in (OWNER, OTHER):
        store.create_session(owner, NewSession(request_id=SESSION))
        store.create_run(owner, SESSION, NewTurn(request_id=RUN, model_id="test", text="test"))
    try:
        yield ImageBillingJournal(store)
    finally:
        store.close()


def create(journal, *, owner=OWNER, call="call-1", price=None, reserve=6, operation_id=None,
           billing_mode="wallet", fingerprint=FINGERPRINT):
    return journal.create(owner, RUN, call, fingerprint, copy.deepcopy(PRICE if price is None else price), reserve,
                          operation_id=operation_id, billing_mode=billing_mode)


def advance_to_running(journal, op, owner=OWNER):
    assert journal.claim(owner, op, "reserve")[1]
    reserve = journal.get(owner, op)["reserve_units"]
    assert journal.reserved(owner, op, reserve)["stage"] == "reserved"
    assert journal.claim(owner, op, "dispatch")[1]
    assert journal.running(owner, op)["stage"] == "running"


def test_codex_image_configuration_defaults_to_disabled_without_a_price():
    settings = HostedWorkImageSettings()
    assert not settings.enabled and settings.provider == "codex" and settings.billing_mode == "wallet"
    assert settings.model == "" and settings.price is None
    assert "reserve_units" not in settings.model_dump() and "api_key_env" not in settings.model_dump()
    assert "api_base" not in settings.model_dump()
    assert HostedWorkImagePrice(amount_per_image="1.234567").amount_per_image == "1.234567"
    for bad in ({}, {"amount_per_image": -1}, {"amount_per_image": "-1"},
                {"amount_per_image": "0.0000001"}, {"amount_per_image": "1", "other": "secret"}):
        with pytest.raises(ValidationError):
            HostedWorkImagePrice.model_validate(bad)


def test_create_locks_image_price_mode_identity_and_owner(journal):
    op = "c" * 32
    first, created = create(journal, operation_id=op)
    repeated, created_again = create(journal, operation_id=op)
    second, second_created = create(journal, call="call-2")
    other, other_created = create(journal, owner=OTHER)
    assert created and not created_again and repeated == first and second_created and other_created
    assert len({op, second["operation_id"], other["operation_id"]}) == 3
    with pytest.raises(WorkError) as foreign:
        journal.get(OTHER, op)
    assert foreign.value.status == 404
    for changes in ({"price": {"amount_per_image": "0.000007"}, "reserve": 7},
                    {"fingerprint": "d" * 64}, {"billing_mode": None}, {"operation_id": "d" * 32}):
        with pytest.raises(WorkError) as conflict:
            create(journal, **changes)
        assert conflict.value.status == 409
    with pytest.raises(WorkError):
        create(journal, owner=OTHER, call="other-call", operation_id=op)
    raw = dict(journal.store.db.execute("SELECT * FROM image_billing_journal WHERE operation_id=?", (op,)).fetchone())
    assert FINGERPRINT not in json.dumps(raw) and "request data never persisted" not in json.dumps(raw)


@pytest.mark.parametrize("amount,units", [("0", 0), ("0.000001", 1), ("1.234567", 1234567),
                                           ("1000000000", 1000000000000000)])
def test_reserve_is_exactly_the_administrator_price_in_micro_yuan(journal, amount, units):
    record, created = create(journal, price={"amount_per_image": amount}, reserve=units)
    assert created and record["reserve_units"] == units
    with pytest.raises(WorkError):
        create(journal, call="wrong-reserve", price={"amount_per_image": amount}, reserve=units + 1)


def test_confirmed_image_is_billed_once_without_token_usage(journal):
    entry, _ = create(journal)
    op = entry["operation_id"]
    advance_to_running(journal, op)
    receipt = copy.deepcopy(RESULT)
    ready = journal.record_image_result(OWNER, op, receipt)
    receipt["sha256"] = "f" * 64
    assert ready["stage"] == "usage_ready" and ready["image_result"] == RESULT
    assert ready["expected_units"] == 6 and ready["legacy_usage"] is None
    assert journal.record_image_result(OWNER, op, RESULT) == ready
    with pytest.raises(WorkError):
        journal.record_image_result(OWNER, op, receipt)
    assert journal.claim(OWNER, op, "settle")[1]
    assert not journal.claim(OWNER, op, "settle")[1]
    settled = journal.settled(OWNER, op, 6)
    assert settled["stage"] == "settled" and settled["actual_units"] == 6
    assert journal.settled(OWNER, op, 6) == settled and journal.pending(OWNER) == []
    assert not journal.claim(OWNER, op, "dispatch")[1]
    with pytest.raises(WorkError):
        journal.settled(OWNER, op, 7)


@pytest.mark.parametrize("receipt", [None, {}, {"sha256": "a" * 64}, {"sha256": "a" * 64, "image_count": True},
    {"sha256": "a" * 64, "image_count": 0}, {"sha256": "a" * 64, "image_count": 2},
    {"sha256": "A" * 64, "image_count": 1}, {"sha256": "a" * 63, "image_count": 1},
    {**RESULT, "image_bytes": "must not be stored"}])
def test_invalid_or_missing_image_receipt_cannot_trigger_charge(journal, receipt):
    entry, _ = create(journal)
    op = entry["operation_id"]
    advance_to_running(journal, op)
    with pytest.raises(WorkError):
        journal.record_image_result(OWNER, op, receipt)
    assert journal.get(OWNER, op)["stage"] == "running" and journal.get(OWNER, op)["image_result"] is None
    assert not journal.claim(OWNER, op, "settle")[1]


def test_result_requires_confirmed_dispatch_and_unknown_output_is_never_replayed(journal):
    entry, _ = create(journal)
    op = entry["operation_id"]
    journal.claim(OWNER, op, "reserve")
    journal.reserved(OWNER, op, 6)
    journal.claim(OWNER, op, "dispatch")
    with pytest.raises(WorkError):
        journal.record_image_result(OWNER, op, RESULT)
    unknown = journal.uncertain(OWNER, op, "provider_outcome_unknown")
    assert unknown["stage"] == "uncertain" and unknown["image_result"] is None
    assert not journal.claim(OWNER, op, "dispatch")[1] and not journal.claim(OWNER, op, "settle")[1]
    assert create(journal) == (unknown, False)
    with pytest.raises(WorkError) as blocked:
        create(journal, call="call-2")
    assert blocked.value.code == "image_billing_pending"
    assert create(journal, owner=OTHER)[1]


def test_confirmed_unstarted_provider_releases_only_with_matching_auth_receipt(journal):
    entry, _ = create(journal)
    op = entry["operation_id"]
    advance_to_running(journal, op)
    original = journal.get(OWNER, op)
    receipt = {"run_id": op, "status": "released", "reserved_units": 6, "actual_units": None}
    assert journal.release_not_started(OWNER, op, provider_not_started=False, receipt=receipt) == (original, False)
    for bad in ({**receipt, "run_id": "f" * 32}, {**receipt, "reserved_units": 5},
                {**receipt, "reserved_units": True}, {**receipt, "status": "running"},
                {**receipt, "actual_units": 0}, None):
        assert journal.release_not_started(OWNER, op, provider_not_started=True, receipt=bad) == (original, False)
    with pytest.raises(WorkError):
        journal.release_not_started(OTHER, op, provider_not_started=True, receipt=receipt)
    released, changed = journal.release_not_started(OWNER, op, provider_not_started=True, receipt=receipt)
    assert changed and released["stage"] == "released" and released["reason"] == "provider_not_started"
    assert journal.release_not_started(OWNER, op, provider_not_started=True, receipt=receipt) == (released, False)
    assert not journal.claim(OWNER, op, "dispatch")[1] and journal.pending(OWNER) == []
    with pytest.raises(WorkError):
        journal.record_image_result(OWNER, op, RESULT)


@pytest.mark.parametrize("stage", ["reserved", "dispatching", "usage_ready", "uncertain", "settled"])
def test_unstarted_release_never_changes_other_stages(journal, stage):
    entry, _ = create(journal)
    op = entry["operation_id"]
    journal.claim(OWNER, op, "reserve")
    journal.reserved(OWNER, op, 6)
    if stage != "reserved":
        journal.claim(OWNER, op, "dispatch")
    if stage not in {"reserved", "dispatching"}:
        journal.running(OWNER, op)
    if stage in {"usage_ready", "settled"}:
        journal.record_image_result(OWNER, op, RESULT)
    if stage == "settled":
        journal.claim(OWNER, op, "settle")
        journal.settled(OWNER, op, 6)
    if stage == "uncertain":
        journal.uncertain(OWNER, op, "provider_outcome_unknown")
    original = journal.get(OWNER, op)
    receipt = {"run_id": op, "status": "released", "reserved_units": 6, "actual_units": None}
    assert journal.release_not_started(OWNER, op, provider_not_started=True, receipt=receipt) == (original, False)


def test_free_requires_explicit_zero_price_and_the_same_verified_image_receipt(journal):
    free = {"amount_per_image": "0"}
    with pytest.raises(WorkError):
        create(journal, price=free, reserve=6, billing_mode="free")
    with pytest.raises(WorkError):
        create(journal, price=PRICE, reserve=6, billing_mode="free")
    entry, _ = create(journal, price=free, reserve=0, billing_mode="free")
    op = entry["operation_id"]
    advance_to_running(journal, op)
    assert journal.record_image_result(OWNER, op, RESULT)["expected_units"] == 0
    assert journal.claim(OWNER, op, "settle")[1]
    assert journal.settled(OWNER, op, 0)["stage"] == "settled"


@pytest.mark.parametrize("reason", ["reserve_unknown", "interrupted"])
@pytest.mark.parametrize("status", ["not_found", "reserved", "released"])
def test_verified_reservation_recovery_cannot_dispatch_again(journal, reason, status):
    entry, _ = create(journal)
    op = entry["operation_id"]
    journal.claim(OWNER, op, "reserve")
    if reason == "interrupted":
        journal.recover_interrupted(OWNER, RUN, executors_stopped=True)
    else:
        journal.uncertain(OWNER, op, reason)
    receipt = None if status == "not_found" else {"run_id": op, "status": status, "reserved_units": 6, "actual_units": None}
    kwargs = {"executors_stopped": True, "auth_receipt_verified": True,
              "auth_status": 404 if status == "not_found" else 200, "receipt": receipt}
    recovered, changed = journal.recover_reservation(OWNER, op, **kwargs)
    assert changed and recovered["stage"] == ("rejected" if status == "not_found" else status)
    assert recovered["uncertain_from"] == "reserving" and not journal.claim(OWNER, op, "dispatch")[1]
    assert journal.recover_reservation(OWNER, op, **kwargs) == (recovered, False)
    if status == "reserved":
        assert journal.released(OWNER, op)["stage"] == "released"


def test_reservation_recovery_requires_verified_matching_auth_receipt(journal):
    entry, _ = create(journal)
    op = entry["operation_id"]
    journal.claim(OWNER, op, "reserve")
    unknown = journal.uncertain(OWNER, op, "reserve_unknown")
    receipt = {"run_id": op, "status": "reserved", "reserved_units": 6, "actual_units": None}
    for stopped, verified in [(False, True), (True, False)]:
        with pytest.raises(WorkError):
            journal.recover_reservation(OWNER, op, executors_stopped=stopped, auth_receipt_verified=verified,
                                        auth_status=200, receipt=receipt)
    for bad in ({**receipt, "reserved_units": 5}, {**receipt, "reserved_units": True},
                {**receipt, "run_id": "f" * 32}, {**receipt, "status": "running"}):
        assert journal.recover_reservation(OWNER, op, executors_stopped=True, auth_receipt_verified=True,
                                           auth_status=200, receipt=bad) == (unknown, False)
    with pytest.raises(WorkError):
        journal.recover_reservation(OTHER, op, executors_stopped=True, auth_receipt_verified=True,
                                    auth_status=200, receipt=receipt)
    assert journal.get(OWNER, op) == unknown


@pytest.mark.parametrize("reason", ["settlement_unknown", "interrupted"])
@pytest.mark.parametrize("status", ["running", "settled"])
def test_settlement_recovery_requires_saved_verified_image_and_matching_auth(journal, reason, status):
    entry, _ = create(journal)
    op = entry["operation_id"]
    advance_to_running(journal, op)
    journal.record_image_result(OWNER, op, RESULT)
    journal.claim(OWNER, op, "settle")
    if reason == "interrupted":
        journal.recover_interrupted(OWNER, RUN, executors_stopped=True)
    else:
        journal.uncertain(OWNER, op, reason)
    receipt = {"run_id": op, "status": status, "reserved_units": 6, "actual_units": 6 if status == "settled" else None}
    kwargs = {"executors_stopped": True, "auth_receipt_verified": True, "receipt": receipt}
    recovered, changed = journal.recover_settlement(OWNER, op, **kwargs)
    assert changed and recovered["stage"] == "settling" and recovered["image_result"] == RESULT
    assert journal.recover_settlement(OWNER, op, **kwargs) == (recovered, False)
    assert not journal.claim(OWNER, op, "dispatch")[1]
    assert journal.settled(OWNER, op, 6)["stage"] == "settled"


def test_mismatches_or_incomplete_image_remain_uncertain(journal):
    entry, _ = create(journal)
    op = entry["operation_id"]
    advance_to_running(journal, op)
    journal.record_image_result(OWNER, op, RESULT)
    journal.claim(OWNER, op, "settle")
    unknown = journal.uncertain(OWNER, op, "settlement_unknown")
    receipt = {"run_id": op, "status": "settled", "reserved_units": 6, "actual_units": 6}
    for bad in ({**receipt, "actual_units": 7}, {**receipt, "reserved_units": 5},
                {**receipt, "status": "released"}, {**receipt, "status": "uncertain"}):
        assert journal.recover_settlement(OWNER, op, executors_stopped=True, auth_receipt_verified=True,
                                           receipt=bad) == (unknown, False)
    journal.store.db.execute("UPDATE image_billing_journal SET image_result=? WHERE operation_id=?", ('{}', op))
    partial = journal.get(OWNER, op)
    assert journal.recover_settlement(OWNER, op, executors_stopped=True, auth_receipt_verified=True,
                                       receipt=receipt) == (partial, False)


def test_old_token_journal_is_preserved_but_cannot_be_reinterpreted_as_per_image(tmp_path):
    store = WorkStore(tmp_path / "legacy.sqlite3", HostedWorkConfig())
    try:
        store.db.execute("""CREATE TABLE image_billing_journal (
            operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL,
            call_hash TEXT NOT NULL, request_fingerprint TEXT NOT NULL, price_snapshot TEXT NOT NULL,
            reserve_units INTEGER NOT NULL, confirmed_reserve_units INTEGER, stage TEXT NOT NULL,
            usage TEXT, expected_units INTEGER, actual_units INTEGER, outcome TEXT,
            uncertain_from TEXT, reason TEXT, created REAL NOT NULL, updated REAL NOT NULL,
            UNIQUE(owner,run_id,call_hash))""")
        op = "c" * 32
        legacy_price = {"text_input_amount_per_million": "1", "image_input_amount_per_million": "0",
                        "image_output_amount_per_million": "2"}
        legacy_usage = {"text_input_tokens": 4, "image_input_tokens": 0, "image_output_tokens": 1}
        store.db.execute("INSERT INTO image_billing_journal VALUES (?,?,?,?,?,?,6,6,'uncertain',?,6,NULL,'completed',"
                         "'settling','settlement_unknown',1,1)",
                         (op, OWNER, RUN, "hash", FINGERPRINT, json.dumps(legacy_price), json.dumps(legacy_usage)))
        migrated = ImageBillingJournal(store)
        record = migrated.get(OWNER, op)
        assert record["billing_mode"] is None and record["image_result"] is None and record["legacy_usage"] == legacy_usage
        receipt = {"run_id": op, "status": "settled", "reserved_units": 6, "actual_units": 6}
        assert migrated.recover_settlement(OWNER, op, executors_stopped=True, auth_receipt_verified=True,
                                           receipt=receipt) == (record, False)
        assert ImageBillingJournal(store).get(OWNER, op) == record
    finally:
        store.close()


def legacy_journal_with_claims(store):
    db = store.db
    db.execute("""CREATE TABLE image_billing_journal (
        operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL,
        call_hash TEXT NOT NULL, request_fingerprint TEXT NOT NULL, price_snapshot TEXT NOT NULL,
        reserve_units INTEGER NOT NULL, confirmed_reserve_units INTEGER, stage TEXT NOT NULL,
        usage TEXT, expected_units INTEGER, actual_units INTEGER, outcome TEXT,
        uncertain_from TEXT, reason TEXT, created REAL NOT NULL, updated REAL NOT NULL,
        UNIQUE(owner,run_id,call_hash))""")
    db.execute("CREATE INDEX image_billing_pending ON image_billing_journal(stage,updated)")
    db.execute("CREATE INDEX legacy_image_owner ON image_billing_journal(owner,run_id)")
    db.execute("""CREATE TABLE hosted_image_dispatch_claims (
        operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL,
        run_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created REAL NOT NULL,
        FOREIGN KEY(operation_id) REFERENCES image_billing_journal(operation_id))""")
    db.execute("CREATE INDEX legacy_claim_owner ON hosted_image_dispatch_claims(owner)")
    for op, owner, run, session, call in [("c" * 32, OWNER, RUN, SESSION, "call-a"),
                                          ("d" * 32, OTHER, "e" * 32, "f" * 32, "call-b")]:
        request_hash = hashlib.sha256(bytes.fromhex(FINGERPRINT)).hexdigest()
        db.execute("INSERT INTO image_billing_journal VALUES (?,?,?,?,?,?,6,6,'running',NULL,NULL,NULL,NULL,NULL,NULL,1,1)",
                   (op, owner, run, call, request_hash, json.dumps(PRICE)))
        db.execute("INSERT INTO hosted_image_dispatch_claims VALUES (?,?,?,?,?,?)", (op, owner, session, run, FINGERPRINT, 1))
    columns = [row["name"] for row in db.execute("PRAGMA table_info(image_billing_journal)")]
    records = [tuple(row) for row in db.execute("SELECT * FROM image_billing_journal ORDER BY operation_id")]
    claims = [tuple(row) for row in db.execute("SELECT * FROM hosted_image_dispatch_claims ORDER BY operation_id")]
    indexes = [tuple(row) for row in db.execute("SELECT name,sql FROM sqlite_master WHERE type='index' "
                                               "AND name IN ('image_billing_pending','legacy_image_owner','legacy_claim_owner') "
                                               "ORDER BY name")]
    links = [tuple(row) for row in db.execute("PRAGMA foreign_key_list(hosted_image_dispatch_claims)")]
    return columns, records, claims, indexes, links


def assert_legacy_migration_preserved(store, before):
    db = store.db
    columns, records, claims, indexes, links = before
    selected = ",".join('"' + name + '"' for name in columns)
    assert [tuple(row) for row in db.execute(f"SELECT {selected} FROM image_billing_journal ORDER BY operation_id")] == records
    assert [tuple(row) for row in db.execute("SELECT * FROM hosted_image_dispatch_claims ORDER BY operation_id")] == claims
    assert [tuple(row) for row in db.execute("SELECT name,sql FROM sqlite_master WHERE type='index' "
                                             "AND name IN ('image_billing_pending','legacy_image_owner','legacy_claim_owner') "
                                             "ORDER BY name")] == indexes
    assert [tuple(row) for row in db.execute("PRAGMA foreign_key_list(hosted_image_dispatch_claims)")] == links
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert db.execute("SELECT 1 FROM sqlite_master WHERE name='image_billing_journal_v2'").fetchone() is None


def test_migration_preserves_dispatch_claims_journal_and_indexes_without_replay(tmp_path):
    store = WorkStore(tmp_path / "legacy-claims.sqlite3", HostedWorkConfig())
    try:
        before = legacy_journal_with_claims(store)
        journal = ImageBillingJournal(store)
        assert_legacy_migration_preserved(store, before)
        assert journal.get(OWNER, "c" * 32)["billing_mode"] is None
        coordinator = ImageCoordinator(HostedWorkConfig(), SimpleNamespace(journal=journal), None)
        assert not coordinator._claim(OWNER, SESSION, RUN, "c" * 32, FINGERPRINT)
        assert not coordinator._claim(OTHER, "f" * 32, "e" * 32, "d" * 32, FINGERPRINT)
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("INSERT INTO hosted_image_dispatch_claims VALUES(?,?,?,?,?,?)",
                             ("c" * 32, OWNER, SESSION, RUN, FINGERPRINT, 2))
        assert_legacy_migration_preserved(store, before)
    finally:
        store.close()


def test_migration_failure_after_drop_rolls_back_claims_journal_and_indexes(tmp_path):
    store = WorkStore(tmp_path / "legacy-rollback.sqlite3", HostedWorkConfig())
    try:
        before = legacy_journal_with_claims(store)

        def deny_rename(action, _arg1, arg2, _db, _source):
            if action == sqlite3.SQLITE_ALTER_TABLE and arg2 == "image_billing_journal_v2":
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        store.db.set_authorizer(deny_rename)
        with pytest.raises(sqlite3.DatabaseError):
            ImageBillingJournal(store)
        store.db.set_authorizer(None)
        assert_legacy_migration_preserved(store, before)
        with pytest.raises(sqlite3.IntegrityError):
            store.db.execute("INSERT INTO hosted_image_dispatch_claims VALUES(?,?,?,?,?,?)",
                             ("c" * 32, OWNER, SESSION, RUN, FINGERPRINT, 2))
        legacy = object.__new__(ImageBillingJournal)
        legacy.store = store
        coordinator = ImageCoordinator(HostedWorkConfig(), SimpleNamespace(journal=legacy), None)
        assert not coordinator._claim(OWNER, SESSION, RUN, "c" * 32, FINGERPRINT)
        journal = ImageBillingJournal(store)
        assert_legacy_migration_preserved(store, before)
        coordinator = ImageCoordinator(HostedWorkConfig(), SimpleNamespace(journal=journal), None)
        assert not coordinator._claim(OWNER, SESSION, RUN, "c" * 32, FINGERPRINT)
    finally:
        store.db.set_authorizer(None)
        store.close()


def test_migration_rejects_claim_bound_to_wrong_owner_without_changes(tmp_path):
    store = WorkStore(tmp_path / "legacy-mismatched-claim.sqlite3", HostedWorkConfig())
    try:
        columns, records, _, indexes, links = legacy_journal_with_claims(store)
        store.db.execute("UPDATE hosted_image_dispatch_claims SET owner=? WHERE operation_id=?", (OTHER, "c" * 32))
        claims = [tuple(row) for row in store.db.execute("SELECT * FROM hosted_image_dispatch_claims ORDER BY operation_id")]
        before = (columns, records, claims, indexes, links)
        with pytest.raises(WorkError) as error:
            ImageBillingJournal(store)
        assert error.value.code == "image_billing_migration"
        assert_legacy_migration_preserved(store, before)
    finally:
        store.close()


def test_wal_competing_creates_and_dispatches_claim_once(journal, tmp_path):
    barrier = Barrier(2)

    def create_one(_):
        store = WorkStore(tmp_path / "work.sqlite3", HostedWorkConfig())
        try:
            local = ImageBillingJournal(store)
            barrier.wait(timeout=5)
            return create(local)
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        records = list(pool.map(create_one, range(2)))
    assert sorted(created for _, created in records) == [False, True]
    op = records[0][0]["operation_id"]
    assert records[1][0]["operation_id"] == op
    journal.claim(OWNER, op, "reserve")
    journal.reserved(OWNER, op, 6)
    barrier = Barrier(2)

    def dispatch_one(_):
        store = WorkStore(tmp_path / "work.sqlite3", HostedWorkConfig())
        try:
            local = ImageBillingJournal(store)
            barrier.wait(timeout=5)
            return local.claim(OWNER, op, "dispatch")[1]
        finally:
            store.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(dispatch_one, range(2))) == [False, True]
