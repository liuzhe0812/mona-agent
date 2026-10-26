from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_ROOT = REPO_ROOT / "third_party" / "vibe-trading"
PROBE = """
import json
import os
from pathlib import Path

home_before = os.environ.get("HOME")
profile_before = os.environ.get("USERPROFILE")
from src.config import migrate
from src.config.paths import (
    get_config_path,
    get_runs_dir,
    get_runtime_root,
    get_sessions_dir,
    get_swarm_runs_dir,
    get_uploads_dir,
    get_workspace_path,
)
from src.api.helpers import ENV_PATH, LEGACY_ENV_PATH
from src.agent.skills import USER_SKILLS_DIR
from src.hypotheses.registry import default_hypotheses_path
from src.memory.persistent import MEMORY_BASE
from src.memory.search_index import _DEFAULT_DB_PATH
from src.providers import llm
from src.swarm.presets import USER_PRESETS_DIR
from src.tools.report_artifacts import reports_root
from src.tools.path_utils import allowed_write_roots
import src.config.paths as paths_module

sentinel_key = os.environ["STOCK_VIBE_TEST_SENTINEL_KEY"]
llm._ensure_dotenv()
root = get_runtime_root().resolve()
legacy_root = Path(os.environ["STOCK_VIBE_TEST_LEGACY_ROOT"]).resolve()
expected_legacy_root = migrate.default_legacy_root().resolve()
legacy_sentinel = legacy_root / "sessions" / "mona-source-isolation-sentinel.txt"
migrated = migrate.migrate_legacy_state()

path_map = {
    "runtime": get_runtime_root(),
    "config": get_config_path(),
    "sessions": get_sessions_dir(),
    "runs": get_runs_dir(),
    "swarm_runs": get_swarm_runs_dir(),
    "swarm_presets": USER_PRESETS_DIR,
    "uploads": get_uploads_dir(),
    "workspace": get_workspace_path(),
    "memory": MEMORY_BASE,
    "memory_index": _DEFAULT_DB_PATH,
    "hypotheses": default_hypotheses_path(),
    "skills": USER_SKILLS_DIR,
    "dotenv": ENV_PATH,
    "legacy_dotenv": LEGACY_ENV_PATH,
    "generated_reports": reports_root(),
    "shadow_reports": root / "shadow_reports",
    "alpha_bench_reports": root / "reports",
}
write_roots = allowed_write_roots()
print(json.dumps({
    "root": str(root),
    "paths": {name: str(path.resolve()) for name, path in path_map.items()},
    "write_roots": [str(path.resolve()) for path in write_roots],
    "paths_module": str(Path(paths_module.__file__).resolve()),
    "dotenv_candidates": [str(path.resolve()) for path in llm._ENV_CANDIDATES],
    "cwd_sentinel_loaded": sentinel_key in os.environ,
    "home_unchanged": home_before == os.environ.get("HOME"),
    "profile_unchanged": profile_before == os.environ.get("USERPROFILE"),
    "legacy_root": str(expected_legacy_root),
    "legacy_sentinel_exists": legacy_sentinel.exists(),
    "legacy_dest_exists": (root / "sessions" / legacy_sentinel.name).exists(),
    "migration_result": bool(migrated),
}, ensure_ascii=False))
"""


def _copy_snapshot(tmp_path: Path) -> Path:
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    for name in ("source-lock.json", "files.json", "vibe-trading-source.zip"):
        shutil.copyfile(SNAPSHOT_ROOT / name, snapshot / name)
    shutil.copytree(SNAPSHOT_ROOT / "patches", snapshot / "patches")
    return snapshot


@pytest.mark.parametrize("artifact", ("archive", "manifest"))
def test_tampered_source_is_rejected_without_creating_destination(
    tmp_path: Path, artifact: str
) -> None:
    snapshot = _copy_snapshot(tmp_path)
    if artifact == "archive":
        with (snapshot / "vibe-trading-source.zip").open("ab") as stream:
            stream.write(b"tampered")
    else:
        manifest_path = snapshot / "files.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest[0]["sha256"] = "0" * 64
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    destination_parent = tmp_path / "output"
    destination = destination_parent / "native"
    with pytest.raises(ValueError):
        prepare(snapshot, destination)

    assert not destination.exists()
    assert not destination_parent.exists()


def test_exact_patch_failure_does_not_publish_partial_build(tmp_path: Path) -> None:
    snapshot = _copy_snapshot(tmp_path)
    patch_path = next((snapshot / "patches").glob("*.json"))
    patch = json.loads(patch_path.read_text(encoding="utf-8"))
    patch["files"][0]["replacements"][0]["before"] += "-mismatch"
    patch_path.write_text(json.dumps(patch), encoding="utf-8")

    destination_parent = tmp_path / "output"
    destination_parent.mkdir()
    destination = destination_parent / "native"
    with pytest.raises(ValueError, match="Patch text mismatch"):
        prepare(snapshot, destination)

    assert not destination.exists()
    assert list(destination_parent.iterdir()) == []


