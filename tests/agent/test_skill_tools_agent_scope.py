"""Skill tools resolve per executing-agent identity (multi-agent phase 4).

Every skill tool holds an agent-scoped SkillsLoader:
  agent-private skills  >  agent package skills  >  platform builtin skills
and the lifecycle sidecar (access counters, provenance, archival) is isolated
per (agent_id, skill_name) — one .usage.json per agent skills dir.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent import agent_management, skill_usage
from mona.agent.partners import MONA_AGENT_ID, AgentRegistry, normalize_agent_id
from mona.agent.tools.context import ToolContext
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.agent.tools.skill_tools import (
    SkillAssetCopyTool,
    SkillCreateTool,
    SkillReadTool,
    SkillReferenceReadTool,
    SkillScriptRunTool,
)
from mona.config import paths as config_paths
from mona.runtime.agent_env import (
    AgentEnvironmentResolution,
    AgentRuntimeError,
)

AGENT_A = "com.example.agent-a"


@pytest.fixture
def skills_roots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """Per-agent skills dirs (mona + agent-a), tmp-isolated.

    skill_usage binds ``get_agent_skills_dir`` at import time; SkillsLoader /
    SkillCreateTool resolve it lazily through ``mona.config.paths`` — patch
    both namespaces.
    """
    roots = {
        MONA_AGENT_ID: tmp_path / "mona" / "skills",
        AGENT_A: tmp_path / "agent-a" / "skills",
    }
    for p in roots.values():
        p.mkdir(parents=True)

    def _resolve(agent_id: str) -> Path:
        return roots[normalize_agent_id(agent_id)]

    monkeypatch.setattr(config_paths, "get_agent_skills_dir", _resolve)
    monkeypatch.setattr(skill_usage, "get_agent_skills_dir", _resolve)
    monkeypatch.setattr(agent_management, "get_agent_skills_dir", _resolve)
    monkeypatch.setattr(
        agent_management,
        "is_skill_script_enabled",
        lambda agent_id, name: normalize_agent_id(agent_id) == AGENT_A and name == "s2",
    )
    monkeypatch.setattr(
        agent_management,
        "get_agent_memory_dir",
        lambda agent_id: tmp_path / "memory-roots" / normalize_agent_id(agent_id) / "memory",
    )
    original_get = AgentRegistry.get
    monkeypatch.setattr(
        AgentRegistry,
        "get",
        lambda self, agent_id: (
            SimpleNamespace(id=AGENT_A)
            if normalize_agent_id(agent_id) == AGENT_A
            else original_get(self, agent_id)
        ),
    )
    return roots


@pytest.fixture
def builtin_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect the platform builtin skills dir to a tmp dir."""
    import mona.agent.skills as skills_mod

    builtin = tmp_path / "builtin"
    builtin.mkdir()
    monkeypatch.setattr(skills_mod, "BUILTIN_SKILLS_DIR", builtin)
    return builtin


def _write_skill(base: Path, name: str, body: str = "# Skill\n") -> Path:
    skill_dir = base / name
    skill_dir.mkdir(parents=True)
    path = skill_dir / "SKILL.md"
    path.write_text(body, encoding="utf-8")
    return path


def _skill_content(name: str, body: str) -> str:
    return f"---\nname: {name}\ndescription: Test-only private skill.\n---\n\n{body}"


def _ctx(agent_id: str) -> ToolContext:
    return ToolContext(config=SimpleNamespace(), workspace=".", agent_id=agent_id)


# ---------------------------------------------------------------------------
# skill_read: layered resolution per agent
# ---------------------------------------------------------------------------


