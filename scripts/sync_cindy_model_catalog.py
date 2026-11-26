#!/usr/bin/env python3
"""Build Mona's offline model catalog from an explicitly supplied Cindy checkout.

The source metadata and hashes are embedded in the output. Cindy attribution is
in mona/development/CINDY-NOTICE; this script never accesses the network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "mona" / "providers" / "catalog" / "model-capabilities.json"
CATALOG_DIR = Path("packages/model-providers/catalog")
MANUFACTURERS = {
    "ant-ling",
    "anthropic",
    "deepseek",
    "google",
    "minimax",
    "minimax-cn",
    "mistral",
    "moonshotai",
    "moonshotai-cn",
    "openai",
    "xai",
    "xiaomi",
}
PI_PRESET_IDS = {
    "anthropic": "anthropic-api", "openai": "openai-api", "xai": "xai-api",
    "google": "google-gemini-api", "openai-codex": "openai",
    "minimax-cn": "minimax-cn", "minimax": "minimax-global",
    "moonshotai": "moonshot-kimi-global", "moonshotai-cn": "moonshot-kimi-cn",
    "kimi-coding": "moonshot-kimi-code", "zai": "zai-coding-plan-global",
    "zai-coding-cn": "zhipu-coding-plan-cn", "xiaomi": "xiaomi-mimo-api-cn",
    "xiaomi-token-plan-cn": "xiaomi-mimo-token-plan-cn",
    "qwen-token-plan-cn": "aliyun-bailian-token-plan-cn",
}
PI_LABELS = {
    "openai-api": "OpenAI API", "anthropic-api": "Anthropic API", "xai-api": "xAI API",
    "amazon-bedrock": "Amazon Bedrock", "azure-openai-responses": "Azure OpenAI",
    "google-vertex": "Google Vertex AI", "cloudflare-ai-gateway": "Cloudflare AI Gateway",
    "cloudflare-workers-ai": "Cloudflare Workers AI", "github-copilot": "GitHub Copilot",
    "ant-ling": "蚂蚁百灵", "baseten": "Baseten", "cerebras": "Cerebras",
    "fireworks": "Fireworks AI", "groq": "Groq", "huggingface": "Hugging Face",
    "nvidia": "NVIDIA NIM", "together": "Together AI", "mistral": "Mistral AI",
    "opencode": "OpenCode Zen", "qwen-token-plan": "Qwen Token Plan (Global)",
    "qwen-token-plan-individual": "Qwen Token Plan（个人版）",
    "xiaomi-token-plan-ams": "MiMo Token Plan (Amsterdam)",
    "xiaomi-token-plan-sgp": "MiMo Token Plan (Singapore)",
}
PRIVATE_PRESETS = {"sub2api", "litellm", "lmstudio", "llamacpp", "vllm", "magpie"}


def read_source(root: Path, name: str) -> tuple[dict[str, Any], str]:
    path = (root / CATALOG_DIR / name).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError(f"Source file escapes the supplied Cindy checkout: {name}")
    data = path.read_bytes()
    result = json.loads(data)
    if not isinstance(result, dict):
        raise ValueError(f"Invalid catalog: {name}")
    return result, hashlib.sha256(data).hexdigest()


def canonical_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value or value != value.strip():
        return None
    if any(char in value for char in "{}<>*\\") or any(char.isspace() for char in value):
        return None
    try:
        url = urlsplit(value)
        if (
            url.scheme.lower() not in {"http", "https"}
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
        ):
            return None
        scheme = url.scheme.lower()
        host = url.hostname.lower()
        if ":" in host:
            host = f"[{host}]"
        port = url.port
        if port is not None and port != (443 if scheme == "https" else 80):
            host += f":{port}"
        return urlunsplit((scheme, host, url.path.rstrip("/"), "", ""))
    except ValueError:
        return None


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and value == value.strip()


def metadata(row: dict[str, Any], *, route: bool) -> dict[str, Any]:
    """Copy only fields whose absence and explicit empty/false have distinct meanings."""
    result: dict[str, Any] = {}
    name = row.get("name")
    if isinstance(name, str) and name.strip():
        result["name"] = name
    window = row.get("contextWindow")
    if isinstance(window, int) and not isinstance(window, bool) and window > 0:
        result["context_window"] = window
    efforts = row.get("efforts")
    if isinstance(efforts, list) and all(isinstance(item, str) and item for item in efforts):
        result["reasoning_efforts"] = efforts
    default = row.get("defaultEffort")
    if isinstance(default, str) and default:
        result["default_reasoning_effort"] = default
    elif "defaultEffort" in row and default is None:
        # Keep an explicit null until higher and lower reference layers merge.
        result["default_reasoning_effort"] = None
    modalities = row.get("modalities")
    inputs = modalities.get("input") if isinstance(modalities, dict) else None
    if isinstance(inputs, list) and all(isinstance(item, str) and item for item in inputs):
        result["input_modalities"] = inputs
    elif isinstance(row.get("supportsImageInput"), bool):
        result["supports_image_input"] = row["supportsImageInput"]

    execution = row.get("execution")
    pi = execution.get("pi", {}) if isinstance(execution, dict) else {}
    if not isinstance(pi, dict):
        pi = {}
    api = pi.get("api") if route or pi else row.get("nativeApi")
    if isinstance(api, str) and api:
        result["wire_api"] = api
    if not route:
        return result

    compat = pi.get("compat")
    compat = compat if isinstance(compat, dict) else {}
    thinking_format = compat.get("thinkingFormat")
    if isinstance(thinking_format, str) and thinking_format:
        result["thinking_format"] = thinking_format
    if isinstance(compat.get("supportsReasoningEffort"), bool):
        result["supports_reasoning_effort"] = compat["supportsReasoningEffort"]
    level_map = pi.get("thinkingLevelMap")
    if isinstance(level_map, dict) and all(
        isinstance(key, str) and (value is None or isinstance(value, str))
        for key, value in level_map.items()
    ):
        result["thinking_level_map"] = dict(sorted(level_map.items()))
    template = compat.get("chatTemplateArgs")
    if isinstance(template, dict) and template:
        result["chat_template_args"] = template
    if isinstance(row.get("thinkingToggle"), bool):
        result["thinking_toggle"] = row["thinkingToggle"]
    if compat.get("forceAdaptiveThinking") is True:
        result["supports_adaptive_thinking"] = True
    return clean_metadata(result)


def clean_metadata(values: dict[str, Any]) -> dict[str, Any]:
    default = values.get("default_reasoning_effort")
    efforts = values.get("reasoning_efforts")
    if default is None or (isinstance(efforts, list) and default not in efforts):
        values.pop("default_reasoning_effort", None)
    return values


def signature(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def preset_metadata(row: dict[str, Any]) -> dict[str, Any]:
    """Project an explicit Pi preset model without turning defaults into user edits."""
    engine = row.get("engineOverrides")
    pi = engine.get("pi", {}) if isinstance(engine, dict) else {}
    pi = pi if isinstance(pi, dict) else {}
    fields = {**row, **pi}
    if fields.get("reasoning") is False:
        fields["efforts"] = []
    elif "reasoningEfforts" in fields:
        fields["efforts"] = fields["reasoningEfforts"]
    if "reasoningDefaultEffort" in fields:
        fields["defaultEffort"] = fields["reasoningDefaultEffort"]
    return metadata(fields, route=False)


def api_name(wire: Any, agent: str = "pi") -> str:
    if wire == "openai-chat":
        return "openai-completions"
    if isinstance(wire, str) and wire:
        return wire
    return "openai-responses" if agent == "codex" else "anthropic-messages" if agent == "claude-code" else "openai-completions"


def registry_metadata(row: dict[str, Any]) -> dict[str, Any]:
    values = metadata(row, route=False)
    if isinstance(row.get("nativeApi"), str):
        # This is the manufacturer's API, not the transport of a particular route.
        values.pop("wire_api", None)
        values["native_api"] = row["nativeApi"]
    return values


def choose_runtime(preset: dict[str, Any]) -> tuple[dict[str, Any], str]:
    runtimes = preset.get("runtimes", {})
    choices = [(agent, runtimes[agent]) for agent in ("pi", "codex", "claude-code")
               if isinstance(runtimes.get(agent), dict)]
    for agent, runtime in choices:
        if api_name(runtime.get("wireProtocol"), agent) == "openai-completions":
            return runtime, "openai-completions"
    if choices:
        agent, runtime = choices[0]
        return runtime, api_name(runtime.get("wireProtocol"), agent)
    return {}, "openai-completions"


def registry_routes(registry: dict[str, Any]) -> tuple[dict[str, dict], list[dict[str, str]]]:
    bases = {row["id"]: row for row in registry.get("baseModels", [])
             if isinstance(row, dict) and valid_id(row.get("id"))}
    candidates: dict[tuple[str, str], dict[str, dict]] = defaultdict(dict)
    for entry in registry.get("models", []):
        if not isinstance(entry, dict):
            continue
        base = bases.get(entry.get("modelRef"), {})
        for route in entry.get("routes", []):
            if not isinstance(route, dict) or not valid_id(route.get("providerId")) or not valid_id(route.get("modelId")):
                continue
            defaults = {**registry_metadata(base.get("defaults", {})),
                        **registry_metadata(entry),
                        **registry_metadata(route.get("defaults", {}))}
            base_defaults = registry_metadata(base.get("defaults", {}))
            entry_defaults = registry_metadata(entry)
            route_defaults = registry_metadata(route.get("defaults", {}))
            per_agent = {agent: registry_metadata(value)
                         for agent, value in entry.get("perAgent", {}).items()
                         if isinstance(value, dict)}
            value = {
                "defaults": defaults,
                "base_defaults": base_defaults,
                "entry_defaults": entry_defaults,
                "route_defaults": route_defaults,
                **({"model_ref": entry["modelRef"]} if valid_id(entry.get("modelRef")) else {}),
                **({"per_agent": per_agent} if per_agent else {}),
                **({"force_overrides": registry_metadata(route["forceOverrides"])}
                   if isinstance(route.get("forceOverrides"), dict) else {}),
            }
            key = (route["providerId"], route["modelId"])
            candidates[key][signature(value)] = value
    result: dict[str, dict] = {}
    conflicts = []
    for (provider, model), values in sorted(candidates.items()):
        if len(values) != 1:
            conflicts.append({"provider": provider, "model": model})
            continue
        result.setdefault(provider, {})[model] = next(iter(values.values()))
    return result, conflicts


def build_presets(catalog: dict[str, Any], curated: dict[str, Any], registry: dict[str, Any]) -> tuple[list[dict], dict, dict, list]:
    sources = catalog["providers"]
    declared = curated.get("presets")
    if not isinstance(declared, list):
        raise ValueError("Cindy preset catalog is missing presets")
    registry_data, registry_conflicts = registry_routes(registry)
    pi_apis = {"anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai",
               "bedrock-converse-stream", "azure-openai-responses", "google-vertex", "mistral-conversations"}
    raw_presets = []
    ids = set()
    for preset in declared:
        if not isinstance(preset, dict) or not valid_id(preset.get("id")):
            continue
        runtime, api = choose_runtime(preset)
        # Mona already supports the official MiniMax Chat endpoint on this exact base.
        if preset["id"] in {"minimax-cn", "minimax-global"}:
            runtime = preset["runtimes"]["codex"]
            api = "openai-completions"
        source = next((key for key, value in PI_PRESET_IDS.items() if value == preset["id"]), preset["id"])
        raw_presets.append((preset, runtime, api, source, sources.get(source, [])))
        ids.add(preset["id"])

    for source, rows in sources.items():
        if source == "openai-codex" or not isinstance(rows, list) or not rows:
            continue
        groups = [(source, rows)]
        if source == "amazon-bedrock":
            origins = list(dict.fromkeys(row.get("upstream") for row in rows))
            groups = [(source if index == 0 else f"{source}-{urlsplit(origin).hostname.split('.')[1]}",
                       [row for row in rows if row.get("upstream") == origin])
                      for index, origin in enumerate(origins) if isinstance(origin, str)]
        for source_id, group in groups:
            preset_id = PI_PRESET_IDS.get(source_id, source_id)
            if preset_id in ids or not all(
                (row.get("upstream") or "https://{resource}.openai.azure.com/openai/v1").startswith("https://")
                and row.get("execution", {}).get("pi", {}).get("api") in pi_apis for row in group
            ):
                continue
            # Prefer an explicitly cataloged Chat transport when the provider offers one.
            first = next((row for row in group if row["execution"]["pi"]["api"] == "openai-completions"), group[0])
            base = first.get("upstream") or "https://{resource}.openai.azure.com/openai/v1"
            api = first["execution"]["pi"]["api"]
            if source == "mistral":
                base, api = "https://api.mistral.ai/v1", "openai-completions"
            name = PI_LABELS.get(preset_id, f"Amazon Bedrock ({preset_id.removeprefix('amazon-bedrock-')})"
                                 if preset_id.startswith("amazon-bedrock-") else preset_id)
            preset = {"id": preset_id, "name": name, "regionHint": "global", "models": []}
            raw_presets.append((preset, {"baseUrl": base, "baseUrlEditable": "{" in base}, api, source, group))
            ids.add(preset_id)
    if "nous" not in ids:
        raw_presets.append(({"id": "nous", "name": "Nous Research (Hermes)", "regionHint": "global", "models": []},
                            {"baseUrl": "https://inference-api.nousresearch.com/v1",
                             "modelsUrl": "https://inference-api.nousresearch.com/v1/models"},
                            "openai-completions", "nous", []))

    result = []
    model_defaults: dict[str, dict[str, dict]] = {}
    for preset, runtime, api, source, rows in raw_presets:
        pid = preset["id"]
        base = runtime.get("baseUrl", "")
        auth = ("aws" if source == "amazon-bedrock" else
                "google-adc" if source == "google-vertex" else
                "github-copilot" if source == "github-copilot" else
                "none" if preset.get("authMethod") == "none" else "apiKey")
        models = []
        preset_values_by_id: dict[str, dict[str, Any]] = {}
        for row in preset.get("models", []):
            if not isinstance(row, dict) or not valid_id(row.get("id")):
                continue
            overrides = row.get("engineOverrides")
            pi = overrides.get("pi", {}) if isinstance(overrides, dict) else {}
            selected = {**row, **(pi if isinstance(pi, dict) else {})}
            model_route = selected.get("route")
            model_route = model_route if isinstance(model_route, dict) else {}
            model_base = model_route.get("baseUrl") or base
            model_api = api_name(selected.get("api") or selected.get("piApi") or model_route.get("wireProtocol"))
            if not (selected.get("api") or selected.get("piApi") or model_route.get("wireProtocol")):
                model_api = api
            if source in {"opencode", "opencode-go", "google"}:
                exact = [candidate for candidate in rows if candidate.get("id") == row["id"]
                         and urlsplit(candidate.get("upstream", "")).netloc.lower() == urlsplit(base).netloc.lower()]
                if len(exact) == 1:
                    model_base = exact[0]["upstream"]
                    model_api = exact[0]["execution"]["pi"]["api"]
            item = {"id": row["id"], "wire_model_id": row["id"], **clean_metadata(preset_metadata(row)),
                    "default_enabled": row.get("defaultEnabled") is not False}
            if model_base != base:
                item["api_base"] = model_base
            if model_api != api:
                item["wire_api"] = model_api
            models.append(item)
            preset_values_by_id[row["id"]] = preset_metadata(row)
        candidates = []
        for row in rows:
            if not isinstance(row, dict) or not valid_id(row.get("id")):
                continue
            row_base = row.get("upstream") or base
            row_api = row.get("execution", {}).get("pi", {}).get("api")
            if source == "mistral":
                row_base, row_api = base, api
            # Curated providers only inherit candidates from their actual origin.
            if preset in declared and urlsplit(row_base).netloc.lower() != urlsplit(base).netloc.lower():
                continue
            item = {"id": row["id"], "wire_model_id": row["id"],
                    "name": row.get("name") or row["id"], "default_enabled": False}
            if row_base != base:
                item["api_base"] = row_base
            if row_api and row_api != api:
                item["wire_api"] = row_api
            if canonical_url(row.get("upstream")) is None:
                item["metadata"] = metadata(row, route=True)
            candidates.append(item)
        result.append({
            "id": pid, "name": preset.get("name") or pid, "api_base": base,
            "wire_api": api, "auth_method": auth, "allow_private": pid in PRIVATE_PRESETS,
            "api_base_editable": runtime.get("baseUrlEditable") is True or "{" in base,
            **({"models_url": runtime["modelsUrl"]} if runtime.get("modelsUrl") else {}),
            **({"region": preset["regionHint"]} if preset.get("regionHint") else {}),
            **({"docs_url": preset["docsUrl"]} if preset.get("docsUrl") else {}),
            "models": models, "candidates": candidates,
        })

        combined = {}
        models_by_id = {item["id"]: item for item in models}
        declarations = registry_data.get(pid, {})
        for model_id in sorted(set(preset_values_by_id) | set(declarations)):
            layers = declarations.get(model_id, {})
            preset_values = preset_values_by_id.get(model_id, {})
            selected = models_by_id.get(model_id, {})
            model_base = selected.get("api_base", base).rstrip("/")
            model_api = selected.get("wire_api", api)
            matches = {}
            for row in rows:
                if row.get("id") != model_id:
                    continue
                row_base = (row.get("upstream") or base).rstrip("/")
                row_api = row.get("execution", {}).get("pi", {}).get("api")
                if row_base != model_base or row_api != model_api:
                    continue
                exact = metadata(row, route=False)
                exact.pop("wire_api", None)
                matches[signature(exact)] = exact
            exact_values = next(iter(matches.values())) if len(matches) == 1 else {}
            values: dict[str, Any] = {}
            provenance: dict[str, str] = {}
            for layer, origin in (
                (layers.get("base_defaults", {}), "registry_base"),
                (exact_values, "exact_pi"),
                (preset_values, "preset"),
                (layers.get("entry_defaults", {}), "registry_entry"),
                (layers.get("route_defaults", {}), "registry_route"),
                (layers.get("per_agent", {}).get("pi", {}), "registry_pi"),
                (layers.get("force_overrides", {}), "registry_force"),
            ):
                values.update(layer)
                provenance.update({key: origin for key in layer})
            combined[model_id] = clean_metadata(values)
            combined[model_id]["_provenance"] = {key: provenance[key] for key in values if key in provenance}
        if combined:
            model_defaults[pid] = dict(sorted(combined.items()))
    return result, model_defaults, registry_data, registry_conflicts


def build(catalog: dict[str, Any], registry: dict[str, Any]) -> tuple[dict, dict, dict]:
    providers = catalog.get("providers")
    base_models = registry.get("baseModels")
    if not isinstance(providers, dict) or not isinstance(base_models, list):
        raise ValueError("Cindy catalogs are missing providers or baseModels")

    routes: dict[tuple[str, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    manufacturer_rows: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    manufacturer_vendors: dict[str, set[str]] = defaultdict(set)
    skipped_unusable_routes = 0
    for provider, rows in providers.items():
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict) or not valid_id(row.get("id")):
                continue
            url = canonical_url(row.get("upstream"))
            if url is None:
                skipped_unusable_routes += 1
                continue
            model_id = row["id"]
            values = metadata(row, route=True)
            routes[(url, model_id)][signature(values)] = values
            if provider in MANUFACTURERS:
                values = metadata(row, route=False)
                manufacturer_rows[model_id][signature(values)] = values
                manufacturer_vendors[model_id].add(provider.removesuffix("-cn"))

    route_output: dict[str, dict[str, dict[str, Any]]] = {}
    route_conflicts: list[dict[str, str]] = []
    for (url, model_id), candidates in sorted(routes.items()):
        if len(candidates) != 1:
            route_conflicts.append({"base_url": url, "model": model_id})
            continue
        route_output.setdefault(url, {})[model_id] = next(iter(candidates.values()))

    # A public registry alias may only refer to one declared base identity.
    identities: dict[str, list[tuple[str, dict[str, Any], list[str]]]] = defaultdict(list)
    for base in base_models:
        if not isinstance(base, dict) or not valid_id(base.get("id")):
            continue
        aliases = base.get("aliases", [])
        aliases = aliases if isinstance(aliases, list) else []
        ids = sorted({item for item in [base["id"], *aliases] if valid_id(item)})
        defaults = base.get("defaults")
        values = metadata(defaults if isinstance(defaults, dict) else {}, route=False)
        for model_id in ids:
            identities[model_id].append((base["id"], values, ids))

    references: dict[str, dict[str, Any]] = {}
    ambiguous_manufacturers = sorted(
        model_id for model_id, candidates in manufacturer_rows.items()
        if len(candidates) != 1 or len(manufacturer_vendors[model_id]) != 1
    )
    for model_id, candidates in sorted(manufacturer_rows.items()):
        if model_id not in ambiguous_manufacturers and model_id not in identities:
            references[model_id] = clean_metadata(dict(next(iter(candidates.values()))))
    ambiguous_aliases: list[str] = []
    for model_id, matches in sorted(identities.items()):
        if len({(item[0], signature(item[1])) for item in matches}) != 1:
            ambiguous_aliases.append(model_id)
            continue
        _, registry_values, ids = matches[0]
        manufacturer = {
            sig: value
            for alias in ids
            if alias not in ambiguous_manufacturers
            for sig, value in manufacturer_rows.get(alias, {}).items()
        }
        values = dict(next(iter(manufacturer.values()))) if len(manufacturer) == 1 else {}
        values.update(registry_values)
        clean_metadata(values)
        if values:
            references[model_id] = values
    return route_output, dict(sorted(references.items())), {
        "route_conflicts": route_conflicts,
        "ambiguous_registry_aliases": ambiguous_aliases,
        "ambiguous_manufacturer_references": ambiguous_manufacturers,
        "skipped_unusable_routes": skipped_unusable_routes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cindy_repo", type=Path, help="Path to a local Cindy checkout")
    parser.add_argument("--check", action="store_true", help="Check the committed asset without writing")
    args = parser.parse_args()
    root = args.cindy_repo.resolve(strict=True)
    if not root.is_dir():
        parser.error("The Cindy checkout must be a directory")
    catalog, catalog_hash = read_source(root, "provider-models.json")
    registry, registry_hash = read_source(root, "model-registry.json")
    preset_catalog, presets_hash = read_source(root, "providers.json")
    routes, references, conflicts = build(catalog, registry)
    presets, preset_models, route_registry, registry_conflicts = build_presets(
        catalog, preset_catalog, registry
    )
    data = {
        "source": {
            "origin": "Cindy packages/model-providers/catalog",
            "notice": "mona/development/CINDY-NOTICE",
            "catalog_generated_at": catalog.get("generatedAt"),
            "catalog_source": catalog.get("source"),
            "catalog_source_version": catalog.get("sourceVersion"),
            "catalog_sha256": catalog_hash,
            "registry_schema_version": registry.get("schemaVersion"),
            "registry_updated_at": registry.get("updatedAt"),
            "registry_sha256": registry_hash,
            "presets_version": preset_catalog.get("version"),
            "presets_sha256": presets_hash,
            "registry_route_conflicts": registry_conflicts,
            **conflicts,
        },
        "routes": routes,
        "references": references,
        "presets": presets,
        "preset_models": preset_models,
        "registry_routes": route_registry,
    }
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_bytes() != content.encode("utf-8"):
            raise SystemExit("Model catalog is missing or differs from the supplied Cindy checkout")
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(content.encode("utf-8"))
    print(
        f"{sum(map(len, routes.values()))} routes, {len(references)} references, {len(presets)} presets; "
        f"{len(conflicts['route_conflicts'])} conflicting routes and "
        f"{len(conflicts['ambiguous_registry_aliases'])} ambiguous aliases excluded; "
        f"{conflicts['skipped_unusable_routes']} unusable routes skipped"
    )


if __name__ == "__main__":
    main()
