"""Read-only view wakeups. No task dispatch, credentials, or transcript copy."""
from __future__ import annotations

import asyncio
from uuid import uuid4


class DevelopmentUpdates:
    def __init__(self):
        self.epoch = uuid4().hex
        self.revision = 0
        self._loop = None
        self._event = None

    @property
    def version(self) -> str:
        return f"{self.epoch}:{self.revision}"

    def notify(self) -> None:
        self.revision += 1
        if self._loop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._wake)

    def _wake(self) -> None:
        if self._event is not None:
            self._event.set()
            self._event = None

    async def wait(self, version: str, seconds: float = 15) -> None:
        self._loop = asyncio.get_running_loop()
        if version == self.version:
            if self._event is None:
                self._event = asyncio.Event()
            event = self._event
            try:
                await asyncio.wait_for(event.wait(), seconds)
            except TimeoutError:
                return  # An idle heartbeat, never a failed or repeated task.
        # Batch bursts of model deltas before producing the next public snapshot.
        await asyncio.sleep(0.04)
