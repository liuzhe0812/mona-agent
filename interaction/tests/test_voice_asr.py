from pathlib import Path

import numpy as np
import pytest

from mona_interaction import voice_asr
from mona_interaction.voice_asr import (
    ASRDependencyError,
    ASRModelError,
    ASRModelFiles,
    ASRRuntimeError,
    SherpaOnlineASR,
)


@pytest.fixture
def model(tmp_path):
    root = tmp_path / "runtime"
    root.mkdir()
    names = ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx"]
    for name in names:
        (root / name).write_bytes(b"test")
    return root, ASRModelFiles(*names)


class FakeStream:
    def __init__(self):
        self.chunks = []

    def accept_waveform(self, sample_rate, samples):
        self.chunks.append((sample_rate, samples.copy()))


class FakeRecognizer:
    def __init__(self, **options):
        self.options = options
        self.stream = FakeStream()
        self.steps = []
        self.current = ("", False)
        self.resets = 0

    def create_stream(self):
        return self.stream

    def is_ready(self, stream):
        return bool(self.steps)

    def decode_stream(self, stream):
        self.current = self.steps.pop(0)

    def get_result(self, stream):
        return self.current[0]

    def is_endpoint(self, stream):
        return self.current[1]

    def reset(self, stream):
        self.resets += 1
        self.current = ("", False)


def test_streaming_partial_final_and_pcm_conversion(model):
    root, files = model
    asr = SherpaOnlineASR(root, files, recognizer_factory=FakeRecognizer)
    recognizer = asr._recognizer
    assert Path(recognizer.options["encoder"]) == (root / files.encoder).resolve()
    assert recognizer.options["enable_endpoint_detection"] is True
    assert recognizer.options["sample_rate"] == 16000
    assert recognizer.options["provider"] == "cpu"
    assert asr.feed(b"\x00") == []
    recognizer.steps = [("你", False), ("你好", False), ("你好", True)]
    assert asr.feed(b"\x80\xff\x7f\x01") == [
        {"type": "asr.partial", "segment": 1, "text": "你"},
        {"type": "asr.partial", "segment": 1, "text": "你好"},
        {"type": "asr.final", "segment": 1, "text": "你好"},
    ]
    rate, samples = recognizer.stream.chunks[0]
    assert rate == 16000
    np.testing.assert_allclose(samples, [-1.0, 32767 / 32768])
    assert recognizer.resets == 1
    recognizer.steps = [("再见", False)]
    assert asr.feed(b"\x00") == [{"type": "asr.partial", "segment": 2, "text": "再见"}]
    np.testing.assert_allclose(recognizer.stream.chunks[1][1], [1 / 32768])


def test_only_endpoint_emits_final_and_reset_discards_unfinished_input(model):
    root, files = model
    asr = SherpaOnlineASR(root, files, recognizer_factory=FakeRecognizer)
    recognizer = asr._recognizer
    recognizer.steps = [("候选", False), ("候选", False), ("", False), ("", True)]
    assert asr.feed(b"\x00\x00") == [
        {"type": "asr.partial", "segment": 1, "text": "候选"},
        {"type": "asr.partial", "segment": 1, "text": ""},
        {"type": "asr.endpoint", "segment": 1},
    ]
    assert recognizer.resets == 1
    assert asr.feed(b"\xff") == []
    asr.reset()
    recognizer.steps = [("新话语", True)]
    assert asr.feed(b"\x01\x00") == [{"type": "asr.final", "segment": 3, "text": "新话语"}]
    np.testing.assert_allclose(recognizer.stream.chunks[-1][1], [1 / 32768])


def test_endpoint_is_checked_even_when_no_new_decode_is_ready(model):
    root, files = model
    asr = SherpaOnlineASR(root, files, recognizer_factory=FakeRecognizer)
    asr._recognizer.current = ("完成", True)
    assert asr.feed(b"\x00\x00") == [{"type": "asr.final", "segment": 1, "text": "完成"}]


def test_missing_dependency_and_invalid_model_paths_are_explicit(model, tmp_path, monkeypatch):
    root, files = model
    real_import = voice_asr.import_module

    def fake_import(name):
        if name == "sherpa_onnx":
            raise ModuleNotFoundError(name)
        return real_import(name)

    monkeypatch.setattr(voice_asr, "import_module", fake_import)
    with pytest.raises(ASRDependencyError, match="sherpa-onnx"):
        SherpaOnlineASR(root, files)
    outside = tmp_path / "outside.onnx"
    outside.write_bytes(b"test")
    for encoder in ("missing.onnx", "../outside.onnx", outside):
        with pytest.raises(ASRModelError):
            SherpaOnlineASR(root, ASRModelFiles(files.tokens, encoder, files.decoder, files.joiner),
                            recognizer_factory=FakeRecognizer)
    link = root / "escape.onnx"
    try:
        link.symlink_to(outside)
    except OSError:
        return
    with pytest.raises(ASRModelError, match="可信目录"):
        SherpaOnlineASR(root, ASRModelFiles(files.tokens, "escape.onnx", files.decoder, files.joiner),
                        recognizer_factory=FakeRecognizer)


def test_invalid_frames_and_recognizer_failures_are_not_silenced(model):
    root, files = model
    asr = SherpaOnlineASR(root, files, recognizer_factory=FakeRecognizer)
    with pytest.raises(TypeError):
        asr.feed("not audio")
    with pytest.raises(ValueError):
        asr.feed(bytes(64001))
    with pytest.raises(ValueError):
        asr.feed(memoryview(np.zeros(20000, dtype=np.int32)))
    asr._recognizer.steps = [(None, False)]
    with pytest.raises(ASRRuntimeError, match="无效结果"):
        asr.feed(b"\x00\x00")
