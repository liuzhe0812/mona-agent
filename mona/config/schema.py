"""Configuration schema using Pydantic."""
from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel
from pydantic_settings import BaseSettings

from mona.cron.types import CronSchedule

MONA_BOT_NAME = "Mona"
MONA_BOT_ICON = ""

if TYPE_CHECKING:
    from mona.agent.tools.canvas import CanvasToolConfig
    from mona.agent.tools.chart import ChartToolConfig
    from mona.agent.tools.crypto import CryptoToolConfig
    from mona.agent.tools.dataframe import DataframeToolConfig
    from mona.agent.tools.document import DocumentToolConfig
    from mona.agent.tools.http import HttpToolConfig
    from mona.agent.tools.image_generation import ImageGenerationToolConfig
    from mona.agent.tools.office import OfficeToolConfig
    from mona.agent.tools.self import MyToolConfig
    from mona.agent.tools.shell import ExecToolConfig
    from mona.agent.tools.video_generation import VideoGenerationToolConfig
    from mona.agent.tools.web import WebToolsConfig
    from mona.email_intel.config import EmailIntelConfig


class Base(BaseModel):
    """Base model that accepts both camelCase and snake_case keys."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ChannelsConfig(Base):
    """Configuration for chat channels.

    Built-in and plugin channel configs are stored as extra fields (dicts).
    Each channel parses its own config in __init__.
    Per-channel "streaming": true enables streaming output (requires send_delta impl).
    """

    model_config = ConfigDict(extra="allow")

    send_progress: bool = True  # stream agent's text progress to the channel
    send_tool_hints: bool = False  # stream tool-call hints (e.g. read_file("…"))
    show_reasoning: bool = True  # surface model reasoning when channel implements it
    send_max_retries: int = Field(default=3, ge=0, le=10)  # Max delivery attempts (initial send included)
    transcription_provider: str = "groq"  # Voice transcription backend: "groq" or "openai"
    transcription_language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}$")  # Optional ISO-639-1 hint for audio transcription

    # TTS (text-to-speech) — used by /v1/audio/speech and channel synthesize_speech
    tts_provider: str = "edge"  # "edge", "minimax", or "cosyvoice"
    tts_voice: str = "zh-CN-XiaoyiNeural"  # Voice ID (fixed per PRD: same voice every synthesis)
    tts_api_key: str = ""  # API key for minimax/cosyvoice (edge is free)
    tts_api_base: str = ""  # Optional custom API base URL
    tts_model: str = ""  # Optional model override (provider-specific)


class DreamConfig(Base):
    """Dream memory consolidation configuration."""

    _HOUR_MS = 3_600_000

    interval_h: int = Field(default=2, ge=1)  # Every 2 hours by default
    cron: str | None = Field(default=None, exclude=True)  # Legacy compatibility override
    model_override: str | None = Field(
        default=None,
        validation_alias=AliasChoices("modelOverride", "model", "model_override"),
    )  # Optional Dream-specific model override
    max_batch_size: int = Field(default=20, ge=1)  # Max history entries per run
    # Bumped from 10 to 15 in #3212 (exp002: +30% dedup, no accuracy loss; >15 plateaus).
    max_iterations: int = Field(default=15, ge=1)  # Max tool calls per Phase 2
    # Per-line git-blame age annotation in Phase 1 prompt (see #3212). Default
    # on — set to False to feed MEMORY.md raw if a specific LLM reacts poorly
    # to the `← Nd` suffix or you want deterministic, git-independent prompts.
    annotate_line_ages: bool = True

    # Skill lifecycle (see docs/design/skill-lifecycle-design.md).
    # Automatic archival is OFF by default — users opt in after a dry-run.
    # Stats, capacity cap, manual archive/restore and `mona skill prune`
    # (dry-run) work regardless of this flag.
    skill_prune_enabled: bool = False
    archive_after_days: int = Field(default=90, ge=1)
    # Hard cap on active user skills (agent-created + unknown). Builtin
    # skills live in a separate read-only directory and are not counted.
    max_active_user_skills: int = Field(default=100, ge=1)

    def build_schedule(self, timezone: str) -> CronSchedule:
        """Build the runtime schedule, preferring the legacy cron override if present."""
        if self.cron:
            return CronSchedule(kind="cron", expr=self.cron, tz=timezone)
        return CronSchedule(kind="every", every_ms=self.interval_h * self._HOUR_MS)

    def describe_schedule(self) -> str:
        """Return a human-readable summary for logs and startup output."""
        if self.cron:
            return f"cron {self.cron} (legacy)"
        hours = self.interval_h
        return f"every {hours}h"


class InlineFallbackConfig(Base):
    """One inline fallback model configuration."""

    model: str
    provider: str
    max_tokens: int | None = None
    context_window_tokens: int | None = None
    temperature: float | None = None
    reasoning_effort: str | None = None


FallbackCandidate = str | InlineFallbackConfig


class ModelPresetConfig(Base):
    """A named set of model + generation parameters for quick switching."""

    model: str
    provider: str = "auto"
    max_tokens: int = 8192
    context_window_tokens: int = 65_536
    temperature: float = 0.1
    reasoning_effort: str | None = None

    def to_generation_settings(self) -> Any:
        from mona.providers.base import GenerationSettings
        return GenerationSettings(
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            reasoning_effort=self.reasoning_effort,
        )


class AgentDefaults(Base):
    """Default agent configuration."""

    workspace: str = "~/.mona/workspace"
    model_preset: str | None = None  # Active preset name — takes precedence over fields below
    model: str = "deepseek-v4-flash"
    provider: str = "auto"  # Provider name (e.g. "anthropic", "openrouter") or "auto" for auto-detection
    max_tokens: int = 8192
    context_window_tokens: int = 65_536
    context_block_limit: int | None = None
    temperature: float = 0.1
    fallback_models: list[FallbackCandidate] = Field(default_factory=list)
    max_tool_iterations: int = 100
    max_concurrent_subagents: int = Field(default=1, ge=1)
    max_tool_result_chars: int = 16_000
    provider_retry_mode: Literal["standard", "persistent"] = "standard"
    tool_hint_max_length: int = Field(
        default=40,
        ge=20,
        le=500,
        validation_alias=AliasChoices("toolHintMaxLength"),
        serialization_alias="toolHintMaxLength",
    )  # Max characters for tool hint display (e.g. "$ cd …/project && npm test")
    reasoning_effort: str | None = None  # low / medium / high / adaptive / none — LLM thinking effort; None preserves the provider default
    timezone: str = "UTC"  # IANA timezone, e.g. "Asia/Shanghai", "America/New_York"
    unified_session: bool = False  # Share one session across all channels (single-user multi-device)
    disabled_skills: list[str] = Field(default_factory=list)  # Skill names to exclude from loading (e.g. ["summarize", "skill-creator"])
    session_ttl_minutes: int = Field(
        default=0,
        ge=0,
        validation_alias=AliasChoices("idleCompactAfterMinutes", "sessionTtlMinutes"),
        serialization_alias="idleCompactAfterMinutes",
    )  # Auto-compact idle threshold in minutes (0 = disabled)
    max_messages: int = Field(
        default=120,
        ge=0,
    )  # Max messages to replay from session history (0 = use default 120, respects token budget)
    consolidation_ratio: float = Field(
        default=0.5,
        ge=0.1,
        le=0.95,
        validation_alias=AliasChoices("consolidationRatio"),
        serialization_alias="consolidationRatio",
    )  # Consolidation target ratio (0.5 = 50% of budget retained after compression)
    dream: DreamConfig = Field(default_factory=DreamConfig)

    @property
    def bot_name(self) -> str:
        return MONA_BOT_NAME

    @property
    def bot_icon(self) -> str:
        return MONA_BOT_ICON

class AgentsConfig(Base):
    """Agent configuration."""

    defaults: AgentDefaults = Field(default_factory=AgentDefaults)


class ModelGenerationParameters(Base):
    """Explicitly enabled optional request fields for one media model."""

    enabled: list[str] = Field(default_factory=list)
    values: dict[str, str | int | float] = Field(default_factory=dict)


class ProviderConfig(Base):
    """LLM provider configuration."""

    # Display name for user-created Cindy-compatible chat providers.
    display_name: str | None = None
    api_key: str | None = None
    api_base: str | None = None
    model: str | None = None  # Last-used model for this provider
    # Chat settings only: an empty value follows the provider catalog defaults;
    # a populated list is the user's explicit visible-model selection.
    enabled_models: list[str] | None = None
    discovered_models: list[dict[str, Any]] | None = None
    extra_headers: dict[str, str] | None = None  # Custom headers (e.g. APP-Code for AiHubMix)
    extra_body: dict[str, Any] | None = None  # Extra fields merged into every request body


class BedrockProviderConfig(ProviderConfig):
    """AWS Bedrock Runtime provider configuration."""

    region: str | None = None  # AWS region, falls back to AWS_REGION/AWS_DEFAULT_REGION/profile
    profile: str | None = None  # Optional AWS shared config profile


class ProvidersConfig(Base):
    """Configuration for LLM providers."""

    custom: ProviderConfig = Field(default_factory=ProviderConfig)  # Any OpenAI-compatible endpoint
    mona_managed: ProviderConfig = Field(default_factory=ProviderConfig)
    azure_openai: ProviderConfig = Field(default_factory=ProviderConfig)  # Azure OpenAI (model = deployment name)
    bedrock: BedrockProviderConfig = Field(default_factory=BedrockProviderConfig)  # AWS Bedrock Converse
    anthropic: ProviderConfig = Field(default_factory=ProviderConfig)
    openai: ProviderConfig = Field(default_factory=ProviderConfig)
    openrouter: ProviderConfig = Field(default_factory=ProviderConfig)
    huggingface: ProviderConfig = Field(default_factory=ProviderConfig)
    skywork: ProviderConfig = Field(default_factory=ProviderConfig)  # Skywork / APIFree API gateway
    deepseek: ProviderConfig = Field(default_factory=ProviderConfig)
    groq: ProviderConfig = Field(default_factory=ProviderConfig)
    zhipu: ProviderConfig = Field(default_factory=ProviderConfig)
    dashscope: ProviderConfig = Field(default_factory=ProviderConfig)
    dashscope_coding_plan: ProviderConfig = Field(default_factory=ProviderConfig)  # DashScope Coding Plan (百炼 Coding Plan)
    vllm: ProviderConfig = Field(default_factory=ProviderConfig)
    ollama: ProviderConfig = Field(default_factory=ProviderConfig)  # Ollama local models
    lm_studio: ProviderConfig = Field(default_factory=ProviderConfig)  # LM Studio local models
    atomic_chat: ProviderConfig = Field(default_factory=ProviderConfig)  # Atomic Chat local models
    ovms: ProviderConfig = Field(default_factory=ProviderConfig)  # OpenVINO Model Server (OVMS)
    gemini: ProviderConfig = Field(default_factory=ProviderConfig)
    moonshot: ProviderConfig = Field(default_factory=ProviderConfig)
    minimax: ProviderConfig = Field(default_factory=ProviderConfig)
    minimax_anthropic: ProviderConfig = Field(default_factory=ProviderConfig)  # MiniMax Anthropic endpoint (thinking)
    mistral: ProviderConfig = Field(default_factory=ProviderConfig)
    stepfun: ProviderConfig = Field(default_factory=ProviderConfig)  # Step Fun (阶跃星辰)
    xiaomi_mimo: ProviderConfig = Field(default_factory=ProviderConfig)  # Xiaomi MIMO (小米)
    longcat: ProviderConfig = Field(default_factory=ProviderConfig)  # LongCat
    ant_ling: ProviderConfig = Field(default_factory=ProviderConfig)  # Ant Ling
    aihubmix: ProviderConfig = Field(default_factory=ProviderConfig)  # AiHubMix API gateway
    siliconflow: ProviderConfig = Field(default_factory=ProviderConfig)  # SiliconFlow (硅基流动)
    agnes: ProviderConfig = Field(default_factory=ProviderConfig)  # Agnes AI
    novita: ProviderConfig = Field(default_factory=ProviderConfig)  # Novita AI
    volcengine: ProviderConfig = Field(default_factory=ProviderConfig)  # VolcEngine (火山引擎)
    volcengine_coding_plan: ProviderConfig = Field(default_factory=ProviderConfig)  # VolcEngine Coding Plan
    byteplus: ProviderConfig = Field(default_factory=ProviderConfig)  # BytePlus (VolcEngine international)
    byteplus_coding_plan: ProviderConfig = Field(default_factory=ProviderConfig)  # BytePlus Coding Plan
    openai_codex: ProviderConfig = Field(default_factory=ProviderConfig, exclude=True)  # OpenAI Codex (OAuth)
    github_copilot: ProviderConfig = Field(default_factory=ProviderConfig, exclude=True)  # Github Copilot (OAuth)
    qianfan: ProviderConfig = Field(default_factory=ProviderConfig)  # Qianfan (百度千帆)
    nvidia: ProviderConfig = Field(default_factory=ProviderConfig)  # NVIDIA NIM (nvapi- keys)
    # Cindy presets use hyphenated IDs, so they live in a keyed map instead of
    # becoming one Python field per preset.
    cindy: dict[str, ProviderConfig] = Field(default_factory=dict)

    def get_provider_config(self, name: str) -> ProviderConfig | None:
        """Return a built-in or Cindy chat provider config by public ID."""
        dynamic = self.cindy.get(name)
        if isinstance(dynamic, ProviderConfig):
            return dynamic
        value = getattr(self, name, None)
        if isinstance(value, ProviderConfig):
            return value
        return None


class StockConfig(Base):
    """Stock module configuration (design §13).

    The watchlist is user data stored under ``~/.mona/stock/`` and never
    enters ``config.json``.
    """

    # On by default (design §13): the module must be reachable out of the
    # box — a shipped feature hidden behind a switch reads as "not built".
    # Users who never want it flip the toggle once in Settings → Stock.
    enabled: bool = True
    # Automatic daily review is opt-in; enabling the stock module only makes
    # the workspace and manual research features available.
    auto_review_enabled: bool = False
    review_time: str = Field(
        default="15:30", pattern=r"^([01]\d|2[0-3]):[0-5]\d$"
    )  # Asia/Shanghai, daily review trigger time
    # Daily-review coverage (design §11): all watchlist instruments or only
    # focus-marked ones — never silently widens the analysis scope.
    review_scope: Literal["all", "focus"] = "focus"
    push_notification: bool = True  # desktop notification for review digest
    push_email: bool = False  # optional email delivery for review digest
    quote_refresh_sec: int = Field(default=30, ge=5, le=3600)


class HeartbeatConfig(Base):
    """Heartbeat service configuration."""

    enabled: bool = True
    interval_s: int = 30 * 60  # 30 minutes
    keep_recent_messages: int = 8


class ApiConfig(Base):
    """OpenAI-compatible API server configuration."""

    host: str = "127.0.0.1"  # Safer default: local-only bind.
    port: int = 8900
    timeout: float = 120.0  # Per-request timeout in seconds.


class GatewayConfig(Base):
    """Gateway/server configuration."""

    host: str = "127.0.0.1"  # Safer default: local-only bind.
    port: int = 18790
    heartbeat: HeartbeatConfig = Field(default_factory=HeartbeatConfig)


class ServicesConfig(Base):
    """Services process configuration (business services split from gateway)."""

    host: str = "127.0.0.1"  # Safer default: local-only bind.
    port: int = 17174


class RuntimeConfig(Base):
    """Preferences for downloading managed runtime components."""

    auto_download: bool = True


class VideoModuleConfig(Base):
    """Video production engine rollout and fallback controls."""

    render_engine: Literal["legacy", "hyperframes", "auto"] = "auto"
    allow_render_fallback: bool = True
    hyperframes_version: str = "0.8.16"


class ProfileConfig(Base):
    """User-profile dashboard collection and generation limits."""

    window_days: Literal[30] = 30
    timezone: str = "Asia/Shanghai"
    max_evidence_sessions: int = Field(default=50, ge=1, le=100)
    max_evidence_messages: int = Field(default=200, ge=1, le=400)
    max_message_chars: int = Field(default=1200, ge=200, le=4000)
    max_input_tokens: int = Field(default=12000, ge=2000, le=32000)
    profile_max_output_tokens: int = Field(default=4096, ge=256, le=32000)
    advice_max_output_tokens: int = Field(default=8192, ge=512, le=32000)
    llm_timeout_seconds: int = Field(default=120, ge=30, le=120)
    pipeline_timeout_seconds: int = Field(default=420, ge=60, le=600)
    max_advice_history: int = Field(default=100, ge=3, le=200)

    @model_validator(mode="after")
    def validate_timezone(self) -> "ProfileConfig":
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"invalid profile timezone: {self.timezone}") from exc
        return self


class MCPServerConfig(Base):
    """MCP server connection configuration (stdio or HTTP)."""

    type: Literal["stdio", "sse", "streamableHttp"] | None = None  # auto-detected if omitted
    command: str = ""  # Stdio: command to run (e.g. "npx")
    args: list[str] = Field(default_factory=list)  # Stdio: command arguments
    env: dict[str, str] = Field(default_factory=dict)  # Stdio: extra env vars
    url: str = ""  # HTTP/SSE: endpoint URL
    headers: dict[str, str] = Field(default_factory=dict)  # HTTP/SSE: custom headers
    tool_timeout: int = 30  # seconds before a tool call is cancelled
    enabled_tools: list[str] = Field(default_factory=lambda: ["*"])  # Only register these tools; accepts raw MCP names or wrapped mcp_<server>_<tool> names; ["*"] = all tools; [] = no tools


def _lazy_default(module_path: str, class_name: str) -> Any:
    """Deferred import helper for ToolsConfig default factories."""
    import importlib
    module = importlib.import_module(module_path)
    return getattr(module, class_name)()


class TerminalExecMode(str, Enum):
    AUTO = "auto"
    APPROVAL = "approval"


class PPTMasterConfig(Base):
    """PPT Master skill configuration."""

    enabled: bool = False
    projects_dir: str = "ppt_projects"
    default_format: str = "ppt169"
    use_mona_image_gen: bool = True
    tts_enabled: bool = False
    live_preview: bool = True
    preview_port: int = 5050


class NotesToolsConfig(Base):
    """Configuration for notes agent tools (create/search/read/save_image)."""

    enabled: bool = True
    allow_create: bool = True  # controls notes_create and notes_save_image


class TerminalToolConfig(Base):
    enable: bool = True
    exec_mode: TerminalExecMode = TerminalExecMode.AUTO
    dangerous_patterns: list[str] = Field(
        default_factory=lambda: [
            "rm -rf /",
            "rm -rf /*",
            "mkfs",
            "dd if=",
            "dd of=",
            "> /dev/sd",
            "chmod -R 777 /",
            "chown -R",
            "shutdown",
            "reboot",
            "init 0",
            "init 6",
            ":(){ :|:& };:",
        ],
    )
    safe_patterns: list[str] = Field(
        default_factory=lambda: [
            "ls",
            "cat",
            "head",
            "tail",
            "grep",
            "find",
            "wc",
            "ps",
            "top",
            "df",
            "du",
            "free",
            "uptime",
            "echo",
            "pwd",
            "whoami",
            "hostname",
            "uname",
            "netstat",
            "ss",
            "ping",
            "curl",
            "wget",
        ],
    )


class ToolsConfig(Base):
    """Tools configuration.

    Field types for tool-specific sub-configs are resolved via model_rebuild()
    at the bottom of this file to avoid circular imports (tool modules import
    Base from schema.py).
    """

    web: WebToolsConfig = Field(default_factory=lambda: _lazy_default("mona.agent.tools.web", "WebToolsConfig"))
    exec: ExecToolConfig = Field(default_factory=lambda: _lazy_default("mona.agent.tools.shell", "ExecToolConfig"))
    my: MyToolConfig = Field(default_factory=lambda: _lazy_default("mona.agent.tools.self", "MyToolConfig"))
    image_generation: ImageGenerationToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.image_generation", "ImageGenerationToolConfig"),
    )
    video_generation: VideoGenerationToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.video_generation", "VideoGenerationToolConfig"),
    )
    document: DocumentToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.document", "DocumentToolConfig"),
    )
    office: OfficeToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.office", "OfficeToolConfig"),
    )
    http: HttpToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.http", "HttpToolConfig"),
    )
    dataframe: DataframeToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.dataframe", "DataframeToolConfig"),
    )
    chart: ChartToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.chart", "ChartToolConfig"),
    )
    canvas: CanvasToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.canvas", "CanvasToolConfig"),
    )
    crypto: CryptoToolConfig = Field(
        default_factory=lambda: _lazy_default("mona.agent.tools.crypto", "CryptoToolConfig"),
    )
    email_intel: EmailIntelConfig = Field(
        default_factory=lambda: _lazy_default("mona.email_intel.config", "EmailIntelConfig"),
    )
    notes_tools: NotesToolsConfig = Field(default_factory=NotesToolsConfig)
    restrict_to_workspace: bool = False  # restrict all tool access to workspace directory
    mcp_servers: dict[str, MCPServerConfig] = Field(default_factory=dict)
    ssrf_whitelist: list[str] = Field(default_factory=list)  # CIDR ranges to exempt from SSRF blocking (e.g. ["100.64.0.0/10"] for Tailscale)
    terminal: TerminalToolConfig = Field(default_factory=TerminalToolConfig)
    ppt_master: PPTMasterConfig = Field(default_factory=PPTMasterConfig)


class Config(BaseSettings):
    """Root configuration for mona."""

    agents: AgentsConfig = Field(default_factory=AgentsConfig)
    channels: ChannelsConfig = Field(default_factory=ChannelsConfig)
    providers: ProvidersConfig = Field(default_factory=ProvidersConfig)
    api: ApiConfig = Field(default_factory=ApiConfig)
    gateway: GatewayConfig = Field(default_factory=GatewayConfig)
    services: ServicesConfig = Field(default_factory=ServicesConfig)
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)
    video: VideoModuleConfig = Field(default_factory=VideoModuleConfig)
    profile: ProfileConfig = Field(default_factory=ProfileConfig)
    tools: ToolsConfig = Field(default_factory=ToolsConfig)
    stock: StockConfig = Field(default_factory=StockConfig)
    model_presets: dict[str, ModelPresetConfig] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("modelPresets", "model_presets"),
    )

    @model_validator(mode="after")
    def _validate_model_preset(self) -> "Config":
        if "default" in self.model_presets:
            raise ValueError("model_preset name 'default' is reserved for agents.defaults")
        name = self.agents.defaults.model_preset
        if name and name != "default" and name not in self.model_presets:
            raise ValueError(f"model_preset {name!r} not found in model_presets")
        for fallback in self.agents.defaults.fallback_models:
            if isinstance(fallback, str) and fallback not in self.model_presets:
                raise ValueError(f"fallback_models entry {fallback!r} not found in model_presets")
        return self

    def resolve_default_preset(self) -> ModelPresetConfig:
        """Return the implicit `default` preset from agents.defaults fields."""
        d = self.agents.defaults
        return ModelPresetConfig(
            model=d.model, provider=d.provider, max_tokens=d.max_tokens,
            context_window_tokens=d.context_window_tokens,
            temperature=d.temperature, reasoning_effort=d.reasoning_effort,
        )

    def resolve_preset(self, name: str | None = None) -> ModelPresetConfig:
        """Return effective model params from a named preset or the implicit default."""
        name = self.agents.defaults.model_preset if name is None else name
        if not name or name == "default":
            return self.resolve_default_preset()
        if name not in self.model_presets:
            raise KeyError(f"model_preset {name!r} not found in model_presets")
        return self.model_presets[name]

    @property
    def workspace_path(self) -> Path:
        """Get expanded workspace path."""
        return Path(self.agents.defaults.workspace).expanduser()

    def _match_provider(
        self, model: str | None = None,
        *,
        preset: ModelPresetConfig | None = None,
    ) -> tuple["ProviderConfig | None", str | None]:
        """Match provider config and its registry name. Returns (config, spec_name)."""
        from mona.providers.registry import (
            PROVIDERS,
            custom_provider_spec,
            find_by_name,
            is_custom_provider_name,
        )

        resolved = preset or self.resolve_preset()
        forced = resolved.provider
        if forced != "auto":
            spec = find_by_name(forced)
            if spec:
                p = self.providers.get_provider_config(spec.name)
                return (p, spec.name) if p else (None, None)
            return None, None

        model_lower = (model or resolved.model).lower()
        model_normalized = model_lower.replace("-", "_")
        model_prefix = model_lower.split("/", 1)[0] if "/" in model_lower else ""
        normalized_prefix = model_prefix.replace("-", "_")

        def _kw_matches(kw: str) -> bool:
            kw = kw.lower()
            return kw in model_lower or kw.replace("-", "_") in model_normalized

        dynamic_specs = []
        for name, provider_config in self.providers.cindy.items():
            if not is_custom_provider_name(name):
                continue
            keywords = [name]
            if provider_config.display_name:
                keywords.append(provider_config.display_name)
            keywords.extend(provider_config.enabled_models or [])
            keywords.extend(
                str(item.get("id"))
                for item in provider_config.discovered_models or []
                if isinstance(item, dict) and item.get("id")
            )
            spec = custom_provider_spec(name, keywords=tuple(dict.fromkeys(keywords)))
            if spec is not None:
                dynamic_specs.append(spec)
        registry_specs = PROVIDERS + tuple(dynamic_specs)

        # Explicit provider prefix wins — prevents `github-copilot/...codex` matching openai_codex.
        for spec in registry_specs:
            p = self.providers.get_provider_config(spec.name)
            if p and model_prefix and normalized_prefix == spec.name:
                if spec.is_oauth or spec.is_local or spec.is_direct or p.api_key or not spec.api_key_required:
                    return p, spec.name

        # Match by keyword (order follows PROVIDERS registry)
        for spec in registry_specs:
            p = self.providers.get_provider_config(spec.name)
            if p and any(_kw_matches(kw) for kw in spec.keywords):
                if spec.is_oauth or spec.is_local or spec.is_direct or p.api_key or not spec.api_key_required:
                    return p, spec.name

        # Fallback: configured local providers can route models without
        # provider-specific keywords (for example plain "llama3.2" on Ollama).
        # Prefer providers whose detect_by_base_keyword matches the configured api_base
        # (e.g. Ollama's "11434" in "http://localhost:11434") over plain registry order.
        local_fallback: tuple[ProviderConfig, str] | None = None
        for spec in registry_specs:
            if not spec.is_local:
                continue
            p = self.providers.get_provider_config(spec.name)
            if not (p and p.api_base):
                continue
            if spec.detect_by_base_keyword and spec.detect_by_base_keyword in p.api_base:
                return p, spec.name
            if local_fallback is None:
                local_fallback = (p, spec.name)
        if local_fallback:
            return local_fallback

        # Fallback: gateways first, then others (follows registry order)
        # OAuth providers are NOT valid fallbacks — they require explicit model selection
        for spec in registry_specs:
            if spec.is_oauth:
                continue
            if not spec.allow_auto_fallback:
                continue
            p = self.providers.get_provider_config(spec.name)
            if p and (p.api_key or not spec.api_key_required):
                return p, spec.name

        return None, None

    def get_provider(
        self,
        model: str | None = None,
        *,
        preset: ModelPresetConfig | None = None,
    ) -> ProviderConfig | None:
        """Get matched provider config (api_key, api_base, extra_headers). Falls back to first available."""
        p, _ = self._match_provider(model, preset=preset)
        return p

    def get_provider_name(
        self,
        model: str | None = None,
        *,
        preset: ModelPresetConfig | None = None,
    ) -> str | None:
        """Get the registry name of the matched provider (e.g. "deepseek", "openrouter")."""
        _, name = self._match_provider(model, preset=preset)
        return name

    def get_api_key(
        self,
        model: str | None = None,
        *,
        preset: ModelPresetConfig | None = None,
    ) -> str | None:
        """Get API key for the given model. Falls back to first available key."""
        p = self.get_provider(model, preset=preset)
        return p.api_key if p else None

    def get_api_base(
        self,
        model: str | None = None,
        *,
        preset: ModelPresetConfig | None = None,
    ) -> str | None:
        """Get API base URL for the given model, falling back to the provider default when present."""
        from mona.providers.registry import find_by_name

        p, name = self._match_provider(model, preset=preset)
        if p and p.api_base:
            return p.api_base
        if name:
            spec = find_by_name(name)
            if spec and spec.default_api_base:
                return spec.default_api_base
        return None

    model_config = ConfigDict(env_prefix="mona_", env_nested_delimiter="__")


def _resolve_tool_config_refs() -> None:
    """Resolve forward references in ToolsConfig by importing tool config classes.

    Must be called after all modules are loaded (breaks circular imports).
    Re-exports the classes into this module's namespace so existing imports
    like ``from mona.config.schema import ExecToolConfig`` continue to work.
    """
    import sys

    from mona.agent.tools.canvas import CanvasToolConfig
    from mona.agent.tools.chart import ChartToolConfig
    from mona.agent.tools.crypto import CryptoToolConfig
    from mona.agent.tools.dataframe import DataframeToolConfig
    from mona.agent.tools.document import DocumentToolConfig
    from mona.agent.tools.http import HttpToolConfig
    from mona.agent.tools.image_generation import ImageGenerationToolConfig
    from mona.agent.tools.office import OfficeToolConfig
    from mona.agent.tools.self import MyToolConfig
    from mona.agent.tools.shell import ExecToolConfig
    from mona.agent.tools.video_generation import VideoGenerationToolConfig
    from mona.agent.tools.web import WebFetchConfig, WebSearchConfig, WebToolsConfig
    from mona.email_intel.config import EmailIntelConfig

    # Re-export into this module's namespace
    mod = sys.modules[__name__]
    mod.ExecToolConfig = ExecToolConfig  # type: ignore[attr-defined]
    mod.WebToolsConfig = WebToolsConfig  # type: ignore[attr-defined]
    mod.WebSearchConfig = WebSearchConfig  # type: ignore[attr-defined]
    mod.WebFetchConfig = WebFetchConfig  # type: ignore[attr-defined]
    mod.MyToolConfig = MyToolConfig  # type: ignore[attr-defined]
    mod.ImageGenerationToolConfig = ImageGenerationToolConfig  # type: ignore[attr-defined]
    mod.VideoGenerationToolConfig = VideoGenerationToolConfig  # type: ignore[attr-defined]
    mod.DocumentToolConfig = DocumentToolConfig  # type: ignore[attr-defined]
    mod.HttpToolConfig = HttpToolConfig  # type: ignore[attr-defined]
    mod.DataframeToolConfig = DataframeToolConfig  # type: ignore[attr-defined]
    mod.ChartToolConfig = ChartToolConfig  # type: ignore[attr-defined]
    mod.CanvasToolConfig = CanvasToolConfig  # type: ignore[attr-defined]
    mod.CryptoToolConfig = CryptoToolConfig  # type: ignore[attr-defined]
    mod.OfficeToolConfig = OfficeToolConfig  # type: ignore[attr-defined]
    mod.EmailIntelConfig = EmailIntelConfig  # type: ignore[attr-defined]

    ToolsConfig.model_rebuild()
    Config.model_rebuild()


# Eagerly resolve when the import chain allows it (no circular deps at this
# point).  If it fails (first import triggers a cycle), the rebuild will
# happen lazily when Config/ToolsConfig is first used at runtime.
try:
    _resolve_tool_config_refs()
except ImportError:
    pass
