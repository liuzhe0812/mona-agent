"""Provider-declared per-model reasoning metadata normalization."""

from __future__ import annotations

import pytest

from mona.providers.reasoning import normalize_reasoning_metadata


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        (
            {
                "reasoning_efforts": ["high", "low", "none"],
                "default_reasoning_effort": "low",
            },
            {"reasoning_efforts": ["high", "low"], "default_reasoning_effort": "low"},
        ),
        (
            {
                "reasoning": {
                    "supportedEfforts": ["minimal", "xhigh"],
                    "defaultEffort": "xhigh",
                }
            },
            {"reasoning_efforts": ["minimal", "xhigh"], "default_reasoning_effort": "xhigh"},
        ),
        (
            {
                "supported_efforts": ["max", "medium"],
                "default_effort": "max",
            },
            {"reasoning_efforts": ["max", "medium"], "default_reasoning_effort": "max"},
        ),
        (
            {
                "effort": {
                    "supported_levels": ["adaptive", "minimum"],
                    "default_level": "minimum",
                }
            },
            {"reasoning_efforts": ["adaptive", "minimum"], "default_reasoning_effort": "minimum"},
        ),
        (
            {
                "capabilities": {
                    "effort": {
                        "supported": True,
                        "levels": {
                            "high": {"supported": True},
                            "max": {"supported": True},
                            "low": {"supported": True},
                            "medium": {"supported": True},
                        },
                        "default_level": "low",
                    },
                    "thinking": {"supported": False},
                }
            },
            {
                "reasoning_efforts": ["low", "medium", "high", "max"],
                "default_reasoning_effort": "low",
            },
        ),
        (
            {"reasoning_efforts": [], "default_reasoning_effort": "high"},
            {"reasoning_efforts": []},
        ),
        (
            {"capabilities": {"thinking": {"supported": False}}},
            {},
        ),
        (
            {"capabilities": {"effort": {"supported": True, "levels": {"low": {"other": True}}}}},
            {},
        ),
        (
            {
                "capabilities": {
                    "thinking": {
                        "types": {"adaptive": {"supported": False}}
                    }
                }
            },
            {"supports_adaptive_thinking": False},
        ),
    ],
)
def test_normalizes_declared_effort_aliases_without_inventing_levels(
    model: dict[str, object], expected: dict[str, object]
) -> None:
    assert normalize_reasoning_metadata(model) == expected


def test_keeps_only_bounded_effort_tokens_and_provider_order() -> None:
    assert normalize_reasoning_metadata(
        {"supported_efforts": ["XHIGH", "low", "a" * 33, 5]}
    ) == {"reasoning_efforts": ["xhigh", "low"]}


@pytest.mark.parametrize(
    "model",
    [
        {"reasoning_efforts": "high"},
        {"reasoning_efforts": ["low", "x" * 33]},
        {"reasoning_efforts": ["low"] * 17},
        {"reasoning_efforts": ["low"], "default_reasoning_effort": "high"},
        {"supportsAdaptiveThinking": "false"},
        {"reasoning": {"supportedEfforts": "low"}},
        {"capabilities": {"effort": {"supported": True, "levels": {}}}},
        {
            "capabilities": {
                "thinking": {"types": {"adaptive": {"supported": "yes"}}}
            }
        },
    ],
)
def test_strict_save_validation_rejects_invalid_declared_metadata(
    model: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        normalize_reasoning_metadata(model, strict=True)
