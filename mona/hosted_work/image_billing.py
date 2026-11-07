"""Work's authenticated wallet bridge for a single image operation."""
from __future__ import annotations

from mona.config.schema import HostedWorkImageSettings
from mona.hosted_work.billing import _PREFIX, BillingError, HostedBilling
from mona.hosted_work.image_pricing import image_actual_units, image_price_units


class HostedImageBilling(HostedBilling):
    async def reserve_image(self, operation_id: str, token: str, image: HostedWorkImageSettings) -> dict:
        if image.billing_mode != "wallet" or image.price is None or not image.model:
            raise BillingError("price_unavailable", "图片模型尚未完成计费配置。", 503, rejected=True)
        return await self._request("POST", _PREFIX + "/image/reserve", operation_id, token=token, body={
            "run_id": operation_id, "model": image.model, "reserve_units": image_price_units(image.price.model_dump()),
            "price": image.price.model_dump(),
        })

    async def settle_image(self, operation_id: str, image: HostedWorkImageSettings, receipt: dict) -> dict:
        if image.price is None:
            raise BillingError("price_unavailable", "图片模型尚未完成计费配置。", 503)
        expected = image_actual_units(image.price.model_dump(), receipt)
        result = await self._request("POST", f"{_PREFIX}/image/{operation_id}/settle", operation_id,
                                     body={"receipt": receipt})
        if result["status"] == "settled" and result["actual_units"] != expected:
            raise BillingError("billing_unknown", "图片计费结果待核对。", 503)
        return result

    async def release_not_started(self, operation_id: str) -> dict:
        return await self._request("POST", f"{_PREFIX}/image/{operation_id}/release-not-started", operation_id, body={})
