"""Dedicated tools for accessing skills stored outside the workspace.

These tools replace direct file access (read_file/write_file) to skill files
stored OUTSIDE the workspace at ~/.mona/agents/<agent_id>/skills/ and the
builtin skills dir.
The _FsTool hard boundary prevents direct file access, so agents must use
these tools.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id
from mona.agent.tools.base import Tool
from mona.agent.tools.schema import (
    StringSchema,
    tool_parameters_schema,
)


def _skills_loader():
    """Lazy accessor for SkillsLoader (avoids circular import at module load)."""
    from mona.agent.skills import BUILTIN_SKILLS_DIR, SkillsLoader
    from mona.config.paths import get_skills_dir
    return SkillsLoader(
        workspace=get_skills_dir(),  # workspace arg is legacy; loader uses get_skills_dir() internally
        builtin_skills_dir=BUILTIN_SKILLS_DIR,
    )


class SkillReadTool(Tool):
    """Read a skill's SKILL.md content by name."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(self, *, track_usage: bool = True) -> None:
        # When Dream reads skills for dedup/maintenance, it must NOT bump
        # access counters — otherwise maintenance would reset the inactivity
        # clock and archival would never happen.
        self._track_usage = track_usage

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

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
                description="Skill name (directory name under ~/.mona/skills/ or builtin).",
            ),
            required=["name"],
        )

    async def execute(self, name: str | None = None, **kwargs: Any) -> str:
        if not name:
            return "Error: name parameter is required."
        loader = _skills_loader()
        content = loader.load_skill(name)
        if content is None:
            return f"Error: skill '{name}' not found."
        if self._track_usage:
            from mona.agent import skill_usage
            skill_usage.bump_access(name)
        return content


