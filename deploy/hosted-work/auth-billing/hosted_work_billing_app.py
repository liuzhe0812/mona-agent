"""Only the Work billing routes; the existing Auth process keeps its scheduler."""
from app.config import settings, validate_runtime_settings
from app.database import SessionLocal
from app.errors import AuthError, auth_error_handler
from app.routers.hosted_work_billing_router import router
from fastapi import FastAPI, HTTPException
from sqlalchemy import text

validate_runtime_settings()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_exception_handler(AuthError, auth_error_handler)
app.include_router(router)


@app.get("/_health")
def health():
    if len(settings.hosted_work_billing_secret) < 32:
        raise HTTPException(status_code=503, detail="Hosted billing is not configured")
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1 FROM hosted_work_charges LIMIT 1"))
    except Exception:
        raise HTTPException(status_code=503, detail="Hosted billing database unavailable") from None
    return {"status": "ready"}
