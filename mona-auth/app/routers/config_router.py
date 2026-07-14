from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AppConfig, PricingPlan
from app.schemas import ContactConfig, PricingConfigResponse, PricingPlanInfo

router = APIRouter(prefix="/config", tags=["config"])


def _get_config_value(db: Session, key: str, default: str | None = None) -> str | None:
    row = db.query(AppConfig).filter(AppConfig.key == key).first()
    return row.value if row else default


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
                period_days=p.period_days,
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
    )
