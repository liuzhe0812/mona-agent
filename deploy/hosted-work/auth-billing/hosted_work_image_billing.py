"""Image-token settlement using Work's existing wallet and charge identities."""
from datetime import datetime, timezone

from app.errors import AuthError
from app.hosted_work_billing import _conflict, _get_charge, _wallet
from app.hosted_work_image_pricing import image_actual_units, image_price_units
from app.models import CreditEventType, CreditLedger


def release_image_not_started(db, operation_id: str):
    """Release a Work-confirmed image hold when its provider was never called."""
    owner = _get_charge(db, operation_id).user_id
    wallet = _wallet(db, owner)
    row = _get_charge(db, operation_id, lock=True)
    if (row.user_id != owner or not isinstance(row.price_json, dict)
            or row.price_json.get("kind") != "image_per_image_v1"):
        _conflict()
    if row.status == "released":
        return row
    if row.status != "running" or row.usage_json is not None or row.actual_units is not None:
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


def settle_image(db, operation_id: str, receipt: dict):
    """Settle one image exactly once; other Work charge kinds cannot use this route."""
    owner = _get_charge(db, operation_id).user_id
    wallet = _wallet(db, owner)
    row = _get_charge(db, operation_id, lock=True)
    price = row.price_json
    if row.user_id != owner or not isinstance(price, dict) or price.get("kind") != "image_per_image_v1":
        _conflict()
    if row.reserved_units != image_price_units(price):
        _conflict()
    if row.usage_json is not None and row.usage_json != receipt:
        _conflict()
    if row.status == "settled":
        return row
    if row.status not in ("running", "uncertain"):
        _conflict()
    charged = image_actual_units(price, receipt)
    row.usage_json, row.actual_units = receipt, charged
    if row.reserved_units and (wallet is None or wallet.reserved_units < row.reserved_units):
        raise AuthError("hosted_wallet_inconsistent", "Reserved balance mismatch", 503)
    extra = max(0, charged - row.reserved_units)
    if extra and (wallet is None or wallet.available_units < extra):
        row.status, row.review_reason = "uncertain", "insufficient_balance_for_settlement"
        db.commit()
        return row
    if wallet is not None:
        wallet.reserved_units -= row.reserved_units
        wallet.available_units += row.reserved_units - charged
        wallet.version += 1
        db.add(CreditLedger(user_id=row.user_id, delta_units=-charged, event_type=CreditEventType.USAGE,
            reference_id=f"hosted:{operation_id}", balance_after=wallet.available_units + wallet.reserved_units,
            metadata_json={"source": "hosted_work_image", "model": row.model, "price": price, "receipt": receipt}))
    elif charged or row.reserved_units:
        raise AuthError("hosted_wallet_inconsistent", "Wallet not found", 503)
    row.status, row.review_reason = "settled", None
    row.settled_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return row
