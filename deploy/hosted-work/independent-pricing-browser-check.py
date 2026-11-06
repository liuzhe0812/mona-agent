"""Production UI check with narrowly scoped, reversible price edits.

Tokens enter via stdin. The only permitted administrator writes temporarily
change one price, then restore its original value using a verified revision.
The original configuration and credentials are never written to the report.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright, expect

helpers = runpy.run_path(str(Path(__file__).with_name("model-admin-browser-check.py")))
CheckError = helpers["CheckError"]
require = helpers["require"]
api = helpers["api"]
revision = helpers["revision"]
MODEL_PATH = "/api/work/admin/models"
CODEX_PATH = "/api/work/admin/codex"
PRICE_PATH = "/admin/credits/model-prices"
AMOUNT_FIELDS = {
    "输入价格": "input_amount_per_million",
    "缓存输入价格": "cached_input_amount_per_million",
    "输出价格": "output_amount_per_million",
}


class WriteGuard:
    """Allow only a named role, recorded configuration, revision and price."""

    def __init__(self, tokens: dict):
        self.tokens = tokens
        self.expected = None
        self.counts: dict[str, int] = {}
        self.blocked_writes = 0
        self.blocked_external = 0
        self.forbidden_price_requests = 0
        self.codex_reads = 0

    def arm(self, name: str, path: str, role: str, body: dict) -> None:
        self.expected = (name, path, role, copy.deepcopy(body))

    async def route(self, route):
        request = route.request
        parsed = urlsplit(request.url)
        if parsed.scheme != "https" or parsed.hostname != "mona-ai.cn" or parsed.port not in (None, 443):
            self.blocked_external += 1
            await route.abort()
            return
        if parsed.path.startswith(PRICE_PATH):
            self.forbidden_price_requests += 1
            await route.abort()
            return
        if request.method in {"GET", "HEAD"}:
            if parsed.path == CODEX_PATH:
                self.codex_reads += 1
            await route.continue_()
            return
        auth = request.headers.get("authorization", "")
        role = ("admin" if auth == "Bearer " + self.tokens["admin_token"] else
                "normal" if auth == "Bearer " + self.tokens["normal_token"] else "anonymous" if not auth else "invalid")
        try:
            actual = request.post_data_json if request.method == "PUT" else None
        except Exception:
            actual = None
        permitted = False
        if self.expected:
            name, path, expected_role, expected = self.expected
            if parsed.path == path and role == expected_role and not parsed.query and not parsed.fragment and isinstance(actual, dict):
                # A new client may omit the obsolete billing_model; the backend
                # preserves it. All other fields must match exactly.
                actual_config = actual.get("configuration")
                expected_config = expected.get("configuration")
                if isinstance(actual_config, dict) and isinstance(expected_config, dict):
                    expected_copy = copy.deepcopy(expected)
                    if "billing_model" not in actual_config:
                        expected_copy["configuration"].pop("billing_model", None)
                    permitted = actual == expected_copy and self.counts.get(name, 0) == 0
        if permitted:
            self.counts[name] = self.counts.get(name, 0) + 1
            self.expected = None
            await route.continue_()
            return
        self.blocked_writes += 1
        await route.abort()


def body_for(path: str, config: dict, value: str, model_id: str) -> dict:
    result = {"expected_revision": value, "configuration": copy.deepcopy(config)}
    if path == MODEL_PATH:
        result["model_id"] = model_id
    return result


async def current(page, path: str, token: str, model_id: str) -> tuple[dict, str]:
    reply = await api(page, path, token)
    require(reply["status"] == 200 and isinstance(reply["value"], dict), "configuration_unavailable")
    value = reply["value"]
    if path == MODEL_PATH:
        require(value.get("synchronized") is True and isinstance(value.get("models"), list), "models_not_synchronized")
        rows = [row for row in value["models"] if isinstance(row, dict) and row.get("id") == model_id]
        require(len(rows) == 1 and isinstance(rows[0].get("configuration"), dict), "model_unavailable")
        config = rows[0]["configuration"]
    else:
        require(value.get("public_enabled") is False and value.get("execution", {}).get("ready") is False,
                "codex_unexpectedly_open")
        config = value.get("configuration")
    require(isinstance(config, dict) and config.get("billing_mode") in {"free", "wallet"}, "invalid_configuration")
    require("price" in config, "price_field_missing")
    return config, revision(value.get("revision"))


async def fill_price(page, price: dict | None) -> None:
    for label, key in AMOUNT_FIELDS.items():
        await page.get_by_label(label, exact=True).fill("" if price is None else price[key])


async def check(target: str, tokens: dict, report: dict) -> None:
    guard = WriteGuard(tokens)
    page = None
    pending: dict | None = None
    errors = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        context = None
        try:
            context = await browser.new_context(viewport={"width": 1440, "height": 800}, locale="zh-CN", service_workers="block")
            await context.add_init_script("if(location.origin==='https://mona-ai.cn' && window===window.top)sessionStorage.setItem('admin_token'," + json.dumps(tokens["admin_token"]) + ");")
            await context.route("**/*", guard.route)
            await context.route_web_socket("**/*", lambda socket: socket.close())
            page = await context.new_page()
            page.set_default_timeout(25000)
            page.on("pageerror", lambda _error: errors.append("pageerror"))
            report["phase"] = "load"
            response = await page.goto(target, wait_until="domcontentloaded")
            require(response is not None and response.status == 200, "page_unavailable")
            await expect(page.get_by_role("heading", name="工作台模型与计费", exact=True)).to_be_visible()
            model_id = "qwen"
            original_model, model_rev = await current(page, MODEL_PATH, tokens["admin_token"], model_id)
            original_codex, codex_rev = await current(page, CODEX_PATH, tokens["admin_token"], model_id)
            require(model_rev == codex_rev, "configuration_changed")
            require(original_model.get("source") == "mona", "model_unavailable")
            report["checks"].update(actual_admin_configuration_loaded=True, models_synchronized=True)

            report["phase"] = "authorization"
            for path, original in ((MODEL_PATH, original_model), (CODEX_PATH, original_codex)):
                body = body_for(path, original, model_rev, model_id)
                for role, token, expected in (("anonymous", None, 401), ("normal", tokens["normal_token"], 403)):
                    reply = await api(page, path, token)
                    guard.arm(role + path, path, role, body)
                    denied = await api(page, path, token, body=body)
                    require(reply["status"] == denied["status"] == expected, "authorization_failed")
            report["checks"].update(anonymous_denied_both_routes=True, normal_denied_both_routes=True)

            report["phase"] = "custom_price"
            providers = page.get_by_role("group", name="模型提供者", exact=True)
            await expect(providers.get_by_role("button")).to_have_count(2)
            await expect(providers.get_by_role("button", name="自定义 API", exact=True)).to_be_visible()
            await expect(providers.get_by_role("button", name="Codex CLI", exact=True)).to_be_visible()
            model_input = page.get_by_label("平台模型标识", exact=True)
            await expect(model_input).to_be_visible()
            if await model_input.input_value() != model_id:
                await page.get_by_role("button", name="选择模型", exact=True).click()
                await page.get_by_role("menuitem", name=f"{original_model['label']} ({model_id})", exact=True).click()
            await expect(model_input).to_have_value(model_id)
            main = page.get_by_role("main")
            require(await main.evaluate("el => el.scrollHeight > el.clientHeight && ['auto','scroll'].includes(getComputedStyle(el).overflowY)"),
                    "scroll_unavailable")
            samples = [
                {"input_amount_per_million": "1.234567", "cached_input_amount_per_million": "0.123456", "output_amount_per_million": "2.345678"},
                {"input_amount_per_million": "2.123456", "cached_input_amount_per_million": "0.234567", "output_amount_per_million": "3.456789"},
            ]
            current_revision = model_rev
            for index, (path, original) in enumerate(((MODEL_PATH, original_model), (CODEX_PATH, original_codex))):
                scope = "custom" if path == MODEL_PATH else "codex"
                report["phase"] = scope + "_price"
                if path == CODEX_PATH:
                    await providers.get_by_role("button", name="Codex CLI", exact=True).click()
                    initial_status = await api(page, CODEX_PATH, tokens["admin_token"])
                    require(initial_status["status"] == 200 and isinstance(initial_status["value"].get("discovery"), dict),
                            "discovery_unavailable")
                    initial_discovery = initial_status["value"]["discovery"]
                    require(initial_discovery.get("state") in {"found", "not_found"}, "discovery_invalid")
                    if not original["cli_path"] and initial_discovery["state"] == "not_found":
                        reads_before = guard.codex_reads
                        await asyncio.sleep(11.5)
                        require(guard.codex_reads > reads_before, "discovery_not_rechecked")
                        report["checks"]["discovery_automatically_rechecked"] = True
                    latest_status = await api(page, CODEX_PATH, tokens["admin_token"])
                    require(latest_status["status"] == 200, "discovery_unavailable")
                    detected = latest_status["value"]["discovery"]
                    if not original["cli_path"] and detected.get("state") == "found":
                        await expect(page.get_by_label("CLI 程序路径", exact=True)).to_have_value(detected["path"])
                        report["checks"]["detected_path_prefilled_without_saving"] = True
                    # Ensure a newly detected path does not become a persisted
                    # setting as a side effect of testing the price.
                    cli = page.get_by_label("CLI 程序路径", exact=True)
                    if not original["cli_path"]:
                        await cli.fill("/tmp/mona-qa-not-executed")
                    await cli.fill(original["cli_path"])
                for label, key in AMOUNT_FIELDS.items():
                    await expect(page.get_by_label(label, exact=True)).to_have_value("" if original["price"] is None else original["price"][key])
                sample = samples[index] if original["price"] != samples[index] else samples[1 - index]
                changed = {**original, "price": sample}
                pending = {"path": path, "scope": scope, "original": original, "changed": changed,
                           "confirmed_revision": None, "model_id": model_id}
                await fill_price(page, sample)
                guard.arm(scope + "_price_save", path, "admin", body_for(path, changed, current_revision, model_id))
                async with page.expect_response(lambda item: urlsplit(item.url).path == path and item.request.method == "PUT") as wait:
                    await page.get_by_role("button", name="保存配置", exact=True).click()
                saved = await wait.value
                require(saved.status == 200, scope + "_save_failed")
                saved_value = await saved.json()
                pending["confirmed_revision"] = current_revision = revision(saved_value.get("revision"))
                observed, observed_revision = await current(page, path, tokens["admin_token"], model_id)
                require(observed == changed and observed_revision == current_revision, scope + "_price_not_saved")
                await page.reload(wait_until="domcontentloaded")
                await expect(page.get_by_role("heading", name="工作台模型与计费", exact=True)).to_be_visible()
                if path == CODEX_PATH:
                    await providers.get_by_role("button", name="Codex CLI", exact=True).click()
                    cli = page.get_by_label("CLI 程序路径", exact=True)
                    if not original["cli_path"]:
                        await cli.fill("/tmp/mona-qa-not-executed")
                    await cli.fill(original["cli_path"])
                elif await page.get_by_label("平台模型标识", exact=True).input_value() != model_id:
                    await page.get_by_role("button", name="选择模型", exact=True).click()
                    await page.get_by_role("menuitem", name=f"{original['label']} ({model_id})", exact=True).click()
                for label, key in AMOUNT_FIELDS.items():
                    await expect(page.get_by_label(label, exact=True)).to_have_value(sample[key])
                report["checks"][scope + "_price_saved_and_survives_reload"] = True
                await fill_price(page, original["price"])
                guard.arm(scope + "_price_restore", path, "admin", body_for(path, original, current_revision, model_id))
                async with page.expect_response(lambda item: urlsplit(item.url).path == path and item.request.method == "PUT") as wait:
                    await page.get_by_role("button", name="保存配置", exact=True).click()
                restored = await wait.value
                require(restored.status == 200, scope + "_restore_failed")
                restored_value = await restored.json()
                current_revision = revision(restored_value.get("revision"))
                restored_config, observed_revision = await current(page, path, tokens["admin_token"], model_id)
                require(restored_config == original and observed_revision == current_revision, scope + "_restore_failed")
                pending = None
                report["checks"][scope + "_original_price_restored"] = True

            report["phase"] = "discovery"
            codex = await api(page, CODEX_PATH, tokens["admin_token"])
            require(codex["status"] == 200 and isinstance(codex["value"].get("discovery"), dict), "discovery_unavailable")
            discovery = codex["value"]["discovery"]
            require(discovery.get("state") in {"found", "not_found"}, "discovery_invalid")
            if discovery["state"] == "found":
                require(isinstance(discovery.get("path"), str) and discovery["path"].startswith("/"), "discovery_invalid")
            else:
                require(discovery.get("path") is None, "discovery_invalid")
            report["checks"].update(two_providers=True, price_entries_independent=True, codex_discovery_response=True)
            report["safe"] = {"codex_detected": discovery["state"] == "found"}
            require(not errors and guard.blocked_writes == 0 and guard.blocked_external == 0
                    and guard.forbidden_price_requests == 0, "unexpected_browser_activity")
            report["phase"], report["passed"] = "complete", True
        finally:
            if page is not None and pending is not None:
                restored_ok = False
                try:
                    found, found_revision = await current(page, pending["path"], tokens["admin_token"], pending["model_id"])
                    if found == pending["original"]:
                        restored_ok = True
                    elif found == pending["changed"] and found_revision == pending["confirmed_revision"]:
                        body = body_for(pending["path"], pending["original"], found_revision, pending["model_id"])
                        guard.arm(pending["scope"] + "_cleanup", pending["path"], "admin", body)
                        response = await api(page, pending["path"], tokens["admin_token"], body=body)
                        if response["status"] == 200:
                            actual, _ = await current(page, pending["path"], tokens["admin_token"], pending["model_id"])
                            restored_ok = actual == pending["original"]
                except Exception:
                    restored_ok = False
                report["checks"][pending["scope"] + "_cleanup_restored"] = restored_ok
                if not restored_ok:
                    report["passed"] = False
                    report["restore_issue"] = "configuration_changed_or_unconfirmed"
            report.setdefault("safe", {}).update(guarded_write_counts=guard.counts,
                forbidden_shared_price_requests=guard.forbidden_price_requests, blocked_writes=guard.blocked_writes,
                blocked_external_requests=guard.blocked_external)
            if context is not None:
                await context.close()
            await browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Safely verify independent Work model prices")
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"production": True, "mocked_responses": False, "passed": False, "phase": "validation", "checks": {}}
    target = helpers["report_path"](args.output)
    try:
        url = helpers["target_url"](args.url)
        tokens = helpers["read_tokens"]()
        asyncio.run(check(url, tokens, report))
    except CheckError as exc:
        report["error"] = str(exc)
    except Exception as exc:
        report["error"] = "check_failed"
        report["error_type"] = type(exc).__name__
    finally:
        with target.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(json.dumps(report, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
