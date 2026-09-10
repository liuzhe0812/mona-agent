from fastapi import FastAPI, Request, Response
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)


def reset_limiter_state() -> None:
    """清空 rate limiter 计数器（测试用）"""
    storage = limiter._storage  # type: ignore[attr-defined]
    # MemoryStorage 的存储在 storage.storage 字典中
    if hasattr(storage, "storage") and isinstance(storage.storage, dict):
        storage.storage.clear()


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> Response:
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=429,
        content={"error": "rate_limit_exceeded", "detail": str(exc.detail)},
    )


def setup_rate_limit(app: FastAPI):
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    app.add_middleware(SlowAPIMiddleware)
