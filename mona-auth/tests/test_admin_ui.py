from pathlib import Path

from app.auth import create_access_token
from app.models import CreditWallet, PricingPlan, User


def test_admin_panel_exposes_billing_and_gateway_maintenance():
    html = (Path(__file__).parents[1] / "app" / "admin" / "index.html").read_text(
        encoding="utf-8"
    )

    for marker in (
        'id="tab-credits"',
        'id="section-credits"',
        'id="creditProductTable"',
        'id="customRechargeEnabled"',
        'id="customRechargeMin"',
        'id="customRechargeMax"',
        'id="balanceRechargeFlag"',
        'id="managedModelFlag"',
        'id="modelPriceTable"',
        'id="modelPriceOptions"',
        'id="modelPriceConfiguredCount"',
        'id="modelPriceSearch"',
        'id="modelPriceMultiplier"',
        'id="modelMediaRateGrid"',
        'id="modelPriceFetch"',
        'id="modelOfficialPriceStatus"',
        'id="modelPromotionModel"',
        'id="modelPromotionEnabled"',
        'id="modelPromotionDiscount"',
        'id="modelPromotionStart"',
        'id="modelPromotionEnd"',
        'id="modelPromotionModal"',
        'id="reconciliationResult"',
        'id="uncertainTable"',
        'id="creditUserTable"',
        'id="creditPaymentTable"',
        'id="tab-channels"',
        'id="section-channels"',
        'id="gatewayChannelKey"',
        'id="gatewayModelPicker"',
        'id="gatewayModelTrigger"',
        'id="gatewayModelFooterCount"',
        'id="gatewayManualPanel"',
        'id="gatewayChannelTable"',
        'id="gatewayDrawerBackdrop"',
        'id="fundsTables"',
        'id="fundsSide"',
        'id="fundsSettings"',
        'id="modelPricingContainer"',
        'id="systemBusinessSettingsContainer"',
        "function saveCreditProduct",
        "function saveCustomRechargeSettings",
        "function saveBillingFeatureFlags",
        "function createModelPrice",
        "function editModelPrice",
        "function enableModelPrice",
        "function deleteModelPrice",
        "function resetModelPriceEditor",
        "function loadOfficialModelPrice",
        "function applyModelPriceMultiplier",
        "function setModelPriceBillingType",
        "function openModelPromotionModal",
        "function closeModelPromotionModal",
        "function saveModelPromotion",
        "function runCreditReconciliation",
        "function adjustUserCredits",
        "function syncCreditPayment",
        "function refundCreditPayment",
        "function saveGatewayChannel",
        "function discoverGatewayModels",
        "function closeGatewayModelPicker",
        "function toggleGatewayManualModels",
        "function testGatewayChannel",
        "function arrangeBusinessSections",
        "function openGatewayChannelEditor",
        "function closeGatewayChannelEditor",
    ):
        assert marker in html

    assert "新增必填；编辑时留空保留原 Key" in html
    assert "Key 只提交到服务端，编辑时留空表示保留原 Key" in html
    assert "用户与授权" in html
    assert "模型服务" in html
    assert "资金中心" in html
    assert 'id="fundsTables"' in html
    assert 'id="modelPricingContainer"' in html
    assert "function arrangeBusinessSections" in html
    assert ">余额与模型<" not in html
    assert ">模型渠道<" not in html
    assert "优先级（越大越优先）" in html
    assert "gatewayChannelWeight" not in html
    assert '<details id="gatewayModelPicker"' not in html
    assert "选择这个渠道可以承接的模型" in html
    assert "保存后立即启用，并自动停用同模型旧版本" in html
    assert "历史账单仍使用原价格" in html
    assert "模型 / 版本" not in html
    assert "版本 v${p.version}" not in html
    assert "#modelPriceTable { min-width: 980px; table-layout: fixed; }" in html
    assert 'class="media-rate-list"' in html
    assert "仅保存</option>" not in html
    assert "获取官方价格" in html
    assert "销售倍率" in html
    assert "缓存命中费率" in html
    assert "function formatRmbInput" in html
    assert "Coding Plan；它按调用次数结算" in html
    assert "userBalanceCard.hidden = true" in html
    assert "append(paymentCard, reconciliationCard, uncertainCard)" in html
    assert "在一个账户视图中管理身份、授权、订阅和人民币余额" in html
    assert "sessionStorage.setItem('admin_token', token)" in html
    assert "localStorage.setItem('admin_token', token)" not in html


def test_admin_pricing_preserves_period_and_renewal_configuration(client, db):
    admin = User(
        email="pricing-ui-admin@example.com",
        account="pricing-ui-admin",
        password_hash="x",
        is_admin=True,
    )
    db.add(admin)
    db.commit()
    token, _ = create_access_token(admin.id)
    response = client.put(
        "/admin/pricing",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "plans": [
                {
                    "id": "yearly",
                    "name": "年度订阅",
                    "price": 288,
                    "original_price": 348,
                    "duration_months": 12,
                    "period_days": 365,
                    "auto_renewable": False,
                    "badge": "推荐",
                    "sort_order": 1,
                    "enabled": True,
                }
            ],
            "contact": {"email": "support@example.com", "wechat": "mona_support"},
            "promotional_banner": "年度优惠",
        },
    )
    assert response.status_code == 200
    plan = db.get(PricingPlan, "yearly")
    assert plan is not None
    assert plan.period_days == 365
    assert plan.auto_renewable is False


def test_admin_user_search_accepts_account_or_email(client, db):
    admin = User(
        email="user-search-admin@example.com",
        account="user-search-admin",
        password_hash="x",
        is_admin=True,
    )
    target = User(
        email="target-email@example.com",
        account="target-account",
        password_hash="x",
    )
    db.add_all([admin, target])
    db.commit()
    db.add(
        CreditWallet(
            user_id=target.id,
            available_units=12_500_000,
            reserved_units=750_000,
            active_requests=2,
        )
    )
    db.commit()
    token, _ = create_access_token(admin.id)
    headers = {"Authorization": f"Bearer {token}"}
    by_account = client.get(
        "/admin/users",
        params={"search": "target-account"},
        headers=headers,
    )
    by_email = client.get(
        "/admin/users",
        params={"search": "target-email"},
        headers=headers,
    )
    assert [item["id"] for item in by_account.json()["users"]] == [target.id]
    assert [item["id"] for item in by_email.json()["users"]] == [target.id]
    account = by_account.json()["users"][0]
    assert account["available_balance"] == "12.5"
    assert account["reserved_balance"] == "0.75"
    assert account["active_requests"] == 2
    assert account["wallet_updated_at"]
