"""Shared package-path filtering for Mona PowerPoint Skill resources."""

from __future__ import annotations

from pathlib import Path, PurePosixPath

_PPTX_PACKAGE_PREFIX = ("mona", "skills", "mona-pptx", "assets")
_PREVIEW_DIRECTORIES = frozenset({"presets", "design", "scenarios"})
_EXCLUDED_RESOURCE_PATHS = frozenset(
    {
        ("previews.json",),
        ("dashi", "templates.json"),
        ("native", "editorial-evidence.png"),
        ("native", "parallel-five.png"),
        ("native", "product-story.png"),
    }
)


def should_include_mona_pptx_package_resource(
    source: str | Path,
    destination: str | Path,
) -> bool:
    """Filter one PyInstaller source/destination pair using its package-relative file path."""
    source_parts = PurePosixPath(str(source).replace("\\", "/")).parts
    if not source_parts:
        return True
    destination_parts = PurePosixPath(str(destination).replace("\\", "/")).parts
    parts = (*destination_parts, source_parts[-1])
    prefix_length = len(_PPTX_PACKAGE_PREFIX)
    for index in range(len(parts) - prefix_length + 1):
        if parts[index : index + prefix_length] != _PPTX_PACKAGE_PREFIX:
            continue
        resource_path = parts[index + prefix_length :]
        if resource_path in _EXCLUDED_RESOURCE_PATHS:
            return False
        if (
            len(resource_path) >= 2
            and resource_path[0] in _PREVIEW_DIRECTORIES
            and PurePosixPath(resource_path[-1]).suffix.lower() == ".png"
        ):
            return False
        return True
    return True
