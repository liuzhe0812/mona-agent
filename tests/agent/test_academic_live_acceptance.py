"""Live acceptance tests for the shipped academic-researcher partner agent.

These tests intentionally use the real configured model and the real partner
loop.  They are skipped unless the caller opts in with
``RUN_LIVE_RESEARCH_ACCEPTANCE=1`` and a provider API key is configured.
"""

from __future__ import annotations

import json
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import pytest

from mona.academic.models import EvidenceClaim, EvidenceLocator, SourceRecord
from mona.academic.store import ResearchRecordStore
from mona.agent.partners import AgentRegistry, ConversationMetadata

ACADEMIC_AGENT_ID = "com.mona.academic-researcher"
RUN_LIVE_RESEARCH_ACCEPTANCE = os.getenv("RUN_LIVE_RESEARCH_ACCEPTANCE") == "1"
FIXTURES = Path(__file__).parents[1] / "fixtures" / "academic_research"


def _configured_live_skip_reason() -> str | None:
    if not RUN_LIVE_RESEARCH_ACCEPTANCE:
        return "set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live agent acceptance"
    try:
        from mona.config.loader import load_config, resolve_config_env_vars
        from mona.providers.registry import find_by_name

        config = resolve_config_env_vars(load_config())
        preset = config.resolve_preset()
        provider_name = config.get_provider_name(preset.model, preset=preset)
        provider_config = config.get_provider(preset.model, preset=preset)
        if not preset.model or not provider_name:
            return "no active model/provider preset is configured"
        provider_spec = find_by_name(provider_name)
        if not provider_config or not provider_config.api_key:
            if not provider_spec or not provider_spec.is_local:
                return "active provider has no configured API key"
        definition = AgentRegistry().get(ACADEMIC_AGENT_ID)
        if definition is None:
            return f"agent package is unavailable: {ACADEMIC_AGENT_ID}"
        from mona.agent.user_config import load_agent_user_config

        if not load_agent_user_config(ACADEMIC_AGENT_ID).enabled:
            return "academic-researcher partner is disabled in user configuration"
    except Exception as exc:
        return f"live model configuration unavailable: {type(exc).__name__}: {exc}"
    return None


def _tool_invocations(messages: list[dict]) -> list[tuple[str, dict]]:
    calls: list[tuple[str, dict]] = []
    for message in messages:
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            name = function.get("name")
            raw_arguments = function.get("arguments") or "{}"
            try:
                arguments = json.loads(raw_arguments)
            except (TypeError, json.JSONDecodeError):
                arguments = {}
            if isinstance(name, str):
                calls.append((name, arguments if isinstance(arguments, dict) else {}))
    return calls


def _tool_results(messages: list[dict], name: str) -> list[dict]:
    results: list[dict] = []
    for message in messages:
        if message.get("role") != "tool" or message.get("name") != name:
            continue
        content = message.get("content")
        if not isinstance(content, str):
            continue
        try:
            payload = json.loads(content)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            results.append(payload)
    return results


@asynccontextmanager
async def _live_bot(tmp_path: Path):
    reason = _configured_live_skip_reason()
    if reason:
        pytest.skip(reason)
    from mona.config.paths import get_agent_output_dir
    from mona.mona import Mona

    bot = Mona.from_config(workspace=tmp_path)
    agent_workspace = get_agent_output_dir(tmp_path, ACADEMIC_AGENT_ID)
    session_key = f"live-academic:{uuid4().hex}"
    session = bot._loop.sessions.get_or_create(session_key)
    session.metadata["conversation"] = ConversationMetadata.direct(
        ACADEMIC_AGENT_ID,
        title="Academic live acceptance",
    ).to_session_metadata()
    bot._loop.sessions.save(session)
    try:
        yield bot, session_key, agent_workspace
    finally:
        await bot._loop.close_mcp()


