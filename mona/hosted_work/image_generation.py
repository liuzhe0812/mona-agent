"""Private workspace adapter for the shared image-generation tool.

This module is not registered as a Hosted Work capability.  A caller must
provide a per-image wrapper before it can be used.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from mona.agent.tools.base import Tool
from mona.agent.tools.image_generation import ImageGenerationTool, ImageGenerationToolConfig
from mona.config.schema import ProviderConfig
from mona.hosted_work.contracts import identifier
from mona.hosted_work.sandbox_files import relative_path
from mona.providers.image_generation import (
    CodexImageGenerationClient,
    GeminiImageGenerationClient,
    GeneratedImageResponse,
    ImageGenerationError,
    MonaManagedImageGenerationClient,
    OpenAIImageGenerationClient,
    StepFunImageGenerationClient,
)
from mona.utils.artifacts import (
    ArtifactError,
    _artifact_root,
    _safe_relative_dir,
    decode_image_data_url,
)
from mona.utils.helpers import detect_image_mime

_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_OWNER = re.compile(r"^[a-f0-9]{64}$")
_EXTENSIONS = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}


@dataclass(frozen=True)
class ImageCall:
    """Server-generated identity and non-secret details for one image request."""

    operation_id: str
    index: int
    model: str
    image_size: str | None
    aspect_ratio: str | None
    request_fingerprint: str = field(repr=False)


ImageCallWrapper = Callable[
    [ImageCall, Callable[[], Awaitable[GeneratedImageResponse]]], Awaitable[GeneratedImageResponse]
]
ImageProviderFactory = Callable[[ImageGenerationToolConfig, dict[str, ProviderConfig]], Any]


def _state_root(state_dir: str | Path) -> Path:
    path = Path(state_dir)
    if (not path.is_absolute() or path.is_symlink()
            or bool(getattr(path, "is_junction", lambda: False)()) or not path.is_dir()):
        raise ValueError("invalid hosted image state")
    return path.resolve(strict=True)


def _scoped_directory(parent: Path, name: str, *, create: bool) -> Path | None:
    path = parent / name
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        if not create:
            return None
        raise
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or bool(getattr(path, "is_junction", lambda: False)())):
        raise ValueError("invalid hosted image staging directory")
    resolved = path.resolve(strict=True)
    if resolved != path or resolved.parent != parent:
        raise ValueError("invalid hosted image staging directory")
    if create:
        path.chmod(0o700)
    return resolved


def _run_staging(state_dir: str | Path, owner: str, run_id: str, *, create: bool) -> Path | None:
    if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
        raise ValueError("invalid hosted image owner")
    identifier(run_id)
    current = _state_root(state_dir)
    for name in ("users", owner, "image-staging", run_id):
        current = _scoped_directory(current, name, create=create)
        if current is None:
            return None
    return current


def cleanup_image_staging(state_dir: str | Path, owner: str, run_id: str, *, executor_stopped: bool = False) -> bool:
    """Remove only one run's staging after the caller confirms its executor stopped."""
    if executor_stopped is not True:
        raise ValueError("hosted image executor is not confirmed stopped")
    target = _run_staging(state_dir, owner, run_id, create=False)
    if target is None:
        return False

    def fail(error):
        raise error

    for directory, directories, files in os.walk(target, followlinks=False, onerror=fail):
        for name in directories + files:
            path = Path(directory) / name
            metadata = path.lstat()
            if (stat.S_ISLNK(metadata.st_mode) or bool(getattr(path, "is_junction", lambda: False)())
                    or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode))
                    or stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1
                    or path.resolve(strict=True) != path or not path.is_relative_to(target)):
                raise ValueError("invalid hosted image staging content")
    if target.resolve(strict=True) != target or target.name != run_id or target.parent.name != "image-staging":
        raise ValueError("invalid hosted image staging target")
    shutil.rmtree(target)
    return True


def _result(code: str, message: str, artifacts: list[dict[str, Any]], *, retry_safe: bool = False) -> str:
    return json.dumps({"ok": False, "code": code, "message": message, "retry_safe": retry_safe,
                       "retryable": retry_safe, "artifacts": artifacts}, ensure_ascii=False)


def _request_fingerprint(prompt: str, model: str, image_size: str | None, aspect_ratio: str | None,
                         reference_digests: tuple[str, ...]) -> str:
    payload = {"prompt": prompt, "model": model, "image_size": image_size,
               "aspect_ratio": aspect_ratio, "reference_sha256": reference_digests}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(b"mona-hosted-image-request-v1\0" + canonical.encode("utf-8")).hexdigest()


