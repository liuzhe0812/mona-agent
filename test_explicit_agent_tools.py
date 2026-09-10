from __future__ import annotations

import json
from pathlib import Path


AGENTS_ROOT = Path(__file__).parent / "mona" / "agents"
BASIC_SYSTEM_TOOLS = {"exec", "write_stdin", "list_exec_sessions"}
EXPLICIT_AGENT_IDS = {
    "com.mona.a-share-analyst",
    "com.mona.academic-researcher",
    "com.mona.xhs-operator",
}


def test_every_explicit_agent_has_basic_system_tools() -> None:
    manifests = [
        manifest
        for manifest in sorted(AGENTS_ROOT.rglob("agent.json"))
        if json.loads(manifest.read_text(encoding="utf-8")).get("visibility", "partner")
        == "partner"
    ]
    assert manifests
    assert {
        json.loads(manifest.read_text(encoding="utf-8"))["id"]
        for manifest in manifests
    } == EXPLICIT_AGENT_IDS

    missing: dict[str, list[str]] = {}
    for manifest in manifests:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        absent = sorted(BASIC_SYSTEM_TOOLS - set(data.get("toolAllowlist", [])))
        if absent:
            missing[data["id"]] = absent

    assert missing == {}
