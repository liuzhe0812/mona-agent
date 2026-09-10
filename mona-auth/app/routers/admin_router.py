from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.credits import display_amount
from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.models import (
    AgreementStatus,
    AppConfig,
    CreditWallet,
    Notification,
    NotificationRead,
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
from app.recharge_promotion import recharge_pro_promotion, save_recharge_pro_promotion
from app.schemas import (
    AdminAccountUpdateRequest,
    AdminRechargeProPromotionRequest,
    AdminTrialUpdateRequest,
    AdminUserInfo,
    AdminUserListResponse,
)

router = APIRouter(prefix="/admin", tags=["admin"])


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise AuthError("forbidden", "Admin access required", status_code=403)
    return user


@router.get("/users", response_model=AdminUserListResponse)
def list_users(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    search: str = Query(default=""),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    offset = (page - 1) * page_size
    query = db.query(User).order_by(User.created_at.desc())
    if search:
        query = query.filter(
            or_(User.email.contains(search), User.account.contains(search))
        )
    total = query.count()
    users = query.offset(offset).limit(page_size).all()

    result = []
    for u in users:
        sub = (
            db.query(Subscription)
            .filter(Subscription.user_id == u.id, Subscription.status == SubscriptionStatus.ACTIVE)
            .first()
        )
        wallet = db.get(CreditWallet, u.id)
        result.append(
            AdminUserInfo(
                id=u.id,
                email=u.email,
                account=u.account,
                is_admin=u.is_admin,
                trial_started_at=u.trial_started_at,
                trial_expires_at=u.trial_expires_at,
                created_at=u.created_at,
                subscription_status=sub.status.value if sub else None,
                subscription_end=sub.current_period_end if sub else None,
                available_balance=display_amount(wallet.available_units) if wallet else "0",
                reserved_balance=display_amount(wallet.reserved_units) if wallet else "0",
                active_requests=wallet.active_requests if wallet else 0,
                wallet_updated_at=wallet.updated_at if wallet else None,
            )
        )

    return AdminUserListResponse(users=result, total=total)


@router.put("/users/{user_id}/trial")
def update_trial(
    user_id: int,
    body: AdminTrialUpdateRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise AuthError("user_not_found", "User not found", status_code=404)

    user.trial_expires_at = body.trial_expires_at
    if user.trial_started_at is None:
        user.trial_started_at = datetime.now(timezone.utc)
    db.commit()

    return {"message": "Trial updated", "trial_expires_at": user.trial_expires_at.isoformat()}


@router.put("/users/{user_id}/subscription")
def update_subscription(
    user_id: int,
    status: str = Query(..., pattern=r"^(active|expired)$"),
    period_end: datetime | None = None,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise AuthError("user_not_found", "User not found", status_code=404)

    sub = db.query(Subscription).filter(Subscription.user_id == user.id).first()
    if not sub:
        sub = Subscription(user_id=user.id)
        db.add(sub)

    sub.status = SubscriptionStatus.ACTIVE if status == "active" else SubscriptionStatus.EXPIRED
    sub.current_period_end = period_end
    db.commit()

    return {"message": "Subscription updated"}


@router.put("/users/{user_id}/account")
def update_account(
    user_id: int,
    body: AdminAccountUpdateRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise AuthError("user_not_found", "User not found", status_code=404)

    # Check uniqueness (excluding current user)
    existing = (
        db.query(User)
        .filter(User.account == body.account, User.id != user_id)
        .first()
    )
    if existing:
        raise AuthError("account_exists", "This account name is already taken", status_code=409)

    user.account = body.account
    db.commit()

    return {"message": "Account updated", "account": user.account}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise AuthError("user_not_found", "User not found", status_code=404)
    if user.is_admin:
        raise AuthError("forbidden", "Cannot delete admin user", status_code=403)
    db.query(Subscription).filter(Subscription.user_id == user_id).delete()
    db.delete(user)
    db.commit()
    return {"message": "User deleted"}


@router.get("/stats")
def get_stats(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    total_users = db.query(User).count()
    active_subscriptions = (
        db.query(Subscription).filter(Subscription.status == SubscriptionStatus.ACTIVE).count()
    )
    active_trials = db.query(User).filter(User.trial_expires_at > now).count()
    expired_trials = db.query(User).filter(
        User.trial_expires_at != None,  # noqa: E711
        User.trial_expires_at <= now,
    ).count()

    return {
        "total_users": total_users,
        "active_subscriptions": active_subscriptions,
        "active_trials": active_trials,
        "expired_trials": expired_trials,
    }


@router.get("/pricing")
def get_pricing_admin(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    plans = db.query(PricingPlan).order_by(PricingPlan.sort_order.asc()).all()
    contact_email = db.query(AppConfig).filter(AppConfig.key == "contact_email").first()
    contact_wechat = db.query(AppConfig).filter(AppConfig.key == "contact_wechat").first()
    banner = db.query(AppConfig).filter(AppConfig.key == "promotional_banner").first()
    return {
        "plans": plans,
        "contact": {
            "email": contact_email.value if contact_email else "",
            "wechat": contact_wechat.value if contact_wechat else "",
        },
        "promotional_banner": banner.value if banner else None,
    }


@router.put("/pricing")
def update_pricing(
    body: dict,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    db.query(PricingPlan).delete()
    for p in body.get("plans", []):
        db.add(PricingPlan(
            id=p["id"],
            name=p["name"],
            price=p["price"],
            original_price=p.get("original_price"),
            duration_months=p.get("duration_months"),
            period_days=p.get("period_days"),
            auto_renewable=p.get("auto_renewable", True),
            badge=p.get("badge"),
            sort_order=p.get("sort_order", 0),
            enabled=p.get("enabled", True),
        ))
    for key in ["email", "wechat"]:
        if key in body.get("contact", {}):
            config_key = "contact_email" if key == "email" else "contact_wechat"
            row = db.query(AppConfig).filter(AppConfig.key == config_key).first()
            value = body["contact"][key]
            if row:
                row.value = value
            else:
                db.add(AppConfig(key=config_key, value=value))
    banner_row = db.query(AppConfig).filter(AppConfig.key == "promotional_banner").first()
    banner_value = body.get("promotional_banner")
    if banner_row:
        banner_row.value = banner_value
    else:
        db.add(AppConfig(key="promotional_banner", value=banner_value))
    db.commit()
    return {"message": "Pricing config updated"}


@router.delete("/pricing/{plan_id}")
def delete_pricing_plan(
    plan_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    db.query(PricingPlan).filter(PricingPlan.id == plan_id).delete()
    db.commit()
    return {"message": "Plan deleted"}


@router.get("/notifications")
def list_admin_notifications(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    notifications = db.query(Notification).order_by(Notification.created_at.desc()).all()
    return {
        "notifications": [
            {
                "id": n.id,
                "title": n.title,
                "type": n.type,
                "published": n.published,
                "expires_at": n.expires_at.isoformat() if n.expires_at else None,
                "read_count": db.query(NotificationRead).filter(NotificationRead.notification_id == n.id).count(),
            }
            for n in notifications
        ]
    }


@router.post("/notifications")
def create_notification(
    body: dict,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    n = Notification(
        title=body["title"],
        body=body["body"],
        type=body["type"],
        action_url=body.get("action_url"),
        expires_at=body.get("expires_at"),
        published=True,
        published_at=datetime.now(timezone.utc),
    )
    db.add(n)
    db.commit()
    return {"id": n.id}


@router.post("/notifications/{notification_id}/{action}")
def toggle_notification(
    notification_id: int,
    action: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    n = db.query(Notification).filter(Notification.id == notification_id).first()
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")
    if action == "publish":
        n.published = True
        n.published_at = datetime.now(timezone.utc)
    elif action == "unpublish":
        n.published = False
    db.commit()
    return {"message": "Updated"}


@router.delete("/notifications/{notification_id}")
def delete_notification(
    notification_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    db.query(Notification).filter(Notification.id == notification_id).delete()
    db.commit()
    return {"message": "Deleted"}


# ── Registration promo trial config ──

_PROMO_KEYS = ["promo_trial_enabled", "promo_trial_days", "promo_trial_start_at", "promo_trial_end_at"]


def _get_app_config(db: Session, key: str) -> str | None:
    row = db.query(AppConfig).filter(AppConfig.key == key).first()
    return row.value if row else None


def _set_app_config(db: Session, key: str, value: str | None):
    row = db.query(AppConfig).filter(AppConfig.key == key).first()
    if row:
        row.value = value
    else:
        db.add(AppConfig(key=key, value=value))


@router.get("/promo-trial")
def get_promo_trial(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return {
        "enabled": _get_app_config(db, "promo_trial_enabled") == "true",
        "days": int(_get_app_config(db, "promo_trial_days") or 0),
        "start_at": _get_app_config(db, "promo_trial_start_at"),
        "end_at": _get_app_config(db, "promo_trial_end_at"),
    }


@router.put("/promo-trial")
def update_promo_trial(
    body: dict,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    _set_app_config(db, "promo_trial_enabled", "true" if body.get("enabled") else "false")
    _set_app_config(db, "promo_trial_days", str(body.get("days", 0)))
    _set_app_config(db, "promo_trial_start_at", body.get("start_at") or "")
    _set_app_config(db, "promo_trial_end_at", body.get("end_at") or "")
    db.commit()
    return {"message": "Promo trial config updated"}


def _recharge_pro_promotion_response(db: Session) -> dict:
    promotion = recharge_pro_promotion(db)
    return {
        "enabled": promotion.enabled,
        "active": promotion.active,
        "min_amount": format(promotion.min_amount, ".2f"),
        "gift_days": promotion.gift_days,
        "start_at": promotion.start_at,
        "end_at": promotion.end_at,
        "description": promotion.description,
    }


@router.get("/recharge-pro-promotion")
def get_recharge_pro_promotion(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    return _recharge_pro_promotion_response(db)


@router.put("/recharge-pro-promotion")
def update_recharge_pro_promotion(
    body: AdminRechargeProPromotionRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    save_recharge_pro_promotion(db, body)
    db.commit()
    return _recharge_pro_promotion_response(db)


# ── 订单管理 ──

@router.get("/orders")
def list_admin_orders(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    status: str | None = Query(default=None, pattern=r"^(pending|paid|failed)$"),
    channel: str | None = Query(default=None, pattern=r"^(alipay|xhp)$"),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    query = db.query(Payment).order_by(Payment.created_at.desc())
    if status:
        query = query.filter(Payment.status == PaymentStatus(status))
    if channel:
        query = query.filter(Payment.payment_channel == channel)
    total = query.count()
    offset = (page - 1) * page_size
    orders = query.offset(offset).limit(page_size).all()
    return {
        "orders": [
            {
                "id": o.id,
                "user_id": o.user_id,
                "trade_order_id": o.trade_order_id,
                "amount": float(o.amount),
                "plan_code": o.plan_code,
                "duration_months": o.duration_months,
                "status": o.status.value,
                "payment_channel": o.payment_channel,
                "payment_type": o.payment_type,
                "alipay_trade_no": o.alipay_trade_no,
                "paid_at": o.paid_at.isoformat() if o.paid_at else None,
                "created_at": o.created_at.isoformat(),
            }
            for o in orders
        ],
        "total": total,
    }


@router.get("/renewals")
def list_admin_renewals(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    status: str | None = Query(default=None, pattern=r"^(pending|success|failed|retrying)$"),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    query = db.query(SubscriptionRenewal).order_by(SubscriptionRenewal.created_at.desc())
    if status:
        query = query.filter(SubscriptionRenewal.status == RenewalStatus(status))
    total = query.count()
    offset = (page - 1) * page_size
    renewals = query.offset(offset).limit(page_size).all()
    return {
        "renewals": [
            {
                "id": r.id,
                "subscription_id": r.subscription_id,
                "agreement_no": r.agreement_no,
                "out_trade_no": r.out_trade_no,
                "amount": float(r.amount),
                "period_days": r.period_days,
                "status": r.status.value,
                "retry_count": r.retry_count,
                "next_retry_at": r.next_retry_at.isoformat() if r.next_retry_at else None,
                "paid_at": r.paid_at.isoformat() if r.paid_at else None,
                "failure_reason": r.failure_reason,
                "created_at": r.created_at.isoformat(),
            }
            for r in renewals
        ],
        "total": total,
    }


@router.get("/agreements")
def list_admin_agreements(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    status: str | None = Query(default=None, pattern=r"^(active|cancelled|expired)$"),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    query = db.query(PaymentAgreement).order_by(PaymentAgreement.signed_at.desc())
    if status:
        query = query.filter(PaymentAgreement.status == AgreementStatus(status))
    total = query.count()
    offset = (page - 1) * page_size
    agreements = query.offset(offset).limit(page_size).all()
    return {
        "agreements": [
            {
                "id": a.id,
                "user_id": a.user_id,
                "agreement_no": a.agreement_no,
                "alipay_user_id": a.alipay_user_id,
                "status": a.status.value,
                "external_sign_no": a.external_sign_no,
                "signed_at": a.signed_at.isoformat(),
                "cancelled_at": a.cancelled_at.isoformat() if a.cancelled_at else None,
                "cancel_reason": a.cancel_reason,
            }
            for a in agreements
        ],
        "total": total,
    }


@router.post("/agreements/{agreement_id}/unsign")
def admin_unsign_agreement(
    agreement_id: int,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """管理员手动解约某个协议（异常处理）"""
    from app.alipay import alipay_service

    agreement = db.query(PaymentAgreement).filter(PaymentAgreement.id == agreement_id).first()
    if not agreement:
        raise AuthError("agreement_not_found", "Agreement not found", status_code=404)
    if agreement.status != AgreementStatus.ACTIVE:
        return {"message": "Agreement is not active"}

    result = alipay_service.unsign(agreement.agreement_no)
    agreement.status = AgreementStatus.CANCELLED
    agreement.cancelled_at = datetime.now(timezone.utc)
    agreement.cancel_reason = f"Admin manual unsign: {result.error or 'OK'}"
    # 同步关闭订阅的 auto_renew
    subs = db.query(Subscription).filter(Subscription.agreement_id == agreement.id).all()
    for sub in subs:
        sub.auto_renew = False
        if not sub.cancelled_at:
            sub.cancelled_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Agreement unsigned", "alipay_result": result.success}


@router.get("/metrics/dashboard")
def get_metrics_dashboard(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """运营看板：一次性返回所有指标数据。"""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())
    month_start = today_start.replace(day=1)
    year_start = today_start.replace(month=1, day=1)

    # ── 收入总览 ──
    def sum_amount(start, end):
        return db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
            Payment.status == PaymentStatus.PAID,
            Payment.paid_at >= start,
            Payment.paid_at < end,
        ).scalar() or 0

    revenue_today = sum_amount(today_start, now)
    revenue_week = sum_amount(week_start, now)
    revenue_month = sum_amount(month_start, now)
    revenue_year = sum_amount(year_start, now)

    # MRR：当前 active 订阅的月费总和
    # 月付直接计月费；年付除以 12；无法识别的按 amount 月费
    active_subs = db.query(Subscription).filter(Subscription.status == SubscriptionStatus.ACTIVE).all()
    plan_map = {p.id: p for p in db.query(PricingPlan).all()}
    mrr = 0.0
    plan_count = {}
    for sub in active_subs:
        plan = plan_map.get(sub.plan_code) if sub.plan_code else None
        if plan:
            if plan.duration_months and plan.duration_months >= 12:
                mrr += plan.price / 12
            elif plan.duration_months:
                mrr += plan.price / plan.duration_months
            else:
                mrr += plan.price
            plan_count[plan.name] = plan_count.get(plan.name, 0) + 1

    arr = mrr * 12
    paying_users_count = db.query(func.count(func.distinct(Payment.user_id))).filter(
        Payment.status == PaymentStatus.PAID
    ).scalar() or 0
    avg_revenue_per_user = revenue_year / paying_users_count if paying_users_count else 0

    # ── 用户与转化 ──
    total_users = db.query(User).count()
    active_trials = db.query(User).filter(User.trial_expires_at > now).count()
    expired_trials = db.query(User).filter(
        User.trial_expires_at.is_not(None),
        User.trial_expires_at <= now,
    ).count()
    ever_tried = active_trials + expired_trials
    conversion_rate = paying_users_count / ever_tried if ever_tried else 0

    # 流失用户：曾经付费但当前无 active subscription
    paid_user_ids = {r[0] for r in db.query(func.distinct(Payment.user_id)).filter(Payment.status == PaymentStatus.PAID).all()}
    active_sub_user_ids = {r[0] for r in db.query(Subscription.user_id).filter(Subscription.status == SubscriptionStatus.ACTIVE).all()}
    churned_users = len(paid_user_ids - active_sub_user_ids)

    # 新增用户趋势（近 30 天按天）
    trend_start = today_start - timedelta(days=29)
    new_users_trend = db.query(
        func.date(User.created_at).label('d'),
        func.count(User.id).label('c')
    ).filter(User.created_at >= trend_start).group_by(func.date(User.created_at)).all()
    trend_map = {str(r.d): r.c for r in new_users_trend}
    new_users_series = []
    for i in range(30):
        d = (trend_start + timedelta(days=i)).strftime('%Y-%m-%d')
        new_users_series.append({"date": d, "count": trend_map.get(d, 0)})

    # ── 订阅与续费 ──
    active_count = len(active_subs)
    auto_renew_count = sum(1 for s in active_subs if s.auto_renew)
    auto_renew_rate = auto_renew_count / active_count if active_count else 0

    # 到期分布
    exp_7 = db.query(Subscription).filter(
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.current_period_end >= now,
        Subscription.current_period_end < now + timedelta(days=7),
    ).count()
    exp_30 = db.query(Subscription).filter(
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.current_period_end >= now + timedelta(days=7),
        Subscription.current_period_end < now + timedelta(days=30),
    ).count()
    exp_60 = db.query(Subscription).filter(
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.current_period_end >= now + timedelta(days=30),
        Subscription.current_period_end < now + timedelta(days=60),
    ).count()
    exp_90 = db.query(Subscription).filter(
        Subscription.status == SubscriptionStatus.ACTIVE,
        Subscription.current_period_end >= now + timedelta(days=60),
        Subscription.current_period_end < now + timedelta(days=90),
    ).count()

    # 续费统计
    total_renewals = db.query(SubscriptionRenewal).count()
    success_renewals = db.query(SubscriptionRenewal).filter(
        SubscriptionRenewal.status == RenewalStatus.SUCCESS
    ).count()
    failed_renewals = db.query(SubscriptionRenewal).filter(
        SubscriptionRenewal.status == RenewalStatus.FAILED
    ).count()
    retrying_renewals = db.query(SubscriptionRenewal).filter(
        SubscriptionRenewal.status == RenewalStatus.RETRYING
    ).count()
    renewal_success_rate = success_renewals / total_renewals if total_renewals else 0

    # 月收入趋势（近 12 个月）
    month_trend_start = (now.replace(day=1) - timedelta(days=11 * 30)).replace(day=1)
    revenue_trend = db.query(
        func.date_format(Payment.paid_at, '%Y-%m').label('m'),
        func.sum(Payment.amount).label('s')
    ).filter(
        Payment.status == PaymentStatus.PAID,
        Payment.paid_at >= month_trend_start,
    ).group_by(func.date_format(Payment.paid_at, '%Y-%m')).all()
    rev_map = {r.m: float(r.s) for r in revenue_trend}
    revenue_series = []
    for i in range(12):
        d = (month_trend_start + timedelta(days=i * 30)).strftime('%Y-%m')
        revenue_series.append({"month": d, "amount": rev_map.get(d, 0)})

    return {
        "revenue": {
            "today": float(revenue_today),
            "week": float(revenue_week),
            "month": float(revenue_month),
            "year": float(revenue_year),
            "mrr": round(float(mrr), 2),
            "arr": round(float(arr), 2),
            "avg_revenue_per_user": round(float(avg_revenue_per_user), 2),
            "monthly_series": revenue_series,
        },
        "users": {
            "total": total_users,
            "paying": paying_users_count,
            "active_trials": active_trials,
            "expired_trials": expired_trials,
            "conversion_rate": round(float(conversion_rate), 4),
            "churned": churned_users,
            "new_users_series": new_users_series,
        },
        "subscriptions": {
            "active": active_count,
            "auto_renew_count": auto_renew_count,
            "auto_renew_rate": round(float(auto_renew_rate), 4),
            "plan_distribution": plan_count,
            "expiry_distribution": {
                "7d": exp_7,
                "30d": exp_30,
                "60d": exp_60,
                "90d": exp_90,
            },
            "renewals": {
                "total": total_renewals,
                "success": success_renewals,
                "failed": failed_renewals,
                "retrying": retrying_renewals,
                "success_rate": round(float(renewal_success_rate), 4),
            },
        },
    }
