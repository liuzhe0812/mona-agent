"""Real administrator UI check; tokens enter only through stdin.

The only allowed write is an unchanged free-model configuration. All price
writes, model execution, Codex configuration and other mutations are blocked.
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
                           "max_output_tokens", "reasoning_effort"})


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
    """Permit only a single unchanged admin save and explicit auth/CAS checks."""

    def __init__(self, tokens: dict[str, str]):
        self.tokens = tokens
        self.model_id: str | None = None
        self.configuration: dict | None = None
        self.revision: str | None = None
        self.stage = "read"
        self.counts = {"anonymous": 0, "normal": 0, "admin": 0, "cas": 0}
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
            body = request.post_data_json if request.method == "PUT" and parsed.path == MODEL_PATH else None
        except Exception:
            body = None
        try:
            same_configuration = (json.dumps(body.get("configuration"), sort_keys=True, ensure_ascii=False, allow_nan=False)
                                  == json.dumps(self.configuration, sort_keys=True, ensure_ascii=False, allow_nan=False)) if isinstance(body, dict) else False
        except (TypeError, ValueError):
            same_configuration = False
        auth = request.headers.get("authorization", "")
        role = ("admin" if auth == "Bearer " + self.tokens["admin_token"] else
                "normal" if auth == "Bearer " + self.tokens["normal_token"] else "anonymous" if not auth else "invalid")
        safe = (isinstance(body, dict) and set(body) == {"expected_revision", "model_id", "configuration"}
                and not parsed.query and not parsed.fragment and body.get("model_id") == self.model_id
                and same_configuration and body.get("expected_revision") == self.revision)
        key = role if self.stage == "roles" and role in {"anonymous", "normal"} else (
              "admin" if self.stage == "save" and role == "admin" else "cas" if self.stage == "cas" and role == "admin" else None)
        if safe and key is not None and self.counts[key] == 0:
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


async def check(target: str, tokens: dict[str, str], report: dict) -> None:
    guard = RoleGuard(tokens)
    errors = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless=True)
        try:
            context = await browser.new_context(viewport={"width": 1560, "height": 1000}, locale="zh-CN",
                                                service_workers="block")
            await context.add_init_script("sessionStorage.setItem('admin_token', " + json.dumps(tokens["admin_token"]) + ");")
            await context.route("**/*", guard.route)
            async def block_websocket(socket):
                await socket.close()
            await context.route_web_socket("**/*", block_websocket)
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
            require(isinstance(settings.get("revision"), str) and re.fullmatch(r"[a-f0-9]{64}", settings["revision"]), "invalid_revision")
            require(codex.get("public_enabled") is False and isinstance(codex.get("billing"), dict)
                    and codex["billing"].get("ready") is False, "codex_unexpectedly_open")
            codex_configuration = codex.get("configuration")
            require(isinstance(codex_configuration, dict) and isinstance(codex_configuration.get("label"), str), "codex_status_invalid")
            price = latest_price(price_data)
            guard.model_id, guard.configuration, guard.revision = model_id, config, settings["revision"]
            original_models = {item["id"]: item["configuration"] for item in settings["models"]}
            payload = {"expected_revision": guard.revision, "model_id": model_id, "configuration": config}
            report["checks"].update(qwen_loaded=True, credential_loaded=True, models_synchronized=True,
                                    no_secret_fields=True, wallet_billing_ready=False, codex_public_enabled=False)

            report["phase"] = "authorization"
            guard.stage = "roles"
            for role, token, expected in (("anonymous", None, 401), ("normal", tokens["normal_token"], 403)):
                get = await api(page, MODEL_PATH, token)
                put = await api(page, MODEL_PATH, token, body=payload)
                require(get["status"] == expected and put["status"] == expected, role + "_authorization_failed")
                report["checks"][role + "_denied_read_and_write"] = True

            report["phase"] = "price_and_draft"
            panel = page.locator('section[aria-label="免费 API 模型配置"]')
            qwen_row = panel.locator("li").filter(has_text=f"({model_id})")
            await expect(qwen_row.get_by_text("当前服务已加载凭据。", exact=False)).to_be_visible()
            require("配置尚未同步至服务" not in await qwen_row.inner_text(), "models_not_synchronized")
            selector = panel.get_by_role("combobox", name="选择免费 API 模型")
            current_id = await panel.get_by_label("平台模型标识").input_value()
            if current_id != model_id:
                await selector.click()
                await page.get_by_role("option", name=f"{config['label']} ({model_id})").click()
            values = {"平台模型标识": model_id, "API 显示名称": config["label"], "供应商模型 ID": config["model"],
                      "API Base URL": config["api_base"], "API Key 环境变量名称": config["api_key_env"],
                      "最大输出 token": str(config["max_output_tokens"]),
                      "输入预算上限（可选）": "" if config["context_window_tokens"] is None else str(config["context_window_tokens"]),
                      "推理强度（可选）": config["reasoning_effort"] or ""}
            for label, expected in values.items():
                await expect(panel.get_by_label(label, exact=True)).to_have_value(expected)

            await page.get_by_label("账务模型 ID", exact=True).fill(price["model"])
            price_panel = page.locator('section[aria-label="共用模型价格"]')
            await expect(price_panel.get_by_text(f"{price['model']} · 价格版本 {price['version']}", exact=True)).to_be_visible()
            for label, key in (("输入", "input_amount_per_million"), ("缓存输入", "cached_input_amount_per_million"),
                               ("输出", "output_amount_per_million")):
                value = price_panel.locator("dl > div").filter(has=page.get_by_text(label, exact=True)).locator("dd")
                await expect(value).to_have_text(f"¥{price[key]} / 百万 token")
            await expect(price_panel.get_by_text("Codex 连接检测与余额计费分开；余额扣费尚未接通，Codex 未向用户开放。", exact=True)).to_be_visible()
            codex_label = page.locator("#label")
            draft_label = codex_configuration["label"][:50] + "-draft-check"
            await codex_label.fill(draft_label)
            report["checks"].update(existing_price_version=True, all_three_prices_match=True)
            report["safe"] = {"model_id": model_id, "price_model": price["model"], "price_version": price["version"]}

            report["phase"] = "unchanged_model_save"
            guard.stage = "save"
            async with page.expect_response(lambda value: urlsplit(value.url).path == MODEL_PATH
                                            and value.request.method == "PUT") as save_response:
                await panel.get_by_role("button", name="保存免费 API 配置", exact=True).click()
            saved = await save_response.value
            require(saved.status == 200 and guard.counts["admin"] == 1, "unchanged_save_failed")
            await expect(panel.get_by_text("免费 API 配置已保存。用户无需付费，凭据状态以当前服务信息为准。", exact=True)).to_be_visible()
            await expect(codex_label).to_have_value(draft_label)
            await expect(page.get_by_label("账务模型 ID", exact=True)).to_have_value(price["model"])
            after_reply = await api(page, MODEL_PATH, tokens["admin_token"])
            after_codex = await api(page, CODEX_PATH, tokens["admin_token"])
            require(after_reply["status"] == 200 and after_codex["status"] == 200, "post_save_read_failed")
            after, after_codex_value = after_reply["value"], after_codex["value"]
            require(no_secret_fields(after, tokens) and no_secret_fields(after_codex_value, tokens), "secret_field_exposed")
            require(isinstance(after.get("revision"), str) and re.fullmatch(r"[a-f0-9]{64}", after["revision"]), "invalid_revision")
            require(after.get("synchronized") is True and {item["id"]: item["configuration"] for item in after["models"]} == original_models,
                    "runtime_configuration_changed")
            require(after_codex_value.get("configuration") == codex_configuration
                    and after_codex_value.get("public_enabled") is False and after_codex_value.get("billing", {}).get("ready") is False,
                    "codex_draft_was_saved")
            report["checks"].update(unchanged_qwen_save=True, runtime_synchronized_after_save=True,
                                    codex_draft_preserved=True, codex_not_published=True)

            report["phase"] = "revision"
            changed = after.get("revision") != guard.revision
            report["safe"]["revision_changed"] = changed
            if changed:
                guard.stage = "cas"
                stale = await api(page, MODEL_PATH, tokens["admin_token"], body=payload)
                require(stale["status"] == 409 and isinstance(stale["value"], dict)
                        and stale["value"].get("error") == "configuration_changed", "stale_revision_not_rejected")
                report["checks"]["stale_revision_rejected"] = True
            else:
                report["checks"]["stale_revision_rejected"] = "not_applicable_revision_unchanged"
            require(not errors and guard.blocked_writes == 0, "unexpected_browser_activity")
            report["safe"]["blocked_external_requests"] = guard.blocked_external
            report["safe"]["guarded_write_counts"] = dict(guard.counts)
            report["passed"] = True
            report["phase"] = "complete"
            await context.close()
        finally:
            await browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Safely check the deployed hosted model administration UI")
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"production": True, "mocked_responses": False, "passed": False, "phase": "validation", "checks": {}}
    target = report_path(args.output)
    try:
        url = target_url(args.url)
        tokens = read_tokens()
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
