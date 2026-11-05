"""Reuse desktop title generation after a completed, account-owned Work turn."""
from __future__ import annotations

import asyncio
import re

from mona.hosted_work.contracts import identifier
from mona.providers.base import LLMResponse
from mona.session.webui_turns import (
    WEBUI_SESSION_METADATA_KEY,
    WEBUI_TITLE_METADATA_KEY,
    WEBUI_TITLE_USER_EDITED_METADATA_KEY,
    maybe_generate_webui_title_after_turn,
)

TITLE_TIMEOUT_SECONDS = 8
_OWNER = re.compile(r"^[a-f0-9]{64}$")


class _TitleProvider:
    def __init__(self, provider):
        self.provider = provider

    async def chat_with_retry(self, *args, **kwargs):
        response = await self.provider.chat_with_retry(*args, **kwargs)
        # Shared title cleaning operates on text. Do not project a structured
        # provider error/refusal/tool call into apparently successful title text.
        if (getattr(response, "finish_reason", None) != "stop" or getattr(response, "tool_calls", None)
                or any(getattr(response, name, None) is not None for name in
                       ("error_status_code", "error_kind", "error_type", "error_code"))):
            return LLMResponse(content=None, finish_reason="error")
        return response


async def update_title(ctx, payload: dict, provider, emit) -> bool:
    """Call after the main turn's completed history is saved; never spawn work.

    All storage goes through the already scoped context adapter. The caller
    publishes the updated context after this helper, in history -> context order.
    Title failure is optional metadata failure, never a failed completed turn.
    """
    owner = payload.get("owner")
    if (payload.get("desktop_ui") is not True or not isinstance(owner, str) or not _OWNER.fullmatch(owner)
            or getattr(ctx, "_runtime", None) is None):
        return False
    try:
        sid, rid = identifier(payload.get("session_id")), identifier(payload.get("run_id"))
        if (ctx.owner != owner or ctx.session_id != sid or ctx.session.key != "websocket:" + sid
                or ctx.payload.get("run_id") != rid or ctx.payload.get("owner") != owner
                or ctx.sessions.get_or_create(ctx.session.key) is not ctx.session):
            return False
        metadata = ctx.session.metadata
        changed = metadata.get(WEBUI_SESSION_METADATA_KEY) is not True
        metadata[WEBUI_SESSION_METADATA_KEY] = True
        if payload.get("title_user_edited") is True:
            changed = changed or metadata.get(WEBUI_TITLE_USER_EDITED_METADATA_KEY) is not True
            metadata[WEBUI_TITLE_USER_EDITED_METADATA_KEY] = True
        if changed:
            ctx.sessions.save(ctx.session)
        async with asyncio.timeout(TITLE_TIMEOUT_SECONDS):
            generated = await maybe_generate_webui_title_after_turn(
                channel="websocket", metadata={WEBUI_SESSION_METADATA_KEY: True}, sessions=ctx.sessions,
                session_key=ctx.session.key, provider=_TitleProvider(provider), model=ctx.selection.model)
            if generated:
                await emit("title", {"title": metadata[WEBUI_TITLE_METADATA_KEY]})
            return generated
    except asyncio.CancelledError:
        raise
    except Exception:
        return False
