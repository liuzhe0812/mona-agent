from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import Notification, NotificationRead, User
from app.schemas import NotificationListResponse, NotificationInfo, UnreadCountResponse

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    notifications = (
        db.query(Notification)
        .filter(Notification.published == True)  # noqa: E712
        .filter((Notification.expires_at == None) | (Notification.expires_at > now))  # noqa: E711
        .order_by(Notification.published_at.desc().nullslast())
        .all()
    )

    read_ids = {
        row.notification_id
        for row in db.query(NotificationRead)
        .filter(NotificationRead.user_id == user.id)
        .all()
    }

    return NotificationListResponse(
        notifications=[
            NotificationInfo(
                id=n.id,
                title=n.title,
                body=n.body,
                type=n.type,
                action_url=n.action_url,
                image_url=n.image_url,
                read=n.id in read_ids,
                published_at=n.published_at,
                expires_at=n.expires_at,
            )
            for n in notifications
        ]
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_count(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    total = (
        db.query(Notification)
        .filter(Notification.published == True)  # noqa: E712
        .filter((Notification.expires_at == None) | (Notification.expires_at > now))  # noqa: E711
        .count()
    )
    read = db.query(NotificationRead).filter(NotificationRead.user_id == user.id).count()
    return UnreadCountResponse(unread_count=max(0, total - read))


@router.post("/{notification_id}/read")
def mark_read(
    notification_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    existing = (
        db.query(NotificationRead)
        .filter(
            NotificationRead.user_id == user.id,
            NotificationRead.notification_id == notification_id,
        )
        .first()
    )
    if not existing:
        db.add(
            NotificationRead(
                user_id=user.id,
                notification_id=notification_id,
            )
        )
        db.commit()
    return {"success": True}