class TestSkillReadAgentScope:
    async def test_agent_private_shadows_builtin(
        self, skills_roots: dict[str, Path], builtin_dir: Path
    ) -> None:
        _write_skill(builtin_dir, "s1", body="# builtin s1\n")
        _write_skill(skills_roots[AGENT_A], "s1", body="# private s1\n")

        partner = SkillReadTool(agent_id=AGENT_A)
        mona = SkillReadTool(agent_id=MONA_AGENT_ID)

        assert await partner.execute(name="s1") == "# private s1\n"
        # Mona has no private copy → falls through to the builtin layer.
        assert await mona.execute(name="s1") == "# builtin s1\n"

    async def test_partner_skill_read_cannot_access_mona_only_builtin(
        self, builtin_dir: Path
    ) -> None:
        _write_skill(builtin_dir, "mona-ppt", body="# Mona presentation skill\n")
        _write_skill(builtin_dir, "memory", body="# Shared memory skill\n")

        partner = SkillReadTool(agent_id=AGENT_A)
        mona = SkillReadTool(agent_id=MONA_AGENT_ID)

        assert "not found" in await partner.execute(name="mona-ppt")
        assert await partner.execute(name="memory") == "# Shared memory skill\n"
        assert await mona.execute(name="mona-ppt") == (
            "Error: skill 'mona-ppt' is only available in the AI Documents PPT workflow."
        )

        ppt_document_agent = SkillReadTool(
            agent_id=MONA_AGENT_ID,
            agent_kind="ppt",
        )
        assert await ppt_document_agent.execute(name="mona-ppt") == (
            "# Mona presentation skill\n"
        )

    async def test_agent_private_invisible_to_mona(
        self, skills_roots: dict[str, Path], builtin_dir: Path
    ) -> None:
        _write_skill(skills_roots[AGENT_A], "secret-skill", body="# secret\n")

        partner = SkillReadTool(agent_id=AGENT_A)
        mona = SkillReadTool(agent_id=MONA_AGENT_ID)

        assert await partner.execute(name="secret-skill") == "# secret\n"
        assert "not found" in await mona.execute(name="secret-skill")

    async def test_package_layer_between_private_and_builtin(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from mona.agent.partners import AgentRegistry

        # Manifest skills[] entries are CONCRETE skill directories
        # (completion guide 8.1) — resolve_skill_dirs returns the skill dir
        # itself, not a root to enumerate.
        pkg_skill = _write_skill(
            skills_roots[AGENT_A].parent / "pkg-skills", "pkg-skill", body="# pkg\n"
        )
        monkeypatch.setattr(
            AgentRegistry, "resolve_skill_dirs", lambda self, agent_id: [pkg_skill.parent]
        )

        partner = SkillReadTool(agent_id=AGENT_A)
        mona = SkillReadTool(agent_id=MONA_AGENT_ID)

        assert await partner.execute(name="pkg-skill") == "# pkg\n"
        # Mona's loader has no package layer.
        assert "not found" in await mona.execute(name="pkg-skill")

    async def test_create_reads_agent_id_from_ctx(self, skills_roots) -> None:
        tool = SkillReadTool.create(_ctx(AGENT_A))
        assert tool._agent_id == AGENT_A
        default_tool = SkillReadTool.create(SimpleNamespace())
        assert default_tool._agent_id == MONA_AGENT_ID

        ppt_tool = SkillReadTool.create(
            ToolContext(
                config=SimpleNamespace(),
                workspace=".",
                agent_id=MONA_AGENT_ID,
                agent_kind="ppt",
            )
        )
        assert ppt_tool._agent_kind == "ppt"


# ---------------------------------------------------------------------------
# skill_script_run / skill_reference_read / skill_asset_copy: agent dirs
# ---------------------------------------------------------------------------


class TestSkillDirToolsAgentScope:
    async def test_mona_ppt_helpers_are_blocked_outside_ai_documents(self) -> None:
        expected = "only available in the AI Documents PPT workflow"

        assert expected in await SkillScriptRunTool(
            agent_id=MONA_AGENT_ID,
        ).execute(skill="mona-ppt", script="render.py")
        assert expected in await SkillReferenceReadTool(
            agent_id=MONA_AGENT_ID,
        ).execute(skill="mona-ppt", ref_path="design.md")
        assert expected in await SkillAssetCopyTool(
            agent_id=MONA_AGENT_ID,
        ).execute(skill="mona-ppt", asset="theme.png", dest="theme.png")

    async def test_script_run_resolves_agent_private(
        self, skills_roots: dict[str, Path], builtin_dir: Path
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "s2"
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# s2\n", encoding="utf-8")
        (skill_dir / "scripts" / "echo.py").write_text(
            "print('hello-from-agent-a')\n", encoding="utf-8"
        )
        skill_usage.set_scripts_approved("s2", True, agent_id=AGENT_A)

        partner = SkillScriptRunTool(agent_id=AGENT_A)
        out = await partner.execute(skill="s2", script="echo.py")
        assert "hello-from-agent-a" in out

        mona = SkillScriptRunTool(agent_id=MONA_AGENT_ID)
        assert "not found" in await mona.execute(skill="s2", script="echo.py")

    async def test_script_run_preserves_quoted_arguments(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "quoted-args"
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# quoted-args\n", encoding="utf-8")
        (skill_dir / "scripts" / "argv.py").write_text(
            "import json, sys\nprint(json.dumps(sys.argv[1:]))\n", encoding="utf-8"
        )
        skill_usage.set_scripts_approved("quoted-args", True, agent_id=AGENT_A)
        monkeypatch.setattr(agent_management, "is_skill_script_enabled", lambda *_: True)

        out = await SkillScriptRunTool(agent_id=AGENT_A).execute(
            skill="quoted-args",
            script="argv.py",
            args='--title "a b" --out "C:\\Users\\Researcher\\A B"',
        )

        assert '["--title", "a b", "--out", "C:\\\\Users\\\\Researcher\\\\A B"]' in out

    async def test_script_run_exposes_active_workspace(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "workspace-env"
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# workspace-env\n", encoding="utf-8")
        (skill_dir / "scripts" / "workspace.py").write_text(
            "import os\nprint(os.environ.get('MONA_ACTIVE_WORKSPACE', ''))\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(agent_management, "is_skill_script_enabled", lambda *_: True)

        out = await SkillScriptRunTool(
            agent_id=AGENT_A,
            workspace=tmp_path,
        ).execute(skill="workspace-env", script="workspace.py")

        assert str(tmp_path.resolve()) in out

    async def test_mona_ppt_scripts_run_inside_the_active_workspace(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        skill_dir = skills_roots[MONA_AGENT_ID] / "mona-ppt"
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# mona-ppt\n", encoding="utf-8")
        (skill_dir / "scripts" / "workspace.py").write_text(
            "import json, os\n"
            "from pathlib import Path\n"
            "print(json.dumps([str(Path.cwd()), os.environ.get('MONA_ACTIVE_WORKSPACE', '')]))\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(agent_management, "is_skill_script_enabled", lambda *_: True)

        class FakeRuntimeManager:
            async def prepare_for_skill(
                self, suffix: str, _skill_dir: Path, _spec
            ) -> AgentEnvironmentResolution:
                assert suffix == ".py"
                return AgentEnvironmentResolution(executable=Path(sys.executable), env={})

        active_workspace = tmp_path / "active"
        active_workspace.mkdir()
        token = set_current_workspace(active_workspace)
        try:
            out = await SkillScriptRunTool(
                agent_id=MONA_AGENT_ID,
                agent_kind="ppt",
                workspace=tmp_path / "fallback",
                agent_environment=FakeRuntimeManager(),
            ).execute(skill="mona-ppt", script="workspace.py")
        finally:
            reset_current_workspace(token)

        cwd, env_workspace = json.loads(out.splitlines()[0])
        assert Path(cwd) == active_workspace.resolve()
        assert Path(env_workspace) == active_workspace.resolve()

    async def test_script_run_uses_declared_managed_runtime(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "managed-runtime"
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\n"
            "name: managed-runtime\n"
            "description: managed runtime test\n"
            "metadata:\n"
            "  mona:\n"
            "    runtime:\n"
            "      packs:\n"
            "        - python-base@3.12\n"
            "---\n# managed runtime\n",
            encoding="utf-8",
        )
        (skill_dir / "scripts" / "runtime.py").write_text(
            "import os\nprint(os.environ.get('MANAGED_RUNTIME_TEST', 'missing'))\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(agent_management, "is_skill_script_enabled", lambda *_: True)

        class FakeRuntimeManager:
            async def prepare_for_skill(
                self, suffix: str, _skill_dir: Path, spec
            ) -> AgentEnvironmentResolution:
                assert suffix == ".py"
                assert spec.packs == ["python-base@3.12"]
                return AgentEnvironmentResolution(
                    executable=Path(sys.executable),
                    env={"MANAGED_RUNTIME_TEST": "managed"},
                )

        out = await SkillScriptRunTool(
            agent_id=AGENT_A,
            agent_environment=FakeRuntimeManager(),
        ).execute(skill="managed-runtime", script="runtime.py")

        assert "managed" in out
        assert "[exit code: 0]" in out

    async def test_script_run_reports_declared_runtime_dependency(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "missing-runtime"
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\n"
            "name: missing-runtime\n"
            "description: missing runtime test\n"
            "metadata:\n"
            "  mona:\n"
            "    runtime:\n"
            "      packs:\n"
            "        - python-base@3.12\n"
            "        - scientific@1\n"
            "---\n# missing runtime\n",
            encoding="utf-8",
        )
        (skill_dir / "scripts" / "runtime.py").write_text(
            "print('must not run')\n", encoding="utf-8"
        )
        monkeypatch.setattr(agent_management, "is_skill_script_enabled", lambda *_: True)

        class MissingRuntimeManager:
            async def prepare_for_skill(
                self, _suffix: str, _skill_dir: Path, _spec
            ) -> AgentEnvironmentResolution:
                raise AgentRuntimeError("scientific@1 is unavailable")

        out = await SkillScriptRunTool(
            agent_id=AGENT_A,
            agent_environment=MissingRuntimeManager(),
        ).execute(skill="missing-runtime", script="runtime.py")

        assert json.loads(out) == {
            "status": "runtime_broken",
            "skill": "missing-runtime",
            "error": "scientific@1 is unavailable",
        }

    @pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
    async def test_script_run_supports_node_mjs(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "node-script"
        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# node-script\n", encoding="utf-8")
        (skill_dir / "scripts" / "argv.mjs").write_text(
            "console.log(JSON.stringify(process.argv.slice(2)));\n", encoding="utf-8"
        )
        monkeypatch.setattr(agent_management, "is_skill_script_enabled", lambda *_: True)

        class NodeRuntimeManager:
            async def prepare_for_skill(
                self, suffix: str, _skill_dir: Path, _spec
            ) -> AgentEnvironmentResolution:
                assert suffix == ".mjs"
                return AgentEnvironmentResolution(
                    executable=Path(shutil.which("node") or ""),
                    env=os.environ.copy(),
                )

        out = await SkillScriptRunTool(
            agent_id=AGENT_A,
            agent_environment=NodeRuntimeManager(),
        ).execute(
            skill="node-script",
            script="argv.mjs",
            args='--title "a b"',
        )

        assert '["--title","a b"]' in out

    async def test_script_run_is_cancel_responsive(
        self,
        skills_roots: dict[str, Path],
        builtin_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "cancel-script"
        scripts_dir = skill_dir / "scripts"
        scripts_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# cancel-script\n", encoding="utf-8")
        started = skill_dir / "started.txt"
        done = skill_dir / "done.txt"
        (scripts_dir / "slow.py").write_text(
            "import pathlib, time\n"
            f"pathlib.Path({str(started)!r}).write_text('started')\n"
            "time.sleep(10)\n"
            f"pathlib.Path({str(done)!r}).write_text('done')\n",
            encoding="utf-8",
        )
        skill_usage.set_scripts_approved("cancel-script", True, agent_id=AGENT_A)
        monkeypatch.setattr(agent_management, "is_skill_script_enabled", lambda *_: True)

        class PythonRuntimeManager:
            async def prepare_for_skill(
                self, suffix: str, _skill_dir: Path, _spec
            ) -> AgentEnvironmentResolution:
                assert suffix == ".py"
                return AgentEnvironmentResolution(
                    executable=Path(sys.executable),
                    env=os.environ.copy(),
                )

        task = asyncio.create_task(
            SkillScriptRunTool(
                agent_id=AGENT_A,
                agent_environment=PythonRuntimeManager(),
            ).execute(
                skill="cancel-script",
                script="slow.py",
            )
        )
        for _ in range(50):
            if started.exists():
                break
            await asyncio.sleep(0.02)
        assert started.exists(), task.result() if task.done() else "script did not start"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.2)

        assert not done.exists()

    async def test_reference_read_resolves_agent_private(
        self, skills_roots: dict[str, Path], builtin_dir: Path
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "s3"
        (skill_dir / "references").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# s3\n", encoding="utf-8")
        (skill_dir / "references" / "guide.md").write_text("agent-a reference\n", encoding="utf-8")

        partner = SkillReferenceReadTool(agent_id=AGENT_A)
        assert await partner.execute(skill="s3", ref_path="guide.md") == "agent-a reference\n"

        mona = SkillReferenceReadTool(agent_id=MONA_AGENT_ID)
        assert "not found" in await mona.execute(skill="s3", ref_path="guide.md")

    async def test_asset_copy_resolves_agent_private(
        self, skills_roots: dict[str, Path], builtin_dir: Path, tmp_path: Path
    ) -> None:
        skill_dir = skills_roots[AGENT_A] / "s4"
        (skill_dir / "assets").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# s4\n", encoding="utf-8")
        (skill_dir / "assets" / "logo.txt").write_text("asset-bytes", encoding="utf-8")
        dest = tmp_path / "out" / "logo.txt"

        partner = SkillAssetCopyTool(agent_id=AGENT_A)
        result = await partner.execute(skill="s4", asset="logo.txt", dest=str(dest))
        assert "Successfully copied" in result
        assert dest.read_text(encoding="utf-8") == "asset-bytes"

        mona = SkillAssetCopyTool(agent_id=MONA_AGENT_ID)
        assert "not found" in await mona.execute(
            skill="s4", asset="logo.txt", dest=str(tmp_path / "out2" / "logo.txt")
        )


# ---------------------------------------------------------------------------
# Lifecycle sidecar: isolated per (agent_id, skill_name)
# ---------------------------------------------------------------------------


class TestUsageLedgerAgentScope:
    async def test_bump_access_writes_only_to_executing_agent(
        self, skills_roots: dict[str, Path], builtin_dir: Path
    ) -> None:
        _write_skill(skills_roots[AGENT_A], "s5")

        partner = SkillReadTool(agent_id=AGENT_A)
        await partner.execute(name="s5")

        partner_usage = skills_roots[AGENT_A] / ".usage.json"
        mona_usage = skills_roots[MONA_AGENT_ID] / ".usage.json"
        assert partner_usage.exists()
        data = json.loads(partner_usage.read_text(encoding="utf-8"))
        assert data["s5"]["access_count"] == 1
        # Mona's ledger is untouched.
        assert not mona_usage.exists()

    async def test_skill_create_records_provenance_in_agent_ledger(
        self, skills_roots: dict[str, Path], builtin_dir: Path
    ) -> None:
        tool = SkillCreateTool(agent_id=AGENT_A)
        result = await tool.execute(
            name="new-skill", content=_skill_content("new-skill", "# fresh\n")
        )
        assert "created and is active" in result

        # File lands in the executing agent's private dir.
        assert (skills_roots[AGENT_A] / "new-skill" / "SKILL.md").exists()
        # Provenance goes to the same agent's sidecar.
        data = json.loads((skills_roots[AGENT_A] / ".usage.json").read_text(encoding="utf-8"))
        assert data["new-skill"]["created_by"] == "agent"
        assert data["new-skill"]["approved_at"] is None
        assert not (skills_roots[MONA_AGENT_ID] / ".usage.json").exists()

    def test_ledgers_are_independent_across_agents(self, skills_roots: dict[str, Path]) -> None:
        skill_usage.bump_access("shared-name", agent_id=AGENT_A)
        skill_usage.bump_access("shared-name", agent_id=AGENT_A)
        skill_usage.bump_access("shared-name", agent_id=MONA_AGENT_ID)

        a = json.loads((skills_roots[AGENT_A] / ".usage.json").read_text(encoding="utf-8"))
        m = json.loads((skills_roots[MONA_AGENT_ID] / ".usage.json").read_text(encoding="utf-8"))
        assert a["shared-name"]["access_count"] == 2
        assert m["shared-name"]["access_count"] == 1
