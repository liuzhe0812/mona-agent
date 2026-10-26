"""IMAP 连接池（参考主流邮箱客户端的持久连接模型）。

设计目标：
- 复用持久连接，避免每次操作都新建 TCP + SSL 握手 + login
- 同一账号的 IMAP 操作串行化（imaplib 不是线程安全的）
- 自动健康检查（NOOP）和断线重连
- 永久性认证错误（密码错误）标记池为 failed，避免无限重试加剧风控

使用方式：
    from mona.email.imap_pool import imap_pool_manager

    # 在 _imap_* 函数中：
    def _imap_xxx(body):
        def op(client: imaplib.IMAP4) -> T:
            client.select(...)
            return client.uid(...)
        return imap_pool_manager.run(body, op)

连接模型：
- 每账号 1 个操作连接（串行复用）
- IDLE 连接独立，不参与复用（IDLE 会阻塞连接）
- 操作连接由 server 的 asyncio.Lock 和池内线程锁串行化；keepalive 共用池内线程锁。
"""

from __future__ import annotations

import contextlib
import imaplib
import socket
import ssl
import threading
import time
from typing import Any, Callable, TypeVar

from loguru import logger

_T = TypeVar("_T")


class ImapOperationDeferred(RuntimeError):  # noqa: N818
    """A background read was interrupted to make room for a foreground operation."""


# 腾讯邮箱（exmail.qq.com / imap.qq.com）在 IMAP 响应中插入 X-QQ-FEAT 行
# 作为 feature 广告，不以 * / + / tag 开头，imaplib 的 _get_response 无法解析，
# 直接抛 abort 异常，导致 FETCH 失败、连接被废弃。
# monkey-patch _get_response：遇到 X-QQ-FEAT 行时跳过，继续读取下一行。
_orig_get_response = imaplib.IMAP4._get_response


def _patched_get_response(self, *args, **kwargs):
    while True:
        try:
            return _orig_get_response(self, *args, **kwargs)
        except imaplib.IMAP4.abort as e:
            if "X-QQ-FEAT" in str(e):
                continue
            raise


imaplib.IMAP4._get_response = _patched_get_response

# 可重试的连接异常（断线后重连重试一次）
_RETRYABLE_EXC: tuple[type[BaseException], ...] = (
    ConnectionError,
    TimeoutError,
    OSError,
    imaplib.IMAP4.abort,
)


def _is_retryable(e: Exception) -> bool:
    if isinstance(e, ImapOperationDeferred):
        return False
    if isinstance(e, imaplib.IMAP4.readonly):
        return False
    if isinstance(e, _RETRYABLE_EXC):
        return True
    msg = str(e).lower()
    markers = (
        "timeout", "timed out", "connection reset", "broken pipe",
        "eof", "connection closed", "connection aborted",
        "socket", "connection refused",
        "illegal in state", "logout",
    )
    return any(m in msg for m in markers)


def _is_permanent_auth_error(e: Exception) -> bool:
    """判断是否为永久性认证错误（密码错误/账号异常/频率限制）。

    这些错误不应重试，否则会加剧邮箱服务器对该账号的风控。
    同时匹配中文常见提示，避免中文错误信息被误判为可重试。
    """
    if isinstance(e, ImapOperationDeferred):
        return False
    msg = str(e).lower()
    markers = (
        # 英文
        "login fail",
        "authentication failed",
        "account is abnormal",
        "service is not open",
        "login frequency limited",
        "password",
        # 中文（腾讯/网易/阿里常见提示）
        "认证失败",
        "密码错误",
        "账号异常",
        "账户异常",
        "登录失败",
        "登录频率",
        "频率限制",
        "服务未开通",
        "暂时禁止登录",
        "不允许尝试登录",
    )
    return any(m in msg for m in markers)


