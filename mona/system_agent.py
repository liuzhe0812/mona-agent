"""Read-only LLM planning for the Windows System workspace."""

from __future__ import annotations

import json
import re
from typing import Any

from aiohttp import web

from mona.providers.base import LLMProvider

_ACTION_TABS = {
    "storage_clean": "storage",
    "software_update": "software",
    "startup_disable": "startup",
}
_ACTION_RISKS = {
    "storage_clean": "low",
    "software_update": "medium",
    "startup_disable": "medium",
}
_MAX_ACTIONS = 6
_MAX_HYPOTHESES = 3
_MAX_STORAGE_FINDINGS = 5

_PLAN_PROMPT = """你是 Mona 的 Windows 系统维护规划助手。只依据给出的证据生成建议，不能臆造数值、软件、启动项或操作结果。

你不能执行命令，也不能建议卸载软件、删除个人文件、删除残留文件或修改系统设置。只允许提出以下三种可确认动作：
- storage_clean：清理证据中 cleanable 为 true 的缓存/临时文件 ID。
- software_update：更新证据中 updates 的软件 ID。
- startup_disable：禁用证据中 scope 为 user 且 enabled 为 true 的启动项 ID；此动作可恢复。

存储空间分析能力（基于证据中的 storage 字段）：
- 识别异常占用：参考 scanSummary 中的 totalFiles/totalDirs/scanDurationSecs，结合 cleanupItems 中可清理项的 sizeGb 给出可释放空间总量
- 归因分析：基于 topFileBuckets（按扩展名聚合，不含路径和文件名）识别文件类型分布，如某扩展名占比过高可指出
- 风险判断：可清理项（cleanable=true）属于低风险，可放心建议；不可清理项（cleanable=false）只能提及，不能放入 actions
- 优先级：将可释放空间最大的可清理项排在 actions 前面

返回且只返回 JSON：
{{
  "summary": "一句诊断结论，包含可释放空间总量（如适用）",
  "findings": ["最多 5 条、每条包含可追溯的证据"],
  "actions": [
    {{"type": "storage_clean | software_update | startup_disable", "targets": ["证据中的 ID"], "title": "简短操作名", "reason": "基于证据的原因", "risk": "low | medium"}}
  ]
}}

用户目标：{goal}
系统证据：
{evidence}
"""

_DIAGNOSTIC_PROMPT = """你是 Mona 的 Windows 故障诊断助手。用户遇到的问题是：{symptom}。

只依据“本机检查”中给出的证据分析，不得把相关性说成确定因果，不得编造事件、数值、驱动、错误码或修复结果。不要给出命令、注册表路径、删除操作或可执行动作。

返回且只返回 JSON：
{{
  "summary": "一句不夸大确定性的结论",
  "hypotheses": [
    {{
      "title": "可能原因",
      "confidence": "low | medium | high",
      "evidenceIds": ["本机检查中的 id"],
      "explanation": "解释这些证据为何相关，并说明不确定性",
      "nextStep": "面向普通用户、最小且安全的下一步"
    }}
  ],
  "cautions": ["最多 3 条尚不能确认或需要用户注意的边界"]
}}

至少每个 hypothesis 必须引用一个真实 evidenceIds；没有足够证据时返回空 hypotheses，并明确说明需要哪些额外信息。
本机检查：
{evidence}
"""

_STORAGE_ANALYSIS_PROMPT = """你是 Mona 的存储空间分析助手。只依据给出的脱敏扫描证据解释占用和提出下一步，不得臆造文件名、目录名、路径、大小或删除结果。

证据中的 id 是本次扫描生成的不透明标识。每条发现必须引用至少一个真实 evidenceIds。你不能执行命令或删除文件，只能选择以下建议动作：
- plan_cleanup：仅可引用 cleanupItems 中 cleanable=true 的 id，表示生成需用户确认的安全清理方案。
- review_files：仅可引用 largeFiles 的 id，表示让用户审查长期未修改或占用较大的文件。
- inspect_directory：仅可引用 scope 或 children 的 id，表示继续查看该目录证据。
- none：只解释，不产生动作。

artifactKind 是本机规则识别出的可重建内容类型，但仍不能直接断言可以删除。修改时间桶只表示时间范围，不表示文件已经无用。

返回且只返回 JSON：
{{
  "summary": "一句本次扫描结论",
  "findings": [
    {{
      "title": "简短标题",
      "detail": "说明证据、价值与不确定性",
      "confidence": "low | medium | high",
      "evidenceIds": ["真实证据 id"],
      "action": "plan_cleanup | review_files | inspect_directory | none",
      "targetIds": ["与动作类型匹配的真实 id"]
    }}
  ],
  "cautions": ["最多 3 条边界说明"]
}}

用户目标：{goal}
脱敏存储证据：
{evidence}
"""


