"""Per-run, capability-bound image billing coordination in the Work parent."""
from __future__ import annotations

import hmac
import secrets
from dataclasses import dataclass, field

from mona.config.schema import HostedWorkImageSettings
from mona.hosted_work.billing import BillingError
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.image_billing import HostedImageBilling
from mona.hosted_work.image_billing_journal import ImageBillingJournal
from mona.hosted_work.image_pricing import image_actual_units, image_price_units


@dataclass(frozen=True)
class _Binding:
    session: str
    capability: str = field(repr=False)
    settings: HostedWorkImageSettings = field(repr=False)
    token: str = field(repr=False)


class ImageControl:
    """Keep wallet credentials in the parent; the child receives only a run capability."""

    def __init__(self, config, store, *, billing_factory=HostedImageBilling):
        self.config, self.journal, self.billing_factory = config, ImageBillingJournal(store), billing_factory
        self.bindings: dict[tuple[str, str], _Binding] = {}

    def bind(self, owner: str, session: str, run: str, settings: HostedWorkImageSettings, token: str) -> str:
        capability = secrets.token_urlsafe(32)
        self.bindings[owner, run] = _Binding(session, capability, settings.model_copy(deep=True), token)
        return capability

    def unbind(self, owner: str, run: str) -> None:
        self.bindings.pop((owner, run), None)

    async def close_run(self, owner: str, run: str) -> None:
        """Never replay an interrupted image; release only a confirmed unused hold."""
        binding = self.bindings.get((owner, run))
        if binding is None:
            return
        for record in self.journal.pending(owner):
            if record["run_id"] != run or record["stage"] == "uncertain":
                continue
            operation, stage = record["operation_id"], record["stage"]
            try:
                if stage == "prepared":
                    self.journal.released(owner, operation)
                elif stage == "reserved":
                    if binding.settings.billing_mode == "wallet":
                        result = await self.billing_factory(self.config).release(operation)
                        if result["status"] != "released":
                            raise BillingError("billing_unknown", "图片计费状态待核对。", 503)
                    self.journal.released(owner, operation)
                elif stage == "usage_ready":
                    # The recovery loop can settle a saved receipt after verifying the image.
                    continue
                else:
                    self.journal.uncertain(owner, operation, "interrupted")
                    if binding.settings.billing_mode == "wallet" and stage in {"dispatching", "running"}:
                        await self.billing_factory(self.config).uncertain(operation, "interrupted")
            except (BillingError, WorkError):
                current = self.journal.get(owner, operation)
                if current["stage"] not in {"settled", "released", "rejected", "uncertain", "free_completed"}:
                    self.journal.uncertain(owner, operation, "interrupted")

    def _binding(self, owner: str, session: str, run: str, capability: object) -> _Binding:
        binding = self.bindings.get((owner, run))
        if (binding is None or binding.session != session or not isinstance(capability, str)
                or not hmac.compare_digest(binding.capability, capability)):
            raise WorkError("execution_stopped", "本轮图片操作不可用。", 403)
        return binding

    def _record(self, owner: str, run: str, operation: str) -> dict:
        record = self.journal.get(owner, operation)
        if record["run_id"] != run:
            raise WorkError("not_found", "未找到图片操作记录。", 404)
        return record

    @staticmethod
    def _price(settings: HostedWorkImageSettings) -> dict[str, str]:
        if settings.billing_mode == "free":
            return {"amount_per_image": "0"}
        if settings.price is None:
            raise WorkError("price_unavailable", "图片模型尚未完成计费配置。", 503)
        return settings.price.model_dump()

    async def begin(self, owner: str, session: str, run: str, capability: object,
                    operation: str, fingerprint: str) -> dict:
        binding = self._binding(owner, session, run, capability)
        settings = binding.settings
        if any(item["run_id"] != run for item in self.journal.pending(owner)):
            raise WorkError("image_billing_pending", "已有图片操作结果待核对，未重复生成。", 409)
        price = self._price(settings)
        reserve = image_price_units(price)
        record, _ = self.journal.create(owner, run, operation, fingerprint, price, reserve,
                                        operation_id=operation, billing_mode=settings.billing_mode)
        if record["stage"] == "reserved":
            return {"status": "reserved"}
        record, acquired = self.journal.claim(owner, operation, "reserve")
        if not acquired:
            raise WorkError("image_billing_pending", "图片操作状态待核对，请勿重复生成。", 409)
        if settings.billing_mode == "free":
            self.journal.reserved(owner, operation, 0)
            return {"status": "reserved"}
        try:
            response = await self.billing_factory(self.config).reserve_image(operation, binding.token, settings)
            if response["status"] != "reserved":
                raise BillingError("billing_unknown", "图片计费状态待核对。", 503)
            record = self.journal.reserved(owner, operation, response["reserved_units"])
            if record["stage"] != "reserved":
                raise BillingError("billing_unknown", "图片计费状态待核对。", 503)
        except BillingError as error:
            current = self.journal.get(owner, operation)
            if current["stage"] != "uncertain":
                if error.rejected:
                    self.journal.rejected(owner, operation)
                else:
                    self.journal.uncertain(owner, operation, "reserve_unknown")
            raise
        return {"status": "reserved"}

    async def dispatch(self, owner: str, session: str, run: str, capability: object, operation: str) -> dict:
        settings = self._binding(owner, session, run, capability).settings
        self._record(owner, run, operation)
        record, acquired = self.journal.claim(owner, operation, "dispatch")
        if not acquired:
            raise WorkError("image_billing_pending", "图片操作状态待核对，请勿重复生成。", 409)
        try:
            if settings.billing_mode == "wallet":
                response = await self.billing_factory(self.config).dispatch(operation)
                if response["status"] != "running":
                    raise BillingError("billing_unknown", "图片计费状态待核对。", 503)
            self.journal.running(owner, operation)
        except BillingError:
            self.journal.uncertain(owner, operation, "provider_outcome_unknown")
            raise
        return {"status": "running"}

    async def release_unstarted(self, owner: str, session: str, run: str, capability: object, operation: str) -> None:
        settings = self._binding(owner, session, run, capability).settings
        record = self._record(owner, run, operation)
        if record["stage"] == "released":
            return
        if record["stage"] != "reserved":
            raise WorkError("image_billing_pending", "图片操作状态待核对。", 409)
        if settings.billing_mode == "wallet":
            result = await self.billing_factory(self.config).release(operation)
            if result["status"] != "released" or result["reserved_units"] != record["reserve_units"]:
                raise WorkError("billing_unknown", "图片计费状态待核对。", 503)
        self.journal.released(owner, operation)

    async def release_not_started(self, owner: str, session: str, run: str, capability: object,
                                  operation: str) -> None:
        """Only the provider owner may confirm that no upstream request started."""
        settings = self._binding(owner, session, run, capability).settings
        record = self._record(owner, run, operation)
        if record["stage"] == "released":
            return
        if record["stage"] != "running":
            raise WorkError("image_billing_pending", "图片操作状态待核对。", 409)
        if settings.billing_mode == "wallet":
            result = await self.billing_factory(self.config).release_not_started(operation)
        else:
            result = {"run_id": operation, "status": "released", "reserved_units": 0, "actual_units": None}
        _, changed = self.journal.release_not_started(owner, operation, provider_not_started=True, receipt=result)
        if not changed:
            raise WorkError("billing_unknown", "图片计费状态待核对。", 503)

    async def finish(self, owner: str, session: str, run: str, capability: object,
                     operation: str, receipt: dict) -> dict:
        settings = self._binding(owner, session, run, capability).settings
        self._record(owner, run, operation)
        price = self._price(settings)
        try:
            expected = image_actual_units(price, receipt)
        except (TypeError, ValueError, KeyError):
            await self.uncertain(owner, session, run, capability, operation)
            raise WorkError("billing_unknown", "图片结果待核对，请勿重复生成。", 503) from None
        record = self.journal.record_image_result(owner, operation, receipt)
        if record["expected_units"] != expected:
            raise WorkError("billing_unknown", "图片计费状态待核对。", 503)
        if record["stage"] == "settled":
            return {"status": "settled"}
        record, acquired = self.journal.claim(owner, operation, "settle")
        if not acquired:
            raise WorkError("billing_unknown", "图片计费状态待核对，请勿重复生成。", 503)
        if settings.billing_mode == "free":
            self.journal.settled(owner, operation, 0)
            return {"status": "settled"}
        try:
            response = await self.billing_factory(self.config).settle_image(operation, settings, receipt)
            if response["status"] != "settled":
                raise BillingError("billing_unknown", "图片计费状态待核对。", 503)
            record = self.journal.settled(owner, operation, response["actual_units"])
            if record["stage"] != "settled":
                raise BillingError("billing_unknown", "图片计费状态待核对。", 503)
        except BillingError:
            current = self.journal.get(owner, operation)
            if current["stage"] != "uncertain":
                self.journal.uncertain(owner, operation, "settlement_unknown")
            raise
        return {"status": "settled"}

    async def uncertain(self, owner: str, session: str, run: str, capability: object,
                        operation: str, *, usage_missing: bool = False) -> None:
        settings = self._binding(owner, session, run, capability).settings
        record = self._record(owner, run, operation)
        if record["stage"] in {"settled", "released", "rejected", "free_completed"}:
            return
        if record["stage"] != "uncertain":
            self.journal.uncertain(owner, operation, "provider_outcome_unknown")
        if settings.billing_mode == "wallet" and record["stage"] in {"dispatching", "running"}:
            await self.billing_factory(self.config).uncertain(
                operation, "usage_unavailable" if usage_missing else "provider_outcome_unknown")
