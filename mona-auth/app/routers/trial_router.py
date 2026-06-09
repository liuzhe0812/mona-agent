from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.middleware import limiter
from app.models import TrialActivation
from app.schemas import TrialActivateRequest, TrialActivateResponse

router = APIRouter(prefix="/trial", tags=["trial"])


@router.post("/activate", response_model=TrialActivateResponse)
@limiter.limit("10/minute")
def activate_trial(
    request: Request,
    body: TrialActivateRequest,
    db: Session = Depends(get_db),
):
    existing = (
        db.query(TrialActivation)
        .filter(TrialActivation.machine_fingerprint == body.machine_fingerprint)
        .first()
    )

    if existing:
        now = datetime.now(timezone.utc)
        active = existing.expires_at.tzinfo is not None and existing.expires_at > now
        if existing.expires_at.tzinfo is None:
            active = existing.expires_at.replace(tzinfo=timezone.utc) > now
        return TrialActivateResponse(active=active, expires_at=existing.expires_at)

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=settings.trial_days)

    record = TrialActivation(
        machine_fingerprint=body.machine_fingerprint,
        expires_at=expires_at,
    )
    db.add(record)
    db.commit()
    db.refresh(record)

    return TrialActivateResponse(active=True, expires_at=record.expires_at)
