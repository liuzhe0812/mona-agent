"""Durable, provider-independent image operation and billing checkpoints.

This module only records state. It does not contact a model or a wallet.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from decimal import ROUND_CEILING, Decimal
from uuid import uuid4

from pydantic import ValidationError

from mona.config.schema import HostedWorkImagePrice
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.store import WorkStore, encoded

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_CALL = re.compile(r"^[A-Za-z0-9_.:-]{1,200}$")
_FINGERPRINT = re.compile(r"^[a-f0-9]{64}$")
_PRICE_FIELDS = ("amount_per_image",)
_TERMINAL = frozenset({"settled", "released", "rejected", "free_completed"})
_REASONS = frozenset({"reserve_unknown", "provider_outcome_unknown", "settlement_unknown",
                      "reservation_mismatch", "settlement_mismatch", "over_reservation", "interrupted", "usage_unavailable"})
_CLAIMS = {"reserve": ("prepared", "reserving"), "dispatch": ("reserved", "dispatching"),
           "settle": ("usage_ready", "settling")}

_TABLE = """CREATE TABLE {name} (
    operation_id TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL,
    call_hash TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
    price_snapshot TEXT NOT NULL, reserve_units INTEGER NOT NULL CHECK(reserve_units >= 0),
    confirmed_reserve_units INTEGER CHECK(confirmed_reserve_units IS NULL OR confirmed_reserve_units >= 0),
    billing_mode TEXT CHECK(billing_mode IS NULL OR billing_mode IN ('free','wallet')),
    stage TEXT NOT NULL CHECK(stage IN ('prepared','reserving','reserved','dispatching','running',
        'usage_ready','settling','settled','released','rejected','uncertain','free_completed')),
    usage TEXT, image_result TEXT, expected_units INTEGER CHECK(expected_units IS NULL OR expected_units >= 0),
    actual_units INTEGER CHECK(actual_units IS NULL OR actual_units >= 0),
    outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed','failed')),
    uncertain_from TEXT, reason TEXT, created REAL NOT NULL, updated REAL NOT NULL,
    UNIQUE(owner,run_id,call_hash),
    CHECK(usage IS NULL OR image_result IS NULL),
    CHECK((usage IS NULL AND image_result IS NULL) = (expected_units IS NULL)),
    CHECK((usage IS NULL AND image_result IS NULL) = (outcome IS NULL)),
    CHECK(stage NOT IN ('reserved','dispatching','running','usage_ready','settling','settled')
        OR confirmed_reserve_units IS NOT NULL),
    CHECK(stage NOT IN ('usage_ready','settling','settled') OR usage IS NOT NULL OR image_result IS NOT NULL),
    CHECK(stage != 'settled' OR actual_units IS NOT NULL),
    CHECK(stage != 'free_completed' OR (billing_mode IS 'free' AND reserve_units=0
        AND confirmed_reserve_units IS 0 AND usage IS NULL AND image_result IS NULL AND expected_units IS NULL
        AND actual_units IS NULL AND outcome IS NULL))
)"""


def _invalid() -> WorkError:
    return WorkError("invalid_image_billing", "图片计费记录无效，未执行操作。", 400)


def _conflict() -> WorkError:
    return WorkError("image_billing_conflict", "图片操作状态已变化，请核对后继续。", 409)


def _owner(value: str) -> str:
    if not isinstance(value, str) or not _OWNER.fullmatch(value):
        raise _invalid()
    return value


def _price(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != set(_PRICE_FIELDS):
        raise _invalid()
    try:
        return HostedWorkImagePrice.model_validate(value).model_dump()
    except ValidationError:
        raise _invalid() from None


def _image_result(value: object) -> dict:
    if (not isinstance(value, dict) or set(value) != {"sha256", "image_count"}
            or not isinstance(value["sha256"], str) or not _FINGERPRINT.fullmatch(value["sha256"])
            or type(value["image_count"]) is not int or value["image_count"] != 1):
        raise _invalid()
    return {"sha256": value["sha256"], "image_count": 1}


def _actual_units(price: dict[str, str]) -> int:
    return int((Decimal(price["amount_per_image"]) * 1_000_000).to_integral_value(rounding=ROUND_CEILING))


def _valid_image_result(row) -> bool:
    try:
        _image_result(json.loads(row["image_result"]))
        return (row["outcome"] == "completed"
                and _actual_units(_price(json.loads(row["price_snapshot"]))) == row["expected_units"])
    except (TypeError, ValueError, WorkError):
        return False


def _recovery_authorized(executors_stopped: bool, auth_receipt_verified: bool) -> None:
    if executors_stopped is not True:
        raise WorkError("image_billing_busy", "请先确认原执行已停止，再核对图片操作。", 409)
    if auth_receipt_verified is not True:
        raise WorkError("image_billing_unverified", "请先核验账号计费记录，再继续。", 409)


def _receipt_matches(receipt: object, operation_id: str, reserved_units: int) -> bool:
    return (isinstance(receipt, dict) and receipt.get("run_id") == operation_id
            and type(receipt.get("reserved_units")) is int and receipt["reserved_units"] == reserved_units)


def _schema(db):
    existing = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='image_billing_journal'").fetchone()
    columns = [row["name"] for row in db.execute("PRAGMA table_info(image_billing_journal)")] if existing else []
    migrate = bool(existing and ("billing_mode" not in columns or "image_result" not in columns
                                 or "'free_completed'" not in existing["sql"]))
    return existing, columns, migrate


def _quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _same_rows(db, left: str, right: str, columns: list[str]) -> bool:
    fields = ",".join(_quoted(name) for name in columns)
    left, right = _quoted(left), _quoted(right)
    return (db.execute(f"SELECT count(*) FROM {left}").fetchone()[0] == db.execute(f"SELECT count(*) FROM {right}").fetchone()[0]
            and db.execute(f"SELECT {fields} FROM {left} EXCEPT SELECT {fields} FROM {right} LIMIT 1").fetchone() is None
            and db.execute(f"SELECT {fields} FROM {right} EXCEPT SELECT {fields} FROM {left} LIMIT 1").fetchone() is None)


def _indexes(db) -> dict:
    result = {}
    for index in db.execute("PRAGMA index_list(image_billing_journal)"):
        name = index["name"]
        fields = tuple((row["seqno"], row["name"], row["cid"] if row["cid"] < 0 else None)
                       for row in db.execute(f"PRAGMA index_info({_quoted(name)})"))
        result[name] = (index["unique"], index["origin"], index["partial"], fields)
    return result


def _migration_error() -> WorkError:
    return WorkError("image_billing_migration", "图片计费记录无法安全迁移，请先核对。", 503)


def _migrate(db, columns: list[str]) -> None:
    required = {"operation_id", "owner", "run_id", "call_hash", "request_fingerprint", "price_snapshot",
                "reserve_units", "confirmed_reserve_units", "stage", "usage", "expected_units", "actual_units",
                "outcome", "uncertain_from", "reason", "created", "updated"}
    if not required.issubset(columns) or set(columns) - required - {"billing_mode", "image_result"}:
        raise _migration_error()
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise _migration_error()
    indexes = _indexes(db)
    objects = [(row["type"], row["name"], row["sql"]) for row in db.execute(
        "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='image_billing_journal' "
        "AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")]
    claims = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hosted_image_dispatch_claims'").fetchone()
    claim_snapshot = None
    if claims:
        links = [tuple(row) for row in db.execute("PRAGMA foreign_key_list(hosted_image_dispatch_claims)")]
        claim_columns = [row["name"] for row in db.execute("PRAGMA table_info(hosted_image_dispatch_claims)")]
        if (not {"operation_id", "owner", "run_id"}.issubset(claim_columns)
                or not any(link[2] == "image_billing_journal" and link[3] == "operation_id" and link[4] == "operation_id"
                           for link in links)
                or db.execute("SELECT 1 FROM hosted_image_dispatch_claims c LEFT JOIN image_billing_journal j "
                              "ON j.operation_id=c.operation_id WHERE j.operation_id IS NULL OR c.owner!=j.owner "
                              "OR c.run_id!=j.run_id LIMIT 1").fetchone() is not None):
            raise _migration_error()
        claim_snapshot = "_mona_image_claims_" + uuid4().hex
        db.execute(f"CREATE TEMP TABLE {_quoted(claim_snapshot)} AS SELECT * FROM hosted_image_dispatch_claims")
    db.execute(_TABLE.format(name="image_billing_journal_v2"))
    mode = "billing_mode" if "billing_mode" in columns else "NULL"
    image_result = "image_result" if "image_result" in columns else "NULL"
    db.execute("INSERT INTO image_billing_journal_v2 (operation_id,owner,run_id,call_hash,"
               "request_fingerprint,price_snapshot,reserve_units,confirmed_reserve_units,billing_mode,"
               "stage,usage,image_result,expected_units,actual_units,outcome,uncertain_from,reason,created,updated) "
               "SELECT operation_id,owner,run_id,call_hash,request_fingerprint,price_snapshot,reserve_units,"
               "confirmed_reserve_units," + mode + ",stage,usage," + image_result + ",expected_units,actual_units,outcome,"
               "uncertain_from,reason,created,updated FROM image_billing_journal")
    if not _same_rows(db, "image_billing_journal", "image_billing_journal_v2", columns):
        raise _migration_error()
    db.execute("DROP TABLE image_billing_journal")
    db.execute("ALTER TABLE image_billing_journal_v2 RENAME TO image_billing_journal")
    for _, _, sql in objects:
        db.execute(sql)
    migrated_indexes = _indexes(db)
    for name, definition in indexes.items():
        if migrated_indexes.get(name) != definition:
            raise _migration_error()
    for kind, name, sql in objects:
        row = db.execute("SELECT sql FROM sqlite_master WHERE type=? AND name=? AND tbl_name='image_billing_journal'",
                         (kind, name)).fetchone()
        if row is None or row["sql"] != sql:
            raise _migration_error()
    if claim_snapshot:
        if (not _same_rows(db, "hosted_image_dispatch_claims", claim_snapshot, claim_columns)
                or links != [tuple(row) for row in db.execute("PRAGMA foreign_key_list(hosted_image_dispatch_claims)")]):
            raise _migration_error()
        db.execute(f"DROP TABLE {_quoted(claim_snapshot)}")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise _migration_error()


class ImageBillingJournal:
    def __init__(self, store: WorkStore):
        self.store = store
        if self.store.db.in_transaction:
            raise WorkError("invalid_state", "图片计费记录暂不可用。", 503)
        # The journal deliberately survives removal of a Work conversation; it
        # contains only billing identities and snapshots, not conversation data.
        db = self.store.db
        _, _, needs_migration = _schema(db)
        if needs_migration:
            if db.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
                raise _migration_error()
            db.execute("PRAGMA foreign_keys=OFF")
        try:
            if needs_migration and db.execute("PRAGMA foreign_keys").fetchone()[0] != 0:
                raise _migration_error()
            with self.store.transaction():
                existing, columns, migrate = _schema(db)
                if existing is None:
                    db.execute(_TABLE.format(name="image_billing_journal"))
                elif migrate:
                    if not needs_migration:
                        raise _migration_error()
                    _migrate(db, columns)
                db.execute("CREATE INDEX IF NOT EXISTS image_billing_pending ON image_billing_journal(stage,updated)")
        finally:
            if needs_migration:
                db.execute("PRAGMA foreign_keys=ON")
                if db.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
                    raise _migration_error()

    @staticmethod
    def _record(row) -> dict:
        return {"operation_id": row["operation_id"], "owner": row["owner"], "run_id": row["run_id"],
                "price": json.loads(row["price_snapshot"]), "reserve_units": row["reserve_units"],
                "confirmed_reserve_units": row["confirmed_reserve_units"], "billing_mode": row["billing_mode"],
                "stage": row["stage"], "image_result": json.loads(row["image_result"]) if row["image_result"] is not None else None,
                "legacy_usage": json.loads(row["usage"]) if row["usage"] is not None else None,
                "expected_units": row["expected_units"], "actual_units": row["actual_units"],
                "outcome": row["outcome"], "uncertain_from": row["uncertain_from"], "reason": row["reason"]}

    def _row(self, owner: str, operation_id: str):
        _owner(owner)
        identifier(operation_id)
        row = self.store.db.execute("SELECT * FROM image_billing_journal WHERE owner=? AND operation_id=?",
                                    (owner, operation_id)).fetchone()
        if row is None:
            raise WorkError("not_found", "未找到图片操作记录。", 404)
        return row

    def create(self, owner: str, run_id: str, call_id: str, request_fingerprint: str,
               price: dict[str, str], reserve_units: int, *, operation_id: str | None = None,
               billing_mode: str | None = None) -> tuple[dict, bool]:
        _owner(owner)
        identifier(run_id)
        if operation_id is not None:
            identifier(operation_id)
        if (not isinstance(call_id, str) or not _CALL.fullmatch(call_id)
                or not isinstance(request_fingerprint, str) or not _FINGERPRINT.fullmatch(request_fingerprint)
                or type(reserve_units) is not int or not 0 <= reserve_units <= 9_223_372_036_854_775_807
                or billing_mode not in (None, "free", "wallet")):
            raise _invalid()
        snapshot = _price(price)
        if reserve_units != _actual_units(snapshot):
            raise _invalid()
        if billing_mode == "free" and (reserve_units != 0 or any(Decimal(value) != 0 for value in snapshot.values())):
            raise _invalid()
        call_hash = hashlib.sha256(call_id.encode("ascii")).hexdigest()
        request_hash = hashlib.sha256(bytes.fromhex(request_fingerprint)).hexdigest()
        with self.store.transaction():
            row = self.store.db.execute("SELECT * FROM image_billing_journal WHERE owner=? AND run_id=? AND call_hash=?",
                                        (owner, run_id, call_hash)).fetchone()
            if row is not None:
                if (row["request_fingerprint"] != request_hash or json.loads(row["price_snapshot"]) != snapshot
                        or row["reserve_units"] != reserve_units or row["billing_mode"] != billing_mode
                        or operation_id is not None and row["operation_id"] != operation_id):
                    raise _conflict()
                return self._record(row), False
            if operation_id is not None and self.store.db.execute(
                    "SELECT 1 FROM image_billing_journal WHERE operation_id=?", (operation_id,)).fetchone():
                raise _conflict()
            if self.store.db.execute("SELECT 1 FROM image_billing_journal WHERE owner=? AND run_id=? AND stage='uncertain'",
                                     (owner, run_id)).fetchone():
                raise WorkError("image_billing_pending", "已有图片操作结果待核对，未重复生成。", 409)
            if not self.store.db.execute("SELECT 1 FROM runs WHERE owner=? AND id=?", (owner, run_id)).fetchone():
                raise WorkError("not_found", "未找到该任务。", 404)
            operation_id, now = operation_id or uuid4().hex, time.time()
            self.store.db.execute(
                "INSERT INTO image_billing_journal(operation_id,owner,run_id,call_hash,request_fingerprint,"
                "price_snapshot,reserve_units,billing_mode,stage,created,updated) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)",
                (operation_id, owner, run_id, call_hash, request_hash, encoded(snapshot), reserve_units, billing_mode, now, now))
            return self._record(self._row(owner, operation_id)), True

    def get(self, owner: str, operation_id: str) -> dict:
        return self._record(self._row(owner, operation_id))

    def pending(self, owner: str | None = None) -> list[dict]:
        if owner is not None:
            _owner(owner)
        clause = " AND owner=?" if owner is not None else ""
        return [self._record(row) for row in self.store.db.execute(
            "SELECT * FROM image_billing_journal WHERE stage NOT IN ('settled','released','rejected','free_completed')"
            + clause + " ORDER BY created,operation_id", (owner,) if owner is not None else ())]

    def claim(self, owner: str, operation_id: str, action: str) -> tuple[dict, bool]:
        if not isinstance(action, str) or action not in _CLAIMS:
            raise _invalid()
        expected, target = _CLAIMS[action]
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if (row["stage"] != expected or action == "dispatch" and row["uncertain_from"] is not None
                    or action == "settle" and not _valid_image_result(row)):
                return self._record(row), False
            self.store.db.execute("UPDATE image_billing_journal SET stage=?,updated=? WHERE owner=? AND operation_id=?",
                                  (target, time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id)), True

    def _confirm(self, owner: str, operation_id: str, expected: set[str], target: str) -> dict:
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if row["stage"] == target:
                return self._record(row)
            if row["stage"] not in expected:
                raise _conflict()
            self.store.db.execute("UPDATE image_billing_journal SET stage=?,updated=? WHERE owner=? AND operation_id=?",
                                  (target, time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id))

    def reserved(self, owner: str, operation_id: str, confirmed_units: int) -> dict:
        if type(confirmed_units) is not int or not 0 <= confirmed_units <= 9_223_372_036_854_775_807:
            raise _invalid()
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if row["stage"] == "reserved":
                if row["confirmed_reserve_units"] != confirmed_units:
                    raise _conflict()
                return self._record(row)
            if row["stage"] != "reserving":
                raise _conflict()
            stage = "reserved" if confirmed_units == row["reserve_units"] else "uncertain"
            self.store.db.execute(
                "UPDATE image_billing_journal SET stage=?,confirmed_reserve_units=?,uncertain_from=?,reason=?,updated=? "
                "WHERE owner=? AND operation_id=?",
                (stage, confirmed_units, "reserving" if stage == "uncertain" else None,
                 "reservation_mismatch" if stage == "uncertain" else None, time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id))

    def running(self, owner: str, operation_id: str) -> dict:
        return self._confirm(owner, operation_id, {"dispatching"}, "running")

    def rejected(self, owner: str, operation_id: str) -> dict:
        return self._confirm(owner, operation_id, {"reserving"}, "rejected")

    def released(self, owner: str, operation_id: str) -> dict:
        return self._confirm(owner, operation_id, {"prepared", "reserved"}, "released")

    def release_not_started(self, owner: str, operation_id: str, *, provider_not_started: bool,
                            receipt: dict) -> tuple[dict, bool]:
        """Record an authenticated release only if the caller proved the provider never started."""
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if (row["stage"] != "running" or provider_not_started is not True
                    or row["confirmed_reserve_units"] != row["reserve_units"]
                    or not _receipt_matches(receipt, operation_id, row["reserve_units"])
                    or receipt.get("status") != "released" or receipt.get("actual_units") is not None):
                return self._record(row), False
            self.store.db.execute("UPDATE image_billing_journal SET stage='released',reason='provider_not_started',updated=? "
                                  "WHERE owner=? AND operation_id=?", (time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id)), True

    def record_image_result(self, owner: str, operation_id: str, receipt: dict) -> dict:
        """Persist one verified image before settlement.

        Caller must validate the actual image output and compute its SHA256 from
        the image bytes; a model-provided claim is not evidence of delivery.
        """
        result = _image_result(receipt)
        with self.store.transaction():
            row = self._row(owner, operation_id)
            amount = _actual_units(_price(json.loads(row["price_snapshot"])))
            if row["stage"] in {"usage_ready", "settling", "settled"}:
                if (row["image_result"] is None or json.loads(row["image_result"]) != result or row["outcome"] != "completed"
                        or row["expected_units"] != amount):
                    raise _conflict()
                return self._record(row)
            if row["stage"] != "running":
                raise _conflict()
            self.store.db.execute("UPDATE image_billing_journal SET stage='usage_ready',image_result=?,expected_units=?,"
                                  "outcome='completed',updated=? WHERE owner=? AND operation_id=?",
                                  (encoded(result), amount, time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id))

    def settled(self, owner: str, operation_id: str, actual_units: int) -> dict:
        if type(actual_units) is not int or not 0 <= actual_units <= 9_223_372_036_854_775_807:
            raise _invalid()
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if row["stage"] == "settled":
                if row["actual_units"] != actual_units:
                    raise _conflict()
                return self._record(row)
            if row["stage"] != "settling" or not _valid_image_result(row):
                raise _conflict()
            stage = "settled" if actual_units == row["expected_units"] else "uncertain"
            self.store.db.execute("UPDATE image_billing_journal SET stage=?,actual_units=?,uncertain_from=?,reason=?,updated=? "
                                  "WHERE owner=? AND operation_id=?",
                                  (stage, actual_units, "settling" if stage == "uncertain" else None,
                                   "settlement_mismatch" if stage == "uncertain" else None, time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id))

    def uncertain(self, owner: str, operation_id: str, reason: str) -> dict:
        if not isinstance(reason, str) or reason not in _REASONS:
            raise _invalid()
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if row["stage"] == "uncertain":
                if row["reason"] != reason:
                    raise _conflict()
                return self._record(row)
            if row["stage"] in _TERMINAL:
                raise _conflict()
            self.store.db.execute("UPDATE image_billing_journal SET stage='uncertain',uncertain_from=?,reason=?,updated=? "
                                  "WHERE owner=? AND operation_id=?", (row["stage"], reason, time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id))

    def recover_interrupted(self, owner: str, run_id: str, *, executors_stopped: bool) -> int:
        """After confirming this run's executors stopped, retain uncertain results."""
        _owner(owner)
        identifier(run_id)
        if executors_stopped is not True:
            raise WorkError("image_billing_busy", "请先确认原执行已停止，再核对图片操作。", 409)
        with self.store.transaction():
            result = self.store.db.execute(
                "UPDATE image_billing_journal SET uncertain_from=stage,stage='uncertain',reason='interrupted',updated=? "
                "WHERE owner=? AND run_id=? AND stage IN ('reserving','dispatching','running','settling')",
                (time.time(), owner, run_id))
            return result.rowcount

    def recover_reservation(self, owner: str, operation_id: str, *, executors_stopped: bool,
                            auth_receipt_verified: bool, auth_status: int,
                            receipt: dict | None = None) -> tuple[dict, bool]:
        """Reconcile a reserve without replaying an image.

        Caller must stop the original executor and verify Auth's response belongs
        to this operation. For a 404, caller must also establish that no original
        reservation request remains in flight; a transient absence is not enough.
        """
        _recovery_authorized(executors_stopped, auth_receipt_verified)
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if (row["stage"] != "uncertain" or row["uncertain_from"] != "reserving"
                    or row["reason"] not in {"reserve_unknown", "interrupted"}):
                return self._record(row), False
            if type(auth_status) is int and auth_status == 404 and receipt is None:
                stage, confirmed = "rejected", None
            elif (type(auth_status) is int and auth_status == 200
                  and _receipt_matches(receipt, operation_id, row["reserve_units"])
                  and receipt.get("status") in {"reserved", "released"} and receipt.get("actual_units") is None):
                stage, confirmed = receipt["status"], receipt["reserved_units"]
            else:
                return self._record(row), False
            # Keep uncertain_from as a permanent no-dispatch marker. A recovered
            # hold may be released, but can never initiate/replay image generation.
            self.store.db.execute("UPDATE image_billing_journal SET stage=?,confirmed_reserve_units=?,updated=? "
                                  "WHERE owner=? AND operation_id=?",
                                  (stage, confirmed, time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id)), True

    def recover_settlement(self, owner: str, operation_id: str, *, executors_stopped: bool,
                           auth_receipt_verified: bool, receipt: dict) -> tuple[dict, bool]:
        """Allow only settlement reconciliation after the executor has stopped.

        Caller must verify the authenticated Auth receipt and its operation
        ownership. This does not contact Auth or re-dispatch the image request.
        """
        _recovery_authorized(executors_stopped, auth_receipt_verified)
        with self.store.transaction():
            row = self._row(owner, operation_id)
            if (row["stage"] != "uncertain" or row["uncertain_from"] != "settling"
                    or row["reason"] not in {"settlement_unknown", "interrupted"}):
                return self._record(row), False
            if not _valid_image_result(row):
                return self._record(row), False
            amount = row["expected_units"]
            if (row["confirmed_reserve_units"] != row["reserve_units"] or amount != row["expected_units"]
                    or not _receipt_matches(receipt, operation_id, row["reserve_units"])
                    or not (receipt.get("status") == "running" and receipt.get("actual_units") is None
                            or receipt.get("status") == "settled" and type(receipt.get("actual_units")) is int
                            and receipt["actual_units"] == amount)):
                return self._record(row), False
            self.store.db.execute("UPDATE image_billing_journal SET stage='settling',updated=? WHERE owner=? AND operation_id=?",
                                  (time.time(), owner, operation_id))
            return self._record(self._row(owner, operation_id)), True
