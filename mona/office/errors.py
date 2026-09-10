"""Stable errors shared by Mona Office service boundaries."""

from __future__ import annotations

from enum import StrEnum


class OfficeErrorCode(StrEnum):
    SESSION_NOT_FOUND = "SESSION_NOT_FOUND"
    EDITOR_UNAVAILABLE = "EDITOR_UNAVAILABLE"
    VERSION_CONFLICT = "VERSION_CONFLICT"
    RESYNC_REQUIRED = "RESYNC_REQUIRED"
    INVALID_OPERATION = "INVALID_OPERATION"
    CHECKPOINT_FAILED = "CHECKPOINT_FAILED"
    SAVE_CONFLICT = "SAVE_CONFLICT"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"


class OfficeError(Exception):
    def __init__(
        self,
        code: OfficeErrorCode,
        message: str,
        *,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
