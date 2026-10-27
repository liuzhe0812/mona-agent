"""Per-Agent knowledge-library scope resolution."""

from __future__ import annotations

from pathlib import Path

from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id
from mona.materials.catalog import list_libraries, validate_library_id


def allowed_library_ids(vault: Path, agent_id: str) -> list[str]:
    from mona.agent.user_config import load_agent_user_config

    scope = load_agent_user_config(agent_id).knowledge_base_scope
    if scope.mode == "none":
        return []
    # Legacy "all" was the default, not an explicit assignment to every partner.
    if scope.mode == "all" and normalize_agent_id(agent_id) != MONA_AGENT_ID:
        return []
    available = [str(item["id"]) for item in list_libraries(vault)]
    if scope.mode == "specific":
        selected = set(scope.knowledge_base_ids)
        return [library_id for library_id in available if library_id in selected]
    return available


def library_allowed(vault: Path, agent_id: str, library_id: str) -> bool:
    resolved = validate_library_id(library_id)
    return resolved in allowed_library_ids(vault, agent_id)

