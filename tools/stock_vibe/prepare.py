"""Verify and unpack the pinned source, then apply exact, classified host patches."""

from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

from tools.stock_vibe.snapshot import verify_snapshot


def prepare(snapshot_root: Path, destination: Path) -> dict:
    lock = verify_snapshot(snapshot_root)
    destination = destination.resolve()
    if destination.exists():
        raise FileExistsError("Build destination must not exist; use a fresh directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    patch_files = sorted((snapshot_root / "patches").glob("*.json"))
    patches = []
    for path in patch_files:
        raw = path.read_bytes()
        patches.append((path, json.loads(raw), hashlib.sha256(raw).hexdigest()))
    # Stage beside the destination so a failed patch never exposes a partial build.
    with tempfile.TemporaryDirectory(prefix=".vibe-source-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "source"
        staging.mkdir()
        with zipfile.ZipFile(snapshot_root / lock["archive"]["path"]) as archive:
            for member in archive.infolist():
                target = (staging / member.filename).resolve()
                if not target.is_relative_to(staging):
                    raise ValueError("Archive path escapes build root")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(member))
        applied = []
        for path, patch, patch_sha256 in patches:
            if patch["snapshot_id"] != lock["snapshot_id"]:
                raise ValueError(f"Patch targets a different snapshot: {path.name}")
            for change in patch["files"]:
                target = (staging / change["path"]).resolve()
                if not target.is_relative_to(staging):
                    raise ValueError("Patch path escapes build root")
                original = target.read_bytes()
                if hashlib.sha256(original).hexdigest() != change["sha256"]:
                    raise ValueError(f"Patch source mismatch: {change['path']}")
                content = original.decode("utf-8").replace("\r\n", "\n")
                for edit in change["replacements"]:
                    if content.count(edit["before"]) != edit["count"]:
                        raise ValueError(f"Patch text mismatch: {change['path']}")
                    content = content.replace(edit["before"], edit["after"])
                target.write_text(content, encoding="utf-8", newline="\n")
            for relative, content in patch.get("additions", {}).items():
                target = (staging / relative).resolve()
                if not target.is_relative_to(staging) or target.exists():
                    raise ValueError("Patch addition conflicts or escapes build root")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8", newline="\n")
            applied.append({"path": path.name, "category": patch["category"],
                            "sha256": patch_sha256})
        receipt = {"schema_version": 1, "snapshot_id": lock["snapshot_id"], "patches": applied}
        (staging / "agent" / "mona-source.json").write_text(
            json.dumps(receipt, indent=2) + "\n", encoding="utf-8",
        )
        staging.rename(destination)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot-root", type=Path, default=Path("third_party/vibe-trading"))
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.snapshot_root, args.destination), indent=2))


if __name__ == "__main__":
    main()
