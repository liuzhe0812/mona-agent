"""Workspace Skills use the owned sandbox and the standard project directory."""
import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import DevelopmentConfig, HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.skills import HostedSkills, discover_project_skills


class Workspace:
    def __init__(self, files):
        self.files = files
        self.requests = []
        self.execute = AsyncMock(return_value={"exit_code": 0, "output": json.dumps({
            "python": "3.11.9", "os": "linux", "bins": {"known": True, "missing": False},
            "env": {"READY": True}, "packages": {"httpx": "0.28.0"},
        })})

    async def file(self, request):
        self.requests.append(request)
        path = request["path"]
        if request["action"] == "list":
            names = sorted({key.split("/")[2] for key in self.files if key.startswith(".agents/skills/")})
            return {"entries": [{"name": name, "kind": "directory"} for name in names], "truncated": False}
        if path not in self.files:
            raise WorkError("file_not_found", "not found", 404)
        raw = self.files[path]
        return {"path": path, "name": Path(path).name, "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}


def document(name, description="project fixture"):
    return f"---\nname: {name}\ndescription: {description}\n---\n# Project {name}\n".encode()


@pytest.mark.asyncio
async def test_only_standard_workspace_directory_is_discovered():
    sandbox = Workspace({".agents/skills/example/SKILL.md": document("example"),
                         ".agents/skill/singular/SKILL.md": document("singular")})
    result = await discover_project_skills(sandbox)
    assert set(result) == {"example"}
    assert sandbox.requests[0] == {"action": "list", "path": ".agents/skills"}
    assert all(not request["path"].startswith(".agents/skill/") for request in sandbox.requests)


@pytest.mark.asyncio
async def test_discovery_does_not_initialize_desktop_configuration(monkeypatch):
    def reject_initialization(*_args, **_kwargs):
        pytest.fail("project Skill discovery must not initialize desktop tools")

    monkeypatch.setattr(DevelopmentConfig, "__init__", reject_initialization)
    sandbox = Workspace({".agents/skills/example/SKILL.md": document("example")})
    assert set(await discover_project_skills(sandbox)) == {"example"}


@pytest.mark.asyncio
async def test_deeply_nested_invalid_metadata_does_not_block_other_skills():
    nested = (b"---\nname: bad\ndescription: invalid\nmetadata: " + b"[" * 2000
              + b"0" + b"]" * 2000 + b"\n---\nInvalid\n")
    sandbox = Workspace({".agents/skills/bad/SKILL.md": nested,
                         ".agents/skills/good/SKILL.md": document("good")})
    assert set(await discover_project_skills(sandbox)) == {"good"}


@pytest.mark.asyncio
async def test_project_skill_shadows_builtin_and_requires_fresh_read(tmp_path):
    root = tmp_path / "builtins"
    (root / "example").mkdir(parents=True)
    (root / "example" / "SKILL.md").write_text("---\nname: example\ndescription: builtin\n---\n", encoding="utf-8")
    sandbox = Workspace({".agents/skills/example/SKILL.md": document("example")})
    sandbox.project_skills = await discover_project_skills(sandbox)
    config = HostedWorkConfig()
    async def operation(_action, *, path, **_kwargs):
        if path.endswith("/SKILL.md"):
            return {"sha256": sandbox.project_skills["example"]["sha256"]}
        if path.endswith("/pyproject.toml"):
            raise WorkError("file_not_found", "not found", 404)
        return {"size": 4, "sha256": hashlib.sha256(b"data").hexdigest(),
                "data": base64.b64encode(b"data").decode()}
    file_op = AsyncMock(side_effect=operation)
    tools = SimpleNamespace(sandbox=sandbox, config=config, registry=ToolRegistry(),
                            _file=file_op, execute=AsyncMock(return_value="ok"), emit=AsyncMock())
    old = [{"role": "assistant", "tool_calls": [{"id": "old", "function": {
        "name": "skill_read", "arguments": json.dumps({"name": "example"})}}]},
           {"role": "tool", "tool_call_id": "old", "content": "Skill: old project"}]
    skills = HostedSkills(tools, set(), root=root, history=old)
    skills.register()
    assert skills.catalog()[0]["description"] == "project fixture"
    assert "example" not in skills.loaded and "old" not in skills.restored_read_ids
    assert "Project example" in await skills.read("example")
    await skills.script("example", "run.py", args="hello")
    file_op.assert_awaited_with("stat", path=".agents/skills/example/scripts/run.py")
    assert "/workspace/.agents/skills/example/scripts/run.py" in tools.execute.await_args.args[0]
    sandbox.project_skills["example"]["sha256"] = "f" * 64
    # A fresh read remains required, and a changed instruction file cannot
    # reuse authorization from a previous read.
    file_op.side_effect = AsyncMock(return_value={"sha256": "0" * 64})
    assert (await skills.script("example", "run.py")).startswith("Error:")
    assert "example" not in skills.loaded


@pytest.mark.asyncio
async def test_each_workspace_has_only_its_own_project_skills():
    first = Workspace({".agents/skills/first/SKILL.md": document("first")})
    second = Workspace({".agents/skills/second/SKILL.md": document("second")})
    assert set(await discover_project_skills(first)) == {"first"}
    assert set(await discover_project_skills(second)) == {"second"}


@pytest.mark.asyncio
async def test_declared_dependencies_are_described_as_unverified_without_rejection(tmp_path):
    metadata = ("---\nname: checked\ndescription: fixture\nmetadata:\n  mona:\n    requires:\n"
                "      bins: [known]\n      env: [READY]\n---\nInstructions\n").encode()
    missing = metadata.replace(b"name: checked", b"name: missing").replace(b"bins: [known]", b"bins: [missing]")
    sandbox = Workspace({".agents/skills/plain/SKILL.md": document("plain"),
                         ".agents/skills/checked/SKILL.md": metadata,
                         ".agents/skills/checked/pyproject.toml": b'[project]\nrequires-python = ">=3.10"\ndependencies = ["httpx>=0.27"]\n',
                         ".agents/skills/missing/SKILL.md": missing,
                         ".agents/skills/unknown/SKILL.md": document("unknown"),
                         ".agents/skills/unknown/pyproject.toml": b"[project]\ndependencies = ['httpx; sys_platform == \"linux\"']\n"})
    skills = await discover_project_skills(sandbox)
    assert skills["plain"]["available"] is True
    assert skills["checked"]["available"] is True
    assert skills["missing"]["available"] is True
    assert skills["unknown"]["available"] is True
    assert "limitations" not in skills["plain"]
    assert "未验证" in skills["checked"]["limitations"]
    assert "未验证" in skills["missing"]["limitations"]
    assert "未验证" in skills["unknown"]["limitations"]
    sandbox.execute.assert_not_awaited()
    sandbox.project_skills = skills
    root = tmp_path / "builtins"
    root.mkdir()
    async def stat(_action, *, path, **_kwargs):
        if path.endswith("/SKILL.md"):
            return {"sha256": skills["checked"]["sha256"]}
        return {}
    failure = json.dumps({"exit_code": 1, "output": "ModuleNotFoundError: dependency"})
    tools = SimpleNamespace(sandbox=sandbox, config=HostedWorkConfig(), registry=ToolRegistry(), emit=AsyncMock(),
                            _file=AsyncMock(side_effect=stat), execute=AsyncMock(return_value=failure))
    hosted = HostedSkills(tools, set(), root=root)
    hosted.register()
    catalog = {row["name"]: row for row in hosted.catalog()}
    assert catalog["checked"]["available"] and "未验证" in catalog["checked"]["limitations"]
    assert "Instructions" in await hosted.read("checked")
    assert await hosted.script("checked", "run.py") == failure


@pytest.mark.asyncio
async def test_plain_skill_does_not_require_runtime_probe():
    sandbox = Workspace({".agents/skills/plain/SKILL.md": document("plain")})
    skills = await discover_project_skills(sandbox)
    assert skills["plain"]["available"] is True
    sandbox.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_project_always_instructions_are_available_to_shared_context(tmp_path):
    from mona.hosted_work.context import _SkillCatalog

    root = tmp_path / "builtins"
    root.mkdir()
    content = b"---\nname: project\ndescription: fixture\nalways: true\n---\nProject instructions\n"
    sandbox = Workspace({".agents/skills/project/SKILL.md": content})
    sandbox.project_skills = await discover_project_skills(sandbox)
    tools = SimpleNamespace(sandbox=sandbox, config=HostedWorkConfig(), registry=ToolRegistry(), emit=AsyncMock())
    skills = HostedSkills(tools, set(), root=root)
    skills.register()
    catalog = _SkillCatalog(skills)
    assert catalog.get_always_skills() == ["project"]
    assert "Project instructions" in catalog.load_skills_for_context(["project"])
