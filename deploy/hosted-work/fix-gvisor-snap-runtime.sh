#!/usr/bin/env bash
# Follow-up to install-gvisor-snap.sh: Snap Docker cannot see /usr/local/libexec.
# This script changes only the previously registered runsc executable path.
# It never restarts Docker or changes, stops, or removes existing containers.
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Administrator approval required: run via sudo from your own SSH terminal." >&2
  exit 1
fi

config=/var/snap/docker/current/config/daemon.json
original_backup="${config}.before-mona-hosted-work-20261029"
path_backup="${config}.before-snap-path-fix-20261029"
old='/usr/local/libexec/mona-hosted-gvisor/20261029-096589d2d607/runsc'
new='/var/snap/docker/common/mona-hosted-gvisor/20261029-096589d2d607/runsc'
image='sha256:3d7852c0108222d64e8122a672eca4ff9dcb79e10e00eea6807eaebb607cf5ab'
before_sha='a87ccbca0f26131a77faa7349a3b2426e7cff56708f57f85e27b320e75b14ec2'
baseline_sha='9dc192c7a7b7e9fc10e89ad017d684947b68f6e35a68daaf2fcc442d481ec20f'
binary_sha='7d658f2c3a5602d28c391285eb4ee0740e7dd21d40731324049a29620e51cf5e'

test -f "$config"
test -f "$original_backup"
test -f "$path_backup"
test -x "$new"
printf '%s  %s\n' "$before_sha" "$config" "$before_sha" "$path_backup" "$baseline_sha" "$original_backup" "$binary_sha" "$new" | sha256sum -c --status
test -x /snap/bin/docker
/snap/bin/docker image inspect "$image" >/dev/null

pid="$(systemctl show snap.docker.dockerd -p MainPID --value)"
[[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]]
[[ "$(ps -p "$pid" -o comm= | tr -d '[:space:]')" == dockerd ]]

exec 9> /var/snap/docker/current/config/.mona-hosted-work-config.lock
flock -n 9
before="$(mktemp)"
after="$(mktemp)"
changed=0

rollback() {
  original_status="$?"
  trap - ERR
  if [[ "$changed" == 1 ]]; then
    # Only restore OUR exact path; never overwrite an unrelated concurrent change.
    python3 - "$config" "$path_backup" "$new" <<'PY'
import json, os, pathlib, stat, sys, tempfile
config, backup = (pathlib.Path(arg) for arg in sys.argv[1:3])
installed_path = sys.argv[3]
current = json.loads(config.read_bytes())
if current.get('runtimes', {}).get('runsc', {}).get('path') == installed_path:
    value = backup.read_bytes()
    fd, tmp = tempfile.mkstemp(prefix='.mona-rollback-', dir=config.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        meta = config.stat()
        os.chmod(tmp, stat.S_IMODE(meta.st_mode))
        os.chown(tmp, meta.st_uid, meta.st_gid)
        os.replace(tmp, config)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
PY
    if [[ "$(systemctl show snap.docker.dockerd -p MainPID --value)" == "$pid" ]]; then
      kill -HUP "$pid" || :
    fi
    echo 'Runsc smoke failed or validation was interrupted; attempted to restore the prior Docker runtime configuration.' >&2
  fi
  rm -f "$before" "$after"
  exit "$original_status"
}
trap rollback ERR INT TERM
trap 'rm -f "$before" "$after"' EXIT

/snap/bin/docker ps --format '{{.Names}} {{.Status}}' | sort > "$before"
if [[ "$(wc -l < "$before")" -lt 8 ]]; then
  echo 'Expected existing containers are missing; refusing Docker configuration edit.' >&2
  exit 1
fi

# Underlying install was successful. Only /usr/local's Snap-invisible path is wrong.
changed=1
python3 - "$config" "$old" "$new" "$path_backup" <<'PY'
import json, os, pathlib, stat, sys, tempfile
config, old, new, backup = pathlib.Path(sys.argv[1]), *sys.argv[2:]
data = config.read_bytes()
assert data == pathlib.Path(backup).read_bytes(), 'config no longer matches exact pre-fix snapshot'
payload = json.loads(data)
assert payload.get('runtimes', {}).get('runsc') == {'path': old}
payload['runtimes']['runsc']['path'] = new
value = (json.dumps(payload, ensure_ascii=False, indent=2) + '\n').encode()
fd, tmp = tempfile.mkstemp(prefix='.mona-runsc-', dir=config.parent)
try:
    with os.fdopen(fd, 'wb') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    meta = config.stat()
    os.chmod(tmp, stat.S_IMODE(meta.st_mode))
    os.chown(tmp, meta.st_uid, meta.st_gid)
    os.replace(tmp, config)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY

# SIGHUP reloads Docker's daemon.json. It is NOT a service restart.
kill -HUP "$pid"
sleep 4
[[ "$(systemctl show snap.docker.dockerd -p MainPID --value)" == "$pid" ]]

/snap/bin/docker info --format '{{json .Runtimes}}' | python3 -c '
import json, sys
expected = "/var/snap/docker/common/mona-hosted-gvisor/20261029-096589d2d607/runsc"
assert json.load(sys.stdin).get("runsc", {}).get("path") == expected
'
/snap/bin/docker run --rm --pull=never --runtime=runsc \
  --network=none --read-only --user=1000:1000 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=64 --memory=384m --memory-swap=384m --cpus=0.5 \
  --tmpfs /tmp:rw,nosuid,nodev,size=16777216,uid=1000,gid=1000,mode=700 \
  --tmpfs /workspace:rw,nosuid,nodev,size=8388608,uid=1000,gid=1000,mode=700 \
  --entrypoint=python3 "$image" \
  -c 'import os,pathlib; assert os.getuid()==1000; assert not pathlib.Path("/var/run/docker.sock").exists(); print("GVISOR_SMOKE_PASS")'

/snap/bin/docker ps --format '{{.Names}} {{.Status}}' | sort > "$after"
diff -u "$before" "$after"
changed=0
echo 'SUCCESS: runsc works inside the Snap Docker namespace; original containers are intact; Docker daemon PID unchanged.'