def test_receipt_hashes_the_patch_bytes_actually_applied(tmp_path, monkeypatch) -> None:
    snapshot = _copy_snapshot(tmp_path)
    patch_path = snapshot / "patches" / "0007-ashare-preset.json"
    raw = patch_path.read_bytes()
    original_write = Path.write_text
    published = []

    def publish_during_prepare(path, content, *args, **kwargs):
        result = original_write(path, content, *args, **kwargs)
        if path.name == "mona_ashare_research.yaml" and not published:
            published.append(True)
            updated = json.loads(raw)
            updated["reason"] += " replacement published while another build is preparing"
            original_write(patch_path, json.dumps(updated), encoding="utf-8")
        return result

    monkeypatch.setattr(Path, "write_text", publish_during_prepare)
    receipt = prepare(snapshot, tmp_path / "prepared")
    applied = next(patch for patch in receipt["patches"] if patch["path"] == patch_path.name)
    assert published
    assert applied["sha256"] == hashlib.sha256(raw).hexdigest()
    assert applied["sha256"] != hashlib.sha256(patch_path.read_bytes()).hexdigest()


def _controlled_runtime() -> tuple[Path, Path]:
    native_root = Path(
        os.environ.get(
            "STOCK_VIBE_NATIVE_ROOT", REPO_ROOT / ".codex_tmp" / "vibe-native-5"
        )
    )
    python = Path(
        os.environ.get(
            "STOCK_VIBE_TEST_PYTHON",
            REPO_ROOT / ".codex_tmp" / "vibe-venv-313" / "Scripts" / "python.exe",
        )
    )
    return native_root.resolve(), python.resolve()


def test_hosted_subprocess_uses_private_paths_and_skips_legacy_migration(
    tmp_path: Path,
) -> None:
    native_root, python = _controlled_runtime()
    agent_root = native_root / "agent"
    if not agent_root.is_dir() or not (agent_root / "mona-source.json").is_file():
        pytest.skip("prepare the controlled Vibe snapshot before running isolation checks")
    if not python.is_file():
        pytest.skip("set STOCK_VIBE_TEST_PYTHON to the installed controlled interpreter")
    receipt = json.loads((agent_root / "mona-source.json").read_text(encoding="utf-8"))
    source_lock = json.loads((SNAPSHOT_ROOT / "source-lock.json").read_text(encoding="utf-8"))
    expected_patches = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (SNAPSHOT_ROOT / "patches").glob("*.json")
    }
    assert receipt["snapshot_id"] == source_lock["snapshot_id"]
    assert {patch["path"]: patch["sha256"] for patch in receipt["patches"]} == expected_patches

    legacy_dirs = (
        agent_root / "sessions",
        agent_root / "runs",
        agent_root / ".swarm" / "runs",
        agent_root / "uploads",
    )
    if any(path.exists() for path in legacy_dirs):
        pytest.skip("refusing to add a migration sentinel beside existing build state")

    sentinel = f"safe-test-{uuid.uuid4().hex}"
    sentinel_key = "STOCK_VIBE_CWD_SENTINEL"
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    (cwd / ".env").write_text(f"{sentinel_key}={sentinel}\n", encoding="utf-8")
    probe_path = cwd / "probe.py"
    probe_path.write_text(PROBE, encoding="utf-8")

    private_root = tmp_path / "private-vibe-home"
    legacy_sessions = agent_root / "sessions"
    legacy_sessions.mkdir(parents=True)
    legacy_sentinel = legacy_sessions / "mona-source-isolation-sentinel.txt"
    legacy_sentinel.write_text("safe migration sentinel\n", encoding="utf-8")

    environment = {
        key: os.environ[key]
        for key in (
            "PATH",
            "SYSTEMROOT",
            "SYSTEMDRIVE",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
        )
        if key in os.environ
    }
    environment.update(
        {
            "PYTHONPATH": str(agent_root),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "VIBE_TRADING_HOME": str(private_root),
            "VIBE_TRADING_HOSTED": "1",
            "HOSTED": "1",
            "STOCK_VIBE_TEST_SENTINEL_KEY": sentinel_key,
            "STOCK_VIBE_TEST_LEGACY_ROOT": str(agent_root),
        }
    )
    result: subprocess.CompletedProcess[str] | None = None
    destination_sentinel = private_root / "sessions" / legacy_sentinel.name
    try:
        result = subprocess.run(
            [str(python), "-B", str(probe_path)],
            cwd=cwd,
            env=environment,
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    finally:
        legacy_sentinel.unlink(missing_ok=True)
        destination_sentinel.unlink(missing_ok=True)
        if legacy_sessions.exists():
            legacy_sessions.rmdir()

    assert result is not None
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    expected_root = private_root.resolve()
    assert Path(report["root"]) == expected_root
    assert all(
        Path(value) == expected_root or expected_root in Path(value).parents
        for value in report["paths"].values()
    )
    assert all(
        Path(value) == expected_root or expected_root in Path(value).parents
        for value in report["write_roots"]
    )
    assert Path(report["paths_module"]).is_relative_to(agent_root.resolve())
    assert all(
        Path(path) == expected_root or expected_root in Path(path).parents
        for path in report["dotenv_candidates"]
    )
    assert report["cwd_sentinel_loaded"] is False
    assert report["home_unchanged"] is True
    assert report["profile_unchanged"] is True
    assert Path(report["legacy_root"]) == agent_root.resolve()
    assert report["legacy_sentinel_exists"] is True
    assert report["legacy_dest_exists"] is False
    assert report["migration_result"] is False
