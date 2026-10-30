"""Opt-in real gVisor acceptance, never counted as passing on Windows or policy-only tests.

Requires explicit MONA_HOSTED_SANDBOX_SMOKE=1 and a preinstalled pinned
MONA_HOSTED_SANDBOX_IMAGE. Does not install/pull images or alter Docker config.
"""
import json
import os
import shlex
import sys
from uuid import uuid4

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import owner_key
from mona.hosted_work.sandbox import DockerSandbox

pytestmark = pytest.mark.skipif(
    sys.platform != "linux" or os.environ.get("MONA_HOSTED_SANDBOX_SMOKE") != "1",
    reason="requires explicitly authorized Ubuntu/gVisor real-isolation acceptance",
)


@pytest.mark.asyncio
async def test_real_sandbox_files_network_and_user_isolation(tmp_path):
    image = os.environ.get("MONA_HOSTED_SANDBOX_IMAGE", "")
    assert image, "Provide a verified immutable image ID/digest, not a mutable tag."
    config = HostedWorkConfig(sandbox_image=image, state_dir=str(tmp_path), workspace_bytes=8 * 1024 * 1024)
    first = DockerSandbox(config, owner_key("900000001"), uuid4().hex, tmp_path / "one.zip")
    second = DockerSandbox(config, owner_key("900000002"), uuid4().hex, tmp_path / "two.zip")
    canary = tmp_path / "host-only-canary.txt"
    canary.write_text(uuid4().hex, encoding="utf-8")
    script = """import json, os, pathlib, socket
assert os.getuid() == 1000
assert not pathlib.Path(HOST_CANARY).exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
assert os.getenv('MONA_HOSTED_WORK_KEY') is None
try:
    with open('/root/.codex/auth.json', 'rb') as credential:
        credential.read(1)
except (FileNotFoundError, PermissionError):
    pass
else:
    raise AssertionError('host account credentials are readable')
try:
    pathlib.Path('/usr/mona-outside-write').write_text('forbidden')
except OSError:
    pass
else:
    raise AssertionError('system filesystem is writable')
for family, target in [(socket.AF_INET, ('10.0.0.1', 443)), (socket.AF_INET, ('172.31.3.176', 443)),
                       (socket.AF_INET, ('192.168.1.1', 443)), (socket.AF_INET, ('169.254.169.254', 80)),
                       (socket.AF_INET6, ('fd00::1', 443)), (socket.AF_INET, ('8.8.8.8', 53))]:
    connection = socket.socket(family, socket.SOCK_STREAM)
    connection.settimeout(0.5)
    try:
        connection.connect(target)
    except OSError:
        pass
    else:
        raise AssertionError('isolated process reached a network target')
    finally:
        connection.close()
print(json.dumps({'uid': os.getuid(), 'network_blocked': True, 'host_hidden': True}))
""".replace("HOST_CANARY", repr(str(canary)))
    try:
        await first.preflight()
        await first.start()
        reply = await first.execute("python3 -I -c " + shlex.quote(script))
        assert reply["exit_code"] == 0, reply
        assert json.loads(reply["output"])["network_blocked"] is True
        await first.file({"action": "write", "path": "only-first.txt", "content": "private-first"})
        await second.start()
        listing = await second.file({"action": "list", "path": "."})
        assert not any(entry["name"] == "only-first.txt" for entry in listing["entries"])
        await first.save()
        await first.close()
        restored = DockerSandbox(config, first.owner, uuid4().hex, tmp_path / "one.zip")
        try:
            await restored.start()
            restored_file = await restored.file({"action": "read", "path": "only-first.txt"})
            assert restored_file["content"] == "private-first"
        finally:
            await restored.close()
    finally:
        await first.close()
        await second.close()
