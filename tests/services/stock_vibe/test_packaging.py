from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path

import pytest

from mona.runtime.manager import RuntimeComponentManifest
from tools.stock_vibe.snapshot import create_snapshot

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build-vibe-runtime.py"
_SPEC = importlib.util.spec_from_file_location("build_vibe_runtime", SCRIPT_PATH)
assert _SPEC is not None and _SPEC.loader is not None
build_vibe_runtime = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = build_vibe_runtime
_SPEC.loader.exec_module(build_vibe_runtime)


def _write(root: Path, relative: str, content: str | bytes) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))


def _fixture_snapshot(tmp_path: Path) -> tuple[Path, bytes]:
    source = tmp_path / "raw-source"
    root_files = {
        "LICENSE": "license fixture\n",
        "MANIFEST.in": "",
        "NOTICE": "notice fixture\n",
        "README.md": "source fixture\n",
        "pyproject.toml": '[project]\nname = "vibe-trading"\nversion = "0.1.16"\n',
        "requirements-lock.txt": "upstream-dependency==1.0.0\n",
        "requirements-channels-lock.txt": "channel-dependency==2.0.0\n",
        "desktop/electron/requirements-windows-lock.txt": "electron-dependency==3.0.0\n",
    }
    for relative, content in root_files.items():
        _write(source, relative, content)

    source_files = {
        "agent/api_server.py": "app = object()\n",
        "agent/scripts/build.py": "print('build helper')\n",
        "agent/tests/test_api.py": "def test_example(): pass\n",
        "agent/evals/eval.py": "print('eval')\n",
        "agent/frontend/index.html": "<html></html>\n",
        "agent/desktop/electron/main.py": "print('electron')\n",
        "agent/assets/banner.png": b"display-only",
        "agent/.cache/runtime.bin": b"cache",
        "agent/.vibe-trading/state.json": "{}\n",
        "agent/src/skills/example/SKILL.md": "# Example skill\n",
        "agent/src/skills/example/scripts/helper.py": "def helper(): return True\n",
        "agent/src/swarm/presets/ashare.yaml": "name: ashare\n",
        "agent/src/factors/example.py": "FACTOR = 'momentum'\n",
        "agent/src/shadow_account/templates/report.html": "<html>report</html>\n",
        "agent/src/shadow_account/assets/VibeCJK-Regular.ttf": b"font fixture",
    }
    for relative, content in source_files.items():
        _write(source, relative, content)

    snapshot = tmp_path / "snapshot"
    lock = create_snapshot(source, snapshot)
    patch_dir = snapshot / "patches"
    patch_dir.mkdir()
    (patch_dir / "0001-host-isolation.json").write_text(
        json.dumps({
            "snapshot_id": lock["snapshot_id"],
            "category": "host-isolation",
            "files": [],
            "additions": {},
        }),
        encoding="utf-8",
    )
    return snapshot, root_files["requirements-lock.txt"].encode("utf-8")


