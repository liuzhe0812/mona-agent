"""Verify the real provider catalog and reversible per-model price UI."""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import runpy
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from playwright.async_api import async_playwright, expect

helpers = runpy.run_path(str(Path(__file__).with_name("independent-pricing-browser-check.py")))
CheckError, require, api, revision = (helpers[name] for name in ("CheckError", "require", "api", "revision"))
MODEL_PATH = "/api/work/admin/models"
CODEX_PATH = "/api/work/admin/codex"
DISCOVER_PATH = "/api/work/admin/models/discover"
PRICE_PATH = "/admin/credits/model-prices"
PRICE_FIELDS = {"输入价格": "input_amount_per_million", "缓存输入价格": "cached_input_amount_per_million",
                "输出价格": "output_amount_per_million"}


class Guard:
    def __init__(self, tokens: dict, vendor: dict):
        self.tokens, self.vendor = tokens, vendor
        self.expected = None
        self.counts: dict[str, int] = {}
        self.blocked_writes = 0
        self.blocked_external = 0
        self.forbidden_price_requests = 0

    def arm(self, name: str, role: str, body: dict) -> None:
        self.expected = (name, role, copy.deepcopy(body))

    async def route(self, route):
        request = route.request
        url = urlsplit(request.url)
        if url.scheme != "https" or url.hostname != "mona-ai.cn" or url.port not in (None, 443):
            self.blocked_external += 1
            await route.abort()
            return
        if url.path.startswith(PRICE_PATH):
            self.forbidden_price_requests += 1
            await route.abort()
            return
        if request.method in {"GET", "HEAD"}:
            await route.continue_()
            return
        auth = request.headers.get("authorization", "")
        role = ("admin" if auth == "Bearer " + self.tokens["admin_token"] else
                "normal" if auth == "Bearer " + self.tokens["normal_token"] else "anonymous" if not auth else "invalid")
        try:
            body = request.post_data_json
        except Exception:
            body = None
        if (request.method == "POST" and url.path == DISCOVER_PATH and not url.query and not url.fragment
                and role in {"admin", "normal", "anonymous"} and body == self.vendor):
            key = "discover_" + role
            limit = 8 if role == "admin" else 1
            if self.counts.get(key, 0) < limit:
                self.counts[key] = self.counts.get(key, 0) + 1
                await route.continue_()
                return
        if request.method == "PUT" and url.path == MODEL_PATH and self.expected and not url.query and not url.fragment:
            name, expected_role, expected = self.expected
            if role == expected_role and isinstance(body, dict):
                wanted = copy.deepcopy(expected)
                supplied = body.get("configuration")
                if isinstance(supplied, dict):
                    for field in ("billing_model", "reasoning_effort", "context_window_tokens", "max_output_tokens"):
                        if field not in supplied:
                            wanted["configuration"].pop(field, None)
                    if body == wanted and self.counts.get(name, 0) == 0:
                        self.counts[name] = 1
                        self.expected = None
                        await route.continue_()
                        return
        self.blocked_writes += 1
        await route.abort()


async def discover(page, token: str | None, body: dict) -> dict:
    return await page.evaluate("""async ({token, body}) => {
      const headers = {Accept: 'application/json', 'Content-Type': 'application/json'};
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch('/api/work/admin/models/discover', {method:'POST',headers,
        credentials:'omit',cache:'no-store',redirect:'error',body:JSON.stringify(body)});
      let value = null; try { value = await response.json(); } catch {}
      return {status:response.status,value};
    }""", {"token": token, "body": body})


async def model_snapshot(page, token: str, model_id: str) -> tuple[dict, str]:
    reply = await api(page, MODEL_PATH, token)
    require(reply["status"] == 200 and reply["value"].get("synchronized") is True, "models_unavailable")
    rows = [row for row in reply["value"].get("models", []) if row.get("id") == model_id]
    require(len(rows) == 1 and isinstance(rows[0].get("configuration"), dict), "existing_model_unavailable")
    return rows[0]["configuration"], revision(reply["value"].get("revision"))


def save_body(model_id: str, config: dict, value: str) -> dict:
    return {"expected_revision": value, "model_id": model_id, "configuration": copy.deepcopy(config)}


async def fill_price(card, price: dict | None) -> None:
    for label, key in PRICE_FIELDS.items():
        await card.get_by_label(label, exact=True).fill("" if price is None else price[key])


