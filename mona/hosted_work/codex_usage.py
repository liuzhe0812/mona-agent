"""Accumulate native provider receipts without treating missing usage as zero."""
from __future__ import annotations


class CodexUsage:
    def __init__(self):
        self._totals = {"prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0}
        self._active = 0
        self._uncertain = False
        self._issues: set[str] = set()

    def begin(self) -> None:
        self._active += 1

    def add(self, usage: dict) -> set[str]:
        if not isinstance(usage, dict):
            self.invalidate("invalid_usage")
            return set()
        seen = set()
        for key in self._totals:
            if key not in usage:
                continue
            value = usage[key]
            if type(value) is not int or value < 0 or self._totals[key] + value > 2**63 - 1:
                self.invalidate("invalid_usage")
                continue
            self._totals[key] += value
            seen.add(key)
        return seen

    def finish(self, complete: bool, reason: str = "incomplete_receipt") -> None:
        if self._active < 1:
            self.invalidate("invalid_lifecycle")
            return
        self._active -= 1
        if not complete:
            self.invalidate(reason)

    def invalidate(self, reason: str = "unconfirmed") -> None:
        self._uncertain = True
        self._issues.add(reason)

    def diagnostics(self) -> list[str]:
        return sorted(self._issues)

    def snapshot(self) -> dict:
        return {**self._totals, "complete": not self._uncertain and self._active == 0
                and self._totals["cached_tokens"] <= self._totals["prompt_tokens"]}
