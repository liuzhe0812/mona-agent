import pytest

from mona.providers.context_window import context_window_from_error


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            "400 prompt is too long: 1055895 tokens > 1048576 maximum",
            1_048_576,
        ),
        ("prompt is too long: 250000 tokens > 200000 maximum", 200_000),
        ("maximum context length is 1,048,576 tokens", 1_048_576),
        ("maximum context length is 1_048_576 tokens", 1_048_576),
        ("This model's maximum context length is 200000 tokens", 200_000),
        ("prompt is too long", None),
        ("prompt is too long: 1055895 tokens", None),
        ("429 Too many tokens: 1055895 requested", None),
        ("429 rate limit exceeded; retry after 30 seconds", None),
    ],
)
def test_context_window_from_error_extracts_only_declared_context_ceiling(
    error: str,
    expected: int | None,
) -> None:
    assert context_window_from_error(error) == expected
