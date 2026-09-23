"""Dedicated tools for accessing skills stored outside the workspace.

These tools replace direct file access (read_file/write_file) to skill files
stored OUTSIDE the workspace at ~/.mona/agents/<agent_id>/skills/ and the
builtin skills dir.
The _FsTool hard boundary prevents direct file access, so agents must use
these tools.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import sys
from pathlib import Path
from typing import Any

from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id
from mona.agent.tools.base import Tool
from mona.agent.tools.schema import (
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)


def _coerce_agent_id(value: Any) -> str:
    """Best-effort agent id for direct constructor injection.

    Test doubles and partially-mocked contexts may hand us non-string values;
    fall back to Mona rather than crashing tool construction.
    """
    if isinstance(value, str) and value.strip():
        return normalize_agent_id(value)
    return MONA_AGENT_ID


def _agent_id_from_ctx(ctx: Any) -> str:
    """Executing-agent identity from the tool-construction context."""
    return _coerce_agent_id(getattr(ctx, "agent_id", None))


def _skills_loader(agent_id: str = MONA_AGENT_ID):
    """Build a SkillsLoader scoped to *agent_id* (lazy to avoid circular imports).

    Resolution order: agent-private skills > agent package skills > platform
    builtin skills (multi-agent guide 7.3). Mona's loader has no package
    layer and matches the legacy global behavior.
    """
    from mona.agent.partners import AgentRegistry
    from mona.agent.skills import BUILTIN_SKILLS_DIR, SkillsLoader
    from mona.agent.user_config import load_agent_user_config
    from mona.config.paths import get_skills_dir

    agent_id = normalize_agent_id(agent_id)
    package_dirs: list[Path] = []
    if agent_id != MONA_AGENT_ID:
        package_dirs = AgentRegistry().resolve_skill_dirs(agent_id)
    return SkillsLoader(
        workspace=get_skills_dir(),  # workspace arg is legacy; loader uses get_agent_skills_dir() internally
        builtin_skills_dir=BUILTIN_SKILLS_DIR,
        disabled_skills=set(load_agent_user_config(agent_id).disabled_skills),
        agent_id=agent_id,
        package_skill_dirs=package_dirs,
    )


class SkillReadTool(Tool):
    """Read a skill's SKILL.md content by name."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(
        self,
        *,
        track_usage: bool = True,
        agent_id: str = MONA_AGENT_ID,
    ) -> None:
        # When Dream reads skills for dedup/maintenance, it must NOT bump
        # access counters — otherwise maintenance would reset the inactivity
        # clock and archival would never happen.
        self._track_usage = track_usage
        self._agent_id = _coerce_agent_id(agent_id)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(agent_id=_agent_id_from_ctx(ctx))

    @property
    def name(self) -> str:
        return "skill_read"

    @property
    def description(self) -> str:
        return (
            "Load a skill's SKILL.md content by name. "
            "Skills are stored outside the workspace and cannot be accessed via read_file. "
            "Use this tool to read the full SKILL.md when you need to follow its instructions."
        )

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            name=StringSchema(
                description="Skill name (directory name under the executing agent's skills dir, its package, or builtin).",
            ),
            required=["name"],
        )

    async def execute(self, name: str | None = None, **kwargs: Any) -> str | list[dict[str, Any]]:
        if not name:
            return "Error: name parameter is required."
        loader = _skills_loader(self._agent_id)
        content = loader.load_skill(name)
        if content is None:
            return f"Error: skill '{name}' not found."
        from mona.agent.tools.capabilities import activate_capabilities

        activate_capabilities({"skill_resources"})
        if name in {"pdf", "mona-docx", "mona-xlsx", "mona-pptx"}:
            activate_capabilities({"office"})
        if self._track_usage:
            from mona.agent import skill_usage

            skill_usage.bump_access(name, agent_id=self._agent_id)
        from mona.agent.skill_previews import with_skill_previews

        directory = loader.resolve_skill_dir(name)
        return with_skill_previews(directory, content) if directory else content


