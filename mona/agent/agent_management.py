"""Safe management primitives for agent instructions and private skills.

These functions deliberately operate only inside a resolved agent-private
directory. They are shared by the WebUI control API and model-visible tools so
the two paths cannot disagree about validation or activation semantics.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from stat import S_ISREG
from typing import Any

import yaml

from mona.agent.partners import MONA_AGENT_ID, AgentDefinition, AgentRegistry, normalize_agent_id
from mona.agent.skills import SkillsLoader
from mona.agent.user_config import (
    REQUIRED_AGENT_TOOLS,
    load_agent_user_config,
    save_agent_user_config,
)
from mona.config.paths import (
    get_agent_memory_dir,
    get_agent_skills_dir,
    get_agents_dir,
    get_workspace_path,
)

INSTRUCTION_FILES: dict[str, str] = {
    "soul": "SOUL.md",
    "agents": "AGENTS.md",
    "user": "USER.md",
    "memory": "MEMORY.md",
}
_MAX_INSTRUCTION_CHARS = 64_000
_MAX_SKILL_FILE_CHARS = 128_000
_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SYSTEM_MANAGED_TOOL_NAMES = frozenset(
    {
        *REQUIRED_AGENT_TOOLS,
        "canvas",
        "complete_goal",
        "delegate_agent",
        "hoard_capture",
        "hoard_search",
        "long_task",
        "my",
        "memory_edit",
        "propose_workflow",
        "run_collaboration",
        "spawn",
        "skill_create",
        "update_plan",
    }
)
_MONA_RUNTIME_TOOL_NAMES = ("my", "schedule", "todo")
_CUSTOM_AGENT_TOOLS = [
    "web_search",
    "web_fetch",
    "browser_observe",
    "browser_act",
    "read_file",
    "write_file",
    "edit_file",
    "deliver_file",
    "memory_read",
    "memory_edit",
    "memory_search",
    "skill_read",
    "skill_reference_read",
    "skill_asset_copy",
    "skill_create",
]


def _tool_category(name: str) -> str:
    if name.startswith("notes_") or name in {"url2note", "video_extract_frame"}:
        return "notes"
    if name.startswith(("materials_", "wiki_")) or name in {"knowledge_search", "kb_search"}:
        return "knowledge"
    if name.startswith("generate_") or name in {"music_score", "guitar_tab"}:
        return "media"
    if (
        name in {"academic_search", "chart", "dataframe_query", "research_record", "scientific_tool"}
        or name.startswith(("stock_", "submit_"))
    ):
        return "research"
    if name.startswith("db_"):
        return "database"
    if name in {"schedule", "todo", "heartbeat_update"}:
        return "planning"
    if name in {"document", "office", "pdf"}:
        return "office"
    if name.startswith("email_") or name == "message":
        return "communication"
    if name.startswith("terminal_") or name in {"list_exec_sessions", "write_stdin"}:
        return "terminal"
    if name in {"crypto", "config_set_provider"}:
        return "other"
    if name.startswith(("browser_", "computer_")):
        return "automation"
    if name.startswith("mcp_"):
        return "connections"
    if name.startswith("web_") or name == "http_request":
        return "web"
    if name.endswith("_file") or name in {
        "apply_patch", "deliver_file", "edit_file", "exec", "find_files", "grep", "list_dir",
    }:
        return "files"
    if name.startswith("memory_") or name.startswith("hoard_"):
        return "memory"
    if name.startswith("skill_"):
        return "skills"
    if name in {"artifact_read", "delegate_agent", "propose_workflow", "run_collaboration", "spawn"}:
        return "collaboration"
    if name in {"canvas", "complete_goal", "long_task", "my", "update_plan"}:
        return "system"
    return "other"


class AgentManagementError(ValueError):
    """Controlled validation error suitable for user-facing API responses."""


def create_custom_agent(
    display_name: str,
    *,
    description: str = "",
    instructions: str = "",
) -> AgentDefinition:
    """Create one user-owned local expert without publishing it remotely."""
    name = display_name.strip()
    summary = description.strip()
    role = instructions.strip()
    if not name:
        raise AgentManagementError("expert name is required")
    if len(name) > 80:
        raise AgentManagementError("expert name must be 80 characters or fewer")
    if len(summary) > 500:
        raise AgentManagementError("expert description must be 500 characters or fewer")
    if len(role) > 20_000:
        raise AgentManagementError("expert instructions must be 20000 characters or fewer")

    agent_id = f"local.custom.{uuid.uuid4().hex}"
    manifest = {
        "schemaVersion": 1,
        "id": agent_id,
        "displayName": name,
        "description": summary,
        "prompt": "prompt.md",
        "model": "inherit",
        "toolAllowlist": _CUSTOM_AGENT_TOOLS,
        "canDelegate": False,
        "skills": [],
        "packageId": agent_id,
        "packageVersion": "1.0.0",
        "visibility": "partner",
    }
    definition = AgentDefinition.model_validate(manifest)
    root = get_agents_dir()
    destination = root / agent_id
    staging = Path(tempfile.mkdtemp(prefix=".custom-agent-", dir=root))
    try:
        _atomic_write(
            staging / "agent.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
        prompt = [
            f"You are {name}, a user-created local expert in Mona.",
            "Follow the user's current request and the local expert instructions below.",
        ]
        if summary:
            prompt.append(f"Expertise: {summary}")
        if role:
            prompt.extend(["", role])
        _atomic_write(staging / "prompt.md", "\n".join(prompt).rstrip() + "\n")
        os.replace(staging, destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return definition


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat()


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".agent_", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def skill_execution_hash(skill_dir: Path) -> str:
    """Fingerprint the instructions, dependency declarations, and executable payload."""
    digest = hashlib.sha256()
    paths = [
        path
        for name in ("SKILL.md", "pyproject.toml", "package.json")
        if (path := skill_dir / name).is_file()
    ]
    scripts = skill_dir / "scripts"
    if scripts.is_dir():
        paths.extend(
            path
            for path in scripts.rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and path.suffix.lower() not in {".pyc", ".pyo"}
        )
    for path in sorted(paths, key=lambda item: item.relative_to(skill_dir).as_posix()):
        relative = path.relative_to(skill_dir).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def _instruction_path(agent_id: str, key: str) -> Path:
    filename = INSTRUCTION_FILES.get(key)
    if filename is None:
        raise AgentManagementError(f"unsupported instruction file {key!r}")
    return get_agent_memory_dir(normalize_agent_id(agent_id)) / filename


def _memory_store(agent_id: str):
    from mona.agent.memory import MemoryStore

    return MemoryStore(get_workspace_path(), agent_id=normalize_agent_id(agent_id))


def read_instruction(agent_id: str, key: str) -> dict[str, Any]:
    path = _instruction_path(agent_id, key)
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        content = ""
    return {
        "key": key,
        "filename": path.name,
        "content": content,
        "contentHash": _sha256(content),
        "updatedAt": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
        if path.exists()
        else None,
    }


def list_instructions(agent_id: str) -> list[dict[str, Any]]:
    return [read_instruction(agent_id, key) for key in INSTRUCTION_FILES]


def agent_data_summary(agent_id: str) -> dict[str, Any]:
    """Return bounded, metadata-only storage facts for the management page."""

    def _stats(root: Path) -> tuple[int, int, str | None]:
        files = size = 0
        latest: float | None = None
        if not root.exists():
            return files, size, None
        for base, _, names in os.walk(root, followlinks=False):
            for name in names:
                try:
                    stat = (Path(base) / name).lstat()
                except OSError:
                    continue
                if not S_ISREG(stat.st_mode):
                    continue
                files += 1
                size += stat.st_size
                latest = max(latest or stat.st_mtime, stat.st_mtime)
        updated = datetime.fromtimestamp(latest, tz=timezone.utc).isoformat() if latest else None
        return files, size, updated

    memory_dir = get_agent_memory_dir(normalize_agent_id(agent_id))
    skills_dir = get_agent_skills_dir(normalize_agent_id(agent_id))
    memory_files, memory_bytes, memory_updated = _stats(memory_dir)
    skill_files, skill_bytes, skill_updated = _stats(skills_dir)
    return {
        "memoryFiles": memory_files,
        "memoryBytes": memory_bytes,
        "memoryUpdatedAt": memory_updated,
        "skillFiles": skill_files,
        "skillBytes": skill_bytes,
        "skillUpdatedAt": skill_updated,
    }


def agent_tool_catalog(
    definition: AgentDefinition,
    *,
    workspace: Path,
    bus: Any = None,
    subagent_manager: Any = None,
    sessions: Any = None,
    runtime_registry: Any = None,
) -> list[dict[str, Any]]:
    """Return the current Agent's configurable tool ceiling and availability."""
    from mona.agent.tools.context import ToolContext
    from mona.agent.tools.loader import ToolLoader
    from mona.agent.tools.registry import ToolRegistry
    from mona.agent.user_config import configurable_agent_tools
    from mona.config.loader import load_config
    from mona.providers.image_generation import image_gen_provider_configs
    from mona.providers.video_generation import video_gen_provider_configs

    config = load_config()
    catalog_registry = ToolRegistry()
    is_mona = definition.id == MONA_AGENT_ID
    configurable = configurable_agent_tools(definition)
    ToolLoader().load(
        ToolContext(
            config=config.tools,
            workspace=str(workspace),
            bus=bus,
            subagent_manager=subagent_manager,
            cron_service=getattr(subagent_manager, "cron_service", None),
            sessions=sessions,
            image_generation_provider_configs=image_gen_provider_configs(config),
            video_generation_provider_configs=video_gen_provider_configs(config),
            timezone=config.agents.defaults.timezone,
            agent_id=definition.id,
        ),
        catalog_registry,
        scope="core" if is_mona else "subagent",
        tool_allowlist=configurable,
    )
    if is_mona:
        from mona.computer_use.runtime import COMPUTER_PERMISSION_TOOL_NAMES

        dynamic = (
            [
                name
                for name in runtime_registry.tool_names
                if getattr(runtime_registry.get(name), "model_visible", True)
            ]
            if runtime_registry is not None
            else []
        )
        static = [
            name
            for name in catalog_registry.tool_names
            if getattr(catalog_registry.get(name), "model_visible", True)
        ]
        names = list(
            dict.fromkeys(
                [
                    *static,
                    *dynamic,
                    *_MONA_RUNTIME_TOOL_NAMES,
                    *COMPUTER_PERMISSION_TOOL_NAMES,
                ]
            )
        )
    else:
        names = list(configurable or [])
    rows: list[dict[str, Any]] = []
    for name in names:
        tool = (
            runtime_registry.get(name)
            if runtime_registry is not None and runtime_registry.has(name)
            else catalog_registry.get(name)
        )
        if tool is not None and not getattr(tool, "model_visible", True):
            continue
        if (
            is_mona
            and tool is None
            and name.startswith("computer_")
            and name not in COMPUTER_PERMISSION_TOOL_NAMES
        ):
            continue
        computer_tool = name.startswith("computer_")
        rows.append(
            {
                "name": name,
                "category": _tool_category(name),
                "description": (
                    tool.description
                    if tool
                    else ("观察和操作电脑上的其他应用。" if computer_tool else "当前运行配置下不可用")
                ),
                "available": tool is not None or computer_tool,
                "readOnly": tool.read_only if tool else None,
                "requiresExplicitPermission": bool(
                    computer_tool
                    or name.startswith("mcp_")
                    or (tool and tool.requires_explicit_permission)
                ),
                "systemManaged": bool(
                    name in _SYSTEM_MANAGED_TOOL_NAMES
                    or (tool and getattr(tool, "system_managed", False))
                ),
            }
        )
    return rows


