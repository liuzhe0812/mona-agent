"""Run the dedicated Work FRP tunnel with an in-memory configuration."""

import json
import os
import subprocess
import sys
from pathlib import Path


def credentials(role):
    if role == "provider":
        import gi

        gi.require_version("Secret", "1")
        from gi.repository import Secret

        schema = Secret.Schema.new(
            "org.mona.HostedWork.Tunnel",
            Secret.SchemaFlags.NONE,
            {"service": Secret.SchemaAttributeType.STRING},
        )
        value = Secret.password_lookup_sync(schema, {"service": "mona-work-tunnel-v1"}, None)
        if value is None:
            raise RuntimeError("Work tunnel credential is unavailable or locked")
    else:
        value = (Path(os.environ["CREDENTIALS_DIRECTORY"]) / "work-tunnel").read_text()
    data = json.loads(value)
    if set(data) != {"frps_token", "stcp_key"} or not all(
        isinstance(value, str) and value for value in data.values()
    ):
        raise ValueError("Invalid Work tunnel credential")
    return data


def configuration(role, data):
    token = json.dumps(data["frps_token"])
    secret = json.dumps(data["stcp_key"])
    common = f'''serverAddr = "mona-ai.cn"
serverPort = 443
user = "mona-work-v2"
auth.method = "token"
auth.token = {token}
transport.protocol = "wss"
transport.tls.trustedCaFile = "/etc/ssl/certs/ca-certificates.crt"
transport.tls.serverName = "mona-ai.cn"
log.level = "warn"
'''
    if role == "provider":
        return common + f'''[[proxies]]
name = "work"
type = "stcp"
secretKey = {secret}
localIP = "172.31.3.176"
localPort = 17175
transport.useEncryption = true
'''
    return common + f'''[[visitors]]
name = "work-visitor"
type = "stcp"
serverUser = "mona-work-v2"
serverName = "work"
secretKey = {secret}
bindAddr = "127.0.0.1"
bindPort = 18801
transport.useEncryption = true
'''


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"provider", "visitor"}:
        raise SystemExit("Usage: tunnel.py provider|visitor")
    role = sys.argv[1]
    config = configuration(role, credentials(role)).encode()
    executable = "/opt/notebook-relay/runtime/frpc"
    with os.fdopen(os.memfd_create("mona-work-tunnel", 0), "w+b") as memory_file:
        memory_file.write(config)
        memory_file.flush()
        memory_file.seek(0)
        fd = memory_file.fileno()
        path = f"/proc/self/fd/{fd}"
        checked = subprocess.run([executable, "verify", "-c", path], pass_fds=(fd,), capture_output=True)
        if checked.returncode:
            raise SystemExit("Work tunnel configuration validation failed")
        memory_file.seek(0)
        process = subprocess.Popen([executable, "-c", path], pass_fds=(fd,))
        raise SystemExit(process.wait())


if __name__ == "__main__":
    main()
