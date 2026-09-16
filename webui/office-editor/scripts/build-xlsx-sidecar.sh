#!/usr/bin/env bash

set -euo pipefail
umask 022

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "xlsx-sidecar macOS builds must run on Darwin; refusing to build on this host."
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
    die "unsupported macOS architecture: $(uname -m); expected arm64 or x86_64."
    ;;
esac

command -v cargo >/dev/null 2>&1 || die "cargo was not found on PATH."
command -v rustc >/dev/null 2>&1 || die "rustc was not found on PATH."
command -v shasum >/dev/null 2>&1 || die "shasum was not found on PATH."

script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd -P)"
office_editor_root="$(CDPATH= cd "$script_dir/.." && pwd -P)"
repo_root="$(CDPATH= cd "$office_editor_root/../.." && pwd -P)"
engine_root="$office_editor_root/vendor/genoffice/apps/sheets/native/xlsx-engine"
cargo_manifest="$engine_root/Cargo.toml"

[[ -f "$cargo_manifest" ]] || die "xlsx-sidecar Cargo.toml was not found: $cargo_manifest"

rust_host="$(rustc -vV | awk '$1 == "host:" { print $2; exit }')"
[[ "$rust_host" == "$rust_target" ]] || die \
  "native macOS build requires Rust host $rust_target; found '$rust_host'."

version="$(awk '
  /^\[package\][[:space:]]*$/ { in_package = 1; next }
  /^\[/ { if (in_package) exit }
  in_package && /^[[:space:]]*version[[:space:]]*=/ {
    value = $0
    sub(/^[^\"]*\"/, "", value)
    sub(/\".*$/, "", value)
    print value
    exit
  }
' "$cargo_manifest")"
[[ -n "$version" ]] || die "could not read the xlsx-sidecar version from $cargo_manifest"
[[ "$version" != *[![:alnum:].+_-]* ]] || die "invalid xlsx-sidecar version: $version"

(cd "$engine_root" && cargo build --release --manifest-path "$cargo_manifest" --target "$rust_target")

built_sidecar="$engine_root/target/$rust_target/release/xlsx-sidecar"
[[ -f "$built_sidecar" ]] || die "the release sidecar was not produced at $built_sidecar"

resource_root="$repo_root/src-tauri/resources/office-editor"
resource_sidecar_relpath="sheets/xlsx-sidecar"
resource_sidecar_dir="$resource_root/sheets"
manifest_path="$resource_root/manifest.json"

case "$resource_sidecar_relpath" in
  /*|../*|*/../*|*/..|*\\*)
    die "the xlsx-sidecar manifest entry is not a safe relative path: $resource_sidecar_relpath"
    ;;
esac

mkdir -p "$resource_sidecar_dir"
resource_root_abs="$(CDPATH= cd "$resource_root" && pwd -P)"
resource_sidecar_dir_abs="$(CDPATH= cd "$resource_sidecar_dir" && pwd -P)"
case "$resource_sidecar_dir_abs/" in
  "$resource_root_abs/"*) ;;
  *) die "the xlsx-sidecar resource directory escapes $resource_root_abs" ;;
esac

resource_sidecar="$resource_sidecar_dir_abs/xlsx-sidecar"
install -m 755 "$built_sidecar" "$resource_sidecar"
[[ -x "$resource_sidecar" ]] || die "the copied xlsx-sidecar is not executable: $resource_sidecar"

size="$(stat -f '%z' "$resource_sidecar")"
sha256="$(shasum -a 256 "$resource_sidecar" | awk '{ print $1 }')"
[[ "$size" =~ ^[0-9]+$ ]] || die "could not determine the copied xlsx-sidecar size"
[[ "$sha256" =~ ^[[:xdigit:]]{64}$ ]] || die "could not determine the copied xlsx-sidecar SHA-256"
sha256="$(printf '%s' "$sha256" | tr '[:upper:]' '[:lower:]')"

manifest_tmp="$manifest_path.tmp.$$"
cleanup() {
  rm -f "$manifest_tmp"
}
trap cleanup EXIT HUP INT TERM

{
  printf '{\n'
  printf '  "schemaVersion": 1,\n'
  printf '  "platform": "macos",\n'
  printf '  "arch": "%s",\n' "$arch"
  printf '  "xlsxSidecar": {\n'
  printf '    "path": "%s",\n' "$resource_sidecar_relpath"
  printf '    "version": "%s",\n' "$version"
  printf '    "size": %s,\n' "$size"
  printf '    "sha256": "%s"\n' "$sha256"
  printf '  }\n'
  printf '}\n'
} > "$manifest_tmp"
mv -f "$manifest_tmp" "$manifest_path"
trap - EXIT HUP INT TERM

manifest_entry_abs="$resource_root_abs/$resource_sidecar_relpath"
case "$manifest_entry_abs/" in
  "$resource_root_abs/"*) ;;
  *) die "the xlsx-sidecar manifest entry escapes $resource_root_abs" ;;
esac
[[ "$manifest_entry_abs" == "$resource_sidecar" ]] || die \
  "the xlsx-sidecar manifest entry does not resolve to the copied binary"
[[ -f "$manifest_entry_abs" && -x "$manifest_entry_abs" ]] || die \
  "the xlsx-sidecar manifest entry does not point to an executable file"

printf 'xlsx-sidecar macOS release ready\n'
printf 'version: %s\n' "$version"
printf 'platform: macos\n'
printf 'arch: %s\n' "$arch"
printf 'size: %s bytes\n' "$size"
printf 'sha256: %s\n' "$sha256"
printf 'entry: %s\n' "$resource_sidecar"
