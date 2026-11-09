"""Opt-in export persistence check against the reviewed gVisor image."""
import hashlib
import os
import sys
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import owner_key
from mona.hosted_work.editor_tools import build_editor_tools
from mona.hosted_work.sandbox import DockerSandbox

pytestmark = pytest.mark.skipif(
    sys.platform != "linux" or os.environ.get("MONA_HOSTED_SANDBOX_SMOKE") != "1",
    reason="requires an explicitly selected reviewed Linux/gVisor image",
)


@pytest.mark.asyncio
async def test_export_survives_the_next_workspace_turn(tmp_path):
    image = os.environ.get("MONA_HOSTED_SANDBOX_IMAGE", "")
    assert image
    config = HostedWorkConfig(state_dir=str(tmp_path), sandbox_image=image, public_origin="https://mona-ai.cn",
                              workspace_bytes=8 * 1024 * 1024)
    owner, chat, run_id = owner_key("900000007"), uuid4().hex, uuid4().hex
    snapshot = tmp_path / "workspace.zip"
    first = DockerSandbox(config, owner, run_id, snapshot)
    second = DockerSandbox(config, owner, uuid4().hex, snapshot)
    content = b"PK\x03\x04synthetic Office export persistence fixture"
    try:
        await first.start()
        _, office = build_editor_tools(config, {
            "owner": owner, "session_id": chat, "run_id": run_id,
            "account_token": "synthetic-session-not-used-for-network",
        }, AsyncMock(), sandbox=first)
        exported = office.scope.root / "exports" / "result.pptx"
        exported.parent.mkdir()
        exported.write_bytes(content)
        await office._publish_export(exported)
        await first.save()
        await first.close()

        await second.start()
        restored = await second.file({"action": "stat", "path": "exports/result.pptx"})
        assert restored["size"] == len(content)
        assert restored["sha256"] == hashlib.sha256(content).hexdigest()
    finally:
        await first.close()
        await second.close()
