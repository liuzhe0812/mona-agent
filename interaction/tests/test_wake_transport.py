import asyncio
import json

import pytest
from aiohttp import WSServerHandshakeError
from aiohttp.test_utils import TestClient, TestServer

from mona_interaction.app import create_app
from mona_interaction.asr_settings import ASRModelConfig
from mona_interaction.voice_asr import ASRDependencyError, ASRModelError
from mona_interaction.voice_wake import WakeDependencyError, WakeModelError
from mona_interaction.wake_settings import WakeModelConfig


def origin(client):
    return {"Origin": str(client.make_url("/")).rstrip("/")}


@pytest.mark.asyncio
async def test_wake_requires_exact_origin_and_reports_missing_configuration():
    async with TestClient(TestServer(create_app())) as client:
        for headers in ({}, {"Origin": "https://attacker.example"}):
            with pytest.raises(WSServerHandshakeError) as error:
                await client.ws_connect("/wake", headers=headers)
            assert error.value.status == 403
        async with client.ws_connect("/wake", headers=origin(client)) as ws:
            result = await ws.receive_json()
            assert result["type"] == "error"
            assert result["code"] == "not_configured"


class Detector:
    def __init__(self):
        self.received = []

    def feed(self, data):
        self.received.append(len(data))
        return ["not included in output"] if len(self.received) == 2 else []

    def reset(self):
        self.received.clear()


@pytest.mark.asyncio
async def test_wake_accepts_bounded_pcm_and_only_emits_real_detections():
    detector = Detector()
    async with TestClient(TestServer(create_app(wake_factory=lambda: detector))) as client:
        async with client.ws_connect("/wake", headers=origin(client), compress=15) as ws:
            assert ws.compress == 0  # Browsers offer compression even for PCM.
            assert (await ws.receive_json())["type"] == "ready"
            assert (await ws.receive_json())["code"] == "asr_not_configured"
            async with client.ws_connect("/wake", headers=origin(client)) as contender:
                assert (await contender.receive_json())["code"] == "wake_busy"
            await ws.send_bytes(bytes(640))
            await ws.send_bytes(bytes(640))
            assert await asyncio.wait_for(ws.receive_json(), 2) == {"type": "wake.detected"}
            assert detector.received == [640, 640]
            await ws.send_bytes(bytes(20))
            error = await asyncio.wait_for(ws.receive_json(), 2)
            assert error["code"] == "invalid_audio"


@pytest.mark.asyncio
async def test_wake_limits_pcm_rate_and_surfaces_missing_dependencies(monkeypatch):
    import mona_interaction.wake_transport as transport

    monkeypatch.setattr(transport, "BURST_FRAMES", 2)
    async with TestClient(TestServer(create_app(wake_factory=Detector))) as client:
        async with client.ws_connect("/wake", headers=origin(client)) as ws:
            assert (await ws.receive_json())["type"] == "ready"
            assert (await ws.receive_json())["code"] == "asr_not_configured"
            for _ in range(4):
                await ws.send_bytes(bytes(640))
            assert (await asyncio.wait_for(ws.receive_json(), 2))["type"] == "wake.detected"
            assert (await asyncio.wait_for(ws.receive_json(), 2))["code"] == "audio_rate_exceeded"

    def missing():
        raise WakeDependencyError("private details")

    async with TestClient(TestServer(create_app(wake_factory=missing))) as client:
        async with client.ws_connect("/wake", headers=origin(client)) as ws:
            result = await ws.receive_json()
            assert result["code"] == "dependency_missing"
            assert "private details" not in result["message"]


def test_wake_manifest_uses_only_files_inside_explicit_trusted_root(tmp_path):
    root = tmp_path / "models"
    root.mkdir()
    names = {"tokens": "tokens.txt", "encoder": "encoder.onnx", "decoder": "decoder.onnx",
             "joiner": "joiner.onnx", "keywords_file": "keywords.txt"}
    for name in names.values():
        (root / name).write_bytes(b"fixture")
    manifest = {"version": 1, "asset_root": "models", **names}
    path = tmp_path / "wake.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    assert WakeModelConfig.from_file(path).root == root.resolve()
    (tmp_path / "outside.onnx").write_bytes(b"fixture")
    manifest["encoder"] = "../outside.onnx"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(WakeModelError):
        WakeModelConfig.from_file(path)


