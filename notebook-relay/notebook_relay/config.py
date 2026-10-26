import ipaddress
import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PUBLIC_UPSTREAMS = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter_free": "https://openrouter.ai/api/v1",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NOTEBOOK_RELAY_", hide_input_in_errors=True
    )

    host: Literal["127.0.0.1", "::1"] = "127.0.0.1"
    port: int = Field(default=8800, ge=1, le=65535)
    api_key: SecretStr
    upstream_provider: Literal["local", "groq", "openrouter_free", "opencode_native"] = "local"
    upstream_base_url: str | None = None
    upstream_api_key: SecretStr | None = None
    models: tuple[str, ...] = ()
    max_concurrency: int = Field(default=16, ge=1, le=128)
    request_timeout_seconds: float = Field(default=180, gt=0, le=600)
    max_body_bytes: int = Field(default=2 * 1024 * 1024, ge=1, le=16 * 1024 * 1024)
    opencode_executable: str | None = None
    opencode_start_timeout_seconds: float = Field(default=30, gt=0, le=120)
    opencode_max_response_bytes: int = Field(default=16 * 1024 * 1024, ge=1024)

    @field_validator("api_key")
    @classmethod
    def validate_api_key(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < 16:
            raise ValueError("NOTEBOOK_RELAY_API_KEY 至少需要 16 个字符")
        return value

    @field_validator("upstream_base_url")
    @classmethod
    def validate_upstream(cls, value: str | None) -> str | None:
        if not value:
            return None
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("上游必须是无凭据、查询参数及片段的本机 HTTP 地址")
        try:
            address = ipaddress.ip_address(parsed.hostname)
            if parsed.port == 0:
                raise ValueError("invalid port")
        except ValueError:
            raise ValueError("上游必须使用有效的数值回环地址和端口") from None
        if not address.is_loopback:
            raise ValueError("上游只允许数值回环地址")
        return value.rstrip("/")

    @field_validator("models")
    @classmethod
    def validate_models(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if any(not item.strip() for item in value) or len(set(value)) != len(value):
            raise ValueError("模型白名单不能包含空项或重复项")
        return value

    @model_validator(mode="after")
    def validate_provider(self):
        if self.upstream_provider != "local" and self.upstream_base_url is not None:
            raise ValueError("官方预设不接受自定义上游地址")
        if self.upstream_provider == "opencode_native":
            if self.models and self.models != ("deepseek-v4.1-flash-free",):
                raise ValueError("原生 OpenCode 通道仅允许官方免费 DeepSeek V4.1 Flash")
            self.models = ("deepseek-v4.1-flash-free",)
        if self.upstream_provider == "openrouter_free" and any(
            re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*:free", model) is None
            for model in self.models
        ):
            raise ValueError("OpenRouter 免费预设只允许目录中具名的 :free 模型")
        return self

    @property
    def resolved_upstream_base_url(self) -> str | None:
        if self.upstream_provider == "local":
            return self.upstream_base_url
        if self.upstream_provider == "opencode_native":
            return None
        return PUBLIC_UPSTREAMS[self.upstream_provider]

