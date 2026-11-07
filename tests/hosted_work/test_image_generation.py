"""Hosted image tool isolation; all image providers and sandboxes are local fakes."""

import asyncio
import base64
import hashlib
import io
import json
import os
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from PIL import Image

from mona.agent.tools.image_generation import ImageGenerationTool, ImageGenerationToolConfig
from mona.config.schema import ProviderConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.image_generation import HostedImageGenerationTool, cleanup_image_staging
from mona.providers.image_generation import (
    GeneratedImageResponse,
    ImageGenerationError,
    OpenAIImageGenerationClient,
)

SECRET = "private-provider-key-not-for-output"
ALICE, BOB, RUN, OTHER_RUN = "a" * 64, "b" * 64, "1" * 32, "2" * 32


def png_bytes(color="red"):
    data = io.BytesIO()
    Image.new("RGB", (2, 2), color).save(data, format="PNG")
    return data.getvalue()


@contextmanager
def directory_link(link, target):
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        if os.name != "nt":
            pytest.skip("directory links unavailable")
        import _winapi
        try:
            _winapi.CreateJunction(str(target), str(link))
        except OSError:
            pytest.skip("directory links unavailable")
    try:
        yield
    finally:
        if link.exists() or link.is_symlink():
            if os.name == "nt":
                os.rmdir(link)
            else:
                link.unlink()