class Recognizer:
    def __init__(self):
        self.sizes = []

    def feed(self, data):
        self.sizes.append(len(data))
        index = len(self.sizes)
        return [{"type": "asr.partial" if index % 2 else "asr.final",
                 "segment": (index + 1) // 2, "text": f"text-{index}"}]

    def reset(self):
        self.sizes.clear()


@pytest.mark.asyncio
async def test_wake_continues_recognizing_multiple_sentences_without_new_wake():
    detector, asr = Detector(), Recognizer()
    async with TestClient(TestServer(create_app(wake_factory=lambda: detector, asr_factory=lambda: asr))) as client:
        async with client.ws_connect("/wake", headers=origin(client)) as ws:
            ready = await ws.receive_json()
            assert ready["asr_available"] is True
            await ws.send_bytes(bytes(640))
            await ws.send_bytes(bytes(640))
            wake = await asyncio.wait_for(ws.receive_json(), 2)
            assert asr.sizes == []  # room sound and the wake phrase aren't input
            await ws.send_bytes(bytes(640))
            first = await asyncio.wait_for(ws.receive_json(), 2)
            assert wake["type"] == "wake.detected"
            assert wake["stream_id"] == ready["stream_id"]
            assert first["type"] == "asr.partial"
            assert first["generation"] == wake["generation"]
            assert asr.sizes == [640]
            for _ in range(3):
                await ws.send_bytes(bytes(640))
            events = [await asyncio.wait_for(ws.receive_json(), 2) for _ in range(3)]
            assert [item["type"] for item in events] == ["asr.final", "asr.partial", "asr.final"]
            assert all(item["stream_id"] == ready["stream_id"] and item["generation"] == 1 for item in events)
            assert detector.received == [640, 640]  # no re-wake needed during the conversation
            assert asr.sizes == [640] * 4

            reset = {"type": "wake.rearm", "version": 1, "stream_id": ready["stream_id"], "generation": 1}
            await ws.send_json(reset)
            standby = await asyncio.wait_for(ws.receive_json(), 2)
            assert standby == {"type": "wake.standby", "stream_id": ready["stream_id"], "generation": 1}
            await ws.send_bytes(bytes(640))
            await ws.send_bytes(bytes(640))
            second_wake = await asyncio.wait_for(ws.receive_json(), 2)
            assert second_wake["type"] == "wake.detected" and second_wake["generation"] == 2
            assert asr.sizes == []
            await ws.send_json(reset)  # delayed control cannot put the new conversation to sleep
            await ws.send_bytes(bytes(640))
            again = await asyncio.wait_for(ws.receive_json(), 2)
            assert again["type"] == "asr.partial" and again["generation"] == 2


@pytest.mark.asyncio
async def test_asr_dependency_failure_is_explicit_without_breaking_wake_only():
    def unavailable():
        raise ASRDependencyError("private details")

    async with TestClient(TestServer(create_app(wake_factory=Detector, asr_factory=unavailable))) as client:
        async with client.ws_connect("/wake", headers=origin(client)) as ws:
            assert (await ws.receive_json())["asr_available"] is False
            problem = await ws.receive_json()
            assert problem["code"] == "asr_dependency_missing"
            assert "private details" not in problem["message"]
            await ws.send_bytes(bytes(640))
            await ws.send_bytes(bytes(640))
            assert await asyncio.wait_for(ws.receive_json(), 2) == {"type": "wake.detected"}


@pytest.mark.asyncio
async def test_asr_runtime_failure_is_reported_instead_of_faking_a_final_result():
    class BrokenRecognizer:
        def feed(self, data):
            raise RuntimeError("private failure details")

    async with TestClient(TestServer(create_app(wake_factory=Detector, asr_factory=BrokenRecognizer))) as client:
        async with client.ws_connect("/wake", headers=origin(client)) as ws:
            assert (await ws.receive_json())["asr_available"] is True
            await ws.send_bytes(bytes(640))
            await ws.send_bytes(bytes(640))
            assert (await asyncio.wait_for(ws.receive_json(), 2))["type"] == "wake.detected"
            await ws.send_bytes(bytes(640))
            result = await asyncio.wait_for(ws.receive_json(), 2)
            assert result["type"] == "error"
            assert result["code"] == "asr_failed"
            assert "private failure details" not in result["message"]


def test_asr_manifest_confines_model_paths_to_trusted_root(tmp_path):
    root = tmp_path / "models"
    root.mkdir()
    names = {"tokens": "tokens.txt", "encoder": "encoder.onnx", "decoder": "decoder.onnx", "joiner": "joiner.onnx"}
    for name in names.values():
        (root / name).write_bytes(b"fixture")
    manifest = {"version": 1, "asset_root": "models", **names}
    path = tmp_path / "asr.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    assert ASRModelConfig.from_file(path).root == root.resolve()
    (tmp_path / "outside.onnx").write_bytes(b"fixture")
    manifest["encoder"] = "../outside.onnx"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ASRModelError):
        ASRModelConfig.from_file(path)
