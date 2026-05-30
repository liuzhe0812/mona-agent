import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.models import Payment, PaymentStatus, Subscription, SubscriptionStatus, User
from app.schemas import (
    CreatePaymentRequest,
    CreatePaymentResponse,
    PaymentListResponse,
    SubscriptionInfo,
)

router = APIRouter(prefix="/payment", tags=["payment"])


def _xhp_sign(params: dict[str, str]) -> str:
    sorted_items = sorted(params.items())
    sign_str = "&".join(f"{k}={v}" for k, v in sorted_items if v != "")
    sign_str += settings.xhp_app_secret
    return hashlib.md5(sign_str.encode()).hexdigest()


def _get_price(duration_months: int) -> float:
    if duration_months >= 12:
        years = duration_months // 12
        return settings.price_yearly * years
    return settings.price_monthly * duration_months


def _activate_subscription(db: Session, user_id: int, duration_months: int):
    now = datetime.now(timezone.utc)
    sub = db.query(Subscription).filter(Subscription.user_id == user_id).first()

    if sub and sub.status == SubscriptionStatus.ACTIVE and sub.current_period_end:
        if sub.current_period_end.tzinfo is None:
            sub.current_period_end = sub.current_period_end.replace(tzinfo=timezone.utc)
        if sub.current_period_end > now:
            sub.current_period_end = sub.current_period_end + timedelta(days=30 * duration_months)
        else:
            sub.current_period_end = now + timedelta(days=30 * duration_months)
    else:
        if not sub:
            sub = Subscription(user_id=user_id)
            db.add(sub)
        sub.status = SubscriptionStatus.ACTIVE
        sub.current_period_end = now + timedelta(days=30 * duration_months)

    db.commit()


@router.post("/create", response_model=CreatePaymentResponse)
async def create_payment(
    body: CreatePaymentRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    active_sub = (
        db.query(Subscription)
        .filter(Subscription.user_id == user.id, Subscription.status == SubscriptionStatus.ACTIVE)
        .first()
    )
    if active_sub and active_sub.current_period_end:
        end = active_sub.current_period_end
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if end > datetime.now(timezone.utc):
            raise AuthError("already_subscribed", "You already have an active subscription", status_code=409)

    trade_order_id = f"mona_{user.id}_{uuid.uuid4().hex[:12]}"
    amount = _get_price(body.duration_months)

    payment = Payment(
        user_id=user.id,
        trade_order_id=trade_order_id,
        amount=amount,
        duration_months=body.duration_months,
        status=PaymentStatus.PENDING,
    )
    db.add(payment)
    db.commit()

    params = {
        "version": "1.1",
        "appid": settings.xhp_app_id,
        "trade_order_id": trade_order_id,
        "total_fee": f"{amount:.2f}",
        "title": f"Mona Pro 会员 - {body.duration_months}个月",
        "time": str(int(datetime.now(timezone.utc).timestamp())),
        "notify_url": settings.xhp_notify_url,
        "nonce_str": uuid.uuid4().hex[:16],
        "type": body.payment_type,
        "hash": "",
    }
    params["hash"] = _xhp_sign(params)

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(settings.xhp_base_url, data=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        payment.status = PaymentStatus.FAILED
        db.commit()
        raise AuthError("payment_error", f"Failed to create payment order: {e}", status_code=502)

    if data.get("errcode") != 0:
        payment.status = PaymentStatus.FAILED
        db.commit()
        raise AuthError(
            "payment_error", data.get("errmsg", "Unknown payment error"), status_code=502
        )

    pay_url = data.get("url_qrcode", data.get("url", ""))
    payment.pay_url = pay_url
    payment.xhp_order_id = data.get("open_order_id")
    db.commit()

    return CreatePaymentResponse(
        trade_order_id=trade_order_id,
        pay_url=pay_url,
        amount=amount,
    )


@router.post("/notify")
async def payment_notify(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    params = dict(form)

    received_hash = params.pop("hash", None)
    if not received_hash:
        raise AuthError("invalid_notify", "Missing hash", status_code=400)

    expected_hash = _xhp_sign({k: str(v) for k, v in params.items() if k != "hash"})
    if received_hash != expected_hash:
        raise AuthError("invalid_sign", "Signature verification failed", status_code=400)

    trade_order_id = params.get("trade_order_id")
    status_val = params.get("status")

    if not trade_order_id:
        return "success"

    payment = db.query(Payment).filter(Payment.trade_order_id == trade_order_id).first()
    if not payment:
        return "success"

    if status_val == "OD" and payment.status != PaymentStatus.PAID:
        payment.status = PaymentStatus.PAID
        payment.paid_at = datetime.now(timezone.utc)
        _activate_subscription(db, payment.user_id, payment.duration_months)

    return "success"


@router.get("/subscription", response_model=SubscriptionInfo)
def get_subscription(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sub = db.query(Subscription).filter(Subscription.user_id == user.id).first()
    if not sub:
        return SubscriptionInfo(status="expired", current_period_end=None)
    return SubscriptionInfo(status=sub.status.value, current_period_end=sub.current_period_end)


@router.get("/list", response_model=PaymentListResponse)
def list_payments(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    payments = (
        db.query(Payment)
        .filter(Payment.user_id == user.id)
        .order_by(Payment.created_at.desc())
        .limit(20)
        .all()
    )
    return PaymentListResponse(payments=payments)
