"""自动续费定时任务

使用 APScheduler 后台调度：
- 每小时执行扣款任务（到期前 3 天的订阅）
- 每小时执行重试任务（next_retry_at 到期的 retrying 记录）
- 每天凌晨执行扣款前通知（提前 3 天、1 天）
- 每天凌晨执行订阅过期处理
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.orm import Session

from app.alipay import alipay_service
from app.credits import (
    active_request_counter_snapshot,
    reconcile_wallets,
    recover_stale_requests,
)
from app.database import SessionLocal
from app.email import send_email
from app.media_generation import poll_pending_media_requests
from app.models import (
    AgreementStatus,
    ModelRequest,
    ModelRequestStatus,
    Notification,
    Payment,
    PaymentStatus,
    PricingPlan,
    RenewalStatus,
    Subscription,
    SubscriptionRenewal,
    SubscriptionStatus,
    User,
)
from app.plans import effective_plan_period_days

logger = logging.getLogger(__name__)

# 续费扣款重试上限
MAX_RENEWAL_RETRY = 3
# 提前扣款天数
PRE_DEDUCT_DAYS = 3

_scheduler: BackgroundScheduler | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ── 扣款任务 ──


def auto_deduct_job() -> None:
    """扫描到期前 PRE_DEDUCT_DAYS 天的订阅，发起周期扣款"""
    if not alipay_service.enabled:
        return
    db = SessionLocal()
    try:
        now = _now()
        due_subs = (
            db.query(Subscription)
            .filter(
                Subscription.auto_renew == True,  # noqa: E712
                Subscription.status == SubscriptionStatus.ACTIVE,
                Subscription.current_period_end <= now + timedelta(days=PRE_DEDUCT_DAYS),
            )
            .all()
        )
        for sub in due_subs:
            try:
                _process_subscription_deduction(db, sub, now)
            except Exception:
                logger.exception("Failed to process deduction for subscription %s", sub.id)
    finally:
        db.close()


def _process_subscription_deduction(db: Session, sub: Subscription, now: datetime) -> None:
    """处理单个订阅的续费扣款"""
    if not sub.agreement or sub.agreement.status != AgreementStatus.ACTIVE:
        logger.warning("Subscription %s has no active agreement, marking auto_renew=False", sub.id)
        sub.auto_renew = False
        db.commit()
        _create_subscription_notification(
            db,
            sub.user_id,
            "协议已失效",
            "您的自动续费协议已失效，订阅到期后请手动续费。",
        )
        return

    plan = (
        db.query(PricingPlan).filter(PricingPlan.id == sub.plan_code).first()
        if sub.plan_code
        else None
    )
    if not plan:
        logger.warning("Subscription %s has no plan_code or plan not found", sub.id)
        return

    # 检查是否已有该周期的续费记录（防重复）
    end = _to_utc(sub.current_period_end) or now
    existing = (
        db.query(SubscriptionRenewal)
        .filter(
            SubscriptionRenewal.subscription_id == sub.id,
            SubscriptionRenewal.created_at >= end - timedelta(days=PRE_DEDUCT_DAYS + 1),
        )
        .first()
    )
    if existing and existing.status in (
        RenewalStatus.PENDING,
        RenewalStatus.SUCCESS,
        RenewalStatus.RETRYING,
    ):
        return  # 本周期已发起扣款

    out_trade_no = f"recur_{sub.id}_{int(time.time())}_{uuid.uuid4().hex[:4]}"
    renewal = SubscriptionRenewal(
        subscription_id=sub.id,
        agreement_no=sub.agreement.agreement_no,
        out_trade_no=out_trade_no,
        amount=float(plan.price),
        period_days=effective_plan_period_days(plan),
        status=RenewalStatus.PENDING,
    )
    db.add(renewal)
    db.commit()
    db.refresh(renewal)

    # 调用支付宝扣款
    result = alipay_service.periodic_deduct(
        agreement_no=sub.agreement.agreement_no,
        out_trade_no=out_trade_no,
        total_amount=float(plan.price),
        subject=f"Mona Pro {plan.name} 续费",
    )

    if result.success:
        renewal.status = RenewalStatus.SUCCESS
        renewal.alipay_trade_no = result.trade_no
        renewal.paid_at = _now()
        # 延长订阅
        if sub.current_period_end:
            cur_end = _to_utc(sub.current_period_end) or _now()
            if cur_end > _now():
                sub.current_period_end = cur_end + timedelta(days=renewal.period_days)
            else:
                sub.current_period_end = _now() + timedelta(days=renewal.period_days)
                sub.status = SubscriptionStatus.ACTIVE
        else:
            sub.current_period_end = _now() + timedelta(days=renewal.period_days)
            sub.status = SubscriptionStatus.ACTIVE
        db.commit()
        logger.info(
            "Renewal success for subscription %s, extended to %s", sub.id, sub.current_period_end
        )
    else:
        _handle_deduction_failure(db, sub, renewal, result.error)


def _handle_deduction_failure(
    db: Session,
    sub: Subscription,
    renewal: SubscriptionRenewal,
    error: str | None,
) -> None:
    """处理扣款失败"""
    renewal.failure_reason = error
    renewal.retry_count += 1

    if renewal.retry_count >= MAX_RENEWAL_RETRY:
        # 重试上限，停止重试
        renewal.status = RenewalStatus.FAILED
        renewal.next_retry_at = None
        sub.auto_renew = False
        db.commit()
        _create_subscription_notification(
            db,
            sub.user_id,
            "自动续费扣款失败",
            f"您的订阅自动续费已连续失败 {MAX_RENEWAL_RETRY} 次，自动续费已关闭。"
            f"请在订阅到期前手动续费，避免服务中断。",
        )
        _send_renewal_failure_email(db, sub, error)
    else:
        # 安排重试（24 小时后）
        renewal.status = RenewalStatus.RETRYING
        renewal.next_retry_at = _now() + timedelta(hours=24)
        db.commit()
        if renewal.retry_count == 1:
            # 第一次失败发邮件
            _send_renewal_failure_email(db, sub, error)


def _send_renewal_failure_email(db: Session, sub: Subscription, error: str | None) -> None:
    """发送扣款失败邮件"""
    user = db.query(User).filter(User.id == sub.user_id).first()
    if not user:
        return
    try:
        end = _to_utc(sub.current_period_end)
        end_str = end.strftime("%Y-%m-%d") if end else "未知"
        send_email(
            user.email,
            subject="Mona Pro 续费扣款失败提醒",
            body=f"""
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
                <h2>续费扣款失败</h2>
                <p>您的 Mona Pro 订阅在自动续费时扣款失败。</p>
                <p>失败原因：{error or "未知"}</p>
                <p>当前订阅到期时间：{end_str}</p>
                <p>系统将在 24 小时后重试，如余额不足请及时充值。</p>
                <p>如需手动续费或关闭自动续费，请打开 Mona 客户端操作。</p>
            </div>
            """,
        )
    except Exception:
        logger.exception("Failed to send renewal failure email to %s", user.email)


# ── 重试任务 ──


def retry_failed_deductions_job() -> None:
    """重试 RETRYING 状态的续费记录"""
    if not alipay_service.enabled:
        return
    db = SessionLocal()
    try:
        now = _now()
        pending = (
            db.query(SubscriptionRenewal)
            .filter(
                SubscriptionRenewal.status == RenewalStatus.RETRYING,
                SubscriptionRenewal.next_retry_at <= now,
            )
            .all()
        )
        for renewal in pending:
            try:
                _retry_single_deduction(db, renewal)
            except Exception:
                logger.exception("Retry failed for renewal %s", renewal.id)
    finally:
        db.close()


def _retry_single_deduction(db: Session, renewal: SubscriptionRenewal) -> None:
    sub = renewal.subscription
    if not sub or not sub.agreement:
        renewal.status = RenewalStatus.FAILED
        db.commit()
        return

    plan = (
        db.query(PricingPlan).filter(PricingPlan.id == sub.plan_code).first()
        if sub.plan_code
        else None
    )
    if not plan:
        renewal.status = RenewalStatus.FAILED
        db.commit()
        return

    result = alipay_service.periodic_deduct(
        agreement_no=sub.agreement.agreement_no,
        out_trade_no=renewal.out_trade_no,
        total_amount=float(renewal.amount),
        subject=f"Mona Pro {plan.name} 续费（重试 {renewal.retry_count}）",
    )

    if result.success:
        renewal.status = RenewalStatus.SUCCESS
        renewal.alipay_trade_no = result.trade_no
        renewal.paid_at = _now()
        renewal.next_retry_at = None
        # 延长订阅
        if sub.current_period_end:
            cur_end = _to_utc(sub.current_period_end) or _now()
            if cur_end > _now():
                sub.current_period_end = cur_end + timedelta(days=renewal.period_days)
            else:
                sub.current_period_end = _now() + timedelta(days=renewal.period_days)
                sub.status = SubscriptionStatus.ACTIVE
        db.commit()
    else:
        _handle_deduction_failure(db, sub, renewal, result.error)


# ── 扣款前通知任务 ──


def pre_deduct_notify_job() -> None:
    """扫描 3 天内到期且开启自动续费的订阅，发送扣款前通知（仅 3 天和 1 天时点）"""
    db = SessionLocal()
    try:
        now = _now()
        due_subs = (
            db.query(Subscription)
            .filter(
                Subscription.auto_renew == True,  # noqa: E712
                Subscription.status == SubscriptionStatus.ACTIVE,
                Subscription.current_period_end > now,
                Subscription.current_period_end <= now + timedelta(days=PRE_DEDUCT_DAYS),
            )
            .all()
        )
        for sub in due_subs:
            end = _to_utc(sub.current_period_end)
            if not end:
                continue
            days_left = (end - now).days
            if days_left in (PRE_DEDUCT_DAYS, 1):
                _send_pre_deduct_notification(db, sub, days_left)
    finally:
        db.close()


def _send_pre_deduct_notification(db: Session, sub: Subscription, days_left: int) -> None:
    user = db.query(User).filter(User.id == sub.user_id).first()
    if not user:
        return
    plan = (
        db.query(PricingPlan).filter(PricingPlan.id == sub.plan_code).first()
        if sub.plan_code
        else None
    )
    if not plan:
        return
    try:
        end = _to_utc(sub.current_period_end)
        end_str = end.strftime("%Y-%m-%d") if end else "未知"
        send_email(
            user.email,
            subject=f"Mona Pro 会员将于 {days_left} 天后自动续费",
            body=f"""
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
                <h2>自动续费提醒</h2>
                <p>您的 Mona Pro {plan.name} 将于 {days_left} 天后自动续费。</p>
                <p>续费金额：¥{plan.price:.2f}</p>
                <p>扣款时间：{end_str}</p>
                <p>如需取消自动续费，请在 Mona 客户端的"订阅管理"中关闭。</p>
            </div>
            """,
        )
    except Exception:
        logger.exception("Failed to send pre-deduct notification to %s", user.email)


# ── 订阅过期处理任务 ──


def expire_subscriptions_job() -> None:
    """标记已过期的订阅为 expired"""
    db = SessionLocal()
    try:
        now = _now()
        expired = (
            db.query(Subscription)
            .filter(
                Subscription.status == SubscriptionStatus.ACTIVE,
                Subscription.current_period_end < now,
            )
            .all()
        )
        for sub in expired:
            sub.status = SubscriptionStatus.EXPIRED
            _create_subscription_notification(
                db,
                sub.user_id,
                "订阅已过期",
                "您的 Mona Pro 订阅已过期，部分功能将受限。请续费后继续使用。",
            )
        db.commit()
        if expired:
            logger.info("Marked %d subscriptions as expired", len(expired))
    finally:
        db.close()


def recover_model_requests_job() -> None:
    db = SessionLocal()
    try:
        result = recover_stale_requests(db)
        db.commit()
        if result["released"] or result["uncertain"]:
            logger.warning("Recovered stale model requests: %s", result)
    except Exception:
        db.rollback()
        logger.exception("Model request recovery failed")
    finally:
        db.close()


def poll_media_requests_job() -> None:
    try:
        completed = poll_pending_media_requests()
        if completed:
            logger.info("Completed %d managed media requests", completed)
    except Exception:
        logger.exception("Managed media request polling failed")


def sync_pending_payments_job() -> None:
    if not alipay_service.enabled:
        return
    from app.routers.subscribe_router import sync_payment_status

    db = SessionLocal()
    try:
        pending = (
            db.query(Payment)
            .filter(
                Payment.payment_channel == "alipay",
                Payment.status.in_([PaymentStatus.PENDING, PaymentStatus.PAID]),
                Payment.fulfillment_status != "succeeded",
                Payment.created_at >= _now() - timedelta(days=7),
            )
            .order_by(Payment.created_at)
            .limit(50)
            .all()
        )
        for payment in pending:
            payment_id = payment.id
            try:
                sync_payment_status(db, payment)
            except Exception:
                db.rollback()
                logger.exception("Payment reconciliation failed for order %s", payment_id)
    except Exception:
        db.rollback()
        logger.exception("Pending payment reconciliation failed")
    finally:
        db.close()


def credit_reconciliation_job() -> None:
    db = SessionLocal()
    try:
        differences = reconcile_wallets(db)
        if differences:
            logger.critical("Credit wallet reconciliation found %d differences", len(differences))
        capacity = active_request_counter_snapshot(db)
        if not capacity["ok"]:
            logger.critical("Model request capacity counters differ: %s", capacity)
        uncertain = (
            db.query(ModelRequest)
            .filter(ModelRequest.status == ModelRequestStatus.UNCERTAIN)
            .count()
        )
        if uncertain:
            logger.critical("Credit reconciliation found %d uncertain model requests", uncertain)
        unfulfilled = (
            db.query(Payment)
            .filter(
                Payment.product_type == "credit_topup",
                Payment.status == PaymentStatus.PAID,
                Payment.fulfillment_status != "succeeded",
            )
            .count()
        )
        if unfulfilled:
            logger.critical("Credit reconciliation found %d paid unfulfilled orders", unfulfilled)
    except Exception:
        logger.exception("Credit wallet reconciliation failed")
    finally:
        db.close()


# ── 通知创建 ──


def _create_subscription_notification(
    db: Session,
    user_id: int,
    title: str,
    body: str,
) -> None:
    """创建订阅相关站内通知（user_id 不存在则跳过 user 关联，仅作展示）"""
    notif = Notification(
        title=title,
        body=body,
        type="subscription",
        action_url="subscribe",
        published=True,
        published_at=_now(),
    )
    db.add(notif)
    db.commit()


# ── 启动调度器 ──


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone="UTC")

    # 每小时执行扣款任务
    _scheduler.add_job(
        auto_deduct_job,
        trigger=IntervalTrigger(hours=1),
        id="auto_deduct",
        replace_existing=True,
        next_run_time=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    # 每小时执行重试任务
    _scheduler.add_job(
        retry_failed_deductions_job,
        trigger=IntervalTrigger(hours=1),
        id="retry_deductions",
        replace_existing=True,
        next_run_time=datetime.now(timezone.utc) + timedelta(minutes=10),
    )

    # 每天凌晨 2 点执行扣款前通知
    _scheduler.add_job(
        pre_deduct_notify_job,
        trigger=CronTrigger(hour=2, minute=0),
        id="pre_deduct_notify",
        replace_existing=True,
    )

    # 每天凌晨 3 点执行订阅过期处理
    _scheduler.add_job(
        expire_subscriptions_job,
        trigger=CronTrigger(hour=3, minute=0),
        id="expire_subscriptions",
        replace_existing=True,
    )

    _scheduler.add_job(
        recover_model_requests_job,
        trigger=IntervalTrigger(minutes=1),
        id="recover_model_requests",
        replace_existing=True,
    )

    _scheduler.add_job(
        poll_media_requests_job,
        trigger=IntervalTrigger(seconds=10),
        id="poll_media_requests",
        replace_existing=True,
        max_instances=1,
    )

    _scheduler.add_job(
        sync_pending_payments_job,
        trigger=IntervalTrigger(minutes=2),
        id="sync_pending_payments",
        replace_existing=True,
    )

    _scheduler.add_job(
        credit_reconciliation_job,
        trigger=CronTrigger(hour=4, minute=0),
        id="credit_reconciliation",
        replace_existing=True,
    )

    _scheduler.start()
    logger.info("Scheduler started with subscription, payment, and credit recovery jobs")


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
