"""Offline operator recovery. Never replays a model, shell command, upload, or original input."""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

from filelock import FileLock

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.sandbox import DockerSandbox, container_name
from mona.hosted_work.store import WorkStore


async def confirm_absent(config: HostedWorkConfig, owner: str, record_id: str):
    sandbox = DockerSandbox(config, owner, record_id, Path(config.state_dir) / "users" / owner / "workspace.zip")
    _, output = await sandbox._invoke(["ps", "-a", "--filter", f"name=^/{container_name(owner, record_id)}$", "--format", "{{.Names}}"])
    if output.strip():
        raise WorkError("container_exists", "原隔离容器仍存在；请先核对并结束原执行，不能直接解锁。", 409)


def main():
    parser = argparse.ArgumentParser(description="Offline review of unknown online Work results")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--owner")
    parser.add_argument("--kind", choices=["run", "file"])
    parser.add_argument("--id", dest="record_id")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-executors-stopped", action="store_true")
    parser.add_argument("--acknowledge-unknown-result", action="store_true")
    parser.add_argument("--note", default="")
    args = parser.parse_args()
    raw = json.loads(args.config.read_text(encoding="utf-8"))
    config = HostedWorkConfig.model_validate(raw.get("hosted_work", raw.get("hostedWork", {})))
    root = Path(config.state_dir).resolve(strict=True)
    if not (root / "sessions.sqlite3").is_file() or (root / "sessions.sqlite3").is_symlink():
        raise SystemExit("Existing hosted state database is required.")
    with FileLock(str(root / "service.lock"), timeout=0):
        store = WorkStore(root / "sessions.sqlite3", config)
        try:
            if not args.apply:
                print(json.dumps({"unknown": store.unknown_records(), "changed": False}, ensure_ascii=False))
                return
            if (sys.platform != "linux" or not args.confirm_executors_stopped or not args.acknowledge_unknown_result
                    or not args.owner or not re.fullmatch(r"[a-f0-9]{64}", args.owner) or not args.kind
                    or not args.note.strip() or len(args.note.strip()) > 500):
                raise SystemExit("Stop the service and its owned native processes; explicit confirmations, exact owner/kind/id and a note are required.")
            identifier(args.record_id)
            home = root / "users" / args.owner
            if not home.is_dir() or home.is_symlink():
                raise SystemExit("The exact owned runtime directory must exist.")
            with FileLock(str(home / "execution.lock"), timeout=0):
                asyncio.run(confirm_absent(config, args.owner, args.record_id))
                store.resolve_unknown(args.owner, args.kind, args.record_id, args.note)
            print(json.dumps({"id": args.record_id, "tracking_closed": True, "result_still_unknown": True,
                              "replayed": False}, ensure_ascii=False))
        finally:
            store.close()


if __name__ == "__main__":
    main()
