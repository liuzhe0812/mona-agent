from fastapi import Request
from fastapi.responses import JSONResponse


class AuthError(Exception):
    def __init__(self, error: str, detail: str | None = None, status_code: int = 400):
        self.error = error
        self.detail = detail
        self.status_code = status_code


async def auth_error_handler(request: Request, exc: AuthError):
    body = {"error": exc.error}
    if exc.detail:
        body["detail"] = exc.detail
    return JSONResponse(status_code=exc.status_code, content=body)
