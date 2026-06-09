from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.errors import AuthError
from app.models import Subscription, SubscriptionStatus, User
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