def write_instruction(agent_id: str, key: str, content: str, *, message: str) -> dict[str, Any]:
    if not isinstance(content, str):
        raise AgentManagementError("instruction content must be text")
    if len(content) > _MAX_INSTRUCTION_CHARS:
        raise AgentManagementError(
            f"instruction content exceeds {_MAX_INSTRUCTION_CHARS} characters"
        )
    path = _instruction_path(agent_id, key)
    store = _memory_store(agent_id)
    # The initial commit snapshots pre-existing files before a user edit.
    store.git.init()
    _atomic_write(path, content)
    store.git.auto_commit(message)
    return read_instruction(agent_id, key)


def instruction_history(agent_id: str, key: str) -> list[dict[str, str]]:
    _instruction_path(agent_id, key)  # validate key before accessing GitStore
    entries = _memory_store(agent_id).git.log()
    return [
        {"sha": item.sha, "message": item.message, "timestamp": item.timestamp} for item in entries
    ]


def restore_instruction(agent_id: str, key: str, commit: str) -> dict[str, Any]:
    path = _instruction_path(agent_id, key)
    store = _memory_store(agent_id)
    content = store.git.read_file_at_commit(commit, path.name)
    if content is None:
        raise AgentManagementError("instruction version was not found")
    return write_instruction(agent_id, key, content, message=f"restore {path.name} from {commit}")