@pytest.mark.asyncio
@pytest.mark.skipif(
    not RUN_LIVE_RESEARCH_ACCEPTANCE,
    reason="set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live agent acceptance",
)
async def test_live_academic_agent_reads_pdf_records_evidence_and_map(tmp_path: Path):
    async with _live_bot(tmp_path) as runtime:
        bot, session_key, agent_workspace = runtime
        pdf = agent_workspace / "synthetic-paper.pdf"
        shutil.copy2(FIXTURES / "papers" / "synthetic-paper.pdf", pdf)
        task_id = "live_pdf_evidence"
        prompt = f"""
You are the academic-researcher partner in a live acceptance test. Work on the
fixed PDF at {pdf.name} and do real tool calls; do not merely describe what you
would do.

1. Read the PDF with the document tool and use the research-evidence skill.
2. Create research task {task_id} with research_record.init.
3. Extract one real source record from the PDF, one fact claim with an exact
   page locator, and a source-backed knowledge map. Write them with
   research_record.source_upsert, claim_append, and map_write.
4. Call research_record.validate and report its actual result. Do not invent
   identifiers, page numbers, or values that are not present in the PDF.
"""
        result = await bot.run(prompt, session_key=session_key)
        invocations = _tool_invocations(result.messages)
        names = [name for name, _ in invocations]
        assert "document" in names, names
        assert "research_record" in names, names
        records = [arguments for name, arguments in invocations if name == "research_record"]
        assert any(arguments.get("action") == "init" for arguments in records)
        assert any(arguments.get("action") == "source_upsert" for arguments in records)
        assert any(arguments.get("action") == "claim_append" for arguments in records)
        assert any(arguments.get("action") == "map_write" for arguments in records)
        assert any(arguments.get("action") == "validate" for arguments in records)

        store = ResearchRecordStore(agent_workspace)
        manifest = store.status(task_id)
        sources = store.read_sources(task_id)
        claims = store.read_claims(task_id)
        knowledge_map = store.read_map(task_id)
        validation = store.validate(task_id)
        assert sources
        assert claims
        assert knowledge_map is not None
        assert knowledge_map.nodes
        assert validation["valid"] is True, validation
        assert _tool_results(result.messages, "research_record")
        assert result.content.strip()
        assert manifest.artifacts.get("sources")
        assert manifest.artifacts.get("claims")
        assert manifest.artifacts.get("knowledge_map")


@pytest.mark.asyncio
@pytest.mark.skipif(
    not RUN_LIVE_RESEARCH_ACCEPTANCE,
    reason="set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live agent acceptance",
)
async def test_live_academic_agent_writes_cited_markdown_and_registers_deliverable(tmp_path: Path):
    async with _live_bot(tmp_path) as runtime:
        bot, session_key, agent_workspace = runtime
        task_id = "live_writing_delivery"
        ledger_fixture = json.loads(
            (FIXTURES / "writing" / "evidence-ledger.json").read_text(encoding="utf-8")
        )
        store = ResearchRecordStore(agent_workspace)
        store.init(task_id, goal="Write an evidence-led Markdown research note")
        source_fixture = ledger_fixture["sources"][0]
        source = SourceRecord(
            source_id=source_fixture["source_id"],
            title=source_fixture["title"],
            authors=["Fixture Author"],
            published_at="2026-01-02",
            venue="Synthetic Journal",
            source_type="paper",
            doi="10.0000/example.1",
            url="https://example.invalid/paper",
            abstract="A fixed acceptance-test source.",
            retrieved_at="2026-08-22T00:00:00Z",
            provider="acceptance-fixture",
            providers=["acceptance-fixture"],
        )
        store.source_upsert(task_id, source)
        claim_fixture = ledger_fixture["claims"][0]
        store.claim_append(
            task_id,
            EvidenceClaim(
                claim_id=claim_fixture["claim_id"],
                claim_type="fact",
                claim_text=claim_fixture["claim_text"],
                source_ids=[source.source_id],
                evidence_text=claim_fixture["claim_text"],
                locator=EvidenceLocator(kind="page", value="2"),
                supports="support",
                verification_status="verified",
            )
        )
        ledger_path = agent_workspace / "fixed-evidence-ledger.json"
        ledger_path.write_text(json.dumps(ledger_fixture, ensure_ascii=False, indent=2), encoding="utf-8")
        prompt = f"""
You are the academic-researcher partner in a live acceptance test. The fixed
evidence ledger is already initialized for task {task_id}; read the ledger
files under research/{task_id}/ and the attached reference file
{ledger_path.name}. Do not invent or add sources.

Write a concise Markdown research note under the task's deliverables directory
using only the existing source and claim. Include the source_id and a page-2
locator next to the factual statement. Use research_record.validate, register
the Markdown with research_record.deliverable_register using the existing
source/claim IDs, then call deliver_file for the Markdown. Report the actual
validation result and do not claim experiments or approvals that are absent.
"""
        result = await bot.run(prompt, session_key=session_key)
        invocations = _tool_invocations(result.messages)
        names = [name for name, _ in invocations]
        assert "research_record" in names, names
        assert "deliver_file" in names, names
        records = [arguments for name, arguments in invocations if name == "research_record"]
        assert any(arguments.get("action") == "validate" for arguments in records)
        assert any(arguments.get("action") == "deliverable_register" for arguments in records)
        assert "write_file" in names or "edit_file" in names, names

        validation = store.validate(task_id)
        deliverables = store.read_deliverables(task_id)
        assert validation["valid"] is True, validation
        assert deliverables
        deliverable = deliverables[-1]
        deliverable_path = store.read_artifact(task_id, deliverable.path)
        markdown = deliverable_path.read_text(encoding="utf-8")
        assert source.source_id in markdown
        assert "page" in markdown.lower()
        assert set(deliverable.source_ids) == {source.source_id}
        assert set(deliverable.claim_ids) == {claim_fixture["claim_id"]}
        assert result.content.strip()


