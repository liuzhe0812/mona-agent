"""Build an immutable Work release without desktop UI, Auth code, credentials or live user state."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import tarfile
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    frontend = root / "webui/dist-hosted-work"
    if not (frontend / "hosted-work.html").is_file():
        raise SystemExit("Build the independent Work frontend first.")
    files = set((root / "mona").rglob("*.py"))
    files.update((root / "mona/templates").rglob("*.md"))
    files.update((root / "tests/hosted_work").glob("*.py"))
    files.update(frontend.rglob("*"))
    for subtree in ("mona/development/sandbox_node", "deploy/hosted-work"):
        files.update((root / subtree).rglob("*"))
    files.update(root / name for name in ("pyproject.toml", "docs/architecture/hosted-work.md"))
    selected = sorted(path for path in files if path.is_file() and "__pycache__" not in path.parts)
    manifest = {}
    for path in selected:
        relative = path.relative_to(root)
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise SystemExit("Release sources must not contain symlinks or outside paths.")
        if any(part.startswith(".env") or part in {"node_modules", ".git", ".venv"} for part in relative.parts):
            raise SystemExit("Unexpected environment or generated directory in release input.")
        if path.stat().st_size > 16 * 1024 * 1024:
            raise SystemExit("Unexpected oversized release input.")
        manifest[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    destination = args.output.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise SystemExit("Refusing to overwrite an existing release artifact.")
    with destination.open("xb") as output, tarfile.open(fileobj=output, mode="w:gz") as archive:
        for path in selected:
            name = path.relative_to(root).as_posix()
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != manifest[name]:
                raise SystemExit("Release input changed during packaging.")
            item = tarfile.TarInfo(name)
            item.size, item.mode = len(data), 0o644
            archive.addfile(item, io.BytesIO(data))
        data = json.dumps({"format": "mona-work-release-v2", "business_dependency": "account-identity-only",
                           "files": manifest}, ensure_ascii=False, indent=2, sort_keys=True).encode()
        item = tarfile.TarInfo("deploy-manifest.json")
        item.size, item.mode = len(data), 0o600
        archive.addfile(item, io.BytesIO(data))
    print(json.dumps({"artifact": str(destination), "files": len(manifest), "bytes": destination.stat().st_size,
                      "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
