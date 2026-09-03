from pathlib import Path

from mona.webui.settings_api import _migrate_workspace_data


def test_workspace_switch_copies_final_artifact_roots_but_not_runtime(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    for root_name in (
        "agent-workspaces",
        "stock_projects",
        "ppt_projects",
        "video_projects",
    ):
        source = old / root_name / "run" / "artifact.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(root_name, encoding="utf-8")
    (old / "runtime" / "agent-jobs" / "job.json").parent.mkdir(
        parents=True, exist_ok=True
    )
    (old / "runtime" / "agent-jobs" / "job.json").write_text(
        "runtime", encoding="utf-8"
    )

    _migrate_workspace_data(old, new)

    for root_name in (
        "agent-workspaces",
        "stock_projects",
        "ppt_projects",
        "video_projects",
    ):
        copied = new / root_name / "run" / "artifact.md"
        assert copied.read_text(encoding="utf-8") == root_name
    assert not (new / "runtime").exists()


def test_workspace_switch_does_not_overwrite_existing_targets(tmp_path: Path) -> None:
    old = tmp_path / "old"
    new = tmp_path / "new"
    source = old / "agent-workspaces" / "agent-a" / "output" / "report.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("old", encoding="utf-8")
    existing = new / "agent-workspaces" / "agent-a" / "output" / "report.md"
    existing.parent.mkdir(parents=True, exist_ok=True)
    existing.write_text("new", encoding="utf-8")

    _migrate_workspace_data(old, new)

    assert existing.read_text(encoding="utf-8") == "new"
