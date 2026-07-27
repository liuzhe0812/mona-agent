"""支付宝官方支付服务封装

支持：
- 电脑网站支付（一次性）
- 当面付预下单（扫码支付）
- 周期扣款签约并支付
- 周期扣款当期扣款
- 周期扣款解约
- 异步回调验签

依赖：python-alipay-sdk（AlipayPythonSDK）
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from alipay import AliPay
from alipay.utils import AliPayConfig

from app.config import settings

logger = logging.getLogger(__name__)

GATEWAY_PRODUCTION = "https://openapi.alipay.com/gateway.do"
GATEWAY_SANDBOX = "https://openapi-sandbox.dl.alipaydev.com/gateway.do"


@dataclass
class DeductResult:
    success: bool
    trade_no: str | None = None
    error: str | None = None
    raw: dict[str, Any] | None = None


@dataclass
class SignAndPayResult:
    success: bool
    sign_url: str | None = None
    error: str | None = None
    raw: dict[str, Any] | None = None


@dataclass
class UnsignResult:
    success: bool
    error: str | None = None


class AlipayService:
    """支付宝服务封装（线程安全单例）"""

    _instance: "AlipayService | None" = None

    def __new__(cls) -> "AlipayService":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        if self._initialized:
            return
        self._initialized = True
        self._client: AliPay | None = None
        self._enabled = bool(
            settings.alipay_app_id
            and settings.alipay_app_private_key_pem
            and settings.alipay_public_key_pem
        )
        if not self._enabled:
            logger.warning("AlipayService disabled: missing alipay_app_id / private_key / public_key")
            return
        self._client = AliPay(
            appid=settings.alipay_app_id,
            app_notify_url=settings.alipay_notify_url,
            app_private_key_string=settings.alipay_app_private_key_pem,
            alipay_public_key_string=settings.alipay_public_key_pem,
            sign_type="RSA2",
            debug=settings.alipay_sandbox,
            verbose=False,
            config=AliPayConfig(timeout=15),
        )
        self._gateway = GATEWAY_SANDBOX if settings.alipay_sandbox else GATEWAY_PRODUCTION
        logger.info("AlipayService initialized (sandbox=%s)", settings.alipay_sandbox)

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def gateway(self) -> str:
        return self._gateway

    @property
    def notify_url(self) -> str:
        return settings.alipay_notify_url

    @property
    def return_url(self) -> str:
        return settings.alipay_return_url

    # ── 电脑网站支付 ──

    def create_page_pay_url(
        self,
        out_trade_no: str,
        total_amount: float,
        subject: str,
        return_url: str | None = None,
    ) -> str:
        """电脑网站支付，返回跳转 URL（用户浏览器跳转）"""
        if not self._client:
            raise RuntimeError("Alipay service not enabled")
        order_string = self._client.api_alipay_trade_page_pay(
            out_trade_no=out_trade_no,
            total_amount=f"{total_amount:.2f}",
            subject=subject,
            return_url=return_url or self.return_url,
            notify_url=self.notify_url,
            # PC 支付默认二维码 + 账号支付
        )
        return f"{self._gateway}?{order_string}"

    # ── 当面付预下单（扫码支付）──

    def create_precreate_qr(
        self,
        out_trade_no: str,
        total_amount: float,
        subject: str,
    ) -> str:
        """当面付预下单，返回二维码内容（可用 qrcode 库生成图片）"""
        if not self._client:
            raise RuntimeError("Alipay service not enabled")
        result = self._client.api_alipay_trade_precreate(
            out_trade_no=out_trade_no,
            total_amount=f"{total_amount:.2f}",
            subject=subject,
            notify_url=self.notify_url,
        )
        if result.get("code") != "10000":
            raise RuntimeError(
                f"alipay precreate failed: {result.get('sub_code')} {result.get('sub_msg')}"
            )
        return result.get("qr_code", "")

    # ── 周期扣款签约并支付 ──

    def sign_and_pay(
        self,
        external_agreement_no: str,
        out_trade_no: str,
        total_amount: float,
        subject: str,
        return_url: str | None = None,
    ) -> SignAndPayResult:
        """周期扣款签约并支付，返回签约 URL

        使用 alipay.user.agreement.facetopay.sign.and.pay 接口。
        python-alipay-sdk 未封装此接口，使用通用 client_api 签名后拼 URL（与 page.pay 同模式）。
        """
        if not self._client:
            return SignAndPayResult(success=False, error="Alipay service not enabled")
        try:
            biz_content = {
                "external_agreement_no": external_agreement_no,
                "out_trade_no": out_trade_no,
                "total_amount": f"{total_amount:.2f}",
                "subject": subject,
                "product_code": "CYCLE_PAY_AUTH",
                "sign_scene": settings.alipay_sign_scene,
            }
            # client_api 只签名不发 HTTP 请求，返回 order_string（与 page.pay 一致）
            order_string = self._client.client_api(
                "alipay.user.agreement.facetopay.sign.and.pay",
                biz_content,
                return_url=return_url or self.return_url,
                notify_url=self.notify_url,
            )
            if not order_string:
                return SignAndPayResult(success=False, error="Empty order_string from alipay")
            sign_url = (
                order_string
                if order_string.startswith("http")
                else f"{self._gateway}?{order_string}"
            )
            return SignAndPayResult(success=True, sign_url=sign_url)
        except Exception as e:
            logger.exception("sign_and_pay failed")
            return SignAndPayResult(success=False, error=str(e))

    # ── 周期扣款当期扣款 ──

    def periodic_deduct(
        self,
        agreement_no: str,
        out_trade_no: str,
        total_amount: float,
        subject: str,
    ) -> DeductResult:
        """周期扣款当期扣款"""
        if not self._client:
            return DeductResult(success=False, error="Alipay service not enabled")
        try:
            result = self._client.api_alipay_trade_pay(
                out_trade_no=out_trade_no,
                total_amount=f"{total_amount:.2f}",
                subject=subject,
                product_code="CYCLE_PAY_AUTH_P",
                agreement_no=agreement_no,
                notify_url=self.notify_url,
            )
            if result.get("code") == "10000":
                return DeductResult(
                    success=True,
                    trade_no=result.get("trade_no"),
                    raw=result,
                )
            return DeductResult(
                success=False,
                error=f"{result.get('sub_code')} {result.get('sub_msg')}",
                raw=result,
            )
        except Exception as e:
            logger.exception("periodic_deduct failed")
            return DeductResult(success=False, error=str(e))

    # ── 解约 ──

    def unsign(self, agreement_no: str, remind_type: str = "NO_REMIND") -> UnsignResult:
        """解约周期扣款协议

        使用 alipay.user.agreement.unsign 接口（python-alipay-sdk 未封装，用通用 server_api）。
        """
        if not self._client:
            return UnsignResult(success=False, error="Alipay service not enabled")
        try:
            biz_content = {
                "agreement_no": agreement_no,
                "remind_type": remind_type,
            }
            result = self._client.server_api(
                "alipay.user.agreement.unsign",
                biz_content,
            )
            if result.get("code") == "10000":
                return UnsignResult(success=True)
            return UnsignResult(
                success=False,
                error=f"{result.get('sub_code')} {result.get('sub_msg')}",
            )
        except Exception as e:
            logger.exception("unsign failed")
            return UnsignResult(success=False, error=str(e))

    # ── 查询交易状态 ──

    def query_trade(self, out_trade_no: str | None = None, trade_no: str | None = None) -> dict[str, Any]:
        """统一交易查询，返回原始响应"""
        if not self._client:
            raise RuntimeError("Alipay service not enabled")
        kwargs: dict[str, Any] = {}
        if out_trade_no:
            kwargs["out_trade_no"] = out_trade_no
        if trade_no:
            kwargs["trade_no"] = trade_no
        return self._client.api_alipay_trade_query(**kwargs)

    # ── 验签 ──

    def verify_callback(self, data: dict[str, Any]) -> bool:
        """验证异步回调签名

        data 应为支付宝回调的原始 form 数据（已转为 dict，sign 字段保留）
        """
        if not self._client:
            return False
        sign = data.pop("sign", None)
        sign_type = data.pop("sign_type", None)
        if not sign:
            return False
        try:
            return self._client.verify(data, sign)
        except Exception:
            logger.exception("verify_callback failed")
            return False

    # ── 退款 ──

    def refund(
        self,
        out_trade_no: str | None = None,
        trade_no: str | None = None,
        refund_amount: float | None = None,
        refund_reason: str | None = None,
        out_request_no: str | None = None,
    ) -> dict[str, Any]:
        """交易退款"""
        if not self._client:
            raise RuntimeError("Alipay service not enabled")
        kwargs: dict[str, Any] = {}
        if out_trade_no:
            kwargs["out_trade_no"] = out_trade_no
        if trade_no:
            kwargs["trade_no"] = trade_no
        if refund_amount is not None:
            kwargs["refund_amount"] = f"{refund_amount:.2f}"
        if refund_reason:
            kwargs["refund_reason"] = refund_reason
        if out_request_no:
            kwargs["out_request_no"] = out_request_no
        return self._client.api_alipay_trade_refund(**kwargs)


# 模块级单例
alipay_service = AlipayService()
