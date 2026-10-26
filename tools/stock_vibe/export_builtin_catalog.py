"""Generate the fixed strategy display catalog from the pinned native source.

Generation uses the managed financial interpreter; --check is a fast, offline
source-pin and artifact check and does not need that interpreter or start Vibe.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "third_party/vibe-trading"
OUTPUT = ROOT / "webui/src/lib/stock-vibe-builtin-catalog.generated.json"
DETAIL_FIELDS = {
    "strategy_id", "version", "name", "source", "example", "deleted", "market", "interval",
    "description", "can_scan", "can_backtest", "unavailable_reason", "parameters", "has_evidence",
    "linked_run", "effective_config", "rules",
}


class CatalogExportError(ValueError):
    pass


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _items_bytes(items: list[dict]) -> bytes:
    return json.dumps(items, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def source_pins() -> dict:
    lock_path = SNAPSHOT / "source-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    return {
        "snapshot_id": lock["snapshot_id"],
        "source_lock_sha256": _sha256(lock_path.read_bytes()),
        "requirements_lock_sha256": _sha256((SNAPSHOT / "requirements-windows-cp313.lock").read_bytes()),
        "patches": [{"path": path.name, "sha256": _sha256(path.read_bytes())}
                    for path in sorted((SNAPSHOT / "patches").glob("*.json"))],
        "exporter_sha256": _sha256(Path(__file__).read_bytes().replace(b"\r\n", b"\n")),
    }


def validate_catalog(value: dict) -> None:
    expected = source_pins()
    if not isinstance(value, dict) or value.get("schema_version") != 1 or not isinstance(value.get("source"), dict):
        raise CatalogExportError("Invalid built-in catalog schema")
    source = value["source"]
    if set(source) != {*expected, "items_sha256"} or any(source.get(key) != data for key, data in expected.items()):
        raise CatalogExportError("Built-in catalog source pins are stale; regenerate it")
    items = value.get("items")
    if not isinstance(items, list) or len(items) != 20:
        raise CatalogExportError("Built-in catalog must contain all 20 native entries")
    if source.get("items_sha256") != _sha256(_items_bytes(items)):
        raise CatalogExportError("Built-in catalog content checksum does not match")
    identities = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != DETAIL_FIELDS:
            raise CatalogExportError("Invalid built-in strategy detail fields")
        identity = item["strategy_id"]
        if (not isinstance(identity, str) or not re.fullmatch(r"builtin:[A-Za-z0-9_.-]{1,128}", identity)
                or ".." in identity or identity in identities
                or not re.fullmatch(r"[a-f0-9]{64}", str(item["version"]))):
            raise CatalogExportError("Invalid built-in strategy identity")
        identities.add(identity)
        if (item["source"] != "builtin" or item["example"] is not True or item["deleted"] is not False
                or item["has_evidence"] is not False or item["linked_run"] is not None
                or item["effective_config"] is not None):
            raise CatalogExportError("Built-in display data contains user or execution state")
        if (not isinstance(item["parameters"], list) or not isinstance(item["rules"], list)
                or not isinstance(item["can_scan"], bool) or not isinstance(item["can_backtest"], bool)):
            raise CatalogExportError("Invalid built-in strategy presentation data")
        for text in _strings(item):
            if text.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", text):
                raise CatalogExportError("Built-in display data contains a local absolute path")


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from _strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _strings(child)


def resolve_output(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = ROOT / path
    path = path.resolve()
    if not path.is_relative_to(ROOT.resolve()):
        raise CatalogExportError("Catalog output must resolve inside this repository")
    return path


def native_python(explicit: str | None = None) -> Path:
    from mona.config.paths import get_target_managed_runtimes_dir
    from mona.runtime.manager import RuntimeComponentStore
    from mona.runtime.python_env import PythonEnvironmentBuilder

    runtime_root = get_target_managed_runtimes_dir().resolve()
    if explicit:
        path = Path(explicit).expanduser()
        path = (path if path.is_absolute() else ROOT / path).resolve(strict=True)
        if not path.is_relative_to(runtime_root) and not path.is_relative_to(ROOT.resolve()):
            raise CatalogExportError("Native Python must be in the managed runtime or repository")
    else:
        store = RuntimeComponentStore(runtime_root)
        active = store.active("stock-vibe")
        if active is None:
            raise CatalogExportError("The managed stock-vibe runtime is not installed")
        manifest, _bundle = active
        path = PythonEnvironmentBuilder(runtime_root, store, environment="stock-vibe").python_for(
            [f"{manifest.id}@{manifest.version}"])
        if path is None:
            raise CatalogExportError("The managed stock-vibe Python environment is not ready")
        path = path.resolve(strict=True)
        if not path.is_relative_to(runtime_root):
            raise CatalogExportError("Managed native Python escapes its runtime root")
    if not path.is_file():
        raise CatalogExportError("Native Python must be a regular file")
    return path


_EXPORT = r'''
import importlib.metadata
import importlib.util
import json
import re
import socket
import sys
from pathlib import Path

if sys.version_info[:2] != (3, 13):
    raise RuntimeError('Built-in catalog generation requires the locked Python 3.13 runtime')

def deny(*args, **kwargs):
    raise RuntimeError('Network access is forbidden during built-in catalog export')

socket.create_connection = deny
socket.getaddrinfo = deny
socket.socket.connect = deny
socket.socket.connect_ex = deny
normalize = lambda name: re.sub(r'[-_.]+', '-', name).lower()
pins = dict(re.findall(r'^([A-Za-z0-9_.-]+)==([^\s\\]+)', Path(sys.argv[1]).read_text(encoding='utf-8'), re.M))
for package, version in pins.items():
    if importlib.metadata.version(package) != version:
        raise RuntimeError('Native Python does not match the pinned financial requirements')
from src.api import mona_strategy_library as library
distributions = importlib.metadata.packages_distributions()
locked = {normalize(name) for name in pins}
for row in library._builtin_entries():
    dependency = row['dependency']
    if dependency:
        available = importlib.util.find_spec(dependency) is not None
        pinned = any(normalize(name) in locked for name in distributions.get(dependency, []))
        if available != pinned:
            raise RuntimeError('Optional strategy dependency availability differs from the locked component')
page = library.strategy_catalog(source='builtin', market='all', limit=100)
if page['total'] != 20 or len(page['items']) != page['total']:
    raise RuntimeError('Native built-in strategy catalog is incomplete')
print(json.dumps(page['items'], ensure_ascii=False, sort_keys=True))
'''


def generate(python: Path) -> dict:
    from tools.stock_vibe.prepare import prepare

    scratch = ROOT / ".codex_tmp"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="builtin-catalog-export-", dir=scratch) as temporary:
        staging = Path(temporary)
        receipt = prepare(SNAPSHOT, staging / "source")
        home = staging / "home"
        home.mkdir()
        env = {key: value for key, value in os.environ.items() if key.upper() in {
            "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"}}
        env.update(PYTHONPATH=str(staging / "source/agent"), PYTHONUTF8="1", PYTHONNOUSERSITE="1",
            PYTHONDONTWRITEBYTECODE="1", PYTHON_DOTENV_DISABLED="1", VIBE_TRADING_HOME=str(home),
            VIBE_TRADING_HOSTED="1", VIBE_TRADING_ENABLE_SCHEDULER="false",
            VIBE_TRADING_CHANNELS_AUTO_START="false", HOME=str(home), USERPROFILE=str(home),
            APPDATA=str(home), LOCALAPPDATA=str(home))
        result = subprocess.run([str(python), "-c", _EXPORT, str(SNAPSHOT / "requirements-windows-cp313.lock")],
            cwd=home, env=env, capture_output=True, encoding="utf-8", timeout=90, check=False)
        if result.returncode != 0:
            raise CatalogExportError("Native built-in metadata export failed: " + result.stderr.strip())
        items = json.loads(result.stdout.splitlines()[-1])
        source = source_pins()
        if receipt["snapshot_id"] != source["snapshot_id"] or [
                {"path": item["path"], "sha256": item["sha256"]} for item in receipt["patches"]] != source["patches"]:
            raise CatalogExportError("Source pins changed during catalog generation")
        value = {"schema_version": 1, "source": {**source, "items_sha256": _sha256(_items_bytes(items))}, "items": items}
        validate_catalog(value)
        return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Check pins and generated data without starting native Python")
    parser.add_argument("--output", default=str(OUTPUT), help="Catalog path inside this repository")
    parser.add_argument("--python", help="Explicit managed/repository native Python, for generation only")
    args = parser.parse_args(argv)
    try:
        output = resolve_output(args.output)
        if args.check:
            validate_catalog(json.loads(output.read_text(encoding="utf-8")))
            print("Fixed built-in strategy catalog is current (20 entries)")
        else:
            value = generate(native_python(args.python or os.environ.get("MONA_VIBE_TEST_PYTHON")))
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
            print(f"Generated 20 fixed built-in strategy entries: {output.relative_to(ROOT)}")
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    raise SystemExit(main())
