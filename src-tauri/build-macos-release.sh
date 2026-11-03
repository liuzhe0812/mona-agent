#!/usr/bin/env bash

set -euo pipefail
umask 022

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "macOS release builds must run on Darwin."
fi

[[ "$(uname -m)" == "arm64" ]] || die "Mona macOS releases require an Apple Silicon runner."
arch="arm64"
rust_target="aarch64-apple-darwin"

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd -P)"
repo_root="$(CDPATH= cd "$script_dir/.." && pwd -P)"
release_root="$repo_root/dist/macos"
release_output="$release_root/$arch"
gateway_resource="$script_dir/resources/mona-gateway"
office_manifest="$script_dir/resources/office-editor/manifest.json"
office_sidecar="$script_dir/resources/office-editor/sheets/xlsx-sidecar"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/mona-macos-release.XXXXXX")"

cleanup() {
  rm -rf "$build_root"
}
trap cleanup EXIT HUP INT TERM

for command in cargo codesign file lipo python; do
  command -v "$command" >/dev/null 2>&1 || die "$command was not found on PATH."
done

version="$(python - "$repo_root" <<'PY'
import sys
import tomllib
from pathlib import Path

root = Path(sys.argv[1])
versions = {
    "pyproject.toml": tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"],
    "src-tauri/Cargo.toml": tomllib.loads((root / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"))["package"]["version"],
    "src-tauri/tauri.conf.json": __import__("json").loads((root / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"],
}
if len(set(versions.values())) != 1:
    raise SystemExit(f"version mismatch: {versions}")
print(next(iter(versions.values())))
PY
)"

signing_identity="${APPLE_SIGNING_IDENTITY:--}"

# Tauri 只判断这些变量是否存在，空值同样会触发公证，因此 ad-hoc 构建必须移除它们。
if [[ "$signing_identity" == "-" ]]; then
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
fi

sign_file() {
  local path="$1"
  local args=(--force --sign "$signing_identity")
  if [[ "$signing_identity" != "-" ]]; then
    args+=(--options runtime --timestamp)
  fi
  codesign "${args[@]}" "$path"
}

sign_macho_files() {
  local root="$1"
  local path
  while IFS= read -r -d '' path; do
    if file -b "$path" | grep -q 'Mach-O'; then
      sign_file "$path"
    fi
  done < <(find "$root" -type f -print0)
}

verify_office_manifest() {
  python - "$office_manifest" "$office_sidecar" "$arch" <<'PY'
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

manifest_path = Path(sys.argv[1]).resolve()
sidecar = Path(sys.argv[2]).resolve()
expected_arch = sys.argv[3]
office_root = manifest_path.parent.resolve()
if sidecar.parent != office_root / "sheets" or not sidecar.is_file():
    raise SystemExit("bundled XLSX sidecar is missing or outside its resource directory")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
entry = manifest.get("xlsxSidecar")
if manifest.get("schemaVersion") != 1 or manifest.get("platform") != "macos" or manifest.get("arch") != expected_arch:
    raise SystemExit("bundled Office manifest has the wrong platform or architecture")
if not isinstance(entry, dict) or entry.get("path") != "sheets/xlsx-sidecar":
    raise SystemExit("bundled Office manifest has an invalid XLSX sidecar path")
entry_path = (office_root / entry["path"]).resolve()
if entry_path != sidecar or office_root not in entry_path.parents:
    raise SystemExit("bundled Office manifest sidecar path escapes its resource directory")
entry["size"] = sidecar.stat().st_size
entry["sha256"] = hashlib.sha256(sidecar.read_bytes()).hexdigest()
with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=office_root, delete=False) as stream:
    json.dump(manifest, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
    temporary = Path(stream.name)
os.replace(temporary, manifest_path)
PY
}

bash "$repo_root/webui/office-editor/scripts/build-xlsx-sidecar.sh"
[[ -x "$office_sidecar" ]] || die "macOS XLSX sidecar was not produced."
sign_file "$office_sidecar"
verify_office_manifest

npm --prefix "$repo_root/webui" run build:video-runtime

(
  cd "$repo_root"
  python scripts/prepare_bundled_runtimes.py --platform darwin --architecture "$arch"
)

case "$gateway_resource" in
  "$repo_root"/src-tauri/resources/mona-gateway) ;;
  *) die "gateway resource path is outside the repository" ;;
esac
rm -rf "$gateway_resource"

(
  cd "$repo_root"
  python -m PyInstaller --noconfirm --clean \
    --distpath "$build_root/gateway-dist" \
    --workpath "$build_root/gateway-work" \
    "$repo_root/mona-gateway.spec"
)

gateway_output="$build_root/gateway-dist/mona-gateway"
[[ -d "$gateway_output" && -x "$gateway_output/mona-gateway" ]] || die "Gateway onedir output was not produced."
mv "$gateway_output" "$gateway_resource"
"$gateway_resource/mona-gateway" --help >/dev/null
"$gateway_resource/mona-gateway" --version | grep -Fq "v$version" || die "gateway version does not match $version"
sign_macho_files "$gateway_resource"

(
  cd "$script_dir"
  cargo tauri build --target "$rust_target" --bundles app,dmg
)

bundle_root="$script_dir/target/$rust_target/release/bundle"
app_source="$bundle_root/macos/Mona.app"
dmg_source="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
[[ -d "$app_source" ]] || die "Mona.app was not produced."
[[ -n "$dmg_source" && -f "$dmg_source" ]] || die "macOS DMG was not produced."

case "$release_output" in
  "$repo_root"/dist/macos/arm64) ;;
  *) die "release output path is outside the repository" ;;
