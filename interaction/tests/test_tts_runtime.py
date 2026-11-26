import asyncio
import json
import sys

import pytest

from mona_interaction.tts_transport import TTSRuntime, read_frame


@pytest.mark.asyncio
async def test_worker_reuse_restart_and_shutdown(tmp_path):
    worker = tmp_path / "worker.py"
    worker.write_text('''
import json, struct, sys
def send(kind, ident, data=b""):
    frame = kind + ident.encode("ascii") + data
    sys.stdout.buffer.write(struct.pack(">I", len(frame)) + frame)
    sys.stdout.buffer.flush()
send(b"R", "0" * 32)
for line in sys.stdin:
    req = json.loads(line)
    send(b"D", req["id"], b"\\x01\\x00")
    send(b"E", req["id"])
''', encoding="utf-8")
    runtime = TTSRuntime(command=(sys.executable, str(worker)))
    runtime.enable()
    try:
        first = await runtime.ready()
        for ident in ("1" * 32, "2" * 32):
            assert await runtime.ready() is first
            first.stdin.write((json.dumps({"id": ident, "text": "你好"}) + "\n").encode())
            await first.stdin.drain()
            assert await read_frame(first) == (b"D", ident, b"\x01\x00")
            assert await read_frame(first) == (b"E", ident, b"")
        await runtime.restart()
        assert first.returncode is not None
        replacement = await runtime.ready()
        assert replacement is not first and replacement.returncode is None
    finally:
        await runtime.disable()
    assert replacement.returncode is not None
