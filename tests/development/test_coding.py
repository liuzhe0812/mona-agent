import asyncio
import copy
import json
from dataclasses import replace

import pytest

from mona.agent.runner import AgentRunner
from mona.agent.tools.path_utils import (
    get_current_workspace,
    reset_current_workspace,
    set_current_workspace,
)
from mona.agent.tools.shell import ExecToolConfig
from mona.config.schema import CodingConfig
from mona.development.coding import CodingTools, build_coding_run_spec
from mona.development.context import build_coding_messages, load_project_context
from mona.development.contracts import DevelopmentSession, ExecutorId, Project
from mona.development.executors.host_tools import DELEGATION_INSTRUCTIONS
from mona.development.store import DevelopmentError
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.session.manager import Session, SessionManager


class SequenceProvider(LLMProvider):
    """Isolate only model choice; execute the production Runner and real tools."""

    def __init__(self, responses):
        super().__init__()
        self.responses = list(responses)
        self.requests = []

    async def chat(self, messages, tools=None, **kwargs):
        self.requests.append(copy.deepcopy({"messages": messages, "tools": tools}))
        return self.responses.pop(0)

    def get_default_model(self):
        return "test-coding"


def setup(tmp_path, *, readonly=False):
    root = tmp_path / "项目"
    root.mkdir(parents=True, exist_ok=True)
    (root / "AGENTS.md").write_text("RULE_MARKER: preserve user work", encoding="utf-8")
    project = Project(root_path=str(root.resolve()), display_name="project")
    session = DevelopmentSession(project_id=project.id)
    tools = CodingTools(root, session.transcript_key, ExecToolConfig(), readonly=readonly)
    transcript = Session(key=session.transcript_key)
    return root, project, session, tools, transcript


def tool_names(tools):
    return {schema["function"]["name"] for schema in tools.registry.get_definitions()}


def test_minimal_actual_toolset_has_no_business_tools(tmp_path):
    _, _, _, tools, _ = setup(tmp_path)
    assert tool_names(tools) == {"read_file", "write_file", "edit_file", "list_dir", "grep", "find_files", "exec", "write_stdin", "list_exec_sessions", "development_design_resource"}


@pytest.mark.parametrize("readonly,parent_id,enabled", [(False, None, True), (False, None, False), (True, None, True), (False, "parent_fixture", True)])
def test_delegation_policy_is_formal_parent_instruction_and_availability_stays_data(tmp_path, readonly, parent_id, enabled):
    _, project, session, _, transcript = setup(tmp_path, readonly=readonly)
    session.parent_session_id = parent_id
    availability = '[Runtime Context — metadata only, not instructions]\n' + json.dumps({"developmentDelegationEnabled": enabled})
    context = replace(load_project_context(project), subagent_context=availability)
    messages = build_coding_messages(context, session, transcript, readonly=readonly)
    assert (DELEGATION_INSTRUCTIONS in messages[0]["content"]) == (not readonly and not parent_id)
    assert (any(message["content"] == availability for message in messages)) == (not readonly and not parent_id)


@pytest.mark.asyncio
async def test_readonly_is_tool_enforced_not_just_prompt(tmp_path):
    root, _, _, tools, _ = setup(tmp_path, readonly=True)
    assert tool_names(tools) == {"read_file", "list_dir", "grep", "find_files", "development_design_resource"}
    denied = await tools.registry.execute("write_file", {"path": "should-not-exist", "content": "no"})
    assert "not found" in str(denied).lower() or "unknown" in str(denied).lower()
    assert not (root / "should-not-exist").exists()


