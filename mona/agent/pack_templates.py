"""Packaged workflow template loading (stock-module design §4.3, dev plan T4).

A ``template_ref`` is a ``package://<package_id>/<relative-path>`` URI that
points at a JSON workflow definition shipped inside an agent package — either
the builtin tree (``mona/agents/``) or the installed tree
(``~/.mona/agents/``). Templates are read-only: they are loaded, structurally
validated (schema shape, dependency existence, cycle detection), and handed
to the runner as-is. The room's active revision chain is never involved.

Lookup order mirrors :class:`mona.agent.partners.AgentRegistry`: the builtin
tree wins over the installed tree for the same package id.
"""

from __future__ import annotations

import json
from pathlib import Path, PurePosixPath

from mona.agent.partners import BUILTIN_AGENTS_DIR, normalize_agent_id
from mona.agent.workflow import WorkflowDefinition, execution_layers
from mona.cron.service import CronSkip

PACKAGE_REF_SCHEME = "package://"


def parse_package_ref(ref: str) -> tuple[str, str]:
    """Split ``package://<package_id>/<relative-path>`` into its two parts.

    Raises ``ValueError`` on anything that is not a strictly relative,
    forward-slash path inside a normalized package id — same discipline as
    agent manifest path validation (guide 5.1).
    """
    candidate = ref.strip()
    if not candidate.startswith(PACKAGE_REF_SCHEME):
        raise ValueError(
            f"template_ref must start with {PACKAGE_REF_SCHEME!r}: {ref!r}"
        )
    body = candidate[len(PACKAGE_REF_SCHEME):]
    package_id, sep, rel_path = body.partition("/")
    if not sep or not package_id or not rel_path:
        raise ValueError(
            f"template_ref must be {PACKAGE_REF_SCHEME}<package_id>/<path>: {ref!r}"
        )
    package_id = normalize_agent_id(package_id)  # raises on bad ids
    if "\\" in rel_path:
        raise ValueError(f"template_ref path must use forward slashes: {ref!r}")
    pure = PurePosixPath(rel_path)
    if pure.is_absolute():
        raise ValueError(f"template_ref path must be relative: {ref!r}")
    if ".." in pure.parts:
        raise ValueError(f"template_ref path must not contain '..': {ref!r}")
    return package_id, rel_path


def load_pack_template(
    ref: str,
    *,
    builtin_dir: Path | None = None,
    installed_dir: Path | None = None,
) -> WorkflowDefinition:
    """Load and structurally validate a packaged workflow template.

    Room membership validation is *not* done here — it happens at run time
    against the target conversation (``WorkflowRunner.run`` revalidates when
    a conversation is passed), so a template stays portable across rooms.

    Raises :class:`mona.cron.service.CronSkip` when the file does not exist:
    a missing packaged template is a deliberate skip in the cron run history,
    never a crash. Raises ``ValueError`` on unreadable or invalid content.
    """
    package_id, rel_path = parse_package_ref(ref)
    search_dirs = [builtin_dir or BUILTIN_AGENTS_DIR]
    if installed_dir is None:
        try:
            from mona.config.paths import get_data_dir

            installed_dir = get_data_dir() / "agents"
        except Exception:
            installed_dir = None
    if installed_dir is not None:
        search_dirs.append(installed_dir)

    target: Path | None = None
    for base in search_dirs:
        package_root = (base / package_id).resolve()
        candidate = (package_root / rel_path).resolve()
        if not candidate.is_relative_to(package_root):
            raise ValueError(f"template_ref path escapes package root: {ref!r}")
        if candidate.is_file():
            target = candidate
            break
    if target is None:
        raise CronSkip(f"pack template not found: {ref!r}")

    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read pack template {target}: {exc}") from exc
    definition = WorkflowDefinition.model_validate(raw)
    execution_layers(definition)  # raises on missing deps / cycles
    return definition
