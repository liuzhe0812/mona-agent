from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from mona.office.sidecar import XlsxSidecarProcess


def test_sidecar_process_uses_versioned_json_lines_and_stops(tmp_path: Path) -> None:
    script = tmp_path / "fake_sidecar.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    response = {
        "version": request["version"],
        "requestId": request["requestId"],
        "ok": True,
        "result": {"command": request["command"], "path": request.get("path")},
    }
    print(json.dumps(response), flush=True)
""".strip(),
        encoding="utf-8",
    )

    async def run() -> None:
        sidecar = XlsxSidecarProcess([sys.executable, str(script)])
        result = await sidecar.open(tmp_path / "input.xlsx")

        assert result == {"command": "open", "path": str(tmp_path / "input.xlsx")}
        assert sidecar.process_id is not None
        await sidecar.stop()
        assert sidecar.process_id is None

    asyncio.run(run())
