"""Exercise the shared desktop image provider through the hosted boundaries."""
import base64
import hashlib
import io
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.contracts import NewSession, NewTurn
from mona.hosted_work.image_control import ImageControl
from mona.hosted_work.image_pricing import image_price_units
from mona.hosted_work.image_runtime import _CALL_ID, ImageRuntime
from mona.hosted_work.store import WorkStore

OWNER, SID, RID = "a" * 64, "1" * 32, "2" * 32


class Sandbox:
    def __init__(self):
        self.files = {}

    async def file(self, request):
        path = request["path"]
        if request["action"] == "upload":
            self.files[path] = base64.b64decode(request["data"], validate=True)
        raw = self.files[path]
        return {"path": path, "name": path.rsplit("/", 1)[-1], "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}


class Wallet:
    def __init__(self):
        self.actions = []

    async def reserve_image(self, _operation, _token, settings):
        self.actions.append("reserve")
        return {"status": "reserved", "reserved_units": image_price_units(settings.price.model_dump())}

    async def dispatch(self, _operation):
        self.actions.append("dispatch")
        return {"status": "running"}

    async def settle_image(self, _operation, _settings, _usage):
        self.actions.append("settle")
        return {"status": "settled", "actual_units": 4}


@pytest.mark.asyncio
async def test_image_uses_shared_provider_then_is_billed_and_delivered(monkeypatch):
    # Keep paths short enough for Windows when owner and run IDs are included.
    temp = tempfile.TemporaryDirectory(prefix="mwi-")
    tmp_path = Path(temp.name).resolve()
    assert tmp_path.is_relative_to(Path(tempfile.gettempdir()).resolve())
    image = HostedWorkImageSettings(enabled=True, model="gpt-6.1-sol",
                                    price=HostedWorkImagePrice(amount_per_image="0.000004"))
    config = HostedWorkConfig(state_dir=str(tmp_path), auth_origin="https://auth.example.test",
                              public_origin="https://example.test", image_generation=image)
    store = WorkStore(tmp_path / "work.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="test", text="test"))
    wallet = Wallet()
    control = ImageControl(config, store, billing_factory=lambda _: wallet)
    capability = control.bind(OWNER, SID, RID, image, "test-token")
    sandbox, delivered, previews = Sandbox(), [], []
    async def deliver(path):
        delivered.append(path)
    tools = SimpleNamespace(deliver_file=deliver)
    runtime = ImageRuntime(config, {"owner": OWNER, "session_id": SID, "run_id": RID, "account_token": "test-token",
        "hosted_image": {"settings": image.model_dump(), "capability": capability}}, sandbox, tools)
    buf = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(buf, format="PNG")
    png = buf.getvalue()
    provider_calls = []
    async def rpc(command, args):
        common = (OWNER, SID, RID, args.get("capability"))
        if command == "image_begin":
            return await control.begin(*common, args["operation"], args["fingerprint"])
        if command == "image_dispatch":
            return await control.dispatch(*common, args["operation"])
        if command == "image_generate":
            provider_calls.append(args["model"])
            await control.finish(*common, args["operation"],
                                 {"sha256": hashlib.sha256(png).hexdigest(), "image_count": 1})
            file = {"mime": "image/png", "size": len(png), "sha256": hashlib.sha256(png).hexdigest(),
                    "data": base64.b64encode(png).decode()}
            previews.append(file)
            return {"status": "settled", "image": file}
        raise AssertionError(command)
    monkeypatch.setattr(runtime, "_post", rpc)
    call = _CALL_ID.set("tool-call-1")
    try:
        result = json.loads(await runtime.tool().execute(prompt="draw a red square"))
        assert result["ok"] is True and len(result["artifacts"]) == 1, (result, wallet.actions, provider_calls, len(str(tmp_path)))
        assert "draw a red square" not in json.dumps(result)
        assert wallet.actions == ["reserve", "dispatch", "settle"]
        assert provider_calls == ["gpt-6.1-sol"]
        await runtime.deliver("tool-call-1", result["artifacts"])
        assert len(delivered) == len(previews) == 1
        assert previews[0]["sha256"] == hashlib.sha256(png).hexdigest()
        assert base64.b64decode(previews[0]["data"]) == png
        assert control.journal.pending(OWNER) == []
    finally:
        _CALL_ID.reset(call)
        await runtime.close()
        store.close()
        temp.cleanup()
