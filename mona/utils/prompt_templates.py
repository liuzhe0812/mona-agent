"""Load and render agent system prompt templates (Jinja2) under mona/templates/.

Agent prompts live in ``templates/agent/`` (pass names like ``agent/identity.md``).
Shared copy lives under ``agent/_snippets/`` and is included via
``{% include 'agent/_snippets/....md' %}``.
"""

import hashlib
from functools import lru_cache
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader

_TEMPLATES_ROOT = Path(__file__).resolve().parent.parent / "templates"

# Exact shipped defaults only; customized bootstrap files remain user-owned.
_LEGACY_BOOTSTRAP_HASHES = {
    "AGENTS.md": {
        "faa70cce4698756817b4b1c88bb06fdf0fe07c4fc13758d7664b5beea3196e92",  # dcfd9691
        "3e387c14b39025abf580fcff0041a5826bc10838341b28f12730c9d1ca4c57c6",  # f1aadcb9
    },
    "SOUL.md": {
        "c728da6bbbbaa33ba29ccc0e827b88d5c45241456efbcf4152c4a7d6b747fcce",  # dcfd9691
        "5c0c3fc04187a946d9ec0fe5fb0c5195fbf9f75543e91d45b496b94c6daca10d",  # 9eef6e8f
    },
}


def current_bootstrap_content(name: str, content: str) -> str:
    """Use today's bundled copy for unchanged legacy defaults, without writing user files."""
    known = _LEGACY_BOOTSTRAP_HASHES.get(name)
    if known and hashlib.sha256(content.lstrip("\ufeff").strip().encode("utf-8")).hexdigest() in known:
        return (_TEMPLATES_ROOT / name).read_text(encoding="utf-8")
    return content


@lru_cache
def _environment() -> Environment:
    # Plain-text prompts: do not HTML-escape variable values.
    return Environment(
        loader=FileSystemLoader(str(_TEMPLATES_ROOT)),
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def render_template(name: str, *, strip: bool = False, **kwargs: Any) -> str:
    """Render ``name`` (e.g. ``agent/identity.md``, ``agent/platform_policy.md``) under ``templates/``.

    Use ``strip=True`` for single-line user-facing strings when the file ends
    with a trailing newline you do not want preserved.
    """
    text = _environment().get_template(name).render(**kwargs)
    return text.rstrip() if strip else text
