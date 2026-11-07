"""Hosted Work reuses desktop discovery without expanding its authorized tools."""
import asyncio
import base64
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.config import paths as config_paths
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.tools import HostedTool, HostedTools


def names(registry):
    return {item["function"]["name"] for item in registry.get_definitions()}


def tool(name):
    return HostedTool(name, "fixture", {}, [], AsyncMock(return_value=name + " done"))


def enable_fixture_image(instance):
    registry = instance.registry
    registry.register(tool("generate_image"))
    registry.set_allowed_tool_names(set(registry.get_allowed_tool_names() or ()) | {"generate_image"})
    instance.skills.allowed_names.add("generate_image")


@pytest.fixture
def factory(monkeypatch):
    def deny_private(*_args):
        pytest.fail("Hosted Work must not resolve private or expert Skill directories")

    monkeypatch.setattr(config_paths, "get_agent_skills_dir", deny_private)

    def make(*, metadata=None, attachments=(), history=(), extra=()):
        config = HostedWorkConfig()
        sandbox = SimpleNamespace(config=config, execute=AsyncMock(return_value={"exit_code": 0, "output": "ok"}),
                                  file=AsyncMock(return_value={"path": "test.txt", "size": 3, "sha256": "a" * 64}))
        editors = [tool("office"), tool("canvas"), *extra]
        instance = HostedTools(sandbox, AsyncMock(), editors, session_id="a" * 32, config=config,
                               metadata=metadata, attachments=attachments, history=history)
        return instance, sandbox, editors

    return make


@pytest.mark.asyncio
async def test_shared_capability_loader_hides_then_enables_only_authorized_tools(factory):
    denied = [tool("browser_act"), tool("computer_observe"), tool("terminal_exec"), tool("generate_image")]
    instance, sandbox, editors = factory(extra=denied)
    registry = instance.registry
    initial = names(registry)
    assert {"load_capability", "skill_read", "read_file", "list_dir", "web_fetch", "canvas"} <= initial
    assert not {"office", "exec", "write_file", "skill_reference_read", "skill_asset_copy", "skill_script_run"} & initial
    assert all(not registry.has(name) for name in ("browser_act", "computer_observe", "terminal_exec", "generate_image"))
    assert not next(item for item in instance.skills.catalog() if item["name"] == "image-generation")["available"]
    blocked = await registry.execute("office", {})
    assert "load_capability" in blocked and not editors[0].callback.await_count
    unavailable = await registry.execute("load_capability", {"capabilities": ["browser"]})
    assert "none in this configuration" in unavailable and not registry.has("browser_act")
    assert "Invalid parameters" in await registry.execute("load_capability", {"capabilities": ["not-a-capability"]})
    assert "office" in await registry.execute("load_capability", {"capabilities": ["office"]})
    assert "office" in names(registry) and await registry.execute("office", {}) == "office done"
    assert "write_file" in await registry.execute("load_capability", {"capabilities": ["development"]})
    assert {"exec", "write_file"} <= names(registry)
    await registry.execute("exec", {"command": "pwd"})
    sandbox.execute.assert_awaited_once_with("pwd")


@pytest.mark.asyncio
async def test_image_capability_uses_hosted_builtin_loader_without_private_telemetry(factory, monkeypatch):
    import mona.agent as agent

    instance, sandbox, _editors = factory()
    enable_fixture_image(instance)
    loader = instance.skills.loader
    loaded = MagicMock(wraps=loader.load_skills_for_context)
    monkeypatch.setattr(loader, "load_skills_for_context", loaded)
    monkeypatch.setattr(agent, "skill_usage", SimpleNamespace(
        bump_access=lambda *_args, **_kwargs: pytest.fail("private telemetry accessed")), raising=False)
    registry = instance.registry

    result = await registry.execute("load_capability", {"capabilities": ["image"]})

    loaded.assert_called_once_with(["image-generation"], track_usage=False)
    assert "### Skill: image-generation" in result and "# Image Generation" in result
    assert str(instance.skills.root) not in result
    assert instance.skills.loaded == {"image-generation"}
    assert {"generate_image", "skill_reference_read", "skill_script_run"} <= names(registry)
    assert instance.skills.file("image-generation", "scripts/find_upstream_cases.py").is_file()
    reference = await registry.execute("skill_reference_read", {
        "skill": "image-generation", "ref_path": "upstream/templates-index.md",
    })
    assert reference and not (isinstance(reference, str) and reference.startswith("Error:"))
    sandbox.file.assert_not_awaited()
    sandbox.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_image_capability_stays_unavailable_without_a_registered_backend(factory, monkeypatch):
    instance, _sandbox, _editors = factory(extra=[tool("generate_image")])
    loaded = MagicMock(wraps=instance.skills.loader.load_skills_for_context)
    monkeypatch.setattr(instance.skills.loader, "load_skills_for_context", loaded)

    result = await instance.registry.execute("load_capability", {"capabilities": ["image"]})

    assert "none in this configuration" in result
    assert "### Skill: image-generation" not in result
    assert not instance.registry.has("generate_image") and not instance.skills.loaded
    loaded.assert_not_called()


