"""Explicit desktop GitHub Copilot device login and cancellation."""

from __future__ import annotations

import asyncio
from typing import Any

from mona.providers import github_copilot_provider as copilot

_MESSAGES = {
    "expired": "登录已过期，请重新登录。",
    "denied": "GitHub 授权被拒绝，请重新登录。",
    "invalid_response": "GitHub 返回的登录信息无效，请重试。",
    "failed": "GitHub 登录失败，请检查网络后重试。",
}


def github_copilot_authorized() -> bool:
    """Report whether a usable saved OAuth session exists, without exposing it."""
    return copilot.github_copilot_authorized()


class CopilotLoginSession:
    """Keep one cancellable attempt; stale attempts cannot persist a token."""

    def __init__(self) -> None:
        self._generation = 0
        self._task: asyncio.Task[None] | None = None
        self._status: dict[str, Any] = {"status": "idle"}

    def start(self) -> dict[str, Any]:
        self.cancel()
        generation = self._generation
        self._status = {"status": "starting"}
        self._task = asyncio.create_task(self._run(generation))
        return self.get_status()

    def cancel(self) -> dict[str, Any]:
        self._generation += 1
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None
        self._status = {"status": "idle"}
        return self.get_status()

    def get_status(self) -> dict[str, Any]:
        if self._status["status"] in {"idle", "authorized"}:
            return {"status": "authorized" if github_copilot_authorized() else "idle"}
        return dict(self._status)

    async def _run(self, generation: int) -> None:
        def on_device_code(user_code: str, verification_url: str) -> None:
            if generation == self._generation:
                self._status = {
                    "status": "waiting", "user_code": user_code, "verification_url": verification_url,
                }

        try:
            token = await copilot.request_github_copilot_token(on_device_code)
            if generation != self._generation:
                return
            # No await between checking ownership and the small local save: cancel
            # or a newer start cannot interleave after the check and before commit.
            copilot.get_storage().save(token)
            self._status = {"status": "authorized"}
        except asyncio.CancelledError:
            return
        except copilot.CopilotDeviceLoginError as exc:
            if generation == self._generation:
                self._status = {"status": "failed", "message": _MESSAGES.get(exc.reason, _MESSAGES["failed"])}
        except Exception:
            if generation == self._generation:
                self._status = {"status": "failed", "message": _MESSAGES["failed"]}
