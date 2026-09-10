"""Tool transport normalization must preserve source evidence and protocols."""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from mona.agent.tools.result_compress import compress_tool_result


@pytest.mark.parametrize("tool", ["document", "read_file", "skill_read", "skill_reference_read", "custom_tool"])
def test_source_and_instructions_survive_repeated_normalization(tool):
    source = "<!-- source document -->\n" + "\n".join(
        f"{i}| 原始条目 {i}：<element-id>，坐标 x < 100，值 {i / 100}。" for i in range(400)
    )
    once = compress_tool_result(source, tool_name=tool)
    assert once == source
    assert compress_tool_result(once, tool_name=tool) == source


def test_json_keeps_every_record_nested_field_and_exact_numeric_literal():
    rows = [{"id": i, "value": {"text": '完整内容  \\" <target>\n' + 'x' * 100}} for i in range(120)]
    source = json.dumps(rows, ensure_ascii=False, indent=2).replace('"id": 60', '"id": 1234567890.12345678901234567890')
    compact = compress_tool_result(source, tool_name="office")
    assert len(compact) < len(source)
    assert json.loads(compact, parse_float=Decimal) == json.loads(source, parse_float=Decimal)
    assert "1234567890.12345678901234567890" in compact
    assert compress_tool_result(compact, tool_name="office") == compact


def test_json_source_file_preserves_formatting():
    text = json.dumps({"records": list(range(500))}, indent=4)
    assert compress_tool_result(text, tool_name="read_file") == text


def test_html_and_diff_are_not_reinterpreted_or_summarized():
    html = '<html><style>.x{color:red}</style><script>const x = 1;</script>' + '<p>数据</p>' * 400 + '</html>'
    diff = '@@ -1,400 +1,400 @@\n' + '\n'.join(f' unchanged {i}' for i in range(400)) + '\n-old\n+new'
    assert compress_tool_result(html, tool_name="email_fetch") == html
    assert compress_tool_result(diff, tool_name="some_tool") == diff


def test_terminal_removes_color_codes_without_dropping_middle_lines():
    source = '\n'.join(f'\x1b[31mrecord {i}\x1b[0m' for i in range(200))
    expected = '\n'.join(f'record {i}' for i in range(200))
    assert compress_tool_result(source, tool_name="terminal_exec") == expected
    assert compress_tool_result(expected, tool_name="terminal_exec") == expected


def test_unknown_or_malformed_payloads_remain_exact():
    for text in ['small', '{not json\n' + 'x\n' * 400, '重复\n' * 400]:
        assert compress_tool_result(text, tool_name="custom_tool") == text
