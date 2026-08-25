"""Contract tests for the academic tool wrappers."""

from __future__ import annotations

import json
import os
from types import SimpleNamespace

import httpx
import pytest

from mona.academic.models import EvidenceLocator, SourceRecord
from mona.academic.providers import ProviderError, ProviderPage
from mona.academic.scientific import (
    PUBCHEM_TOOL_ID,
    UNIPROT_TOOL_ID,
    ApprovedScientificBackend,
)
from mona.agent.tools.academic import (
    AcademicSearchTool,
    ResearchRecordTool,
    ScientificTool,
)
from mona.agent.tools.context import ToolContext
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry


def _source(source_id: str, provider: str, *, doi: str | None = None) -> SourceRecord:
    return SourceRecord(
        source_id=source_id,
        title=f"Paper {source_id}",
        authors=["Researcher"],
        published_at="2024-01-02",
        source_type="paper",
        doi=doi,
        provider=provider,
        providers=[provider],
    )


def test_tool_loader_discovers_and_allowlists_all_academic_tools(tmp_path):
    names = {"academic_search", "research_record", "scientific_tool"}
    ctx = ToolContext(
        config=SimpleNamespace(),
        workspace=str(tmp_path),
        agent_id="com.mona.academic-researcher",
    )
    registry = ToolRegistry()

    registered = ToolLoader().load(
        ctx,
        registry,
        scope="subagent",
        tool_allowlist=sorted(names),
    )

    assert names <= set(registered)
    assert names <= set(registry.tool_names)


@pytest.mark.asyncio
async def test_academic_search_merges_sources_and_preserves_provider_errors():
    class GoodProvider:
        provider = "good"

        async def search(self, query: str, *, limit: int, cursor: str | None = None):
            assert query == "graph neural network"
            assert limit == 5
            return ProviderPage(
                self.provider,
                records=[_source("shared", self.provider, doi="10.1000/shared")],
            )

    class FailingProvider:
        provider = "broken"

        async def search(self, query: str, *, limit: int, cursor: str | None = None):
            return ProviderPage(
                self.provider,
                error=ProviderError(
                    self.provider,
                    "rate_limited",
                    "provider unavailable",
                    status_code=429,
                    retryable=True,
                ),
            )

    tool = AcademicSearchTool(
        providers={"good": GoodProvider(), "broken": FailingProvider()}
    )
    payload = json.loads(
        await tool.execute(
            action="search",
            query="graph neural network",
            providers=["good", "broken"],
            limit=5,
        )
    )

    assert payload["records"] and len(payload["records"]) == 1
    assert payload["records"][0]["source_id"] == "shared"
    assert payload["provider_errors"] == [
        {
            "provider": "broken",
            "code": "rate_limited",
            "message": "provider unavailable",
            "status_code": 429,
            "retry_after": None,
            "retryable": True,
        }
    ]
    assert payload["query_log"]["action"] == "search"
    assert payload["query_log"]["providers"] == ["good", "broken"]
    assert payload["query_log"]["query"] == "graph neural network"


@pytest.mark.asyncio
async def test_academic_search_metadata_and_citations_require_identifier():
    class Provider:
        provider = "fake"

        async def metadata(self, identifier: str):
            return ProviderPage(self.provider, records=[_source("meta", self.provider)])

        async def citations(self, identifier: str, *, limit: int, cursor: str | None = None):
            return ProviderPage(self.provider, records=[_source("citation", self.provider)])

    tool = AcademicSearchTool(providers={"crossref": Provider()})
    metadata = json.loads(
        await tool.execute(action="metadata", identifier="10.1000/example", providers=["crossref"])
    )
    citations = json.loads(
        await tool.execute(
            action="citations",
            identifier="10.1000/example",
            providers=["crossref"],
            direction="references",
        )
    )
    missing = json.loads(await tool.execute(action="metadata", providers=["crossref"]))

    assert metadata["records"][0]["source_id"] == "meta"
    assert citations["records"][0]["source_id"] == "citation"
    assert citations["query_log"]["citation_direction"] == "references"
    assert missing["ok"] is False
    assert missing["error_code"] == "identifier_required"