class Sandbox:
    def __init__(self, files=None):
        self.files = dict(files or {})
        self.calls = []
        self.corrupt = None

    async def file(self, request):
        self.calls.append(dict(request))
        path, action = request["path"], request["action"]
        if action == "download":
            raw = self.files[path]
            reply = {"path": path, "name": Path(path).name, "size": len(raw),
                     "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}
            if self.corrupt:
                reply.update(self.corrupt)
            return reply
        assert action == "upload"
        raw = base64.b64decode(request["data"], validate=True)
        self.files[path] = raw
        return {"path": path, "name": Path(path).name, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


@pytest.fixture
def state_root():
    # Use a short root so Windows' legacy open() path limit does not hide the
    # behavior under test; the real Hosted service runs on Ubuntu.
    with tempfile.TemporaryDirectory(prefix="mwi-") as path:
        yield Path(path).resolve()


@pytest.fixture
def setup_tool(monkeypatch, state_root):
    calls, observed, events = [], [], []
    behavior = {"raise_at": None, "sleep_at": None, "multiple": False, "mutate_reference_at": None,
                "entered": asyncio.Event(), "second_entered": asyncio.Event()}

    class Provider:
        def __init__(self, **kwargs):
            assert kwargs["api_key"] == SECRET

        async def generate(self, **kwargs):
            calls.append(kwargs)
            behavior["entered"].set()
            index = len(calls) - 1
            if index == 1:
                behavior["second_entered"].set()
            for value in kwargs.get("reference_images") or []:
                path = Path(value)
                observed.append((str(path), path.read_bytes(), path.parent.stat().st_mode))
            if behavior["sleep_at"] == index:
                await asyncio.Event().wait()
            if behavior["raise_at"] == index:
                raise ImageGenerationError(f"private diagnostics {SECRET} /private/host/path", code="result_unknown")
            if behavior["mutate_reference_at"] == index:
                Path(kwargs["reference_images"][0]).write_bytes(png_bytes("blue"))
            url = "data:image/png;base64," + base64.b64encode(png_bytes()).decode()
            return GeneratedImageResponse(images=[url, url] if behavior["multiple"] else [url], content="",
                                          raw={"key": SECRET, "usage": {"input_tokens": 11, "output_tokens": 22}})

    async def wrapper(call, invoke):
        events.append(("reserve", call.index, call.model, call.image_size, call.aspect_ratio, call.operation_id))
        result = await invoke()
        events.append(("settle", call.index))
        return result

    monkeypatch.setattr("mona.agent.tools.image_generation.get_image_gen_provider", lambda _name: Provider)
    config = ImageGenerationToolConfig(enabled=True, provider="openrouter", model="fixture-image", max_images_per_turn=3)

    def create(sandbox, *, call_wrapper=wrapper, timeout=1, operation_id_factory=None, provider_factory=None,
               owner=ALICE, run_id=RUN):
        return HostedImageGenerationTool(sandbox=sandbox, config=config,
            provider_configs={"openrouter": ProviderConfig(api_key=SECRET),
                              "unused": ProviderConfig(api_key="unused-provider-secret")}, call_wrapper=call_wrapper,
            state_dir=state_root, owner=owner, run_id=run_id,
            max_file_bytes=1024 * 1024, workspace_bytes=4 * 1024 * 1024, max_reference_images=4,
            timeout_seconds=timeout, operation_id_factory=operation_id_factory, provider_factory=provider_factory)

    return create, config, calls, observed, events, behavior


@pytest.mark.asyncio
async def test_desktop_schema_and_execution_use_private_workspace_per_account(setup_tool):
    create, config, calls, observed, events, _ = setup_tool
    alice, bob = Sandbox({"uploads/input.png": png_bytes()}), Sandbox()
    tool = create(alice)
    assert tool.parameters == ImageGenerationTool(workspace=".", config=config).parameters
    result = json.loads(await tool.execute("make image", reference_images=["/workspace/uploads/input.png"], count=2))
    assert result["ok"] is True and len(result["artifacts"]) == 2
    assert [event[:2] for event in events] == [("reserve", 0), ("settle", 0), ("reserve", 1), ("settle", 1)]
    assert len(calls) == 2 and all(call["model"] == "fixture-image" for call in calls)
    assert len(observed) == 2 and all(data == png_bytes() for _, data, _ in observed)
    if os.name != "nt":
        assert all(stat.S_IMODE(mode) & 0o077 == 0 for _, _, mode in observed)
    operation_ids = [event[-1] for event in events if event[0] == "reserve"]
    assert len(set(operation_ids)) == 2 and all(len(value) == 32 for value in operation_ids)
    assert all(not Path(path).exists() for path, _, _ in observed)
    assert SECRET not in json.dumps(result) and all(path not in json.dumps(result) for path, _, _ in observed)
    for artifact in result["artifacts"]:
        assert artifact["path"].startswith("/workspace/generated/")
        relative = artifact["path"].removeprefix("/workspace/")
        assert alice.files[relative] == png_bytes() and relative not in bob.files
        assert artifact["sha256"] == hashlib.sha256(png_bytes()).hexdigest()
    denied = json.loads(await create(bob, owner=BOB).execute("edit", reference_images=["/workspace/uploads/input.png"]))
    assert denied["ok"] is False and len(calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("provider,model,count", [
    ("openai", "gpt-image-2", 1), ("openai_codex", "gpt-6.1-sol", 1),
    ("gemini", "imagen-fixture", 1), ("stepfun", "step-image-edit-2", 1),
    ("stepfun", "step-1x-medium", 2), ("mona_managed", "image-fixture", 1),
])
async def test_provider_that_would_ignore_references_is_rejected_before_billing(provider, model, count, state_root):
    calls = []
    async def wrapper(call, invoke):
        calls.append(call)
        return await invoke()
    config = ImageGenerationToolConfig(enabled=True, provider=provider, model=model)
    tool = HostedImageGenerationTool(sandbox=Sandbox({"input.png": png_bytes()}), config=config,
        provider_configs={provider: ProviderConfig(api_key=SECRET)}, call_wrapper=wrapper,
        state_dir=state_root, owner=ALICE, run_id=RUN,
        max_file_bytes=1024 * 1024, workspace_bytes=4 * 1024 * 1024, max_reference_images=4, timeout_seconds=1)
    result = json.loads(await tool.execute("edit", reference_images=["/workspace/input.png"] * count))
    assert result["ok"] is False and result["code"] == "REFERENCE_IMAGE_UNSUPPORTED"
    assert result["retry_safe"] is False and not calls


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai_codex", "mona_managed"])
async def test_default_desktop_account_providers_never_run_on_the_host(provider, state_root):
    calls = []
    async def wrapper(call, invoke):
        calls.append(call)
        return await invoke()
    config = ImageGenerationToolConfig(enabled=True, provider=provider, model="fixture-model")
    tool = HostedImageGenerationTool(sandbox=Sandbox(), config=config,
        provider_configs={provider: ProviderConfig(api_key=SECRET)}, call_wrapper=wrapper,
        state_dir=state_root, owner=ALICE, run_id=RUN,
        max_file_bytes=1024 * 1024, workspace_bytes=4 * 1024 * 1024, max_reference_images=4, timeout_seconds=1)
    result = json.loads(await tool.execute("generate"))
    assert result["ok"] is False and result["code"] == "IMAGE_GENERATION_UNAVAILABLE"
    assert not calls


@pytest.mark.asyncio
async def test_trusted_factory_injects_a_client_into_real_openai_provider(setup_tool):
    create, _, _calls, _, _, _ = setup_tool
    requests, factories, usage = [], [], []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}],
                                         "usage": {"input_tokens": 5, "output_tokens": 7}})
    async def wrapper(_call, invoke):
        response = await invoke()
        usage.append(response.raw["usage"])
        return response
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False) as client:
        def factory(config, providers):
            assert set(providers) == {"openrouter"}
            factories.append((config.model, providers["openrouter"].api_key))
            return OpenAIImageGenerationClient(api_key=providers["openrouter"].api_key,
                                               api_base="https://8.8.8.8/v1", client=client)
        sandbox = Sandbox({"input.png": png_bytes()})
        tool = create(sandbox, call_wrapper=wrapper, provider_factory=factory)
        result = json.loads(await tool.execute("test"))
        rejected = json.loads(await tool.execute("edit", reference_images=["input.png"]))
        assert rejected["code"] == "REFERENCE_IMAGE_UNSUPPORTED" and len(requests) == 1
        assert not client.is_closed
    assert result["ok"] is True and len(requests) == 1 and len(factories) == 2
    assert usage == [{"input_tokens": 5, "output_tokens": 7}]
    assert SECRET not in json.dumps(result) and "unused-provider-secret" not in json.dumps(result)
    assert "usage" not in json.dumps(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["/etc/passwd", "../outside.png", "/workspace/../outside.png",
                                   "C:\\outside.png", "https://example.test/image.png", "data:image/png;base64,AA=="])
