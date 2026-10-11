"""Ephemeral official login state; never part of project history or model input."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from uuid import uuid4

LoginState = Literal["starting", "waiting", "cancelling", "succeeded", "cancelled", "failed", "unknown"]
ACTIVE_LOGIN_STATES = frozenset({"starting", "waiting", "cancelling", "unknown"})
AUTH_FAILURE_REASONS = {
    "native_account_binding_failed": "无法保存本机账号连接，请检查 Mona 数据目录后重试。",
    "native_local_account_unavailable": "未找到可用的本机 Claude Code 账号，请先在本机 Claude Code 中登录。",
    "native_local_account_expired": "本机 Claude Code 登录已过期，请在本机 CLI 更新登录后重试。",
    "native_authentication_failed": "官方认证未确认成功，请核对当前连接后再操作。",
    "native_authentication_timeout": "等待官方授权超时，没有自动发起第二次登录。",
    "native_authentication_connection_lost": "官方认证连接已结束，结果未确认；请先核对连接。",
    "native_authentication_cleanup_failed": "认证资源尚未确认回收，暂不标记成功或重新登录。",
}
_REASONS = {
    "idle": "当前没有正在进行的登录。可以检查连接，或明确开始官方登录。",
    "starting": "正在建立官方登录流程。",
    "waiting": "请在官方页面完成登录；关闭设置页不会取消登录。",
    "cancelling": "已请求取消，正在等待原生认证流程结束。",
    "succeeded": "官方认证流程已完成。请检查连接；这不是开发任务验收。",
    "cancelled": "本次登录已取消，没有退出原有账户或停止开发任务。",
    "failed": "本次登录流程未确认完成，请检查连接或重新开始。",
    "unknown": "登录结果暂时无法确认；没有自动发起第二次登录。请核对连接。",
}


@dataclass
class NativeLogin:
    login_id: str = field(default_factory=lambda: "login_" + uuid4().hex)
    state: LoginState = "starting"
    native_id: str | None = field(default=None, repr=False)
    auth_url: str = field(default="", repr=False)
    error_code: str | None = field(default=None, repr=False)
    _early: dict[str, bool] = field(default_factory=dict, repr=False)

    def attach(self, native_id: str, auth_url: str) -> None:
        self.native_id, self.auth_url = native_id, auth_url
        if self.state == "starting":
            self.state = "waiting"
        outcome = self._early.get(native_id)
        self._early.clear()
        if outcome is not None:
            self.complete(outcome)

    def notify(self, native_id: object, success: object) -> None:
        if not isinstance(native_id, str) or not native_id or type(success) is not bool:
            return
        if self.native_id == native_id:
            self.complete(success)
        elif self.native_id is None and self.state == "starting" and len(self._early) < 8:
            self._early[native_id] = success

    def complete(self, success: bool, *, error_code: str | None = None) -> None:
        if self.state not in ACTIVE_LOGIN_STATES:
            return
        self.state = "succeeded" if success else "cancelled" if self.state == "cancelling" else "failed"
        self.error_code = error_code if self.state == "failed" and isinstance(error_code, str) and error_code in AUTH_FAILURE_REASONS else None
        self.auth_url = ""

    def disconnected(self) -> None:
        if self.state in ACTIVE_LOGIN_STATES:
            self.state = "unknown"
            self.auth_url = ""

    def public(self) -> dict:
        result = {"loginId": self.login_id, "state": self.state,
                  "authUrl": self.auth_url if self.state == "waiting" else "", "reason": _REASONS[self.state]}
        if self.error_code:
            result.update(errorCode=self.error_code, reason=AUTH_FAILURE_REASONS[self.error_code])
        return result


def idle_login() -> dict:
    return {"loginId": None, "state": "idle", "authUrl": "", "reason": _REASONS["idle"]}
