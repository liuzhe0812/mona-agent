"""Tests for mona/cli/models.py — model info helpers for the onboard wizard.

These tests verify that the stub functions return real data instead of empty
placeholders, restoring the onboard wizard's model autocomplete functionality.
"""

from __future__ import annotations

from mona.cli.models import (
    find_model_info,
    format_token_count,
    get_all_models,
    get_model_context_limit,
    get_model_suggestions,
)


class TestGetAllModels:
    def test_returns_known_models(self) -> None:
        models = get_all_models()
        assert isinstance(models, list)
        assert len(models) > 0

    def test_includes_mainstream_models(self) -> None:
        models = set(get_all_models())
        # 至少包含一些主流模型名（不要求完全匹配，只要存在已知模型即可）
        assert any("claude" in m.lower() or "gpt" in m.lower() or "deepseek" in m.lower() for m in models)


class TestFindModelInfo:
    def test_returns_info_for_known_model(self) -> None:
        models = get_all_models()
        info = find_model_info(models[0])
        assert info is not None
        assert "context_window" in info

    def test_returns_none_for_unknown_model(self) -> None:
        assert find_model_info("nonexistent-model-xyz-12345") is None


class TestGetModelContextLimit:
    def test_returns_int_for_known_model(self) -> None:
        models = get_all_models()
        limit = get_model_context_limit(models[0])
        assert limit is not None
        assert isinstance(limit, int)
        assert limit > 0

    def test_returns_none_for_unknown_model(self) -> None:
        assert get_model_context_limit("nonexistent-model-xyz-12345") is None


class TestGetModelSuggestions:
    def test_returns_matching_models(self) -> None:
        suggestions = get_model_suggestions("claude")
        assert isinstance(suggestions, list)
        # 应该返回至少一个匹配 "claude" 的模型（如果存在）
        if suggestions:
            assert all("claude" in s.lower() for s in suggestions)

    def test_respects_limit(self) -> None:
        suggestions = get_model_suggestions("", limit=5)
        assert len(suggestions) <= 5

    def test_case_insensitive(self) -> None:
        lower = get_model_suggestions("claude")
        upper = get_model_suggestions("CLAUDE")
        assert lower == upper


class TestFormatTokenCount:
    def test_formats_thousands(self) -> None:
        assert format_token_count(200000) == "200,000"

    def test_formats_zero(self) -> None:
        assert format_token_count(0) == "0"

    def test_formats_small_number(self) -> None:
        assert format_token_count(42) == "42"
