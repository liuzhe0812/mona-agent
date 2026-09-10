"""回归测试：Agent 知识资料的视觉证据提取。"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from mona.materials import vision

_PNG_1X1 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _reading(
    transcription: str = "可读文字",
    description: str = "图中有一张示意图。",
    gaps: list[dict[str, Any]] | None = None,
) -> str:
    return json.dumps(
        {
            "transcription": transcription,
            "description": description,
            "gaps": [] if gaps is None else gaps,
        },
        ensure_ascii=False,
    )


def _gap(detail: str = "图表右侧数值", *, blocking: bool = True) -> dict[str, Any]:
    return {
        "detail": detail,
        "blocking": blocking,
        "reason": "该区域影响图表数值的理解",
    }


class _FakeProvider:
    def __init__(
        self,
        *,
        supports_vision: bool | None = True,
        content: str | None = None,
        responses: dict[str, Any] | None = None,
    ) -> None:
        self._supports_vision = supports_vision
        self._content = content if content is not None else _reading()
        self._responses = responses or {}
        self.chat_calls: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []
        self.retry_calls = 0

    def get_capabilities(self, _model: str) -> SimpleNamespace:
        return SimpleNamespace(supports_vision=self._supports_vision)

    async def chat(self, **kwargs: Any) -> SimpleNamespace:
        self.chat_calls.append(kwargs)
        content = kwargs["messages"][1]["content"]
        request = json.loads(content[1]["text"])
        self.requests.append(request)
        value = self._responses.get(request["location"], self._content)
        if isinstance(value, list):
            if not value:
                raise AssertionError(f"unexpected extra request for {request['location']}")
            value = value.pop(0)
        if isinstance(value, BaseException):
            raise value
        if isinstance(value, tuple):
            finish_reason, response_content = value
        else:
            finish_reason, response_content = "stop", value
        return SimpleNamespace(finish_reason=finish_reason, content=response_content)

    async def chat_with_retry(self, **_kwargs: Any) -> SimpleNamespace:
        self.retry_calls += 1
        raise AssertionError("视觉知识解析不得调用去图重试")


def _patch_provider(monkeypatch: pytest.MonkeyPatch, provider: _FakeProvider) -> None:
    monkeypatch.setattr(vision, "_load_vision_provider", lambda: (provider, "vision-test"))


def _unit(label: str, data: bytes, *, context: str = "") -> vision._VisualUnit:
    return vision._VisualUnit(
        label=label,
        data=data,
        mime="image/png",
        location={"image": label, "visual": True},
        context=context,
    )


@pytest.fixture
def image_file(tmp_path: Path) -> Path:
    path = tmp_path / "diagram.png"
    path.write_bytes(base64.b64decode(_PNG_1X1))
    return path


@pytest.mark.asyncio
async def test_static_image_produces_visual_segment_with_original_image_input(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = _FakeProvider(
        content=_reading("营收 98.2%", "柱状图显示营收增长。"),
    )
    _patch_provider(monkeypatch, provider)

    segments = await vision.extract_visual_segments(image_file)

    assert len(segments) == 1
    assert segments[0].kind == "visual"
    assert segments[0].label == "图片"
    assert segments[0].meta == {"image": "diagram.png", "visual": True}
    assert "98.2%" in segments[0].text
    assert "营收增长" in segments[0].text
    assert len(provider.chat_calls) == 1
    content = provider.chat_calls[0]["messages"][1]["content"]
    assert any(
        block.get("type") == "image_url"
        and block["image_url"]["url"].startswith("data:image/png;base64,")
        for block in content
    )
    assert provider.retry_calls == 0


@pytest.mark.asyncio
async def test_non_blocking_gap_is_preserved_in_visual_segment(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gap = _gap("机箱底部的微小品牌标记", blocking=False)
    provider = _FakeProvider(
        content=_reading("hp", "一台台式电脑、显示器、键盘和鼠标。", [gap]),
    )
    _patch_provider(monkeypatch, provider)

    segments = await vision.extract_visual_segments(image_file)

    assert len(segments) == 1
    assert "台式电脑" in segments[0].text
    assert "机箱底部的微小品牌标记" in segments[0].text
    assert "该区域影响图表数值的理解" in segments[0].text
    assert len(provider.chat_calls) == 1
    assert "previousReading" not in provider.requests[0]


@pytest.mark.asyncio
async def test_blocking_gap_is_reviewed_and_still_fails(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    initial_gap = _gap("图表右侧数字无法辨认")
    reviewed_gap = _gap("图表右侧数字无法辨认")
    provider = _FakeProvider(
        responses={
            "图片": [
                _reading("营收", "柱状图", [initial_gap]),
                _reading("营收", "柱状图", [reviewed_gap]),
            ]
        }
    )
    _patch_provider(monkeypatch, provider)

    with pytest.raises(RuntimeError, match="关键内容无法辨认") as raised:
        await vision.extract_visual_segments(image_file)

    assert "图表右侧数字无法辨认" in str(raised.value)
    assert len(provider.chat_calls) == 2
    assert all(
        any(block.get("type") == "image_url" for block in call["messages"][1]["content"])
        for call in provider.chat_calls
    )
    review_request = provider.requests[1]
    assert review_request["previousReading"]["gaps"][0]["detail"] == "图表右侧数字无法辨认"
    assert "task" in review_request


@pytest.mark.asyncio
async def test_blocking_gap_review_can_demote_gap_and_preserve_it(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    detail = "登录框底部的微小提示文字"
    initial = _gap(detail)
    reviewed = {
        "detail": detail,
        "blocking": False,
        "reason": "该提示文字不影响理解登录界面的用途",
    }
    provider = _FakeProvider(
        responses={
            "图片": [
                _reading("登录", "一个登录界面", [initial]),
                _reading("登录", "一个登录界面", [reviewed]),
            ]
        }
    )
    _patch_provider(monkeypatch, provider)

    segments = await vision.extract_visual_segments(image_file)

    assert len(segments) == 1
    assert detail in segments[0].text
    assert "不影响理解登录界面的用途" in segments[0].text
    assert len(provider.chat_calls) == 2
    assert provider.requests[1]["previousReading"]["gaps"][0]["detail"] == detail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response,expected",
    [
        (("length", _reading()), "被截断"),
        (("stop", "这不是 JSON"), "格式无效"),
        (RuntimeError("vision transport down"), "vision transport down"),
    ],
)
async def test_provider_transport_format_and_truncation_failures(
    image_file: Path,
    monkeypatch: pytest.MonkeyPatch,
    response: Any,
    expected: str,
) -> None:
    provider = _FakeProvider(responses={"图片": response})
    _patch_provider(monkeypatch, provider)

    with pytest.raises(RuntimeError, match=expected):
        await vision.extract_visual_segments(image_file)

    assert len(provider.chat_calls) == 1
    sent_content = provider.chat_calls[0]["messages"][1]["content"]
    assert any(block.get("type") == "image_url" for block in sent_content)
    assert provider.retry_calls == 0


@pytest.mark.asyncio
async def test_multiple_images_cache_successes_and_retry_only_failed_unit(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    units = [
        _unit("文档图片 1（one.png）", b"one", context="第一张图说明"),
        _unit("文档图片 2（two.png）", b"two", context="第二张图说明"),
        _unit("文档图片 3（three.png）", b"three", context="第三张图说明"),
    ]
    monkeypatch.setattr(vision, "_visual_units", lambda _path: units)
    provider = _FakeProvider(
        responses={
            units[0].label: _reading("one", "第一张"),
            units[1].label: [RuntimeError("第二张暂时不可用"), _reading("two", "第二张")],
            units[2].label: _reading("three", "第三张"),
        }
    )
    _patch_provider(monkeypatch, provider)
    cache_dir = image_file.parent / "visual-cache"

    with pytest.raises(RuntimeError, match="第二张暂时不可用"):
        await vision.extract_visual_segments(image_file, cache_dir=cache_dir)

    first_run_locations = [request["location"] for request in provider.requests]
    assert set(first_run_locations) == {unit.label for unit in units}
    failure_file = cache_dir / "failures.json"
    failures = json.loads(failure_file.read_text(encoding="utf-8"))
    assert [item["label"] for item in failures] == [units[1].label]
    cached_successes = [
        path for path in cache_dir.glob("*.json") if path.name != "failures.json"
    ]
    assert len(cached_successes) == 2
    cached_readings = [json.loads(path.read_text(encoding="utf-8")) for path in cached_successes]
    assert {reading["location"]["image"] for reading in cached_readings} == {"文档图片 1（one.png）", "文档图片 3（three.png）"}
    assert all(reading["readerVersion"] == vision._VISUAL_READER_VERSION for reading in cached_readings)
    assert all(reading["model"] == "vision-test" for reading in cached_readings)

    provider.requests.clear()
    segments = await vision.extract_visual_segments(image_file, cache_dir=cache_dir)

    assert {segment.label for segment in segments} == {unit.label for unit in units}
    assert [request["location"] for request in provider.requests] == [units[1].label]
    assert json.loads(failure_file.read_text(encoding="utf-8")) == []


@pytest.mark.asyncio
async def test_cache_key_changes_when_context_or_image_changes(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = _FakeProvider(content=_reading("文字", "描述"))
    _patch_provider(monkeypatch, provider)
    cache_dir = image_file.parent / "visual-cache"
    unit = _unit("图片", b"same-image", context="上下文一")
    monkeypatch.setattr(vision, "_visual_units", lambda _path: [unit])

    await vision.extract_visual_segments(image_file, cache_dir=cache_dir)
    unit = _unit("图片", b"same-image", context="上下文二")
    monkeypatch.setattr(vision, "_visual_units", lambda _path: [unit])
    await vision.extract_visual_segments(image_file, cache_dir=cache_dir)
    unit = _unit("图片", b"changed-image", context="上下文二")
    monkeypatch.setattr(vision, "_visual_units", lambda _path: [unit])
    await vision.extract_visual_segments(image_file, cache_dir=cache_dir)

    assert len(provider.chat_calls) == 3
    assert len([path for path in cache_dir.glob("*.json") if path.name != "failures.json"]) == 3


@pytest.mark.asyncio
async def test_cache_key_changes_when_model_or_reader_version_changes(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = _FakeProvider(content=_reading("文字", "描述"))
    model = "vision-model-a"
    monkeypatch.setattr(vision, "_load_vision_provider", lambda: (provider, model))
    cache_dir = image_file.parent / "visual-cache"
    unit = _unit("图片", b"same-image", context="同一上下文")
    monkeypatch.setattr(vision, "_visual_units", lambda _path: [unit])

    await vision.extract_visual_segments(image_file, cache_dir=cache_dir)
    model = "vision-model-b"
    await vision.extract_visual_segments(image_file, cache_dir=cache_dir)
    monkeypatch.setattr(vision, "_VISUAL_READER_VERSION", vision._VISUAL_READER_VERSION + 1)
    await vision.extract_visual_segments(image_file, cache_dir=cache_dir)

    assert len(provider.chat_calls) == 3
    assert len([path for path in cache_dir.glob("*.json") if path.name != "failures.json"]) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "review,expected",
    [
        (_reading("营收", "柱状图", []), "复核遗漏了识别缺口"),
        (
            json.dumps(
                {
                    "transcription": "营收",
                    "description": "柱状图",
                    "gaps": [{"detail": "图表右侧数字无法辨认", "blocking": True}],
                },
                ensure_ascii=False,
            ),
            "缺口说明不完整",
        ),
    ],
)
async def test_review_rejects_missing_or_invalid_gap(
    image_file: Path,
    monkeypatch: pytest.MonkeyPatch,
    review: str,
    expected: str,
) -> None:
    initial = _reading("营收", "柱状图", [_gap()])
    provider = _FakeProvider(responses={"图片": [initial, review]})
    _patch_provider(monkeypatch, provider)

    with pytest.raises(RuntimeError, match=expected):
        await vision.extract_visual_segments(image_file)

    assert len(provider.chat_calls) == 2
    assert provider.requests[1]["previousReading"]["gaps"][0]["detail"] == "图表右侧数值"


@pytest.mark.asyncio
async def test_vision_unsupported_fails_without_text_fallback(
    image_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = _FakeProvider(supports_vision=False)
    _patch_provider(monkeypatch, provider)

    with pytest.raises(RuntimeError, match="不支持图片识别"):
        await vision.extract_visual_segments(image_file)

    assert provider.chat_calls == []
    assert provider.retry_calls == 0
