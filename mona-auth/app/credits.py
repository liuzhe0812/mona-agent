from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.errors import AuthError
from app.models import (
    CreditEventType,
    CreditLedger,
    CreditWallet,
    ModelGatewayLock,
    ModelRequest,
    ModelRequestStatus,
)

BALANCE_UNIT_SCALE = 1_000_000
CREDIT_UNIT_SCALE = BALANCE_UNIT_SCALE


def display_amount(units: int) -> str:
    value = Decimal(units) / Decimal(BALANCE_UNIT_SCALE)
    return format(value.normalize(), "f")


def amount_to_units(amount: Decimal) -> int:
    scaled = amount * Decimal(BALANCE_UNIT_SCALE)
    if scaled != scaled.to_integral_value():
        raise ValueError("amount has more than six decimal places")
    return int(scaled)


def display_credits(units: int) -> str:
    """Deprecated compatibility alias for clients released before RMB balance."""
    return display_amount(units)


def _wallet_query(db: Session, user_id: int, *, lock: bool):
    query = db.query(CreditWallet).filter(CreditWallet.user_id == user_id)
    return query.with_for_update() if lock else query


def get_wallet(db: Session, user_id: int, *, lock: bool = False) -> CreditWallet:
    wallet = _wallet_query(db, user_id, lock=lock).first()
    if wallet is None:
        wallet = CreditWallet(user_id=user_id, available_units=0, reserved_units=0)
        db.add(wallet)
        db.flush()
    return wallet


def _lock_gateway_admission(db: Session) -> ModelGatewayLock:
    lock = db.query(ModelGatewayLock).filter(ModelGatewayLock.id == 1).with_for_update().first()
    if lock is None:
        lock = ModelGatewayLock(id=1, active_requests=0)
        db.add(lock)
        db.flush()
    return lock


def _decrement_active_counters(
    db: Session,
    *,
    wallet: CreditWallet,
) -> None:
    gateway = _lock_gateway_admission(db)
    if wallet.active_requests <= 0 or gateway.active_requests <= 0:
        raise AuthError(
            "capacity_counter_invalid",
            "Active request counters are inconsistent",
            500,
        )
    wallet.active_requests -= 1
    gateway.active_requests -= 1


def grant_topup(
    db: Session,
    *,
    user_id: int,
    units: int,
    reference_id: str,
    metadata: dict | None = None,
) -> CreditWallet:
    if units <= 0:
        raise ValueError("topup units must be positive")
    existing = (
        db.query(CreditLedger)
        .filter(
            CreditLedger.event_type == CreditEventType.TOPUP,
            CreditLedger.reference_id == reference_id,
        )
        .first()
    )
    if existing is not None:
        if existing.user_id != user_id:
            raise AuthError("reference_conflict", "Reference is already in use", status_code=409)
        return get_wallet(db, user_id, lock=True)

    wallet = get_wallet(db, user_id, lock=True)
    wallet.available_units += units
    wallet.version += 1
    db.add(
        CreditLedger(
            user_id=user_id,
            delta_units=units,
            event_type=CreditEventType.TOPUP,
            reference_id=reference_id,
            balance_after=wallet.available_units + wallet.reserved_units,
            metadata_json=metadata,
        )
    )
    return wallet


def adjust_credits(
    db: Session,
    *,
    user_id: int,
    delta_units: int,
    reference_id: str,
    reason: str,
    admin_user_id: int,
) -> CreditWallet:
    if delta_units == 0:
        raise ValueError("adjustment cannot be zero")
    existing = (
        db.query(CreditLedger)
        .filter(
            CreditLedger.event_type == CreditEventType.ADJUSTMENT,
            CreditLedger.reference_id == reference_id,
        )
        .first()
    )
    if existing is not None:
        if existing.user_id != user_id or existing.delta_units != delta_units:
            raise AuthError("reference_conflict", "Reference is already in use", 409)
        return get_wallet(db, user_id, lock=True)

    wallet = get_wallet(db, user_id, lock=True)
    _lock_gateway_admission(db)
    existing = (
        db.query(CreditLedger)
        .filter(
            CreditLedger.event_type == CreditEventType.ADJUSTMENT,
            CreditLedger.reference_id == reference_id,
        )
        .with_for_update()
        .first()
    )
    if existing is not None:
        if existing.user_id != user_id or existing.delta_units != delta_units:
            raise AuthError("reference_conflict", "Reference is already in use", 409)
        return wallet
    if delta_units < 0 and wallet.available_units < -delta_units:
        raise AuthError("insufficient_credits", "Insufficient available balance", 409)
    wallet.available_units += delta_units
    wallet.version += 1
    db.add(
        CreditLedger(
            user_id=user_id,
            delta_units=delta_units,
            event_type=CreditEventType.ADJUSTMENT,
            reference_id=reference_id,
            balance_after=wallet.available_units + wallet.reserved_units,
            metadata_json={"reason": reason, "admin_user_id": admin_user_id},
        )
    )
    return wallet


