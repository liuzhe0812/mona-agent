"""Public Work requests contain no executable host settings or provider credentials."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

ID = re.compile(r"^[a-f0-9]{32}$")
TERMINAL = frozenset({"completed", "failed", "cancelled", "interrupted", "unknown"})


class WorkError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def identifier(value: str) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise WorkError("invalid_id", "记录标识无效。")
    return value


def owner_key(account_id: str) -> str:
    if not isinstance(account_id, str) or not account_id.isascii() or not account_id.isdigit() or int(account_id) <= 0:
        raise WorkError("invalid_identity", "登录身份无效，请重新登录。", 401)
    return hashlib.sha256(("mona-hosted-work-v1:" + str(int(account_id))).encode()).hexdigest()


def https_origin(value: str) -> str:
    try:
        parts = urlsplit(value)
        valid = (parts.scheme == "https" and parts.hostname and not parts.username
                 and not parts.password and parts.port in (None, 443)
                 and parts.path in ("", "/") and not parts.query and not parts.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("hosted service origins must be explicit HTTPS origins")
    return value.rstrip("/")


def private_directory(path: Path) -> Path:
    """Only the service calls this with an operator root and server-derived IDs."""
    if path.is_symlink():
        raise WorkError("invalid_state", "在线工作空间不可用。", 503)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)
    return path.resolve(strict=True)


class AccountLogin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    account: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=1024, repr=False)


class NewSession(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str
    title: str = Field(default="新任务", min_length=1, max_length=80)

    _id = field_validator("request_id")(identifier)


class NewTurn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str
    model_id: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=50000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=8)

    _id = field_validator("request_id")(identifier)

    @field_validator("attachment_ids")
    @classmethod
    def _attachments(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("duplicate attachment ids")
        return [identifier(value) for value in values]


class RunResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["completed", "failed", "cancelled", "unknown"]
    content: str = ""
    message: str = ""
    workspace_saved: bool = False
