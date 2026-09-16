"""WeChat (微信) QR-code login session for the WebUI.

Wraps the blocking ``WeixinChannel._qr_login()`` loop into a non-blocking
state machine that the WebUI can poll. A single session lives on the
WebsocketChannel instance (process-local singleton).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal

import httpx
from loguru import logger

from mona.channels.weixin import (
    ILINK_APP_CLIENT_VERSION,
    ILINK_APP_ID,
    MAX_QR_REFRESH_COUNT,
    WeixinConfig,
)

# Login session states exposed to the WebUI.
LoginState = Literal[
    "idle",
    "fetching_qr",
    "awaiting_scan",
    "confirmed",
    "expired",
    "failed",
    "cancelled",
]

# Status returned by WeChat's get_qrcode_status endpoint.
_QR_STATUS_CONFIRMED = "confirmed"
_QR_STATUS_EXPIRED = "expired"
_QR_STATUS_SCANNED_REDIRECT = "scaned_but_redirect"
_QR_STATUS_WAIT = "wait"

_QR_POLL_INTERVAL_S = 1.0
_QR_FETCH_TIMEOUT_S = 30.0


def _render_qr_svg(scan_url: str) -> str:
    """Render *scan_url* as an inline SVG string.

    Falls back to a tiny SVG that just shows the URL text when the optional
    ``qrcode`` package is unavailable.
    """
    try:
        import qrcode
        import qrcode.image.svg

        # SvgPathImage emits a single <path> instead of hundreds of <rect>
        # elements and — crucially — avoids the ``svg:`` namespace prefixes
        # that break rendering when the SVG is injected via innerHTML in the
        # browser (the HTML parser does not honour XML namespace prefixes).
        qr = qrcode.QRCode(border=1, image_factory=qrcode.image.svg.SvgPathImage)
        qr.add_data(scan_url)
        qr.make(fit=True)
        img = qr.make_image()
        return img.to_string().decode("utf-8")
    except Exception as e:  # pragma: no cover - optional dependency
        logger.warning("qrcode SVG render failed, falling back to text: {}", e)
        # Escape minimal XML chars so the URL renders safely.
        escaped = (
            scan_url.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60">'
            f'<text x="4" y="20" font-family="monospace" font-size="10">{escaped}</text>'
            f"</svg>"
        )


class WeixinLoginSession:
    """Non-blocking QR login state machine.

    Lifecycle::

        start() -> background task fetches QR + polls status
        get_status() -> {state, qr_svg?, error?}
        cancel() -> stop the background task

    A session is single-use; call ``reset()`` before starting a new one.
    """

    def __init__(self, config: WeixinConfig) -> None:
        self._config: WeixinConfig = config.model_copy(deep=True)
        self._state: LoginState = "idle"
        self._qr_svg: str = ""
        self._error: str = ""
        self._task: asyncio.Task[None] | None = None
        self._client: httpx.AsyncClient | None = None
        self._stop_event = asyncio.Event()

    @property
    def state(self) -> LoginState:
        return self._state

    @property
    def error(self) -> str:
        return self._error

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    def get_status(self) -> dict[str, Any]:
        """Return a JSON-serialisable status snapshot for the WebUI."""
        payload: dict[str, Any] = {"state": self._state}
        if self._qr_svg and self._state == "awaiting_scan":
            payload["qr_svg"] = self._qr_svg
        if self._error and self._state in {"failed", "expired"}:
            payload["error"] = self._error
        return payload

    def start(self) -> None:
        """Start the login flow in the background. No-op if already running."""
        if self.is_running:
            return
        self._reset_state()
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run())

    async def cancel(self) -> None:
        """Cancel the in-flight login flow."""
        self._cancel_sync()
        # Close the client asynchronously if we have a running loop.
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass

    def _cancel_sync(self) -> None:
        """Synchronously mark the session as cancelled (safe from sync handlers)."""
        self._stop_event.set()
        task = self._task
        if task and not task.done():
            task.cancel()
        self._task = None
        if self._state not in {"confirmed", "failed", "expired", "cancelled"}:
            self._state = "cancelled"

    def _reset_state(self) -> None:
        self._state = "fetching_qr"
        self._qr_svg = ""
        self._error = ""

    async def _close_client(self) -> None:
        client = self._client
        self._client = None
        if client is not None:
            try:
                await client.aclose()
            except Exception:
                pass

    async def _run(self) -> None:
        try:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(_QR_FETCH_TIMEOUT_S, connect=30),
                follow_redirects=True,
            )
            await self._login_loop()
        except asyncio.CancelledError:
            if self._state not in {"confirmed", "failed", "expired"}:
                self._state = "cancelled"
            raise
        except Exception as e:
            logger.exception("WeChat login session failed")
            self._state = "failed"
            self._error = str(e) or e.__class__.__name__
        finally:
            await self._close_client()

    async def _login_loop(self) -> None:
        refresh_count = 0
        qrcode_id, scan_url = await self._fetch_qr_code()
        self._qr_svg = _render_qr_svg(scan_url)
        self._state = "awaiting_scan"

        current_poll_base_url = self._config.base_url

        while not self._stop_event.is_set():
            try:
                status_data = await self._api_get_with_base(
                    base_url=current_poll_base_url,
                    endpoint="ilink/bot/get_qrcode_status",
                    params={"qrcode": qrcode_id},
                    auth=False,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._is_retryable_qr_poll_error(e):
                    await self._sleep_or_stop(_QR_POLL_INTERVAL_S)
                    continue
                self._state = "failed"
                self._error = f"QR status poll failed: {e}"
                return

            if not isinstance(status_data, dict):
                await self._sleep_or_stop(_QR_POLL_INTERVAL_S)
                continue

            status = status_data.get("status", "")
            if status == _QR_STATUS_CONFIRMED:
                token = status_data.get("bot_token", "")
                base_url = status_data.get("baseurl", "")
                if not token:
                    self._state = "failed"
                    self._error = "Login confirmed but no bot_token returned"
                    return
                # Persist token + base_url into the live config so the
                # running channel picks it up on next start.
                self._config.token = token
                if base_url:
                    self._config.base_url = base_url
                if not WeixinLoginSession._persist_token(token, base_url):
                    self._state = "failed"
                    self._error = "Failed to save WeChat account state"
                    return
                self._state = "confirmed"
                return
            if status == _QR_STATUS_SCANNED_REDIRECT:
                redirect_host = str(status_data.get("redirect_host", "") or "").strip()
                if redirect_host:
                    if redirect_host.startswith("http://") or redirect_host.startswith("https://"):
                        redirected_base = redirect_host
                    else:
                        redirected_base = f"https://{redirect_host}"
                    if redirected_base != current_poll_base_url:
                        current_poll_base_url = redirected_base
            elif status == _QR_STATUS_EXPIRED:
                refresh_count += 1
                if refresh_count > MAX_QR_REFRESH_COUNT:
                    self._state = "expired"
                    self._error = "QR code expired too many times"
                    return
                try:
                    qrcode_id, scan_url = await self._fetch_qr_code()
                    current_poll_base_url = self._config.base_url
                    self._qr_svg = _render_qr_svg(scan_url)
                    self._state = "awaiting_scan"
                except Exception as e:
                    self._state = "failed"
                    self._error = f"Failed to refresh QR code: {e}"
                    return
                continue
            # status == "wait" — keep polling
            await self._sleep_or_stop(_QR_POLL_INTERVAL_S)

    async def _fetch_qr_code(self) -> tuple[str, str]:
        self._state = "fetching_qr"
        data = await self._api_get(
            "ilink/bot/get_bot_qrcode",
            params={"bot_type": "3"},
            auth=False,
        )
        qrcode_img_content = data.get("qrcode_img_content", "")
        qrcode_id = data.get("qrcode", "")
        if not qrcode_id:
            raise RuntimeError(f"Failed to get QR code from WeChat API: {data}")
        return qrcode_id, (qrcode_img_content or qrcode_id)

    async def _sleep_or_stop(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
            # stop event set during sleep — propagate cancellation
            raise asyncio.CancelledError()
        except asyncio.TimeoutError:
            return

    # ------------------------------------------------------------------
    # HTTP helpers — mirror WeixinChannel but use the session-local client
    # ------------------------------------------------------------------

    @staticmethod
    def _make_headers() -> dict[str, str]:
        """Build per-request headers for the QR login flow (no auth needed)."""
        import base64
        import os

        uint32 = int.from_bytes(os.urandom(4), "big")
        uin = base64.b64encode(str(uint32).encode()).decode()
        return {
            "X-WECHAT-UIN": uin,
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
        }

    async def _api_get(
        self,
        endpoint: str,
        params: dict | None = None,
        *,
        auth: bool = True,
        extra_headers: dict[str, str] | None = None,
    ) -> dict:
        assert self._client is not None
        url = f"{self._config.base_url}/{endpoint}"
        hdrs = self._make_headers()
        if extra_headers:
            hdrs.update(extra_headers)
        resp = await self._client.get(url, params=params, headers=hdrs)
        resp.raise_for_status()
        return resp.json()

    async def _api_get_with_base(
        self,
        *,
        base_url: str,
        endpoint: str,
        params: dict | None = None,
        auth: bool = True,
        extra_headers: dict[str, str] | None = None,
    ) -> dict:
        assert self._client is not None
        url = f"{base_url.rstrip('/')}/{endpoint}"
        hdrs = self._make_headers()
        if extra_headers:
            hdrs.update(extra_headers)
        resp = await self._client.get(url, params=params, headers=hdrs)
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _is_retryable_qr_poll_error(err: Exception) -> bool:
        if isinstance(err, httpx.TimeoutException | httpx.TransportError):
            return True
        if isinstance(err, httpx.HTTPStatusError):
            status_code = err.response.status_code if err.response is not None else 0
            return status_code >= 500
        return False

    # ------------------------------------------------------------------
    # Persistence — reuse WeixinChannel's state file format
    # ------------------------------------------------------------------

    @staticmethod
    def _get_state_dir() -> Path:
        """Resolve the WeChat account state directory, honoring config.state_dir."""
        from mona.config.loader import load_config
        from mona.config.paths import get_runtime_subdir

        try:
            config = load_config()
            section = getattr(config.channels, "weixin", None)
            if section is not None:
                if isinstance(section, dict):
                    state_dir = section.get("state_dir", "")
                else:
                    state_dir = getattr(section, "state_dir", "")
                if state_dir:
                    return Path(state_dir).expanduser()
        except Exception:
            pass
        return get_runtime_subdir("weixin")

    @staticmethod
    def _persist_token(token: str, base_url: str) -> bool:
        """Save the freshly-obtained token into the WeChat account state file.

        Reuses the same on-disk format as ``WeixinChannel._save_state`` so a
        subsequent gateway start picks it up via ``_load_state``.
        """
        import json
        from contextlib import suppress

        try:
            state_dir = WeixinLoginSession._get_state_dir()
            state_dir.mkdir(parents=True, exist_ok=True)
            state_file = state_dir / "account.json"
            existing: dict[str, Any] = {}
            if state_file.exists():
                with suppress(Exception):
                    existing = json.loads(state_file.read_text())
            existing["token"] = token
            if base_url:
                existing["base_url"] = base_url
            state_file.write_text(json.dumps(existing, ensure_ascii=False))
            return True
        except Exception:
            logger.exception("Failed to persist WeChat token")
            return False

    @staticmethod
    def clear_saved_token() -> bool:
        """Delete the saved WeChat account state file (logout)."""
        try:
            state_dir = WeixinLoginSession._get_state_dir()
            state_file = state_dir / "account.json"
            if not state_file.exists():
                return True
            state_file.unlink()
            return True
        except Exception:
            logger.exception("Failed to delete WeChat account state file")
            return False

    @staticmethod
    def has_saved_token() -> bool:
        """Check whether a saved WeChat token exists on disk."""
        import json

        try:
            state_dir = WeixinLoginSession._get_state_dir()
            state_file = state_dir / "account.json"
            if not state_file.exists():
                return False
            data = json.loads(state_file.read_text())
            return bool(data.get("token"))
        except Exception:
            return False


# Re-export to satisfy static analyzers that expect WeixinChannel usage.
__all__ = ["WeixinLoginSession", "LoginState", "WeixinConfig"]