async def check(target: str, tokens: dict, report: dict, screenshot: Path) -> None:
    headers = {"Authorization": "Bearer " + tokens["admin_token"], "Origin": "https://mona-ai.cn"}
    async with httpx.AsyncClient(timeout=20, trust_env=False, follow_redirects=False) as client:
        response = await client.get("https://mona-ai.cn" + MODEL_PATH, headers=headers)
        require(response.status_code == 200, "admin_snapshot_unavailable")
        rows = response.json().get("models", [])
        matches = [row for row in rows if row.get("id") == "qwen"]
        require(len(matches) == 1, "existing_model_unavailable")
        config = matches[0]["configuration"]
        vendor = {"api_base": config["api_base"], "api_key_env": config["api_key_env"]}
    guard = Guard(tokens, vendor)
    page = None
    pending = None
    errors = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        context = None
        try:
            context = await browser.new_context(viewport={"width": 1440, "height": 850}, locale="zh-CN", service_workers="block")
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
            original, current_revision = await model_snapshot(page, tokens["admin_token"], "qwen")
            require(original["api_base"] == vendor["api_base"] and original["api_key_env"] == vendor["api_key_env"],
                    "configuration_changed")
            for role, token, expected in (("anonymous", None, 401), ("normal", tokens["normal_token"], 403)):
                denied = await discover(page, token, vendor)
                require(denied["status"] == expected, "authorization_failed")
            catalog = await discover(page, tokens["admin_token"], vendor)
            require(catalog["status"] == 200 and isinstance(catalog["value"].get("models"), list), "catalog_unavailable")
            ids = [item.get("id") for item in catalog["value"]["models"]]
            require(original["model"] in ids and "glm-5" in ids, "catalog_incomplete")
            report["checks"].update(actual_catalog_loaded=True, anonymous_discovery_denied=True, ordinary_discovery_denied=True)
            report["safe"] = {"provider_model_count": len(ids)}

            report["phase"] = "model_choices"
            require(await page.get_by_text("推理强度", exact=False).count() == 0, "reasoning_field_visible")
            for item in catalog["value"]["models"]:
                report["phase"] = "catalog_card_" + item["id"]
                label = original["label"] if item["id"] == original["model"] else item["label"]
                await expect(page.get_by_role("group", name="模型 " + label, exact=True)).to_be_visible(timeout=25000)
            report["phase"] = "existing_model"
            qwen = page.get_by_role("group", name="模型 " + original["label"], exact=True)
            await expect(qwen).to_be_visible(timeout=25000)
            await expect(qwen.get_by_role("checkbox", name="开放 " + original["label"], exact=True)).to_be_checked()
            other = page.get_by_role("group", name="模型 glm-5", exact=True)
            report["phase"] = "other_model_draft"
            await expect(other).to_be_visible(timeout=25000)
            await other.scroll_into_view_if_needed()
            await page.screenshot(path=str(screenshot))
            checkbox = other.get_by_role("checkbox", name="开放 glm-5", exact=True)
            await expect(checkbox).not_to_be_checked()
            await checkbox.check()
            for label in PRICE_FIELDS:
                await other.get_by_label(label, exact=True).fill("0")
            await checkbox.uncheck()
            unchanged, same_revision = await model_snapshot(page, tokens["admin_token"], "qwen")
            require(unchanged == original and same_revision == current_revision, "draft_was_saved")
            report["checks"].update(existing_model_preserved=True, selection_is_draft=True, reasoning_field_hidden=True)

            report["phase"] = "model_price"
            sample = {"input_amount_per_million": "1.234567", "cached_input_amount_per_million": "0.123456", "output_amount_per_million": "2.345678"}
            if original.get("price") == sample:
                sample = {"input_amount_per_million": "2.345678", "cached_input_amount_per_million": "0.234567", "output_amount_per_million": "3.456789"}
            changed = {**original, "price": sample}
            pending = {"original": original, "changed": changed, "confirmed_revision": None}
            await fill_price(qwen, sample)
            guard.arm("price_save", "admin", save_body("qwen", changed, current_revision))
            async with page.expect_response(lambda item: urlsplit(item.url).path == MODEL_PATH and item.request.method == "PUT") as wait:
                await qwen.get_by_role("button", name="保存 " + original["label"], exact=True).click()
            saved = await wait.value
            require(saved.status == 200, "price_save_failed")
            pending["confirmed_revision"] = current_revision = revision((await saved.json()).get("revision"))
            observed, observed_revision = await model_snapshot(page, tokens["admin_token"], "qwen")
            require(observed == changed and observed_revision == current_revision, "price_not_persisted")
            await page.reload(wait_until="domcontentloaded")
            qwen = page.get_by_role("group", name="模型 " + original["label"], exact=True)
            await expect(qwen).to_be_visible(timeout=25000)
            for label, key in PRICE_FIELDS.items():
                await expect(qwen.get_by_label(label, exact=True)).to_have_value(sample[key])
            report["checks"]["per_model_price_survives_reload"] = True
            await fill_price(qwen, original.get("price"))
            guard.arm("price_restore", "admin", save_body("qwen", original, current_revision))
            async with page.expect_response(lambda item: urlsplit(item.url).path == MODEL_PATH and item.request.method == "PUT") as wait:
                await qwen.get_by_role("button", name="保存 " + original["label"], exact=True).click()
            restored = await wait.value
            require(restored.status == 200, "price_restore_failed")
            restored_revision = revision((await restored.json()).get("revision"))
            actual, actual_revision = await model_snapshot(page, tokens["admin_token"], "qwen")
            require(actual == original and actual_revision == restored_revision, "price_restore_failed")
            pending = None
            report["checks"]["original_price_and_open_status_restored"] = True
            report["phase"] = "codex_status"
            status = await api(page, CODEX_PATH, tokens["admin_token"])
            require(status["status"] == 200 and status["value"].get("execution", {}).get("ready") is False,
                    "codex_status_unavailable")
            await page.get_by_role("button", name="Codex CLI", exact=True).click()
            discovery = status["value"].get("discovery", {})
            if discovery.get("state") == "found" and not status["value"].get("configuration", {}).get("cli_path"):
                await expect(page.get_by_label("CLI 程序路径", exact=True)).to_have_value(discovery["path"])
                report["checks"]["codex_detected_path_prefilled"] = True
            if not status["value"].get("connection", {}).get("models"):
                await expect(page.get_by_text("尚未取得 Codex 模型；请完成终端登录并检测连接。", exact=True)).to_be_visible()
                report["checks"]["codex_empty_list_honest"] = True
            require(not errors and guard.blocked_writes == 0 and guard.blocked_external == 0
                    and guard.forbidden_price_requests == 0, "unexpected_browser_activity")
            report["passed"], report["phase"] = True, "complete"
        finally:
            if page is not None and pending is not None:
                restored_ok = False
                try:
                    actual, value = await model_snapshot(page, tokens["admin_token"], "qwen")
                    if actual == pending["original"]:
                        restored_ok = True
                    elif actual == pending["changed"] and value == pending["confirmed_revision"]:
                        body = save_body("qwen", pending["original"], value)
                        guard.arm("cleanup", "admin", body)
                        result = await api(page, MODEL_PATH, tokens["admin_token"], body=body)
                        if result["status"] == 200:
                            actual, _ = await model_snapshot(page, tokens["admin_token"], "qwen")
                            restored_ok = actual == pending["original"]
                except Exception:
                    restored_ok = False
                report["checks"]["cleanup_restored"] = restored_ok
                if not restored_ok:
                    report["passed"] = False
                    report["restore_issue"] = "configuration_changed_or_unconfirmed"
            report.setdefault("safe", {}).update(guarded_write_counts=guard.counts,
                forbidden_shared_price_requests=guard.forbidden_price_requests, blocked_writes=guard.blocked_writes,
                blocked_external_requests=guard.blocked_external)
            if page is not None and not report["passed"] and pending is None:
                try:
                    await page.screenshot(path=str(screenshot.with_name("failure.png")))
                except Exception:
                    pass
            if context is not None:
                await context.close()
            await browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Safely verify automatic Work model selection")
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"production": True, "mocked_responses": False, "passed": False, "phase": "validation", "checks": {}}
    target = helpers["helpers"]["report_path"](args.output)
    try:
        url = helpers["helpers"]["target_url"](args.url)
        tokens = helpers["helpers"]["read_tokens"]()
        asyncio.run(check(url, tokens, report, target.parent / "catalog.png"))
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