def apply_refund(
    db: Session,
    *,
    user_id: int,
    units: int,
    reference_id: str,
    payment_id: int,
    admin_user_id: int,
    reason: str,
) -> CreditWallet:
    if units <= 0:
        raise ValueError("refund units must be positive")
    existing = (
        db.query(CreditLedger)
        .filter(
            CreditLedger.event_type == CreditEventType.REFUND,
            CreditLedger.reference_id == reference_id,
        )
        .first()
    )
    if existing is not None:
        if existing.user_id != user_id or existing.delta_units != -units:
            raise AuthError("reference_conflict", "Reference is already in use", 409)
        return get_wallet(db, user_id, lock=True)

    wallet = get_wallet(db, user_id, lock=True)
    if wallet.available_units < units:
        raise AuthError(
            "refund_balance_spent",
            "Purchased balance has already been reserved or spent",
            409,
        )
    wallet.available_units -= units
    wallet.version += 1
    db.add(
        CreditLedger(
            user_id=user_id,
            delta_units=-units,
            event_type=CreditEventType.REFUND,
            reference_id=reference_id,
            balance_after=wallet.available_units + wallet.reserved_units,
            metadata_json={
                "payment_id": payment_id,
                "admin_user_id": admin_user_id,
                "reason": reason,
            },
        )
    )
    return wallet


def reserve_request(
    db: Session,
    *,
    request_id: str,
    user_id: int,
    model: str,
    reserved_units: int,
    price_version: int,
    promotion_id: int | None = None,
    price_multiplier_bps: int = 10_000,
    billing_type: str = "token",
    request_hash: str | None = None,
    allow_existing: bool = True,
) -> ModelRequest:
    if reserved_units <= 0:
        raise ValueError("reserved units must be positive")
    existing = db.query(ModelRequest).filter(ModelRequest.request_id == request_id).first()
    if existing is not None:
        if existing.user_id != user_id:
            raise AuthError("request_conflict", "Request ID is already in use", status_code=409)
        if (
            existing.model != model
            or existing.reserved_units != reserved_units
            or existing.price_version != price_version
            or existing.promotion_id != promotion_id
            or existing.price_multiplier_bps != price_multiplier_bps
            or existing.billing_type != billing_type
            or existing.request_hash != request_hash
        ):
            raise AuthError("request_conflict", "Request ID payload changed", status_code=409)
        if not allow_existing:
            raise AuthError("request_already_exists", "Request ID is already in use", 409)
        return existing

    wallet = get_wallet(db, user_id, lock=True)
    gateway = _lock_gateway_admission(db)
    existing = (
        db.query(ModelRequest)
        .filter(ModelRequest.request_id == request_id)
        .with_for_update()
        .first()
    )
    if existing is not None:
        if existing.user_id != user_id:
            raise AuthError("request_conflict", "Request ID is already in use", status_code=409)
        if (
            existing.model != model
            or existing.reserved_units != reserved_units
            or existing.price_version != price_version
            or existing.promotion_id != promotion_id
            or existing.price_multiplier_bps != price_multiplier_bps
            or existing.billing_type != billing_type
            or existing.request_hash != request_hash
        ):
            raise AuthError("request_conflict", "Request ID payload changed", status_code=409)
        if not allow_existing:
            raise AuthError("request_already_exists", "Request ID is already in use", 409)
        return existing

    if wallet.active_requests >= settings.model_access_max_user_concurrency:
        raise AuthError("model_concurrency_exceeded", "Too many active requests", status_code=429)
    if wallet.available_units < reserved_units:
        raise AuthError("insufficient_credits", "Insufficient balance", status_code=402)
    if gateway.active_requests >= settings.model_access_max_global_concurrency:
        raise AuthError("model_capacity_exceeded", "Managed model capacity is full", 503)

    wallet.available_units -= reserved_units
    wallet.reserved_units += reserved_units
    wallet.active_requests += 1
    gateway.active_requests += 1
    wallet.version += 1
    request = ModelRequest(
        request_id=request_id,
        user_id=user_id,
        model=model,
        status=ModelRequestStatus.RESERVED,
        reserved_units=reserved_units,
        price_version=price_version,
        promotion_id=promotion_id,
        price_multiplier_bps=price_multiplier_bps,
        billing_type=billing_type,
        request_hash=request_hash,
    )
    db.add(request)
    db.flush()
    return request


