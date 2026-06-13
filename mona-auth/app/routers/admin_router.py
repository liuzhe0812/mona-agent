from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.models import AppConfig, Notification, NotificationRead, PricingPlan, Subscription, SubscriptionStatus, User
from app.schemas import AdminTrialUpdateRequest, AdminUserInfo, AdminUserListResponse

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
        query = query.filter(User.email.contains(search))
    total = query.count()
    users = query.offset(offset).limit(page_size).all()

    result = []
    for u in users:
        sub = (
            db.query(Subscription)
            .filter(Subscription.user_id == u.id, Subscription.status == SubscriptionStatus.ACTIVE)
            .first()
        )
        result.append(
            AdminUserInfo(
                id=u.id,
                email=u.email,
                is_admin=u.is_admin,
                trial_started_at=u.trial_started_at,
                trial_expires_at=u.trial_expires_at,
                created_at=u.created_at,
                subscription_status=sub.status.value if sub else None,
                subscription_end=sub.current_period_end if sub else None,
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
            duration_months=p["duration_months"],
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
