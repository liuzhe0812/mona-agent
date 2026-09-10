from __future__ import annotations

import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.alipay import alipay_service
from app.config import settings
from app.credits import (
    active_request_counter_snapshot,
    adjust_credits,
    amount_to_units,
    apply_refund,
    display_amount,
    display_credits,
    get_wallet,
    reconcile_wallets,
    release_request,
    settle_request,
)
from app.database import get_db
from app.errors import AuthError
from app.feature_flags import feature_flag_snapshot, set_admin_feature_flags
from app.model_billing import actual_units
from app.model_promotions import promotion_payload, storage_utc, utc_now
from app.models import (
    CreditProduct,
    CreditWallet,
    ModelGatewayLock,
    ModelPrice,
    ModelPromotion,
    ModelRequest,
    ModelRequestStatus,
    Payment,
    PaymentStatus,
    User,
)
from app.recharge_promotion import revoke_recharge_pro_bonus
from app.recharge_settings import custom_recharge_settings, set_custom_recharge_settings
from app.routers.admin_router import require_admin
from app.routers.subscribe_router import sync_payment_status
from app.schemas import (
    AdminBillingFeatureFlagsRequest,
    AdminCreditAdjustmentRequest,
    AdminCreditProductRequest,
    AdminCreditRefundRequest,
    AdminCustomRechargeSettingsRequest,
    AdminModelPriceRequest,
    AdminModelPromotionRequest,
    AdminModelRequestResolution,
)

router = APIRouter(prefix="/admin/credits", tags=["admin-credits"])


def _one_api_reachable() -> bool:
    try:
        response = httpx.get(
            f"{settings.one_api_base_url.rstrip('/')}{settings.one_api_health_path}",
            timeout=2,
        )
        return response.is_success
    except httpx.HTTPError:
        return False


def _service_status(db: Session) -> dict:
    flags = feature_flag_snapshot(db)
    available_units, reserved_units = db.query(
        func.coalesce(func.sum(CreditWallet.available_units), 0),
        func.coalesce(func.sum(CreditWallet.reserved_units), 0),
    ).one()
    today_start = datetime.now(ZoneInfo("Asia/Shanghai")).replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    ).astimezone(timezone.utc).replace(tzinfo=None)
    today_recharge = (
        db.query(func.coalesce(func.sum(Payment.amount), 0))
        .filter(
            Payment.product_type == "credit_topup",
            Payment.status == PaymentStatus.PAID,
            Payment.paid_at >= today_start,
        )
        .scalar()
    )
    pending_refunds = (
        db.query(Payment)
        .filter(
            Payment.product_type == "credit_topup",
            Payment.refund_status.notin_(("not_requested", "succeeded")),
        )
        .count()
    )
    return {
        "credit_payments_enabled": flags["balance_recharge_enabled"],
        "model_access_enabled": flags["managed_model_enabled"],
        **flags,
        "alipay_configured": alipay_service.enabled,
        "one_api_configured": bool(settings.one_api_token),
        "one_api_admin_configured": bool(settings.one_api_admin_token),
        "one_api_reachable": _one_api_reachable(),
        "enabled_products": db.query(CreditProduct).filter(CreditProduct.enabled.is_(True)).count(),
        "enabled_models": db.query(ModelPrice).filter(ModelPrice.enabled.is_(True)).count(),
        "total_available_amount": display_amount(int(available_units or 0)),
        "total_reserved_amount": display_amount(int(reserved_units or 0)),
        "today_recharge_amount": format(today_recharge or 0, ".2f"),
        "pending_refunds": pending_refunds,
    }


