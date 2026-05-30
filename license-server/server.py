import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel, Field

PRIVATE_KEY_PATH = Path(__file__).parent / "keys" / "private.pem"
PUBLIC_KEY_PATH = Path(__file__).parent / "keys" / "public.pem"

ADMIN_PASSWORD = "changeme123"

LICENSE_DURATION_DAYS = {
    "monthly": 31,
    "yearly": 366,
}

app = FastAPI(title="Mona License Server")


class IssueRequest(BaseModel):
    machine_id: str = Field(min_length=8, max_length=128)
    password: str
    duration: str = Field(default="yearly", pattern=r"^(monthly|yearly)$")


def _issue_license(machine_id: str, duration: str) -> str:
    private_key = PRIVATE_KEY_PATH.read_text()
    now = datetime.now(timezone.utc)
    days = LICENSE_DURATION_DAYS.get(duration, 366)
    exp = now + timedelta(days=days)

    fp_hash = hashlib.sha256(machine_id.encode()).hexdigest()

    payload = {
        "sub": "user_id:0",
        "fp": fp_hash,
        "plan": "pro",
        "exp": exp,
        "iat": now,
        "jti": uuid.uuid4().hex,
    }

    return jwt.encode(payload, private_key, algorithm="RS256")


@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = Path(__file__).parent / "index.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.post("/api/issue")
async def issue_license(body: IssueRequest):
    if body.password != ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="密码错误")

    if not PRIVATE_KEY_PATH.exists():
        raise HTTPException(status_code=500, detail="私钥文件不存在，请先运行 python generate_keys.py")

    license_jwt = _issue_license(body.machine_id, body.duration)

    return PlainTextResponse(
        content=license_jwt,
        media_type="text/plain",
        headers={"Content-Disposition": 'attachment; filename="mona-license.jwt"'},
    )


@app.get("/health")
async def health():
    return {"status": "ok", "public_key_exists": PUBLIC_KEY_PATH.exists()}