@pytest.mark.asyncio
async def test_academic_search_routes_citation_directions_and_preserves_labels():
    class DirectionProvider:
        def __init__(self, provider: str):
            self.provider = provider

        async def citations(self, identifier: str, *, limit: int, cursor: str | None = None):
            return ProviderPage(
                self.provider,
                records=[_source(f"{self.provider}-citation", self.provider)],
            )

    tool = AcademicSearchTool(
        providers={
            "openalex": DirectionProvider("openalex"),
            "crossref": DirectionProvider("crossref"),
            "europe_pmc": DirectionProvider("europe_pmc"),
        }
    )
    all_directions = json.loads(
        await tool.execute(
            action="citations",
            identifier="10.1000/example",
            providers=["openalex", "crossref", "europe_pmc"],
            direction="all",
        )
    )
    bad_direction = json.loads(
        await tool.execute(
            action="citations",
            identifier="10.1000/example",
            providers=["openalex"],
            direction="references",
        )
    )
    cursor = json.loads(
        await tool.execute(
            action="search",
            query="topic",
            providers=["openalex", "crossref"],
            cursor="provider-cursor",
        )
    )

    assert {
        record["citation_direction"] for record in all_directions["records"]
    } == {"cited_by", "references"}
    assert {
        record["provider"]: record["citation_direction"]
        for record in all_directions["records"]
    } == {"openalex": "cited_by", "crossref": "references", "europe_pmc": "references"}
    assert all_directions["query_log"]["provider_directions"] == {
        "openalex": "cited_by",
        "crossref": "references",
        "europe_pmc": "references",
    }
    assert bad_direction["records"] == []
    assert bad_direction["provider_errors"][0]["code"] == "unsupported_direction"
    assert cursor["ok"] is False
    assert cursor["error_code"] == "cursor_requires_single_provider"


@pytest.mark.asyncio
async def test_research_record_init_append_and_status_are_workspace_scoped(tmp_path):
    tool = ResearchRecordTool(workspace=tmp_path)
    init = json.loads(
        await tool.execute(action="init", task_id="task-1", goal="Study evidence")
    )
    source = json.loads(
        await tool.execute(
            action="source_upsert",
            task_id="task-1",
            record=_source("source-1", "fixture").model_dump(mode="json"),
        )
    )
    claim = json.loads(
        await tool.execute(
            action="claim_append",
            task_id="task-1",
            record={
                "claim_id": "claim-1",
                "claim_type": "fact",
                "claim_text": "The paper reports a result.",
                "source_ids": ["source-1"],
                "evidence_text": "The abstract reports the result.",
                "locator": EvidenceLocator(kind="abstract").model_dump(mode="json"),
            },
        )
    )
    status = json.loads(await tool.execute(action="status", task_id="task-1"))

    assert init["ok"] is True
    assert source["record"]["source_id"] == "source-1"
    assert claim["record"]["claim_id"] == "claim-1"
    assert status["manifest"]["task_id"] == "task-1"
    assert status["manifest"]["source_ids"] == ["source-1"]
    assert status["manifest"]["claim_ids"] == ["claim-1"]
    assert (tmp_path / "research" / "task-1" / "manifest.json").is_file()


@pytest.mark.asyncio
async def test_research_record_rejects_unsafe_task_id(tmp_path):
    tool = ResearchRecordTool(workspace=tmp_path)
    payload = json.loads(await tool.execute(action="init", task_id="../escape"))
    assert payload["ok"] is False
    assert payload["error_code"] == "invalid_task_id"
    assert not (tmp_path.parent / "escape").exists()


