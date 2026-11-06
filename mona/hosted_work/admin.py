"""Administrator-only Codex connection and billing drafts."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

from aiohttp import web
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field

from mona.config.schema import HostedCodexSettings, HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.frontend import _is_link


class SaveCodex(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    configuration: HostedCodexSettings


class CodexAdmin:
    def __init__(self, config_path: Path):
        # Only the process entry point supplies this path, never a website request.
        self.path = config_path.resolve(strict=True)
        self.root = self.path.parent
        self.lock = asyncio.Lock()
        self.checked: tuple[str, dict] | None = None

    def _scoped(self, relative: str) -> Path:
        path = self.root / relative
        if (not path.resolve().is_relative_to(self.root)
                or any(_is_link(item) for item in (path, *path.parents) if item.is_relative_to(self.root))):
            raise WorkError("invalid_configuration", "专用配置目录未通过安全检查，请在服务器核对。", 503)
        return path

    def _read(self) -> tuple[dict, str, str, HostedCodexSettings]:
        if _is_link(self.path) or self.path.stat().st_size > 2 * 1024 * 1024:
            raise WorkError("invalid_configuration", "工作台配置无法读取，请在服务器核对。", 503)
        raw = self.path.read_bytes()
        data = json.loads(raw)
        key = "hosted_work" if "hosted_work" in data else "hostedWork"
        settings = HostedWorkConfig.model_validate(data.get(key, {})).codex
        return data, key, hashlib.sha256(raw).hexdigest(), settings

    def _models(self) -> list[dict]:
        cache = self._scoped("development/native/codex/models_cache.json")
        if not cache.is_file() or cache.stat().st_size > 10 * 1024 * 1024:
            return []
        try:
            models = json.loads(cache.read_text(encoding="utf-8")).get("models", [])
            if not isinstance(models, list):
                return []
            ids = dict.fromkeys(item["slug"] for item in models if isinstance(item, dict)
                                and isinstance(item.get("slug"), str) and 0 < len(item["slug"]) <= 200
                                and not any(ord(c) < 33 or ord(c) == 127 for c in item["slug"]))
            return [{"id": model, "label": model} for model in list(ids)[:512]]
        except (OSError, ValueError, AttributeError):
            return []

    def _write_locked(self, data: dict, key: str, revision: str, *, backup_kind: str) -> None:
        """Commit a validated, revision-checked edit while holding both locks."""
        HostedWorkConfig.model_validate(data[key])
        candidate = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        previous = self.path.read_bytes()
        if hashlib.sha256(previous).hexdigest() != revision:
            raise WorkError("configuration_changed", "配置已被修改，请刷新后重新填写。", 409)
        backup = self._scoped(self.path.name + ".before-" + backup_kind + "-" + revision + ".json")
        if not backup.exists():
            with backup.open("xb") as stream:
                os.chmod(backup, 0o600)
                stream.write(previous)
        elif hashlib.sha256(backup.read_bytes()).hexdigest() != revision:
            raise WorkError("invalid_configuration", "配置备份未通过校验，请在服务器核对。", 503)
        descriptor, temporary = tempfile.mkstemp(prefix=".hosted-settings-", dir=self.root)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(candidate)
                stream.flush()
                os.fsync(stream.fileno())
            if hashlib.sha256(self.path.read_bytes()).hexdigest() != revision:
                raise WorkError("configuration_changed", "配置已被修改，请刷新后重新填写。", 409)
            os.replace(temporary, self.path)
            self.path.chmod(0o600)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def snapshot(self) -> dict:
        _, _, revision, settings = self._read()
        connection = {"state": "not_configured" if not settings.cli_path else "not_checked",
                      "message": "请填写 Ubuntu 上的 Codex 程序路径，保存后检查连接。" if not settings.cli_path
                                 else "配置已保存，请检查专用账户的连接。",
                      "models": self._models()}
        if self.checked and self.checked[0] == revision:
            connection = self.checked[1]
        command = [sys.executable, "-m", "mona.hosted_work.admin", "--config", str(self.path)]
        return {"revision": revision, "configuration": settings.model_dump(), "connection": connection,
                "billing": {"mode": settings.billing_mode, "ready": settings.billing_mode == "free",
                            "message": "管理员已设置为免费，不扣用户余额。" if settings.billing_mode == "free"
                                       else "使用网站与应用共用的 Mona 余额；余额计费尚未接通。"},
                "execution": {"ready": False, "message": "Codex CLI 执行接入尚未完成，暂不可调用。"},
                "public_enabled": False,
                "login_commands": ["cd " + shlex.quote(str(Path(__file__).resolve().parents[2])),
                                   shlex.join([*command, "login", "--device-auth" if settings.auth_mode == "chatgpt" else "--with-api-key"]),
                                   shlex.join([*command, "login", "status"])]}

    async def save(self, request: SaveCodex) -> dict:
        if request.configuration.cli_path and not Path(request.configuration.cli_path).is_absolute():
            raise WorkError("invalid_cli_path", "请填写 Ubuntu 上的绝对程序路径。")
        async with self.lock:
            try:
                with FileLock(str(self._scoped(self.path.name + ".admin.lock")), timeout=0):
                    data, key, revision, _ = self._read()
                    if revision != request.expected_revision:
                        raise WorkError("configuration_changed", "配置已被修改，请刷新后重新填写。", 409)
                    data[key]["codex"] = request.configuration.model_dump()
                    self._write_locked(data, key, revision, backup_kind="codex")
            except Timeout as exc:
                raise WorkError("configuration_busy", "配置正在保存，请稍后重试。", 409) from exc
            self.checked = None
            return self.snapshot()

    def profile(self, settings: HostedCodexSettings):
        from mona.development.contracts import ExecutorId
        from mona.development.executors.codex_policy import prepare_codex_profile
        from mona.development.executors.discovery import resolve_executable

        if not settings.cli_path or not Path(settings.cli_path).is_absolute():
            raise WorkError("cli_not_configured", "请先填写并保存 Codex 程序的绝对路径。")
        executable, _ = resolve_executable(ExecutorId.CODEX, Path(settings.cli_path))
        home = self._scoped("development/native/codex")
        for name in ("auth.json", "config.toml", "models_cache.json"):
            self._scoped("development/native/codex/" + name)
        bootstrap = self._scoped("codex-bootstrap")
        bootstrap.mkdir(mode=0o700, parents=True, exist_ok=True)
        if any(bootstrap.iterdir()):
            raise WorkError("bootstrap_not_empty", "专用登录目录不是空目录，请在服务器核对。", 503)
        return prepare_codex_profile(executable, home, bootstrap)

    async def probe(self) -> dict:
        from mona.development.executors.codex import CodexExecutor

        async with self.lock:
            _, _, revision, settings = self._read()
            host = None
            connection = {"state": "unavailable", "message": "未能验证 Codex 连接，请核对程序路径后重试。", "models": []}
            try:
                host = CodexExecutor(self.profile(settings), request_timeout=15)
                async with asyncio.timeout(40):
                    result = await host.probe()
                connection["models"] = models = self._models()
                if not result.protocol_verified or not result.isolation_verified:
                    connection["message"] = "Codex 程序未通过连接检查，请核对程序及版本。"
                elif result.authentication != "ready":
                    connection.update(state="login_required", message="请在 Ubuntu 终端登录专用 Codex 账户，然后再次检查。")
                elif result.auth_mode != settings.auth_mode:
                    connection.update(state="auth_mode_mismatch", message="实际认证方式与配置不一致，请核对专用账户。")
                elif not settings.model or settings.model not in {item["id"] for item in models}:
                    connection.update(state="model_required", message="账户连接已验证，请从原生模型列表选择模型并保存。")
                elif settings.model not in {item.id for item in result.model_details}:
                    connection.update(state="model_unavailable", message="所选模型当前不可用，请重新选择并保存。")
                else:
                    connection.update(state="ready", message="专用账户和所选模型连接已验证。")
            except WorkError:
                raise
            except (OSError, ValueError, TimeoutError):
                pass
            finally:
                if host is not None:
                    await host.shutdown()
            self.checked = revision, connection
            return self.snapshot()

    def register(self, app: web.Application) -> None:
        async def handle(request):
            if request.method == "GET":
                return web.json_response(self.snapshot())
            if request.content_length is not None and request.content_length > 8192:
                raise WorkError("invalid_request", "配置内容过大。", 413)
            raw = bytearray()
            async for chunk in request.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 8192:
                    raise WorkError("invalid_request", "配置内容过大。", 413)
            if request.method == "PUT":
                model = SaveCodex.model_validate_json(raw)
                if "billing_mode" not in model.configuration.model_fields_set:
                    raise WorkError("invalid_request", "请刷新配置页面后明确选择计费方式。")
                return web.json_response(await self.save(model))
            if json.loads(raw) != {}:
                raise WorkError("invalid_request", "检查连接不接受额外配置。")
            return web.json_response(await self.probe())

        app.router.add_get("/api/work/admin/codex", handle)
        app.router.add_put("/api/work/admin/codex", handle)
        app.router.add_post("/api/work/admin/codex/probe", handle)


def main() -> None:
    """Manual device login; authentication never crosses the website API."""
    args = sys.argv[1:]
    if (len(args) != 4 or args[0] != "--config" or args[2] != "login"
            or args[3] not in {"--device-auth", "--with-api-key", "status"}):
        raise SystemExit("用法：python -m mona.hosted_work.admin --config <配置文件> login <--device-auth|--with-api-key|status>")
    os.umask(0o077)
    admin = CodexAdmin(Path(args[1]))
    try:
        profile = admin.profile(admin._read()[3])
    except (OSError, ValueError, WorkError):
        raise SystemExit("Codex 专用配置尚未就绪，请先在管理页保存程序路径。") from None
    environment = dict(profile.environment)
    if os.environ.get("TERM"):
        environment["TERM"] = os.environ["TERM"]
    raise SystemExit(subprocess.run([profile.command[0], "login", args[3]], cwd=profile.project_root,
                                   env=environment).returncode)


if __name__ == "__main__":
    main()
