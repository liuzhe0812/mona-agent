"""Explicit server entry: python -m mona.hosted_work --config <operator-owned file>."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from aiohttp import web
from filelock import FileLock

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import private_listener, website_origin
from mona.hosted_work.auth_client import AuthClient
from mona.hosted_work.contracts import private_directory
from mona.hosted_work.executor import ProcessExecutor
from mona.hosted_work.sandbox import DockerSandbox
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore


def main():
    parser = argparse.ArgumentParser(description="Mona online Work host (independent of desktop startup)")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise SystemExit("Hosted Work requires Ubuntu/Linux; desktop behavior is unchanged.")
    path = args.config.resolve(strict=True)
    data = json.loads(path.read_text(encoding="utf-8"))
    config = HostedWorkConfig.model_validate(data.get("hosted_work", data.get("hostedWork", {})))
    if not config.enabled or not Path(config.state_dir).is_absolute():
        raise SystemExit("Hosted Work needs explicit enablement and an absolute private state directory.")
    website_origin(config)
    bind_host = private_listener(config.bind_host)
    auth = AuthClient(config)
    root = private_directory(Path(config.state_dir))
    asyncio.run(DockerSandbox(config, "0" * 64, "0" * 32, root / "preflight-unused.zip").preflight())
    realm = {"format": "mona-hosted-work-v1", "auth_origin": auth.origin}
    with FileLock(str(root / "service.lock"), timeout=0):
        marker = root / "realm.json"
        if marker.exists():
            if json.loads(marker.read_text(encoding="utf-8")) != realm:
                raise SystemExit("This state directory belongs to another account service.")
        else:
            with marker.open("x", encoding="utf-8") as stream:
                json.dump(realm, stream)
        store = WorkStore(root / "sessions.sqlite3", config)
        store.recover()
        service = WorkService(config, store, auth, ProcessExecutor(config))
        app = create_app(service)
        async def shutdown(_app):
            await service.close()
            store.close()
        app.on_cleanup.append(shutdown)
        # Expose only the explicitly configured interface; never inherit 0.0.0.0.
        # Disable access logs so bearer tokens and user filenames aren't logged.
        web.run_app(app, host=bind_host, port=config.port, access_log=None)


if __name__ == "__main__":
    main()
