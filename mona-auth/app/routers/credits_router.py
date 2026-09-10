from __future__ import annotations

import hashlib
import logging
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.alipay import alipay_service
from app.config import settings
from app.credits import amount_to_units, display_amount, display_credits, get_wallet
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.feature_flags import balance_recharge_enabled
from app.media_generation import public_media_result
from app.middleware import limiter
from app.models import (
    CreditLedger,
    CreditProduct,
    ModelRequest,
    ModelRequestStatus,
    Payment,
    PaymentStatus,
    User,
)
from app.recharge_promotion import recharge_pro_promotion
from app.recharge_settings import custom_recharge_settings
from app.schemas import (
    CreditBalanceResponse,
    CreditLedgerInfo,
    CreditLedgerListResponse,
    CreditOrderHistoryItem,
    CreditOrderHistoryResponse,
    CreditOrderRequest,
    CreditOrderResponse,
    CreditOrderStatusResponse,
    CreditProductInfo,
    CreditProductListResponse,
    CreditUsageDailyPoint,
    CreditUsageModelItem,
    CreditUsageRecentItem,
    CreditUsageResponse,
    RechargeProPromotionInfo,
)

router = APIRouter(prefix="/credits", tags=["credits"])
logger = logging.getLogger(__name__)
ORDER_EXPIRE_MINUTES = 30


def _public_ledger_metadata(entry: CreditLedger) -> dict | None:
    if not entry.metadata_json:
        return None
    return {
        key: value
        for key, value in entry.metadata_json.items()
        if key not in {"admin_user_id", "payment_id"}
    }


def _product_balance_units(product: CreditProduct) -> int:
    units = amount_to_units(product.price)
    if product.credit_units != units:
        raise AuthError(
            "product_configuration_invalid",
            "Recharge product balance must equal its price",
            503,
        )
    return units


@router.get("/products", response_model=CreditProductListResponse)
def list_products(db: Session = Depends(get_db)):
    products = (
        db.query(CreditProduct)
        .filter(CreditProduct.enabled.is_(True))
        .order_by(CreditProduct.sort_order, CreditProduct.code)
        .all()
    )
    result = []
    for product in products:
        units = _product_balance_units(product)
        amount = display_amount(units)
        result.append(
            CreditProductInfo(
                code=product.code,
                name=product.name,
                price=product.price,
                balance_units=units,
                balance_amount=amount,
                credit_units=units,
                credits=amount,
            )
        )
    promotion = recharge_pro_promotion(db)
    return CreditProductListResponse(
        recharge_enabled=balance_recharge_enabled(db),
        custom_recharge=custom_recharge_settings(db),
        promotion=(
            RechargeProPromotionInfo(
                enabled=promotion.enabled,
                active=promotion.active,
                min_amount=promotion.min_amount,
                gift_days=promotion.gift_days,
                start_at=promotion.start_at,
                end_at=promotion.end_at,
                description=promotion.description,
            )
            if promotion.enabled
            else None
        ),
        products=result,
    )


