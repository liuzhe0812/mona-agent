"""Async message queue for decoupled channel-agent communication."""

import asyncio

from mona.bus.events import InboundMessage, OutboundMessage
from mona.bus.user_questions import UserQuestions
from mona.session.work_turns import WorkTurnController


class MessageBus:
    """
    Async message bus that decouples chat channels from the agent core.

    Channels push messages to the inbound queue, and the agent processes
    them and pushes responses to the outbound queue.
    """

    def __init__(self):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()
        self.user_questions = UserQuestions(self.publish_outbound)
        self.work_turns = WorkTurnController(on_input_state=self._publish_work_input_state)

    def _publish_work_input_state(self, state: dict) -> None:
        self.outbound.put_nowait(OutboundMessage("websocket", state["chat_id"], "",
                                                metadata={"_work_input_state": state}))

    async def publish_inbound(self, msg: InboundMessage) -> bool:
        """Publish a message from a channel to the agent."""
        input_id = msg.metadata.get("input_id") if msg.channel == "websocket" else None
        if input_id and not self.work_turns.can_dispatch_input(msg.chat_id, input_id, msg.metadata.get("target_turn_id")):
            if self.work_turns.input_state(msg.chat_id, input_id) is not None:
                self.work_turns.emit_input(msg.chat_id, input_id)
            else:
                self.work_turns.reject_input(msg.chat_id, input_id, msg.metadata.get("target_turn_id"), "原任务仍在停止或等待核对，本次输入未开始执行。")
            return False
        await self.inbound.put(msg)
        if input_id:
            self.work_turns.confirm_input(msg.chat_id, input_id)
        return True

    async def consume_inbound(self) -> InboundMessage:
        """Consume the next inbound message (blocks until available)."""
        return await self.inbound.get()

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Publish a response from the agent to channels."""
        await self.outbound.put(msg)

    async def consume_outbound(self) -> OutboundMessage:
        """Consume the next outbound message (blocks until available)."""
        return await self.outbound.get()

    @property
    def inbound_size(self) -> int:
        """Number of pending inbound messages."""
        return self.inbound.qsize()

    @property
    def outbound_size(self) -> int:
        """Number of pending outbound messages."""
        return self.outbound.qsize()
