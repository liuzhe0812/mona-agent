"""Isolated Hosted Work billing against the existing wallet and ledger."""
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.database import Base
from app.errors import AuthError
from app.model_billing import actual_units
from app.models import SQLITE_BIGINT_PK, CreditEventType, CreditLedger, CreditWallet
from sqlalchemy import JSON, BigInteger, CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column


class HostedWorkCharge(Base):
    __tablename__ = "hosted_work_charges"
    __table_args__ = (
        CheckConstraint("reserved_units >= 0", name="ck_hosted_charge_reserved_nonnegative"),
        CheckConstraint("actual_units IS NULL OR actual_units >= 0", name="ck_hosted_charge_actual_nonnegative"),
        Index("ix_hosted_charge_user_created", "user_id", "created_at"),
        Index("ix_hosted_charge_status_updated", "status", "updated_at"),
    )
    run_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(SQLITE_BIGINT_PK, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    reserved_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    actual_units: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    price_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    usage_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    review_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=func.now(), onupdate=func.now())
    settled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


def _conflict():
    raise AuthError("hosted_charge_conflict", "Hosted charge state or parameters conflict", 409)


def _get_charge(db: Session, run_id: str, *, lock: bool = False) -> HostedWorkCharge:
    q = db.query(HostedWorkCharge).filter_by(run_id=run_id).populate_existing()
    row = (q.with_for_update() if lock else q).first()
    if row is None:
        raise AuthError("hosted_charge_not_found", "Hosted charge not found", 404)
    return row


def _wallet(db: Session, user_id: int) -> CreditWallet | None:
    return db.query(CreditWallet).filter_by(user_id=user_id).populate_existing().with_for_update().first()


def _matches(row, user_id, model, price, reserved):
    return (row.user_id == user_id and row.model == model and row.price_json == price
            and row.reserved_units == reserved)


def reserve(db: Session, *, run_id: str, user_id: int, model: str, price: dict, reserved: int):
    # Lock wallets before Hosted charge rows throughout this module. Desktop counters
    # and pricing tables are deliberately untouched.
    wallet = _wallet(db, user_id)
    existing = db.query(HostedWorkCharge).filter_by(run_id=run_id).populate_existing().with_for_update().first()
    if existing is not None:
        if not _matches(existing, user_id, model, price, reserved):
            _conflict()
        return existing
    if reserved > 0 and (wallet is None or wallet.available_units < reserved):
        raise AuthError("insufficient_balance", "Insufficient available balance", 402)
    if reserved > 0:
        wallet.available_units -= reserved
        wallet.reserved_units += reserved
        wallet.version += 1
    row = HostedWorkCharge(run_id=run_id, user_id=user_id, model=model, status="reserved",
                           reserved_units=reserved, price_json=price)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Another account can race on a globally unique run_id. Roll back the
        # wallet adjustment before returning the already-created result/conflict.
        db.rollback()
        row = db.query(HostedWorkCharge).filter_by(run_id=run_id).first()
        if row is None:
            raise
        if not _matches(row, user_id, model, price, reserved):
            _conflict()
    return row


def dispatch(db: Session, run_id: str):
    row = _get_charge(db, run_id, lock=True)
    if row.status == "reserved":
        row.status = "running"
        db.commit()
    elif row.status != "running":
        _conflict()
    return row


def release(db: Session, run_id: str):
    # Read only to discover the bound owner, then lock in wallet/charge order.
    owner = _get_charge(db, run_id).user_id
    wallet = _wallet(db, owner)
    row = _get_charge(db, run_id, lock=True)
    if row.user_id != owner:
        _conflict()
    if row.status == "released":
        return row
    if row.status != "reserved":
        _conflict()
    if row.reserved_units:
        if wallet is None or wallet.reserved_units < row.reserved_units:
            raise AuthError("hosted_wallet_inconsistent", "Reserved balance mismatch", 503)
        wallet.reserved_units -= row.reserved_units
        wallet.available_units += row.reserved_units
        wallet.version += 1
    row.status = "released"
    db.commit()
    return row


def mark_uncertain(db: Session, run_id: str, reason: str):
    row = _get_charge(db, run_id, lock=True)
    if row.status == "uncertain":
        if row.review_reason != reason:
            _conflict()
        return row
    if row.status != "running":
        _conflict()
    row.status = "uncertain"
    row.review_reason = reason
    db.commit()
    return row


def settle(db: Session, run_id: str, usage: dict):
    owner = _get_charge(db, run_id).user_id
    wallet = _wallet(db, owner)
    row = _get_charge(db, run_id, lock=True)
    if row.user_id != owner:
        _conflict()
    if row.usage_json is not None and row.usage_json != usage:
        _conflict()
    if row.status == "settled":
        return row
    if row.status not in ("running", "uncertain"):
        _conflict()
    price = row.price_json
    rates = SimpleNamespace(
        input_rate=int(Decimal(price["input_amount_per_million"]) * 1_000_000),
        cached_input_rate=int(Decimal(price["cached_input_amount_per_million"]) * 1_000_000),
        output_rate=int(Decimal(price["output_amount_per_million"]) * 1_000_000),
    )
    charged = actual_units(rates, prompt_tokens=usage["input_tokens"],
                           cached_tokens=usage["cached_input_tokens"],
                           completion_tokens=usage["output_tokens"])
    row.usage_json = usage
    row.actual_units = charged
    if row.reserved_units and (wallet is None or wallet.reserved_units < row.reserved_units):
        raise AuthError("hosted_wallet_inconsistent", "Reserved balance mismatch", 503)
    extra = max(0, charged - row.reserved_units)
    if extra and (wallet is None or wallet.available_units < extra):
        row.status = "uncertain"
        row.review_reason = "insufficient_balance_for_settlement"
        db.commit()
        return row
    if wallet is not None:
        wallet.reserved_units -= row.reserved_units
        wallet.available_units += row.reserved_units - charged
        wallet.version += 1
        db.add(CreditLedger(
            user_id=row.user_id, delta_units=-charged, event_type=CreditEventType.USAGE,
            reference_id=f"hosted:{run_id}",
            balance_after=wallet.available_units + wallet.reserved_units,
            metadata_json={"source": "hosted_work", "model": row.model,
                           "price": price, "usage": usage},
        ))
    elif charged or row.reserved_units:
        raise AuthError("hosted_wallet_inconsistent", "Wallet not found", 503)
    row.status = "settled"
    row.review_reason = None
    row.settled_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return row


def view(row: HostedWorkCharge) -> dict:
    return {"run_id": row.run_id, "status": row.status,
            "reserved_units": row.reserved_units, "actual_units": row.actual_units}
