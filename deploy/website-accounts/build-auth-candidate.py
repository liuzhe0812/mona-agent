"""Build a scoped candidate on top of an observed production source archive.

Never packages a .env, private key, database or the unrelated local Auth changes.
No server is contacted and no deployment is performed by this builder.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import io
import json
import tarfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
AUTH = ROOT / "mona-auth"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raw = args.baseline.read_bytes()
    if sha(raw) != args.expected_sha or args.output.exists():
        raise SystemExit("Baseline digest must match and output must not exist")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if (not member.isfile() or path.is_absolute() or ".." in path.parts
                    or str(path) != member.name or member.size > 2_000_000):
                raise SystemExit("Unexpected source archive entry")
            files[member.name] = archive.extractfile(member).read()
    baseline = json.loads(files.pop("source-manifest.json"))
    if set(files) != set(baseline["files"]) or any(sha(value) != baseline["files"][name] for name, value in files.items()):
        raise SystemExit("Source manifest mismatch")
    original = dict(files)

    def replace(name: str, old: str, new: str, count: int = 1):
        content = files[name].decode("utf-8")
        endings = ["\r\n", "\n"] if content.count("\r\n") > content.count("\n") / 2 else ["\n", "\r\n"]
        for ending in endings:
            before, after = old.replace("\n", ending), new.replace("\n", ending)
            if content.count(before) == count:
                files[name] = content.replace(before, after).encode("utf-8")
                return
        raise SystemExit(f"Exact compatible anchor mismatch: {name}: {old[:70]!r}")

    # New modules are copied from the verified local implementation. Shared
    # production modules are patched below, never replaced wholesale.
    additions = [*AUTH.glob("app/website_*.py"), AUTH / "app/routers/website_account_router.py",
                 AUTH / "app/routers/identity_router.py",
                 AUTH / "alembic/versions/2026_10_17_add_account_token_version.py",
                 AUTH / "alembic/versions/2026_10_30_add_website_accounts.py",
                 AUTH / "tests/test_website_accounts.py", AUTH / "tests/test_website_security.py",
                 AUTH / "tests/test_website_device_boundaries.py",
                 AUTH / "tests/test_identity.py", AUTH / "tests/test_account_token_revocation.py"]
    for path in additions:
        name = path.relative_to(AUTH).as_posix()
        if name in files:
            raise SystemExit(f"Production already has this addition; rebase before proceeding: {name}")
        files[name] = path.read_bytes()

    replace("app/config.py", "    password_reset_code_expire_minutes: int = 10",
        '    website_accounts_enabled: bool = False\n    website_origin: str = "https://mona-ai.cn"\n'
        '    website_session_hours: int = Field(default=168, ge=1, le=720)\n'
        '    wechat_login_enabled: bool = False\n    wechat_app_id: str = ""\n'
        '    wechat_app_secret: str = Field(default="", repr=False)\n\n'
        '    password_reset_code_expire_minutes: int = 10')
    replace("app/models.py", '    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)',
        '    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)\n'
        '    credential_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")')
    replace("app/auth.py", "from app.config import settings", "from app.config import settings\nfrom app.errors import AuthError")
    replace("app/auth.py", "                        device_version: str | None = None,\n                        expires_at:",
            "                        device_version: str | None = None,\n                        credential_version: int = 0,\n                        expires_at:")
    replace("app/auth.py", '        "scope": "account",', '        "scope": "account",\n        "cv": credential_version,')
    replace("app/auth.py", "def create_model_access_token(",
        'def validate_account_token_version(payload: dict, current_version: int) -> None:\n'
        '    version = payload.get("cv", 0)\n'
        '    if isinstance(version, bool) or not isinstance(version, int) or version != current_version:\n'
        '        raise AuthError("account_session_revoked", "账号凭据已更新，请重新登录。", 401)\n\n\n'
        'def create_model_access_token(')
    replace("app/deps.py", "from app.auth import decode_access_token", "from app.auth import decode_access_token, validate_account_token_version")
    replace("app/deps.py", "from app.models import User", "from app.models import User\nfrom app.website_sessions import validate_website_session")
    replace("app/deps.py", "    validate_device_claims(db, user.id, payload)\n    return user",
        "    validate_account_token_version(payload, user.credential_version)\n"
        "    validate_website_session(db, user.id, payload)\n    validate_device_claims(db, user.id, payload)\n    return user")
    source = (AUTH / "app/deps.py").read_text(encoding="utf-8-sig")
    helper = next(node for node in ast.parse(source).body
                  if isinstance(node, ast.FunctionDef) and node.name == "get_device_management_user")
    replace("app/deps.py", "def get_current_device(",
            ast.get_source_segment(source, helper) + "\n\n\ndef get_current_device(")
    replace("app/deps.py", "    if payload.get(\"sid\") is None and payload.get(\"dv\") is None:",
            '    if "wsid" in payload:\n'
            '        raise AuthError("desktop_upgrade_required", "请升级 Mona 并重新登录，以继续使用 Mona AI。", 401)\n'
            '    if payload.get("sid") is None and payload.get("dv") is None:')
    name = "app/routers/desktop_auth_router.py"
    replace(name, "from app.deps import bearer_scheme, get_current_device, get_current_user",
            "from app.deps import bearer_scheme, get_current_device, get_current_user, get_device_management_user")
    replace(name, "def list_desktop_devices(user: User = Depends(get_current_user),",
            "def list_desktop_devices(user: User = Depends(get_device_management_user),")
    replace(name, "def revoke_desktop_device(body: DeviceReplacement, user: User = Depends(get_current_user),",
            "def revoke_desktop_device(body: DeviceReplacement, user: User = Depends(get_device_management_user),")
    for name, count in (("app/routers/device_router.py", 4), ("app/routers/trial_router.py", 2)):
        replace(name, "from app.deps import get_current_user", "from app.deps import get_device_management_user")
        replace(name, "Depends(get_current_user)", "Depends(get_device_management_user)", count)
    replace("app/device_sessions.py", "def _token(device: AccountDeviceSession, entitlements: dict) -> dict:",
            "def _token(device: AccountDeviceSession, entitlements: dict, credential_version: int) -> dict:")
    replace("app/device_sessions.py", "device_version=device.token_version, expires_at=device.expires_at.replace(tzinfo=timezone.utc))",
            "device_version=device.token_version, credential_version=credential_version, expires_at=device.expires_at.replace(tzinfo=timezone.utc))")
    replace("app/device_sessions.py", "_token(current, entitlements)", "_token(current, entitlements, user.credential_version)", 2)

    name = "app/routers/auth_router.py"
    replace(name, "from app.device_sessions import revoke_all_devices", "from app.device_sessions import lock_account, revoke_all_devices")
    replace(name, "create_access_token(user.id)", "create_access_token(user.id, credential_version=user.credential_version)", 2)
    source = (AUTH / name).read_text(encoding="utf-8-sig")
    helper = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == "create_registered_account")
    replace(name, '@router.post("/register", response_model=TokenResponse)',
            ast.get_source_segment(source, helper) + '\n\n\n@router.post("/register", response_model=TokenResponse)')
    replace(name, "    reset_code.used = True\n    user.password_hash = hash_password(body.new_password)",
            '    lock_account(db, user.id)\n    db.refresh(user)\n    db.refresh(reset_code)\n'
            '    if reset_code.used:\n        raise AuthError("invalid_code", "Invalid or expired verification code", 400)\n'
            '    reset_code.used = True\n    user.password_hash = hash_password(body.new_password)\n    user.credential_version += 1')
    replace(name, "    if not verify_password(body.old_password, current_user.password_hash):",
            "    lock_account(db, current_user.id)\n    db.refresh(current_user)\n    if not verify_password(body.old_password, current_user.password_hash):")
    replace(name, "    current_user.password_hash = hash_password(body.new_password)",
            "    current_user.password_hash = hash_password(body.new_password)\n    current_user.credential_version += 1")
    # Legacy device-trial/registration/subscribe code is deliberately preserved.
    replace("app/main.py", "from app.routers.auth_router import router as auth_router",
        "from app.routers.auth_router import router as auth_router\n"
        "from app.routers.identity_router import router as identity_router\n"
        "from app.routers.website_account_router import router as website_account_router\n"
        "from app.website_security import configure_website_security")
    replace("app/main.py", "app.include_router(auth_router)",
            "app.include_router(auth_router)\napp.include_router(identity_router)\napp.include_router(website_account_router)")
    replace("app/main.py", "app.add_exception_handler(AuthError, auth_error_handler)",
            "app.add_exception_handler(AuthError, auth_error_handler)\nconfigure_website_security(app)")
    replace("alembic/env.py", "from app.device_models import AccountDeviceSession  # noqa: F401",
            "from app.device_models import AccountDeviceSession  # noqa: F401\nfrom app import website_models  # noqa: F401")
    replace("app/email.py", "import smtplib", "import smtplib\nimport ssl")
    replace("app/email.py", "smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=30)",
            "smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=30, context=ssl.create_default_context())")
    replace("app/email.py", "server.starttls()", "server.starttls(context=ssl.create_default_context())")

    for name, data in files.items():
        if name.endswith(".py"):
            ast.parse(data.decode("utf-8-sig"), filename=name)
    changed = [name for name in files if files[name] != original.get(name)]
    manifest = {"format": "mona-website-accounts-candidate-v1", "production_root": baseline["root"],
                "baseline_archive_sha256": args.expected_sha, "baseline_sha256": baseline["files"],
                "files": {name: sha(value) for name, value in files.items()}, "changed_paths": sorted(changed),
                "contains_credentials": False, "deployed": False}
    args.output.mkdir(parents=True)
    for name, data in files.items():
        path = args.output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (args.output / "candidate-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output), "files": len(files), "changed_paths": sorted(changed)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
