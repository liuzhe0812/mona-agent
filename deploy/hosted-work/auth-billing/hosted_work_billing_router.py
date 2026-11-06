"""Internal-only authenticated Hosted Work billing protocol."""
import hmac
import json
import re
from decimal import Decimal
from typing import Literal

import httpx
from app.auth import decode_access_token
from app.config import settings
from app.database import get_db
from app.deps import bearer_scheme
from app.hosted_work_billing import (
    _get_charge,
    dispatch,
    mark_uncertain,
    release,
    reserve,
    settle,
    view,
)
from app.models import User
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.orm import Session


def require_hosted_work_key(key: str | None = Header(default=None, alias="X-Hosted-Work-Key")):
    configured = settings.hosted_work_billing_secret
    if len(configured) < 32:
        raise HTTPException(status_code=503, detail="Hosted billing is not configured")
    if key is None or not hmac.compare_digest(key.encode("utf-8"), configured.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Hosted billing authentication required")


def website_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
                 db: Session = Depends(get_db)) -> User:
    claims = decode_access_token(credentials.credentials)
    if (claims is None or not isinstance(claims.get("wsid"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", claims["wsid"])
            or "sid" in claims or "dv" in claims
            or not isinstance(claims.get("sub"), str)
            or not re.fullmatch(r"[1-9][0-9]{0,18}", claims["sub"])
            or int(claims["sub"]) > 9_223_372_036_854_775_807):
        raise HTTPException(status_code=401, detail="Website session required")

    # Only the original Auth process knows its live website-login switch. It
    # checks the website session, revocation and current credential version.
    try:
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=2.0) as client:
            with client.stream(
                "GET", "http://127.0.0.1:8000/auth/identity",
                headers={"Host": "mona-ai.cn", "Authorization": "Bearer " + credentials.credentials},
            ) as response:
                if response.status_code in (401, 403):
                    raise HTTPException(status_code=401, detail="Website session invalid")
                if response.status_code != 200:
                    raise HTTPException(status_code=503, detail="Account verification unavailable")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 4096:
                        raise HTTPException(status_code=503, detail="Account verification unavailable")
        identity = json.loads(body)
    except (httpx.HTTPError, ValueError):
        raise HTTPException(status_code=503, detail="Account verification unavailable") from None
    if not isinstance(identity, dict) or identity.get("account_id") != claims["sub"]:
        raise HTTPException(status_code=401, detail="Account identity mismatch")
    user = db.query(User).filter(User.id == int(claims["sub"])).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Account identity mismatch")
    return user


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Price(Contract):
    input_amount_per_million: str
    cached_input_amount_per_million: str
    output_amount_per_million: str

    @field_validator("input_amount_per_million", "cached_input_amount_per_million", "output_amount_per_million")
    @classmethod
    def valid_price(cls, value: str) -> str:
        if not re.fullmatch(r"(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?", value):
            raise ValueError("Price must be a nonnegative decimal string with at most six decimals")
        number = Decimal(value)
        if number > 1_000_000_000:
            raise ValueError("Price exceeds the allowed maximum")
        return format(number.normalize(), "f")


class Reserve(Contract):
    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    model: str = Field(min_length=1, max_length=200)
    reserve_units: int = Field(ge=0, le=9_223_372_036_854_775_807)
    price: Price

    @field_validator("model")
    @classmethod
    def valid_model(cls, value: str) -> str:
        if value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Invalid model identifier")
        return value

    @model_validator(mode="after")
    def positive_reserve_for_paid(self):
        if self.reserve_units == 0 and any(Decimal(x) > 0 for x in self.price.model_dump().values()):
            raise ValueError("A paid model requires a positive reserve")
        return self


class Usage(Contract):
    input_tokens: int = Field(ge=0, le=1_000_000_000)
    cached_input_tokens: int = Field(ge=0, le=1_000_000_000)
    output_tokens: int = Field(ge=0, le=1_000_000_000)

    @model_validator(mode="after")
    def cached_is_included_in_input(self):
        if self.cached_input_tokens > self.input_tokens:
            raise ValueError("Cached input exceeds total input")
        return self


class Settlement(Contract):
    usage: Usage


class Uncertain(Contract):
    reason: Literal["usage_unavailable", "provider_outcome_unknown", "interrupted"]


router = APIRouter(prefix="/auth/internal/hosted-work/billing", dependencies=[Depends(require_hosted_work_key)])


@router.post("/reserve")
def reserve_route(payload: Reserve, user: User = Depends(website_user), db: Session = Depends(get_db)):
    return view(reserve(db, run_id=payload.run_id, user_id=user.id, model=payload.model,
                        price=payload.price.model_dump(), reserved=payload.reserve_units))


@router.get("/{run_id}")
def get_route(run_id: str, db: Session = Depends(get_db)):
    return view(_get_charge(db, run_id))


@router.post("/{run_id}/dispatch")
def dispatch_route(run_id: str, db: Session = Depends(get_db)):
    return view(dispatch(db, run_id))


@router.post("/{run_id}/release")
def release_route(run_id: str, db: Session = Depends(get_db)):
    return view(release(db, run_id))


@router.post("/{run_id}/uncertain")
def uncertain_route(run_id: str, payload: Uncertain, db: Session = Depends(get_db)):
    return view(mark_uncertain(db, run_id, payload.reason))


@router.post("/{run_id}/settle")
def settle_route(run_id: str, payload: Settlement, db: Session = Depends(get_db)):
    return view(settle(db, run_id, payload.usage.model_dump()))
