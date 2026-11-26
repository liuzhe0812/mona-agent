from pathlib import Path

import numpy as np
import pytest

from mona_interaction import voice_wake
from mona_interaction.voice_wake import SherpaWakeDetector, WakeDependencyError, WakeModelError, WakeModelFiles


@pytest.fixture
def model(tmp_path):
    root = tmp_path / "runtime"
    root.mkdir()
    names = ["tokens.txt", "encoder.onnx", "decoder.onnx", "joiner.onnx", "keywords.txt"]
    for name in names:
        (root / name).write_bytes(b"test")
    return root, WakeModelFiles(*names)


class FakeStream:
    def __init__(self):
        self.chunks = []

    def accept_waveform(self, sample_rate, samples):
        self.chunks.append((sample_rate, samples.copy()))


class FakeSpotter:
    def __init__(self, **options):
        self.options = options
        self.stream = FakeStream()
        self.results = []
        self.resets = 0

    def create_stream(self):
        return self.stream

    def is_ready(self, stream):
        return bool(self.results)

    def decode_stream(self, stream):
        self.current = self.results.pop(0)

    def get_result(self, stream):
        return self.current

    def reset_stream(self, stream):
        self.resets += 1


def test_continuous_pcm_and_real_detection_events(model):
    root, files = model
    detector = SherpaWakeDetector(root, files, spotter_factory=FakeSpotter)
    spotter = detector._spotter
    assert Path(spotter.options["encoder"]) == (root / files.encoder).resolve()
    assert spotter.options["provider"] == "cpu"

    assert detector.feed(b"\x00") == []
    spotter.results = ["", "你好 Mona", "", "Hey Mona"]
    assert detector.feed(b"\x80\xff\x7f\x01") == ["你好 Mona", "Hey Mona"]
    rate, samples = spotter.stream.chunks[0]
    assert rate == 16000
    np.testing.assert_allclose(samples, [-1.0, 32767 / 32768])
    assert spotter.resets == 2
    assert detector.feed(b"\x00") == []
    np.testing.assert_allclose(spotter.stream.chunks[1][1], [1 / 32768])
    detector.reset()
    assert spotter.resets == 3


def test_rejects_missing_and_outside_model_files(model, tmp_path):
    root, files = model
    with pytest.raises(WakeModelError, match="缺失"):
        SherpaWakeDetector(root, WakeModelFiles("missing", files.encoder, files.decoder, files.joiner,
                                              files.keywords_file), spotter_factory=FakeSpotter)
    outside = tmp_path / "outside.onnx"
    outside.write_bytes(b"test")
    with pytest.raises(WakeModelError, match="可信目录"):
        SherpaWakeDetector(root, WakeModelFiles(files.tokens, outside, files.decoder, files.joiner,
                                              files.keywords_file), spotter_factory=FakeSpotter)
    link = root / "escape.onnx"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symbolic links are unavailable")
    with pytest.raises(WakeModelError, match="可信目录"):
        SherpaWakeDetector(root, WakeModelFiles(files.tokens, link, files.decoder, files.joiner,
                                              files.keywords_file), spotter_factory=FakeSpotter)


def test_missing_sherpa_is_explicit(model, monkeypatch):
    root, files = model
    real_import = voice_wake.import_module

    def fake_import(name):
        if name == "sherpa_onnx":
            raise ModuleNotFoundError(name)
        return real_import(name)

    monkeypatch.setattr(voice_wake, "import_module", fake_import)
    with pytest.raises(WakeDependencyError, match="sherpa-onnx"):
        SherpaWakeDetector(root, files)


def test_reset_discards_partial_sample(model):
    root, files = model
    detector = SherpaWakeDetector(root, files, spotter_factory=FakeSpotter)
    detector.feed(b"\xff")
    detector.reset()
    detector.feed(b"\x01\x00")
    np.testing.assert_allclose(detector._stream.chunks[0][1], [1 / 32768])
    with pytest.raises(TypeError):
        detector.feed("not pcm")
