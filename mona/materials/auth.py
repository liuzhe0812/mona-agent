"""Services 本地 API 的每次启动令牌鉴权（阶段 0 / P0-1）。

资料库路由处理用户的私密文档与 Wiki 写入/删除，不能仅依赖"绑定 127.0.0.1"
作为安全边界——任意本地进程或恶意网页都可能尝试访问本机端口。

令牌分发约定：
- services 进程启动时调用 ``get_services_token()``：优先取环境变量
  ``MONA_SERVICES_TOKEN``，否则读取/生成 app data 目录下的
  ``services.token`` 文件并立即持久化；
- Rust 本地 HTTP 桥（``local_http_request``）为受保护 services 请求
  自动读取同一 ``services.token`` 文件并附带 ``X-Mona-Token`` 头，
  前端无需感知令牌。

校验 ``/api/materials/*`` 以及会触发外部数据抓取和上下文写入的
``POST /api/stock/research/preflight``；其它 stock、email、schedule 路由维持现状。
"""

from __future__ import annotations

import hmac
import os
import secrets
from pathlib import Path

from aiohttp import web

from mona.config.paths import get_data_dir

SERVICES_TOKEN_ENV = "MONA_SERVICES_TOKEN"
SERVICES_TOKEN_HEADER = "X-Mona-Token"
_TOKEN_FILE_NAME = "services.token"

# 受保护的路由前缀
_PROTECTED_PREFIX = "/api/materials"
_PROTECTED_EXACT_PATHS = {"/api/stock/research/preflight"}


def _token_file_path() -> Path:
    app_data_dir = os.environ.get("MONA_APP_DATA_DIR")
    if app_data_dir:
        return Path(app_data_dir) / _TOKEN_FILE_NAME
    return get_data_dir() / _TOKEN_FILE_NAME


def get_services_token() -> str:
    """返回当前进程生效的 services 令牌。

    优先级：环境变量 > services.token 文件 > 随机生成并写入文件。
    """
    env_token = os.environ.get(SERVICES_TOKEN_ENV, "").strip()
    if env_token:
        return env_token

    path = _token_file_path()
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    except OSError:
        pass

    token = secrets.token_hex(32)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(token, encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        # 无法持久化时仍返回内存令牌，进程内一致
        pass
    return token


def is_valid_services_token(token: str | None) -> bool:
    """常量时间比较校验令牌。"""
    if not token:
        return False
    return hmac.compare_digest(token, get_services_token())


def _requires_services_token(path: str) -> bool:
    return path.startswith(_PROTECTED_PREFIX) or path in _PROTECTED_EXACT_PATHS


@web.middleware
async def materials_auth_middleware(request: web.Request, handler) -> web.StreamResponse:
    """校验受保护 services 请求的 X-Mona-Token 头。

    OPTIONS 预检请求不携带自定义头，直接放行由 CORS 中间件处理。
    """
    if request.method == "OPTIONS":
        return await handler(request)
    if _requires_services_token(request.path):
        if not is_valid_services_token(request.headers.get(SERVICES_TOKEN_HEADER)):
            raise web.HTTPUnauthorized(reason="invalid services token")
    return await handler(request)
