"""Reconcile image holds after the original executor has stopped; never regenerate."""
from __future__ import annotations

from mona.config.schema import HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.billing import BillingError
from mona.hosted_work.contracts import WorkError


async def recover_image_billing(control, *, is_active, preview_verified):
    settled = []
    for record in control.journal.pending():
        owner, run, operation, stage = (record[key] for key in ("owner", "run_id", "operation_id", "stage"))
        if is_active(owner, run) or record["billing_mode"] not in {"free", "wallet"}:
            continue
        try:
            if stage == "prepared":
                control.journal.released(owner, operation)
                continue
            if stage == "reserved":
                if record["billing_mode"] == "wallet":
                    result = await control.billing_factory(control.config).get(operation)
                    if result["status"] == "reserved":
                        result = await control.billing_factory(control.config).release(operation)
                    if result["status"] != "released" or result["reserved_units"] != record["reserve_units"]:
                        continue
                control.journal.released(owner, operation)
                continue
            if stage in {"reserving", "dispatching", "running", "settling"}:
                control.journal.uncertain(owner, operation, "interrupted")
                if record["billing_mode"] == "wallet" and stage in {"dispatching", "running"}:
                    try:
                        await control.billing_factory(control.config).uncertain(operation, "interrupted")
                    except BillingError:
                        pass
                continue
            if stage == "uncertain" and record["uncertain_from"] == "reserving":
                if record["billing_mode"] == "free":
                    continue
                result = await control.billing_factory(control.config).get(operation)
                recovered, changed = control.journal.recover_reservation(owner, operation, executors_stopped=True,
                    auth_receipt_verified=True, auth_status=200, receipt=result)
                if changed and recovered["stage"] == "reserved":
                    released = await control.billing_factory(control.config).release(operation)
                    if released["status"] == "released" and released["reserved_units"] == record["reserve_units"]:
                        control.journal.released(owner, operation)
                continue
            if not record["image_result"] or not preview_verified(owner, run, operation, record["image_result"]):
                continue
            settings = HostedWorkImageSettings(model="recovery", price=HostedWorkImagePrice.model_validate(record["price"]),
                                               billing_mode=record["billing_mode"])
            if stage == "usage_ready":
                record, acquired = control.journal.claim(owner, operation, "settle")
                if not acquired:
                    continue
            elif stage == "uncertain" and record["uncertain_from"] == "settling":
                if record["billing_mode"] == "free":
                    continue
                remote = await control.billing_factory(control.config).get(operation)
                record, acquired = control.journal.recover_settlement(owner, operation, executors_stopped=True,
                    auth_receipt_verified=True, receipt=remote)
                if not acquired:
                    continue
                if remote["status"] == "settled":
                    control.journal.settled(owner, operation, remote["actual_units"])
                    settled.append((owner, run, operation))
                    continue
            else:
                continue
            if record["billing_mode"] == "free":
                control.journal.settled(owner, operation, 0)
                settled.append((owner, run, operation))
            else:
                try:
                    result = await control.billing_factory(control.config).settle_image(operation, settings, record["image_result"])
                    if result["status"] != "settled":
                        raise BillingError("billing_unknown", "图片计费状态待核对。", 503)
                    control.journal.settled(owner, operation, result["actual_units"])
                    settled.append((owner, run, operation))
                except BillingError:
                    current = control.journal.get(owner, operation)
                    if current["stage"] == "settling":
                        control.journal.uncertain(owner, operation, "settlement_unknown")
        except (BillingError, WorkError, ValueError, KeyError, TypeError):
            # Missing/ambiguous receipts or images are never treated as evidence of success.
            continue
    return settled
