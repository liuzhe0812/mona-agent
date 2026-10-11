"""Reuse the local Claude Code account, following Cindy's credential adapter.

Only the app binding is persisted here. System credentials remain owned by the CLI.
"""

from __future__ import annotations

import getpass
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from mona.development.executors.rpc import RpcError

_BINDING = "claude-local-account.json"


def read_local_account() -> dict:
    """Same stores as Cindy's claude-credentials-store; never load CLI settings."""
    try:
        if sys.platform == "darwin":
            result = subprocess.run(
                ["/usr/bin/security", "find-generic-password", "-a", os.environ.get("USER") or getpass.getuser(),
                 "-w", "-s", "Claude Code-credentials"],
                capture_output=True, text=True, timeout=5, check=False,
            )
            if result.returncode:
                raise ValueError("credential unavailable")
            raw = result.stdout
        else:
            directory = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser().resolve()
            raw = (directory / ".credentials.json").read_text(encoding="utf-8-sig")
        blob = json.loads(raw)
        oauth = blob.get("claudeAiOauth") if isinstance(blob, dict) else None
        if not isinstance(oauth, dict) or not isinstance(oauth.get("accessToken"), str) or not oauth["accessToken"].strip():
            raise ValueError("credential unavailable")
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RpcError("native_local_account_unavailable", "未找到可用的本机 Claude Code 账号，请先在本机 Claude Code 中登录。") from None
    expiry = oauth.get("expiresAt")
    if isinstance(expiry, (int, float)) and expiry <= time.time() * 1000:
        raise RpcError("native_local_account_expired", "本机 Claude Code 登录已过期，请在本机 CLI 更新登录后重试。")
    return oauth


def bind_local_account(home: Path) -> None:
    read_local_account()
    target = home / _BINDING
    temporary = target.with_suffix(".tmp")
    temporary.write_text('{"bound":true}\n', encoding="utf-8")
    temporary.replace(target)


def unbind_local_account(home: Path) -> None:
    (home / _BINDING).unlink(missing_ok=True)


def is_local_account_bound(home: Path) -> bool:
    return (home / _BINDING).is_file()


def local_account_env(home: Path) -> dict[str, str]:
    if not is_local_account_bound(home):
        return {}
    oauth = read_local_account()
    # Field mapping matches Cindy's claude-oauth-spawn-env.ts.
    env = {"CLAUDE_CODE_OAUTH_TOKEN": oauth["accessToken"]}
    scopes = oauth.get("scopes")
    if isinstance(scopes, list) and scopes and all(isinstance(scope, str) for scope in scopes):
        env["CLAUDE_CODE_OAUTH_SCOPES"] = " ".join(scopes)
    for source, key in (("subscriptionType", "CLAUDE_CODE_SUBSCRIPTION_TYPE"),
                        ("rateLimitTier", "CLAUDE_CODE_RATE_LIMIT_TIER")):
        if isinstance(oauth.get(source), str) and oauth[source]:
            env[key] = oauth[source]
    return env
