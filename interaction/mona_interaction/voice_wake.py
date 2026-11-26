"""Local streaming keyword detection; no model acquisition or microphone access."""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Callable


class WakeDependencyError(RuntimeError):
    """A required local keyword-detection dependency is unavailable."""


class WakeModelError(ValueError):
    """A required model file is missing or outside the trusted root."""


@dataclass(frozen=True)
class WakeModelFiles:
    """Model and keyword paths, relative to an explicitly trusted local root."""

    tokens: str | Path
    encoder: str | Path
    decoder: str | Path
    joiner: str | Path
    keywords_file: str | Path


def _model_paths(trusted_root: str | Path, files: WakeModelFiles) -> dict[str, str]:
    try:
        root = Path(trusted_root).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise WakeModelError("唤醒模型目录不存在或无法访问。") from exc
    if not root.is_dir():
        raise WakeModelError("唤醒模型目录无效。")
    result = {}
    for name in ("tokens", "encoder", "decoder", "joiner", "keywords_file"):
        value = getattr(files, name)
        if not isinstance(value, (str, Path)) or not str(value):
            raise WakeModelError(f"唤醒模型文件未配置：{name}。")
        supplied = Path(value).expanduser()
        try:
            resolved = (root / supplied).resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise WakeModelError(f"唤醒模型文件缺失或无法访问：{name}。") from exc
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise WakeModelError(f"唤醒模型文件不在可信目录内：{name}。")
        result[name] = str(resolved)
    return result


class SherpaWakeDetector:
    """Detect configured keywords from continuous 16 kHz, mono, PCM16-LE audio.

    ``trusted_root`` must be supplied by the caller from the unified runtime
    repository or another explicitly trusted local directory. The keyword file
    must use the token format expected by the installed Sherpa model.
    """

    def __init__(self, trusted_root: str | Path, files: WakeModelFiles, *,
                 spotter_factory: Callable | None = None) -> None:
        paths = _model_paths(trusted_root, files)
        try:
            self._numpy = import_module("numpy")
        except (ImportError, OSError) as exc:
            raise WakeDependencyError("语音唤醒不可用：numpy 未安装或无法加载。") from exc
        if spotter_factory is None:
            try:
                spotter_factory = import_module("sherpa_onnx").KeywordSpotter
            except (ImportError, AttributeError, OSError) as exc:
                raise WakeDependencyError("语音唤醒不可用：sherpa-onnx 未安装或无法加载。") from exc
        try:
            self._spotter = spotter_factory(**paths, num_threads=2, provider="cpu")
        except Exception as exc:
            raise WakeModelError("语音唤醒模型无法加载，请检查模型与关键词文件。") from exc
        self._stream = self._spotter.create_stream()
        self._pending = b""

    def feed(self, pcm: bytes | bytearray | memoryview) -> list[str]:
        """Consume PCM bytes and return only keywords actually detected.

        A split 16-bit sample is retained for the next call. A detection resets
        the Sherpa stream as required by its streaming keyword spotter API.
        """
        if not isinstance(pcm, (bytes, bytearray, memoryview)):
            raise TypeError("音频必须是 PCM 字节。")
        data = self._pending + bytes(pcm)
        usable = len(data) - len(data) % 2
        self._pending = data[usable:]
        if not usable:
            return []
        samples = self._numpy.frombuffer(data[:usable], dtype="<i2").astype(self._numpy.float32) / 32768.0
        self._stream.accept_waveform(16000, samples)
        detected = []
        while self._spotter.is_ready(self._stream):
            self._spotter.decode_stream(self._stream)
            keyword = self._spotter.get_result(self._stream)
            if keyword:
                if not isinstance(keyword, str):
                    raise RuntimeError("语音唤醒引擎返回了无效结果。")
                detected.append(keyword)
                self._spotter.reset_stream(self._stream)
        return detected

    def reset(self) -> None:
        """Discard a partial sample and reset detection for a new audio stream."""
        self._pending = b""
        self._spotter.reset_stream(self._stream)
