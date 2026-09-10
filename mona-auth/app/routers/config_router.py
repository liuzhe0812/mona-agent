from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import AppConfig, PricingPlan
from app.plans import effective_plan_period_days
from app.schemas import ContactConfig, PricingConfigResponse, PricingPlanInfo, PromoTrialInfo

router = APIRouter(prefix="/config", tags=["config"])


def _catalog_file(path: str) -> FileResponse:
    catalog = Path(path)
    if not catalog.is_file():
        raise HTTPException(status_code=404, detail="Catalog is not published")
    return FileResponse(
        catalog,
        media_type="application/json",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/experts/catalog-v1.json", response_class=FileResponse)
def get_expert_catalog():
    return _catalog_file(settings.expert_catalog_path)


@router.get("/runtimes/catalog-v1.json", response_class=FileResponse)
def get_runtime_catalog():
    return _catalog_file(settings.runtime_catalog_path)


def _get_config_value(db: Session, key: str, default: str | None = None) -> str | None:
    row = db.query(AppConfig).filter(AppConfig.key == key).first()
    return row.value if row else default


def _get_active_promo_trial(db: Session) -> PromoTrialInfo | None:
    """Return promo trial info if the registration promo is currently active."""
    row = db.query(AppConfig).filter(AppConfig.key == "promo_trial_enabled").first()
    if not row or row.value != "true":
        return None

    days_row = db.query(AppConfig).filter(AppConfig.key == "promo_trial_days").first()
    if not days_row:
        return None
    try:
        days = int(days_row.value)
    except (ValueError, TypeError):
        return None
    if days <= 0:
        return None

    now = datetime.now(timezone.utc)

    def _parse_aware(value: str) -> datetime | None:
        try:
            dt = datetime.fromisoformat(value)
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt

    start_row = db.query(AppConfig).filter(AppConfig.key == "promo_trial_start_at").first()
    if start_row and start_row.value:
        start = _parse_aware(start_row.value)
        if start and now < start:
            return None

    end_at_str: str | None = None
    end_row = db.query(AppConfig).filter(AppConfig.key == "promo_trial_end_at").first()
    if end_row and end_row.value:
        end = _parse_aware(end_row.value)
        if end and now > end:
            return None
        end_at_str = end_row.value

    return PromoTrialInfo(enabled=True, days=days, end_at=end_at_str)


@router.get("/pricing", response_model=PricingConfigResponse)
def get_pricing_config(db: Session = Depends(get_db)):
    plans = (
        db.query(PricingPlan)
        .filter(PricingPlan.enabled == True)  # noqa: E712
        .order_by(PricingPlan.sort_order.asc())
        .all()
    )

    return PricingConfigResponse(
        plans=[
            PricingPlanInfo(
                id=p.id,
                name=p.name,
                price=float(p.price),
                duration_months=p.duration_months,
                period_days=effective_plan_period_days(p),
                auto_renewable=p.auto_renewable,
                original_price=float(p.original_price) if p.original_price else None,
                badge=p.badge,
            )
            for p in plans
        ],
        contact=ContactConfig(
            email=_get_config_value(db, "contact_email", "support@example.com") or "",
            wechat=_get_config_value(db, "contact_wechat", "") or "",
        ),
        promotional_banner=_get_config_value(db, "promotional_banner"),
        promo_trial=_get_active_promo_trial(db),
    )
