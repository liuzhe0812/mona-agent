"""Per-Agent knowledge-library scope resolution."""

from __future__ import annotations

from pathlib import Path

from mona.materials.catalog import list_libraries, validate_library_id


def allowed_library_ids(vault: Path, agent_id: str) -> list[str]:
    from mona.agent.user_config import load_agent_user_config

    available = [str(item["id"]) for item in list_libraries(vault)]
    scope = load_agent_user_config(agent_id).knowledge_base_scope
    if scope.mode == "none":
        return []
    if scope.mode == "specific":
        selected = set(scope.knowledge_base_ids)
        return [library_id for library_id in available if library_id in selected]
    return available


def library_allowed(vault: Path, agent_id: str, library_id: str) -> bool:
    resolved = validate_library_id(library_id)
    return resolved in allowed_library_ids(vault, agent_id)

