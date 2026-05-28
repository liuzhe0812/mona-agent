from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.errors import AuthError, auth_error_handler
from app.middleware import setup_rate_limit
from app.routers.auth_router import router as auth_router
from app.routers.device_router import router as device_router
from app.routers.stripe_router import router as stripe_router

app = FastAPI(title="Mona Auth Service", version="0.1.0")

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
app.include_router(stripe_router)


@app.get("/health")
async def health():
    return {"status": "ok"}