def _json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("模型未返回可用的结构化方案") from error
    if not isinstance(value, dict):
        raise ValueError("模型未返回可用的结构化方案")
    return value


def _rows(evidence: dict[str, Any], section: str, key: str) -> list[dict[str, Any]]:
    section_value = evidence.get(section)
    if not isinstance(section_value, dict):
        return []
    value = section_value.get(key)
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _action_targets(action_type: str, evidence: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if action_type == "storage_clean":
        return {
            str(row.get("id")): row
            for row in _rows(evidence, "storage", "cleanupItems")
            if row.get("cleanable") is True and row.get("id")
        }
    if action_type == "software_update":
        return {
            str(row.get("id")): row
            for row in _rows(evidence, "software", "updates")
            if row.get("id")
        }
    if action_type == "startup_disable":
        return {
            str(row.get("id")): row
            for row in _rows(evidence, "startup", "items")
            if row.get("id") and row.get("scope") == "user" and row.get("enabled") is True
        }
    return {}


def _normalize_actions(raw_actions: Any, evidence: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(raw_actions, list):
        return []

    normalized: list[dict[str, Any]] = []
    for raw in raw_actions:
        if not isinstance(raw, dict):
            continue
        action_type = raw.get("type")
        if action_type not in _ACTION_TABS:
            continue
        targets = _action_targets(action_type, evidence)
        raw_ids = raw.get("targets")
        if not isinstance(raw_ids, list):
            continue
        target_ids = list(dict.fromkeys(str(item) for item in raw_ids if str(item) in targets))[:10]
        if not target_ids:
            continue
        names = [str(targets[item].get("name") or item) for item in target_ids]
        quoted_names = "、".join(f"「{name}」" for name in names)
        if action_type == "storage_clean":
            title = f"清理{'、'.join(names)}"
            reason = f"扫描结果显示{quoted_names}可安全清理"
        elif action_type == "software_update":
            title = f"更新{'、'.join(names)}"
            reason = f"WinGet 检测到{quoted_names}有可用更新"
        else:
            title = f"禁用{'、'.join(names)}启动项"
            reason = f"{quoted_names}当前已启用，且属于用户级启动项"
        normalized.append({
            "id": f"action-{len(normalized) + 1}",
            "type": action_type,
            "targetIds": target_ids,
            "targetNames": names,
            "title": title,
            "reason": reason,
            "risk": _ACTION_RISKS[action_type],
            "evidenceTab": _ACTION_TABS[action_type],
        })
        if len(normalized) == _MAX_ACTIONS:
            break
    return normalized


def _diagnostic_hypotheses(raw_hypotheses: Any, evidence: dict[str, Any]) -> list[dict[str, Any]]:
    checks = evidence.get("checks")
    known_ids = {
        str(check.get("id"))
        for check in checks
        if isinstance(check, dict) and check.get("id")
    } if isinstance(checks, list) else set()
    if not isinstance(raw_hypotheses, list):
        return []

    normalized: list[dict[str, Any]] = []
    for raw in raw_hypotheses:
        if not isinstance(raw, dict):
            continue
        evidence_ids = raw.get("evidenceIds")
        if not isinstance(evidence_ids, list):
            continue
        verified_ids = list(dict.fromkeys(str(value) for value in evidence_ids if str(value) in known_ids))
        title = raw.get("title")
        explanation = raw.get("explanation")
        next_step = raw.get("nextStep")
        confidence = raw.get("confidence")
        if not verified_ids or not all(isinstance(value, str) and value.strip() for value in (title, explanation, next_step)):
            continue
        normalized.append({
            "title": title.strip()[:120],
            "confidence": confidence if confidence in {"low", "medium", "high"} else "low",
            "evidenceIds": verified_ids,
            "explanation": explanation.strip()[:500],
            "nextStep": next_step.strip()[:300],
        })
        if len(normalized) == _MAX_HYPOTHESES:
            break
    return normalized


def _storage_number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return round(max(0.0, float(value)), 3)


def _sanitize_storage_evidence(evidence: dict[str, Any]) -> dict[str, Any]:
    """Whitelist compact storage evidence so paths and file names never reach the model."""

    def compact_file_types(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        return [
            {
                "category": str(row.get("category", ""))[:40],
                "sizeGb": _storage_number(row.get("sizeGb")),
            }
            for row in value[:6]
            if isinstance(row, dict) and row.get("category")
        ]

    def compact_buckets(value: Any, *, extension: bool = False) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        key = "extension" if extension else "bucket"
        return [
            {
                key: str(row.get(key, ""))[:20],
                "count": max(0, int(row.get("count", 0) or 0)),
                "sizeGb": _storage_number(row.get("sizeGb")),
            }
            for row in value[:8]
            if isinstance(row, dict) and row.get(key)
        ]

    def compact_directory(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, dict) or not value.get("id"):
            return None
        return {
            "id": str(value["id"])[:80],
            "sizeGb": _storage_number(value.get("sizeGb")),
            "fileCount": max(0, int(value.get("fileCount", 0) or 0)),
            "directSizeGb": _storage_number(value.get("directSizeGb")),
            "artifactKind": str(value.get("artifactKind", ""))[:80] or None,
            "fileTypes": compact_file_types(value.get("fileTypes")),
            "modifiedBuckets": compact_buckets(value.get("modifiedBuckets")),
            "topExtensions": compact_buckets(value.get("topExtensions"), extension=True),
        }

    scope = compact_directory(evidence.get("scope"))
    children = [
        compact
        for value in evidence.get("children", [])[:20]
        if (compact := compact_directory(value)) is not None
    ] if isinstance(evidence.get("children"), list) else []

    large_files = []
    if isinstance(evidence.get("largeFiles"), list):
        for row in evidence["largeFiles"][:20]:
            if not isinstance(row, dict) or not row.get("id"):
                continue
            large_files.append({
                "id": str(row["id"])[:80],
                "extension": str(row.get("extension", ""))[:20],
                "sizeGb": _storage_number(row.get("sizeGb")),
                "modifiedBucket": str(row.get("modifiedBucket", "unknown"))[:20],
            })

    cleanup_items = []
    if isinstance(evidence.get("cleanupItems"), list):
        for row in evidence["cleanupItems"][:20]:
            if not isinstance(row, dict) or not row.get("id"):
                continue
            cleanup_items.append({
                "id": str(row["id"])[:80],
                "name": str(row.get("name", ""))[:80],
                "sizeGb": _storage_number(row.get("sizeGb")),
                "cleanable": row.get("cleanable") is True,
                "reason": str(row.get("reason", ""))[:200],
            })

    return {
        "scanId": str(evidence.get("scanId", ""))[:100],
        "scope": scope,
        "children": children,
        "largeFiles": large_files,
        "cleanupItems": cleanup_items,
    }


def _normalize_storage_findings(raw_findings: Any, evidence: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(raw_findings, list):
        return []

    scope = evidence.get("scope")
    directories = ([scope] if isinstance(scope, dict) else []) + list(evidence.get("children", []))
    cleanup = [row for row in evidence.get("cleanupItems", []) if row.get("cleanable") is True]
    large_files = list(evidence.get("largeFiles", []))
    rows_by_id = {
        str(row["id"]): row
        for row in [*directories, *cleanup, *large_files]
        if isinstance(row, dict) and row.get("id")
    }
    allowed_targets = {
        "plan_cleanup": {str(row["id"]) for row in cleanup},
        "review_files": {str(row["id"]) for row in large_files},
        "inspect_directory": {str(row["id"]) for row in directories},
    }

    normalized = []
    for raw in raw_findings:
        if not isinstance(raw, dict):
            continue
        title = raw.get("title")
        detail = raw.get("detail")
        raw_evidence_ids = raw.get("evidenceIds")
        if not all(isinstance(value, str) and value.strip() for value in (title, detail)):
            continue
        if not isinstance(raw_evidence_ids, list):
            continue
        evidence_ids = list(dict.fromkeys(
            str(value) for value in raw_evidence_ids if str(value) in rows_by_id
        ))[:10]
        if not evidence_ids:
            continue

        action = raw.get("action")
        if action not in {"plan_cleanup", "review_files", "inspect_directory", "none"}:
            action = "none"
        raw_target_ids = raw.get("targetIds")
        target_ids = []
        if action != "none" and isinstance(raw_target_ids, list):
            target_ids = list(dict.fromkeys(
                str(value)
                for value in raw_target_ids
                if str(value) in allowed_targets[action]
            ))[:20]
        if action != "none" and not target_ids:
            action = "none"

        related_ids = target_ids or evidence_ids
        related_sizes = [
            _storage_number(rows_by_id[value].get("sizeGb"))
            for value in related_ids
            if value in rows_by_id
        ]
        related_size_gb = round(
            sum(related_sizes) if action in {"plan_cleanup", "review_files"} else max(related_sizes, default=0.0),
            3,
        )
        confidence = raw.get("confidence")
        normalized.append({
            "id": f"storage-finding-{len(normalized) + 1}",
            "title": title.strip()[:120],
            "detail": detail.strip()[:500],
            "confidence": confidence if confidence in {"low", "medium", "high"} else "low",
            "risk": {
                "plan_cleanup": "low",
                "review_files": "review",
                "inspect_directory": "review",
                "none": "keep",
            }[action],
            "evidenceIds": evidence_ids,
            "action": action,
            "targetIds": target_ids,
            "relatedSizeGb": related_size_gb,
        })
        if len(normalized) == _MAX_STORAGE_FINDINGS:
            break
    return normalized


async def generate_diagnostic_report(
    provider: LLMProvider,
    symptom: str,
    evidence: dict[str, Any],
    model: str | None = None,
) -> dict[str, Any]:
    """Generate an evidence-linked diagnosis without exposing execution capability."""
    response = await provider.chat(
        messages=[{
            "role": "user",
            "content": _DIAGNOSTIC_PROMPT.format(
                symptom=symptom[:120],
                evidence=json.dumps(evidence, ensure_ascii=False, separators=(",", ":")),
            ),
        }],
        tools=None,
        model=model,
        max_tokens=1200,
        temperature=0.1,
    )
    from mona.usage import record_provider_usage

    record_provider_usage(provider, model, response)
    raw = _json_object(response.content or "")
    hypotheses = _diagnostic_hypotheses(raw.get("hypotheses"), evidence)
    summary = raw.get("summary")
    cautions = raw.get("cautions")
    return {
        "summary": summary.strip()[:500] if isinstance(summary, str) and summary.strip() else "本机证据已经收集，尚不足以给出可靠结论。",
        "hypotheses": hypotheses,
        "cautions": [value.strip()[:300] for value in cautions if isinstance(value, str) and value.strip()][:3] if isinstance(cautions, list) else [],
    }


async def generate_storage_assessment(
    provider: LLMProvider,
    goal: str,
    evidence: dict[str, Any],
    model: str | None = None,
) -> dict[str, Any]:
    """Analyze one storage scan scope without exposing paths or execution tools."""
    sanitized = _sanitize_storage_evidence(evidence)
    response = await provider.chat(
        messages=[{
            "role": "user",
            "content": _STORAGE_ANALYSIS_PROMPT.format(
                goal=goal[:500],
                evidence=json.dumps(sanitized, ensure_ascii=False, separators=(",", ":")),
            ),
        }],
        tools=None,
        model=model,
        max_tokens=1400,
        temperature=0.1,
    )
    from mona.usage import record_provider_usage

    record_provider_usage(provider, model, response)
    raw = _json_object(response.content or "")
    findings = _normalize_storage_findings(raw.get("findings"), sanitized)
    summary = raw.get("summary")
    cautions = raw.get("cautions")
    return {
        "scanId": sanitized["scanId"],
        "summary": summary.strip()[:500] if isinstance(summary, str) and summary.strip() else "本次扫描证据已经整理完成。",
        "findings": findings,
        "cautions": [
            value.strip()[:300]
            for value in cautions
            if isinstance(value, str) and value.strip()
        ][:3] if isinstance(cautions, list) else [],
    }


async def generate_system_plan(
    provider: LLMProvider,
    goal: str,
    evidence: dict[str, Any],
    model: str | None = None,
) -> dict[str, Any]:
    """Generate a plan without exposing any tool or execution capability to the LLM."""
    response = await provider.chat(
        messages=[{
            "role": "user",
            "content": _PLAN_PROMPT.format(
                goal=goal[:500],
                evidence=json.dumps(evidence, ensure_ascii=False, separators=(",", ":")),
            ),
        }],
        tools=None,
        model=model,
        max_tokens=1200,
        temperature=0.2,
    )
    from mona.usage import record_provider_usage

    record_provider_usage(provider, model, response)
    raw = _json_object(response.content or "")
    actions = _normalize_actions(raw.get("actions"), evidence)
    return {
        "summary": f"基于当前系统证据，生成 {len(actions)} 项需确认操作。",
        "findings": [action["reason"] for action in actions[:5]],
        # ponytail: only existing, independently confirmed Tauri actions are executable.
        "actions": actions,
    }


async def handle_system_plan(request: web.Request) -> web.Response:
    """Gateway endpoint for the System sidebar's read-only planning request."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    goal = str(body.get("goal", "") or "").strip()
    evidence = body.get("evidence")
    if not goal or not isinstance(evidence, dict):
        return web.json_response({"error": "goal 和 evidence 不能为空"}, status=400)

    agent_loop = request.app.get("agent_loop")
    provider = getattr(agent_loop, "provider", None)
    if provider is None:
        return web.json_response({"error": "LLM provider 不可用"}, status=503)

    config = getattr(agent_loop, "config", None)
    model = getattr(config, "model", None) or getattr(agent_loop, "model_name", None)
    try:
        return web.json_response(await generate_system_plan(provider, goal, evidence, model=model))
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=422)
    except Exception as error:
        return web.json_response({"error": str(error)}, status=500)


async def handle_system_diagnose(request: web.Request) -> web.Response:
    """Gateway endpoint for the System sidebar's read-only diagnostic request."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    symptom = str(body.get("symptom", "") or "").strip()
    evidence = body.get("evidence")
    if not symptom or not isinstance(evidence, dict):
        return web.json_response({"error": "symptom 和 evidence 不能为空"}, status=400)

    agent_loop = request.app.get("agent_loop")
    provider = getattr(agent_loop, "provider", None)
    if provider is None:
        return web.json_response({"error": "LLM provider 不可用"}, status=503)

    config = getattr(agent_loop, "config", None)
    model = getattr(config, "model", None) or getattr(agent_loop, "model_name", None)
    try:
        return web.json_response(await generate_diagnostic_report(provider, symptom, evidence, model=model))
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=422)
    except Exception as error:
        return web.json_response({"error": str(error)}, status=500)


async def handle_storage_analyze(request: web.Request) -> web.Response:
    """Gateway endpoint for evidence-linked storage analysis."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    goal = str(body.get("goal", "") or "").strip()
    evidence = body.get("evidence")
    if not goal or not isinstance(evidence, dict) or not evidence.get("scanId"):
        return web.json_response({"error": "goal、scanId 和 evidence 不能为空"}, status=400)

    agent_loop = request.app.get("agent_loop")
    provider = getattr(agent_loop, "provider", None)
    if provider is None:
        return web.json_response({"error": "LLM provider 不可用"}, status=503)

    config = getattr(agent_loop, "config", None)
    model = getattr(config, "model", None) or getattr(agent_loop, "model_name", None)
    try:
        return web.json_response(
            await generate_storage_assessment(provider, goal, evidence, model=model)
        )
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=422)
    except Exception as error:
        return web.json_response({"error": str(error)}, status=500)
