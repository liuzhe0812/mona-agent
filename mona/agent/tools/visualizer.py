"""Work-only tools for loading visualizer guidance and returning widget content."""

from __future__ import annotations

import json
import re
from contextvars import ContextVar
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.schema import ArraySchema, StringSchema, tool_parameters_schema
from mona.config.schema import Base

_MODULES = ("diagram", "mockup", "interactive", "chart", "art")
_MODULE_FILES = {
    "diagram": ("svg.md", "diagram.md"),
    "mockup": ("ui.md", "interactive.md"),
    "interactive": ("ui.md", "interactive.md"),
    "chart": ("ui.md", "chart.md", "maps.md"),
    "art": ("svg.md", "art.md"),
}
_COMMON_FILES = ("core.md", "colors.md")
_SCRIPT_HOSTS = frozenset({
    "cdnjs.cloudflare.com",
    "esm.sh",
    "cdn.jsdelivr.net",
    "unpkg.com",
})
_FORBIDDEN_TAGS = frozenset({"form", "iframe", "object", "embed", "base", "meta", "link", "html", "head", "body"})
_REFERENCE_DIR = Path(__file__).resolve().parents[2] / "skills" / "mona-visualizer" / "references"


class VisualizerToolConfig(Base):
    enable: bool = True
    max_widget_chars: int = 128_000


class _WidgetParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forbidden_tags: set[str] = set()
        self.svg_viewboxes: list[str | None] = []
        self.script_sources: list[str | None] = []
        self.has_doctype = False

    def handle_decl(self, decl: str) -> None:
        if decl.strip().lower().startswith("doctype"):
            self.has_doctype = True

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._record_tag(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._record_tag(tag, attrs)

    def _record_tag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in _FORBIDDEN_TAGS:
            self.forbidden_tags.add(tag)
        if tag == "svg":
            self.svg_viewboxes.append(next((value for name, value in attrs if name.lower() == "viewbox"), None))
        if tag == "script":
            self.script_sources.extend(
                value for name, value in attrs if name.lower() in {"src", "href"}
            )


def _json_result(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _parse_module_list(value: Any) -> list[str] | str:
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return "Error: modules must include at least one supported module."
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, RecursionError):
            if raw.startswith("["):
                return "Error: modules must be a valid JSON array or comma-separated list."
            parsed = [part.strip() for part in raw.split(",")]
        if not isinstance(parsed, list):
            if "," in raw:
                parsed = [part.strip() for part in raw.split(",")]
            else:
                return "Error: modules must be an array or comma-separated list."
        value = parsed
    if not isinstance(value, list):
        return "Error: modules must be an array or comma-separated list."
    if not value:
        return "Error: modules must include at least one supported module."
    if any(not isinstance(module, str) or not module.strip() for module in value):
        return "Error: modules must contain non-empty module names."
    modules = list(dict.fromkeys(module.strip() for module in value))
    unknown = [module for module in modules if module not in _MODULES]
    if unknown:
        return f"Error: unsupported visualizer module(s): {', '.join(unknown)}."
    return modules


def _parse_string_array(value: Any, field: str) -> list[str] | str:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (json.JSONDecodeError, RecursionError):
            return f"Error: {field} must be a JSON array of strings."
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return f"Error: {field} must be an array of strings."
    return value


def _script_url_is_allowed(value: str | None) -> bool:
    if not value or value != value.strip() or any(char.isspace() for char in value):
        return False
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() in _SCRIPT_HOSTS
        and parsed.username is None
        and parsed.password is None
        and port in (None, 443)
    )


def _validate_widget(widget_code: str) -> tuple[str | None, str | None]:
    if not widget_code.strip():
        return "Error: widget_code is required.", None
    if re.search(r"\b(?:localStorage|sessionStorage)\b", widget_code, re.IGNORECASE):
        return "Error: widget code cannot use localStorage or sessionStorage.", None
    if re.search(r"\bposition\s*:\s*fixed\b", widget_code, re.IGNORECASE):
        return "Error: widget code cannot use position: fixed.", None

    parser = _WidgetParser()
    try:
        parser.feed(widget_code)
        parser.close()
    except (AssertionError, ValueError):
        return "Error: widget markup could not be parsed.", None
    if parser.has_doctype or re.search(r"<!\s*doctype\b", widget_code, re.IGNORECASE):
        return "Error: widget_code must be a raw fragment without a doctype.", None
    if parser.forbidden_tags:
        tags = ", ".join(sorted(parser.forbidden_tags))
        return f"Error: widget_code cannot include these tags: {tags}.", None
    if any(not _script_url_is_allowed(src) for src in parser.script_sources):
        return "Error: script sources must use HTTPS on an approved host and port 443.", None

    is_svg = re.match(r"\s*<svg(?:\s|>)", widget_code, re.IGNORECASE) is not None
    if is_svg:
        if len(parser.svg_viewboxes) != 1:
            return "Error: an SVG widget must contain exactly one SVG element.", None
        viewbox = parser.svg_viewboxes[0] or ""
        match = re.fullmatch(r"\s*0\s+0\s+680\s+(\d+(?:\.\d+)?)\s*", viewbox)
        if not match or float(match.group(1)) <= 0:
            return "Error: SVG widgets must use viewBox='0 0 680 H' with a positive height.", None
        return None, "svg"
    return None, "html"


