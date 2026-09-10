"""Generate one useful, personalized learning insight."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from loguru import logger

from mona.distill.base import DistillContext, DistillResult, DistillTask
from mona.distill.llm import call_json
from mona.distill.models import OneInsightAdviceOutput
from mona.distill.store import effective_context, read_rich_profile
from mona.utils.helpers import estimate_prompt_tokens_chain
from mona.utils.prompt_templates import render_template

_TASK_NAME = "advice"
_PROMPT_TEMPLATE = "distill/advice.md"


class AdviceTask(DistillTask):
    @property
    def name(self) -> str:
        return _TASK_NAME

    async def collect(self, ctx: DistillContext) -> dict[str, Any]:
        rich = read_rich_profile(ctx.memory_dir)
        evidence = dict(rich.get("evidence_index") or {})
        evidence.update(ctx.shared_data.get("evidence_index") or {})
        return {
            "rich": rich,
            "evidence_index": evidence,
            "holistic_evidence": list(ctx.shared_data.get("holistic_evidence") or []),
            "coverage": list(
                ctx.shared_data.get("coverage")
                or rich.get("dashboard", {}).get("coverage")
                or []
            ),
            "source_scope_id": ctx.shared_data.get("source_scope_id")
            or rich.get("dashboard", {}).get("source_scope_id")
            or "profile",
        }

    async def distill(self, ctx: DistillContext, data: dict[str, Any]) -> DistillResult:
        rich = data["rich"]
        evidence_index = data["evidence_index"]
        holistic_evidence = list(data.get("holistic_evidence") or [])
        if not holistic_evidence:
            holistic_evidence = [
                {
                    "ref": item.get("ref"),
                    "session_key": item.get("session_key"),
                    "title": item.get("title"),
                    "occurred_at": item.get("occurred_at"),
                    "content": item.get("excerpt"),
                }
                for item in evidence_index.values()
                if isinstance(item, dict) and item.get("kind") == "user_message"
            ]

        fingerprint = _fingerprint(
            "one-insight-v1",
            holistic_evidence,
            effective_context(rich),
            rich.get("profile", {}),
            rich.get("work_patterns", {}),
            rich.get("feedback", {}).get("advice", {}),
        )
        previous = rich.get("advice") if isinstance(rich.get("advice"), dict) else {}
        if previous.get("input_fingerprint") == fingerprint and previous.get(
            "generation_status"
        ) in {"ready", "empty"}:
            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=1.0,
                data=dict(previous),
                status="reused",
            )
        if not holistic_evidence:
            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=0.0,
                data=_empty_state(
                    previous,
                    fingerprint,
                    int(rich.get("facts", {}).get("context_revision") or 0),
                    "最近的聊天内容还不足以给出一条有把握的建议。",
                ),
                status="empty",
            )
        if ctx.provider is None:
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error="未配置可用模型，已保留上一次建议",
                status="failed",
                code="provider_unavailable",
            )

        empty_prompt = render_template(
            _PROMPT_TEMPLATE,
            effective_context=json.dumps(effective_context(rich), ensure_ascii=False),
            profile_understanding=json.dumps(rich.get("profile", {}), ensure_ascii=False),
            work_patterns=json.dumps(rich.get("work_patterns", {}), ensure_ascii=False),
            conversation_evidence="[]",
            previous_advice=json.dumps(previous.get("items", [])[:3], ensure_ascii=False),
        )
        selected = _bounded_evidence(ctx, empty_prompt, holistic_evidence)
        prompt = render_template(
            _PROMPT_TEMPLATE,
            effective_context=json.dumps(effective_context(rich), ensure_ascii=False),
            profile_understanding=json.dumps(rich.get("profile", {}), ensure_ascii=False),
            work_patterns=json.dumps(rich.get("work_patterns", {}), ensure_ascii=False),
            conversation_evidence=json.dumps(selected, ensure_ascii=False),
            previous_advice=json.dumps(previous.get("items", [])[:3], ensure_ascii=False),
        )
        try:
            parsed = await call_json(
                provider=ctx.provider,
                model_name=ctx.model_name,
                system="",
                user=prompt,
                output_model=OneInsightAdviceOutput,
                max_tokens=getattr(ctx.profile_config, "advice_max_output_tokens", 8192),
                timeout_seconds=getattr(ctx.profile_config, "llm_timeout_seconds", 120),
            )
        except TimeoutError:
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error="建议生成超时，已保留上一次结果",
                status="failed",
                code="timeout",
            )
        except Exception as exc:
            logger.warning("[advice] invalid model response: {}", exc)
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error="建议返回内容不符合约定，已保留上一次结果",
                status="failed",
                code="invalid_model_output",
            )

        if parsed.knowledge is None:
            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=0.0,
                data=_empty_state(
                    previous,
                    fingerprint,
                    int(rich.get("facts", {}).get("context_revision") or 0),
                    parsed.empty_reason,
                ),
                status="empty",
            )

        knowledge = parsed.knowledge.model_dump()
        resources = await _search_resources(
            knowledge["title"],
            [item.model_dump() for item in parsed.resources],
        )
        refs = list(
            dict.fromkeys(
                item.get("ref")
                for item in selected
                if isinstance(item.get("ref"), str) and item.get("ref") in evidence_index
            )
        )[:5]
        now = datetime.now(timezone.utc).isoformat()
        item_id = _advice_id(data["source_scope_id"], refs, knowledge["title"])
        old_items = {
            item.get("id"): item
            for item in previous.get("items", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        feedback = rich.get("feedback", {}).get("advice", {})
        items: list[dict[str, Any]] = []
        if not _inactive(feedback.get(item_id)):
            items.append(
                {
                    "id": item_id,
                    "kind": "one_insight",
                    "knowledge": knowledge,
                    "learning_advice": parsed.learning_advice,
                    "resources": resources,
                    "source_refs": refs,
                    "title": knowledge["title"],
                    "dimension": "learning",
                    "why_now": knowledge["content"],
                    "first_step": parsed.learning_advice,
                    "starter_content": parsed.learning_advice,
                    "expected_output": "",
                    "done_when": "",
                    "start_prompt": "",
                    "created_at": old_items.get(item_id, {}).get("created_at") or now,
                    "last_supported_at": _last_supported_at(refs, evidence_index) or now,
                    "source_scope_id": data["source_scope_id"],
                }
            )

        by_id = {
            item.get("id"): item
            for item in previous.get("items", [])
            if isinstance(item, dict) and item.get("id")
        }
        for item in items:
            by_id[item["id"]] = item
        retained = sorted(
            by_id.values(),
            key=lambda item: str(item.get("created_at") or ""),
            reverse=True,
        )[: getattr(ctx.profile_config, "max_advice_history", 100)]
        state = {
            "current_ids": [item["id"] for item in items],
            "items": retained,
            "generated_at": now,
            "last_attempt_at": now,
            "generation_status": "ready" if items else "empty",
            "empty_reason": "" if items else "这条建议已被你处理过。",
            "input_fingerprint": fingerprint,
            "context_revision_used": int(rich.get("facts", {}).get("context_revision") or 0),
        }
        return DistillResult(
            task_name=_TASK_NAME,
            success=True,
            confidence=1.0 if items else 0.0,
            data=state,
            status="success" if items else "empty",
        )


async def _search_resources(
    knowledge_title: str,
    suggested: list[dict[str, str]],
) -> list[dict[str, str]]:
    try:
        from mona.agent.tools.web import WebSearchTool
        from mona.config.loader import load_config, resolve_config_env_vars

        config = resolve_config_env_vars(load_config()).tools.web
        if not config.enable:
            return []
        tool = WebSearchTool(
            config=config.search.model_copy(update={"timeout": min(config.search.timeout, 12)}),
            proxy=config.proxy,
            user_agent=config.user_agent,
        )
        raw = await tool.execute(f"{knowledge_title} 入门 学习资料", count=5)
        searched = _parse_search_results(raw)
    except Exception as exc:
        logger.warning("[advice] resource search unavailable: {}", exc)
        return []

    searched_by_url = {_normalise_url(item["url"]): item for item in searched}
    selected: list[dict[str, str]] = []
    for item in suggested:
        match = searched_by_url.get(_normalise_url(str(item.get("url") or "")))
        if match is not None:
            selected.append({"title": str(item.get("title") or match["title"]), "url": match["url"]})
    for item in searched:
        if len(selected) >= 3:
            break
        if all(_normalise_url(value["url"]) != _normalise_url(item["url"]) for value in selected):
            selected.append({"title": item["title"], "url": item["url"]})
    return selected[:3]


def _parse_search_results(raw: str) -> list[dict[str, str]]:
    from mona.security.network import validate_url_target

    lines = raw.splitlines()
    resources: list[dict[str, str]] = []
    index = 0
    while index < len(lines):
        match = re.match(r"^\s*\d+\.\s+(.+?)\s*$", lines[index])
        if not match:
            index += 1
            continue
        title = match.group(1).strip()
        url = lines[index + 1].strip() if index + 1 < len(lines) else ""
        index += 2
        while index < len(lines) and not re.match(r"^\s*\d+\.\s+", lines[index]):
            index += 1
        safe, _detail = validate_url_target(url)
        parsed = urlparse(url)
        if safe and parsed.scheme in {"http", "https"} and parsed.hostname:
            resources.append({"title": title[:300], "url": url})
        if len(resources) >= 5:
            break
    return resources


def _normalise_url(value: str) -> str:
    return value.strip().rstrip("/")


def _fingerprint(*values: Any) -> str:
    raw = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _bounded_evidence(
    ctx: DistillContext,
    prompt: str,
    evidence: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    limit = getattr(ctx.profile_config, "max_input_tokens", 12000)
    selected: list[dict[str, Any]] = []
    for item in evidence:
        candidate = [*selected, item]
        estimate, _source = estimate_prompt_tokens_chain(
            ctx.provider,
            ctx.model_name or None,
            [{"role": "user", "content": prompt + json.dumps(candidate, ensure_ascii=False)}],
        )
        if estimate and estimate > limit:
            break
        selected.append(item)
    return selected


def _inactive(item: Any) -> bool:
    return isinstance(item, dict) and item.get("disposition") in {"dismissed", "completed"}


def _advice_id(source_scope_id: str, refs: list[str], title: str) -> str:
    raw = "\0".join((source_scope_id, *sorted(refs), title.strip()))
    value = uuid.uuid5(uuid.NAMESPACE_URL, f"mona:profile-advice:{raw}")
    return f"advice_{value.hex}"


def _last_supported_at(refs: list[str], evidence: dict[str, dict[str, Any]]) -> str | None:
    values: list[tuple[datetime, str]] = []
    for ref in refs:
        raw = evidence.get(ref, {}).get("occurred_at")
        if not isinstance(raw, str):
            continue
        try:
            values.append((datetime.fromisoformat(raw.replace("Z", "+00:00")), raw))
        except ValueError:
            continue
    return max(values, key=lambda item: item[0])[1] if values else None


def _empty_state(
    previous: dict[str, Any],
    fingerprint: str,
    context_revision: int,
    reason: str,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "current_ids": [],
        "items": list(previous.get("items") or []),
        "generated_at": now,
        "last_attempt_at": now,
        "generation_status": "empty",
        "empty_reason": reason,
        "input_fingerprint": fingerprint,
        "context_revision_used": context_revision,
    }


__all__ = ["AdviceTask"]
