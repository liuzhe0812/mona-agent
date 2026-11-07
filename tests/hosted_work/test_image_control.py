"""Image calls must be bound to a run and settled only from explicit receipts."""
from types import SimpleNamespace

import pytest

from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError
from mona.hosted_work.image_control import ImageControl
from mona.hosted_work.image_pricing import image_price_units
from mona.hosted_work.image_recovery import recover_image_billing
from mona.hosted_work.store import WorkStore

OWNER, OTHER = "a" * 64, "b" * 64
SESSION, RUN, OP, FINGERPRINT = "1" * 32, "2" * 32, "3" * 32, "4" * 64
RECEIPT = {"sha256": "e" * 64, "image_count": 1}
PRICE = HostedWorkImagePrice(amount_per_image="0.000004")


class Billing:
    def __init__(self):
        self.events = []

    async def reserve_image(self, operation, _token, image):
        self.events.append("reserve")
        return {"run_id": operation, "status": "reserved", "reserved_units": image_price_units(image.price.model_dump())}

    async def dispatch(self, operation):
        self.events.append("dispatch")
        return {"run_id": operation, "status": "running"}

    async def settle_image(self, operation, _image, _usage):
        self.events.append("settle")
        return {"run_id": operation, "status": "settled", "actual_units": 4}

    async def uncertain(self, operation, reason):
        self.events.append(("uncertain", reason))
        return {"run_id": operation, "status": "uncertain"}

    async def get(self, operation):
        self.events.append("get")
        return {"run_id": operation, "status": "reserved", "reserved_units": 4, "actual_units": None}

    async def release(self, operation):
        self.events.append("release")
        return {"run_id": operation, "status": "released", "reserved_units": 4, "actual_units": None}

    async def release_not_started(self, operation):
        self.events.append("release_not_started")
        return {"run_id": operation, "status": "released", "reserved_units": 4, "actual_units": None}