def _verify_staged_references(paths: list[str], digests: tuple[str, ...], max_file_bytes: int) -> None:
    if len(paths) != len(digests):
        raise ImageGenerationError("reference image could not be verified", code="result_unknown")
    try:
        for value, expected in zip(paths, digests):
            path = Path(value)
            if path.is_symlink():
                raise ValueError("linked reference")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                        or not 0 < metadata.st_size <= max_file_bytes):
                    raise ValueError("invalid reference")
                raw = stream.read(max_file_bytes + 1)
            if len(raw) != metadata.st_size or hashlib.sha256(raw).hexdigest() != expected:
                raise ValueError("changed reference")
    except (OSError, ValueError) as exc:
        raise ImageGenerationError("reference image could not be verified", code="result_unknown") from exc


class _ObservedProvider:
    def __init__(self, provider, wrapper: ImageCallWrapper, index: int, operation_id: str, max_file_bytes: int,
                 reference_digests: tuple[str, ...]):
        self.provider, self.wrapper, self.index = provider, wrapper, index
        self.max_file_bytes = max_file_bytes
        self.operation_id = operation_id
        self.reference_digests = reference_digests
        self.started = False
        self.post_response_uncertain = False

    async def generate(self, *, prompt, model, reference_images=None, aspect_ratio=None, image_size=None):
        actual = None

        async def invoke():
            nonlocal actual
            if self.started:
                raise ImageGenerationError("image request already sent", code="result_unknown")
            self.started = True
            _verify_staged_references(reference_images or [], self.reference_digests, self.max_file_bytes)
            actual = await self.provider.generate(prompt=prompt, model=model, reference_images=reference_images,
                                                  aspect_ratio=aspect_ratio, image_size=image_size)
            if (not isinstance(actual, GeneratedImageResponse) or len(actual.images) != 1
                    or not isinstance(actual.images[0], str)
                    or len(actual.images[0]) > 4 * ((self.max_file_bytes + 2) // 3) + 128):
                actual = None
                raise ImageGenerationError("image response could not be verified", code="result_unknown")
            return actual

        try:
            fingerprint = _request_fingerprint(prompt, model, image_size, aspect_ratio, self.reference_digests)
            wrapped = await self.wrapper(
                ImageCall(self.operation_id, self.index, model, image_size, aspect_ratio, fingerprint), invoke)
            if actual is None or wrapped is not actual:
                raise ImageGenerationError("image response could not be verified", code="result_unknown")
            return actual
        except (Exception, asyncio.CancelledError):
            if actual is None:
                raise
            # Preserve a received image when settlement or cancellation becomes
            # uncertain, but do not claim the overall operation succeeded.
            self.post_response_uncertain = True
            return actual


class _WorkspaceImageTool(ImageGenerationTool):
    def __init__(self, *, workspace: Path, config: ImageGenerationToolConfig,
                 provider_configs: dict[str, ProviderConfig], wrapper: ImageCallWrapper,
                 index: int, operation_id: str, max_file_bytes: int, reference_count: int,
                 provider_factory: ImageProviderFactory | None, reference_digests: tuple[str, ...]):
        super().__init__(workspace=workspace, config=config, provider_configs=provider_configs)
        self.wrapper, self.index, self.operation_id, self.max_file_bytes = wrapper, index, operation_id, max_file_bytes
        self.reference_count, self.provider_factory = reference_count, provider_factory
        self.reference_digests = reference_digests
        self.observed: _ObservedProvider | None = None

    def _active_workspace(self) -> Path:
        return self.workspace

    def _resolve_reference_image(self, value: str) -> str:
        path = Path(value).resolve(strict=True)
        if not path.is_relative_to(self.workspace.resolve(strict=True)) or not path.is_file():
            raise ImageGenerationError("reference image is unavailable")
        return str(path)

    def _store_artifact(self, image_data_url: str, **kwargs: Any) -> dict[str, Any]:
        from PIL import Image, UnidentifiedImageError

        raw, mime = decode_image_data_url(image_data_url)
        if not 0 < len(raw) <= self.max_file_bytes or mime not in _EXTENSIONS:
            raise ArtifactError("generated image is not available")
        try:
            with Image.open(io.BytesIO(raw)) as image:
                width, height = image.size
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise ArtifactError("generated image could not be read") from exc
        root = _artifact_root(kwargs["save_dir"], kwargs["artifact_root"])
        directory = root / datetime.now().astimezone().strftime("%Y-%m-%d")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink() or directory.resolve(strict=True) != directory:
            raise ArtifactError("invalid generated image directory")
        if not directory.is_relative_to(self.workspace.resolve(strict=True)):
            raise ArtifactError("generated image directory escapes workspace")
        artifact_id = "img_" + uuid4().hex
        path = directory / (artifact_id + _EXTENSIONS[mime])
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
                             | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
        return {"id": artifact_id, "path": str(path), "mime": mime, "width": width, "height": height}

    def _provider_client(self):
        provider = (self.provider_factory(self.config, self.provider_configs)
                    if self.provider_factory is not None else super()._provider_client())
        if provider is None:
            return None
        # These implementations either discard some references or depend on
        # the desktop's private media directory instead of this workspace.
        if self.reference_count and (
            isinstance(provider, (OpenAIImageGenerationClient, CodexImageGenerationClient))
            or isinstance(provider, GeminiImageGenerationClient) and "imagen" in self.config.model.lower()
            or isinstance(provider, StepFunImageGenerationClient)
            and ("1x" not in self.config.model or self.reference_count > 1)
            or isinstance(provider, MonaManagedImageGenerationClient)
        ):
            raise ImageGenerationError("reference images are not supported", code="REFERENCE_IMAGE_UNSUPPORTED")
        # These desktop implementations discover credentials from the local
        # account/device rather than an explicitly bound Hosted Work identity.
        if isinstance(provider, (CodexImageGenerationClient, MonaManagedImageGenerationClient)):
            raise ImageGenerationError("image provider is not available", code="IMAGE_PROVIDER_UNAVAILABLE")
        self.observed = _ObservedProvider(provider, self.wrapper, self.index, self.operation_id,
                                          self.max_file_bytes, self.reference_digests)
        return self.observed


class HostedImageGenerationTool(Tool):
    """Run the desktop image tool against one sandbox with no host paths in results.

    The trusted caller must bind and persist each operation ID before invoking
    the provider. The ID factory may return a previously persisted ID for
    recovery; its index restarts for each tool call. The wrapper returns the
    exact provider response after handling its admission and settlement.
    A caller-supplied provider factory owns its client's network policy and
    lifecycle. The desktop default alone is not a hosted network boundary.
    """

    def __init__(self, *, sandbox, config: ImageGenerationToolConfig,
                 provider_configs: dict[str, ProviderConfig], call_wrapper: ImageCallWrapper,
                 state_dir: str | Path, owner: str, run_id: str,
                 max_file_bytes: int, workspace_bytes: int, max_reference_images: int,
                 timeout_seconds: float, operation_id_factory: Callable[[int], str] | None = None,
                 provider_factory: ImageProviderFactory | None = None):
        if (not callable(call_wrapper) or type(max_file_bytes) is not int or max_file_bytes <= 0
                or type(workspace_bytes) is not int or workspace_bytes < max_file_bytes
                or type(max_reference_images) is not int or max_reference_images < 0
                or operation_id_factory is not None and not callable(operation_id_factory)
                or provider_factory is not None and not callable(provider_factory)
                or isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
                or not 0 < timeout_seconds < float("inf")):
            raise ValueError("invalid hosted image configuration")
        self.sandbox = sandbox
        self.state_dir = _state_root(state_dir)
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise ValueError("invalid hosted image owner")
        self.owner, self.run_id = owner, identifier(run_id)
        self.config = config.model_copy(deep=True)
        selected_provider = provider_configs.get(self.config.provider)
        self.provider_configs = ({self.config.provider: selected_provider.model_copy(deep=True)}
                                 if selected_provider is not None else {})
        self.call_wrapper = call_wrapper
        self.max_file_bytes, self.workspace_bytes = max_file_bytes, workspace_bytes
        self.max_reference_images, self.timeout_seconds = max_reference_images, timeout_seconds
        self.operation_id_factory = operation_id_factory or (lambda _index: uuid4().hex)
        self.provider_factory = provider_factory
        self._schema = ImageGenerationTool(workspace=".", config=self.config, provider_configs={})

    @property
    def name(self) -> str:
        return self._schema.name

    @property
    def description(self) -> str:
        description = self._schema.description + " Reference images must be in the current /workspace."
        if self.config.provider == "openai_codex":
            description += (" The current image service only supports 1K square (1:1) output and cannot edit "
                            "reference images. Do not represent square output as a requested 16:9 image.")
        return description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._schema.parameters

    async def _reference(self, value: str, directory: Path) -> tuple[str, int, str]:
        if value.startswith(("http://", "https://", "data:")):
            raise ValueError("reference must be a workspace file")
        path = relative_path(value)
        reply = await self.sandbox.file({"action": "download", "path": path})
        if (not isinstance(reply, dict) or reply.get("path") != path or type(reply.get("size")) is not int
                or not 0 < reply["size"] <= self.max_file_bytes
                or not isinstance(reply.get("sha256"), str) or not _SHA256.fullmatch(reply["sha256"])):
            raise ValueError("invalid workspace image")
        encoded = reply.get("data")
        if not isinstance(encoded, str) or len(encoded) > 4 * ((self.max_file_bytes + 2) // 3):
            raise ValueError("invalid workspace image")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("invalid workspace image") from exc
        digest = hashlib.sha256(raw).hexdigest()
        if len(raw) != reply["size"] or digest != reply["sha256"]:
            raise ValueError("workspace image changed")
        suffix = _EXTENSIONS.get(detect_image_mime(raw))
        if suffix is None:
            raise ValueError("unsupported workspace image")
        target = directory / (uuid4().hex + suffix)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
        return str(target), len(raw), digest

    async def _artifact(self, root: Path, item: Any) -> dict[str, Any]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("invalid image artifact")
        path = Path(item["path"])
        if not path.is_absolute() or not path.is_relative_to(root):
            raise ValueError("invalid image artifact")
        relative = path.relative_to(root)
        if any(part in {".", ".."} for part in relative.parts):
            raise ValueError("invalid image artifact")
        current = root
        for part in relative.parts:
            current /= part
            if current.is_symlink() or bool(getattr(current, "is_junction", lambda: False)()):
                raise ValueError("invalid image artifact")
        resolved = path.resolve(strict=True)
        if resolved != path or not resolved.is_relative_to(root):
            raise ValueError("invalid image artifact")
        descriptor = os.open(resolved, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                    or not 0 < metadata.st_size <= self.max_file_bytes):
                raise ValueError("invalid image artifact")
            raw = stream.read(self.max_file_bytes + 1)
        mime = detect_image_mime(raw)
        if len(raw) != metadata.st_size or mime not in _EXTENSIONS:
            raise ValueError("invalid image artifact")
        artifact_id = "img_" + uuid4().hex
        path_in_workspace = relative_path((relative.parent / (artifact_id + _EXTENSIONS[mime])).as_posix())
        digest = hashlib.sha256(raw).hexdigest()
        reply = await self.sandbox.file({"action": "upload", "path": path_in_workspace,
                                         "data": base64.b64encode(raw).decode("ascii")})
        if (not isinstance(reply, dict) or reply.get("path") != path_in_workspace
                or type(reply.get("size")) is not int or reply["size"] != len(raw) or reply.get("sha256") != digest):
            raise ValueError("workspace write could not be verified")
        result = {"id": artifact_id, "path": "/workspace/" + path_in_workspace,
                  "mime": mime, "size": len(raw), "sha256": digest}
        for key in ("width", "height"):
            if type(item.get(key)) is int and item[key] > 0:
                result[key] = item[key]
        return result

    async def execute(self, prompt: str, reference_images: list[str] | None = None,
                      aspect_ratio: str | None = None, image_size: str | None = None,
                      count: int | None = None, **kwargs: Any) -> str:
        artifacts: list[dict[str, Any]] = []
        params = {"prompt": prompt, **{key: value for key, value in {
            "reference_images": reference_images, "aspect_ratio": aspect_ratio,
            "image_size": image_size, "count": count,
        }.items() if value is not None}}
        if (kwargs or not self.config.enabled or self.validate_params(params)
                or count is not None and type(count) is not int
                or reference_images is not None and len(reference_images) > self.max_reference_images):
            return _result("IMAGE_GENERATION_UNAVAILABLE", "图片生成配置或参数不可用。", artifacts)
        try:
            _safe_relative_dir(self.config.save_dir)
        except (ArtifactError, TypeError, AttributeError):
            return _result("IMAGE_GENERATION_UNAVAILABLE", "图片生成配置或参数不可用。", artifacts)
        requested = count if count is not None else 1
        invoked = False
        current_started = False
        try:
            run_staging = _run_staging(self.state_dir, self.owner, self.run_id, create=True)
            assert run_staging is not None
            with tempfile.TemporaryDirectory(prefix="call-", dir=run_staging) as temporary:
                root = Path(temporary).resolve(strict=True)
                if os.name != "nt" and stat.S_IMODE(root.stat().st_mode) & 0o077:
                    raise ValueError("temporary directory is not private")
                references = root / "references"
                references.mkdir(mode=0o700)
                staged, reference_digests, total = [], [], 0
                for value in reference_images or []:
                    async with asyncio.timeout(self.timeout_seconds):
                        path, size, digest = await self._reference(value, references)
                    total += size
                    if total > self.workspace_bytes:
                        raise ValueError("workspace image limit exceeded")
                    staged.append(path)
                    reference_digests.append(digest)
                operation_ids: set[str] = set()
                for index in range(requested):
                    current_started = False
                    operation_id = self.operation_id_factory(index)
                    if (not isinstance(operation_id, str) or not re.fullmatch(r"[a-f0-9]{32}", operation_id)
                            or operation_id in operation_ids):
                        raise ValueError("invalid image operation identity")
                    operation_ids.add(operation_id)
                    tool = _WorkspaceImageTool(workspace=root, config=self.config, provider_configs=self.provider_configs,
                                               wrapper=self.call_wrapper, index=index, operation_id=operation_id,
                                               max_file_bytes=self.max_file_bytes, reference_count=len(staged),
                                               provider_factory=self.provider_factory,
                                               reference_digests=tuple(reference_digests))
                    try:
                        async with asyncio.timeout(self.timeout_seconds):
                            raw = await tool.execute(prompt=prompt, reference_images=staged,
                                                     aspect_ratio=aspect_ratio, image_size=image_size, count=1)
                    except TimeoutError:
                        return _result("MEDIA_RESULT_UNKNOWN", "图片生成结果暂未确认，请先检查已有结果。", artifacts)
                    finally:
                        current_started = bool(tool.observed and tool.observed.started)
                        invoked = invoked or current_started
                    try:
                        payload = json.loads(raw)
                    except (TypeError, ValueError):
                        payload = None
                    if not isinstance(payload, dict):
                        code = "MEDIA_RESULT_UNKNOWN" if invoked else "IMAGE_GENERATION_UNAVAILABLE"
                        return _result(code, "图片生成未能确认，请检查已有结果。", artifacts)
                    items = payload.get("artifacts", [])
                    if not isinstance(items, list) or payload.get("ok") is True and len(items) != 1:
                        return _result("MEDIA_RESULT_UNKNOWN", "图片生成结果暂未确认，请先检查已有结果。", artifacts)
                    for item in items:
                        async with asyncio.timeout(self.timeout_seconds):
                            artifacts.append(await self._artifact(root, item))
                    if payload.get("ok") is not True or tool.observed and tool.observed.post_response_uncertain:
                        if payload.get("code") == "INSUFFICIENT_CREDITS" and not current_started:
                            return _result("INSUFFICIENT_CREDITS", "模型余额不足，请充值后继续。", artifacts)
                        if payload.get("code") == "REFERENCE_IMAGE_UNSUPPORTED" and not current_started:
                            return _result("REFERENCE_IMAGE_UNSUPPORTED", "当前图片来源不支持所选参考图编辑。", artifacts)
                        if payload.get("code") == "IMAGE_PROVIDER_UNAVAILABLE" and not current_started:
                            return _result("IMAGE_GENERATION_UNAVAILABLE", "当前图片来源尚未完成工作台接入。", artifacts)
                        if payload.get("code") == "UNSUPPORTED_IMAGE_SIZE" and not current_started:
                            return _result("INVALID_IMAGE_SIZE", "当前图片来源仅支持 1K 方图（1:1），请调整尺寸或选择其他图片来源。",
                                           artifacts, retry_safe=not artifacts)
                        if payload.get("retry_safe") is True and not current_started:
                            return _result("INVALID_IMAGE_SIZE", "图片尺寸或比例不受支持。", artifacts,
                                           retry_safe=not artifacts)
                        return _result("MEDIA_RESULT_UNKNOWN", "图片生成结果暂未确认，请先检查已有结果。", artifacts)
                return json.dumps({"ok": True, "artifacts": artifacts,
                                   "next_step": "图片已保存至当前工作区，可通过现有交付流程提供。"}, ensure_ascii=False)
        except asyncio.CancelledError:
            if invoked:
                return _result("MEDIA_RESULT_UNKNOWN", "图片生成结果暂未确认，请先检查已有结果。", artifacts)
            raise
        except TimeoutError:
            return _result("MEDIA_RESULT_UNKNOWN", "图片生成结果暂未确认，请先检查已有结果。", artifacts)
        except Exception as exc:
            code = getattr(exc, "code", None)
            if code in {"insufficient_balance", "insufficient_credits", "INSUFFICIENT_CREDITS"} and not current_started:
                return _result("INSUFFICIENT_CREDITS", "模型余额不足，请充值后继续。", artifacts)
            if invoked:
                return _result("MEDIA_RESULT_UNKNOWN", "图片生成结果暂未确认，请先检查已有结果。", artifacts)
            return _result("IMAGE_GENERATION_UNAVAILABLE", "图片或当前工作区不可用。", artifacts)
