"""Real administrator UI check; tokens enter only through stdin.

Only an unchanged Qwen save and a reversible Codex billing-mode round trip
are allowed. Every other configuration field and all prices stay untouched.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from playwright.async_api import async_playwright, expect

ORIGIN = "https://mona-ai.cn"
MODEL_PATH = "/api/work/admin/models"
CODEX_PATH = "/api/work/admin/codex"
PRICE_PATH = "/admin/credits/model-prices"
CONFIG_FIELDS = frozenset({"label", "source", "api_base", "api_key_env", "model", "context_window_tokens",
                           "max_output_tokens", "reasoning_effort", "billing_mode", "billing_model"})
CODEX_FIELDS = frozenset({"cli_path", "model", "billing_model", "billing_mode", "label", "auth_mode",
                          "context_window_tokens", "max_output_tokens", "reasoning_effort"})


class CheckError(Exception):
    pass


def require(value, reason: str) -> None:
    if not value:
        raise CheckError(reason)


def report_path(value: Path) -> Path:
    root = (Path(__file__).resolve().parents[2] / "output" / "hosted-work").resolve()
    target = value.expanduser().resolve()
    require(target != root and target.is_relative_to(root), "invalid_output_location")
    if target.suffix.lower() == ".json":
        target.parent.mkdir(parents=True, exist_ok=True)
        require(not target.exists(), "output_already_exists")
        return target
    target.mkdir(parents=True, exist_ok=False)
    return target / "report.json"


def target_url(value: str) -> str:
    try:
        url = urlsplit(value)
        valid = (url.scheme == "https" and url.hostname == "mona-ai.cn" and url.port in (None, 443)
                 and url.username is None and url.password is None and not url.query and not url.fragment
                 and url.path in ("", "/", "/work/admin", "/work/admin/"))
    except ValueError:
        valid = False
    require(valid, "invalid_target")
    return ORIGIN + "/work/admin/"


def read_tokens() -> dict[str, str]:
    raw = sys.stdin.buffer.read(65537)
    require(len(raw) <= 65536, "invalid_credentials")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise CheckError("invalid_credentials") from None
    require(isinstance(value, dict) and set(value) == {"admin_token", "normal_token"}, "invalid_credentials")
    require(all(isinstance(value[key], str) and re.fullmatch(r"[\x21-\x7e]{1,8192}", value[key])
                for key in ("admin_token", "normal_token")), "invalid_credentials")
    require(value["admin_token"] != value["normal_token"], "invalid_credentials")
    return value


def no_secret_fields(value, tokens: dict[str, str]) -> bool:
    forbidden = {"apikey", "apikeyvalue", "secret", "password", "authorization", "accesstoken", "refreshtoken", "token"}
    if isinstance(value, dict):
        for key, item in value.items():
            name = str(key).lower().replace("_", "").replace("-", "")
            if name in forbidden or not no_secret_fields(item, tokens):
                return False
        return True
    if isinstance(value, list):
        return all(no_secret_fields(item, tokens) for item in value)
    if isinstance(value, str):
        return all(value != token and (len(token) < 20 or token not in value) for token in tokens.values())
    return True


def current_qwen(settings: dict) -> tuple[str, dict]:
    require(settings.get("synchronized") is True, "models_not_synchronized")
    billing = settings.get("billing")
    require(isinstance(billing, dict) and billing.get("mode") == "shared_wallet" and billing.get("ready") is False
            and billing.get("prices_endpoint") == PRICE_PATH and billing.get("admin_url") == "/admin", "billing_state_invalid")
    models = settings.get("models")
    require(isinstance(models, list), "invalid_models_response")
    candidates = []
    for row in models:
        require(isinstance(row, dict) and isinstance(row.get("configuration"), dict), "invalid_models_response")
        config = row["configuration"]
        require(set(config) == CONFIG_FIELDS and config.get("source") == "mona", "unexpected_model_fields")
        if "qwen" in " ".join(str(config.get(key, "")) for key in ("label", "model")).lower() or "qwen" in str(row.get("id", "")).lower():
            candidates.append(row)
    require(bool(candidates), "qwen_not_found")
    selected = candidates[0]
    model_id, config = selected.get("id"), selected["configuration"]
    require(isinstance(model_id, str) and re.fullmatch(r"[a-z0-9_-]{1,64}", model_id), "invalid_model_id")
    require(selected.get("credentials") == {"configured": True}, "qwen_credential_not_loaded")
    require(config["billing_mode"] == "free" and isinstance(config["billing_model"], str)
            and selected.get("availability", {}).get("ready") is True, "qwen_state_unexpected")
    require(all(isinstance(config[key], str) and config[key] and config[key] == config[key].strip()
                for key in ("label", "model", "api_base", "api_key_env")), "unsafe_model_configuration")
    require(re.fullmatch(r"MONA_WORK_MODEL_[A-Z0-9_]+", config["api_key_env"]), "unsafe_model_configuration")
    require(type(config["max_output_tokens"]) is int and 256 <= config["max_output_tokens"] <= 32768,
            "unsafe_model_configuration")
    cap, effort = config["context_window_tokens"], config["reasoning_effort"]
    require(cap is None or type(cap) is int and 4096 <= cap <= 2_000_000, "unsafe_model_configuration")
    require(effort is None or isinstance(effort, str) and bool(effort) and effort == effort.strip(),
            "unsafe_model_configuration")
    try:
        parsed = httpx.URL(config["api_base"])
        normalized = str(parsed).rstrip("/")
    except (ValueError, httpx.InvalidURL):
        raise CheckError("unsafe_model_configuration") from None
    require(normalized == config["api_base"] and parsed.scheme == "https" and not parsed.username
            and not parsed.password and not parsed.query and not parsed.fragment, "unsafe_model_configuration")
    return model_id, dict(config)


def latest_price(value: dict) -> dict:
    entries = value.get("prices")
    require(isinstance(entries, list), "price_response_invalid")
    candidates = [item for item in entries if isinstance(item, dict) and item.get("billing_type") == "token"
                  and item.get("enabled") is True and isinstance(item.get("model"), str)
                  and re.fullmatch(r"[A-Za-z0-9._:/-]{1,128}", item["model"])
                  and type(item.get("version")) is int and item["version"] >= 0
                  and all(isinstance(item.get(key), str) and re.fullmatch(r"\d+(?:\.\d+)?", item[key])
                          for key in ("input_amount_per_million", "cached_input_amount_per_million", "output_amount_per_million"))]
    require(bool(candidates), "no_enabled_token_price")
    model = candidates[0]["model"]
    return max((item for item in candidates if item["model"] == model), key=lambda item: item["version"])


class RoleGuard:
    """Permit only the recorded configuration and a reversible Codex mode change."""

    def __init__(self, tokens: dict[str, str]):
        self.tokens = tokens
        self.model_id: str | None = None
        self.model_configuration: dict | None = None
        self.codex_configuration: dict | None = None
        self.initial_revision: str | None = None
        self.revision: str | None = None
        self.stage = "read"
        self.counts = {"anonymous_model": 0, "normal_model": 0, "anonymous_codex": 0, "normal_codex": 0,
                       "model_save": 0, "codex_free": 0, "codex_restore": 0, "cas": 0}
        self.blocked_writes = 0
        self.blocked_external = 0

    async def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if parsed.scheme != "https" or parsed.hostname != "mona-ai.cn" or parsed.port not in (None, 443):
            self.blocked_external += 1
            await route.abort()
            return
        if request.method in {"GET", "HEAD"}:
            await route.continue_()
            return
        try:
            body = request.post_data_json if request.method == "PUT" and parsed.path in {MODEL_PATH, CODEX_PATH} else None
        except Exception:
            body = None
        auth = request.headers.get("authorization", "")
        role = ("admin" if auth == "Bearer " + self.tokens["admin_token"] else
                "normal" if auth == "Bearer " + self.tokens["normal_token"] else "anonymous" if not auth else "invalid")
        expected = None
        key = None
        if parsed.path == MODEL_PATH and self.model_configuration is not None:
            expected = {"expected_revision": self.revision, "model_id": self.model_id,
                        "configuration": self.model_configuration}
            if self.stage == "roles" and role in {"anonymous", "normal"}:
                key = role + "_model"
            elif self.stage == "model_save" and role == "admin":
                key = "model_save"
            elif self.stage == "cas" and role == "admin":
                expected["expected_revision"] = self.initial_revision
                key = "cas"
        elif parsed.path == CODEX_PATH and self.codex_configuration is not None:
            expected = {"expected_revision": self.revision, "configuration": self.codex_configuration}
            if self.stage == "roles" and role in {"anonymous", "normal"}:
                key = role + "_codex"
            elif self.stage == "codex_free" and role == "admin":
                expected["configuration"] = {**self.codex_configuration, "billing_mode": "free"}
                key = "codex_free"
            elif self.stage in {"codex_restore", "codex_restore_cleanup"} and role == "admin":
                key = "codex_restore"
        try:
            safe = (not parsed.query and not parsed.fragment and expected is not None
                    and json.dumps(body, sort_keys=True, ensure_ascii=False, allow_nan=False)
                    == json.dumps(expected, sort_keys=True, ensure_ascii=False, allow_nan=False))
        except (TypeError, ValueError):
            safe = False
        limit = 2 if key == "codex_restore" else 1
        if safe and key is not None and self.counts[key] < limit:
            self.counts[key] += 1
            await route.continue_()
            return
        self.blocked_writes += 1
        await route.abort()


async def api(page, path: str, token: str | None, *, body: dict | None = None) -> dict:
    return await page.evaluate("""async ({path, token, body}) => {
      const headers = {Accept: 'application/json'};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== null) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, {method: body === null ? 'GET' : 'PUT', headers,
        credentials: 'omit', cache: 'no-store', redirect: 'error',
        ...(body === null ? {} : {body: JSON.stringify(body)})});
      let value = null;
      try { value = await response.json(); } catch {}
      return {status: response.status, value};
    }""", {"path": path, "token": token, "body": body})



def codex_draft(status: dict) -> dict:
    config = status.get("configuration")
    require(isinstance(config, dict) and set(config) == CODEX_FIELDS, "codex_status_invalid")
    require(config["billing_mode"] == "wallet" and status.get("billing", {}).get("mode") == "wallet"
            and status.get("billing", {}).get("ready") is False,
            "codex_initial_billing_not_wallet")
    require(status.get("public_enabled") is False and status.get("execution", {}).get("ready") is False,
            "codex_unexpectedly_open")
    require(isinstance(config["label"], str) and config["label"] and config["label"] == config["label"].strip(),
            "codex_status_invalid")
    require(all(isinstance(config[key], str) and config[key] == config[key].strip()
                for key in ("cli_path", "model", "billing_model")), "codex_status_invalid")
    require(config["auth_mode"] in {"chatgpt", "api_key"}, "codex_status_invalid")
    require(type(config["max_output_tokens"]) is int and 256 <= config["max_output_tokens"] <= 32768,
            "codex_status_invalid")
    cap, effort = config["context_window_tokens"], config["reasoning_effort"]
    require(cap is None or type(cap) is int and 4096 <= cap <= 2_000_000, "codex_status_invalid")
    require(effort is None or isinstance(effort, str) and bool(effort) and effort == effort.strip(),
            "codex_status_invalid")
    return dict(config)


def revision(value: object) -> str:
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value), "invalid_revision")
    return value


async def select_mode(page, label: str) -> None:
    await page.get_by_role("button", name="计费方式", exact=True).click()
    await page.get_by_role("menuitem", name=label, exact=True).click()
    await expect(page.get_by_role("button", name="计费方式", exact=True)).to_contain_text(label)


async def verify_scroll(page, report: dict) -> None:
    """Use wheel events inside the actual app at desktop and compact sizes."""
    main = page.get_by_role("main")
    handle = await main.element_handle()
    require(handle is not None, "scroll_container_missing")
    for name, size in (("desktop", {"width": 1560, "height": 1000}), ("compact", {"width": 760, "height": 520})):
        await page.set_viewport_size(size)
        bounds = await main.bounding_box()
        require(bounds is not None, "scroll_container_missing")
        await page.mouse.move(bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2)
        await page.mouse.wheel(0, -50000)
        await page.wait_for_function("el => el.scrollTop <= 1", arg=handle, timeout=5000)
        metrics = await main.evaluate("el => ({height:el.clientHeight, content:el.scrollHeight, overflow:getComputedStyle(el).overflowY})")
        require(metrics["overflow"] in {"auto", "scroll"} and metrics["content"] > metrics["height"] + 20,
                "scroll_container_not_scrollable")
        await page.mouse.wheel(0, 50000)
        await page.wait_for_function("el => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 3",
                                     arg=handle, timeout=5000)
        await expect(page.get_by_role("link", name="前往管理后台设置模型价格", exact=True)).to_be_in_viewport(ratio=1)
        save = page.get_by_role("button", name="保存配置", exact=True)
        reached = False
        for _ in range(16):
            reached = await save.evaluate("""button => {
              const root = button.closest('main').getBoundingClientRect(), rect = button.getBoundingClientRect();
              return rect.top >= root.top && rect.bottom <= root.bottom;
            }""")
            if reached:
                break
            await page.mouse.wheel(0, -220)
            await page.wait_for_timeout(75)
        require(reached, "save_button_not_reachable_by_wheel")
        await expect(save).to_be_in_viewport()
        report["checks"]["wheel_scroll_" + name] = True
    await page.set_viewport_size({"width": 1560, "height": 1000})


async def check(target: str, tokens: dict[str, str], report: dict) -> None:
    guard = RoleGuard(tokens)
    errors = []
    switch = {"revision": None}
    observed = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        context = None
        page = None
        try:
            context = await browser.new_context(viewport={"width": 1560, "height": 1000}, locale="zh-CN",
                                                service_workers="block")
            await context.add_init_script("if(location.origin==='https://mona-ai.cn' && window===window.top) "
                                          "sessionStorage.setItem('admin_token', " + json.dumps(tokens["admin_token"]) + ");")
            await context.route("**/*", guard.route)

            async def block_websocket(socket):
                await socket.close()
            await context.route_web_socket("**/*", block_websocket)

            async def observe_codex_save(response):
                try:
                    if (urlsplit(response.url).path != CODEX_PATH or response.request.method != "PUT"
                            or response.status != 200 or guard.codex_configuration is None):
                        return
                    sent = response.request.post_data_json
                    free = {**guard.codex_configuration, "billing_mode": "free"}
                    if not isinstance(sent, dict) or sent.get("configuration") != free:
                        return
                    value = await response.json()
                    if value.get("configuration") == free:
                        switch["revision"] = revision(value.get("revision"))
                except Exception:
                    return

            def record_response(response):
                if urlsplit(response.url).path == CODEX_PATH and response.request.method == "PUT":
                    observed.append(asyncio.create_task(observe_codex_save(response)))
            context.on("response", record_response)
            page = await context.new_page()
            page.set_default_timeout(20000)
            page.on("pageerror", lambda _error: errors.append("pageerror"))
            report["phase"] = "load"
            response = await page.goto(target, wait_until="domcontentloaded")
            require(response is not None and response.status == 200, "admin_page_unavailable")
            await expect(page.get_by_role("heading", name="工作台模型与计费")).to_be_visible()

            settings_reply = await api(page, MODEL_PATH, tokens["admin_token"])
            codex_reply = await api(page, CODEX_PATH, tokens["admin_token"])
            prices_reply = await api(page, PRICE_PATH, tokens["admin_token"])
            require(all(reply["status"] == 200 and isinstance(reply["value"], dict)
                        for reply in (settings_reply, codex_reply, prices_reply)), "admin_api_unavailable")
            settings, codex, price_data = settings_reply["value"], codex_reply["value"], prices_reply["value"]
            require(all(no_secret_fields(item, tokens) for item in (settings, codex, price_data)), "secret_field_exposed")
            model_id, config = current_qwen(settings)
            original_codex = codex_draft(codex)
            initial_revision = revision(settings.get("revision"))
            require(revision(codex.get("revision")) == initial_revision, "configuration_changed")
            price = latest_price(price_data)
            guard.model_id, guard.model_configuration = model_id, config
            guard.codex_configuration = original_codex
            guard.initial_revision = guard.revision = initial_revision
            original_models = {item["id"]: item["configuration"] for item in settings["models"]}
            model_payload = {"expected_revision": initial_revision, "model_id": model_id, "configuration": config}
            codex_payload = {"expected_revision": initial_revision, "configuration": original_codex}
            report["checks"].update(qwen_loaded=True, qwen_explicitly_free=True, credential_loaded=True,
                                    models_synchronized=True, no_secret_fields=True, codex_public_enabled=False)
            report["safe"] = {"model_id": model_id, "price_model": price["model"], "price_version": price["version"]}

            report["phase"] = "authorization"
            guard.stage = "roles"
            for path, payload in ((MODEL_PATH, model_payload), (CODEX_PATH, codex_payload)):
                for role, token, status in (("anonymous", None, 401), ("normal", tokens["normal_token"], 403)):
                    get = await api(page, path, token)
                    put = await api(page, path, token, body=payload)
                    require(get["status"] == status and put["status"] == status, role + "_authorization_failed")
            report["checks"].update(anonymous_denied_both_routes=True, normal_denied_both_routes=True)

            report["phase"] = "scroll_and_providers"
            providers = page.get_by_role("group", name="模型提供者", exact=True)
            buttons = providers.get_by_role("button")
            await expect(buttons).to_have_count(2)
            labels = [(await buttons.nth(index).inner_text()).strip() for index in range(2)]
            require(labels == ["自定义 API", "Codex CLI"], "unexpected_providers")
            require(await page.get_by_text("免费 API 模型", exact=False).count() == 0, "fixed_free_label_present")
            await expect(page.get_by_label("平台模型标识", exact=True)).to_be_visible()
            await verify_scroll(page, report)
            report["checks"]["only_two_providers"] = True

            report["phase"] = "custom_fields_and_price"
            await page.get_by_role("button", name="新增模型", exact=True).click()
            await expect(page.get_by_role("button", name="计费方式", exact=True)).to_contain_text("共用余额")
            await expect(page.get_by_label("账务模型 ID", exact=True)).to_have_value("")
            report["checks"]["new_model_not_implicitly_free"] = True
            if await page.get_by_label("平台模型标识", exact=True).input_value() != model_id:
                await page.get_by_role("button", name="选择模型", exact=True).click()
                await page.get_by_role("menuitem", name=f"{config['label']} ({model_id})", exact=True).click()
            values = {"平台模型标识": model_id, "显示名称": config["label"], "模型 ID": config["model"],
                      "API Base URL": config["api_base"], "API Key 环境变量名称": config["api_key_env"],
                      "最大输出 token": str(config["max_output_tokens"]), "账务模型 ID": config["billing_model"],
                      "输入预算上限（可选）": "" if config["context_window_tokens"] is None else str(config["context_window_tokens"]),
                      "推理强度（可选）": config["reasoning_effort"] or ""}
            for label, value in values.items():
                await expect(page.get_by_label(label, exact=True)).to_have_value(value)
            report["phase"] = "custom_credential_and_modes"
            await expect(page.get_by_text("凭据：已加载。", exact=True)).to_be_visible()
            await expect(page.get_by_role("button", name="计费方式", exact=True)).to_contain_text("免费")
            await select_mode(page, "共用余额")
            await select_mode(page, "免费")
            billing_id = page.get_by_label("账务模型 ID", exact=True)
            report["phase"] = "shared_price_display"
            await billing_id.fill(price["model"])
            price_panel = page.get_by_role("region", name="共用模型价格", exact=True)
            await expect(price_panel.get_by_text(f"{price['model']} · 价格版本 {price['version']}", exact=True)).to_be_visible()
            for label, key in (("输入", "input_amount_per_million"), ("缓存输入", "cached_input_amount_per_million"),
                               ("输出", "output_amount_per_million")):
                value = price_panel.locator("dl > div").filter(has=page.get_by_text(label, exact=True)).locator("dd")
                await expect(value).to_have_text(f"¥{price[key]} / 百万 token")
            await billing_id.fill(config["billing_model"])
            report["checks"].update(custom_both_modes_selectable=True, existing_price_version=True,
                                    all_three_prices_match=True, price_mapping_left_unsaved=True)

            report["phase"] = "unchanged_qwen_save"
            guard.stage = "model_save"
            async with page.expect_response(lambda item: urlsplit(item.url).path == MODEL_PATH
                                            and item.request.method == "PUT") as wait:
                await page.get_by_role("button", name="保存配置", exact=True).click()
            saved = await wait.value
            require(saved.status == 200 and guard.counts["model_save"] == 1, "unchanged_save_failed")
            saved_model = await saved.json()
            require(no_secret_fields(saved_model, tokens), "secret_field_exposed")
            guard.revision = revision(saved_model.get("revision"))
            await expect(page.get_by_text("模型配置已保存。实际可用状态以服务信息为准。", exact=True)).to_be_visible()
            after = await api(page, MODEL_PATH, tokens["admin_token"])
            after_codex = await api(page, CODEX_PATH, tokens["admin_token"])
            require(after["status"] == after_codex["status"] == 200, "post_save_read_failed")
            require(after["value"].get("revision") == after_codex["value"].get("revision") == guard.revision,
                    "configuration_changed")
            require(after["value"].get("synchronized") is True
                    and {item["id"]: item["configuration"] for item in after["value"]["models"]} == original_models,
                    "runtime_configuration_changed")
            require(after_codex["value"].get("configuration") == original_codex, "codex_configuration_changed")
            report["checks"].update(unchanged_qwen_save=True, runtime_synchronized_after_save=True)

            report["phase"] = "codex_free"
            await providers.get_by_role("button", name="Codex CLI", exact=True).click()
            codex_values = {"显示名称": original_codex["label"], "模型 ID": original_codex["model"],
                            "CLI 程序路径": original_codex["cli_path"], "账务模型 ID": original_codex["billing_model"],
                            "最大输出 token": str(original_codex["max_output_tokens"]),
                            "输入预算上限（可选）": "" if original_codex["context_window_tokens"] is None else str(original_codex["context_window_tokens"]),
                            "推理强度（可选）": original_codex["reasoning_effort"] or ""}
            for label, value in codex_values.items():
                await expect(page.get_by_label(label, exact=True)).to_have_value(value)
            await expect(page.get_by_role("button", name="计费方式", exact=True)).to_contain_text("共用余额")
            await expect(page.get_by_text(codex["execution"]["message"], exact=True)).to_be_visible()
            await select_mode(page, "免费")
            guard.stage = "codex_free"
            async with page.expect_response(lambda item: urlsplit(item.url).path == CODEX_PATH
                                            and item.request.method == "PUT") as wait:
                await page.get_by_role("button", name="保存配置", exact=True).click()
            saved = await wait.value
            require(saved.status == 200 and guard.counts["codex_free"] == 1, "codex_mode_save_failed")
            saved_codex = await saved.json()
            free_codex = {**original_codex, "billing_mode": "free"}
            require(saved_codex.get("configuration") == free_codex and saved_codex.get("public_enabled") is False
                    and saved_codex.get("execution", {}).get("ready") is False
                    and saved_codex.get("billing", {}).get("mode") == "free"
                    and saved_codex.get("billing", {}).get("ready") is True, "codex_mode_not_saved_safely")
            guard.revision = switch["revision"] = revision(saved_codex.get("revision"))
            await expect(page.get_by_text("模型配置已保存。实际可用状态以服务信息为准。", exact=True)).to_be_visible()
            during = await api(page, MODEL_PATH, tokens["admin_token"])
            require(during["status"] == 200 and during["value"].get("revision") == guard.revision
                    and during["value"].get("synchronized") is True
                    and {item["id"]: item["configuration"] for item in during["value"]["models"]} == original_models,
                    "configuration_changed")
            report["checks"].update(codex_free_save=True, codex_free_not_public=True, qwen_unchanged_during_codex=True)

            report["phase"] = "codex_restore"
            await select_mode(page, "共用余额")
            guard.stage = "codex_restore"
            async with page.expect_response(lambda item: urlsplit(item.url).path == CODEX_PATH
                                            and item.request.method == "PUT") as wait:
                await page.get_by_role("button", name="保存配置", exact=True).click()
            restored = await wait.value
            require(restored.status == 200 and guard.counts["codex_restore"] == 1, "codex_restore_failed")
            restored_value = await restored.json()
            require(restored_value.get("configuration") == original_codex and restored_value.get("public_enabled") is False
                    and restored_value.get("execution", {}).get("ready") is False, "codex_restore_failed")
            guard.revision = revision(restored_value.get("revision"))
            await expect(page.get_by_text("模型配置已保存。实际可用状态以服务信息为准。", exact=True)).to_be_visible()
            report["checks"].update(codex_both_modes_selectable=True, codex_mode_roundtrip=True)

            report["phase"] = "revision"
            changed = guard.revision != initial_revision
            report["safe"]["revision_changed"] = changed
            if changed:
                guard.stage = "cas"
                stale = await api(page, MODEL_PATH, tokens["admin_token"], body=model_payload)
                require(stale["status"] == 409 and isinstance(stale["value"], dict)
                        and stale["value"].get("error") == "configuration_changed", "stale_revision_not_rejected")
                report["checks"]["stale_revision_rejected"] = True
            else:
                report["checks"]["stale_revision_rejected"] = "not_applicable_revision_unchanged"
            require(not errors and guard.blocked_writes == 0 and guard.blocked_external == 0, "unexpected_browser_activity")
            report["passed"] = True
            report["phase"] = "complete"
        finally:
            try:
                if observed:
                    try:
                        await asyncio.wait_for(asyncio.gather(*observed, return_exceptions=True), timeout=3)
                    except TimeoutError:
                        pass
                if page is not None and guard.counts["codex_free"] and guard.codex_configuration is not None:
                    restored_ok = False
                    try:
                        current = await api(page, CODEX_PATH, tokens["admin_token"])
                        if current["status"] == 200 and isinstance(current["value"], dict):
                            value = current["value"]
                            original = guard.codex_configuration
                            free = {**original, "billing_mode": "free"}
                            if (value.get("configuration") == original and value.get("public_enabled") is False
                                    and value.get("execution", {}).get("ready") is False):
                                restored_ok = True
                            elif (value.get("configuration") == free and switch["revision"] is not None
                                  and value.get("revision") == switch["revision"]):
                                guard.stage, guard.revision = "codex_restore_cleanup", switch["revision"]
                                result = await api(page, CODEX_PATH, tokens["admin_token"], body={
                                    "expected_revision": switch["revision"], "configuration": original})
                                restored_ok = (result["status"] == 200 and isinstance(result["value"], dict)
                                               and result["value"].get("configuration") == original
                                               and result["value"].get("public_enabled") is False
                                               and result["value"].get("execution", {}).get("ready") is False)
                    except Exception:
                        restored_ok = False
                    report["checks"]["codex_restored"] = restored_ok
                    if not restored_ok:
                        report["passed"] = False
                        report["restore_issue"] = "configuration_changed_or_unconfirmed"
                        raise CheckError("codex_restore_unconfirmed")
            finally:
                report.setdefault("safe", {})["guarded_write_counts"] = dict(guard.counts)
                report["safe"]["blocked_external_requests"] = guard.blocked_external
                report["safe"]["blocked_writes"] = guard.blocked_writes
                if context is not None:
                    await context.close()
                await browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Safely check the deployed hosted model administration UI")
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"production": True, "mocked_responses": False, "passed": False, "phase": "validation", "checks": {}}
    target = report_path(args.output)
    tokens = None
    try:
        url = target_url(args.url)
        tokens = read_tokens()
        asyncio.run(check(url, tokens, report))
    except CheckError as exc:
        report["passed"] = False
        report["error"] = str(exc)
    except Exception as exc:
        report["passed"] = False
        report["error"] = "check_failed"
        report["error_type"] = type(exc).__name__
    finally:
        if tokens is not None and not no_secret_fields(report, tokens):
            report = {"production": True, "mocked_responses": False, "passed": False, "error": "report_redacted"}
        with target.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(json.dumps(report, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