@pytest.fixture
def setup(tmp_path):
    config = HostedWorkConfig(state_dir=str(tmp_path))
    store = WorkStore(tmp_path / "work.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SESSION))
    store.create_run(OWNER, SESSION, NewTurn(request_id=RUN, model_id="test", text="test"))
    billing = Billing()
    control = ImageControl(config, store, billing_factory=lambda _config: billing)
    settings = HostedWorkImageSettings(enabled=True, model="gpt-image-test", price=PRICE.model_copy(deep=True))
    capability = control.bind(OWNER, SESSION, RUN, settings, "user-token")
    yield SimpleNamespace(store=store, billing=billing, control=control, settings=settings, capability=capability)
    store.close()


@pytest.mark.asyncio
async def test_one_image_is_reserved_dispatched_and_settled_once(setup):
    c, cap = setup.control, setup.capability
    setup.settings.price.amount_per_image = "99"
    await c.begin(OWNER, SESSION, RUN, cap, OP, FINGERPRINT)
    await c.dispatch(OWNER, SESSION, RUN, cap, OP)
    assert await c.finish(OWNER, SESSION, RUN, cap, OP, RECEIPT) == {"status": "settled"}
    assert await c.finish(OWNER, SESSION, RUN, cap, OP, RECEIPT) == {"status": "settled"}
    assert setup.billing.events == ["reserve", "dispatch", "settle"]
    with pytest.raises(WorkError):
        await c.dispatch(OWNER, SESSION, RUN, cap, OP)


@pytest.mark.asyncio
async def test_other_account_or_missing_capability_cannot_use_operation(setup):
    c, cap = setup.control, setup.capability
    with pytest.raises(WorkError) as error:
        await c.begin(OTHER, SESSION, RUN, cap, OP, FINGERPRINT)
    assert error.value.status == 403
    with pytest.raises(WorkError):
        await c.begin(OWNER, SESSION, RUN, "wrong", OP, FINGERPRINT)
    assert not setup.billing.events


@pytest.mark.asyncio
async def test_unknown_provider_outcome_is_not_redispatched(setup):
    c, cap = setup.control, setup.capability
    await c.begin(OWNER, SESSION, RUN, cap, OP, FINGERPRINT)
    await c.dispatch(OWNER, SESSION, RUN, cap, OP)
    await c.uncertain(OWNER, SESSION, RUN, cap, OP)
    with pytest.raises(WorkError):
        await c.dispatch(OWNER, SESSION, RUN, cap, OP)
    assert c.journal.get(OWNER, OP)["stage"] == "uncertain"
    assert setup.billing.events == ["reserve", "dispatch", ("uncertain", "provider_outcome_unknown")]


@pytest.mark.asyncio
async def test_missing_image_receipt_cannot_be_settled(setup):
    c, cap = setup.control, setup.capability
    await c.begin(OWNER, SESSION, RUN, cap, OP, FINGERPRINT)
    await c.dispatch(OWNER, SESSION, RUN, cap, OP)
    with pytest.raises(WorkError):
        await c.finish(OWNER, SESSION, RUN, cap, OP, {"sha256": "bad"})
    assert c.journal.get(OWNER, OP)["stage"] == "uncertain"
    assert setup.billing.events[-1] == ("uncertain", "provider_outcome_unknown")


@pytest.mark.asyncio
async def test_admin_explicit_free_uses_no_wallet(setup):
    c = setup.control
    cap = c.bind(OWNER, SESSION, RUN, HostedWorkImageSettings(enabled=True, model="gpt-image-test", billing_mode="free"), "user-token")
    await c.begin(OWNER, SESSION, RUN, cap, OP, FINGERPRINT)
    await c.dispatch(OWNER, SESSION, RUN, cap, OP)
    await c.finish(OWNER, SESSION, RUN, cap, OP, RECEIPT)
    assert c.journal.get(OWNER, OP)["actual_units"] == 0 and not setup.billing.events


@pytest.mark.asyncio
async def test_recovery_releases_only_a_confirmed_pre_dispatch_hold(setup):
    c = setup.control
    c.journal.create(OWNER, RUN, OP, FINGERPRINT, PRICE.model_dump(), 4, operation_id=OP, billing_mode="wallet")
    c.journal.claim(OWNER, OP, "reserve")
    c.journal.uncertain(OWNER, OP, "reserve_unknown")
    await recover_image_billing(c, is_active=lambda *_: False, preview_verified=lambda *_: False)
    assert c.journal.get(OWNER, OP)["stage"] == "released"
    assert setup.billing.events == ["get", "release"]
    assert c.journal.claim(OWNER, OP, "dispatch")[1] is False


@pytest.mark.asyncio
async def test_confirmed_unstarted_provider_releases_running_hold(setup):
    c, cap = setup.control, setup.capability
    await c.begin(OWNER, SESSION, RUN, cap, OP, FINGERPRINT)
    await c.dispatch(OWNER, SESSION, RUN, cap, OP)
    await c.release_not_started(OWNER, SESSION, RUN, cap, OP)
    assert c.journal.get(OWNER, OP)["stage"] == "released"
    assert setup.billing.events == ["reserve", "dispatch", "release_not_started"]
    assert c.journal.claim(OWNER, OP, "dispatch")[1] is False


@pytest.mark.asyncio
async def test_recovery_settles_saved_usage_only_after_image_is_verified(setup):
    c, cap = setup.control, setup.capability
    await c.begin(OWNER, SESSION, RUN, cap, OP, FINGERPRINT)
    await c.dispatch(OWNER, SESSION, RUN, cap, OP)
    c.journal.record_image_result(OWNER, OP, RECEIPT)
    await recover_image_billing(c, is_active=lambda *_: False, preview_verified=lambda *_: False)
    assert c.journal.get(OWNER, OP)["stage"] == "usage_ready" and "settle" not in setup.billing.events
    await recover_image_billing(c, is_active=lambda *_: False, preview_verified=lambda *_: True)
    assert c.journal.get(OWNER, OP)["stage"] == "settled" and setup.billing.events[-1] == "settle"
