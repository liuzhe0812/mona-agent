"""支付宝订阅支付路由

提供：
- POST /payment/subscribe            创建订阅（周期扣款签约 / 一次性支付）
- GET  /payment/orders/{order_id}    查询订单状态（客户端轮询）
- GET  /payment/subscription         查询当前订阅状态
- POST /payment/cancel-auto-renew    取消自动续费（解约）
- GET  /payment/renewals             查询续费扣款记录
- POST /payment/alipay/notify        支付宝异步回调
- GET  /payment/alipay/return        支付宝同步返回（重定向）
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.alipay import alipay_service
from app.config import settings
from app.database import SessionLocal, get_db
from app.deps import get_current_user
from app.email import send_email
from app.errors import AuthError
from app.models import (
    AgreementStatus,
    Payment,
    PaymentAgreement,
    PaymentStatus,
    PricingPlan,
    RenewalStatus,
    Subscription,
    SubscriptionRenewal,
    SubscriptionStatus,
    User,
)
from app.schemas import (
    CancelAutoRenewRequest,
    CancelAutoRenewResponse,
    OrderStatusResponse,
    RenewalInfo,
    RenewalListResponse,
    SubscribeRequest,
    SubscribeResponse,
    SubscriptionInfo,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/payment", tags=["payment"])

# 订单待支付有效期
ORDER_EXPIRE_MINUTES = 30
# 续费扣款重试上限
MAX_RENEWAL_RETRY = 3


# ── 辅助函数 ──

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_UTC(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _get_plan(db: Session, plan_code: str) -> PricingPlan:
    plan = db.query(PricingPlan).filter(PricingPlan.id == plan_code).first()
    if not plan:
        raise AuthError("plan_not_found", f"Plan {plan_code} not found", status_code=404)
    if not plan.enabled:
        raise AuthError("plan_disabled", f"Plan {plan_code} is disabled", status_code=400)
    return plan


def _get_active_subscription(db: Session, user_id: int) -> Subscription | None:
    return (
        db.query(Subscription)
        .filter(
            Subscription.user_id == user_id,
            Subscription.status == SubscriptionStatus.ACTIVE,
        )
        .order_by(Subscription.created_at.desc())
        .first()
    )


def _activate_subscription(
    db: Session,
    user_id: int,
    plan: PricingPlan,
    auto_renew: bool = False,
    agreement_id: int | None = None,
) -> Subscription:
    """激活或延长订阅"""
    now = _now()
    period_days = plan.period_days or (plan.duration_months or 1) * 30
    sub = _get_active_subscription(db, user_id)

    if sub and sub.current_period_end:
        end = _to_UTC(sub.current_period_end) or now
        if end > now:
            # 当前有效，延长
            sub.current_period_end = end + timedelta(days=period_days)
        else:
            sub.current_period_end = now + timedelta(days=period_days)
            sub.status = SubscriptionStatus.ACTIVE
        sub.cancelled_at = None
    else:
        if not sub:
            sub = Subscription(user_id=user_id)
            db.add(sub)
        sub.status = SubscriptionStatus.ACTIVE
        sub.current_period_end = now + timedelta(days=period_days)

    sub.plan_code = plan.id
    sub.auto_renew = auto_renew
    if agreement_id is not None:
        sub.agreement_id = agreement_id
    db.flush()
    return sub


def _build_subscription_info(sub: Subscription | None) -> SubscriptionInfo:
    if not sub:
        return SubscriptionInfo(status="expired", current_period_end=None)
    return SubscriptionInfo(
        status=sub.status.value,
        current_period_end=_to_UTC(sub.current_period_end),
        plan_code=sub.plan_code,
        auto_renew=sub.auto_renew,
        agreement_status=sub.agreement.status.value if sub.agreement else None,
        cancelled_at=_to_UTC(sub.cancelled_at),
    )


# ── 创建订阅 ──

@router.post("/subscribe", response_model=SubscribeResponse)
def create_subscription(
    body: SubscribeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    plan = _get_plan(db, body.plan_code)

    # 校验当前无活跃订阅（除非已过期）
    active_sub = _get_active_subscription(db, user.id)
    if active_sub and active_sub.current_period_end:
        end = _to_UTC(active_sub.current_period_end)
        if end and end > _now():
            raise AuthError(
                "already_subscribed",
                "You already have an active subscription",
                status_code=409,
            )

    if not alipay_service.enabled:
        raise AuthError("alipay_disabled", "Alipay payment is not configured", status_code=503)

    # 周期扣款仅支持可自动续费的套餐
    if body.payment_method == "alipay_periodic" and not plan.auto_renewable:
        raise AuthError(
            "plan_not_renewable",
            f"Plan {body.plan_code} does not support auto-renewal",
            status_code=400,
        )

    trade_order_id = f"mona_{user.id}_{uuid.uuid4().hex[:12]}"
    external_sign_no = f"sign_{user.id}_{uuid.uuid4().hex[:8]}"
    expires_at = _now() + timedelta(minutes=ORDER_EXPIRE_MINUTES)

    # 创建订单
    payment = Payment(
        user_id=user.id,
        trade_order_id=trade_order_id,
        amount=float(plan.price),
        duration_months=plan.duration_months,
        plan_code=plan.id,
        status=PaymentStatus.PENDING,
        payment_channel="alipay",
        payment_type="periodic_sign" if body.payment_method == "alipay_periodic" else "page",
        external_sign_no=external_sign_no if body.payment_method == "alipay_periodic" else None,
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)

    subject = f"Mona Pro {plan.name}"

    if body.payment_method == "alipay_periodic":
        # 周期扣款签约并支付
        result = alipay_service.sign_and_pay(
            external_agreement_no=external_sign_no,
            out_trade_no=trade_order_id,
            total_amount=float(plan.price),
            subject=subject,
        )
        if not result.success:
            payment.status = PaymentStatus.FAILED
            db.commit()
            raise AuthError(
                "alipay_sign_failed",
                result.error or "Sign and pay failed",
                status_code=502,
            )
        payment.pay_url = result.sign_url
        db.commit()

        return SubscribeResponse(
            order_id=payment.id,
            trade_order_id=trade_order_id,
            payment_url=result.sign_url or "",
            payment_method="alipay_periodic",
            expires_at=expires_at,
        )
    else:
        # 一次性电脑网站支付
        try:
            pay_url = alipay_service.create_page_pay_url(
                out_trade_no=trade_order_id,
                total_amount=float(plan.price),
                subject=subject,
            )
        except Exception as e:
            payment.status = PaymentStatus.FAILED
            db.commit()
            raise AuthError("alipay_pay_failed", str(e), status_code=502)

        payment.pay_url = pay_url
        db.commit()

        return SubscribeResponse(
            order_id=payment.id,
            trade_order_id=trade_order_id,
            payment_url=pay_url,
            payment_method="alipay_page",
            expires_at=expires_at,
        )


# ── 查询订单状态 ──

@router.get("/orders/{order_id}", response_model=OrderStatusResponse)
def get_order_status(
    order_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    payment = db.query(Payment).filter(Payment.id == order_id, Payment.user_id == user.id).first()
    if not payment:
        raise AuthError("order_not_found", "Order not found", status_code=404)

    sub = _get_active_subscription(db, user.id)
    return OrderStatusResponse(
        order_id=payment.id,
        status=payment.status.value,
        subscription=_build_subscription_info(sub) if sub else None,
    )


# ── 查询当前订阅 ──

@router.get("/subscription", response_model=SubscriptionInfo)
def get_subscription(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = _get_active_subscription(db, user.id)
    return _build_subscription_info(sub)


# ── 取消自动续费 ──

@router.post("/cancel-auto-renew", response_model=CancelAutoRenewResponse)
def cancel_auto_renew(
    body: CancelAutoRenewRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = _get_active_subscription(db, user.id)
    if not sub:
        raise AuthError("no_subscription", "No active subscription", status_code=404)

    if not sub.auto_renew:
        # 已经取消过，幂等返回
        return CancelAutoRenewResponse(
            cancelled_at=_to_UTC(sub.cancelled_at) or _now(),
            current_period_end=_to_UTC(sub.current_period_end),
            message="自动续费已关闭，无需重复操作",
        )

    if not sub.agreement or sub.agreement.status != AgreementStatus.ACTIVE:
        # 协议已失效，仅本地标记
        sub.auto_renew = False
        sub.cancelled_at = _now()
        db.commit()
        return CancelAutoRenewResponse(
            cancelled_at=sub.cancelled_at,
            current_period_end=_to_UTC(sub.current_period_end),
            message="协议已失效，已关闭自动续费",
        )

    # 调用支付宝解约
    result = alipay_service.unsign(sub.agreement.agreement_no)
    if not result.success:
        # 解约失败也允许本地取消（用户意愿），但记录日志
        logger.warning("Alipay unsign failed for user %s: %s", user.id, result.error)

    sub.agreement.status = AgreementStatus.CANCELLED
    sub.agreement.cancelled_at = _now()
    sub.agreement.cancel_reason = body.reason
    sub.auto_renew = False
    sub.cancelled_at = _now()
    db.commit()

    end = _to_UTC(sub.current_period_end)
    end_str = end.strftime("%Y-%m-%d") if end else "未知"
    return CancelAutoRenewResponse(
        cancelled_at=sub.cancelled_at,
        current_period_end=end,
        message=f"已关闭自动续费，会员有效期至 {end_str}",
    )


# ── 续费扣款记录 ──

@router.get("/renewals", response_model=RenewalListResponse)
def list_renewals(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = _get_active_subscription(db, user.id)
    if not sub:
        return RenewalListResponse(renewals=[])
    renewals = (
        db.query(SubscriptionRenewal)
        .filter(SubscriptionRenewal.subscription_id == sub.id)
        .order_by(SubscriptionRenewal.created_at.desc())
        .limit(50)
        .all()
    )
    return RenewalListResponse(
        renewals=[
            RenewalInfo(
                id=r.id,
                out_trade_no=r.out_trade_no,
                amount=float(r.amount),
                period_days=r.period_days,
                status=r.status.value,
                paid_at=_to_UTC(r.paid_at),
                failure_reason=r.failure_reason,
                created_at=r.created_at,
            )
            for r in renewals
        ]
    )


# ── 支付宝异步回调 ──

@router.post("/alipay/notify", response_class=PlainTextResponse)
async def alipay_notify(request: Request, db: Session = Depends(get_db)):
    """支付宝异步通知入口

    支持两类通知：
    1. 周期扣款签约/解约通知（notify_type=cycle_sign）
    2. 交易支付通知（trade_status=TRADE_SUCCESS / TRADE_FINISHED）
    3. 周期扣款扣款通知（notify_type=cycle_charge）
    """
    form = await request.form()
    data: dict[str, Any] = {k: str(v) for k, v in form.items()}

    # 验签
    if not alipay_service.verify_callback(data.copy()):
        logger.warning("Alipay notify signature verification failed: %s", data)
        return "fail"

    notify_type = data.get("notify_type", "")
    trade_status = data.get("trade_status", "")
    out_trade_no = data.get("out_trade_no", "")
    trade_no = data.get("trade_no", "")

    logger.info("Alipay notify: notify_type=%s trade_status=%s out_trade_no=%s", notify_type, trade_status, out_trade_no)

    try:
        if notify_type == "cycle_sign":
            await _handle_cycle_sign_notify(db, data)
        elif trade_status in ("TRADE_SUCCESS", "TRADE_FINISHED"):
            if notify_type == "cycle_charge":
                await _handle_cycle_charge_notify(db, data, trade_no)
            else:
                await _handle_trade_success_notify(db, data, trade_no)
        else:
            logger.info("Unhandled alipay notify: %s", data)
    except Exception:
        logger.exception("Alipay notify processing failed")
        return "fail"

    return "success"


async def _handle_cycle_sign_notify(db: Session, data: dict[str, Any]) -> None:
    """处理周期扣款签约/解约通知"""
    status = data.get("status", "")
    agreement_no = data.get("agreement_no", "")
    external_sign_no = data.get("external_agreement_no", "")
    alipay_user_id = data.get("alipay_user_id", "")
    now = _now()

    # 找到对应订单（通过 external_sign_no）
    payment = (
        db.query(Payment)
        .filter(Payment.external_sign_no == external_sign_no)
        .first()
    )

    if status == "VERIFIED":
        # 签约成功
        if not agreement_no:
            logger.warning("cycle_sign VERIFIED without agreement_no")
            return
        existing = db.query(PaymentAgreement).filter(PaymentAgreement.agreement_no == agreement_no).first()
        if existing:
            # 已处理，幂等
            return
        agreement = PaymentAgreement(
            user_id=payment.user_id if payment else 0,
            agreement_no=agreement_no,
            alipay_user_id=alipay_user_id or None,
            status=AgreementStatus.ACTIVE,
            external_sign_no=external_sign_no,
        )
        db.add(agreement)
        db.flush()

        # 关联到订单（等待扣款回调激活订阅）
        if payment:
            payment.agreement_no = agreement_no
        db.commit()
        logger.info("Agreement created: %s for user %s", agreement_no, payment.user_id if payment else "?")

    elif status == "UNSIGN":
        # 解约通知
        agreement = db.query(PaymentAgreement).filter(PaymentAgreement.agreement_no == agreement_no).first()
        if agreement:
            agreement.status = AgreementStatus.CANCELLED
            agreement.cancelled_at = now
            # 同步更新订阅
            subs = (
                db.query(Subscription)
                .filter(Subscription.agreement_id == agreement.id)
                .all()
            )
            for sub in subs:
                sub.auto_renew = False
                if not sub.cancelled_at:
                    sub.cancelled_at = now
            db.commit()
            logger.info("Agreement unsign: %s", agreement_no)


async def _handle_cycle_charge_notify(db: Session, data: dict[str, Any], trade_no: str) -> None:
    """处理周期扣款扣款成功通知"""
    out_trade_no = data.get("out_trade_no", "")
    total_amount = data.get("total_amount", "0")
    now = _now()

    # 先查续费记录
    renewal = db.query(SubscriptionRenewal).filter(SubscriptionRenewal.out_trade_no == out_trade_no).first()
    if renewal:
        if renewal.status == RenewalStatus.SUCCESS:
            return  # 幂等
        renewal.status = RenewalStatus.SUCCESS
        renewal.alipay_trade_no = trade_no
        renewal.paid_at = now
        # 延长订阅
        sub = renewal.subscription
        if sub and sub.current_period_end:
            end = _to_UTC(sub.current_period_end) or now
            if end > now:
                sub.current_period_end = end + timedelta(days=renewal.period_days)
            else:
                sub.current_period_end = now + timedelta(days=renewal.period_days)
                sub.status = SubscriptionStatus.ACTIVE
        db.commit()
        return

    # 可能是首期扣款（签约并支付）
    payment = db.query(Payment).filter(Payment.trade_order_id == out_trade_no).first()
    if payment and payment.status != PaymentStatus.PAID:
        payment.status = PaymentStatus.PAID
        payment.paid_at = now
        payment.alipay_trade_no = trade_no
        plan = _get_plan(db, payment.plan_code) if payment.plan_code else None
        if plan:
            # 查找协议
            agreement = None
            if payment.agreement_no:
                agreement = db.query(PaymentAgreement).filter(PaymentAgreement.agreement_no == payment.agreement_no).first()
            _activate_subscription(
                db,
                payment.user_id,
                plan,
                auto_renew=True,
                agreement_id=agreement.id if agreement else None,
            )
        db.commit()
        return

    logger.warning("cycle_charge notify for unknown out_trade_no: %s", out_trade_no)


async def _handle_trade_success_notify(db: Session, data: dict[str, Any], trade_no: str) -> None:
    """处理一次性支付成功通知"""
    out_trade_no = data.get("out_trade_no", "")
    now = _now()

    payment = db.query(Payment).filter(Payment.trade_order_id == out_trade_no).first()
    if not payment:
        logger.warning("trade_success notify for unknown order: %s", out_trade_no)
        return
    if payment.status == PaymentStatus.PAID:
        return  # 幂等

    payment.status = PaymentStatus.PAID
    payment.paid_at = now
    payment.alipay_trade_no = trade_no

    plan = _get_plan(db, payment.plan_code) if payment.plan_code else None
    if plan:
        _activate_subscription(db, payment.user_id, plan, auto_renew=False)
    db.commit()


# ── 支付宝同步返回（前端重定向）──

@router.get("/alipay/return")
async def alipay_return(request: Request):
    """支付宝同步返回，重定向回客户端支付页"""
    # 客户端会在弹窗中轮询订单状态，这里只需简单返回成功页
    return RedirectResponse(url="/payment/return-success", status_code=302)


# ── 后台辅助：主动查询订单状态（兜底回调延迟）──

def sync_payment_status(db: Session, payment: Payment) -> None:
    """主动查询支付宝订单状态并同步"""
    if not alipay_service.enabled:
        return
    if payment.status == PaymentStatus.PAID:
        return
    try:
        result = alipay_service.query_trade(out_trade_no=payment.trade_order_id)
    except Exception:
        logger.exception("query_trade failed for %s", payment.trade_order_id)
        return

    trade_status = result.get("trade_status", "")
    if trade_status in ("TRADE_SUCCESS", "TRADE_FINISHED") and result.get("code") == "10000":
        payment.status = PaymentStatus.PAID
        payment.paid_at = _now()
        payment.alipay_trade_no = result.get("trade_no")
        plan = _get_plan(db, payment.plan_code) if payment.plan_code else None
        if plan:
            _activate_subscription(db, payment.user_id, plan, auto_renew=payment.payment_type == "periodic_sign")
        db.commit()
