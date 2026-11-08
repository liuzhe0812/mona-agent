"""Synthetic-only parent image coordination; no provider or wallet network."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import socket
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from loguru import logger
from PIL import Image

from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.billing import BillingError
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.image_control import ImageControl
from mona.hosted_work.image_coordinator import ImageCoordinator
from mona.hosted_work.image_generation import _request_fingerprint
from mona.hosted_work.previews import QuestionPreviews
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tenant_files import TenantFiles
from mona.providers.image_generation import (
    GeneratedImageResponse,
    ImageGenerationError,
    OpenAIImageGenerationClient,
)

OWNER, OTHER = "a" * 64, "b" * 64
SESSION, RUN, OP = "1" * 32, "2" * 32, "3" * 32
MODEL, PROMPT = "gpt-image-1", "synthetic prompt must not persist"
USAGE = {"input_tokens": 10, "input_tokens_details": {"text_tokens": 8, "image_tokens": 2},
         "output_tokens": 5, "total_tokens": 15}


class BillingDouble:
    def __init__(self):
        self.events = []
        self.verify_persisted = None
        self.lose_settle_reply = False
        self.debits = 0

    async def reserve_image(self, operation, _token, settings):
        self.events.append("reserve")
        return {"run_id": operation, "status": "reserved", "reserved_units": 4}

    async def dispatch(self, operation):
        self.events.append("dispatch")
        return {"run_id": operation, "status": "running"}

    async def settle_image(self, operation, _settings, _usage):
        assert self.verify_persisted()
        self.events.append("settle")
        self.debits += 1
        if self.lose_settle_reply:
            self.lose_settle_reply = False
            raise BillingError("billing_unknown", "synthetic lost reply", 503)
        return {"run_id": operation, "status": "settled", "actual_units": 4}

    async def uncertain(self, operation, reason):
        self.events.append(("uncertain", reason))
        return {"run_id": operation, "status": "uncertain"}

    async def release_not_started(self, operation):
        self.events.append("release_not_started")
        return {"run_id": operation, "status": "released", "reserved_units": 4, "actual_units": None}


class ProviderDouble:
    def __init__(self, raw, usage=USAGE):
        self.raw, self.usage, self.calls = raw, usage, 0
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        self.release.set()
        self.failure = None

    async def generate(self, **_kwargs):
        self.calls += 1
        self.entered.set()
        await self.release.wait()
        if self.failure:
            raise self.failure
        return GeneratedImageResponse(images=["data:image/png;base64," + base64.b64encode(self.raw).decode()],
                                      content="", raw={} if self.usage is None else {"usage": self.usage})


class WireDouble:
    def __init__(self):
        self.events = []
        self.fail = False
        self._peers = []

    def add_peer(self, owner, session, token):
        wire = self

        class Socket:
            closed = False

            async def send_str(self, payload):
                wire.events.append((owner, session, json.loads(payload)))

        self._peers.append(SimpleNamespace(owner=owner, chats={session}, token=token, socket=Socket()))

    async def _identity(self, token, owner):
        if self.fail:
            raise WorkError("login_required", "synthetic logout", 401)
        assert token and owner


@pytest.fixture
def env(tmp_path, monkeypatch):
    root = tmp_path / "hosted"
    if os.name == "nt":
        root = Path("\\\\?\\" + str(root))
    root.mkdir()
    config = HostedWorkConfig(state_dir=str(root), auth_origin="https://auth.example.invalid",
                              public_origin="https://work.example.invalid", max_file_bytes=1024 * 1024)
    store = WorkStore(root / "work.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SESSION))
    store.create_session(OTHER, NewSession(request_id=SESSION))
    store.create_run(OWNER, SESSION, NewTurn(request_id=RUN, model_id="synthetic", text="fixture"))
    files = TenantFiles(config, store.session)
    state = DesktopStore(SimpleNamespace(config=config, store=store), files)
    previews = QuestionPreviews(config, state, files)
    wire = WireDouble()
    wire.add_peer(OWNER, SESSION, "synthetic-website-token")
    desktop = SimpleNamespace(state=state, previews=previews, wire=wire,
        history_media=lambda _owner, _token, _sid, paths: [{"kind": "image", "url": "synthetic-ticket", "name": "image.png"}
                                                           for _path in paths])
    billing = BillingDouble()
    control = ImageControl(config, store, billing_factory=lambda _config: billing)
    settings = HostedWorkImageSettings(enabled=True, model=MODEL, billing_mode="wallet",
                                       price=HostedWorkImagePrice(amount_per_image="0.000004"))
    capability = control.bind(OWNER, SESSION, RUN, settings, "synthetic-website-token")
    monkeypatch.setenv("MONA_WORK_MODEL_IMAGE_TEST", "synthetic-image-key")
    output = BytesIO()
    Image.new("RGB", (3, 2), (40, 80, 120)).save(output, format="PNG")
    provider = ProviderDouble(output.getvalue())
    def factory(_config, _settings):
        return provider
    coordinator = ImageCoordinator(config, control, desktop, provider_factory=factory)
    def verify_persisted():
        records = state.records(OWNER, SESSION)
        journal = control.journal.get(OWNER, OP)
        return (any(record.get("event") == "deliver_files" for record, _ in records)
                and bool(state.get(OWNER, previews._request_key(SESSION, RUN, OP, generated=True)))
                and journal["stage"] == "settling" and journal["image_result"]["image_count"] == 1
                and not wire.events)
    billing.verify_persisted = verify_persisted
    context = SimpleNamespace(config=config, store=store, files=files, state=state, previews=previews,
                              wire=wire, desktop=desktop, billing=billing, control=control, settings=settings,
                              capability=capability, provider=provider, coordinator=coordinator, factory=factory)
    yield context
    state.close()
    store.close()


def fingerprint(prompt=PROMPT):
    return _request_fingerprint(prompt, MODEL, "1K", "1:1", ())


async def prepare(env):
    await env.control.begin(OWNER, SESSION, RUN, env.capability, OP, fingerprint())
    await env.control.dispatch(OWNER, SESSION, RUN, env.capability, OP)


@pytest.mark.asyncio
async def test_provider_auth_failure_before_request_releases_reservation(env):
    await prepare(env)
    class NotStarted:
        request_started = False
        async def generate(self, **_kwargs):
            raise ImageGenerationError("synthetic missing auth")
    env.coordinator.provider_factory = lambda *_: NotStarted()
    result = await request(env)
    assert result == {"status": "uncertain"}
    assert env.control.journal.get(OWNER, OP)["stage"] == "released"
    assert env.billing.events == ["reserve", "dispatch", "release_not_started"]
    assert env.billing.debits == 0


def request(env, *, prompt=PROMPT, model=MODEL, reference_images=None):
    return env.coordinator.generate(OWNER, SESSION, RUN, env.capability, OP, fingerprint=fingerprint(prompt),
                                    model=model, prompt=prompt, aspect_ratio="1:1", image_size="1K",
                                    reference_images=reference_images)


@pytest.mark.asyncio
async def test_concurrent_calls_and_disconnected_waiter_never_duplicate_provider_or_charge(env):
    await prepare(env)
    env.provider.release.clear()
    first = asyncio.create_task(request(env))
    await asyncio.wait_for(env.provider.entered.wait(), 3)
    assert env.coordinator.active(OWNER, RUN, OP) and env.coordinator.active_run(OWNER, RUN)
    second = asyncio.create_task(request(env))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    draining = asyncio.create_task(env.coordinator.wait_run(OWNER, RUN))
    await asyncio.sleep(0)
    assert not draining.done()
    env.provider.release.set()
    result = await asyncio.wait_for(second, 3)
    await asyncio.wait_for(draining, 3)
    assert not env.coordinator.active(OWNER, RUN, OP) and not env.coordinator.active_run(OWNER, RUN)
    assert result["status"] == "settled" and env.provider.calls == 1
    assert base64.b64decode(result["image"]["data"]) == env.provider.raw
    assert set(result) == {"status", "image"} and "usage" not in result["image"]
    assert env.billing.events == ["reserve", "dispatch", "settle"]
    assert env.control.journal.get(OWNER, OP)["stage"] == "settled"
    assert await request(env) == result and env.provider.calls == 1
    replacement = ImageCoordinator(env.config, env.control, env.desktop, provider_factory=env.factory)
    env.coordinator = replacement
    assert await request(env) == result and env.provider.calls == 1
    saved = json.dumps([record for record, _ in env.state.records(OWNER, SESSION)], ensure_ascii=False)
    metadata = json.dumps([dict(row) for row in env.state.db(OWNER).execute("SELECT * FROM metadata")])
    for sensitive in (PROMPT, "synthetic-image-key", "synthetic-website-token", result["image"]["data"]):
        assert sensitive not in saved + metadata
    assert len(env.wire.events) == 1


@pytest.mark.asyncio
async def test_invalid_identity_fingerprint_model_and_references_never_dispatch(env):
    await prepare(env)
    with pytest.raises(WorkError):
        await env.coordinator.generate(OTHER, SESSION, RUN, env.capability, OP, fingerprint=fingerprint(),
                                       model=MODEL, prompt=PROMPT, aspect_ratio="1:1", image_size="1K")
    for kwargs in ({"prompt": "changed"}, {"model": "different-model"}, {"reference_images": ["/workspace/a.png"]}):
        with pytest.raises(WorkError):
            await request(env, **kwargs)
    assert env.provider.calls == 0


@pytest.mark.asyncio
async def test_stop_after_claim_and_before_provider_prevents_dispatch(env, monkeypatch):
    await prepare(env)
    original = env.coordinator._claim
    def stop_after_claim(*args):
        result = original(*args)
        env.store.db.execute("UPDATE runs SET status='cancelled' WHERE owner=? AND id=?", (OWNER, RUN))
        return result
    monkeypatch.setattr(env.coordinator, "_claim", stop_after_claim)
    assert await request(env) == {"status": "uncertain"}
    assert env.provider.calls == 0 and env.control.journal.get(OWNER, OP)["stage"] == "released"
    assert env.billing.events == ["reserve", "dispatch", "release_not_started"]


@pytest.mark.asyncio
async def test_explicit_stop_cancels_only_matching_upstream_request_and_keeps_uncertain_charge(env):
    await prepare(env)
    env.provider.release.clear()
    env.provider.request_started = True
    closed = asyncio.Event()

    async def close():
        closed.set()

    env.provider.aclose = close
    pending = asyncio.create_task(request(env))
    await asyncio.wait_for(env.provider.entered.wait(), 3)
    env.coordinator.cancel_run(OTHER, RUN)
    await asyncio.sleep(0)
    assert not pending.done() and env.coordinator.active(OWNER, RUN, OP)
    env.coordinator.cancel_run(OWNER, RUN)
    env.coordinator.cancel_run(OWNER, RUN)  # Repeated stop does not cancel reconciliation twice.
    with pytest.raises(asyncio.CancelledError):
        await pending
    await env.coordinator.wait_run(OWNER, RUN)
    assert closed.is_set() and env.provider.calls == 1 and env.billing.debits == 0
    assert env.control.journal.get(OWNER, OP)["stage"] == "uncertain"
    assert env.billing.events == ["reserve", "dispatch", ("uncertain", "provider_outcome_unknown")]


@pytest.mark.asyncio
async def test_explicit_stop_before_flight_starts_releases_only_unstarted_reservation(env, monkeypatch):
    await prepare(env)
    original = env.coordinator._claim

    def stop_before_start(*args):
        result = original(*args)
        asyncio.get_running_loop().call_soon(env.coordinator.cancel_run, OWNER, RUN)
        return result

    monkeypatch.setattr(env.coordinator, "_claim", stop_before_start)
    with pytest.raises(asyncio.CancelledError):
        await request(env)
    assert env.provider.calls == 0 and env.billing.debits == 0
    assert env.control.journal.get(OWNER, OP)["stage"] == "released"
    assert env.billing.events == ["reserve", "dispatch", "release_not_started"]


@pytest.mark.asyncio
async def test_stop_after_provider_reply_allows_existing_settlement_to_finish(env, monkeypatch):
    await prepare(env)
    settling, release = asyncio.Event(), asyncio.Event()
    original = env.billing.settle_image

    async def settle(*args):
        settling.set()
        await release.wait()
        return await original(*args)

    monkeypatch.setattr(env.billing, "settle_image", settle)
    pending = asyncio.create_task(request(env))
    await asyncio.wait_for(settling.wait(), 3)
    env.coordinator.cancel_run(OWNER, RUN)
    await asyncio.sleep(0)
    assert not pending.done()
    release.set()
    result = await asyncio.wait_for(pending, 3)
    assert result["status"] == "settled" and env.provider.calls == 1 and env.billing.debits == 1
    assert env.control.journal.get(OWNER, OP)["stage"] == "settled"


@pytest.mark.asyncio
async def test_inflight_result_is_saved_and_settled_after_run_stops(env):
    await prepare(env)
    env.provider.release.clear()
    pending = asyncio.create_task(request(env))
    await asyncio.wait_for(env.provider.entered.wait(), 3)
    env.store.db.execute("UPDATE runs SET status='cancelled' WHERE owner=? AND id=?", (OWNER, RUN))
    env.wire.fail = True  # A revoked/disconnected browser does not interrupt billing.
    env.provider.release.set()
    result = await asyncio.wait_for(pending, 3)
    assert result["status"] == "settled" and env.billing.events[-1] == "settle"
    assert env.previews.read(OWNER, SESSION, result["image"]["path"])[1] == env.provider.raw
    with pytest.raises(WorkError):
        env.previews.prepare_generated(OWNER, SESSION, RUN, "public", [])
    await env.coordinator.wait_run(OWNER, RUN)


@pytest.mark.asyncio
async def test_ready_image_ticket_uses_current_peer_token(env):
    await prepare(env)
    env.wire._peers[0].token = "new-session-token"
    signed_with = []

    def issue(_owner, token, _session, paths):
        signed_with.append(token)
        return [{"kind": "image", "url": "synthetic-ticket", "name": "image.png"} for _path in paths]

    env.desktop.history_media = issue
    result = await request(env)
    assert result["status"] == "settled"
    assert signed_with == ["new-session-token"] and len(env.wire.events) == 1


@pytest.mark.asyncio
async def test_paid_image_without_provider_usage_settles_using_verified_image_receipt(env):
    await prepare(env)
    env.provider.usage = None
    result = await request(env)
    assert result["status"] == "settled" and env.provider.calls == 1
    row = env.control.journal.get(OWNER, OP)
    assert row["stage"] == "settled" and row["image_result"] == {
        "sha256": result["image"]["sha256"], "image_count": 1}
    assert env.billing.events == ["reserve", "dispatch", "settle"]
    assert await request(env) == result and env.provider.calls == 1


@pytest.mark.asyncio
async def test_admin_free_image_with_absent_usage_preserves_unknown_usage(env):
    settings = env.settings.model_copy(update={"billing_mode": "free", "price": None})
    env.capability = env.control.bind(OWNER, SESSION, RUN, settings, "synthetic-website-token")
    await prepare(env)
    env.provider.usage = None
    result = await request(env)
    row = env.control.journal.get(OWNER, OP)
    assert result["status"] == "settled" and row["stage"] == "settled" and row["actual_units"] == 0
    assert env.billing.events == []


@pytest.mark.asyncio
async def test_failure_after_staging_retains_picture_without_charge_or_provider_retry(env, monkeypatch):
    await prepare(env)
    original = env.state.append
    attempts = 0
    def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("synthetic disk failure")
        return original(*args, **kwargs)
    monkeypatch.setattr(env.state, "append", fail_once)
    result = await request(env)
    assert result == {"status": "uncertain"} and env.provider.calls == 1
    assert env.billing.events == ["reserve", "dispatch"]
    assert env.control.journal.get(OWNER, OP)["stage"] == "usage_ready" and not env.wire.events
    assert env.coordinator.ensure_history(OWNER, SESSION, RUN, OP)
    assert env.control.journal.get(OWNER, OP)["stage"] == "usage_ready"
    receipt = env.control.journal.get(OWNER, OP)["image_result"]
    await env.control.finish(OWNER, SESSION, RUN, env.capability, OP, receipt)
    restored = await request(env)
    assert restored["status"] == "settled" and env.provider.calls == 1
    assert env.previews.read(OWNER, SESSION, restored["image"]["path"])[1] == env.provider.raw


@pytest.mark.asyncio
async def test_lost_settlement_response_retains_result_without_a_second_charge(env):
    await prepare(env)
    env.billing.lose_settle_reply = True
    result = await request(env)
    assert result == {"status": "uncertain"} and env.billing.debits == 1 and not env.wire.events
    assert env.control.journal.get(OWNER, OP)["reason"] == "settlement_unknown"
    assert await request(env) == result and env.billing.debits == env.provider.calls == 1
    records = env.coordinator._records(OWNER, SESSION, RUN, OP)
    assert env.previews.read(OWNER, SESSION, records[0]["path"])[1] == env.provider.raw


@pytest.mark.asyncio
async def test_provider_error_cannot_be_retried_after_coordinator_restart(env):
    await prepare(env)
    env.provider.failure = RuntimeError("synthetic provider failure")
    assert await request(env) == {"status": "uncertain"}
    assert env.provider.calls == 1 and env.control.journal.get(OWNER, OP)["stage"] == "uncertain"
    env.coordinator = ImageCoordinator(env.config, env.control, env.desktop, provider_factory=env.factory)
    assert await request(env) == {"status": "uncertain"}
    assert env.provider.calls == 1


@pytest.mark.asyncio
async def test_factory_receives_frozen_operator_settings(env):
    await prepare(env)
    calls = []
    def factory(config, settings):
        calls.append((config, settings))
        return env.provider
    env.coordinator = ImageCoordinator(env.config, env.control, env.desktop, provider_factory=factory)
    result = await request(env)
    assert result["status"] == "settled" and len(calls) == 1
    assert calls[0][0] is env.config and calls[0][1].model == MODEL
    assert "synthetic-image-key" not in json.dumps(result)


@pytest.mark.asyncio
async def test_upstream_error_body_is_redacted_before_desktop_provider_logs(monkeypatch):
    import mona.hosted_work.image_coordinator as module

    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443))])
    transport = module._ImageTransport("https://image.example.invalid/v1", 1024)
    transport.inner = httpx.MockTransport(lambda _request: httpx.Response(
        429, json={"error": {"message": "synthetic-sensitive-provider-payload"}}))
    logs = []
    sink = logger.add(lambda message: logs.append(str(message)), level="ERROR")
    try:
        async with httpx.AsyncClient(transport=transport) as client:
            provider = OpenAIImageGenerationClient(api_key="synthetic-key", api_base="https://image.example.invalid/v1",
                                                   client=client)
            with pytest.raises(ImageGenerationError) as error:
                await provider.generate(prompt="synthetic", model=MODEL)
        assert error.value.code == "IMAGE_RATE_LIMITED"
        assert "synthetic-sensitive-provider-payload" not in str(error.value)
        assert all("synthetic-sensitive-provider-payload" not in entry for entry in logs)
    finally:
        logger.remove(sink)