async def test_reference_path_never_reaches_host_or_provider(setup_tool, value):
    create, _, calls, _, events, _ = setup_tool
    sandbox = Sandbox()
    result = json.loads(await create(sandbox).execute("test", reference_images=[value]))
    assert result["ok"] is False
    assert not calls and not events and not sandbox.calls
    assert value not in json.dumps(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("corruption", [{"size": 1}, {"sha256": "0" * 64}, {"data": "***"},
                                        {"path": "another-account.png"}])
async def test_reference_requires_bounded_matching_bytes_and_digest(setup_tool, corruption):
    create, _, calls, _, events, _ = setup_tool
    sandbox = Sandbox({"input.png": png_bytes()})
    sandbox.corrupt = corruption
    result = json.loads(await create(sandbox).execute("test", reference_images=["/workspace/input.png"]))
    assert result["ok"] is False and not calls and not events


@pytest.mark.asyncio
async def test_timeout_keeps_completed_image_and_never_retries(setup_tool):
    create, _, calls, observed, events, behavior = setup_tool
    behavior["sleep_at"] = 1
    sandbox = Sandbox({"input.png": png_bytes()})
    result = json.loads(await create(sandbox, timeout=0.05).execute("test", reference_images=["input.png"], count=2))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert result["retry_safe"] is False and len(result["artifacts"]) == 1
    assert len(calls) == 2 and [event[:2] for event in events] == [("reserve", 0), ("settle", 0), ("reserve", 1)]
    assert result["artifacts"][0]["path"].removeprefix("/workspace/") in sandbox.files
    assert all(not Path(path).exists() for path, _, _ in observed)


@pytest.mark.asyncio
async def test_active_staging_has_no_prompt_sidecar_or_reference_paths(setup_tool, state_root):
    create, _, _calls, observed, _, behavior = setup_tool
    behavior["sleep_at"] = 1
    prompt = "sensitive private prompt"
    task = asyncio.create_task(create(Sandbox({"input.png": png_bytes()}), timeout=5).execute(
        prompt, reference_images=["/workspace/input.png"], count=2))
    run_root = state_root / "users" / ALICE / "image-staging" / RUN
    try:
        await asyncio.wait_for(behavior["second_entered"].wait(), 2)
        staged = list(run_root.glob("call-*"))
        assert len(staged) == 1 and all(Path(path).is_relative_to(staged[0]) for path, _, _ in observed)
        files = [path for path in staged[0].rglob("*") if path.is_file()]
        assert files and not any(path.suffix == ".json" for path in files)
        assert all(prompt not in str(path) and prompt.replace(" ", "-") not in str(path) for path in files)
        assert all(prompt.encode() not in path.read_bytes() for path in files)
    finally:
        task.cancel()
        result = json.loads(await task)
        assert result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert not list(run_root.glob("call-*"))


def test_crash_staging_cleanup_is_exact_and_requires_stopped_executor(state_root):
    def orphan(owner, run_id):
        path = state_root / "users" / owner / "image-staging" / run_id / "call-crashed" / "references"
        path.mkdir(parents=True)
        (path / "image.png").write_bytes(png_bytes())
        return path

    alice = orphan(ALICE, RUN)
    alice_other = orphan(ALICE, OTHER_RUN)
    bob = orphan(BOB, RUN)
    with pytest.raises(ValueError):
        cleanup_image_staging(state_root, ALICE, RUN)
    assert alice.exists() and alice_other.exists() and bob.exists()
    assert cleanup_image_staging(state_root, ALICE, RUN, executor_stopped=True) is True
    assert not alice.exists() and alice_other.exists() and bob.exists()
    assert cleanup_image_staging(state_root, ALICE, RUN, executor_stopped=True) is False
    with pytest.raises(ValueError):
        cleanup_image_staging(state_root, "../" + BOB, RUN, executor_stopped=True)
    with pytest.raises(WorkError):
        cleanup_image_staging(state_root, ALICE, "../" + OTHER_RUN, executor_stopped=True)
    assert alice_other.exists() and bob.exists()


@pytest.mark.parametrize("root_link", [False, True])
def test_staging_cleanup_refuses_links_into_another_account(state_root, root_link):
    bob = state_root / "users" / BOB / "image-staging" / RUN
    bob.mkdir(parents=True)
    (bob / "keep.png").write_bytes(png_bytes())
    alice_parent = state_root / "users" / ALICE / "image-staging"
    alice_parent.mkdir(parents=True)
    alice = alice_parent / RUN
    if not root_link:
        alice.mkdir()
    with directory_link(alice if root_link else alice / "link", bob):
        with pytest.raises(ValueError):
            cleanup_image_staging(state_root, ALICE, RUN, executor_stopped=True)
        assert (bob / "keep.png").read_bytes() == png_bytes()


@pytest.mark.asyncio
async def test_staging_creation_refuses_a_linked_owner(setup_tool, state_root):
    create, _, calls, _, events, _ = setup_tool
    users = state_root / "users"
    users.mkdir()
    bob = users / BOB
    bob.mkdir()
    (bob / "keep.txt").write_text("keep", encoding="utf-8")
    with directory_link(users / ALICE, bob):
        result = json.loads(await create(Sandbox()).execute("test"))
        assert result["ok"] is False and not calls and not events
        assert (bob / "keep.txt").read_text(encoding="utf-8") == "keep"


@pytest.mark.asyncio
async def test_cancelled_inflight_request_notifies_wrapper_and_returns_unknown(setup_tool):
    create, _, calls, _, _, behavior = setup_tool
    behavior["sleep_at"] = 0
    cancelled = []
    async def wrapper(call, invoke):
        try:
            return await invoke()
        except asyncio.CancelledError:
            cancelled.append(call.operation_id)
            raise
    task = asyncio.create_task(create(Sandbox(), call_wrapper=wrapper).execute("test"))
    await asyncio.wait_for(behavior["entered"].wait(), 1)
    task.cancel()
    result = json.loads(await task)
    assert result["code"] == "MEDIA_RESULT_UNKNOWN" and result["retry_safe"] is False
    assert len(calls) == len(cancelled) == 1


@pytest.mark.asyncio
async def test_timeout_reading_reference_does_not_dispatch_or_retry(setup_tool):
    create, _, calls, _, events, _ = setup_tool
    class SlowSandbox(Sandbox):
        async def file(self, _request):
            await asyncio.Event().wait()
    result = json.loads(await create(SlowSandbox(), timeout=0.05).execute("test", reference_images=["input.png"]))
    assert result["code"] == "MEDIA_RESULT_UNKNOWN" and result["retry_safe"] is False
    assert not calls and not events


@pytest.mark.asyncio
async def test_failure_after_provider_reply_retains_image_without_claiming_success(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    async def uncertain(_call, invoke):
        await invoke()
        raise RuntimeError(f"settlement secret {SECRET}")
    sandbox = Sandbox()
    result = json.loads(await create(sandbox, call_wrapper=uncertain).execute("test"))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert len(result["artifacts"]) == 1 and len(calls) == 1
    assert SECRET not in json.dumps(result)


@pytest.mark.asyncio
async def test_settlement_timeout_after_image_keeps_result_unknown(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    cancellation = []
    async def waiting_settlement(call, invoke):
        response = await invoke()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancellation.append(call.operation_id)
            raise
        return response
    sandbox = Sandbox()
    result = json.loads(await create(sandbox, call_wrapper=waiting_settlement, timeout=0.05).execute("test"))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert result["retry_safe"] is False and len(result["artifacts"]) == 1
    assert len(calls) == len(cancellation) == 1


@pytest.mark.asyncio
async def test_trusted_wrapper_receives_stable_id_and_raw_usage_without_exposing_them(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    records = []
    async def bill(call, invoke):
        response = await invoke()
        records.append((call.operation_id, response.raw["usage"]))
        return response
    identifiers = ["a" * 32, "b" * 32]
    result = json.loads(await create(Sandbox(), call_wrapper=bill,
                                     operation_id_factory=lambda index: identifiers[index]).execute("test", count=2))
    assert result["ok"] is True and len(calls) == 2
    assert records == [(identifiers[0], {"input_tokens": 11, "output_tokens": 22}),
                       (identifiers[1], {"input_tokens": 11, "output_tokens": 22})]
    assert "usage" not in json.dumps(result) and SECRET not in json.dumps(result)
    assert all(identifier not in json.dumps(result) for identifier in identifiers)


@pytest.mark.asyncio
async def test_request_fingerprint_uses_real_parameters_and_verified_reference_bytes(setup_tool):
    create, config, _, _, _, _ = setup_tool
    sandbox = Sandbox({"first.png": png_bytes(), "same.png": png_bytes(), "blue.png": png_bytes("blue")})
    calls = []
    async def capture(call, invoke):
        calls.append(call)
        return await invoke()

    async def generate(prompt, references, **options):
        result = json.loads(await create(sandbox, call_wrapper=capture,
                                        operation_id_factory=lambda _index: "a" * 32).execute(
                                            prompt, reference_images=references, **options))
        assert result["ok"] is True
        fingerprint = calls[-1].request_fingerprint
        assert calls[-1].operation_id == "a" * 32
        assert len(fingerprint) == 64 and all(char in "0123456789abcdef" for char in fingerprint)
        rendered = json.dumps(result, ensure_ascii=False)
        assert fingerprint not in rendered and fingerprint not in repr(calls[-1])
        assert prompt not in rendered
        assert prompt.replace(" ", "-") not in rendered
        assert all(reference not in rendered for reference in references)
        return fingerprint

    baseline = await generate("private image brief", ["first.png"])
    assert await generate("private image brief", ["same.png"]) == baseline
    assert await generate("private image brief", ["first.png"], image_size="1k", aspect_ratio="1:1") == baseline
    assert await generate("different image brief", ["first.png"]) != baseline
    assert await generate("private image brief", ["blue.png"]) != baseline
    assert await generate("private image brief", ["first.png"], image_size="2K") != baseline
    assert await generate("private image brief", ["first.png"], aspect_ratio="16:9") != baseline
    first_order = await generate("private image brief", ["first.png", "blue.png"])
    assert await generate("private image brief", ["blue.png", "first.png"]) != first_order
    config.model = "different-image-model"
    assert await generate("private image brief", ["first.png"]) != baseline


@pytest.mark.asyncio
async def test_wrapper_exception_never_exposes_fingerprint_or_prompt(setup_tool):
    create, _, _, _, _, _ = setup_tool
    fingerprints = []
    async def reject(call, _invoke):
        fingerprints.append(call.request_fingerprint)
        raise RuntimeError("private prompt and fingerprint " + call.request_fingerprint)
    result = await create(Sandbox(), call_wrapper=reject).execute("private prompt")
    assert json.loads(result)["ok"] is False
    assert "private prompt" not in result and fingerprints[0] not in result


@pytest.mark.asyncio
async def test_changed_staged_reference_is_not_sent_under_the_old_fingerprint(setup_tool):
    create, _, calls, _, _, behavior = setup_tool
    behavior["mutate_reference_at"] = 0
    result = json.loads(await create(Sandbox({"input.png": png_bytes()})).execute(
        "test", reference_images=["input.png"], count=2))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert len(calls) == 1 and len(result["artifacts"]) == 1


@pytest.mark.asyncio
async def test_invalid_or_reused_operation_id_cannot_dispatch_a_second_image(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    result = json.loads(await create(Sandbox(), operation_id_factory=lambda _index: "a" * 32).execute("test", count=2))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert len(result["artifacts"]) == 1 and len(calls) == 1


@pytest.mark.asyncio
async def test_second_image_insufficient_balance_preserves_first_without_dispatching_second(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    async def reject_second(call, invoke):
        if call.index == 1:
            raise ImageGenerationError("private balance detail", code="insufficient_credits")
        return await invoke()
    result = json.loads(await create(Sandbox(), call_wrapper=reject_second).execute("test", count=2))
    assert result["ok"] is False and result["code"] == "INSUFFICIENT_CREDITS"
    assert len(result["artifacts"]) == 1 and len(calls) == 1


@pytest.mark.asyncio
async def test_wrapper_cannot_repeat_an_upstream_request(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    async def duplicate(_call, invoke):
        await invoke()
        return await invoke()
    result = json.loads(await create(Sandbox(), call_wrapper=duplicate).execute("test"))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert len(calls) == 1 and len(result["artifacts"]) == 1


@pytest.mark.asyncio
async def test_provider_error_is_sanitized_and_never_resubmitted(setup_tool):
    create, _, calls, _, _, behavior = setup_tool
    behavior["raise_at"] = 0
    result = json.loads(await create(Sandbox()).execute("test"))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert result["retry_safe"] is False and len(calls) == 1
    assert SECRET not in json.dumps(result) and "/private/host/path" not in json.dumps(result)


@pytest.mark.asyncio
async def test_multiple_images_from_one_provider_call_are_not_claimed_as_verified(setup_tool):
    create, _, calls, _, _, behavior = setup_tool
    behavior["multiple"] = True
    result = json.loads(await create(Sandbox()).execute("test"))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert result["artifacts"] == [] and len(calls) == 1


@pytest.mark.asyncio
async def test_wrapper_cannot_fabricate_a_success_without_a_provider_call(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    async def fabricate(_call, _invoke):
        return GeneratedImageResponse(images=["data:image/png;base64,AA=="], content="", raw={})
    result = json.loads(await create(Sandbox(), call_wrapper=fabricate).execute("test"))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert not calls and result["artifacts"] == []


@pytest.mark.asyncio
async def test_unverified_workspace_write_is_unknown_and_never_retried(setup_tool):
    create, _, calls, _, _, _ = setup_tool
    class BadUpload(Sandbox):
        async def file(self, request):
            result = await super().file(request)
            if request["action"] == "upload":
                result["sha256"] = "0" * 64
            return result
    result = json.loads(await create(BadUpload()).execute("test"))
    assert result["ok"] is False and result["code"] == "MEDIA_RESULT_UNKNOWN"
    assert result["artifacts"] == [] and len(calls) == 1


@pytest.mark.asyncio
async def test_invalid_output_size_is_rejected_before_dispatch(setup_tool):
    create, _, calls, _, events, _ = setup_tool
    result = json.loads(await create(Sandbox()).execute("test", image_size="bad-size"))
    assert result["ok"] is False and result["code"] == "INVALID_IMAGE_SIZE" and result["retry_safe"] is True
    assert not calls and not events


def test_wrapper_is_required(setup_tool):
    create, *_ = setup_tool
    with pytest.raises(ValueError):
        create(Sandbox(), call_wrapper=None)