class _AccountImapPool:
    """单账号的 IMAP 操作连接池（1 个持久连接）。

    操作线程锁同时保护 run 和 keepalive，避免协程取消后后台线程仍在使用连接。
    """

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body
        self._client: imaplib.IMAP4 | None = None
        # 永久性失败时间戳（0 表示未失败）；失败后 1 小时内不再尝试 login
        self._failed_until: float = 0
        self._last_use: float = time.time()
        self._operation_lock = threading.Lock()
        self._operation_lock_timeout = 10.0
        self._interrupt_lock = threading.Lock()
        self._interrupt_event = threading.Event()
        self._active_background = False
        # 配置指纹，用于检测配置变更
        self._config_fingerprint = self._compute_fingerprint(body)

    @staticmethod
    def _compute_fingerprint(body: dict[str, Any]) -> str:
        return "|".join([
            str(body.get("imapHost", "")).strip(),
            str(body.get("imapPort", 993)),
            str(body.get("imapUsername", "")).strip(),
            str(body.get("imapPassword", "") or ""),
            str(bool(body.get("useSsl", True))),
        ])

    def config_changed(self, body: dict[str, Any]) -> bool:
        """检测配置是否变更（密码修改等）。"""
        return self._compute_fingerprint(body) != self._config_fingerprint

    def run(self, op: Callable[[imaplib.IMAP4], _T], *, background: bool = False) -> _T:
        """执行 IMAP 操作，自动管理连接生命周期。

        `background=True` 仅用于允许让出连接的纯读操作。
        - 首次调用时新建连接 + login
        - 复用已有连接（NOOP 健康检查）
        - 连接断开时自动重连 + 重试一次
        - 永久性认证错误标记池失败，1 小时内不再 login
        """
        if not self._operation_lock.acquire(timeout=self._operation_lock_timeout):
            raise RuntimeError("邮箱正忙，请稍后重试。")
        try:
            return self._run_locked(op, background=background)
        finally:
            self._operation_lock.release()

    def _run_locked(
        self,
        op: Callable[[imaplib.IMAP4], _T],
        *,
        background: bool = False,
    ) -> _T:
        # 检查永久失败状态
        if self._failed_until > 0:
            wait = self._failed_until - time.time()
            if wait > 0:
                raise RuntimeError(
                    f"账号认证失败，{int(wait)}s 内不再尝试登录（避免加剧邮箱风控）。"
                    f"请检查账号配置或等待风控解除。"
                )
            # 失败时间已过，允许重试
            self._failed_until = 0
            logger.info("[imap-pool] failed period expired, retrying login")

        last_error: Exception | None = None
        for attempt in range(2):  # 最多 2 次：原始 + 重连后重试
            try:
                client = self._get_or_reconnect()
                if background:
                    self._begin_background()
                result = op(client)
            except Exception as e:
                interrupted = self._finish_background() if background else False
                if interrupted:
                    self._invalidate()
                    raise ImapOperationDeferred("后台邮件读取已让位给前台操作。") from e
                last_error = e
                # 永久性认证错误：标记池失败
                if _is_permanent_auth_error(e):
                    self._failed_until = time.time() + 3600  # 1 小时
                    self._invalidate()
                    logger.error(
                        f"[imap-pool] permanent auth error, marking pool failed for 1h: {e}"
                    )
                    raise
                # 可重试的连接错误：失效连接，重连后重试一次
                if _is_retryable(e):
                    self._invalidate()
                    if attempt == 0:
                        logger.debug(
                            f"[imap-pool] connection lost, will reconnect and retry: {e}"
                        )
                        continue
                # 业务错误（如文件夹不存在）或非可重试错误：直接抛出
                raise
            else:
                interrupted = self._finish_background() if background else False
                if interrupted:
                    # 完整结果可以交付，但被打断的 socket 不再复用。
                    self._invalidate()
                self._last_use = time.time()
                return result
            finally:
                if background:
                    self._finish_background()

        # 理论上不会到达
        assert last_error is not None
        raise last_error

    def _begin_background(self) -> None:
        with self._interrupt_lock:
            self._interrupt_event.clear()
            self._active_background = True

    def _finish_background(self) -> bool:
        with self._interrupt_lock:
            interrupted = self._interrupt_event.is_set()
            self._active_background = False
            self._interrupt_event.clear()
            return interrupted

    def interrupt_background(self) -> bool:
        """Wake an active background read without blocking on file close or LOGOUT."""
        with self._interrupt_lock:
            client = self._client
            if not self._active_background or client is None:
                return False
            sock = getattr(client, "sock", None)
            if sock is None:
                return False
            self._interrupt_event.set()
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            return True

    def _get_or_reconnect(self) -> imaplib.IMAP4:
        """获取可用连接，必要时重连。

        为减少因频繁 NOOP 检测误判导致的不必要重连 login，
        上次使用后 5 分钟内直接复用连接，超时后再做 NOOP 健康检查。
        但若连接已被服务器单方面关闭（imaplib.state == LOGOUT），
        即使在 5 分钟窗口内也必须重连，否则后续命令会报
        "command FETCH illegal in state LOGOUT"。
        """
        now = time.time()
        # 先检查连接是否已被服务器关闭（state 变为 LOGOUT）。
        # 这种情况下 _client 对象还在，recently_used 会误判为可用。
        if self._client is not None and self._is_logged_out():
            logger.debug(
                "[imap-pool] connection in LOGOUT state, will reconnect"
            )
            self._invalidate()

        recently_used = self._client is not None and (now - self._last_use) < 300
        if recently_used or (self._client is not None and self._is_alive()):
            return self._client

        # 关闭旧连接
        if self._client is not None:
            self._invalidate()

        # 新建连接
        self._client = self._create_client()
        logger.debug("[imap-pool] established connection")
        return self._client

    def _is_logged_out(self) -> bool:
        """检测连接是否已进入 LOGOUT 状态（服务器主动关闭或之前 logout 调用）。

        imaplib.IMAP4.state 在 LOGOUT 时为 'LOGOUT'，此时连接对象还在但
        任何 IMAP 命令都会被服务器拒绝。recently_used 优化会误判这种连接为可用，
        导致 "command FETCH illegal in state LOGOUT" 错误。
        """
        if self._client is None:
            return True
        try:
            return getattr(self._client, "state", "") == "LOGOUT"
        except Exception:
            return True

    def _is_alive(self) -> bool:
        """通过 NOOP 检测连接是否存活。"""
        if self._client is None:
            return False
        try:
            status, _ = self._client.noop()
            return status == "OK"
        except Exception:
            return False

    def _create_client(self) -> imaplib.IMAP4:
        """新建 IMAP 连接并 login。"""
        host = str(self._body.get("imapHost", "") or "").strip()
        port = int(self._body.get("imapPort", 993) or 993)
        username = str(self._body.get("imapUsername", "") or "").strip()
        password = str(self._body.get("imapPassword", "") or "")
        use_ssl = bool(self._body.get("useSsl", True))

        if not host or not username:
            raise ValueError("imapHost and imapUsername are required")

        if use_ssl:
            ctx = ssl.create_default_context()
            client = imaplib.IMAP4_SSL(host, port, ssl_context=ctx, timeout=30)
        else:
            client = imaplib.IMAP4(host, port, timeout=30)
            client.starttls(ssl.create_default_context())

        try:
            client.login(username, password)
        except Exception:
            with contextlib.suppress(Exception):
                client.shutdown()
            raise
        return client

    def _invalidate(self) -> None:
        """标记连接失效，下次使用时重连。"""
        client, self._client = self._client, None
        if client is not None:
            with contextlib.suppress(Exception):
                client.shutdown()

    def close(self) -> None:
        """关闭池，释放连接。"""
        self._invalidate()
        self._failed_until = 0