def _validate_skill_name(name: str) -> str:
    if not isinstance(name, str) or not _SKILL_NAME_RE.fullmatch(name):
        raise AgentManagementError("skill name must use letters, digits, hyphen, or underscore")
    return name


def _validate_skill_frontmatter(name: str, content: str) -> dict[str, Any]:
    if not content.startswith("---"):
        raise AgentManagementError("SKILL.md must start with YAML frontmatter")
    match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n", content, flags=re.DOTALL)
    if match is None:
        raise AgentManagementError("SKILL.md frontmatter is incomplete")
    try:
        frontmatter = yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError as exc:
        raise AgentManagementError("SKILL.md frontmatter is invalid YAML") from exc
    if not isinstance(frontmatter, dict):
        raise AgentManagementError("SKILL.md frontmatter must be a mapping")
    if frontmatter.get("name") != name:
        raise AgentManagementError("SKILL.md frontmatter name must match the skill directory")
    description = frontmatter.get("description")
    if not isinstance(description, str) or not description.strip():
        raise AgentManagementError("SKILL.md frontmatter requires a description")
    _skill_runtime_from_frontmatter(frontmatter)
    return frontmatter


def _skill_runtime_from_frontmatter(frontmatter: dict[str, Any]):
    metadata = frontmatter.get("metadata")
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        raise AgentManagementError("Skill metadata must be a mapping")
    mona_meta = metadata.get("mona", metadata.get("openclaw"))
    if mona_meta is None:
        return None
    if not isinstance(mona_meta, dict):
        raise AgentManagementError("Skill metadata.mona must be a mapping")
    from mona.runtime.skill_env import parse_skill_runtime_spec

    try:
        return parse_skill_runtime_spec(mona_meta.get("runtime"))
    except ValueError as exc:
        raise AgentManagementError(str(exc)) from exc


