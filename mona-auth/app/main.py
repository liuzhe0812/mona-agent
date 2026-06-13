from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.errors import AuthError, auth_error_handler
from app.middleware import setup_rate_limit
from app.routers.admin_router import router as admin_router
from app.routers.auth_router import router as auth_router
from app.routers.config_router import router as config_router
from app.routers.device_router import router as device_router
from app.routers.notification_router import router as notification_router
from app.routers.payment_router import router as payment_router
from app.routers.trial_router import router as license_router

app = FastAPI(title="Mona Auth Service", version="0.2.0")

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
app.include_router(device_router)
app.include_router(payment_router)
app.include_router(license_router)
app.include_router(admin_router)

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
