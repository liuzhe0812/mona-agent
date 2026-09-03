"""Skills loader for agent capabilities."""

import json
import os
import re
import shutil
from pathlib import Path

import yaml
from loguru import logger

from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id

# Default builtin skills directory (relative to this file)
BUILTIN_SKILLS_DIR = Path(__file__).parent.parent / "skills"

# Platform skills intentionally shared with named agents.  Mona retains access
# to the complete builtin tree; partner loaders use this exact allowlist.
PARTNER_VISIBLE_BUILTIN_SKILLS = frozenset({
    "long-goal",
    "memory",
    "my",
    "summarize",
    "doc-writing-guide",
    "docx",
    "pdf",
    "html-report",
    "mona-office",
})

# Opening ---, YAML body (group 1), closing --- on its own line; supports CRLF.
_STRIP_SKILL_FRONTMATTER = re.compile(
    r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?",
    re.DOTALL,
)


class SkillsLoader:
    """
    Loader for agent skills.

    Skills are markdown files (SKILL.md) that teach the agent how to use
    specific tools or perform certain tasks.
    """

    def __init__(
        self,
        workspace: Path,
        builtin_skills_dir: Path | None = None,
        disabled_skills: set[str] | None = None,
        *,
        agent_id: str = MONA_AGENT_ID,
        package_skill_dirs: list[Path] | None = None,
    ):
        from mona.config.paths import get_agent_skills_dir
        self.workspace = workspace
        self.agent_id = normalize_agent_id(agent_id)
        # Agent-private skills live OUTSIDE the workspace
        # (~/.mona/agents/<agent_id>/skills/) for the _FsTool hard boundary
        # (multi-agent phase 1).
        self.workspace_skills = get_agent_skills_dir(self.agent_id)
        # Package skills ship inside the read-only agent package; they sit
        # between agent-private and platform-builtin skills in priority
        # (multi-agent guide section 7.3).
        self.package_skill_dirs = [Path(p) for p in (package_skill_dirs or [])]
        self.builtin_skills = builtin_skills_dir or BUILTIN_SKILLS_DIR
        self.disabled_skills = disabled_skills or set()
        # Same-name skills shadowed by a higher-priority layer get one
        # warning per loader instance (guide 7.3).
        self._shadow_warned: set[str] = set()

    def _is_builtin_visible(self, name: str) -> bool:
        """Return whether this loader may resolve a platform builtin skill."""
        return self.agent_id == MONA_AGENT_ID or name in PARTNER_VISIBLE_BUILTIN_SKILLS

    def _skill_entries_from_dir(self, base: Path, source: str) -> list[dict[str, str]]:
        if not base.exists():
            return []
        entries: list[dict[str, str]] = []
        for skill_dir in base.iterdir():
            if not skill_dir.is_dir():
                continue
            # Skill lifecycle artifacts live alongside agent-private skills
            # but must never be enumerated as skills:
            #   .archive/     — archived skills (moved here by archive_skill)
            #   .snapshots/   — reserved for future backup/rollback
            # Any other dotfile directory (lock files etc.) is also skipped.
            if skill_dir.name.startswith("."):
                continue
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                continue
            entries.append({"name": skill_dir.name, "path": str(skill_file), "source": source})
        return entries

    def _append_with_priority(
        self,
        skills: list[dict[str, str]],
        new_entries: list[dict[str, str]],
        seen: set[str],
    ) -> None:
        """Append entries not shadowed by an already-seen higher-priority layer."""
        for entry in new_entries:
            name = entry["name"]
            if name in seen:
                if name not in self._shadow_warned:
                    self._shadow_warned.add(name)
                    logger.warning(
                        "Skill {!r} at {} shadowed by a higher-priority copy for agent {!r}",
                        name, entry["path"], self.agent_id,
                    )
                continue
            seen.add(name)
            skills.append(entry)

    def list_skills(self, filter_unavailable: bool = True) -> list[dict[str, str]]:
        """
        List all available skills.

        Args:
            filter_unavailable: If True, filter out skills with unmet requirements.

        Returns:
            List of skill info dicts with 'name', 'path', 'source'.
        """
        # Priority: agent-private > agent package > platform builtin (guide 7.3).
        skills: list[dict[str, str]] = []
        seen: set[str] = set()
        self._append_with_priority(
            skills, self._skill_entries_from_dir(self.workspace_skills, "workspace"), seen
        )
        for skill_dir in self.package_skill_dirs:
            # Manifest ``skills[]`` entries are CONCRETE skill directories
            # (completion guide 8.1): each entry contributes exactly one
            # skill named after the directory itself.
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                if skill_dir.exists():
                    logger.warning(
                        "Package skill dir {} has no SKILL.md; skipped for agent {!r}",
                        skill_dir, self.agent_id,
                    )
                continue
            self._append_with_priority(
                skills,
                [{"name": skill_dir.name, "path": str(skill_file), "source": "package"}],
                seen,
            )
        if self.builtin_skills and self.builtin_skills.exists():
            self._append_with_priority(
                skills,
                [
                    entry
                    for entry in self._skill_entries_from_dir(self.builtin_skills, "builtin")
                    if self._is_builtin_visible(entry["name"])
                ],
                seen,
            )

        if self.disabled_skills:
            skills = [s for s in skills if s["name"] not in self.disabled_skills]

        if filter_unavailable:
            return [skill for skill in skills if self._check_requirements(self._get_skill_meta(skill["name"]))]
        return skills

    def load_skill(self, name: str) -> str | None:
        """
        Load a skill by name.

        Args:
            name: Skill name (directory name).

        Returns:
            Skill content or None if not found.
        """
        skill_dir = self.resolve_skill_dir(name)
        if skill_dir is None:
            return None
        path = skill_dir / "SKILL.md"
        return path.read_text(encoding="utf-8")

    def resolve_skill_dir(self, name: str) -> Path | None:
        """Resolve a skill's directory by priority.

        Order: agent-private > agent package > platform builtin (guide 7.3).
        The agent-private and builtin layers are root directories addressed
        by skill name; each package entry is itself one concrete skill
        directory (manifest ``skills[]`` — completion guide 8.1), so it
        matches when its own directory name equals *name*.
        Returns the first directory that contains ``<name>/SKILL.md``, or
        None when the skill does not exist in any layer.
        """
        private = self.workspace_skills / name
        if (private / "SKILL.md").exists():
            return private
        for package_dir in self.package_skill_dirs:
            if package_dir.name == name and (package_dir / "SKILL.md").exists():
                return package_dir
        if self.builtin_skills and self._is_builtin_visible(name):
            builtin = self.builtin_skills / name
            if (builtin / "SKILL.md").exists():
                return builtin
        return None

    def load_skills_for_context(self, skill_names: list[str]) -> str:
        """
        Load specific skills for inclusion in agent context.

        Args:
            skill_names: List of skill names to load.

        Returns:
            Formatted skills content.
        """
        # Bump access telemetry for skills actually injected into a session
        # context. This is the only summary-style call that counts as a real
        # access: list_skills / get_skill_metadata / build_skills_summary only
        # read frontmatter and must NOT bump, otherwise every system prompt
        # refresh would reset the inactivity clock.
        from mona.agent import skill_usage
        parts: list[str] = []
        for name in skill_names:
            markdown = self.load_skill(name)
            if markdown is None:
                continue
            skill_usage.bump_access(name, agent_id=self.agent_id)
            parts.append(f"### Skill: {name}\n\n{self._strip_frontmatter(markdown)}")
        return "\n\n---\n\n".join(parts)

    def build_skills_summary(self, exclude: set[str] | None = None) -> str:
        """
        Build a summary of all skills (name, description, path, availability).

        This is used for progressive loading - the agent can read the full
        skill content using read_file when needed.

        Args:
            exclude: Set of skill names to omit from the summary.

        Returns:
            Markdown-formatted skills summary.
        """
        all_skills = self.list_skills(filter_unavailable=False)
        if not all_skills:
            return ""

        lines: list[str] = []
        for entry in all_skills:
            skill_name = entry["name"]
            if exclude and skill_name in exclude:
                continue
            meta = self._get_skill_meta(skill_name)
            available = self._check_requirements(meta)
            desc = self._get_skill_description(skill_name)
            # Do not emit entry['path'] — skills live outside workspace and
            # must be accessed via the skill_read tool, not read_file.
            if available:
                lines.append(f"- **{skill_name}** — {desc}")
            else:
                missing = self._get_missing_requirements(meta)
                suffix = f" (unavailable: {missing})" if missing else " (unavailable)"
                lines.append(f"- **{skill_name}** — {desc}{suffix}")
        return "\n".join(lines)

    def _get_missing_requirements(self, skill_meta: dict) -> str:
        """Get a description of missing requirements."""
        requires = skill_meta.get("requires", {})
        required_bins = requires.get("bins", [])
        required_env_vars = requires.get("env", [])
        return ", ".join(
            [f"CLI: {command_name}" for command_name in required_bins if not shutil.which(command_name)]
            + [f"ENV: {env_name}" for env_name in required_env_vars if not os.environ.get(env_name)]
        )

    def _get_skill_description(self, name: str) -> str:
        """Get the description of a skill from its frontmatter."""
        meta = self.get_skill_metadata(name)
        if meta and meta.get("description"):
            return meta["description"]
        return name  # Fallback to skill name

    def _strip_frontmatter(self, content: str) -> str:
        """Remove YAML frontmatter from markdown content."""
        if not content.startswith("---"):
            return content
        match = _STRIP_SKILL_FRONTMATTER.match(content)
        if match:
            return content[match.end():].strip()
        return content

    def _parse_mona_metadata(self, raw: object) -> dict:
        """Extract mona/openclaw metadata from a frontmatter field.

        ``raw`` may be a dict (already parsed by yaml.safe_load) or a JSON str.
        """
        if isinstance(raw, dict):
            data = raw
        elif isinstance(raw, str):
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                return {}
        else:
            return {}
        if not isinstance(data, dict):
            return {}
        payload = data.get("mona", data.get("openclaw", {}))
        return payload if isinstance(payload, dict) else {}

    def _check_requirements(self, skill_meta: dict) -> bool:
        """Check if skill requirements are met (bins, env vars)."""
        requires = skill_meta.get("requires", {})
        required_bins = requires.get("bins", [])
        required_env_vars = requires.get("env", [])
        return all(shutil.which(cmd) for cmd in required_bins) and all(
            os.environ.get(var) for var in required_env_vars
        )

    def _get_skill_meta(self, name: str) -> dict:
        """Get mona metadata for a skill (cached in frontmatter)."""
        raw_meta = self.get_skill_metadata(name) or {}
        return self._parse_mona_metadata(raw_meta.get("metadata"))

    def get_runtime_packs(self, name: str) -> list[str]:
        """Return validated managed runtime pack refs declared by a Skill."""
        spec = self.get_runtime_spec(name)
        return list(spec.packs) if spec is not None else []

    def get_runtime_spec(self, name: str):
        """Return the validated managed runtime declaration for one Skill."""
        meta = self._get_skill_meta(name)
        from mona.runtime.skill_env import parse_skill_runtime_spec

        return parse_skill_runtime_spec(meta.get("runtime"))

    def get_always_skills(self) -> list[str]:
        """Get skills marked as always=true that meet requirements."""
        return [
            entry["name"]
            for entry in self.list_skills(filter_unavailable=True)
            if (meta := self.get_skill_metadata(entry["name"]) or {})
            and (
                self._parse_mona_metadata(meta.get("metadata")).get("always")
                or meta.get("always")
            )
        ]

    def get_skill_metadata(self, name: str) -> dict | None:
        """
        Get metadata from a skill's frontmatter.

        Args:
            name: Skill name.

        Returns:
            Metadata dict or None.
        """
        content = self.load_skill(name)
        if not content or not content.startswith("---"):
            return None
        match = _STRIP_SKILL_FRONTMATTER.match(content)
        if not match:
            return None
        try:
            parsed = yaml.safe_load(match.group(1))
        except yaml.YAMLError:
            return None
        if not isinstance(parsed, dict):
            return None
        # yaml.safe_load returns native types (int, bool, list, etc.);
        # keep values as-is so downstream consumers get correct types.
        metadata: dict[str, object] = {}
        for key, value in parsed.items():
            metadata[str(key)] = value
        return metadata