def _write_wheel(wheelhouse: Path) -> tuple[Path, str]:
    wheelhouse.mkdir(parents=True)
    wheel = wheelhouse / "demo_dep-1.2.3-py3-none-any.whl"
    dist_info = "demo_dep-1.2.3.dist-info/"
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            dist_info + "METADATA",
            "Metadata-Version: 2.1\nName: demo-dep\nVersion: 1.2.3\n\n",
        )
        archive.writestr(
            dist_info + "WHEEL",
            "Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        )
        archive.writestr(dist_info + "RECORD", "")
    return wheel, hashlib.sha256(wheel.read_bytes()).hexdigest()


def _lock(path: Path, wheel_hash: str) -> None:
    path.write_text(
        f"demo-dep==1.2.3 --hash=sha256:{wheel_hash}\n",
        encoding="utf-8",
    )


def test_build_packages_verified_runtime_and_keeps_native_resources(tmp_path: Path) -> None:
    snapshot, upstream_lock = _fixture_snapshot(tmp_path)
    wheelhouse = tmp_path / "wheelhouse"
    _wheel, wheel_hash = _write_wheel(wheelhouse)
    requirements_lock = tmp_path / "requirements-lock.txt"
    _lock(requirements_lock, wheel_hash)
    output = tmp_path / "output" / "stock-vibe.zip"

    build_vibe_runtime.build_runtime(
        snapshot_root=snapshot,
        wheelhouse=wheelhouse,
        requirements_lock=requirements_lock,
        output=output,
        version="0.1.16+stock.1",
    )

    sidecar_path = Path(f"{output}.receipt.json")
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    assert sidecar["package"]["bytes"] == output.stat().st_size
    assert sidecar["package"]["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()

    with zipfile.ZipFile(output) as archive:
        names = set(archive.namelist())
        manifest = RuntimeComponentManifest.model_validate_json(
            archive.read("runtime-manifest.json")
        )
        receipt = json.loads(archive.read("source-receipt.json"))

    assert manifest.id == "stock-vibe"
    assert manifest.kind == "stock-vibe-runtime"
    assert manifest.dependencies == ["python-base@3.13.15"]
    assert manifest.entrypoints == {"server": "agent/api_server.py"}
    assert manifest.python_environment == "stock-vibe"
    assert manifest.python_requirements == "python/requirements.lock"
    assert manifest.python_wheelhouse == "python/wheelhouse"

    assert "LICENSE" in names and "NOTICE" in names
    assert "agent/api_server.py" in names
    assert "agent/src/skills/example/SKILL.md" in names
    assert "agent/src/skills/example/scripts/helper.py" in names
    assert "agent/src/swarm/presets/ashare.yaml" in names
    assert "agent/src/factors/example.py" in names
    assert "agent/src/shadow_account/templates/report.html" in names
    assert "agent/src/shadow_account/assets/VibeCJK-Regular.ttf" in names
    assert not any(
        "agent/scripts/" in name
        or "agent/tests/" in name
        or "agent/evals/" in name
        or "agent/frontend/" in name
        or "agent/desktop/" in name
        or "agent/assets/" in name
        or "agent/.cache/" in name
        or ".vibe-trading/" in name
        for name in names
    )
    assert receipt["source"]["upstream_requirements_lock_sha256"] == hashlib.sha256(
        upstream_lock
    ).hexdigest()
    assert receipt["build"]["requirements_lock_sha256"] == hashlib.sha256(
        requirements_lock.read_bytes()
    ).hexdigest()
    assert receipt["inventory"]["wheel_count"] == 1
    assert receipt["inventory"]["wheel_bytes"] == len((wheelhouse / "demo_dep-1.2.3-py3-none-any.whl").read_bytes())
    assert "PythonEnvironmentBuilder" in receipt["required_before_t02_complete"]
    assert "source-receipt.json" not in {
        item["path"] for item in receipt["inventory"]["files"]
    }


def test_bad_wheel_hash_fails_without_publishing_package(tmp_path: Path) -> None:
    snapshot, _ = _fixture_snapshot(tmp_path)
    wheelhouse = tmp_path / "wheelhouse"
    _write_wheel(wheelhouse)
    requirements_lock = tmp_path / "requirements-lock.txt"
    _lock(requirements_lock, "0" * 64)
    output = tmp_path / "output" / "stock-vibe.zip"

    with pytest.raises(build_vibe_runtime.PackagingError, match="wheel hash"):
        build_vibe_runtime.build_runtime(
            snapshot_root=snapshot,
            wheelhouse=wheelhouse,
            requirements_lock=requirements_lock,
            output=output,
            version="0.1.16+stock.1",
        )

    assert not output.exists()
    assert not Path(f"{output}.receipt.json").exists()


def test_unpinned_requirement_fails_without_publishing_package(tmp_path: Path) -> None:
    snapshot, _ = _fixture_snapshot(tmp_path)
    wheelhouse = tmp_path / "wheelhouse"
    _wheel, wheel_hash = _write_wheel(wheelhouse)
    requirements_lock = tmp_path / "requirements-lock.txt"
    requirements_lock.write_text(
        f"demo-dep --hash=sha256:{wheel_hash}\n",
        encoding="utf-8",
    )
    output = tmp_path / "output" / "stock-vibe.zip"

    with pytest.raises(build_vibe_runtime.PackagingError, match="exact requirement"):
        build_vibe_runtime.build_runtime(
            snapshot_root=snapshot,
            wheelhouse=wheelhouse,
            requirements_lock=requirements_lock,
            output=output,
            version="0.1.16+stock.1",
        )

    assert not output.exists()
    assert not Path(f"{output}.receipt.json").exists()


def test_missing_wheelhouse_or_lock_fails_before_build(tmp_path: Path) -> None:
    output = tmp_path / "stock-vibe.zip"

    with pytest.raises(SystemExit) as error:
        build_vibe_runtime.main(["--output", str(output), "--version", "0.1.16+stock.1"])

    assert error.value.code == 2
    assert not output.exists()
