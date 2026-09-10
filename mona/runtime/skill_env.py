"""Legacy Skill runtime metadata retained for coverage-upgrade compatibility."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import Field, field_validator, model_validator

from mona.config.schema import Base
from mona.runtime.manager import parse_runtime_pack_ref

DEFAULT_PYTHON_BASE_REF = "python-base@3.13.15"
DEFAULT_NODE_BASE_REF = "node-base@22.23.2"
DEFAULT_PYPI_INDEX_URLS = (
    "https://mirrors.huaweicloud.com/repository/pypi/simple",
    "https://pypi.org/simple",
)
DEFAULT_NPM_REGISTRIES = (
    "https://registry.npmmirror.com",
    "https://registry.npmjs.org",
)

# Legacy profile names remain readable for installed Skills created before the
# shared Agent environment. New Skills should use pyproject.toml/package.json.
PLATFORM_PYTHON_PROFILES: dict[str, tuple[str, ...]] = {
    "platform-docx": ("defusedxml==0.7.1", "lxml==6.1.2"),
    "platform-pdf": (
        "pillow==12.3.0",
        "pymupdf==1.28.2",
        "pdfplumber==0.11.10",
        "pypdf==6.16.2",
        "reportlab==5.0.1",
    ),
    "platform-presentations": (
        "defusedxml==0.7.1",
        "lxml==6.1.2",
        "python-pptx==1.0.2",
        "pillow==12.3.0",
        "beautifulsoup4==4.15.0",
        "cairosvg==2.9.0",
        "curl-cffi==0.16.2",
        "ebooklib==0.20",
        "edge-tts==7.2.8",
        "pymupdf==1.28.2",
        "flask==3.1.3",
        "mammoth==1.12.1",
        "markdownify==1.2.3",
        "matplotlib==3.11.1",
        "nbconvert==7.17.1",
        "nbformat==5.11.1",
        "numpy==2.5.2",
        "openpyxl==3.1.5",
        "playwright==1.62.0",
        "reportlab==5.0.1",
        "requests==2.34.2",
        "svglib==2.2.0",
        "urllib3==2.7.0",
        "xlrd==2.0.2",
        "pyyaml==6.0.3",
    ),
    "platform-video": ("loguru==0.7.3", "websockets==17.1"),
    "platform-authoring": (),
}
PLATFORM_PYTHON_REQUIREMENTS = tuple(
    dict.fromkeys(
        requirement
        for requirements in PLATFORM_PYTHON_PROFILES.values()
        for requirement in requirements
    )
)

_PYTHON_REQUIREMENT_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?=="
    r"[A-Za-z0-9][A-Za-z0-9._+!-]*$"
)
_NODE_PACKAGE_RE = re.compile(
    r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@"
    r"[0-9][0-9A-Za-z._+-]*$",
    re.IGNORECASE,
)


class PythonSkillDependencies(Base):
    profile: (
        Literal[
            "platform",
            "platform-docx",
            "platform-pdf",
            "platform-presentations",
            "platform-video",
            "platform-authoring",
        ]
        | None
    ) = None
    requirements: list[str] = Field(default_factory=list, max_length=256)

    @field_validator("requirements")
    @classmethod
    def _requirements(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for raw in values:
            value = raw.strip()
            if not _PYTHON_REQUIREMENT_RE.fullmatch(value):
                raise ValueError(
                    "Legacy Python Skill dependencies must use exact name==version pins"
                )
            if value.lower() not in {item.lower() for item in result}:
                result.append(value)
        return result

    @model_validator(mode="after")
    def _profile_or_requirements(self) -> PythonSkillDependencies:
        if self.profile is not None and self.requirements:
            raise ValueError("Python Skill profile cannot be combined with requirements")
        return self


class NodeSkillDependencies(Base):
    packages: list[str] = Field(default_factory=list, max_length=256)

    @field_validator("packages")
    @classmethod
    def _packages(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for raw in values:
            value = raw.strip()
            if not _NODE_PACKAGE_RE.fullmatch(value):
                raise ValueError(
                    "Legacy Node Skill dependencies must use exact package@version pins"
                )
            if value.lower() not in {item.lower() for item in result}:
                result.append(value)
        return result


class SkillRuntimeSpec(Base):
    """Legacy ``metadata.mona.runtime`` declaration kept for upgrade compatibility."""

    packs: list[str] = Field(default_factory=list, max_length=64)
    python: PythonSkillDependencies | None = None
    node: NodeSkillDependencies | None = None
    optional_script_types: list[Literal["py", "mjs", "r"]] = Field(
        default_factory=list,
        max_length=8,
    )

    @field_validator("optional_script_types")
    @classmethod
    def _optional_script_types(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(values))

    @field_validator("packs")
    @classmethod
    def _packs(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for raw in values:
            value = raw.strip()
            parse_runtime_pack_ref(value)
            if value not in result:
                result.append(value)
        return result

    @model_validator(mode="after")
    def _nonempty(self) -> SkillRuntimeSpec:
        if (
            not self.packs
            and self.python is None
            and self.node is None
            and not self.optional_script_types
        ):
            raise ValueError("Skill runtime declaration is empty")
        return self

    def canonical(self) -> dict[str, object]:
        payload = self.model_dump(mode="json", exclude_none=True)
        if not self.optional_script_types:
            payload.pop("optional_script_types", None)
        return payload


def parse_skill_runtime_spec(raw: object) -> SkillRuntimeSpec | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("metadata.mona.runtime must be an object")
    return SkillRuntimeSpec.model_validate(raw)


def runtime_spec_from_skill_markdown(content: str) -> SkillRuntimeSpec | None:
    if not content.startswith("---"):
        return None
    import yaml

    match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n", content, flags=re.DOTALL)
    if match is None:
        return None
    parsed = yaml.safe_load(match.group(1)) or {}
    if not isinstance(parsed, dict):
        return None
    metadata = parsed.get("metadata")
    if not isinstance(metadata, dict):
        return None
    mona_meta = metadata.get("mona", metadata.get("openclaw"))
    if not isinstance(mona_meta, dict):
        return None
    return parse_skill_runtime_spec(mona_meta.get("runtime"))


__all__ = [
    "DEFAULT_NODE_BASE_REF",
    "DEFAULT_NPM_REGISTRIES",
    "DEFAULT_PYPI_INDEX_URLS",
    "DEFAULT_PYTHON_BASE_REF",
    "NodeSkillDependencies",
    "PLATFORM_PYTHON_PROFILES",
    "PLATFORM_PYTHON_REQUIREMENTS",
    "PythonSkillDependencies",
    "SkillRuntimeSpec",
    "parse_skill_runtime_spec",
    "runtime_spec_from_skill_markdown",
]
