#!/usr/bin/env bash
# One-time, manually sudo-approved gVisor registration for the existing Snap Docker.
# Does not restart Docker, recreate containers, alter NVIDIA, or enable hosted Work.
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this reviewed script with sudo in your own SSH terminal." >&2
  exit 1
fi

stage="/home/liuzhe/mona-hosted-work/runtime/gvisor"
archive="$stage/gvisor-20261029.tar.bz2"
digest="096589d2d6078ba4caa26aa0200932f571aa5da9d08a5156b98ab1d93fa54468"
install_dir="/usr/local/libexec/mona-hosted-gvisor/20261029-${digest:0:12}"
daemon_config="/var/snap/docker/current/config/daemon.json"
backup="${daemon_config}.before-mona-hosted-work-20261029"
docker_bin="/snap/bin/docker"
image="sha256:3d7852c0108222d64e8122a672eca4ff9dcb79e10e00eea6807eaebb607cf5ab"

test -f "$archive"
test -f "$daemon_config"
test -x "$docker_bin"
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status
if [[ -e "$backup" ]]; then
  echo "A prior backup exists; refusing a second unattended edit: $backup" >&2
  exit 1
fi

pid="$(systemctl show snap.docker.dockerd -p MainPID --value)"
[[ "$pid" =~ ^[0-9]+$ ]] && [[ "$pid" -gt 1 ]]
[[ "$(ps -p "$pid" -o comm= | tr -d '[:space:]')" == "dockerd" ]]
before="$(mktemp)"
after="$(mktemp)"
modified=0
staging=""
cleanup() {
  rm -f "$before" "$after"
  if [[ -n "$staging" && -d "$staging" ]]; then rm -rf -- "$staging"; fi
}
rollback() {
  exit_code="$?"
  trap - ERR
  if [[ "$modified" == 1 && -f "$backup" ]]; then
    cp -p -- "$backup" "$daemon_config"
    current_pid="$(systemctl show snap.docker.dockerd -p MainPID --value)"
    if [[ "$current_pid" =~ ^[0-9]+$ && "$current_pid" -gt 1 ]]; then
      kill -HUP "$current_pid" || :
    fi
    echo "Docker runtime registration failed; previous daemon JSON restored." >&2
  fi
  cleanup
  exit "$exit_code"
}
trap rollback ERR
trap cleanup EXIT

"$docker_bin" ps --format '{{.ID}} {{.Names}}' | sort > "$before"
if ! "$docker_bin" image inspect "$image" >/dev/null 2>&1; then
  echo "Pinned sandbox image is missing; refusing runtime registration." >&2
  exit 1
fi

mkdir -p /usr/local/libexec/mona-hosted-gvisor
staging="$(mktemp -d /usr/local/libexec/mona-hosted-gvisor/.install.XXXXXXXX)"
tar -xjf "$archive" -C "$staging"
test -f "$staging/runsc"
test -f "$staging/containerd-shim-runsc-v1"
test -f "$staging/gvisor-bin/gvisor_sentry"
chmod -R a+rX "$staging"
chmod 0755 "$staging/runsc" "$staging/containerd-shim-runsc-v1" "$staging/gvisor-bin/gvisor_sentry"
"$staging/runsc" --version | head -1
if [[ -e "$install_dir" ]]; then
  echo "Pinned runtime directory already exists; refusing to overwrite." >&2
  exit 1
fi
mv "$staging" "$install_dir"
staging=""

python3 - "$daemon_config" "$backup" "$install_dir/runsc" <<'PY'
import json, os, pathlib, shutil, stat, sys, tempfile
config, backup, runsc = map(pathlib.Path, sys.argv[1:])
raw = config.read_bytes()
current = json.loads(raw)
if not isinstance(current, dict) or not isinstance(current.get("runtimes", {}), dict):
    raise SystemExit("Unexpected Snap Docker configuration, no changes made.")
runtime = current.setdefault("runtimes", {})
if "runsc" in runtime:
    raise SystemExit("Docker already contains a runsc entry; no changes made.")
shutil.copy2(config, backup)
runtime["runsc"] = {"path": str(runsc)}
fd, temp = tempfile.mkstemp(prefix=".mona-runtime-", dir=config.parent)
try:
    with os.fdopen(fd, "wb") as stream:
        data = (json.dumps(current, ensure_ascii=False, indent=2) + "\n").encode()
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    metadata = config.stat()
    os.chmod(temp, stat.S_IMODE(metadata.st_mode))
    os.chown(temp, metadata.st_uid, metadata.st_gid)
    os.replace(temp, config)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
PY
modified=1
# Docker's SIGHUP configuration reload is not a service restart. Fail closed
# if Snap confinement refuses the registered runtime or a container changes.
kill -HUP "$pid"
sleep 4
[[ "$(systemctl show snap.docker.dockerd -p MainPID --value)" == "$pid" ]]
"$docker_bin" info --format '{{json .Runtimes}}' | python3 -c 'import json,sys; assert "runsc" in json.load(sys.stdin)'

"$docker_bin" run --rm --pull=never --runtime=runsc --network=none --read-only \
  --user=1000:1000 --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /workspace:rw,nosuid,nodev,size=8388608,uid=1000,gid=1000,mode=700 \
  --entrypoint=python3 "$image" -c 'import os; assert os.getuid()==1000; print("GVISOR_RUNTIME_SMOKE_PASS")'
"$docker_bin" ps --format '{{.ID}} {{.Names}}' | sort > "$after"
diff -u "$before" "$after"
echo "GVisor registered without restarting the existing Docker daemon."