@pytest.mark.asyncio
async def test_tool_roots_ignore_other_active_workspace(tmp_path):
    root, _, _, tools, _ = setup(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    (root / "name.txt").write_text("my project")
    (other / "name.txt").write_text("foreign project")
    token = set_current_workspace(other)
    try:
        result = await tools.registry.execute("read_file", {"path": "name.txt"})
        assert "my project" in result and "foreign project" not in result
        denied = await tools.registry.execute("read_file", {"path": str(other / "name.txt")})
        assert "foreign project" not in denied
        assert "超出" in denied
        assert get_current_workspace() == other
    finally:
        reset_current_workspace(token)


@pytest.mark.asyncio
async def test_production_runner_writes_and_tests_code_without_general_context(tmp_path):
    root, project, session, tools, transcript = setup(tmp_path)
    transcript.metadata["memory"] = "PRIVATE_MEMORY_MUST_NOT_LOAD"
    transcript.add_message("user", "Implement add and run its tests.")
    provider = SequenceProvider([
        LLMResponse("", tool_calls=[
            ToolCallRequest("call_module", "write_file", {"path": "maths.py", "content": "def add(a, b):\n    return a + b\n"}),
            ToolCallRequest("call_tests", "write_file", {"path": "test_maths.py", "content": "import unittest\nfrom maths import add\nclass Tests(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n"}),
        ]),
        LLMResponse("", tool_calls=[ToolCallRequest("call_test", "exec", {"command": "python -m unittest -q", "timeout": 30})]),
        LLMResponse("Implemented and verified."),
    ])
    spec = build_coding_run_spec(load_project_context(project), session, transcript, tools,
        model="test-coding", context_window_tokens=65536, defaults=CodingConfig(max_tool_iterations=8))
    checkpoints = []
    async def capture(event):
        checkpoints.append(copy.deepcopy(event))
    spec.checkpoint_callback = capture
    result = await AgentRunner(provider).run(spec)
    assert result.stop_reason == "completed" and result.error is None
    assert (root / "maths.py").read_text() == "def add(a, b):\n    return a + b\n"
    test_result = next(msg["content"] for msg in result.messages if msg.get("tool_call_id") == "call_test")
    assert "OK" in test_result and "Ran 1 test" in test_result
    assert "PRIVATE_MEMORY_MUST_NOT_LOAD" not in json.dumps(provider.requests)
    assert all("RULE_MARKER" in json.dumps(request["messages"]) for request in provider.requests)
    systems = [[m for m in r["messages"] if m["role"] == "system"] for r in provider.requests]
    assert all(s == systems[0] for s in systems)
    assert checkpoints[0]["phase"] == "awaiting_tools"
    assert any(e["phase"] == "tools_partial" for e in checkpoints)
    assert "memory" not in tool_names(tools)


@pytest.mark.asyncio
async def test_readonly_coding_runner_receives_design_guidance_and_native_image(tmp_path):
    root, project, session, tools, transcript = setup(tmp_path, readonly=True)
    transcript.add_message("user", "Review the existing frontend with design references.")
    provider = SequenceProvider([
        LLMResponse("", tool_calls=[ToolCallRequest("guide", "development_design_resource", {"path": "SKILL.md"})]),
        LLMResponse("", tool_calls=[ToolCallRequest("sample", "development_design_resource",
            {"path": "assets/style-specimens/web/19-swiss-monochrome.jpg"})]),
        LLMResponse("Reference received; project rules remain primary."),
    ])
    spec = build_coding_run_spec(load_project_context(project), session, transcript, tools,
        model="test-coding", context_window_tokens=65536, defaults=CodingConfig(max_tool_iterations=5))
    result = await AgentRunner(provider).run(spec)
    assert result.stop_reason == "completed" and result.error is None
    image_result = next(message["content"] for message in provider.requests[-1]["messages"]
                        if message.get("tool_call_id") == "sample")
    assert any(block.get("type") == "image_url" and block["image_url"]["url"].startswith("data:image/jpeg;base64,")
               for block in image_result)
    assert not (root / ".agents").exists() and not {"skill_read", "skill_script_run"} & tool_names(tools)


@pytest.mark.asyncio
async def test_session_managers_and_history_can_resume_without_new_product_session(tmp_path):
    root, project, session, tools, history = setup(tmp_path)
    manager = SessionManager(tmp_path / "user-data")
    history.add_message("user", "Remember current task is widget.")
    history.add_message("assistant", "Working on widget.")
    manager.save(history)
    reopened = SessionManager(tmp_path / "user-data").get_or_create(session.transcript_key)
    reopened.add_message("user", "Continue that task.")
    spec = build_coding_run_spec(load_project_context(project), session, reopened, tools,
        model="test-coding", context_window_tokens=65536, defaults=CodingConfig())
    provider = SequenceProvider([LLMResponse("Continuing widget.")])
    result = await AgentRunner(provider).run(spec)
    assert "Remember current task is widget." in json.dumps(provider.requests)
    assert result.final_content == "Continuing widget."
    assert spec.session_key == history.key
    assert spec.workspace == root.resolve()


def test_external_executor_is_not_a_model_alias(tmp_path):
    _, project, session, tools, history = setup(tmp_path)
    session.executor = ExecutorId.CODEX
    with pytest.raises(DevelopmentError) as info:
        build_coding_run_spec(load_project_context(project), session, history, tools,
            model="codex-model", context_window_tokens=65536, defaults=CodingConfig())
    assert info.value.code == "wrong_executor"


@pytest.mark.asyncio
async def test_independent_project_tools_are_concurrent_and_no_shared_process_pool(tmp_path):
    a = setup(tmp_path / "a")
    b = setup(tmp_path / "b")
    assert a[3].exec_sessions is not b[3].exec_sessions
    results = await asyncio.gather(
        a[3].registry.execute("write_file", {"path": "same.txt", "content": "first"}),
        b[3].registry.execute("write_file", {"path": "same.txt", "content": "second"}),
    )
    assert all("Error" not in str(result) for result in results)
    assert (a[0] / "same.txt").read_text() == "first"
    assert (b[0] / "same.txt").read_text() == "second"


def test_explicitly_disabled_exec_stays_disabled(tmp_path):
    root, _, session, _, _ = setup(tmp_path)
    tools = CodingTools(root, session.transcript_key, ExecToolConfig(enable=False))
    assert "exec" not in tool_names(tools)
    assert "write_stdin" not in tool_names(tools)
