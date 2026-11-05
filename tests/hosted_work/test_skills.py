"""Hosted builtins expose only checked resources and execute in the user's sandbox."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import shlex
import tarfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.tools.registry import ToolRegistry
from mona.config import paths as config_paths
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.skills import HostedSkills


def _skill(root: Path, name: str) -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} fixture\n---\n# {name} builtin\n", encoding="utf-8",
    )
    return directory


@pytest.fixture
def hosted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = (tmp_path / "builtin").resolve()
    alpha = _skill(root, "alpha")
    (alpha / "references").mkdir()
    (alpha / "references" / "guide.md").write_text("alpha reference", encoding="utf-8")
    (alpha / "assets").mkdir()
    (alpha / "assets" / "logo.bin").write_bytes(b"trusted asset")
    (alpha / "scripts").mkdir()
    (alpha / "scripts" / "echo.py").write_text("print('fixture')\n", encoding="utf-8")

    beta = _skill(root, "beta")
    (beta / "references").mkdir()
    (beta / "references" / "secret.md").write_text("beta only", encoding="utf-8")
    design = _skill(root, "mona-design")
    (design / "references").mkdir()
    (design / "references" / "guide.md").write_text("abcdefghijk", encoding="utf-8")
    _skill(root, "pdf")

    def deny_private(_agent_id):
        pytest.fail("hosted Skill loading must not resolve a private Skill directory")

    monkeypatch.setattr(config_paths, "get_agent_skills_dir", deny_private)
    config = HostedWorkConfig(state_dir=str(tmp_path / "state"))

    async def upload(action, *, path, data):
        assert action == "upload"
        raw = base64.b64decode(data, validate=True)
        return {"path": path, "sha256": hashlib.sha256(raw).hexdigest()}

    async def stage(arguments, *, data):
        digest = hashlib.sha256(data).hexdigest()
        assert arguments[-1] == digest
        return 0, json.dumps({"root": "/tmp/mona-builtin-skills/" + digest}).encode()

    runtime = {"python": "3.11.9", "packages": {}}

    async def execute(command):
        if "importlib.metadata" in command:
            return json.dumps({"exit_code": 0, "output": json.dumps(runtime)})
        return json.dumps({"exit_code": 0, "output": "executed in fixture sandbox"})

    sandbox = SimpleNamespace(config=config, name="mona-work-fixture", _invoke=AsyncMock(side_effect=stage))
    tools = SimpleNamespace(config=config, sandbox=sandbox, registry=ToolRegistry(), fault=None,
                            _file=AsyncMock(side_effect=upload), execute=AsyncMock(side_effect=execute),
                            emit=AsyncMock())
    skills = HostedSkills(tools, {"exec", "office", "canvas"}, root=root)
    skills.register()
    return SimpleNamespace(skills=skills, tools=tools, root=root, runtime=runtime)


@pytest.mark.asyncio
async def test_builtin_names_are_allowlisted_and_private_layer_is_not_read(hosted, tmp_path):
    private = tmp_path / "private"
    _skill(private, "alpha")
    _skill(private, "private-secret")
    hosted.skills.loader.workspace_skills = private
    assert hosted.skills.loader.load_skill("private-secret") is None
    assert "alpha builtin" in hosted.skills.loader.load_skill("alpha")
    catalog = {item["name"]: item for item in hosted.skills.catalog()}
    assert set(catalog) == {"alpha", "beta", "mona-design", "pdf"}
    assert catalog["pdf"]["available"] is False
    assert catalog["pdf"]["missing_tools"] == ["pdf"]
    for name in ("private-secret", "../private-secret", "/alpha", r"C:\alpha", "alpha/../beta"):
        value = await hosted.skills.read(name)
        assert value.startswith("Error:")
        assert str(private) not in value
    assert hosted.skills.loaded == set()


@pytest.mark.asyncio
async def test_builtin_references_can_cross_skills_without_granting_execution(hosted):
    registry = hosted.tools.registry
    for name in ("skill_reference_read", "skill_asset_copy", "skill_script_run"):
        assert not registry.is_permitted(name)
    denied = await registry.execute("skill_reference_read", {"skill": "alpha", "ref_path": "guide.md"})
    assert "not permitted" in denied
    assert (await registry.execute("skill_read", {"name": "alpha"})).startswith("Skill: ")
    for name in ("skill_reference_read", "skill_asset_copy", "skill_script_run"):
        assert registry.is_permitted(name)
    assert await registry.execute("skill_reference_read", {"skill": "alpha", "ref_path": "guide.md"}) == "alpha reference"
    assert await registry.execute("skill_reference_read", {"skill": "beta", "ref_path": "secret.md"}) == "beta only"
    assert "beta" not in hosted.skills.loaded
    assert (await hosted.skills.asset("beta", "missing.bin", "copy.bin")).startswith("Error:")
    assert (await hosted.skills.script("beta", "missing.py")).startswith("Error:")
    assert (await hosted.skills.reference("private-secret", "guide.md")).startswith("Error:")


@pytest.mark.asyncio
@pytest.mark.parametrize("multimodal", [False, True])
async def test_completed_reads_restore_resource_scope_for_the_next_turn(hosted, multimodal):
    content = await hosted.skills.read("alpha")
    if multimodal:
        content = [{"type": "text", "text": content}]
    history = [
        {"role": "assistant", "tool_calls": [{"id": "read-alpha", "function": {
            "name": "skill_read", "arguments": json.dumps({"name": "alpha"}),
        }}]},
        {"role": "tool", "tool_call_id": "read-alpha", "content": content},
        {"role": "assistant", "tool_calls": [{"id": "bad-read", "function": {
            "name": "skill_read", "arguments": json.dumps({"name": ["beta"]}),
        }}]},
        {"role": "tool", "tool_call_id": "bad-read", "content": "Error: invalid name"},
    ]
    tools = SimpleNamespace(**{**vars(hosted.tools), "registry": ToolRegistry()})
    restored = HostedSkills(tools, {"exec", "office", "canvas"}, root=hosted.root, history=history)
    restored.register()
    assert restored.loaded == {"alpha"}
    assert tools.registry.is_permitted("skill_reference_read")
    assert await restored.reference("alpha", "guide.md") == "alpha reference"
    assert await restored.reference("beta", "secret.md") == "beta only"
    assert restored.loaded == {"alpha"}


def test_summary_reuses_desktop_office_skill_selection_contract(hosted):
    from mona.utils.prompt_templates import render_template

    expected = render_template("agent/skills_section.md", skills_summary=json.dumps(hosted.skills.catalog(), ensure_ascii=False))
    assert expected in hosted.skills.summary()


@pytest.mark.asyncio
async def test_pptx_can_follow_the_actual_design_reference_without_loading_a_second_skill(tmp_path, monkeypatch):
    from mona.hosted_work.tools import HostedTools

    def deny_private(*_args):
        pytest.fail("private Skill loading is forbidden")
    monkeypatch.setattr(config_paths, "get_agent_skills_dir", deny_private)
    config = HostedWorkConfig()
    tools = HostedTools(SimpleNamespace(config=config), AsyncMock(), session_id="a" * 32, config=config)
    assert (await tools.registry.execute("skill_read", {"name": "mona-pptx"})).startswith("Skill: ")
    assert tools.skills.loaded == {"mona-pptx"}
    result = await tools.registry.execute("skill_reference_read", {"skill": "mona-design", "ref_path": "native-pptx.md"})
    text = result if isinstance(result, str) else "\n".join(
        block.get("text", "") for block in result if isinstance(block, dict)
    )
    assert text and not text.startswith("Error:") and "Mona" in text
    assert tools.skills.loaded == {"mona-pptx"}


@pytest.mark.asyncio
async def test_reference_paging_and_asset_copy_use_the_sandbox(hosted, monkeypatch):
    monkeypatch.setattr("shutil.copy2", lambda *_args, **_kwargs: pytest.fail("must not copy to a host path"))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(side_effect=AssertionError("host execution")))
    await hosted.skills.read("alpha")
    await hosted.skills.read("mona-design")
    page = json.loads(await hosted.skills.reference("mona-design", "guide.md", offset=3, limit=5))
    assert page["content"] == "defgh" and page["nextOffset"] == 8
    page = json.loads(await hosted.skills.reference("mona-design", "guide.md", offset=8, limit=5))
    assert page["content"] == "ijk" and page["nextOffset"] is None
    result = json.loads(await hosted.skills.asset("alpha", "logo.bin", "images/logo.bin"))
    assert result == {"ok": True, "path": "/workspace/images/logo.bin",
                      "sha256": hashlib.sha256(b"trusted asset").hexdigest()}
    hosted.tools._file.assert_awaited_once_with(
        "upload", path="images/logo.bin", data=base64.b64encode(b"trusted asset").decode(),
    )
    hosted.tools.sandbox._invoke.assert_not_awaited()
    asyncio.create_subprocess_exec.assert_not_awaited()


@pytest.mark.asyncio
async def test_resource_paths_cannot_escape_skill_or_workspace(hosted):
    await hosted.skills.read("alpha")
    for path in ("/guide.md", r"C:\guide.md", "../beta/references/secret.md", "../../outside.md"):
        result = await hosted.skills.reference("alpha", path)
        assert result.startswith("Error:")
    for path in ("/logo.bin", r"C:\logo.bin", "../beta/assets/secret.bin", "../../outside.bin"):
        result = await hosted.skills.asset("alpha", path, "images/logo.bin")
        assert result.startswith("Error:")
    for destination in ("/etc/logo.bin", r"C:\logo.bin", "../outside.bin"):
        result = await hosted.skills.asset("alpha", "logo.bin", destination)
        assert result.startswith("Error:")
    hosted.tools._file.assert_not_awaited()


@pytest.mark.asyncio
async def test_reference_and_asset_symlinks_are_rejected(hosted, tmp_path: Path):
    outside = tmp_path / "outside.txt"
    outside.write_text("outside secret", encoding="utf-8")
    reference_link = hosted.root / "alpha" / "references" / "link.md"
    asset_link = hosted.root / "alpha" / "assets" / "link.bin"
    try:
        reference_link.symlink_to(outside)
        asset_link.symlink_to(outside)
    except OSError:
        pytest.skip("the operating system does not permit symlink creation")
    await hosted.skills.read("alpha")
    assert (await hosted.skills.reference("alpha", "link.md")).startswith("Error:")
    assert (await hosted.skills.asset("alpha", "link.bin", "safe.bin")).startswith("Error:")
    hosted.tools._file.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("version,packages", [
    ("3.11.9", {"defusedxml": "0.7.1"}),
    ("3.13.0", {}),
])
async def test_missing_declared_runtime_refuses_script_before_staging(hosted, version, packages):
    (hosted.root / "alpha" / "pyproject.toml").write_text(
        '[project]\nname="alpha"\nversion="1.0"\nrequires-python=">=3.13"\n'
        'dependencies=["defusedxml==0.7.1"]\n', encoding="utf-8",
    )
    hosted.runtime.update(python=version, packages=packages)
    await hosted.skills.read("alpha")
    result = json.loads(await hosted.skills.script("alpha", "echo.py"))
    assert result["ok"] is False and result["code"] == "runtime_unavailable"
    assert result["requires_python"] == ">=3.13"
    assert result["missing_packages"] == ([] if packages else ["defusedxml==0.7.1"])
    hosted.tools.sandbox._invoke.assert_not_awaited()
    assert hosted.tools.execute.await_count == 1  # Only the sandbox runtime probe.


@pytest.mark.asyncio
async def test_standard_library_script_is_staged_and_run_only_in_sandbox(hosted, monkeypatch):
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(side_effect=AssertionError("host execution")))
    await hosted.skills.read("alpha")
    result = json.loads(await hosted.skills.script(
        "alpha", "echo.py", args='"hello world" "semi; literal" "$(echo never)"',
    ))
    assert result == {"exit_code": 0, "output": "executed in fixture sandbox"}
    hosted.tools.sandbox._invoke.assert_awaited_once()
    stage = hosted.tools.sandbox._invoke.await_args
    arguments, bundle = stage.args[0], stage.kwargs["data"]
    digest = hashlib.sha256(bundle).hexdigest()
    assert arguments[:6] == ["exec", "-i", "mona-work-fixture", "python3", "-I", "-c"]
    assert arguments[-1] == digest
    with tarfile.open(fileobj=io.BytesIO(bundle), mode="r:gz") as archive:
        assert {member.name for member in archive} == {
            "SKILL.md", "assets/logo.bin", "references/guide.md", "scripts/echo.py",
        }
    assert hosted.tools.execute.await_count == 2
    command = hosted.tools.execute.await_args.args[0]
    assert shlex.split(command) == [
        "env", "MONA_ACTIVE_WORKSPACE=/workspace", "PYTHONUTF8=1", "python3",
        f"/tmp/mona-builtin-skills/{digest}/scripts/echo.py", "hello world", "semi; literal", "$(echo never)",
    ]
    assert str(hosted.root) not in command
    asyncio.create_subprocess_exec.assert_not_awaited()


@pytest.mark.asyncio
async def test_script_timeout_cancels_turn_and_never_retries(hosted):
    await hosted.skills.read("alpha")
    probe = json.dumps({"exit_code": 0, "output": json.dumps(hosted.runtime)})
    hosted.tools.execute.side_effect = [probe, TimeoutError("result unknown")]
    with pytest.raises(asyncio.CancelledError):
        await hosted.tools.registry.execute("skill_script_run", {"skill": "alpha", "script": "echo.py"})
    assert hosted.tools.fault and "不要自动重跑" in hosted.tools.fault
    assert hosted.tools.execute.await_count == 2
    hosted.tools.sandbox._invoke.assert_awaited_once()
