from __future__ import annotations

import multiprocessing
from pathlib import Path
from typing import Any

from mona.distill.store import (
    ProfileRevisionConflictError,
    ensure_profile_v3,
    read_rich_profile,
    update_explicit_context,
)


def _write_context_from_process(
    profile_dir: str,
    start: Any,
    results: Any,
    value: str,
) -> None:
    start.wait(10)
    try:
        update_explicit_context(
            Path(profile_dir),
            field="current_focus",
            mode="override",
            value=value,
            expected_context_revision=0,
        )
        results.put(("saved", value))
    except ProfileRevisionConflictError as exc:
        results.put(("conflict", exc.current_revision))


def test_cross_process_context_writes_preserve_json_and_revision(tmp_path: Path) -> None:
    initial = ensure_profile_v3(tmp_path)
    assert initial["facts"]["context_revision"] == 0
    ctx = multiprocessing.get_context("spawn")
    start = ctx.Event()
    results = ctx.Queue()
    processes = [
        ctx.Process(
            target=_write_context_from_process,
            args=(str(tmp_path), start, results, value),
        )
        for value in ("目标 A", "目标 B")
    ]
    for process in processes:
        process.start()
    start.set()
    for process in processes:
        process.join(15)
        assert process.exitcode == 0

    outcomes = [results.get(timeout=2)[0] for _ in processes]
    assert sorted(outcomes) == ["conflict", "saved"]
    stored = read_rich_profile(tmp_path)
    assert stored["facts"]["context_revision"] == 1
    assert stored["facts"]["explicit_context"]["current_focus"]["value"] in {
        "目标 A",
        "目标 B",
    }
