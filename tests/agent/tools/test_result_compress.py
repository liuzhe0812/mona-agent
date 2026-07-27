"""Tests for mona.agent.tools.result_compress."""

from __future__ import annotations

import json

from mona.agent.tools.result_compress import compress_tool_result


def _pad(text: str, min_chars: int = 2200) -> str:
    """Ensure text exceeds the compression threshold without corrupting prefixes.

    Padding is appended at the end so structural prefixes (e.g. ``[`` for JSON,
    ``<`` for HTML) used by the detector remain at the start.
    """
    if len(text) >= min_chars:
        return text
    return text + "\n" + ("x" * (min_chars - len(text) - 1))


def test_small_result_passthrough():
    """Results under the threshold are returned unchanged (same object)."""
    small = '{"a": 1}'
    assert compress_tool_result(small) is small


def test_never_amplifies():
    """If compression would produce a larger string, the original is returned."""
    # A long single-line JSON object: table rendering would be larger.
    payload = _pad('{"key": "' + "a" * 2200 + '"}')
    result = compress_tool_result(payload)
    assert len(result) <= len(payload)


def test_json_array_becomes_table():
    rows = [{"id": i, "name": f"item-{i}-" + "z" * 20} for i in range(200)]
    text = json.dumps(rows)
    assert len(text) > 2048
    result = compress_tool_result(text, tool_name="some_tool")
    assert "|" in result
    assert "id" in result and "name" in result
    assert "rows omitted" in result
    assert len(result) < len(text)


def test_log_dedup_and_head_tail():
    line = "INFO something happened\n"
    text = _pad(line * 200)
    result = compress_tool_result(text, tool_name="shell")
    assert "×" in result or "lines omitted" in result
    assert len(result) < len(text)


def test_html_strips_tags():
    html = _pad("<html><body><p>hello world</p>" + "<div>x</div>" * 200 + "</body></html>")
    result = compress_tool_result(html, tool_name="email_fetch")
    assert "<html>" not in result.lower()
    assert "<div>" not in result.lower()
    assert "hello world" in result
    assert len(result) < len(html)


def test_html_skips_script_and_style():
    html = _pad(
        "<html><head><style>body{color:red}</style></head>"
        "<body><script>alert(1)</script><p>visible</p></body></html>"
    )
    result = compress_tool_result(html)
    assert "color:red" not in result
    assert "alert(1)" not in result
    assert "visible" in result


def test_cjk_safe():
    """Multi-byte CJK characters are not corrupted."""
    cjk = "你好世界" * 400 + "\n"
    text = _pad(cjk)
    result = compress_tool_result(text)
    # No replacement characters, no broken surrogates.
    assert "\ufffd" not in result
    assert "你好世界" in result


def test_diff_folds_unchanged():
    diff_lines = ["@@ -1,3 +1,3 @@", " context line", " context line", "-old", "+new"]
    diff_lines += [" context" for _ in range(100)]
    text = _pad("\n".join(diff_lines))
    result = compress_tool_result(text)
    assert "unchanged lines" in result
    assert "+new" in result
    assert "-old" in result


def test_tool_name_hint_log():
    """shell tool name routes to log compression even without ANSI."""
    text = _pad("\n".join(f"line {i}" for i in range(200)))
    result = compress_tool_result(text, tool_name="run_shell_command")
    assert "lines omitted" in result or "×" in result


def test_text_fallback_head_tail():
    text = _pad("\n".join(f"line {i}" for i in range(200)))
    result = compress_tool_result(text, tool_name="read_file")
    assert "lines omitted" in result
    assert "line 0" in result
    assert "line 199" in result


def test_invalid_json_falls_back_to_text():
    text = _pad("{not valid json " + "x" * 2200)
    result = compress_tool_result(text, tool_name="imap_fetch")
    # Should not crash; falls back to text compression or passthrough.
    assert isinstance(result, str)
    assert len(result) <= len(text)
