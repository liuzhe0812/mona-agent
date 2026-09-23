import json

import pytest

from scripts.verify_development_coding import has_successful_read


@pytest.mark.parametrize("encoded", [True, False])
@pytest.mark.parametrize("absolute", [True, False])
def test_decodes_arguments_before_comparing_path_and_checks_result(tmp_path, encoded, absolute):
    root = tmp_path / "project"
    root.mkdir()
    target = root / ".agents" / "skills" / "check" / "SKILL.md"
    path = str(target) if absolute else ".agents/skills/check/SKILL.md"
    args = {"path": path}
    messages = [{"role": "assistant", "tool_calls": [{"id": "read_one", "function": {
        "name": "read_file", "arguments": json.dumps(args) if encoded else args,
    }}]}, {"role": "tool", "tool_call_id": "read_one", "content": "7| python -m unittest -v"}]
    assert has_successful_read(messages, target, root, "python -m unittest -v")
    assert not has_successful_read(messages[:1], target, root, "python -m unittest -v")
    messages[-1]["content"] = "Error reading file: python -m unittest -v"
    assert not has_successful_read(messages, target, root, "python -m unittest -v")


def test_unrelated_result_or_text_mention_is_not_read_evidence(tmp_path):
    target = tmp_path / "SKILL.md"
    messages = [{"role": "assistant", "content": "I read SKILL.md: python -m unittest -v"},
        {"role": "tool", "tool_call_id": "unrelated", "content": "python -m unittest -v"}]
    assert not has_successful_read(messages, target, tmp_path, "python -m unittest -v")


def test_invalid_json_and_wrong_path_fail_closed(tmp_path):
    target = tmp_path / "SKILL.md"
    for arguments in ("broken JSON", json.dumps({"path": "other/SKILL.md"}), "[]"):
        messages = [{"role": "assistant", "tool_calls": [{"id": "read_one", "function": {
            "name": "read_file", "arguments": arguments,
        }}]}, {"role": "tool", "tool_call_id": "read_one", "content": "python -m unittest -v"}]
        assert not has_successful_read(messages, target, tmp_path, "python -m unittest -v")
