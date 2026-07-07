"""Dedicated tools for accessing skills stored outside the workspace.

These tools replace direct file access (read_file/write_file) to skill files
stored OUTSIDE the workspace at ~/.mona/skills/ and the builtin skills dir.
The _FsTool hard boundary prevents direct file access, so agents must use
these tools.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

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

    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema([
            StringSchema(
                "name",
                description="Skill name (directory name under ~/.mona/skills/ or builtin).",
                required=True,
            ),
        ])

    async def execute(self, name: str | None = None, **kwargs: Any) -> str:
        if not name:
            return "Error: name parameter is required."
        loader = _skills_loader()
        content = loader.load_skill(name)
        if content is None:
            return f"Error: skill '{name}' not found."
        return content


class SkillCreateTool(Tool):
    """Create a new user skill (Dream agent only)."""

    _scopes = {"memory"}

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls()

    @property
    def name(self) -> str:
        return "skill_create"

    @property
    def description(self) -> str:
        return (
            "Create a new user skill under ~/.mona/skills/<name>/SKILL.md. "
            "Dream agent only. "
            "Fails if the skill already exists (use skill_read to inspect first)."
        )

    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema([
            StringSchema(
                "name",
                description="Skill name (directory name, alphanumeric + dashes).",
                required=True,
            ),
            StringSchema(
                "content",
                description="Full SKILL.md content (with optional YAML frontmatter).",
                required=True,
            ),
        ])

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
        from mona.config.paths import get_skills_dir
        skill_dir = get_skills_dir() / name
        skill_file = skill_dir / "SKILL.md"
        if skill_file.exists():
            return f"Error: skill '{name}' already exists at {skill_file}."
        try:
            skill_dir.mkdir(parents=True, exist_ok=True)
            skill_file.write_text(content, encoding="utf-8")
            return f"Successfully created skill '{name}' ({len(content)} chars) at {skill_file}."
        except Exception as e:
            return f"Error creating skill '{name}': {e}"


class SkillScriptRunTool(Tool):
    """Execute a script from a skill's scripts/ directory."""

    _scopes = {"core", "subagent", "memory"}

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

    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema([
            StringSchema(
                "skill",
                description="Skill name (directory name).",
                required=True,
            ),
            StringSchema(
                "script",
                description="Script filename (e.g. 'svg_quality_checker.py').",
                required=True,
            ),
            StringSchema(
                "args",
                description="Arguments to pass to the script (as a single string).",
                default="",
            ),
        ])

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
            import subprocess
            cmd = ["python", str(script_path)]
            if args:
                cmd.extend(args.split())
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(skill_dir),
            )
            output = result.stdout
            if result.stderr:
                output += f"\n[stderr]\n{result.stderr}"
            output += f"\n[exit code: {result.returncode}]"
            return output.strip() or f"(script completed with exit code {result.returncode})"
        except subprocess.TimeoutExpired:
            return f"Error: script '{script}' timed out after 120s."
        except Exception as e:
            return f"Error running script '{script}': {e}"


class SkillReferenceReadTool(Tool):
    """Read a reference file from a skill's references/ directory."""

    _scopes = {"core", "subagent", "memory"}

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

    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema([
            StringSchema(
                "skill",
                description="Skill name (directory name).",
                required=True,
            ),
            StringSchema(
                "ref_path",
                description="Reference file path relative to <skill_dir>/references/ (e.g. 'design_principles.md').",
                required=True,
            ),
        ])

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
            return ref_file.read_text(encoding="utf-8")
        except Exception as e:
            return f"Error reading reference '{ref_path}': {e}"


class SkillAssetCopyTool(Tool):
    """Copy an asset file from a skill's assets/ directory to a destination."""

    _scopes = {"core", "subagent", "memory"}

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

    def parameters(self) -> dict[str, Any]:
        return tool_parameters_schema([
            StringSchema(
                "skill",
                description="Skill name (directory name).",
                required=True,
            ),
            StringSchema(
                "asset",
                description="Asset file path relative to <skill_dir>/assets/ (e.g. 'fonts/noto.ttf').",
                required=True,
            ),
            StringSchema(
                "dest",
                description="Destination path (absolute or relative to workspace).",
                required=True,
            ),
        ])

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
        # Resolve destination (allow absolute or relative to workspace)
        dest_path = Path(dest).expanduser()
        if not dest_path.is_absolute():
            from mona.config.paths import get_workspace_path
            dest_path = get_workspace_path() / dest_path
        try:
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(asset_file, dest_path)
            return f"Successfully copied {asset_file} to {dest_path}."
        except Exception as e:
            return f"Error copying asset '{asset}': {e}"