@pytest.mark.asyncio
async def test_image_capability_rejects_linked_skill_before_enabling(factory, tmp_path, monkeypatch):
    builtin = tmp_path / "builtin"
    private = tmp_path / "private"
    builtin.mkdir()
    private.mkdir()
    (private / "SKILL.md").write_text("PRIVATE_SKILL_MUST_NOT_LOAD", encoding="utf-8")
    try:
        (builtin / "image-generation").symlink_to(private, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("creating a directory symlink is unavailable on this host")
    monkeypatch.setattr("mona.hosted_work.skills.BUILTIN_SKILLS_DIR", builtin)
    instance, _sandbox, _editors = factory()
    enable_fixture_image(instance)
    loaded = MagicMock(wraps=instance.skills.loader.load_skills_for_context)
    monkeypatch.setattr(instance.skills.loader, "load_skills_for_context", loaded)

    result = await instance.registry.execute("load_capability", {"capabilities": ["image"]})

    assert result.startswith("Error:") and "PRIVATE_SKILL_MUST_NOT_LOAD" not in result
    assert "generate_image" not in names(instance.registry) and not instance.skills.loaded
    loaded.assert_not_called()


@pytest.mark.asyncio
async def test_image_capability_rejects_detected_link_on_all_platforms(factory, monkeypatch):
    instance, _sandbox, _editors = factory()
    enable_fixture_image(instance)
    skill_dir = instance.skills.root / "image-generation"
    original = type(skill_dir).is_symlink
    monkeypatch.setattr(type(skill_dir), "is_symlink", lambda path: path == skill_dir or original(path))
    loaded = MagicMock(wraps=instance.skills.loader.load_skills_for_context)
    monkeypatch.setattr(instance.skills.loader, "load_skills_for_context", loaded)

    result = await instance.registry.execute("load_capability", {"capabilities": ["image"]})

    assert result.startswith("Error:") and "generate_image" not in names(instance.registry)
    assert not instance.skills.loaded
    loaded.assert_not_called()


def test_default_skill_context_loading_retains_desktop_usage_tracking(tmp_path, monkeypatch):
    import mona.agent as agent
    from mona.agent.skills import SkillsLoader

    bump = MagicMock()
    monkeypatch.setattr(agent, "skill_usage", SimpleNamespace(bump_access=bump), raising=False)
    content = SkillsLoader(tmp_path).load_skills_for_context(["image-generation"])
    assert "### Skill: image-generation" in content
    bump.assert_called_once_with("image-generation", agent_id="mona")


@pytest.mark.asyncio
async def test_successful_ppt_skill_read_enables_office_and_builtin_references(factory):
    instance, _sandbox, _editors = factory()
    registry = instance.registry
    assert (await registry.execute("skill_read", {"name": "no-such-skill"})).startswith("Error:")
    assert not {"office", "skill_reference_read"} & names(registry)
    result = await registry.execute("skill_read", {"name": "mona-pptx"})
    first = result if isinstance(result, str) else result[0]["text"]
    assert first.startswith("Skill: ")
    assert instance.skills.loaded == {"mona-pptx"}
    assert {"office", "skill_reference_read", "skill_asset_copy", "skill_script_run"} <= names(registry)
    reference = await registry.execute("skill_reference_read", {"skill": "mona-design", "ref_path": "native-pptx.md"})
    text = reference if isinstance(reference, str) else "\n".join(item.get("text", "") for item in reference)
    assert text and not text.startswith("Error:") and "Mona" in text
    assert instance.skills.loaded == {"mona-pptx"}
    assert (await registry.execute("skill_asset_copy", {"skill": "mona-design", "asset": "x", "dest": "x"})).startswith("Error:")
    assert (await registry.execute("skill_script_run", {"skill": "mona-design", "script": "x.py"})).startswith("Error:")


@pytest.mark.asyncio
async def test_ppt_dependency_assets_copy_without_loading_a_second_skill(factory, monkeypatch):
    instance, sandbox, _ = factory()
    monkeypatch.setattr("shutil.copy2", lambda *_args, **_kwargs: pytest.fail("assets must be copied inside the sandbox"))

    async def upload(request):
        assert request["action"] == "upload"
        raw = base64.b64decode(request["data"], validate=True)
        return {"path": request["path"], "name": request["path"].rsplit("/", 1)[-1],
                "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

    sandbox.file.side_effect = upload
    registry = instance.registry
    await registry.execute("skill_read", {"name": "mona-pptx"})
    await registry.execute("skill_reference_read", {"skill": "mona-design", "ref_path": "native-pptx.md"})
    assets = ["09-bento-grid.jpg", "10-dark-hairline-terminal.jpg", "11-two-font-consulting.jpg"]
    for index, name in enumerate(assets):
        asset = "style-specimens/ppt/" + name
        result = json.loads(await registry.execute("skill_asset_copy", {
            "skill": "mona-design", "asset": asset, "dest": f"/workspace/style-{index}.jpg",
        }))
        raw = (instance.skills.root / "mona-design/assets" / asset).read_bytes()
        assert result["ok"] is True and result["sha256"] == hashlib.sha256(raw).hexdigest()
    assert instance.skills.loaded == {"mona-pptx"}
    assert sandbox.file.await_count == 3
    sandbox.execute.assert_not_awaited()
    assert (await registry.execute("skill_script_run", {"skill": "mona-design", "script": "x.py"})).startswith("Error:")
    assert (await registry.execute("skill_asset_copy", {
        "skill": "private-secret", "asset": "x.jpg", "dest": "out.jpg",
    })).startswith("Error:")
    assert sandbox.file.await_count == 3


@pytest.mark.asyncio
async def test_explicit_resource_loading_is_read_only_and_private_skills_stay_unavailable(factory):
    instance, sandbox, _editors = factory()
    registry = instance.registry
    assert "skill_reference_read" not in names(registry)
    assert "skill_reference_read" in await registry.execute("load_capability", {"capabilities": ["skill_resources"]})
    assert "skill_reference_read" in names(registry)
    reference = await registry.execute("skill_reference_read", {"skill": "mona-design", "ref_path": "native-pptx.md"})
    assert not (isinstance(reference, str) and reference.startswith("Error:"))
    assert (await registry.execute("skill_reference_read", {"skill": "private-secret", "ref_path": "x.md"})).startswith("Error:")
    assert (await registry.execute("skill_asset_copy", {"skill": "mona-design", "asset": "x", "dest": "x"})).startswith("Error:")
    assert (await registry.execute("skill_script_run", {"skill": "mona-design", "script": "x.py"})).startswith("Error:")
    sandbox.file.assert_not_awaited()
    sandbox.execute.assert_not_awaited()


def test_active_office_and_pdf_attachment_reuse_the_desktop_preload(factory):
    office, _, _ = factory(metadata={"office_session_id": "office_1", "office_document_type": "slides"})
    assert "office" in names(office.registry) and "exec" not in names(office.registry)
    pdf, _, _ = factory(attachments=[{"path": "/workspace/input.PDF"}])
    assert "office" in names(pdf.registry) and "exec" not in names(pdf.registry)
    canvas, _, _ = factory(metadata={"canvas_id": "canvas_1"})
    assert "canvas" in names(canvas.registry) and "office" not in names(canvas.registry)


@pytest.mark.asyncio
async def test_history_restores_successful_discoveries_without_replaying_calls(factory):
    history = [
        {"role": "assistant", "tool_calls": [
            {"id": "success", "function": {"name": "skill_read", "arguments": json.dumps({"name": "mona-pptx"})}},
            {"id": "failed", "function": {"name": "skill_read", "arguments": json.dumps({"name": "mona-motion"})}},
            {"id": "dev", "function": {"name": "load_capability", "arguments": json.dumps({"capabilities": ["development"]})}},
        ]},
        {"role": "tool", "tool_call_id": "success", "content": [{"type": "text", "text": "Skill: {\"name\":\"mona-pptx\"}"}]},
        {"role": "tool", "tool_call_id": "failed", "content": "Error: unavailable"},
        {"role": "tool", "tool_call_id": "dev", "content": "Loaded capabilities: development."},
    ]
    instance, sandbox, editors = factory(history=history)
    assert instance.skills.loaded == {"mona-pptx"} and instance.skills.restored_read_ids == {"success"}
    assert {"office", "exec", "write_file", "skill_reference_read"} <= names(instance.registry)
    assert not instance.registry.has("video") and not instance.registry.has("generate_image")
    sandbox.file.assert_not_awaited()
    sandbox.execute.assert_not_awaited()
    assert not editors[0].callback.await_count


@pytest.mark.asyncio
async def test_loading_never_reinstates_explicitly_denied_tools(factory):
    instance, _sandbox, _editors = factory()
    registry = instance.registry
    registry.set_allowed_tool_names(set(registry.tool_names) - {"office", "skill_script_run"})
    await registry.execute("skill_read", {"name": "mona-pptx"})
    assert "none in this configuration" in await registry.execute("load_capability", {"capabilities": ["office"]})
    assert not registry.is_permitted("office") and "office" not in names(registry)
    assert not registry.is_permitted("skill_script_run") and "skill_script_run" not in names(registry)


@pytest.mark.asyncio
async def test_capability_state_is_separate_for_parallel_turns(factory):
    ready = asyncio.Event()
    loaded = asyncio.Event()

    async def first():
        instance, _sandbox, _editors = factory()
        ready.set()
        await loaded.wait()
        return names(instance.registry)

    async def second():
        await ready.wait()
        instance, _sandbox, _editors = factory()
        await instance.registry.execute("load_capability", {"capabilities": ["office"]})
        result = names(instance.registry)
        loaded.set()
        return result

    left, right = await asyncio.gather(first(), second())
    assert "office" not in left and "office" in right
