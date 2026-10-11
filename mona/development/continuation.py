"""Code-owned continuation over the shared runner, with an append-only history."""
from __future__ import annotations

import copy
from typing import TYPE_CHECKING

from mona.development.compaction import compact_if_needed, summary_text
from mona.development.context import build_coding_messages
from mona.development.contracts import InputState
from mona.development.store import DevelopmentError

if TYPE_CHECKING:
    from mona.development.runtime import DevelopmentRuntime


class CodingContinuation:
    def __init__(self, runtime: DevelopmentRuntime, run, context, transcript, tools, provider, *, trigger_tokens=None):
        self.runtime, self.run = runtime, run
        self.context, self.transcript = context, transcript
        self.tools, self.provider = tools, provider
        self.trigger_tokens = trigger_tokens
        self.rounds: dict[int, dict] = {}
        self.spec = None
        self.initial_length = 0
        self.summary_usage: dict[str, int] = {}

    def attach(self, spec) -> None:
        self.spec = spec
        self.initial_length = len(spec.initial_messages)
        spec.model_context_callback = self.prepare
        spec.injection_callback = self.drain
        spec.strict_injections = True
        spec.max_injection_cycles = spec.max_iterations
        spec.checkpoint_callback = self.checkpoint

    def persist(self, generated: list[dict]) -> None:
        from mona.development.runtime import stable_id
        output_index = 0
        synthetic_index = 0
        changed = False
        for message in generated:
            if message.get("role") == "user":
                steering = message.get("_steering_input_id")
                if steering:
                    key = message["id"]
                    queued = self.runtime.store.get_input(steering)
                    original = next((m for m in self.transcript.messages if m.get("id") == queued.message_id), None)
                    if original is None:
                        raise DevelopmentError("missing_steering_input", "纠偏原文缺失，未继续执行。")
                    if not original.get("_input_delivered"):
                        original["_input_delivered"] = True
                        changed = True
                else:
                    key = stable_id("message", self.run.id, "runtime", str(synthetic_index))
                    synthetic_index += 1
            else:
                key = stable_id("message", self.run.id, str(output_index))
                output_index += 1
            value = {**copy.deepcopy(message), "id": key, "run_id": self.run.id, "author_id": "mona"}
            if message.get("role") == "user" and not message.get("_steering_input_id"):
                value["source_kind"] = "runtime"
            row = next((m for m in self.transcript.messages if m.get("id") == key), None)
            if row is None:
                role, text = value.pop("role"), value.pop("content", "")
                self.transcript.add_message(role, text, **value)
                changed = True
            elif any(row.get(k) != v for k, v in value.items()):
                row.update(value)
                self.transcript.update_ui_summary(row)
                changed = True
        if changed:
            self.runtime.sessions.save(self.transcript, fsync=True)

    async def checkpoint(self, event: dict) -> None:
        self.rounds[event["iteration"]] = copy.deepcopy(event)
        generated = []
        for _, row in sorted(self.rounds.items()):
            generated.append(row["assistant_message"])
            generated.extend(row.get("completed_tool_results", []))
        self.persist(generated)
        # A model response is evidence that inputs dispatched with that request
        # were observed. Reservations made after it are deliberately untouched.
        if event["phase"] in {"awaiting_tools", "final_response"}:
            from mona.development.runtime import stable_id

            completed_results = event.get("completed_tool_results") or []
            assistant_index = len(generated) - 1 - len(completed_results)
            if 0 <= assistant_index < len(generated):
                self.runtime.store.append_run_event(self.run.id, "agent.message.completed", {
                    "messageId": stable_id("message", self.run.id, str(assistant_index)),
                })
            for item in self.runtime.store.list_inputs(self.run.id):
                if item.intent == "steering" and item.state == InputState.ACCEPTED:
                    self.runtime.store.transition_input(item.id, item.revision, InputState.CONSUMED)
            live = self.runtime.live.get(self.run.session_id)
            if live and live.get("runId") == self.run.id:
                self.runtime.live.pop(self.run.session_id, None)
        self.runtime.store.append_run_event(self.run.id, "checkpoint", {"phase": event["phase"], "iteration": event["iteration"]})

    async def drain(self, *, limit: int, phase: str) -> list[dict]:
        from mona.development.runtime import stable_id
        if phase not in {"after tool execution", "after final response"}:
            return []
        async with self.runtime._lock(self.run.session_id):
            candidates = [i for i in self.runtime.store.list_inputs(self.run.id)
                          if i.intent == "steering" and i.state == InputState.PENDING]
            result = []
            for item in candidates[:min(limit, 1)]:
                row = next((m for m in self.transcript.messages if m.get("id") == item.message_id), None)
                if row is None:
                    raise DevelopmentError("missing_steering_input", "待纠偏消息正文缺失，未执行。")
                self.runtime.store.transition_input(item.id, item.revision, InputState.RESERVED)
                result.append({"role": "user", "content": copy.deepcopy(row["content"]),
                    "id": stable_id("message", self.run.id, "steering", item.id),
                    "_steering_input_id": item.id, "source_kind": "steering"})
            return result

    async def prepare(self, messages: list[dict], *, force: bool = False) -> list[dict]:
        self.persist(messages[self.initial_length:])
        session = self.runtime.store.get_session(self.run.session_id)
        compacted = await compact_if_needed(self.context, session, self.transcript,
            self.runtime.sessions, self.provider, model=self.spec.model,
            context_window_tokens=self.spec.context_window_tokens, max_output_tokens=self.spec.max_tokens,
            tools=self.tools.registry.get_definitions(), trigger_tokens=self.trigger_tokens,
            context_block_limit=self.spec.context_block_limit, allow_mid_turn=True, force=force)
        if compacted:
            self.runtime.store.append_run_event(self.run.id, "context.compacted", compacted)
            self.tools.file_states.invalidate_read_dedup()
            for key, value in compacted.get("usage", {}).items():
                if isinstance(value, int) and not isinstance(value, bool):
                    self.summary_usage[key] = self.summary_usage.get(key, 0) + value
        projected = build_coding_messages(self.context, session, self.transcript,
            summary=summary_text(self.transcript), readonly=self.tools.readonly)
        for item in self.runtime.store.list_inputs(self.run.id):
            if item.intent == "steering" and item.state == InputState.RESERVED:
                if any(m.get("_steering_input_id") == item.id for m in messages[self.initial_length:]):
                    self.runtime.store.transition_input(item.id, item.revision, InputState.ACCEPTED)
        return projected

    def settle(self) -> None:
        # Accepted without a response is not proof of consumption. After a
        # crash/cancel preserve the request for inspection, never auto-replay it.
        for item in self.runtime.store.list_inputs(self.run.id):
            if item.intent == "steering" and item.state in {InputState.RESERVED, InputState.ACCEPTED}:
                self.runtime.store.transition_input(item.id, item.revision, InputState.UNKNOWN)
