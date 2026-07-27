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

_PLAN_PROMPT = """你是 Mona 的 Windows 系统维护规划助手。只依据给出的证据生成建议，不能臆造数值、软件、启动项或操作结果。

你不能执行命令，也不能建议卸载软件、删除个人文件、删除残留文件或修改系统设置。只允许提出以下三种可确认动作：
- storage_clean：清理证据中 cleanable 为 true 的缓存/临时文件 ID。
- software_update：更新证据中 updates 的软件 ID。
- startup_disable：禁用证据中 scope 为 user 且 enabled 为 true 的启动项 ID；此动作可恢复。

返回且只返回 JSON：
{{
  "summary": "一句诊断结论",
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
    raw = _json_object(response.content or "")
    hypotheses = _diagnostic_hypotheses(raw.get("hypotheses"), evidence)
    summary = raw.get("summary")
    cautions = raw.get("cautions")
    return {
        "summary": summary.strip()[:500] if isinstance(summary, str) and summary.strip() else "本机证据已经收集，尚不足以给出可靠结论。",
        "hypotheses": hypotheses,
        "cautions": [value.strip()[:300] for value in cautions if isinstance(value, str) and value.strip()][:3] if isinstance(cautions, list) else [],
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
    """Gateway endpoint for evidence-linked, read-only Windows fault diagnosis."""
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
