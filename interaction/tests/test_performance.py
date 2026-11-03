import json

import pytest

from mona_interaction.performance import parse_reply

PERFORMANCE = {
    "tone": "gentle",
    "smile": 0,
    "gaze": "user",
    "gesture": {"type": "nod", "strength": 1},
}


def encoded(performance=PERFORMANCE, *, text="你好，世界 🌸"):
    return json.dumps({"text": text, "performance": performance}, ensure_ascii=False)


def test_plain_text_is_preserved_without_guessing_json():
    for text in (
        "你好，世界 🌸", "  原文带空格和换行\n", '请保留 {"text":"里面的内容"} 原文',
        '说明：\n```json\n{"text":"里面的内容"}\n```',
    ):
        assert parse_reply(text) == {"text": text, "performance": None, "performance_status": "missing"}


def test_json_returns_unicode_text_and_normalized_performance():
    result = parse_reply(encoded())
    assert result == {"text": "你好，世界 🌸", "performance": PERFORMANCE, "performance_status": "valid"}
    assert type(result["performance"]["smile"]) is float
    assert type(result["performance"]["gesture"]["strength"]) is float
    midpoint = {**PERFORMANCE, "smile": 0.35, "gesture": {"type": "nod", "strength": 0.6}}
    assert parse_reply(encoded(midpoint))["performance"] == midpoint


def test_complete_json_fence_is_parsed():
    content = f"  ```JSON\r\n{encoded()}\r\n```  \n"
    assert parse_reply(content)["performance_status"] == "valid"
    assert parse_reply(content)["text"] == "你好，世界 🌸"


def test_missing_performance_keeps_json_text():
    assert parse_reply('{"text":"  原文  "}') == {
        "text": "  原文  ", "performance": None, "performance_status": "missing"
    }


def test_missing_or_unknown_performance_fields_are_invalid():
    invalid = [
        None,
        {},
        {key: value for key, value in PERFORMANCE.items() if key != "gaze"},
        {**PERFORMANCE, "extra": 1},
        {**PERFORMANCE, "gesture": {"type": "nod"}},
        {**PERFORMANCE, "gesture": {"type": "nod", "strength": 1, "extra": 1}},
    ]
    for performance in invalid:
        assert parse_reply(encoded(performance)) == {
            "text": "你好，世界 🌸", "performance": None, "performance_status": "invalid"
        }


def test_unknown_enums_and_wrong_types_are_invalid():
    invalid = [
        {**PERFORMANCE, "tone": "happy"},
        {**PERFORMANCE, "tone": []},
        {**PERFORMANCE, "gaze": "up"},
        {**PERFORMANCE, "gesture": {"type": "wave", "strength": 1}},
        {**PERFORMANCE, "gesture": "nod"},
        {**PERFORMANCE, "smile": "0.5"},
    ]
    for performance in invalid:
        result = parse_reply(encoded(performance))
        assert result["text"] == "你好，世界 🌸"
        assert result["performance"] is None
        assert result["performance_status"] == "invalid"


def test_nonfinite_boolean_and_out_of_range_numbers_are_invalid():
    for number in (True, False, -0.01, 1.01, float("nan"), float("inf"), float("-inf")):
        for performance in (
            {**PERFORMANCE, "smile": number},
            {**PERFORMANCE, "gesture": {"type": "nod", "strength": number}},
        ):
            result = parse_reply(encoded(performance))
            assert result["performance"] is None
            assert result["performance_status"] == "invalid"


def test_json_without_valid_text_is_not_shown_as_prose():
    for content in ("{}", '{"text":null}', '{"text":"   "}', '{"text":3}', "[]", '"hello"'):
        with pytest.raises(ValueError):
            parse_reply(content)


def test_reply_text_must_be_nonempty_and_within_limit():
    assert parse_reply("界" * 64_000)["text"] == "界" * 64_000
    for content in ("", "  \n", "界" * 64_001, encoded(text="界" * 64_001)):
        with pytest.raises(ValueError):
            parse_reply(content)


def test_invalid_json_fence_is_not_shown_as_prose():
    with pytest.raises(ValueError):
        parse_reply('```json\n{"text":\n```')