esac
rm -rf "$release_output"
mkdir -p "$release_output"
cp -R "$app_source" "$release_output/Mona.app"
cp "$dmg_source" "$release_output/Mona_${version}_${arch}.dmg"

codesign --verify --deep --strict "$release_output/Mona.app"
packaged_gateway="$(find "$release_output/Mona.app" -type f -path '*/mona-gateway/mona-gateway' -print -quit)"
[[ -n "$packaged_gateway" ]] || die "packaged app is missing the gateway."
"$packaged_gateway" --version | grep -Fq "v$version" || die "packaged gateway version does not match $version"
packaged_manifest="$(find "$release_output/Mona.app" -type f -path '*/desktop-resources/office-editor/manifest.json' -print -quit)"
[[ -n "$packaged_manifest" ]] || die "packaged app is missing the Office resource manifest."
python - "$packaged_manifest" "$arch" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
if manifest.get("schemaVersion") != 1 or manifest.get("platform") != "macos" or manifest.get("arch") != sys.argv[2]:
    raise SystemExit("packaged Office manifest does not match the native build architecture")
PY

packaged_runtime_manifest="$(find "$release_output/Mona.app" -type f -path '*/desktop-resources/runtime-base/manifest.json' -print -quit)"
[[ -n "$packaged_runtime_manifest" ]] || die "packaged app is missing the bundled runtime manifest."
(
  cd "$repo_root"
  python - "$(dirname "$packaged_runtime_manifest")" "$arch" "$build_root" <<'PY'
import asyncio
import os
import subprocess
from pathlib import Path
import sys

from mona.runtime.bundled import load_bundled_runtime
from mona.runtime.jobs import RuntimeInstallJobManager
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.python_env import PythonEnvironmentBuilder

os.environ.pop("PYTHONHOME", None)
os.environ.pop("PYTHONPATH", None)
os.environ["PIP_NO_INDEX"] = "1"
payload = load_bundled_runtime(Path(sys.argv[1]), current_platform="darwin", current_architecture=sys.argv[2])
store = RuntimeComponentStore(Path(sys.argv[3]) / "runtime-smoke")
jobs = RuntimeInstallJobManager(
    catalog_client=None, component_store=store, state_path=store.root / "jobs.json", installer=None,
    current_platform="darwin", current_architecture=sys.argv[2], auto_download_enabled=lambda: False,
    bundled_runtime_root=payload.root,
)
if not asyncio.run(jobs.ensure_bundled()):
    raise SystemExit("packaged script runtime was not prepared")

for component_id, entrypoint in (("python-base", "python"), ("node-base", "node")):
    manifest, root = store.active(component_id)
    binary = root / manifest.entrypoints[entrypoint]
    actual_arch = subprocess.check_output(["lipo", "-archs", str(binary)], text=True).strip()
    if actual_arch != sys.argv[2]:
        raise SystemExit(f"packaged {component_id} architecture is {actual_arch}, expected {sys.argv[2]}")

builder = PythonEnvironmentBuilder(store.root, store, current_platform="darwin")
python = builder.python_for(payload.python_refs)
if python is None:
    raise SystemExit("packaged Python environment was not prepared")
subprocess.run([str(python), "-I", "-c", "import defusedxml, lxml.etree, PIL, pymupdf, websockets"], check=True)
node_manifest, node_root = store.active("node-base")
node_dir = (node_root / node_manifest.entrypoints["node"]).parent
for executable in ("node", "npm", "npx"):
    subprocess.run([str(node_dir / executable), "--version"], check=True, stdout=subprocess.DEVNULL)

print("Verified packaged Python, Node and common libraries using an isolated offline environment.")
PY
)

