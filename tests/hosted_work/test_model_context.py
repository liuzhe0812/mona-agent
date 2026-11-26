"""The hosted runtime and UI use the desktop catalog, never a private desktop profile."""
import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.model_access import model_context_window
from mona.hosted_work.turn import run_turn
from tests.hosted_work.test_runner import ModelBoundary, SandboxBoundary


def config(**settings):
    return HostedWorkConfig(models={"qwen": {"label": "Qwen3.7 Plus", "model": "qwen3.7-plus",
        "api_base": "https://coding.dashscope.aliyuncs.com/v1", **settings}})


def test_actual_platform_model_uses_the_shared_catalog_without_private_config(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Hosted model metadata must not load a private desktop configuration")
    monkeypatch.setattr("mona.config.loader.load_config", forbidden)
    selection = config().models["qwen"]
    window = model_context_window(selection)
    assert selection.context_window_tokens is None
    assert (window.tokens, window.source) == (983_616, "catalog")
    selection.api_base = "https://unlisted.example.invalid/v1"
    assert model_context_window(selection).source == "reference"
    assert not model_context_window(selection).verified


@pytest.mark.asyncio
async def test_request_larger_than_old_32k_cap_reaches_the_existing_runner():
    model, sandbox = ModelBoundary(), SandboxBoundary()
    async def emit(*_args):
        pass
    result = await run_turn(config(), {"model_id": "qwen", "run_id": "c" * 32,
        "history": [{"role": "user", "content": "mona context " * 20000}]}, sandbox, model, emit)
    assert result["status"] == "completed" and len(model.requests) == 3 and len(sandbox.calls) == 1
    assert result["diagnostic"]["context_window_tokens"] == 983_616
    assert result["diagnostic"]["context_window_source"] == "catalog"


@pytest.mark.asyncio
async def test_explicit_operator_input_cap_is_still_enforced_without_replaying_tools():
    model = ModelBoundary()
    async def emit(*_args):
        pass
    result = await run_turn(config(context_window_tokens=4096), {"model_id": "qwen", "run_id": "d" * 32,
        "history": [{"role": "user", "content": "mona context " * 20000}]}, SandboxBoundary(), model, emit)
    assert result["status"] == "failed" and result["diagnostic"]["stop_reason"] == "context_limit"
    assert model.requests == []
