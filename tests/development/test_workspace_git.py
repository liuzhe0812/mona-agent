import asyncio
import shutil
import subprocess

import pytest

from mona.development.contracts import Project
from mona.development.review import read_review_diff
from mona.development.store import DevelopmentError
from mona.development.workspace import git_diff, git_summary


def git(root, *args):
    result = subprocess.run([shutil.which("git"), *args], cwd=root, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.asyncio
async def test_nested_project_paths_and_unborn_staged_diff(tmp_path):
    if not shutil.which("git"):
        pytest.skip("Git not installed")
    repository = tmp_path / "repo"
    repository.mkdir()
    git(repository, "init", "-q")
    root = repository / "nested"
    root.mkdir()
    (root / "代码.py").write_text("answer = 42\n", encoding="utf-8")
    (repository / "outside.py").write_text("not part of this project\n", encoding="utf-8")
    git(repository, "add", "--", ".")
    project = Project(root_path=str(root.resolve()), display_name="nested")
    summary = await git_summary(project)
    assert [row["path"] for row in summary["files"]] == ["代码.py"]
    assert summary["attribution"] == "workspace"
    diff = await git_diff(project, "代码.py")
    assert "+answer = 42" in diff["diff"]
    assert "outside.py" not in diff["diff"]


@pytest.mark.asyncio
async def test_non_git_project_is_not_an_empty_successful_diff(tmp_path):
    if not shutil.which("git"):
        pytest.skip("Git not installed")
    project = Project(root_path=str(tmp_path.resolve()), display_name="plain directory")
    summary = await git_summary(project)
    assert summary["available"] is False and summary["reason"]


@pytest.mark.asyncio
async def test_git_counts_are_real_workspace_changes_not_agent_attribution(tmp_path):
    if not shutil.which("git"):
        pytest.skip("Git not installed")
    git(tmp_path, "init", "-q")
    source = tmp_path / "source.txt"
    source.write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    git(tmp_path, "add", "--", "source.txt")
    git(tmp_path, "-c", "user.name=Mona Acceptance", "-c", "user.email=acceptance@example.invalid", "-c", "core.hooksPath=empty-hooks", "commit", "-q", "-m", "baseline")
    source.write_text("alpha\ndelta\ngamma\nepsilon\n", encoding="utf-8")
    (tmp_path / "new.txt").write_text("untracked line\n", encoding="utf-8")
    summary = await git_summary(Project(root_path=str(tmp_path.resolve()), display_name="repo"))
    assert summary["count"] == 2 and summary["untrackedFiles"] == 1
    assert (summary["additions"], summary["deletions"]) == (2, 1)
    assert summary["attribution"] == "workspace" and summary["statsScope"] == "tracked"


@pytest.mark.asyncio
async def test_selected_filename_is_literal_not_a_git_pattern(tmp_path):
    if not shutil.which("git"):
        pytest.skip("Git not installed")
    git(tmp_path, "init", "-q")
    (tmp_path / "[draft].ts").write_text("selected_file = 1\n", encoding="utf-8")
    (tmp_path / "d.ts").write_text("unrelated_file = 1\n", encoding="utf-8")
    git(tmp_path, "add", "--", ".")
    project = Project(root_path=str(tmp_path.resolve()), display_name="literal paths")
    result = await git_diff(project, "[draft].ts")
    assert "selected_file" in result["diff"]
    assert "unrelated_file" not in result["diff"]


@pytest.mark.asyncio
async def test_oversized_review_diff_is_rejected_and_git_remains_usable(tmp_path):
    if not shutil.which("git"):
        pytest.skip("Git not installed")
    git(tmp_path, "init", "-q")
    source = tmp_path / "large.txt"
    source.write_text("a" * 1_100_000 + "\n", encoding="utf-8")
    git(tmp_path, "add", "--", "large.txt")
    git(tmp_path, "-c", "user.name=Mona Acceptance", "-c", "user.email=acceptance@example.invalid",
        "-c", "core.hooksPath=empty-hooks", "commit", "-q", "-m", "baseline")
    source.write_text("b" * 1_100_000 + "\n", encoding="utf-8")
    diff = subprocess.run(
        [shutil.which("git"), "--no-pager", "diff", "--", "large.txt"],
        cwd=tmp_path, capture_output=True, check=True,
    ).stdout
    assert len(diff) > 2 * 1024 * 1024

    project = Project(root_path=str(tmp_path.resolve()), display_name="large review diff")
    with pytest.raises(DevelopmentError) as error:
        await asyncio.wait_for(read_review_diff(project, "large.txt"), timeout=5)
    assert error.value.code == "git_result_too_large"

    summary = await asyncio.wait_for(git_summary(project), timeout=5)
    assert summary["available"] is True
    assert [row["path"] for row in summary["files"]] == ["large.txt"]