class SkillCreateTool(Tool):
    """Create a new private Skill for the executing agent."""

    _scopes = {"memory", "subagent"}

    # Hard cap on active user skills. Applies to all active user skills
    # (agent-created + unknown); builtin skills live in a separate read-only
    # directory and are not counted. Caller can override via constructor.
    DEFAULT_MAX_ACTIVE_USER_SKILLS = 100

    def __init__(
        self,
        *,
        max_active_user_skills: int | None = None,
        agent_id: str = MONA_AGENT_ID,
    ) -> None:
        self._max_active = (
            max_active_user_skills
            if max_active_user_skills is not None
            else self.DEFAULT_MAX_ACTIVE_USER_SKILLS
        )
        # New skills land in the executing agent's private skills dir
        # (~/.mona/agents/<agent_id>/skills/) — multi-agent phase 1.
        self._agent_id = _coerce_agent_id(agent_id)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(agent_id=getattr(ctx, "agent_id", None) or MONA_AGENT_ID)

    @property
    def name(self) -> str:
        return "skill_create"

    @property
    def description(self) -> str:
        return (
            "Create a new private skill for the executing agent. The content is "
            "validated and activated under that agent only. SKILL.md must include YAML "
            "frontmatter with matching name and a description."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            name=StringSchema(
                description="Skill name (directory name, alphanumeric + dashes).",
            ),
            content=StringSchema(
                description="Full SKILL.md content (with optional YAML frontmatter).",
            ),
            required=["name", "content"],
        )

    async def execute(
        self,
        name: str | None = None,
        content: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not name:
            return "Error: name parameter is required."
        if content is None:
            return "Error: content parameter is required."
        try:
            from mona.agent import skill_usage
            from mona.agent.agent_management import install_generated_skill_content

            active = skill_usage.list_active_user_skill_names(self._agent_id)
            if len(active) >= self._max_active:
                return (
                    f"Error: active user skill count ({len(active)}) has reached "
                    f"the cap ({self._max_active}). Archive or merge existing skills first."
                )
            install_generated_skill_content(
                self._agent_id,
                name=name,
                content=content,
                source="agent:skill_create",
            )
            return f"Skill '{name}' was created and is active for this Agent."
        except Exception as e:
            return f"Error creating skill '{name}': {e}"


class SkillScriptRunTool(Tool):
    """Execute a script from a skill's scripts/ directory."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(
        self,
        *,
        track_usage: bool = True,
        agent_id: str = MONA_AGENT_ID,
        workspace: str | Path | None = None,
        agent_environment: Any | None = None,
    ) -> None:
        self._track_usage = track_usage
        self._agent_id = _coerce_agent_id(agent_id)
        self._workspace = Path(workspace).resolve() if workspace else None
        self._agent_environment = agent_environment

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(
            agent_id=_agent_id_from_ctx(ctx),
            workspace=getattr(ctx, "workspace", None),
            agent_environment=getattr(ctx, "agent_environment", None),
        )

    @property
    def name(self) -> str:
        return "skill_script_run"

    @property
    def description(self) -> str:
        return (
            "Execute a Python, Node .mjs, or R script bundled with a skill. "
            "Scripts live in <skill_dir>/scripts/. "
            "Use this instead of `exec` for skill-provided scripts — it resolves "
            "the skill directory automatically and runs in a controlled manner."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            skill=StringSchema(
                description="Skill name (directory name).",
            ),
            script=StringSchema(
                description="Script filename (e.g. 'svg_quality_checker.py').",
            ),
            args=StringSchema(
                description="Arguments to pass to the script (as a single string).",
            ),
            timeout_seconds=IntegerSchema(
                120,
                description="Maximum runtime in seconds; raise only for a documented long-running skill workflow.",
                minimum=1,
                maximum=1800,
            ),
            required=["skill", "script"],
        )

    async def execute(
        self,
        skill: str | None = None,
        script: str | None = None,
        args: str = "",
        timeout_seconds: int = 120,
        **kwargs: Any,
    ) -> str:
        if not skill or not script:
            return "Error: skill and script parameters are required."
        # Prevent path traversal in script name
        if "/" in script or "\\" in script or ".." in script:
            return f"Error: invalid script name '{script}'."
        # Find the skill directory (agent-private > package > builtin)
        loader = _skills_loader(self._agent_id)
        skill_dir = loader.resolve_skill_dir(skill)
        if skill_dir is None:
            return f"Error: skill '{skill}' not found."
        if skill in loader.disabled_skills:
            return f"Error: skill '{skill}' is disabled in Agent settings."
        script_path = skill_dir / "scripts" / script
        if not script_path.exists():
            return f"Error: script '{script}' not found in skill '{skill}' (expected at {script_path})."
        try:
            env = os.environ.copy()
            env["PYTHONUTF8"] = "1"
            from mona.agent.tools.path_utils import get_current_workspace

            active_workspace = get_current_workspace(self._workspace)
            if active_workspace is not None:
                env["MONA_ACTIVE_WORKSPACE"] = str(active_workspace)
            suffix = script_path.suffix.lower()
            from mona.config.paths import get_managed_runtimes_dir
            from mona.runtime.agent_env import (
                AgentEnvironmentManager,
                AgentRuntimeError,
            )
            from mona.runtime.manager import RuntimeManagerError

            manager = self._agent_environment or AgentEnvironmentManager(get_managed_runtimes_dir())
            try:
                runtime_spec = loader.get_runtime_spec(skill)
                resolution = await manager.prepare_for_skill(
                    suffix,
                    skill_dir,
                    runtime_spec,
                )
            except (AgentRuntimeError, RuntimeManagerError, ValueError) as exc:
                return json.dumps(
                    {
                        "status": "runtime_broken",
                        "skill": skill,
                        "error": str(exc),
                    },
                    ensure_ascii=False,
                )
            runner = str(resolution.executable)
            env.update(resolution.env)
            cmd = [runner, *resolution.prefix_args, str(script_path)]
            if args:
                cmd.extend(shlex.split(args))
            spawn_kwargs: dict[str, Any] = {}
            if sys.platform != "win32":
                spawn_kwargs["start_new_session"] = True
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(skill_dir),
                env=env,
                **spawn_kwargs,
            )
            try:
                stdout, stderr = await asyncio.wait_for(
                    process.communicate(), timeout=timeout_seconds
                )
            except asyncio.TimeoutError:
                from mona.agent.tools.shell import kill_process_tree

                await kill_process_tree(process)
                return f"Error: script '{script}' timed out after {timeout_seconds}s."
            except asyncio.CancelledError:
                from mona.agent.tools.shell import kill_process_tree

                await kill_process_tree(process)
                raise
            output = stdout.decode("utf-8", errors="replace")
            if stderr:
                output += f"\n[stderr]\n{stderr.decode('utf-8', errors='replace')}"
            output += f"\n[exit code: {process.returncode}]"
            if self._track_usage:
                from mona.agent import skill_usage

                skill_usage.bump_access(skill, agent_id=self._agent_id)
            return output.strip() or f"(script completed with exit code {process.returncode})"
        except Exception as e:
            return f"Error running script '{script}': {e}"


class SkillReferenceReadTool(Tool):
    """Read a reference file from a skill's references/ directory."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(
        self,
        *,
        track_usage: bool = True,
        agent_id: str = MONA_AGENT_ID,
    ) -> None:
        self._track_usage = track_usage
        self._agent_id = _coerce_agent_id(agent_id)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(agent_id=_agent_id_from_ctx(ctx))

    @property
    def name(self) -> str:
        return "skill_reference_read"

    @property
    def description(self) -> str:
        return (
            "Read a reference file bundled with a skill. "
            "Reference files live in <skill_dir>/references/*.md. "
            "Use this to load design guidelines, style guides, or other reference docs "
            "that ship with a skill."
        )

    @property
    def read_only(self) -> bool:
        return True

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            skill=StringSchema(
                description="Skill name (directory name).",
            ),
            ref_path=StringSchema(
                description="Reference file path relative to <skill_dir>/references/ (e.g. 'design_principles.md').",
            ),
            required=["skill", "ref_path"],
        )

    async def execute(
        self,
        skill: str | None = None,
        ref_path: str | None = None,
        **kwargs: Any,
    ) -> str | list[dict[str, Any]]:
        if not skill or not ref_path:
            return "Error: skill and ref_path parameters are required."
        # Prevent path traversal
        if ".." in ref_path:
            return f"Error: invalid ref_path '{ref_path}'."
        skill_dir = _skills_loader(self._agent_id).resolve_skill_dir(skill)
        if skill_dir is None:
            return f"Error: skill '{skill}' not found."
        ref_path = ref_path.replace("\\", "/")
        if ref_path.startswith("references/"):
            ref_path = ref_path[len("references/"):]
        root = skill_dir.resolve()
        reference_root = root / "references"
        ref_file = (reference_root / ref_path).resolve()
        if not ref_file.is_relative_to(reference_root) or not ref_file.is_relative_to(root):
            return "Error: reference path is outside the current skill."
        if not ref_file.is_file():
            return f"Error: reference '{ref_path}' not found in skill '{skill}' (expected at {ref_file})."
        try:
            content = ref_file.read_text(encoding="utf-8")
            if self._track_usage:
                from mona.agent import skill_usage

                skill_usage.bump_access(skill, agent_id=self._agent_id)
            from mona.agent.skill_previews import with_skill_previews

            return with_skill_previews(skill_dir, content, ref_path)
        except Exception as e:
            return f"Error reading reference '{ref_path}': {e}"