@pytest.mark.asyncio
@pytest.mark.skipif(
    not RUN_LIVE_RESEARCH_ACCEPTANCE,
    reason="set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live agent acceptance",
)
async def test_live_academic_agent_designs_then_writes_grant_and_review(tmp_path: Path):
    async with _live_bot(tmp_path) as runtime:
        bot, session_key, agent_workspace = runtime
        task_id = "live_design_grant_review"
        ledger_fixture = json.loads(
            (FIXTURES / "writing" / "evidence-ledger.json").read_text(encoding="utf-8")
        )
        store = ResearchRecordStore(agent_workspace)
        store.init(task_id, goal="Design a research plan and prepare grant/reviewer materials")
        source_fixture = ledger_fixture["sources"][0]
        claim_fixture = ledger_fixture["claims"][0]
        source = SourceRecord(
            source_id=source_fixture["source_id"],
            title=source_fixture["title"],
            authors=["Fixture Author"],
            published_at="2026-01-02",
            venue="Synthetic Journal",
            source_type="paper",
            doi="10.0000/example.1",
            url="https://example.invalid/paper",
            abstract="A fixed acceptance-test source.",
            retrieved_at="2026-08-22T00:00:00Z",
            provider="acceptance-fixture",
            providers=["acceptance-fixture"],
        )
        store.source_upsert(task_id, source)
        store.claim_append(
            task_id,
            EvidenceClaim(
                claim_id=claim_fixture["claim_id"],
                claim_type="fact",
                claim_text=claim_fixture["claim_text"],
                source_ids=[source.source_id],
                evidence_text=claim_fixture["claim_text"],
                locator=EvidenceLocator(kind="page", value="2"),
                supports="support",
                verification_status="verified",
            ),
        )
        for filename in ("grant-requirements.md", "review-comments.json"):
            shutil.copy2(FIXTURES / "writing" / filename, agent_workspace / filename)

        prompt = f"""
You are the academic-researcher partner in a live acceptance test. The task
{task_id} has a closed, fixed evidence ledger under research/{task_id}/. Use
only its existing source_id {source.source_id} and claim_id {claim_fixture['claim_id']};
do not call providers or add sources. Read grant-requirements.md and
review-comments.json from the workspace as fixed requirements.

First read the research-design skill and write
research/{task_id}/deliverables/research-design.json. The JSON object must use
exactly these top-level fields and fill each with structured content:
research_question, related_work, falsifiable_hypothesis, alternative_explanations,
confirmation_conditions, falsification_conditions, object_or_data,
independent_variables, dependent_variables, control_variables, confounders,
controls_or_baseline, primary_endpoint, metrics, failure_modes,
ethics_privacy_boundary. related_work must cite {source.source_id}; the
hypothesis must remain proposed, not an experimental result. Mark novelty or
feasibility as unverified where the ledger is insufficient.

Then read the research-writing skill and write
research/{task_id}/deliverables/grant-and-review.md. Include sections for
grant significance/need, specific aims, technical route, innovation, risks,
alternative plans, and abstract. Add separate R1 and R2 responses from the
fixed review-comments.json, each with decision, evidence (using only
{source.source_id}/{claim_fixture['claim_id']}), modification location, and
response draft. Do not claim an experiment was completed or that ethics
approval/data access already exists; label them as proposed or pending.

Register both files with research_record.deliverable_register using the
existing source and claim IDs, call research_record.validate, and call
deliver_file for both Markdown/JSON deliverables. Do real tool calls and report
the actual validation result.
"""
        result = await bot.run(prompt, session_key=session_key)
        invocations = _tool_invocations(result.messages)
        names = [name for name, _ in invocations]
        assert "skill_read" in names, names
        assert "research_record" in names, names
        deliver_calls = [arguments for name, arguments in invocations if name == "deliver_file"]
        assert deliver_calls, names
        delivered_paths = json.dumps(deliver_calls, ensure_ascii=False)
        assert "research-design.json" in delivered_paths
        assert "grant-and-review.md" in delivered_paths
        records = [arguments for name, arguments in invocations if name == "research_record"]
        registrations = [
            arguments
            for arguments in records
            if arguments.get("action") == "deliverable_register"
        ]
        assert len(registrations) >= 2, records
        assert any(arguments.get("action") == "validate" for arguments in records)

        validation = store.validate(task_id)
        assert validation["valid"] is True, validation
        deliverables = store.read_deliverables(task_id)
        assert len(deliverables) >= 2
        files = {
            Path(deliverable.path).name: store.read_artifact(task_id, deliverable.path)
            for deliverable in deliverables
        }
        design_path = files.get("research-design.json")
        writing_path = files.get("grant-and-review.md")
        assert design_path is not None, files
        assert writing_path is not None, files
        design = json.loads(design_path.read_text(encoding="utf-8"))
        required_design_fields = {
            "research_question",
            "related_work",
            "falsifiable_hypothesis",
            "alternative_explanations",
            "confirmation_conditions",
            "falsification_conditions",
            "object_or_data",
            "independent_variables",
            "dependent_variables",
            "control_variables",
            "confounders",
            "controls_or_baseline",
            "primary_endpoint",
            "metrics",
            "failure_modes",
            "ethics_privacy_boundary",
        }
        assert required_design_fields <= set(design)
        assert all(design[field] not in (None, "", [], {}) for field in required_design_fields)
        design_text = json.dumps(design, ensure_ascii=False).lower()
        assert source.source_id in design_text
        assert "已获伦理批准" not in design_text
        assert "ethics approval obtained" not in design_text
        assert "experiment completed" not in design_text

        markdown = writing_path.read_text(encoding="utf-8")
        markdown_lower = markdown.lower()
        for heading in (
            "significance",
            "specific aims",
            "technical route",
            "innovation",
            "risks",
            "alternative",
            "abstract",
            "r1",
            "r2",
            "decision",
            "evidence",
            "modification",
            "response",
        ):
            assert heading in markdown_lower, heading
        assert source.source_id in markdown
        assert claim_fixture["claim_id"] in markdown
        for forbidden in ("已获伦理批准", "ethics approval obtained", "experiment completed"):
            assert forbidden not in markdown_lower
        assert result.content.strip()