@pytest.mark.asyncio
async def test_research_record_normalizes_same_task_deliverables_and_validates(tmp_path):
    tool = ResearchRecordTool(workspace=tmp_path)
    task_id = "live_writing_delivery"
    task_dir = tmp_path / "research" / task_id / "deliverables"
    task_dir.mkdir(parents=True)
    (task_dir / "record-path.md").write_text("record path\n", encoding="utf-8")
    (task_dir / "fields-path.md").write_text("fields path\n", encoding="utf-8")

    await tool.execute(action="init", task_id=task_id, goal="Writing delivery")
    record_path = json.loads(
        await tool.execute(
            action="deliverable_register",
            task_id=task_id,
            record={
                "deliverable_id": "record-deliverable",
                "kind": "report",
                "path": f"research/{task_id}/deliverables/record-path.md",
            },
        )
    )
    fields_path = json.loads(
        await tool.execute(
            action="deliverable_register",
            task_id=task_id,
            record={"deliverable_id": "fields-deliverable", "kind": "report"},
            fields={
                "path": f"research\\{task_id}\\deliverables\\fields-path.md",
                "title": "Fields path",
            },
        )
    )
    validation = json.loads(await tool.execute(action="validate", task_id=task_id))

    assert record_path["record"]["path"] == "deliverables/record-path.md"
    assert fields_path["record"]["path"] == "deliverables/fields-path.md"
    assert validation["validation"]["valid"] is True, validation


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "research/other-task/deliverables/note.md",
        "C:/outside/note.md",
        "deliverables/../note.md",
    ],
)
async def test_research_record_rejects_cross_task_absolute_and_traversal_deliverables(
    tmp_path, path
):
    tool = ResearchRecordTool(workspace=tmp_path)
    task_id = "task-deliverable-safety"
    await tool.execute(action="init", task_id=task_id)
    payload = json.loads(
        await tool.execute(
            action="deliverable_register",
            task_id=task_id,
            record={
                "deliverable_id": "unsafe-deliverable",
                "kind": "report",
                "path": path,
            },
        )
    )

    assert payload["ok"] is False
    assert payload["error_code"] == "invalid_record"


@pytest.mark.asyncio
async def test_scientific_tool_returns_stable_unavailable_without_sdk():
    tool = ScientificTool(backend_loader=lambda: None)
    payload = json.loads(await tool.execute(action="discover", query="protein"))
    assert payload["ok"] is False
    assert payload["status"] == "unavailable"
    assert payload["error_code"] == "tooluniverse_unavailable"