class SkillAssetCopyTool(Tool):
    """Copy an asset file from a skill's assets/ directory to a destination."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(
        self,
        *,
        track_usage: bool = True,
        agent_id: str = MONA_AGENT_ID,
    ) -> None:
        self._track_usage = track_usage
        self._agent_id = _coerce_agent_id(agent_id)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(agent_id=_agent_id_from_ctx(ctx))

    @property
    def name(self) -> str:
        return "skill_asset_copy"

    @property
    def description(self) -> str:
        return (
            "Copy an asset (font, icon, image) from a skill's assets/ directory to a destination path. "
            "Use this to bundle skill-provided resources into the workspace when needed."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema(
            skill=StringSchema(
                description="Skill name (directory name).",
            ),
            asset=StringSchema(
                description="Asset file path relative to <skill_dir>/assets/ (e.g. 'fonts/noto.ttf').",
            ),
            dest=StringSchema(
                description="Destination path (absolute or relative to workspace).",
            ),
            required=["skill", "asset", "dest"],
        )

    async def execute(
        self,
        skill: str | None = None,
        asset: str | None = None,
        dest: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not skill or not asset or not dest:
            return "Error: skill, asset, and dest parameters are required."
        if ".." in asset:
            return f"Error: invalid asset path '{asset}'."
        skill_dir = _skills_loader(self._agent_id).resolve_skill_dir(skill)
        if skill_dir is None:
            return f"Error: skill '{skill}' not found."
        asset_file = skill_dir / "assets" / asset
        if not asset_file.exists():
            return (
                f"Error: asset '{asset}' not found in skill '{skill}' (expected at {asset_file})."
            )
        # Resolve destination (allow absolute or relative to the active
        # session workspace). Using the contextvar-aware helper ensures that
        # normal sessions copy assets into the active Agent output rather than
        # the workspace root.
        dest_path = Path(dest).expanduser()
        if not dest_path.is_absolute():
            from mona.agent.tools.path_utils import get_current_workspace
            from mona.config.paths import get_workspace_path

            active_ws = get_current_workspace(get_workspace_path())
            dest_path = active_ws / dest_path
        try:
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(asset_file, dest_path)
            if self._track_usage:
                from mona.agent import skill_usage

                skill_usage.bump_access(skill, agent_id=self._agent_id)
            return f"Successfully copied {asset_file} to {dest_path}."
        except Exception as e:
            return f"Error copying asset '{asset}': {e}"
