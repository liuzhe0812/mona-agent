"""Local Sherpa streaming speech recognition; never downloads or dispatches input.

The consumer serializes access to each recognizer instance. Partial results are
revisable and must not be dispatched as user requests. A final result is emitted
only when the recognizer reports an endpoint.
"""
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path, PureWindowsPath
from typing import Callable


class ASRDependencyError(RuntimeError):
    """A required local recognition dependency is unavailable."""


class ASRModelError(ValueError):
    """The model is missing, invalid or outside the trusted directory."""


class ASRRuntimeError(RuntimeError):
    """The local recognizer failed to process audio."""


@dataclass(frozen=True)
class ASRModelFiles:
    tokens: str | Path
    encoder: str | Path
    decoder: str | Path
    joiner: str | Path


def _model_paths(trusted_root: str | Path, files: ASRModelFiles) -> dict[str, str]:
    try:
        root = Path(trusted_root).expanduser().resolve(strict=True)
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        raise ASRModelError("语音识别模型目录不存在或无法访问。") from exc
    if not root.is_dir():
        raise ASRModelError("语音识别模型目录无效。")
    result = {}
    for name in ("tokens", "encoder", "decoder", "joiner"):
        value = getattr(files, name)
        if not isinstance(value, (str, Path)) or not str(value):
            raise ASRModelError(f"语音识别模型文件未配置：{name}。")
        supplied = Path(value)
        windows = PureWindowsPath(value)
        if supplied.is_absolute() or windows.is_absolute() or windows.drive:
            raise ASRModelError(f"语音识别模型文件必须使用相对路径：{name}。")
        try:
            resolved = (root / supplied).resolve(strict=True)
        except (OSError, RuntimeError, ValueError) as exc:
            raise ASRModelError(f"语音识别模型文件缺失或无法访问：{name}。") from exc
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise ASRModelError(f"语音识别模型文件不在可信目录内：{name}。")
        result[name] = str(resolved)
    return result


class SherpaOnlineASR:
    """Consume 16 kHz mono PCM16-LE and return partial/final text events.

    The root must be the unified runtime repository or an explicitly trusted
    local directory. Files are provided relative to that directory. Nothing is
    downloaded, persisted or forwarded to an agent by this class.
    """

    MAX_FEED_BYTES = 64_000

    def __init__(self, trusted_root: str | Path, files: ASRModelFiles, *,
                 recognizer_factory: Callable | None = None) -> None:
        if not isinstance(files, ASRModelFiles):
            raise ASRModelError("语音识别模型文件配置无效。")
        paths = _model_paths(trusted_root, files)
        try:
            self._numpy = import_module("numpy")
        except (ImportError, OSError) as exc:
            raise ASRDependencyError("语音识别不可用：numpy 未安装或无法加载。") from exc
        if recognizer_factory is None:
            try:
                recognizer_factory = import_module("sherpa_onnx").OnlineRecognizer.from_transducer
            except (ImportError, AttributeError, OSError) as exc:
                raise ASRDependencyError("语音识别不可用：sherpa-onnx 未安装或无法加载。") from exc
        try:
            self._recognizer = recognizer_factory(
                **paths, num_threads=2, sample_rate=16000, provider="cpu", enable_endpoint_detection=True,
            )
            self._stream = self._recognizer.create_stream()
        except Exception as exc:
            raise ASRModelError("语音识别模型无法加载，请检查模型文件。") from exc
        self._pending = b""
        self._partial = ""
        self._segment = 1

    def feed(self, pcm: bytes | bytearray | memoryview) -> list[dict]:
        if not isinstance(pcm, (bytes, bytearray, memoryview)):
            raise TypeError("音频必须是 PCM 字节。")
        if memoryview(pcm).nbytes > self.MAX_FEED_BYTES:
            raise ValueError("单次音频数据过长。")
        data = self._pending + bytes(pcm)
        usable = len(data) - len(data) % 2
        self._pending = data[usable:]
        if not usable:
            return []
        samples = self._numpy.frombuffer(data[:usable], dtype="<i2").astype(self._numpy.float32) / 32768.0
        events = []
        try:
            self._stream.accept_waveform(16000, samples)
            steps = 0
            while self._recognizer.is_ready(self._stream):
                steps += 1
                if steps > 1024:
                    raise ASRRuntimeError("语音识别处理超出限制。")
                self._recognizer.decode_stream(self._stream)
                self._collect(events)
            if steps == 0:
                self._collect(events)
        except ASRRuntimeError:
            raise
        except Exception as exc:
            raise ASRRuntimeError("语音识别运行失败，请检查语音资源。") from exc
        return events

    def _collect(self, events: list[dict]) -> None:
        text = self._recognizer.get_result(self._stream)
        if not isinstance(text, str):
            raise ASRRuntimeError("语音识别返回了无效结果。")
        if self._recognizer.is_endpoint(self._stream):
            if text.strip():
                events.append({"type": "asr.final", "segment": self._segment, "text": text})
            else:
                if self._partial:
                    events.append({"type": "asr.partial", "segment": self._segment, "text": ""})
                events.append({"type": "asr.endpoint", "segment": self._segment})
            self._recognizer.reset(self._stream)
            self._segment += 1
            self._partial = ""
        elif text != self._partial:
            self._partial = text
            events.append({"type": "asr.partial", "segment": self._segment, "text": text})

    def reset(self) -> None:
        """Discard the unfinished utterance, including any partial PCM sample."""
        try:
            self._recognizer.reset(self._stream)
        except Exception as exc:
            raise ASRRuntimeError("语音识别无法重置。") from exc
        self._pending = b""
        self._partial = ""
        self._segment += 1