class SkillCreateTool(Tool):
    """Create a new user skill (Dream agent only)."""

    _scopes = {"memory"}

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
        self._agent_id = normalize_agent_id(agent_id)

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(agent_id=getattr(ctx, "agent_id", None) or MONA_AGENT_ID)

    @property
    def name(self) -> str:
        return "skill_create"

    @property
    def description(self) -> str:
        return (
            "Create a new user skill under the executing agent's private skills dir "
            "(~/.mona/agents/<agent_id>/skills/<name>/SKILL.md). "
            "Dream agent only. "
            "Fails if the skill already exists (use skill_read to inspect first) "
            "or if the active user skill count has reached the configured cap."
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
        # Sanitize skill name
        if not all(c.isalnum() or c in "-_" for c in name):
            return f"Error: invalid skill name '{name}' (only alphanumeric, dash, underscore allowed)."
        from mona.agent import skill_usage
        from mona.config.paths import get_agent_skills_dir

        skill_dir = get_agent_skills_dir(self._agent_id) / name
        skill_file = skill_dir / "SKILL.md"
        if skill_file.exists():
            return f"Error: skill '{name}' already exists at {skill_file}."

        # Capacity check: count active user skills before creating. Hold the
        # lifecycle lock through directory creation + provenance write so two
        # concurrent Dream forks cannot both pass the cap and overshoot.
        try:
            with skill_usage._lifecycle_lock():  # noqa: SLF001 — same-module lock
                active = skill_usage.list_active_user_skill_names()
                if name not in active and len(active) >= self._max_active:
                    return (
                        f"Error: active user skill count ({len(active)}) has "
                        f"reached the cap ({self._max_active}). Archive or "
                        f"merge existing skills before creating new ones "
                        f"(use `mona skill prune --apply` or `mona skill archive <name>`)."
                    )
                # Only create the directory if it does not yet exist (the
                # earlier skill_file.exists() check covered SKILL.md; the
                # directory itself might exist as an empty stub from a failed
                # prior run — only rmtree if WE created it this call).
                created_dir = False
                if not skill_dir.exists():
                    skill_dir.mkdir(parents=True, exist_ok=True)
                    created_dir = True
                try:
                    skill_file.write_text(content, encoding="utf-8")
                    # Provenance write is part of the same critical section.
                    # If it fails, roll back the directory we just created
                    # so the next attempt starts clean.
                    skill_usage.record_agent_created(name)
                except Exception as provenance_err:
                    if created_dir:
                        import shutil as _shutil
                        try:
                            _shutil.rmtree(skill_dir)
                        except OSError:
                            pass
                    return (
                        f"Error creating skill '{name}': provenance write failed "
                        f"and directory was rolled back: {provenance_err}"
                    )
            return f"Successfully created skill '{name}' ({len(content)} chars) at {skill_file}."
        except Exception as e:
            return f"Error creating skill '{name}': {e}"


class SkillScriptRunTool(Tool):
    """Execute a script from a skill's scripts/ directory."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(self, *, track_usage: bool = True) -> None:
        self._track_usage = track_usage

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

    @property
    def name(self) -> str:
        return "skill_script_run"

    @property
    def description(self) -> str:
        return (
            "Execute a Python script bundled with a skill. "
            "Scripts live in <skill_dir>/scripts/*.py. "
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
            required=["skill", "script"],
        )

    async def execute(
        self,
        skill: str | None = None,
        script: str | None = None,
        args: str = "",
        **kwargs: Any,
    ) -> str:
        if not skill or not script:
            return "Error: skill and script parameters are required."
        # Prevent path traversal in script name
        if "/" in script or "\\" in script or ".." in script:
            return f"Error: invalid script name '{script}'."
        # Find the skill directory
        from mona.agent.skills import BUILTIN_SKILLS_DIR
        from mona.config.paths import get_skills_dir
        candidates = [get_skills_dir() / skill, BUILTIN_SKILLS_DIR / skill]
        skill_dir = next((p for p in candidates if p.exists()), None)
        if skill_dir is None:
            return f"Error: skill '{skill}' not found."
        script_path = skill_dir / "scripts" / script
        if not script_path.exists():
            return f"Error: script '{script}' not found in skill '{skill}' (expected at {script_path})."
        try:
            import os
            import sys
            env = os.environ.copy()
            env["PYTHONUTF8"] = "1"
            cmd = [sys.executable, str(script_path)]
            if args:
                cmd.extend(args.split())
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(skill_dir),
                env=env,
            )
            output = result.stdout
            if result.stderr:
                output += f"\n[stderr]\n{result.stderr}"
            output += f"\n[exit code: {result.returncode}]"
            if self._track_usage:
                from mona.agent import skill_usage
                skill_usage.bump_access(skill)
            return output.strip() or f"(script completed with exit code {result.returncode})"
        except subprocess.TimeoutExpired:
            return f"Error: script '{script}' timed out after 120s."
        except Exception as e:
            return f"Error running script '{script}': {e}"


class SkillReferenceReadTool(Tool):
    """Read a reference file from a skill's references/ directory."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(self, *, track_usage: bool = True) -> None:
        self._track_usage = track_usage

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

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
    ) -> str:
        if not skill or not ref_path:
            return "Error: skill and ref_path parameters are required."
        # Prevent path traversal
        if ".." in ref_path:
            return f"Error: invalid ref_path '{ref_path}'."
        from mona.agent.skills import BUILTIN_SKILLS_DIR
        from mona.config.paths import get_skills_dir
        candidates = [get_skills_dir() / skill, BUILTIN_SKILLS_DIR / skill]
        skill_dir = next((p for p in candidates if p.exists()), None)
        if skill_dir is None:
            return f"Error: skill '{skill}' not found."
        ref_file = skill_dir / "references" / ref_path
        if not ref_file.exists():
            return f"Error: reference '{ref_path}' not found in skill '{skill}' (expected at {ref_file})."
        try:
            content = ref_file.read_text(encoding="utf-8")
            if self._track_usage:
                from mona.agent import skill_usage
                skill_usage.bump_access(skill)
            return content
        except Exception as e:
            return f"Error reading reference '{ref_path}': {e}"


class SkillAssetCopyTool(Tool):
    """Copy an asset file from a skill's assets/ directory to a destination."""

    _scopes = {"core", "subagent", "memory"}

    def __init__(self, *, track_usage: bool = True) -> None:
        self._track_usage = track_usage

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

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
        from mona.agent.skills import BUILTIN_SKILLS_DIR
        from mona.config.paths import get_skills_dir
        candidates = [get_skills_dir() / skill, BUILTIN_SKILLS_DIR / skill]
        skill_dir = next((p for p in candidates if p.exists()), None)
        if skill_dir is None:
            return f"Error: skill '{skill}' not found."
        asset_file = skill_dir / "assets" / asset
        if not asset_file.exists():
            return f"Error: asset '{asset}' not found in skill '{skill}' (expected at {asset_file})."
        # Resolve destination (allow absolute or relative to the active
        # session workspace). Using the contextvar-aware helper ensures that
        # normal sessions copy assets into ``workspace/output/`` rather than
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
                skill_usage.bump_access(skill)
            return f"Successfully copied {asset_file} to {dest_path}."
        except Exception as e:
            return f"Error copying asset '{asset}': {e}"