class _VisualizerTool(Tool, ContextAware):
    _scopes = {"core"}
    config_key = "visualizer"
    system_managed = True

    def __init__(self, config: VisualizerToolConfig | None = None) -> None:
        self.config = config or VisualizerToolConfig()
        self._request_context: ContextVar[RequestContext | None] = ContextVar(
            f"{type(self).__name__}_request_context",
            default=None,
        )

    @classmethod
    def config_cls(cls) -> type[Base]:
        return VisualizerToolConfig

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return bool(ctx.config.visualizer.enable)

    @classmethod
    def create(cls, ctx: Any) -> _VisualizerTool:
        return cls(config=ctx.config.visualizer)

    def set_context(self, ctx: RequestContext) -> None:
        self._request_context.set(ctx)

    def available_in_context(self) -> bool:
        ctx = self._request_context.get()
        return ctx is not None and ctx.channel == "websocket"

    @property
    def read_only(self) -> bool:
        return True


@tool_parameters(
    tool_parameters_schema(
        modules=ArraySchema(
            StringSchema("Guidance modules to load.", enum=list(_MODULES)),
            description="Select the visualizer guidance modules needed for the current drawing.",
            min_items=1,
        ),
        required=["modules"],
    )
)
class ReadMeTool(_VisualizerTool):
    @property
    def name(self) -> str:
        return "read_me"

    @property
    def description(self) -> str:
        return (
            "Load the visual design guidance needed before drawing. Choose only the relevant "
            "modules, then call show_widget. Keep explanations in the chat and use the widget "
            "only for visuals."
        )

    def cast_params(self, params: dict[str, Any]) -> dict[str, Any]:
        if isinstance(params, dict) and isinstance(params.get("modules"), str):
            raw = params["modules"].strip()
            try:
                parsed = json.loads(raw)
            except (json.JSONDecodeError, RecursionError):
                if raw.startswith("["):
                    parsed = raw
                else:
                    parsed = [part.strip() for part in raw.split(",")]
            if isinstance(parsed, list):
                params = {**params, "modules": parsed}
        return super().cast_params(params)

    async def execute(self, modules: Any = None, **kwargs: Any) -> str:
        selected = _parse_module_list(modules)
        if isinstance(selected, str):
            return selected
        filenames = list(_COMMON_FILES)
        for module in selected:
            for filename in _MODULE_FILES[module]:
                if filename not in filenames:
                    filenames.append(filename)
        try:
            sections = [(_REFERENCE_DIR / filename).read_text(encoding="utf-8").strip() for filename in filenames]
        except OSError as exc:
            return f"Error: visualizer guidance reference is unavailable ({type(exc).__name__})."
        return _json_result({
            "type": "visualizer_read_me_result",
            "content": "\n\n".join(sections),
        })


@tool_parameters(
    tool_parameters_schema(
        title=StringSchema("Short widget title.", min_length=1),
        widget_code=StringSchema("Raw SVG or HTML fragment to display.", min_length=1),
        loading_messages=ArraySchema(
            StringSchema("A localized loading message."),
            description="One to four short messages in the user's language.",
            min_items=1,
            max_items=4,
        ),
        required=["title", "widget_code", "loading_messages"],
    )
)
class ShowWidgetTool(_VisualizerTool):
    @property
    def name(self) -> str:
        return "show_widget"

    @property
    def description(self) -> str:
        return (
            "Show an SVG or interactive HTML visual directly in the chat. Use read_me first "
            "for the relevant guidance. Keep the explanation in the chat body; do not repeat "
            "the widget code or ask the user to create a file."
        )

    async def execute(
        self,
        title: Any = None,
        widget_code: Any = None,
        loading_messages: Any = None,
        **kwargs: Any,
    ) -> str:
        if not isinstance(title, str) or not title.strip():
            return "Error: title is required."
        if not isinstance(widget_code, str) or not widget_code.strip():
            return "Error: widget_code is required."
        if len(widget_code) > self.config.max_widget_chars:
            return f"Error: widget_code exceeds max_widget_chars ({self.config.max_widget_chars})."
        parsed_messages = _parse_string_array(loading_messages, "loading_messages")
        if isinstance(parsed_messages, str):
            return parsed_messages
        if not 1 <= len(parsed_messages) <= 4:
            return "Error: loading_messages must contain between one and four messages."
        error, render_mode = _validate_widget(widget_code)
        if error:
            return error
        return _json_result({
            "type": "visualizer_show_widget_result",
            "success": True,
            "title": title.strip(),
            "widget_code": widget_code,
            "loading_messages": parsed_messages,
            "render_mode": render_mode,
        })