@router.get("/status")
def get_credit_service_status(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return _service_status(db)


@router.put("/feature-flags")
def update_billing_feature_flags(
    body: AdminBillingFeatureFlagsRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if body.balance_recharge_enabled:
        if not settings.credits_payment_enabled:
            raise AuthError(
                "deployment_gate_closed",
                "Balance recharge deployment gate is closed",
                409,
            )
        if not alipay_service.enabled or not settings.alipay_seller_id:
            raise AuthError("alipay_disabled", "Alipay payment is not configured", 409)
        enabled_products = db.query(CreditProduct).filter(CreditProduct.enabled.is_(True)).all()
        custom = custom_recharge_settings(db)
        if not enabled_products and not custom["enabled"]:
            raise AuthError("products_required", "At least one recharge option is required", 409)
        if any(item.credit_units != amount_to_units(item.price) for item in enabled_products):
            raise AuthError("product_configuration_invalid", "Recharge products are invalid", 409)
    if body.managed_model_enabled:
        if not settings.model_access_enabled:
            raise AuthError(
                "deployment_gate_closed",
                "Managed model deployment gate is closed",
                409,
            )
        if len(settings.one_api_token) < 16 or not _one_api_reachable():
            raise AuthError("gateway_unavailable", "One API is unavailable", 409)
        if not db.query(ModelPrice).filter(ModelPrice.enabled.is_(True)).first():
            raise AuthError("model_prices_required", "An enabled model price is required", 409)
    set_admin_feature_flags(
        db,
        balance_recharge=body.balance_recharge_enabled,
        managed_model=body.managed_model_enabled,
    )
    db.commit()
    return _service_status(db)


@router.get("/products")
def list_products(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    products = db.query(CreditProduct).order_by(CreditProduct.sort_order).all()
    return {
        "products": [
            {
                "code": item.code,
                "name": item.name,
                "price": format(item.price, ".2f"),
                "balance_units": item.credit_units,
                "balance_amount": display_amount(item.credit_units),
                "credit_units": item.credit_units,
                "credits": display_credits(item.credit_units),
                "enabled": item.enabled,
                "sort_order": item.sort_order,
            }
            for item in products
        ]
    }


@router.get("/recharge-settings")
def get_recharge_settings(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    settings_data = custom_recharge_settings(db)
    return {
        "enabled": settings_data["enabled"],
        "min_amount": format(settings_data["min_amount"], ".2f"),
        "max_amount": format(settings_data["max_amount"], ".2f"),
    }


@router.put("/recharge-settings")
def update_recharge_settings(
    body: AdminCustomRechargeSettingsRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    set_custom_recharge_settings(
        db,
        enabled=body.enabled,
        min_amount=body.min_amount,
        max_amount=body.max_amount,
    )
    db.commit()
    return {
        "enabled": body.enabled,
        "min_amount": format(body.min_amount, ".2f"),
        "max_amount": format(body.max_amount, ".2f"),
    }


@router.get("/users")
def list_credit_users(
    search: str = Query(default="", max_length=128),
    limit: int = Query(default=50, ge=1, le=100),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    query = (
        db.query(User, CreditWallet)
        .outerjoin(CreditWallet, CreditWallet.user_id == User.id)
        .order_by(User.id.desc())
    )
    if search.strip():
        keyword = f"%{search.strip()}%"
        query = query.filter(or_(User.email.like(keyword), User.account.like(keyword)))
    rows = query.limit(limit).all()
    return {
        "users": [
            {
                "user_id": user.id,
                "account": user.account,
                "email": user.email,
                "available_balance": display_amount(wallet.available_units if wallet else 0),
                "reserved_balance": display_amount(wallet.reserved_units if wallet else 0),
                "available_credits": display_credits(wallet.available_units if wallet else 0),
                "reserved_credits": display_credits(wallet.reserved_units if wallet else 0),
                "active_requests": wallet.active_requests if wallet else 0,
                "updated_at": wallet.updated_at if wallet else None,
            }
            for user, wallet in rows
        ]
    }


@router.get("/payments")
def list_credit_payments(
    limit: int = Query(default=50, ge=1, le=100),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(Payment, User)
        .join(User, User.id == Payment.user_id)
        .filter(Payment.product_type == "credit_topup")
        .order_by(Payment.id.desc())
        .limit(limit)
        .all()
    )
    return {
        "payments": [
            {
                "payment_id": payment.id,
                "trade_order_id": payment.trade_order_id,
                "user_id": user.id,
                "account": user.account,
                "email": user.email,
                "product_code": payment.product_code,
                "amount": format(payment.amount, ".2f"),
                "balance_amount": display_amount(payment.credit_units or 0),
                "credits": display_credits(payment.credit_units or 0),
                "status": payment.status.value,
                "fulfillment_status": payment.fulfillment_status,
                "refund_status": payment.refund_status,
                "created_at": payment.created_at,
                "paid_at": payment.paid_at,
                "refunded_at": payment.refunded_at,
                "bonus_pro_days": payment.bonus_pro_days,
                "bonus_pro_revoked": payment.bonus_pro_revoked_at is not None,
                "refundable": (
                    payment.status == PaymentStatus.PAID
                    and payment.fulfillment_status == "succeeded"
                    and payment.refund_status != "succeeded"
                    and bool(payment.credit_units)
                ),
                "syncable": (
                    payment.status == PaymentStatus.PENDING
                    or (
                        payment.status == PaymentStatus.PAID
                        and payment.fulfillment_status != "succeeded"
                    )
                ),
            }
            for payment, user in rows
        ]
    }


@router.put("/products/{code}")
def upsert_product(
    code: str,
    body: AdminCreditProductRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) is None:
        raise AuthError("invalid_product_code", "Product code is invalid", 422)
    balance_units = amount_to_units(body.price)
    if body.credit_units is not None and body.credit_units != balance_units:
        raise AuthError(
            "balance_price_mismatch",
            "Recharge balance must equal the RMB price",
            422,
        )
    product = db.get(CreditProduct, code)
    if product is None:
        product = CreditProduct(code=code)
        db.add(product)
    product.name = body.name
    product.price = body.price
    product.credit_units = balance_units
    product.enabled = body.enabled
    product.sort_order = body.sort_order
    db.commit()
    return {"code": product.code, "enabled": product.enabled}


@router.get("/model-prices")
def list_model_prices(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    prices = db.query(ModelPrice).order_by(ModelPrice.model, ModelPrice.version.desc()).all()
    used_prices = {
        (model, version)
        for model, version in db.query(
            ModelRequest.model,
            ModelRequest.price_version,
        ).distinct()
    }
    return {
        "prices": [
            {
                "id": item.id,
                "model": item.model,
                "version": item.version,
                "input_rate": item.input_rate,
                "cached_input_rate": item.cached_input_rate,
                "output_rate": item.output_rate,
                "billing_type": item.billing_type,
                "rates": item.rates_json or {},
                "rate_amounts": {
                    key: display_amount(value)
                    for key, value in (item.rates_json or {}).items()
                    if isinstance(value, int)
                },
                "input_amount_per_million": display_amount(item.input_rate),
                "cached_input_amount_per_million": display_amount(item.cached_input_rate),
                "output_amount_per_million": display_amount(item.output_rate),
                "input_credits_per_million": display_credits(item.input_rate),
                "cached_input_credits_per_million": display_credits(item.cached_input_rate),
                "output_credits_per_million": display_credits(item.output_rate),
                "enabled": item.enabled,
                "used": (item.model, item.version) in used_prices,
                "deletable": not item.enabled
                and (item.model, item.version) not in used_prices,
                "effective_at": item.effective_at,
            }
            for item in prices
        ]
    }


@router.post("/model-prices")
def create_model_price(
    body: AdminModelPriceRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    lock = db.query(ModelGatewayLock).filter(ModelGatewayLock.id == 1).with_for_update().first()
    if lock is None:
        db.add(ModelGatewayLock(id=1))
        db.flush()
    version = (
        db.query(func.coalesce(func.max(ModelPrice.version), 0))
        .filter(ModelPrice.model == body.model)
        .scalar()
        + 1
    )
    if body.enabled:
        db.query(ModelPrice).filter(ModelPrice.model == body.model).update(
            {ModelPrice.enabled: False}, synchronize_session=False
        )
    price = ModelPrice(
        model=body.model,
        version=version,
        input_rate=body.input_rate if body.billing_type == "token" else 0,
        cached_input_rate=body.cached_input_rate if body.billing_type == "token" else 0,
        output_rate=body.output_rate if body.billing_type == "token" else 0,
        billing_type=body.billing_type,
        rates_json=body.rates or None,
        enabled=body.enabled,
    )
    db.add(price)
    db.commit()
    return {
        "model": price.model,
        "version": price.version,
        "billing_type": price.billing_type,
        "enabled": price.enabled,
    }


@router.post("/model-prices/{price_id}/enable")
def enable_model_price(
    price_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    price = db.get(ModelPrice, price_id)
    if price is None:
        raise AuthError("model_price_not_found", "价格版本不存在", 404)
    lock = (
        db.query(ModelGatewayLock)
        .filter(ModelGatewayLock.id == 1)
        .with_for_update()
        .first()
    )
    if lock is None:
        db.add(ModelGatewayLock(id=1))
        db.flush()
    db.query(ModelPrice).filter(ModelPrice.model == price.model).update(
        {ModelPrice.enabled: False},
        synchronize_session=False,
    )
    price.enabled = True
    db.commit()
    return {"id": price.id, "model": price.model, "version": price.version, "enabled": True}


@router.get("/model-promotions")
def list_model_promotions(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    current = utc_now()
    rows = db.query(ModelPromotion).order_by(ModelPromotion.created_at.desc()).all()
    return {"promotions": [promotion_payload(row, now=current) for row in rows]}


@router.put("/model-promotions")
def upsert_model_promotion(
    body: AdminModelPromotionRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    price = (
        db.query(ModelPrice)
        .filter(ModelPrice.model == body.model, ModelPrice.enabled.is_(True))
        .order_by(ModelPrice.version.desc())
        .first()
    )
    if price is None:
        raise AuthError("model_not_found", "Enabled model not found", 404)
    if price.billing_type != "token":
        raise AuthError("model_promotion_unsupported", "Only chat models support discounts", 422)

    lock = db.query(ModelGatewayLock).filter(ModelGatewayLock.id == 1).with_for_update().first()
    if lock is None:
        db.add(ModelGatewayLock(id=1))
        db.flush()
    start_at = storage_utc(body.start_at)
    end_at = storage_utc(body.end_at)
    promotion = (
        db.query(ModelPromotion)
        .filter(ModelPromotion.model == body.model)
        .with_for_update()
        .first()
    )
    if promotion is None:
        promotion = ModelPromotion(
            model=body.model,
            price_multiplier_bps=10_000 - body.discount_percent * 100,
            start_at=start_at,
            end_at=end_at,
            enabled=body.enabled,
            disabled_at=None if body.enabled else storage_utc(utc_now()),
        )
        db.add(promotion)
    else:
        promotion.price_multiplier_bps = 10_000 - body.discount_percent * 100
        promotion.start_at = start_at
        promotion.end_at = end_at
        promotion.enabled = body.enabled
        promotion.disabled_at = None if body.enabled else storage_utc(utc_now())
    db.commit()
    db.refresh(promotion)
    return promotion_payload(promotion)


@router.post("/model-promotions/{promotion_id}/disable")
def disable_model_promotion(
    promotion_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    promotion = (
        db.query(ModelPromotion)
        .filter(ModelPromotion.id == promotion_id)
        .with_for_update()
        .first()
    )
    if promotion is None:
        raise AuthError("model_promotion_not_found", "Model promotion not found", 404)
    if promotion.enabled:
        promotion.enabled = False
        promotion.disabled_at = storage_utc(utc_now())
        db.commit()
        db.refresh(promotion)
    return promotion_payload(promotion)


@router.delete("/model-prices/{price_id}")
def delete_model_price(
    price_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    price = db.get(ModelPrice, price_id)
    if price is None:
        raise AuthError("model_price_not_found", "价格版本不存在", 404)
    if price.enabled:
        raise AuthError("model_price_enabled", "请先停用该价格版本", 409)
    used = (
        db.query(ModelRequest.request_id)
        .filter(
            ModelRequest.model == price.model,
            ModelRequest.price_version == price.version,
        )
        .first()
    )
    if used is not None:
        raise AuthError("model_price_in_use", "该价格版本已有账单记录，不能删除", 409)
    db.delete(price)
    db.commit()
    return {"id": price_id, "deleted": True}


@router.post("/models/{model:path}/disable")
def disable_model(
    model: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    lock = (
        db.query(ModelGatewayLock)
        .filter(ModelGatewayLock.id == 1)
        .with_for_update()
        .first()
    )
    if lock is None:
        db.add(ModelGatewayLock(id=1))
        db.flush()
    updated = (
        db.query(ModelPrice)
        .filter(ModelPrice.model == model, ModelPrice.enabled.is_(True))
        .update({ModelPrice.enabled: False}, synchronize_session=False)
    )
    if not updated:
        raise AuthError("model_not_found", "Enabled model not found", 404)
    db.commit()
    return {"model": model, "enabled": False}


@router.post("/users/{user_id}/adjustments")
def create_adjustment(
    user_id: int,
    body: AdminCreditAdjustmentRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if body.delta_units == 0:
        raise AuthError("invalid_adjustment", "Adjustment cannot be zero", 422)
    if db.get(User, user_id) is None:
        raise AuthError("user_not_found", "User not found", 404)
    reference_id = f"adjustment:{body.idempotency_key}"
    wallet = adjust_credits(
        db,
        user_id=user_id,
        delta_units=body.delta_units,
        reference_id=reference_id,
        reason=body.reason,
        admin_user_id=admin.id,
    )
    db.commit()
    return {
        "reference_id": reference_id,
        "available_units": wallet.available_units,
        "available_balance": display_amount(wallet.available_units),
        "available_credits": display_credits(wallet.available_units),
    }


@router.get("/uncertain-requests")
def list_uncertain_requests(
    limit: int = Query(default=50, ge=1, le=100),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    requests = (
        db.query(ModelRequest)
        .filter(ModelRequest.status == ModelRequestStatus.UNCERTAIN)
        .order_by(ModelRequest.created_at)
        .limit(limit)
        .all()
    )
    return {
        "requests": [
            {
                "request_id": item.request_id,
                "user_id": item.user_id,
                "model": item.model,
                "billing_type": item.billing_type,
                "reserved_units": item.reserved_units,
                "price_version": item.price_version,
                "error_code": item.error_code,
                "usage": item.usage_json,
                "created_at": item.created_at,
            }
            for item in requests
        ]
    }


@router.post("/requests/{request_id}/resolve")
def resolve_uncertain_request(
    request_id: str,
    body: AdminModelRequestResolution,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    request = db.get(ModelRequest, request_id)
    if request is None:
        raise AuthError("request_not_found", "Model request not found", 404)
    if request.status not in {
        ModelRequestStatus.UNCERTAIN,
        ModelRequestStatus.RESERVED,
        ModelRequestStatus.RUNNING,
    }:
        raise AuthError("request_conflict", f"Request is already {request.status.value}", 409)
    if body.action == "release":
        request = release_request(db, request_id=request_id, error_code="admin_released")
    else:
        if request.billing_type in {"image", "video"}:
            if body.actual_units is None or body.actual_units <= 0:
                raise AuthError("usage_required", "Verified media amount is required", 422)
            request = settle_request(
                db,
                request_id=request_id,
                actual_units=body.actual_units,
                prompt_tokens=0,
                completion_tokens=0,
                cached_tokens=0,
                usage_metadata=body.usage or request.usage_json or {},
                allow_overage=True,
            )
            if request.status != ModelRequestStatus.SETTLED:
                raise AuthError(
                    "resolution_failed",
                    "Available balance cannot cover the verified usage",
                    409,
                )
            request.error_code = f"{request.error_code or body.action}:{body.reason}"[:64]
            db.commit()
            return {"request_id": request.request_id, "status": request.status.value}
        usage = (body.prompt_tokens, body.completion_tokens, body.cached_tokens)
        if any(value is None for value in usage):
            raise AuthError("usage_required", "All usage fields are required", 422)
        price = (
            db.query(ModelPrice)
            .filter(
                ModelPrice.model == request.model,
                ModelPrice.version == request.price_version,
            )
            .one()
        )
        units = actual_units(
            price,
            prompt_tokens=body.prompt_tokens or 0,
            completion_tokens=body.completion_tokens or 0,
            cached_tokens=body.cached_tokens or 0,
            price_multiplier_bps=request.price_multiplier_bps,
        )
        request = settle_request(
            db,
            request_id=request_id,
            actual_units=units,
            prompt_tokens=body.prompt_tokens or 0,
            completion_tokens=body.completion_tokens or 0,
            cached_tokens=body.cached_tokens or 0,
            allow_overage=True,
        )
        if request.status != ModelRequestStatus.SETTLED:
            raise AuthError(
                "resolution_failed",
                "Available balance cannot cover the verified usage",
                409,
            )
    request.error_code = f"{request.error_code or body.action}:{body.reason}"[:64]
    db.commit()
    return {"request_id": request.request_id, "status": request.status.value}


@router.get("/reconciliation")
def reconciliation(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    differences = reconcile_wallets(db)
    capacity = active_request_counter_snapshot(db)
    unfulfilled = (
        db.query(Payment)
        .filter(
            Payment.product_type == "credit_topup",
            Payment.status == PaymentStatus.PAID,
            Payment.fulfillment_status != "succeeded",
        )
        .count()
    )
    return {
        "ok": not differences and unfulfilled == 0 and capacity["ok"],
        "wallet_differences": differences,
        "active_request_counters": capacity,
        "paid_unfulfilled_orders": unfulfilled,
    }


@router.post("/payments/{payment_id}/refund")
def refund_credit_payment(
    payment_id: int,
    body: AdminCreditRefundRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    payment = db.query(Payment).filter(Payment.id == payment_id).with_for_update().first()
    if payment is None or payment.product_type != "credit_topup":
        raise AuthError("payment_not_found", "Credit payment not found", 404)
    if payment.refund_status == "succeeded":
        return {"payment_id": payment.id, "refund_status": payment.refund_status}
    if payment.status != PaymentStatus.PAID or payment.fulfillment_status != "succeeded":
        raise AuthError("payment_not_refundable", "Payment is not fulfilled", 409)
    if payment.payment_channel != "alipay" or not payment.credit_units:
        raise AuthError("payment_not_refundable", "Payment cannot be refunded here", 409)
    wallet = get_wallet(db, payment.user_id, lock=True)
    if wallet.available_units < payment.credit_units:
        raise AuthError(
            "refund_balance_spent",
            "Purchased balance has already been reserved or spent",
            409,
        )
    try:
        result = alipay_service.refund(
            out_trade_no=payment.trade_order_id,
            refund_amount=payment.amount,
            refund_reason=body.reason,
            out_request_no=f"credit_refund_{payment.id}",
        )
    except Exception as exc:
        raise AuthError("alipay_refund_failed", "Alipay refund request failed", 502) from exc
    if result.get("code") != "10000":
        raise AuthError("alipay_refund_failed", "Alipay rejected the refund", 502)
    apply_refund(
        db,
        user_id=payment.user_id,
        units=payment.credit_units,
        reference_id=f"payment:{payment.trade_order_id}",
        payment_id=payment.id,
        admin_user_id=admin.id,
        reason=body.reason,
    )
    revoke_recharge_pro_bonus(db, payment)
    payment.refund_status = "succeeded"
    payment.refunded_units = payment.credit_units
    payment.refunded_at = datetime.now(timezone.utc)
    db.commit()
    return {"payment_id": payment.id, "refund_status": payment.refund_status}


@router.post("/payments/{payment_id}/sync")
def sync_credit_payment(
    payment_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    payment = db.query(Payment).filter(Payment.id == payment_id).first()
    if payment is None or payment.product_type != "credit_topup":
        raise AuthError("payment_not_found", "Credit payment not found", 404)
    sync_payment_status(db, payment)
    db.refresh(payment)
    return {
        "payment_id": payment.id,
        "status": payment.status.value,
        "fulfillment_status": payment.fulfillment_status,
    }