def mark_request_running(
    db: Session,
    *,
    request_id: str,
    upstream_request_id: str | None = None,
    upstream_channel_id: int | None = None,
) -> ModelRequest:
    request = (
        db.query(ModelRequest).filter(ModelRequest.request_id == request_id).with_for_update().one()
    )
    if request.status in {ModelRequestStatus.RESERVED, ModelRequestStatus.RUNNING}:
        request.status = ModelRequestStatus.RUNNING
        if upstream_request_id:
            request.upstream_request_id = upstream_request_id
        if upstream_channel_id is not None:
            request.upstream_channel_id = upstream_channel_id
    return request


def release_request(db: Session, *, request_id: str, error_code: str | None = None) -> ModelRequest:
    request = (
        db.query(ModelRequest).filter(ModelRequest.request_id == request_id).with_for_update().one()
    )
    if request.status in {ModelRequestStatus.RELEASED, ModelRequestStatus.SETTLED}:
        return request

    was_active = request.status in {ModelRequestStatus.RESERVED, ModelRequestStatus.RUNNING}
    wallet = get_wallet(db, request.user_id, lock=True)
    if was_active:
        _decrement_active_counters(db, wallet=wallet)
    wallet.reserved_units -= request.reserved_units
    wallet.available_units += request.reserved_units
    wallet.version += 1
    request.status = ModelRequestStatus.RELEASED
    request.error_code = error_code
    request.settled_at = datetime.now(timezone.utc)
    return request


def mark_request_uncertain(
    db: Session,
    *,
    request_id: str,
    error_code: str,
) -> ModelRequest:
    request = (
        db.query(ModelRequest).filter(ModelRequest.request_id == request_id).with_for_update().one()
    )
    if request.status not in {ModelRequestStatus.SETTLED, ModelRequestStatus.RELEASED}:
        if request.status in {ModelRequestStatus.RESERVED, ModelRequestStatus.RUNNING}:
            wallet = get_wallet(db, request.user_id, lock=True)
            _decrement_active_counters(db, wallet=wallet)
        request.status = ModelRequestStatus.UNCERTAIN
        request.error_code = error_code
        request.settled_at = datetime.now(timezone.utc)
    return request


def settle_request(
    db: Session,
    *,
    request_id: str,
    actual_units: int,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int = 0,
    usage_metadata: dict | None = None,
    result_json: dict | None = None,
    allow_overage: bool = False,
) -> ModelRequest:
    values = (actual_units, prompt_tokens, completion_tokens, cached_tokens)
    if any(value < 0 for value in values):
        raise ValueError("usage values must be non-negative")

    request = (
        db.query(ModelRequest).filter(ModelRequest.request_id == request_id).with_for_update().one()
    )
    if request.status == ModelRequestStatus.SETTLED:
        if (
            request.actual_units != actual_units
            or request.prompt_tokens != prompt_tokens
            or request.completion_tokens != completion_tokens
            or request.cached_tokens != cached_tokens
            or request.usage_json != usage_metadata
        ):
            raise AuthError("request_conflict", "Settlement payload changed", status_code=409)
        return request
    if request.status == ModelRequestStatus.RELEASED:
        raise AuthError("request_conflict", "Released request cannot be settled", status_code=409)
    was_active = request.status in {ModelRequestStatus.RESERVED, ModelRequestStatus.RUNNING}
    wallet = get_wallet(db, request.user_id, lock=True)
    if actual_units > request.reserved_units and not allow_overage:
        if was_active:
            _decrement_active_counters(db, wallet=wallet)
        request.status = ModelRequestStatus.UNCERTAIN
        request.error_code = "usage_exceeds_reservation"
        request.settled_at = datetime.now(timezone.utc)
        return request

    additional_units = max(0, actual_units - request.reserved_units)
    if additional_units > wallet.available_units:
        if was_active:
            _decrement_active_counters(db, wallet=wallet)
        request.status = ModelRequestStatus.UNCERTAIN
        request.error_code = "insufficient_credits_for_overage"
        request.settled_at = datetime.now(timezone.utc)
        return request
    wallet.reserved_units -= request.reserved_units
    wallet.available_units += max(0, request.reserved_units - actual_units)
    wallet.available_units -= additional_units
    if was_active:
        _decrement_active_counters(db, wallet=wallet)
    wallet.version += 1

    request.status = ModelRequestStatus.SETTLED
    request.actual_units = actual_units
    request.prompt_tokens = prompt_tokens
    request.completion_tokens = completion_tokens
    request.cached_tokens = cached_tokens
    request.usage_json = usage_metadata
    if result_json is not None:
        request.result_json = result_json
    request.settled_at = datetime.now(timezone.utc)
    db.add(
        CreditLedger(
            user_id=request.user_id,
            delta_units=-actual_units,
            event_type=CreditEventType.USAGE,
            reference_id=request.request_id,
            balance_after=wallet.available_units + wallet.reserved_units,
            metadata_json={
                "model": request.model,
                "billing_type": request.billing_type,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "cached_tokens": cached_tokens,
                "price_version": request.price_version,
                "promotion_id": request.promotion_id,
                "price_multiplier_bps": request.price_multiplier_bps,
                **(usage_metadata or {}),
            },
        )
    )
    return request


