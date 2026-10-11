"""Generated image display references, scoped to their owning project."""
from __future__ import annotations

import base64
import io
import re
from pathlib import Path

from PIL import Image

from mona.config.paths import get_media_dir
from mona.development.contracts import Project
from mona.development.store import DevelopmentError, NotFoundError
from mona.utils.media_decode import DEFAULT_MAX_BYTES
from mona.utils.media_store import store_media_bytes

MEDIA_PREFIX = "mona-media:"
_REFERENCE = re.compile(r"mona-media:(sha256-[a-f0-9]{64}\.(png|jpeg|gif|webp|avif|bmp))\Z")
_FORMATS = {"PNG": "png", "JPEG": "jpeg", "GIF": "gif", "WEBP": "webp", "AVIF": "avif", "BMP": "bmp"}


def _media_root(project: Project) -> Path:
    root = get_media_dir("development").resolve() / project.id
    if root.resolve() != root:
        raise DevelopmentError("media_outside_project", "图片存储路径已变化。")
    return root


def materialize_generated_image(project: Project, artifact_root: Path, source: str) -> str:
    if source.startswith(("https://", "http://")):
        return source  # Display only; never fetch an untrusted URL in the backend.
    if source.startswith("data:") or re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", source):
        encoded = source
        if source.startswith("data:"):
            header, separator, encoded = source.partition(",")
            if not separator or not re.fullmatch(r"data:image/(?:png|jpeg|gif|webp|avif|bmp);base64", header):
                raise DevelopmentError("invalid_generated_image", "生成的图片格式无效。")
        if len(encoded) > (DEFAULT_MAX_BYTES + 2) // 3 * 4:
            raise DevelopmentError("media_too_large", "生成的图片超过大小上限。")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise DevelopmentError("invalid_generated_image", "生成的图片数据无效。") from error
    else:
        from mona.development.workspace import project_path
        target = Path(source).expanduser()
        if not target.is_absolute():
            target = project_path(project) / target
        target = target.resolve(strict=True)
        artifact_root = artifact_root.absolute()
        owned_artifact = artifact_root.resolve() == artifact_root and target.is_relative_to(artifact_root)
        if not owned_artifact and not target.is_relative_to(project_path(project)):
            raise DevelopmentError("media_outside_project", "生成的图片不属于当前任务。")
        if target.stat().st_size > DEFAULT_MAX_BYTES:
            raise DevelopmentError("media_too_large", "生成的图片超过大小上限。")
        with target.open("rb") as stream:
            raw = stream.read(DEFAULT_MAX_BYTES + 1)
    if len(raw) > DEFAULT_MAX_BYTES:
        raise DevelopmentError("media_too_large", "生成的图片超过大小上限。")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            suffix = _FORMATS.get(image.format)
            image.verify()
        if not suffix:
            raise ValueError("unsupported image format")
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError) as error:
        raise DevelopmentError("invalid_generated_image", "生成的图片文件无效。") from error
    stored = store_media_bytes(raw, _media_root(project), "." + suffix)
    return MEDIA_PREFIX + stored.name


def read_generated_image(project: Project, reference: str) -> tuple[bytes, str]:
    match = _REFERENCE.fullmatch(reference)
    if not match:
        raise DevelopmentError("invalid_media_reference", "图片引用无效。")
    root = _media_root(project)
    target = (root / match[1]).resolve()
    if not target.is_relative_to(root):
        raise DevelopmentError("media_outside_project", "图片不属于当前项目。")
    if not target.is_file():
        raise NotFoundError()
    if target.stat().st_size > DEFAULT_MAX_BYTES:
        raise DevelopmentError("media_too_large", "图片超过大小上限。")
    with target.open("rb") as stream:
        raw = stream.read(DEFAULT_MAX_BYTES + 1)
    if len(raw) > DEFAULT_MAX_BYTES:
        raise DevelopmentError("media_too_large", "图片超过大小上限。")
    return raw, "image/" + match[2]