packaged_native_catalog="$(find "$release_output/Mona.app" -type f -path '*/mona/runtime/native-tools.json' -print -quit)"
[[ -n "$packaged_native_catalog" ]] || die "packaged app is missing the built-in native runtime catalog."
(
  cd "$repo_root"
  python - "$packaged_native_catalog" "$arch" "$build_root" <<'PY'
import asyncio
import json
import subprocess
import sys
from pathlib import Path

from mona.runtime import native_packaging
from mona.runtime.catalog import RuntimeCatalog, RuntimeCatalogClient, RuntimeInstaller
from mona.runtime.download import VerifiedDownloader
from mona.runtime.jobs import RuntimeInstallJobManager
from mona.runtime.manager import RuntimeComponentStore

catalog_path = Path(sys.argv[1])
catalog = RuntimeCatalog.model_validate_json(catalog_path.read_text(encoding="utf-8"))
native_packaging._FFMPEG_LICENSES = catalog_path.parent / "licenses" / "ffmpeg-6.1.1"
store = RuntimeComponentStore(Path(sys.argv[3]) / "runtime-smoke")
client = RuntimeCatalogClient([], store.root / "catalog.json", bundled_catalog=catalog)
installer = RuntimeInstaller(
    catalog_client=client, downloader=VerifiedDownloader(), store=store, cache_dir=store.root / "downloads",
    current_platform="darwin", current_architecture=sys.argv[2],
)
jobs = RuntimeInstallJobManager(
    catalog_client=client, component_store=store, state_path=store.root / "native-jobs.json", installer=installer,
    current_platform="darwin", current_architecture=sys.argv[2], auto_download_enabled=lambda: True,
)

async def prepare():
    await jobs.ensure("browser")
    await jobs.ensure("ffmpeg")

asyncio.run(prepare())

def executable(component, name):
    active = store.active(component)
    if active is None or name not in active[0].entrypoints:
        raise SystemExit(f"managed {component} was not installed")
    return active[1] / active[0].entrypoints[name]

browser = executable("browser-chromium", "browser")
ffmpeg = executable("ffmpeg", "ffmpeg")
ffprobe = executable("ffprobe", "ffprobe")
for binary in (browser, ffmpeg, ffprobe):
    subprocess.run([str(binary), "--version" if binary == browser else "-version"],
                   check=True, stdout=subprocess.DEVNULL, timeout=30)
video = store.root / "smoke.mp4"
subprocess.run([
    str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "color=c=black:s=16x16:r=1", "-frames:v", "1", "-c:v", "libx264",
    "-pix_fmt", "yuv420p", "-y", str(video),
], check=True, timeout=60)
probe = subprocess.check_output([
    str(ffprobe), "-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,width,height", "-of", "json", str(video),
], timeout=30, text=True)
streams = json.loads(probe)["streams"]
if len(streams) != 1 or (streams[0]["codec_name"], streams[0]["width"], streams[0]["height"]) != ("h264", 16, 16):
    raise SystemExit("managed video encoder or probe did not produce the expected frame")
print("Verified on-demand browser, FFmpeg and FFprobe using an isolated runtime store.")
PY
)

printf 'macOS release ready\n'
printf 'version: %s\n' "$version"
printf 'architecture: %s\n' "$arch"
printf 'app: %s\n' "$release_output/Mona.app"
printf 'dmg: %s\n' "$release_output/Mona_${version}_${arch}.dmg"
