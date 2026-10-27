import asyncio
from pathlib import Path

import pytest

from mona.agent.tools.knowledge_search import WikiReadTool, WikiSearchTool
from mona.agent.user_config import AgentUserConfig, KnowledgeBaseScope
from mona.materials import access
from mona.materials.catalog import (
    DEFAULT_LIBRARY_ID,
    create_library,
    ensure_catalog,
    get_library_root,
)
from mona.materials.index import MaterialsIndex, sync_index


@pytest.fixture(autouse=True)
def private_agent_data(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("mona.config.paths.get_config_path", lambda: tmp_path / "mona" / "config.json")


def test_default_legacy_libraries_belong_only_to_mona(tmp_path: Path, monkeypatch) -> None:
    vault = tmp_path / "vault"
    ensure_catalog(vault)
    second = create_library(vault, "旧资料")
    monkeypatch.setattr(
        "mona.agent.user_config.load_agent_user_config", lambda _agent_id: AgentUserConfig()
    )

    assert access.allowed_library_ids(vault, "mona") == [DEFAULT_LIBRARY_ID, second["id"]]
    assert access.allowed_library_ids(vault, "agent-a") == []
    assert not access.library_allowed(vault, "agent-a", DEFAULT_LIBRARY_ID)


def test_agent_specific_scope_filters_libraries(tmp_path: Path, monkeypatch) -> None:
    vault = tmp_path / "vault"
    ensure_catalog(vault)
    second = create_library(vault, "私有库")
    config = AgentUserConfig(
        knowledge_base_scope=KnowledgeBaseScope(
            mode="specific", knowledge_base_ids=[second["id"]]
        )
    )
    monkeypatch.setattr(
        "mona.agent.user_config.load_agent_user_config", lambda _agent_id: config
    )

    assert access.allowed_library_ids(vault, "agent-a") == [second["id"]]
    assert not access.library_allowed(vault, "agent-a", DEFAULT_LIBRARY_ID)
    assert access.library_allowed(vault, "agent-a", second["id"])


def test_agent_none_scope_has_no_library(tmp_path: Path, monkeypatch) -> None:
    vault = tmp_path / "vault"
    ensure_catalog(vault)
    config = AgentUserConfig(
        knowledge_base_scope=KnowledgeBaseScope(mode="none")
    )
    monkeypatch.setattr(
        "mona.agent.user_config.load_agent_user_config", lambda _agent_id: config
    )

    assert access.allowed_library_ids(vault, "agent-a") == []


def test_wiki_tools_enforce_agent_library_scope(tmp_path: Path, monkeypatch) -> None:
    vault = tmp_path / "vault"
    ensure_catalog(vault)
    private = create_library(vault, "私有库")
    default_root = get_library_root(vault, DEFAULT_LIBRARY_ID)
    private_root = get_library_root(vault, private["id"])
    (default_root / "wiki" / "public.md").write_text(
        "---\nid: wiki-public\ntitle: 公开页面\n---\n\n公开唯一词\n",
        encoding="utf-8",
    )
    (private_root / "wiki" / "private.md").write_text(
        "---\nid: wiki-private\ntitle: 私有页面\n---\n\n私有唯一词\n",
        encoding="utf-8",
    )
    for root in (default_root, private_root):
        index = MaterialsIndex(root / "index.db", vault=vault, library_root=root)
        try:
            sync_index(vault, index, library_root=root)
        finally:
            index.close()

    config = AgentUserConfig(
        knowledge_base_scope=KnowledgeBaseScope(
            mode="specific", knowledge_base_ids=[DEFAULT_LIBRARY_ID]
        )
    )
    monkeypatch.setattr(
        "mona.agent.user_config.load_agent_user_config", lambda _agent_id: config
    )
    app_data = tmp_path / "appdata"
    (app_data / "notes").mkdir(parents=True)
    (app_data / "notes" / "vault_path.txt").write_text(str(vault), encoding="utf-8")
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(app_data))

    allowed = asyncio.run(WikiSearchTool("agent-a").execute(query="公开唯一词"))
    denied_search = asyncio.run(WikiSearchTool("agent-a").execute(query="私有唯一词"))
    denied_read = asyncio.run(
        WikiReadTool("agent-a").execute(
            ref=f"kb:{private['id']}:wiki-private:0"
        )
    )

    assert "公开页面" in allowed
    assert "私有页面" not in denied_search
    assert "not allowed" in denied_read

    monkeypatch.setattr(
        "mona.agent.user_config.load_agent_user_config", lambda _agent_id: AgentUserConfig()
    )
    default_search = asyncio.run(WikiSearchTool("agent-b").execute(query="公开唯一词"))
    default_read = asyncio.run(
        WikiReadTool("agent-b").execute(ref=f"kb:{DEFAULT_LIBRARY_ID}:wiki-public:0")
    )
    assert "公开页面" not in default_search
    assert "not allowed" in default_read