def recover_stale_requests(db: Session, *, now: datetime | None = None) -> dict[str, int]:
    current = now or datetime.now(timezone.utc)
    reserved_before = current - timedelta(seconds=settings.model_access_reserved_stale_seconds)
    running_before = current - timedelta(seconds=settings.model_access_running_stale_seconds)
    reserved_ids = [
        item.request_id
        for item in db.query(ModelRequest)
        .filter(
            ModelRequest.status == ModelRequestStatus.RESERVED,
            ModelRequest.created_at <= reserved_before,
        )
        .limit(100)
        .all()
    ]
    running_ids = [
        item.request_id
        for item in db.query(ModelRequest)
        .filter(
            ModelRequest.status == ModelRequestStatus.RUNNING,
            ModelRequest.created_at <= running_before,
        )
        .limit(100)
        .all()
    ]
    for request_id in reserved_ids:
        release_request(db, request_id=request_id, error_code="stale_before_upstream")
    for request_id in running_ids:
        mark_request_uncertain(db, request_id=request_id, error_code="stale_running")
    return {"released": len(reserved_ids), "uncertain": len(running_ids)}


def reconcile_wallets(db: Session) -> list[dict[str, int]]:
    ledger_totals = dict(
        db.query(CreditLedger.user_id, func.coalesce(func.sum(CreditLedger.delta_units), 0))
        .group_by(CreditLedger.user_id)
        .all()
    )
    differences: list[dict[str, int]] = []
    wallet_user_ids: set[int] = set()
    for wallet in db.query(CreditWallet).all():
        wallet_user_ids.add(wallet.user_id)
        wallet_total = wallet.available_units + wallet.reserved_units
        ledger_total = int(ledger_totals.get(wallet.user_id, 0))
        if wallet_total != ledger_total:
            differences.append(
                {
                    "user_id": wallet.user_id,
                    "wallet_total": wallet_total,
                    "ledger_total": ledger_total,
                    "difference": wallet_total - ledger_total,
                }
            )
    for user_id, ledger_total in ledger_totals.items():
        if user_id not in wallet_user_ids:
            differences.append(
                {
                    "user_id": user_id,
                    "wallet_total": 0,
                    "ledger_total": int(ledger_total),
                    "difference": -int(ledger_total),
                }
            )
    return differences


def active_request_counter_snapshot(db: Session) -> dict[str, int | bool]:
    request_count = (
        db.query(ModelRequest)
        .filter(
            ModelRequest.status.in_([ModelRequestStatus.RESERVED, ModelRequestStatus.RUNNING])
        )
        .count()
    )
    wallet_count = int(
        db.query(func.coalesce(func.sum(CreditWallet.active_requests), 0)).scalar() or 0
    )
    gateway = db.get(ModelGatewayLock, 1)
    gateway_count = gateway.active_requests if gateway is not None else 0
    return {
        "ok": request_count == wallet_count == gateway_count,
        "model_requests": request_count,
        "wallets": wallet_count,
        "gateway": gateway_count,
    }