class ImapPoolManager:
    """全局 IMAP 连接池管理器。

    按 (host, username) 维护每账号的连接池。
    """

    def __init__(self) -> None:
        self._pools: dict[tuple[str, str], _AccountImapPool] = {}
        self._lock = threading.Lock()

    def _pool_key(self, body: dict[str, Any]) -> tuple[str, str]:
        host = str(body.get("imapHost", "") or "").strip()
        username = str(body.get("imapUsername", "") or "").strip()
        return (host, username)

    def get_pool(self, body: dict[str, Any]) -> _AccountImapPool:
        """获取或创建账号的连接池。

        如果配置变更（密码修改等）或池处于永久失败状态，会重建池。
        """
        key = self._pool_key(body)
        with self._lock:
            pool = self._pools.get(key)
            # 配置变更或池失败已过期：重建
            if pool is not None and pool.config_changed(body):
                logger.debug("[imap-pool] config changed, recreating pool")
                pool.close()
                pool = None
            if pool is None:
                pool = _AccountImapPool(body)
                self._pools[key] = pool
            return pool

    def run(
        self,
        body: dict[str, Any],
        op: Callable[[imaplib.IMAP4], _T],
        *,
        background: bool = False,
    ) -> _T:
        """获取池并执行操作；background 仅用于允许让出连接的纯读调用。"""
        return self.get_pool(body).run(op, background=background)

    def interrupt_background(self, body: dict[str, Any]) -> bool:
        """Interrupt an existing pool's read without creating a pool or waiting for a socket close."""
        key = self._pool_key(body)
        if not self._lock.acquire(blocking=False):
            return False
        try:
            pool = self._pools.get(key)
        finally:
            self._lock.release()
        return pool.interrupt_background() if pool is not None else False

    def remove_pool(self, host: str, username: str) -> None:
        """删除账号的连接池（账号删除时调用）。"""
        key = (host.strip(), username.strip())
        with self._lock:
            pool = self._pools.pop(key, None)
        if pool:
            pool.close()
            logger.debug("[imap-pool] removed pool")

    def reset_pool(self, body: dict[str, Any]) -> None:
        """重置账号的连接池（修改配置/测试连接时调用）。"""
        key = self._pool_key(body)
        with self._lock:
            pool = self._pools.pop(key, None)
        if pool:
            pool.close()
            logger.debug("[imap-pool] reset pool")

    def close_all(self) -> None:
        """关闭所有连接池（gateway 关闭时调用）。"""
        with self._lock:
            pools = list(self._pools.values())
            self._pools.clear()
        for p in pools:
            p.close()
        logger.info(f"[imap-pool] closed all pools ({len(pools)})")

    def keepalive(self, interval: float = 120.0) -> None:
        """后台线程：定期对空闲连接发送 NOOP 保活，避免服务器因长时间不活动关闭连接。

        注意：
        - NOOP 失败时只标记连接失效，不在此处重连 login，避免后台任务触发风控。
        - 使用操作线程锁非阻塞地跳过忙碌池，避免 NOOP 与 FETCH 并发。
        下次用户操作时由 run() 自动重连。
        """
        while True:
            time.sleep(interval)
            with self._lock:
                pools = list(self._pools.values())
            for pool in pools:
                self._keepalive_pool(pool)

    @staticmethod
    def _keepalive_pool(pool: _AccountImapPool) -> None:
        if pool._failed_until > time.time():
            return
        if not pool._operation_lock.acquire(blocking=False):
            return
        try:
            client = pool._client
            if client is None:
                return
            try:
                status, _ = client.noop()
                if status == "OK":
                    pool._last_use = time.time()
                else:
                    pool._invalidate()
            except Exception as e:
                logger.debug(f"[imap-pool] keepalive NOOP failed, will reconnect on next use: {e}")
                pool._invalidate()
        finally:
            pool._operation_lock.release()

    def status(self) -> list[dict[str, Any]]:
        """返回所有池的状态（用于监控/调试）。"""
        with self._lock:
            items = list(self._pools.items())
        result = []
        for (host, username), pool in items:
            result.append({
                "host": host,
                "username": username,
                "hasConnection": pool._client is not None,
                "failed": pool._failed_until > time.time(),
                "lastUse": pool._last_use,
            })
        return result


# 全局单例
imap_pool_manager = ImapPoolManager()