def _validate_skill_script_runtime(
    frontmatter: dict[str, Any],
    file_paths: list[PurePosixPath],
) -> object | None:
    script_suffixes = {
        path.suffix.lower() for path in file_paths if path.parts and path.parts[0] == "scripts"
    }
    executable_suffixes = script_suffixes & {".py", ".mjs", ".r", ".js", ".ts", ".sh", ".ps1"}
    unsupported = sorted(executable_suffixes - {".py", ".mjs"})
    if unsupported:
        raise AgentManagementError(
            "Skill scripts use unsupported managed runtimes: " + ", ".join(unsupported)
        )
    if not executable_suffixes:
        return _skill_runtime_from_frontmatter(frontmatter)
    spec = _skill_runtime_from_frontmatter(frontmatter)
    return spec


class SkillManager:
    """Manage private skills while preserving existing loader and usage data."""

    def __init__(self, agent_id: str, *, registry: AgentRegistry | None = None) -> None:
        self.agent_id = normalize_agent_id(agent_id)
        self.registry = registry or AgentRegistry()
        if self.registry.get(self.agent_id) is None:
            raise AgentManagementError("agent is not installed")
        self.skills_dir = get_agent_skills_dir(self.agent_id)

    def _loader(self) -> SkillsLoader:
        return SkillsLoader(
            get_workspace_path(),
            agent_id=self.agent_id,
            package_skill_dirs=self.registry.resolve_skill_dirs(self.agent_id),
        )

    @staticmethod
    def _description(content: str) -> str:
        try:
            match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n", content, flags=re.DOTALL)
            if match is None:
                return ""
            frontmatter = yaml.safe_load(match.group(1)) or {}
        except (yaml.YAMLError, TypeError):
            return ""
        description = frontmatter.get("description") if isinstance(frontmatter, dict) else None
        return description.strip() if isinstance(description, str) else ""

    def _row(
        self,
        *,
        name: str,
        source: str,
        path: Path,
        enabled: bool,
        archived: bool,
        scripts_enabled: bool,
    ) -> dict[str, Any]:
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            content = ""
        try:
            execution_hash = skill_execution_hash(path.parent)
        except OSError:
            execution_hash = _sha256(content)
        from mona.agent import skill_usage

        usage = skill_usage.get_record(name, self.agent_id)
        provenance = skill_usage.get_provenance(name, self.agent_id)
        category = "self_learning" if source == "private" and provenance == "agent" else "external"
        has_scripts = (path.parent / "scripts").is_dir()
        runtime_payload: dict[str, object] | None = None
        runtime_ready = not has_scripts
        runtime_error: str | None = None
        if has_scripts:
            try:
                from mona.config.paths import get_managed_runtimes_dir
                from mona.runtime.agent_env import AgentEnvironmentManager
                from mona.runtime.skill_env import runtime_spec_from_skill_markdown

                runtime_spec = runtime_spec_from_skill_markdown(content)
                runtime_payload = runtime_spec.canonical() if runtime_spec else None
                AgentEnvironmentManager(get_managed_runtimes_dir()).assert_skill_ready(
                    path.parent, runtime_spec
                )
                runtime_ready = True
            except Exception as exc:
                runtime_error = str(exc)
        return {
            "name": name,
            "ownerAgentId": self.agent_id,
            "description": self._description(content),
            "content": content if source == "private" and not archived else None,
            "source": source,
            "category": category,
            "provenance": provenance,
            "editable": source == "private" and not archived,
            "accessCount": int(usage.get("access_count") or 0),
            "createdAt": usage.get("created_at"),
            "lastAccessedAt": usage.get("last_accessed_at"),
            "pinned": bool(usage.get("pinned")),
            "enabled": enabled,
            "archived": archived,
            "hasScripts": has_scripts,
            "scriptsEnabled": scripts_enabled,
            "runtime": runtime_payload,
            "runtimeReady": runtime_ready,
            "runtimeError": runtime_error,
            "contentHash": _sha256(content),
            "executionHash": execution_hash,
        }

    def list(self) -> list[dict[str, Any]]:
        config = load_agent_user_config(self.agent_id)
        disabled = set(config.disabled_skills)
        rows: list[dict[str, Any]] = []
        for entry in self._loader().list_skills(filter_unavailable=False):
            skill_path = Path(entry["path"])
            source = {"workspace": "private", "builtin": "platform"}.get(
                entry["source"], entry["source"]
            )
            rows.append(
                self._row(
                    name=entry["name"],
                    source=source,
                    path=skill_path,
                    enabled=entry["name"] not in disabled,
                    archived=False,
                    scripts_enabled=entry["name"] not in disabled,
                )
            )
        from mona.agent import skill_usage

        for name in skill_usage.list_archived_skill_names(self.agent_id):
            path = self.skills_dir / ".archive" / name / "SKILL.md"
            rows.append(
                self._row(
                    name=name,
                    source="private",
                    path=path,
                    enabled=False,
                    archived=True,
                    scripts_enabled=False,
                )
            )
        return sorted(rows, key=lambda item: (item["archived"], item["name"].lower()))

    def read(self, name: str) -> dict[str, Any]:
        name = _validate_skill_name(name)
        skill = next((item for item in self.list() if item["name"] == name), None)
        if skill is None:
            raise AgentManagementError("skill is not installed")
        if skill["source"] == "private":
            path = self.skills_dir / (".archive" if skill["archived"] else "") / name / "SKILL.md"
        else:
            entry = next(
                (
                    item
                    for item in self._loader().list_skills(filter_unavailable=False)
                    if item["name"] == name
                ),
                None,
            )
            if entry is None:
                raise AgentManagementError("skill is not installed")
            path = Path(entry["path"])
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise AgentManagementError("skill content is unavailable") from exc
        return {**skill, "content": content}

    def update_private(
        self, name: str, content: str, *, expected_hash: str | None
    ) -> dict[str, Any]:
        name = _validate_skill_name(name)
        if not isinstance(content, str):
            raise AgentManagementError("skill content must be text")
        if len(content) > _MAX_SKILL_FILE_CHARS:
            raise AgentManagementError("skill content is too large")
        path = self.skills_dir / name / "SKILL.md"
        try:
            current = path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise AgentManagementError("only active private skills can be edited") from exc
        if expected_hash and not hmac.compare_digest(_sha256(current), expected_hash):
            raise AgentManagementError("skill changed since it was opened; refresh and try again")
        frontmatter = _validate_skill_frontmatter(name, content)
        skill_root = path.parent
        existing_files = (
            [
                PurePosixPath(item.relative_to(skill_root).as_posix())
                for item in (skill_root / "scripts").rglob("*")
                if item.is_file()
            ]
            if (skill_root / "scripts").is_dir()
            else []
        )
        _validate_skill_script_runtime(frontmatter, existing_files)
        _atomic_write(path, content)
        return self.read(name)

    def install_generated(self, *, name: str, content: str, source: str) -> dict[str, Any]:
        """Validate and immediately install a model-generated private Skill."""
        name = _validate_skill_name(name)
        if not isinstance(content, str):
            raise AgentManagementError("skill content must be text")
        if len(content) > _MAX_SKILL_FILE_CHARS:
            raise AgentManagementError("skill content is too large")
        _validate_skill_frontmatter(name, content)

        final = self.skills_dir / name
        if final.exists():
            raise AgentManagementError(
                "a private skill with this name already exists; update is not implicit"
            )
        if any(
            row["name"] == name for row in self._loader().list_skills(filter_unavailable=False)
        ):
            raise AgentManagementError("skill name conflicts with a package or platform skill")

        self.skills_dir.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=f".{name}-", dir=self.skills_dir))
        try:
            _atomic_write(temporary / "SKILL.md", content)
            os.replace(temporary, final)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise

        from mona.agent import skill_usage

        skill_usage.record_install(
            name,
            agent_id=self.agent_id,
            origin="agent",
            source=source,
            content_hash=_sha256(content),
            scripts_approved=False,
        )
        return {"name": name, "path": str(final), "enabled": True}

    def active_skill_dir(self, name: str) -> Path:
        """Resolve an active skill through the same precedence used at execution time."""
        name = _validate_skill_name(name)
        skill_dir = self._loader().resolve_skill_dir(name)
        if skill_dir is None:
            raise AgentManagementError("skill is not installed or active")
        return skill_dir.resolve()

    def assert_script_setup_allowed(self, name: str) -> Path:
        active = self.active_skill_dir(name)
        if not (active / "scripts").is_dir():
            raise AgentManagementError("skill has no scripts")
        definition = self.registry.require(self.agent_id)
        from mona.agent.user_config import resolve_effective_agent_config

        allowed_tools = resolve_effective_agent_config(definition).allowed_tools
        if allowed_tools is not None and "skill_script_run" not in allowed_tools:
            raise AgentManagementError("this agent is not allowed to run skill scripts")
        return active

    def action(self, name: str, action: str) -> None:
        name = _validate_skill_name(name)
        from mona.agent import skill_usage

        if action in {"pin", "unpin"}:
            if not skill_usage.is_active(name, self.agent_id) and not skill_usage.is_archived(
                name, self.agent_id
            ):
                raise AgentManagementError("only private skills can be pinned")
            skill_usage.set_pinned(name, action == "pin", self.agent_id)
            return
        if action in {"enable", "disable"}:
            config = load_agent_user_config(self.agent_id)
            disabled = set(config.disabled_skills)
            if action == "enable":
                disabled.discard(name)
            else:
                disabled.add(name)
            save_agent_user_config(
                self.agent_id, {"disabled_skills": sorted(disabled)}, expected_revision=None
            )
            return
        if action == "archive":
            ok, detail = skill_usage.archive_skill(name, automatic=False, agent_id=self.agent_id)
            if not ok:
                raise AgentManagementError(detail)
            return
        if action == "restore":
            ok, detail = skill_usage.restore_skill(name, agent_id=self.agent_id)
            if not ok:
                raise AgentManagementError(detail)
            return
        if action in {"enable_scripts", "disable_scripts"}:
            active = self.active_skill_dir(name)
            if action == "enable_scripts":
                active = self.assert_script_setup_allowed(name)
                from mona.config.paths import get_managed_runtimes_dir
                from mona.runtime.agent_env import AgentEnvironmentManager
                from mona.runtime.skill_env import runtime_spec_from_skill_markdown

                content = (active / "SKILL.md").read_text(encoding="utf-8")
                AgentEnvironmentManager(get_managed_runtimes_dir()).assert_skill_ready(
                    active,
                    runtime_spec_from_skill_markdown(content),
                )
            elif action == "disable_scripts":
                self.action(name, "disable")
            return
        raise AgentManagementError("unsupported skill action")


def install_generated_skill_content(
    agent_id: str,
    *,
    name: str,
    content: str,
    source: str,
) -> dict[str, Any]:
    """Validate and install a model-created, single-file Skill."""
    return SkillManager(agent_id).install_generated(name=name, content=content, source=source)


def is_skill_script_enabled(agent_id: str, name: str) -> bool:
    config = load_agent_user_config(agent_id)
    if name in config.disabled_skills:
        return False
    try:
        SkillManager(agent_id).active_skill_dir(name)
    except (AgentManagementError, OSError):
        return False
    return True


__all__ = [
    "AgentManagementError",
    "INSTRUCTION_FILES",
    "SkillManager",
    "agent_data_summary",
    "agent_tool_catalog",
    "instruction_history",
    "is_skill_script_enabled",
    "list_instructions",
    "read_instruction",
    "restore_instruction",
    "install_generated_skill_content",
    "write_instruction",
]