@router.get("/balance", response_model=CreditBalanceResponse)
def get_balance(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    wallet = get_wallet(db, user.id)
    db.commit()
    db.refresh(wallet)
    return CreditBalanceResponse(
        available_units=wallet.available_units,
        reserved_units=wallet.reserved_units,
        available_amount=display_amount(wallet.available_units),
        reserved_amount=display_amount(wallet.reserved_units),
        available_credits=display_credits(wallet.available_units),
        reserved_credits=display_credits(wallet.reserved_units),
        updated_at=wallet.updated_at,
    )


@router.get("/usage", response_model=CreditUsageResponse)
def get_usage(
    tz_offset_minutes: int = Query(default=0, ge=-720, le=840),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    period_days = 30
    now = datetime.now(timezone.utc)
    offset = timedelta(minutes=tz_offset_minutes)
    today = (now + offset).date()
    first_day = today - timedelta(days=period_days - 1)
    start_utc = datetime.combine(first_day, time.min) - offset
    requests = (
        db.query(ModelRequest)
        .filter(
            ModelRequest.user_id == user.id,
            ModelRequest.created_at >= start_utc,
        )
        .order_by(ModelRequest.created_at.desc())
        .all()
    )

    daily: dict[date, dict[str, int]] = {
        first_day + timedelta(days=index): {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "spent_units": 0,
        }
        for index in range(period_days)
    }
    models: dict[str, dict[str, int]] = {}
    period_tokens = 0
    period_spent_units = 0
    settled_count = 0
    pending_count = 0
    pending_reserved_units = 0
    pending_statuses = {
        ModelRequestStatus.RESERVED,
        ModelRequestStatus.RUNNING,
        ModelRequestStatus.UNCERTAIN,
    }

    def local_day(value: datetime) -> date:
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return (value + offset).date()

    for item in requests:
        if item.status in pending_statuses:
            pending_count += 1
            pending_reserved_units += item.reserved_units
        if item.status != ModelRequestStatus.SETTLED or item.actual_units is None:
            continue
        prompt_tokens = item.prompt_tokens or 0
        completion_tokens = item.completion_tokens or 0
        cached_tokens = item.cached_tokens or 0
        total_tokens = prompt_tokens + completion_tokens
        spent_units = item.actual_units
        day = local_day(item.created_at)
        if day in daily:
            daily[day]["prompt_tokens"] += prompt_tokens
            daily[day]["completion_tokens"] += completion_tokens
            daily[day]["spent_units"] += spent_units
        model = models.setdefault(
            item.model,
            {
                "billing_type": item.billing_type,
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cached_tokens": 0,
                "spent_units": 0,
                "request_count": 0,
            },
        )
        model["prompt_tokens"] += prompt_tokens
        model["completion_tokens"] += completion_tokens
        model["cached_tokens"] += cached_tokens
        model["spent_units"] += spent_units
        model["request_count"] += 1
        period_tokens += total_tokens
        period_spent_units += spent_units
        settled_count += 1

    recent = []
    for item in requests[:20]:
        settled = item.status == ModelRequestStatus.SETTLED and item.actual_units is not None
        prompt_tokens = item.prompt_tokens if settled else None
        completion_tokens = item.completion_tokens if settled else None
        total_tokens = (
            (prompt_tokens or 0) + (completion_tokens or 0) if settled else None
        )
        recent.append(
            CreditUsageRecentItem(
                request_id=item.request_id,
                model=item.model,
                billing_type=item.billing_type,
                status=item.status.value,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                cached_tokens=item.cached_tokens if settled else None,
                total_tokens=total_tokens,
                spent_amount=display_amount(item.actual_units) if settled else None,
                reserved_amount=(
                    display_amount(item.reserved_units)
                    if item.status in pending_statuses
                    else "0"
                ),
                spent_credits=display_credits(item.actual_units) if settled else None,
                reserved_credits=(
                    display_credits(item.reserved_units)
                    if item.status in pending_statuses
                    else "0"
                ),
                created_at=item.created_at,
                settled_at=item.settled_at,
                usage=item.usage_json,
                result=public_media_result(item)
                if item.billing_type in {"image", "video"}
                else item.result_json,
            )
        )

    return CreditUsageResponse(
        period_days=period_days,
        today_tokens=(
            daily[today]["prompt_tokens"] + daily[today]["completion_tokens"]
        ),
        period_tokens=period_tokens,
        period_spent_units=period_spent_units,
        period_spent_amount=display_amount(period_spent_units),
        period_spent_credits=display_credits(period_spent_units),
        settled_request_count=settled_count,
        model_count=len(models),
        pending_request_count=pending_count,
        pending_reserved_amount=display_amount(pending_reserved_units),
        pending_reserved_credits=display_credits(pending_reserved_units),
        daily=[
            CreditUsageDailyPoint(
                date=day.isoformat(),
                prompt_tokens=values["prompt_tokens"],
                completion_tokens=values["completion_tokens"],
                total_tokens=(
                    values["prompt_tokens"] + values["completion_tokens"]
                ),
                spent_units=values["spent_units"],
                spent_amount=display_amount(values["spent_units"]),
                spent_credits=display_credits(values["spent_units"]),
            )
            for day, values in daily.items()
        ],
        by_model=[
            CreditUsageModelItem(
                model=model,
                billing_type=values["billing_type"],
                prompt_tokens=values["prompt_tokens"],
                completion_tokens=values["completion_tokens"],
                cached_tokens=values["cached_tokens"],
                total_tokens=(
                    values["prompt_tokens"] + values["completion_tokens"]
                ),
                spent_units=values["spent_units"],
                spent_amount=display_amount(values["spent_units"]),
                spent_credits=display_credits(values["spent_units"]),
                request_count=values["request_count"],
            )
            for model, values in sorted(
                models.items(),
                key=lambda item: (-item[1]["spent_units"], item[0]),
            )
        ],
        recent=recent,
        updated_at=now,
    )


@router.get("/ledger", response_model=CreditLedgerListResponse)
def list_ledger(
    limit: int = Query(default=50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    entries = (
        db.query(CreditLedger)
        .filter(CreditLedger.user_id == user.id)
        .order_by(CreditLedger.id.desc())
        .limit(limit)
        .all()
    )
    return CreditLedgerListResponse(
        entries=[
            CreditLedgerInfo(
                id=entry.id,
                delta_units=entry.delta_units,
                event_type=entry.event_type.value,
                reference_id=entry.reference_id,
                balance_after=entry.balance_after,
                delta_amount=display_amount(entry.delta_units),
                balance_after_amount=display_amount(entry.balance_after),
                delta_credits=display_credits(entry.delta_units),
                balance_after_credits=display_credits(entry.balance_after),
                metadata=_public_ledger_metadata(entry),
                created_at=entry.created_at,
            )
            for entry in entries
        ]
    )


@router.post("/orders", response_model=CreditOrderResponse)
@limiter.limit("5/minute")
def create_order(
    request: Request,
    body: CreditOrderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del request
    if body.custom_amount is not None:
        custom = custom_recharge_settings(db)
        if not custom["enabled"]:
            raise AuthError("custom_recharge_disabled", "Custom recharge is disabled", 404)
        if not custom["min_amount"] <= body.custom_amount <= custom["max_amount"]:
            raise AuthError(
                "custom_recharge_out_of_range",
                (
                    f"Custom recharge amount must be between "
                    f"{custom['min_amount']:.2f} and {custom['max_amount']:.2f}"
                ),
                422,
            )
        product_code = "custom_recharge"
        product_name = f"自定义充值 ¥{body.custom_amount:.2f}"
        price = body.custom_amount
        balance_units = amount_to_units(price)
    else:
        product = (
            db.query(CreditProduct)
            .filter(
                CreditProduct.code == body.product_code,
                CreditProduct.enabled.is_(True),
            )
            .first()
        )
        if product is None:
            raise AuthError("product_not_found", "Recharge product not found", status_code=404)
        product_code = product.code
        product_name = product.name
        price = product.price
        balance_units = _product_balance_units(product)
    if not balance_recharge_enabled(db):
        raise AuthError("credit_payments_disabled", "Balance recharge is disabled", 503)
    if not alipay_service.enabled:
        raise AuthError("alipay_disabled", "Alipay payment is not configured", status_code=503)
    if not settings.alipay_seller_id:
        raise AuthError("alipay_disabled", "Alipay seller identity is not configured", 503)

    request_digest = hashlib.sha256(
        f"{user.id}:{body.idempotency_key}".encode("utf-8")
    ).hexdigest()[:24]
    trade_order_id = f"credit_{user.id}_{request_digest}"
    existing = db.query(Payment).filter(Payment.trade_order_id == trade_order_id).first()
    if existing is not None:
        if (
            existing.product_code != product_code
            or existing.amount != price
            or existing.credit_units != balance_units
        ):
            raise AuthError("order_conflict", "Idempotency key was used for another recharge", 409)
        payment = existing
    else:
        payment = Payment(
            user_id=user.id,
            trade_order_id=trade_order_id,
            amount=price,
            status=PaymentStatus.PENDING,
            payment_channel="alipay",
            payment_type="page",
            product_type="credit_topup",
            product_code=product_code,
            credit_units=balance_units,
            fulfillment_status="not_started",
        )
        db.add(payment)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            payment = db.query(Payment).filter(Payment.trade_order_id == trade_order_id).one()
            if (
                payment.product_code != product_code
                or payment.amount != price
                or payment.credit_units != balance_units
            ):
                raise AuthError(
                    "order_conflict",
                    "Idempotency key was used for another recharge",
                    409,
                )
        db.refresh(payment)

    payment = db.query(Payment).filter(Payment.id == payment.id).with_for_update().one()
    if (
        payment.product_code != product_code
        or payment.amount != price
        or payment.credit_units != balance_units
    ):
        raise AuthError("order_conflict", "Idempotency key was used for another recharge", 409)
    if payment.status != PaymentStatus.PENDING:
        raise AuthError("order_conflict", "Recharge order is no longer pending", 409)
    if not payment.pay_url:
        try:
            payment.pay_url = alipay_service.create_page_pay_url(
                out_trade_no=trade_order_id,
                total_amount=price,
                subject=f"Mona 余额充值 {product_name}",
            )
        except Exception as exc:
            payment.status = PaymentStatus.FAILED
            db.commit()
            logger.exception("Alipay order creation failed for %s", payment.trade_order_id)
            raise AuthError("alipay_pay_failed", "Unable to create payment", 502) from exc
    db.commit()
    return CreditOrderResponse(
        order_id=payment.id,
        trade_order_id=payment.trade_order_id,
        payment_url=payment.pay_url,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=ORDER_EXPIRE_MINUTES),
    )


@router.get("/orders", response_model=CreditOrderHistoryResponse)
def list_orders(
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    payments = (
        db.query(Payment)
        .filter(Payment.user_id == user.id, Payment.product_type == "credit_topup")
        .order_by(Payment.created_at.desc(), Payment.id.desc())
        .limit(limit + 1)
        .all()
    )
    has_more = len(payments) > limit
    payments = payments[:limit]
    return CreditOrderHistoryResponse(
        orders=[
            CreditOrderHistoryItem(
                order_id=payment.id,
                trade_order_id=payment.trade_order_id,
                product_code=payment.product_code,
                amount=payment.amount,
                status=payment.status.value,
                fulfillment_status=payment.fulfillment_status,
                balance_units=payment.credit_units or 0,
                balance_amount=display_amount(payment.credit_units or 0),
                credit_units=payment.credit_units or 0,
                credits=display_credits(payment.credit_units or 0),
                bonus_pro_days=payment.bonus_pro_days,
                bonus_pro_revoked=payment.bonus_pro_revoked_at is not None,
                payment_url=(
                    payment.pay_url if payment.status == PaymentStatus.PENDING else None
                ),
                created_at=payment.created_at,
                paid_at=payment.paid_at,
            )
            for payment in payments
        ],
        has_more=has_more,
    )


@router.get("/orders/{order_id}", response_model=CreditOrderStatusResponse)
def get_order(
    order_id: int,
    reconcile: bool = Query(default=False),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    payment = (
        db.query(Payment)
        .filter(
            Payment.id == order_id,
            Payment.user_id == user.id,
            Payment.product_type == "credit_topup",
        )
        .first()
    )
    if payment is None:
        raise AuthError("order_not_found", "Recharge order not found", status_code=404)
    if (
        reconcile
        and payment.payment_channel == "alipay"
        and payment.fulfillment_status != "succeeded"
        and payment.status in (PaymentStatus.PENDING, PaymentStatus.PAID)
    ):
        from app.routers.subscribe_router import sync_payment_status

        try:
            sync_payment_status(db, payment, strict=True)
        except Exception as exc:
            db.rollback()
            logger.exception("Credit payment reconciliation failed for order %s", order_id)
            raise AuthError(
                "credit_payment_reconciliation_failed",
                "Unable to reconcile payment status",
                status_code=503,
            ) from exc
        db.refresh(payment)
    return CreditOrderStatusResponse(
        order_id=payment.id,
        status=payment.status.value,
        fulfillment_status=payment.fulfillment_status,
        balance_units=payment.credit_units or 0,
        balance_amount=display_amount(payment.credit_units or 0),
        credit_units=payment.credit_units or 0,
        bonus_pro_days=payment.bonus_pro_days,
        bonus_pro_revoked=payment.bonus_pro_revoked_at is not None,
    )