@pytest.mark.asyncio
async def test_scientific_tool_approved_backend_completes_discover_inspect_run_status():
    pubchem_payload = {
        "PropertyTable": {
            "Properties": [{"CID": 2244, "MolecularFormula": "C9H8O4"}]
        }
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert "/compound/name/aspirin/property/" in str(request.url)
        return httpx.Response(200, json=pubchem_payload, request=request)

    backend = ApprovedScientificBackend(transport=httpx.MockTransport(handler))
    tool = ScientificTool(backend=backend)

    discovered = json.loads(
        await tool.execute(action="discover", query="PubChem", limit=1)
    )
    inspected = json.loads(
        await tool.execute(action="inspect", tool_id=PUBCHEM_TOOL_ID)
    )
    run = json.loads(
        await tool.execute(
            action="run",
            tool_id=PUBCHEM_TOOL_ID,
            arguments={"name": "aspirin", "properties": ["MolecularFormula"]},
        )
    )
    status = json.loads(
        await tool.execute(action="status", tool_id=PUBCHEM_TOOL_ID)
    )

    assert discovered["ok"] is True
    assert discovered["tools"][0]["tool_id"] == PUBCHEM_TOOL_ID
    assert inspected["tool"]["read_only"] is True
    assert run["ok"] is True
    assert run["status"] == "succeeded"
    assert run["result"]["result"] == pubchem_payload
    assert status["ok"] is True
    assert status["status"] == "ready"


def test_scientific_tool_default_loader_falls_back_to_approved_backend(monkeypatch):
    monkeypatch.setattr(
        "mona.agent.tools.academic._load_tooluniverse",
        lambda: None,
    )
    tool = ScientificTool()
    assert isinstance(tool._get_backend(), ApprovedScientificBackend)


RUN_LIVE_RESEARCH_ACCEPTANCE = os.getenv("RUN_LIVE_RESEARCH_ACCEPTANCE") == "1"


@pytest.mark.asyncio
@pytest.mark.skipif(
    not RUN_LIVE_RESEARCH_ACCEPTANCE,
    reason="set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live approved scientific checks",
)
@pytest.mark.parametrize(
    ("tool_id", "arguments"),
    [
        pytest.param(PUBCHEM_TOOL_ID, {"name": "aspirin", "properties": ["MolecularFormula"]}, id="pubchem"),
        pytest.param(UNIPROT_TOOL_ID, {"query": "accession:P04637", "size": 1}, id="uniprot"),
    ],
)
async def test_live_scientific_tool_runs_approved_tools(tool_id, arguments):
    tool = ScientificTool()
    inspected = json.loads(await tool.execute(action="inspect", tool_id=tool_id))
    result = json.loads(
        await tool.execute(action="run", tool_id=tool_id, arguments=arguments)
    )
    assert inspected["ok"] is True, inspected
    assert result["ok"] is True, result
    assert result["status"] == "succeeded", result
    assert result["result"]
    assert result["data_sources"]


@pytest.mark.asyncio
async def test_scientific_tool_simulated_backend_runs_real_action_sequence():
    class FakeToolUniverse:
        __version__ = "test-1.0"

        def __init__(self):
            self.calls: list[tuple[str, object]] = []

        def list_built_in_tools(self, *, mode: str, scan_all: bool = False):
            self.calls.append(("discover", mode))
            return [
                {
                    "name": "Fake_calculate",
                    "description": "Deterministic test calculation",
                    "type": "local",
                    "parameters": {"x": {"type": "number"}},
                }
            ]

        def tool_specification(self, tool_name: str, *, return_prompt: bool = False):
            self.calls.append(("inspect", tool_name))
            return {
                "name": tool_name,
                "description": "Deterministic test calculation",
                "parameters": {"x": {"type": "number"}},
                "license": "MIT",
                "citation": "fixture",
            }

        def run(self, function_call):
            self.calls.append(("run", function_call))
            return {"status": "complete", "data": {"value": 4}, "data_sources": ["fixture"]}

        def get_tool_health(self, tool_name: str):
            self.calls.append(("status", tool_name))
            return {"status": "healthy", "tool_name": tool_name}

    backend = FakeToolUniverse()
    tool = ScientificTool(backend=backend)

    discover = json.loads(await tool.execute(action="discover", query="calculate"))
    inspect = json.loads(await tool.execute(action="inspect", tool_id="Fake_calculate"))
    before_inspect = ScientificTool(backend=backend)
    rejected = json.loads(
        await before_inspect.execute(
            action="run", tool_id="Fake_calculate", arguments={"x": 2}
        )
    )
    run = json.loads(
        await tool.execute(action="run", tool_id="Fake_calculate", arguments={"x": 2})
    )
    status = json.loads(await tool.execute(action="status", tool_id="Fake_calculate"))

    assert discover["tools"][0]["name"] == "Fake_calculate"
    assert inspect["tool"]["license"] == "MIT"
    assert rejected["error_code"] == "inspect_required"
    assert run["ok"] is True
    assert run["result"]["data"]["value"] == 4
    assert run["data_sources"] == ["fixture"]
    assert status["status"] == "healthy"
    assert ("run", {"name": "Fake_calculate", "arguments": {"x": 2}}) in backend.calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("backend_status", "error_code"),
    [("error", "backend_error"), ("failed", "backend_error"), ("unavailable", "backend_unavailable")],
)
async def test_scientific_tool_does_not_mark_backend_failure_as_success(backend_status, error_code):
    class FailingBackend:
        def tool_specification(self, tool_name: str, *, return_prompt: bool = False):
            return {"name": tool_name, "parameters": {}}

        def run(self, function_call):
            return {"status": backend_status, "message": "fixture failure"}

        def status(self, tool_id: str | None = None):
            return {"status": backend_status, "message": "fixture failure"}

    tool = ScientificTool(backend=FailingBackend())
    await tool.execute(action="inspect", tool_id="Fake_failure")
    payload = json.loads(
        await tool.execute(action="run", tool_id="Fake_failure", arguments={})
    )

    assert payload["ok"] is False
    assert payload["status"] == backend_status
    assert payload["error_code"] == error_code
    assert payload["result"]["message"] == "fixture failure"
    status = json.loads(
        await tool.execute(action="status", tool_id="Fake_failure")
    )
    assert status["ok"] is False
    assert status["status"] == backend_status
    assert status["error_code"] == error_code
    assert status["result"]["message"] == "fixture failure"
