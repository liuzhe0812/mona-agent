from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.alipay import alipay_service
from app.config import settings, validate_runtime_settings
from app.database import get_db
from app.errors import AuthError, auth_error_handler
from app.feature_flags import feature_flag_snapshot
from app.media_generation import ensure_active_media_channels
from app.middleware import setup_rate_limit
from app.routers.admin_credits_router import router as admin_credits_router
from app.routers.admin_gateway_router import router as admin_gateway_router
from app.routers.admin_router import router as admin_router
from app.routers.auth_router import router as auth_router
from app.routers.config_router import router as config_router
from app.routers.credits_router import router as credits_router
from app.routers.device_router import router as device_router
from app.routers.model_access_router import proxy_router, token_router
from app.routers.notification_router import router as notification_router
from app.routers.payment_router import router as payment_router
from app.routers.subscribe_router import router as subscribe_router
from app.routers.trial_router import router as license_router
from app.routers.upload_router import router as upload_router
from app.routers.worker_router import router as worker_router
from app.scheduler import shutdown_scheduler, start_scheduler

validate_runtime_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    start_scheduler()
    try:
        yield
    finally:
        shutdown_scheduler()


app = FastAPI(title="Mona Auth Service", version="0.4.0", lifespan=lifespan)

app.add_exception_handler(AuthError, auth_error_handler)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

setup_rate_limit(app)

app.include_router(auth_router)
app.include_router(config_router)
app.include_router(credits_router)
app.include_router(token_router)
app.include_router(proxy_router)
app.include_router(device_router)
app.include_router(payment_router)
app.include_router(subscribe_router)
app.include_router(license_router)
app.include_router(admin_router)
app.include_router(admin_credits_router)
app.include_router(admin_gateway_router)
app.include_router(notification_router)
app.include_router(upload_router)
app.include_router(worker_router)

# Admin SPA - serve static files
_admin_dir = Path(__file__).parent / "admin"
if _admin_dir.exists():
    _assets_dir = _admin_dir / "assets"
    if _assets_dir.exists():
        app.mount("/admin/assets", StaticFiles(directory=_assets_dir), name="admin-assets")

    @app.get("/admin/{full_path:path}")
    async def admin_spa(full_path: str):
        file_path = _admin_dir / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_admin_dir / "index.html")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/ready")
def ready(db: Session = Depends(get_db)):
    db.execute(text("SELECT 1"))
    db.execute(text("SELECT 1 FROM credit_wallets LIMIT 1"))
    db.execute(text("SELECT 1 FROM model_gateway_locks LIMIT 1"))
    db.execute(text("SELECT billing_type, rates_json FROM model_prices LIMIT 1"))
    db.execute(text("SELECT 1 FROM worker_attachments LIMIT 1"))
    db.execute(text("SELECT 1 FROM worker_jobs LIMIT 1"))
    db.execute(
        text(
            "SELECT billing_type, request_hash, usage_json, result_json "
            "FROM model_requests LIMIT 1"
        )
    )
    flags = feature_flag_snapshot(db)
    if flags["balance_recharge_enabled"] and not alipay_service.enabled:
        raise HTTPException(status_code=503, detail="Payment dependency is unavailable")
    if flags["managed_model_enabled"]:
        try:
            ensure_active_media_channels(db)
        except AuthError as exc:
            raise HTTPException(
                status_code=503,
                detail="Managed media dependency is unavailable",
            ) from exc
        try:
            response = httpx.get(
                f"{settings.one_api_base_url.rstrip('/')}{settings.one_api_health_path}",
                timeout=2,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=503,
                detail="Managed model dependency is unavailable",
            ) from exc
    return {
        "status": "ready",
        "model_access_enabled": flags["managed_model_enabled"],
        "credit_payments_enabled": flags["balance_recharge_enabled"],
    }


