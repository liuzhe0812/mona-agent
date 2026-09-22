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

case "$(uname -m)" in
  arm64)
    arch="arm64"
    rust_target="aarch64-apple-darwin"
    ;;
  x86_64)
    arch="x64"
    rust_target="x86_64-apple-darwin"
    ;;
  *)
    die "unsupported macOS architecture: $(uname -m)"
    ;;
esac

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

case "$gateway_resource" in
  "$repo_root"/src-tauri/resources/mona-gateway) ;;
  *) die "gateway resource path is outside the repository" ;;
esac
rm -rf "$gateway_resource"

python -m PyInstaller --noconfirm --clean \
  --distpath "$build_root/gateway-dist" \
  --workpath "$build_root/gateway-work" \
  "$repo_root/mona-gateway.spec"

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
  "$repo_root"/dist/macos/arm64|"$repo_root"/dist/macos/x64) ;;
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

printf 'macOS release ready\n'
printf 'version: %s\n' "$version"
printf 'architecture: %s\n' "$arch"
printf 'app: %s\n' "$release_output/Mona.app"
printf 'dmg: %s\n' "$release_output/Mona_${version}_${arch}.dmg"
