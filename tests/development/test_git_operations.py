"""All writes stay in disposable repositories; no network or developer index."""
import asyncio
import shutil
import subprocess

import pytest

from mona.development.git_operations import GitOperations, destination_label
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore, NotFoundError


def command(root, *args):
    result = subprocess.run([shutil.which("git"), "--literal-pathspecs", *args], cwd=root, capture_output=True)
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    return result.stdout


@pytest.fixture
def repository(tmp_path):
    if not shutil.which("git"):
        pytest.skip("Git not installed")
    root = tmp_path / "项目"
    root.mkdir()
    command(root, "init", "-q", "-b", "main")
    command(root, "config", "user.name", "Mona Acceptance")
    command(root, "config", "user.email", "acceptance@example.invalid")
    command(root, "config", "commit.gpgsign", "false")
    command(root, "config", "core.hooksPath", ".empty-hooks")
    command(root, "config", "core.autocrlf", "input")
    (root / "selected.txt").write_text("baseline\n", encoding="utf-8")
    (root / "other.txt").write_text("other baseline\n", encoding="utf-8")
    command(root, "add", "--", ".")
    command(root, "commit", "-q", "-m", "baseline")
    store = DevelopmentStore(tmp_path / "state" / "development.sqlite3")
    project = store.open_project(root)
    session = store.create_session(project.id)
    service = GitOperations(store)
    return root, service, session


async def execute(service, session, item):
    result = await service.execute(session.id, item["id"])
    task = service.tasks.get(item["id"])
    if task:
        await asyncio.wait_for(asyncio.shield(task), 45)
    return service.get(session.id, result["id"])


@pytest.mark.asyncio
async def test_selected_commit_preserves_other_staging_and_requires_execute(repository):
    root, service, session = repository
    (root / "selected.txt").write_text("chosen current version\n", encoding="utf-8")
    (root / "other.txt").write_text("other staged version\n", encoding="utf-8")
    command(root, "add", "--", "other.txt")
    (root / "other.txt").write_text("other unstaged version\n", encoding="utf-8")
    before_index = (root / ".git/index").read_bytes()
    before_head = command(root, "rev-parse", "HEAD")
    item = await service.prepare(session.id, "request_one", "commit", ["selected.txt"], "selected only")
    assert item["status"] == "prepared"
    assert (root / ".git/index").read_bytes() == before_index
    assert command(root, "rev-parse", "HEAD") == before_head
    result = await execute(service, session, item)
    assert result["status"] == "succeeded", result
    assert command(root, "show", "HEAD:selected.txt") == b"chosen current version\n"
    assert command(root, "show", "HEAD:other.txt") == b"other baseline\n"
    assert command(root, "show", ":other.txt") == b"other staged version\n"
    assert (root / "other.txt").read_text() == "other unstaged version\n"
    assert [step["phase"] for step in result["steps"]] == ["checking", "staging", "committing"]
    assert all(step["status"] == "completed" for step in result["steps"])
    again = await execute(service, session, item)
    assert again["commit"] == result["commit"]
    assert command(root, "rev-list", "--count", "HEAD").strip() == b"2"
    await service.close()


@pytest.mark.asyncio
async def test_untracked_unicode_literal_paths_and_deleted_files(repository):
    root, service, session = repository
    (root / "[草稿] note.txt").write_text("new file\n", encoding="utf-8")
    (root / "other.txt").unlink()
    item = await service.prepare(session.id, "request_new", "commit", ["[草稿] note.txt", "other.txt"], "new and deleted")
    result = await execute(service, session, item)
    assert result["status"] == "succeeded", result
    assert command(root, "show", "HEAD:[草稿] note.txt") == b"new file\n"
    assert b"other.txt" not in command(root, "ls-tree", "--name-only", "HEAD")
    await service.close()


@pytest.mark.asyncio
async def test_stale_file_index_and_head_rejected_before_staging(repository):
    root, service, session = repository
    selected = root / "selected.txt"
    selected.write_text("preview\n")
    item = await service.prepare(session.id, "request_stale", "commit", [selected.name], "stale")
    selected.write_text("manual edit after preview\n")
    before = (root / ".git/index").read_bytes()
    result = await execute(service, session, item)
    assert result["status"] == "failed" and len(result["steps"]) == 1
    assert (root / ".git/index").read_bytes() == before
    item = await service.prepare(session.id, "request_index", "stage", [selected.name])
    (root / "other.txt").write_text("new staging\n")
    command(root, "add", "--", "other.txt")
    assert (await execute(service, session, item))["status"] == "failed"
    assert command(root, "show", ":selected.txt") == b"baseline\n"
    await service.close()


@pytest.mark.asyncio
async def test_stage_does_not_commit_and_initial_repository_commit(repository):
    root, service, session = repository
    (root / "selected.txt").write_text("staged\n")
    item = await service.prepare(session.id, "request_stage", "stage", ["selected.txt"])
    assert (await execute(service, session, item))["status"] == "succeeded"
    assert command(root, "show", ":selected.txt") == b"staged\n"
    assert command(root, "show", "HEAD:selected.txt") == b"baseline\n"
    command(root, "checkout", "--orphan", "initial")
    command(root, "rm", "-rf", "--cached", ".")
    item = await service.prepare(session.id, "request_initial", "commit", ["selected.txt"], "initial selected")
    result = await execute(service, session, item)
    assert result["status"] == "succeeded", result
    assert command(root, "ls-tree", "--name-only", "HEAD").strip() == b"selected.txt"
    await service.close()


@pytest.mark.asyncio
async def test_push_is_explicit_single_ref_and_never_forced(repository, tmp_path):
    root, service, session = repository
    remote = tmp_path / "remote.git"
    remote.mkdir()
    command(remote, "init", "--bare", "-q")
    command(root, "remote", "add", "origin", str(remote))
    command(root, "tag", "do-not-push")
    command(root, "config", "push.followTags", "true")
    item = await service.prepare(session.id, "request_push", "push", [], remote="origin", branch="review/main")
    assert not (remote / "refs/heads/review/main").exists()
    result = await execute(service, session, item)
    assert result["status"] == "succeeded", result
    expected = command(root, "rev-parse", "HEAD").strip()
    assert command(remote, "rev-parse", "refs/heads/review/main").strip() == expected
    assert command(remote, "tag", "--list") == b""
    command(root, "checkout", "--orphan", "unrelated")
    command(root, "commit", "-q", "-m", "different root")
    rejected = await service.prepare(session.id, "request_reject", "push", [], remote="origin", branch="review/main")
    assert (await execute(service, session, rejected))["status"] == "failed"
    assert command(remote, "rev-parse", "refs/heads/review/main").strip() == expected
    await service.close()


@pytest.mark.asyncio
async def test_remote_config_change_invalidates_confirmation(repository, tmp_path):
    root, service, session = repository
    command(root, "remote", "add", "origin", str(tmp_path / "first.git"))
    item = await service.prepare(session.id, "request_destination", "push", [], remote="origin", branch="main")
    command(root, "remote", "set-url", "origin", str(tmp_path / "second.git"))
    result = await execute(service, session, item)
    assert result["status"] == "failed" and len(result["steps"]) == 1
    assert "signature" not in result and "requestDigest" not in result
    assert destination_label("https://name:synthetic@example.invalid/repo?secret=test#fragment") == "https://example.invalid/repo"
    await service.close()


@pytest.mark.asyncio
async def test_unknown_operation_survives_restart_and_never_replays(repository):
    root, service, session = repository
    (root / "selected.txt").write_text("pending\n")
    item = await service.prepare(session.id, "request_interrupted", "commit", ["selected.txt"], "one time")
    saved = service._load(session.id, item["id"])
    saved["status"] = "running"
    service._save(saved)
    restored = GitOperations(service.store)
    assert restored.get(session.id, item["id"])["status"] == "unknown"
    assert (await restored.execute(session.id, item["id"]))["status"] == "unknown"
    assert not restored.tasks
    second = await restored.prepare(session.id, "request_blocked", "stage", ["selected.txt"])
    with pytest.raises(ConflictError):
        await restored.execute(session.id, second["id"])
    assert restored.acknowledge(session.id, item["id"])["status"] == "acknowledged"
    assert command(root, "rev-list", "--count", "HEAD").strip() == b"1"
    await restored.close()
    await service.close()


@pytest.mark.asyncio
async def test_scope_locks_readonly_and_idempotency(repository, tmp_path):
    root, service, session = repository
    (root / "selected.txt").write_text("change\n")
    item = await service.prepare(session.id, "request_same", "stage", ["selected.txt"])
    with pytest.raises(ConflictError):
        await service.prepare(session.id, "request_same", "commit", ["selected.txt"], "different")
    other = service.store.create_session(session.project_id, readonly=True)
    with pytest.raises(DevelopmentError, match="不能修改"):
        await service.prepare(other.id, "request_ro", "stage", ["selected.txt"])
    separate = service.store.create_session(session.project_id)
    with pytest.raises(NotFoundError):
        await service.execute(separate.id, item["id"])
    (root / ".git/index.lock").write_text("another operation")
    with pytest.raises(ConflictError):
        await service.prepare(session.id, "request_lock", "commit", ["selected.txt"], "no")
    assert (root / ".git/index.lock").read_text() == "another operation"
    await service.close()


@pytest.mark.asyncio
async def test_hook_failure_keeps_staging_without_claiming_commit(repository):
    root, service, session = repository
    hooks = root / ".empty-hooks"
    hooks.mkdir()
    hook = hooks / "pre-commit"
    hook.write_bytes(b"#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    (root / "selected.txt").write_text("staged after failed check\n")
    item = await service.prepare(session.id, "request_hook", "commit", ["selected.txt"], "check fails")
    result = await execute(service, session, item)
    assert result["status"] == "failed", result
    assert result["exitCode"] != 0 and result["commit"] is None
    assert command(root, "show", ":selected.txt") == b"staged after failed check\n"
    assert command(root, "rev-list", "--count", "HEAD").strip() == b"1"
    await service.close()


@pytest.mark.asyncio
async def test_lost_commit_receipt_never_repeats_effect(repository, monkeypatch):
    import mona.development.git_operations as operations
    root, service, session = repository
    original = operations.git

    async def lost_receipt(root, *args, **kwargs):
        result = await original(root, *args, **kwargs)
        if args[0] == "commit":
            raise operations.GitUncertainError("synthetic lost receipt")
        return result

    monkeypatch.setattr(operations, "git", lost_receipt)
    (root / "selected.txt").write_text("execute once\n")
    item = await service.prepare(session.id, "request_lost", "commit", ["selected.txt"], "execute once")
    result = await execute(service, session, item)
    assert result["status"] == "unknown"
    assert command(root, "rev-list", "--count", "HEAD").strip() == b"2"
    assert (await execute(service, session, item))["status"] == "unknown"
    assert command(root, "rev-list", "--count", "HEAD").strip() == b"2"
    await service.close()


@pytest.mark.asyncio
async def test_http_auth_and_explicit_confirmation(repository, monkeypatch):
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    from mona.config.schema import Config, _resolve_tool_config_refs
    from mona.development.api import RUNTIME_KEY, register_development_routes
    from mona.development.runtime import DevelopmentRuntime
    from mona.session.manager import SessionManager
    root, service, session = repository
    _resolve_tool_config_refs()
    runtime = DevelopmentRuntime(service.store, SessionManager(root.parent / "history"), Config)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-git-test")
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    async with TestClient(TestServer(app)) as client:
        prefix = f"/api/development/sessions/{session.id}/git-actions"
        headers = {"X-Mona-Token": "synthetic-git-test"}
        assert (await client.get(prefix + "/context")).status == 401
        (root / "selected.txt").write_text("http selected\n")
        reply = await client.post(prefix + "/prepare", json={"requestId": "request_http", "kind": "commit", "paths": ["selected.txt"], "message": "via UI"}, headers=headers)
        assert reply.status == 200
        item = await reply.json()
        assert not runtime.git_operations.tasks
        denied = await client.post(prefix + f"/{item['id']}/execute", json={"confirmed": False}, headers=headers)
        assert denied.status == 400
        denied = await client.post(prefix + f"/{item['id']}/execute", json={"confirmed": True})
        assert denied.status == 401 and not runtime.git_operations.tasks
        response = await client.post(prefix + f"/{item['id']}/execute", json={"confirmed": True}, headers=headers)
        assert response.status == 202
        await runtime.git_operations.tasks[item["id"]]
        restored = await client.get(prefix + f"/{item['id']}", headers=headers)
        assert (await restored.json())["status"] == "succeeded"
        assert command(root, "rev-list", "--count", "HEAD").strip() == b"2"
        branches = await client.get(prefix + "/branches", headers=headers)
        assert (await branches.json())["branches"] == ["main"]
        created = await client.post(prefix + "/prepare", json={"requestId": "request_branch_http",
            "kind": "create_branch", "branch": "feature/http"}, headers=headers)
        assert created.status == 200
        branch_action = await created.json()
        started = await client.post(prefix + f"/{branch_action['id']}/execute", json={"confirmed": True}, headers=headers)
        assert started.status == 202
        await runtime.git_operations.tasks[branch_action["id"]]
        assert (await (await client.get(prefix + "/branches", headers=headers)).json())["branch"] == "feature/http"
        preview = await client.get(prefix + "/preview?includeUnstaged=false", headers=headers)
        value = await preview.json()
        assert preview.status == 200 and value["includeUnstaged"] is False and value["identity"]["name"]
        assert (await client.post(prefix + "/generate-message", json={"includeUnstaged": False, "contextToken": value["contextToken"]})).status == 401
        graph = await client.get(prefix + "/graph", headers=headers)
        history = await graph.json()
        assert graph.status == 200 and history["commits"][0]["subject"] == "via UI"
        detail = await client.get(prefix + f"/commits/{history['commits'][0]['hash']}?path=selected.txt", headers=headers)
        assert detail.status == 200 and "+http selected" in (await detail.json())["diff"]
    await service.close()


@pytest.mark.asyncio
async def test_branch_create_switch_and_request_reuse(repository):
    root, service, session = repository
    assert (await service.branches(session.id))["branches"] == ["main"]
    created = await service.prepare(session.id, "request_create_branch", "create_branch", [], branch="feature/work")
    assert command(root, "branch", "--show-current").strip() == b"main"
    result = await execute(service, session, created)
    assert result["status"] == "succeeded" and result["targetBranch"] == "feature/work"
    assert command(root, "branch", "--show-current").strip() == b"feature/work"
    assert (await service.execute(session.id, created["id"]))["status"] == "succeeded"
    assert (await service.prepare(session.id, "request_create_branch", "create_branch", [], branch="feature/work"))["id"] == created["id"]
    with pytest.raises(ConflictError):
        await service.prepare(session.id, "request_create_branch", "switch_branch", [], branch="main")
    switched = await service.prepare(session.id, "request_switch_branch", "switch_branch", [], branch="main")
    assert (await execute(service, session, switched))["status"] == "succeeded"
    assert command(root, "branch", "--show-current").strip() == b"main"
    await service.close()


@pytest.mark.asyncio
async def test_branch_switch_preserves_conflicting_working_changes(repository):
    root, service, session = repository
    command(root, "switch", "-c", "feature/changed")
    (root / "selected.txt").write_text("other branch\n", encoding="utf-8")
    command(root, "add", "--", "selected.txt")
    command(root, "commit", "-q", "-m", "other branch")
    command(root, "switch", "main")
    (root / "selected.txt").write_text("my local edits\n", encoding="utf-8")
    item = await service.prepare(session.id, "request_conflict_branch", "switch_branch", [], branch="feature/changed")
    result = await execute(service, session, item)
    assert result["status"] == "failed"
    assert result["errorCode"] == "branch_overwrite" and "selected.txt" in result["affectedPaths"]
    assert command(root, "branch", "--show-current").strip() == b"main"
    assert (root / "selected.txt").read_text(encoding="utf-8") == "my local edits\n"
    await service.close()


@pytest.mark.asyncio
async def test_uncertain_branch_result_is_never_replayed(repository, monkeypatch):
    import mona.development.git_operations as operations

    root, service, session = repository
    original = operations.git

    async def lost_receipt(root, *args, **kwargs):
        result = await original(root, *args, **kwargs)
        if args[0] == "switch":
            raise operations.GitUncertainError("synthetic lost receipt")
        return result

    monkeypatch.setattr(operations, "git", lost_receipt)
    item = await service.prepare(session.id, "request_uncertain_branch", "create_branch", [], branch="feature/uncertain")
    assert (await execute(service, session, item))["status"] == "unknown"
    assert (await service.execute(session.id, item["id"]))["status"] == "unknown"
    pending = (await service.branches(session.id))["pendingAction"]
    assert pending["id"] == item["id"] and pending["status"] == "unknown"
    assert command(root, "branch", "--show-current").strip() == b"feature/uncertain"
    assert service.acknowledge(session.id, item["id"])["status"] == "acknowledged"
    await service.close()


@pytest.mark.asyncio
async def test_staged_only_preview_and_commit_keep_unstaged_and_other_staging(repository):
    root, service, session = repository
    (root / "selected.txt").write_text("staged version\n")
    (root / "other.txt").write_text("other staged\n")
    command(root, "add", "--", "selected.txt", "other.txt")
    (root / "selected.txt").write_text("unstaged version\n")
    before = await service.preview(session.id, False)
    assert before["identity"]["name"] == "Mona Acceptance"
    assert before["stagedCount"] == 2 and before["unstagedCount"] == 1
    assert before["additions"] == 2 and before["deletions"] == 2
    item = await service.prepare(session.id, "staged_only", "commit", ["selected.txt"], "fix: staged only",
        include_unstaged=False, context_token=before["contextToken"])
    result = await execute(service, session, item)
    assert result["status"] == "succeeded", result
    assert command(root, "show", "HEAD:selected.txt") == b"staged version\n"
    assert (root / "selected.txt").read_text() == "unstaged version\n"
    assert command(root, "show", "HEAD:other.txt") == b"other baseline\n"
    assert command(root, "show", ":other.txt") == b"other staged\n"
    await service.close()


@pytest.mark.asyncio
async def test_preview_token_rejects_changed_files_before_prepare(repository):
    root, service, session = repository
    (root / "selected.txt").write_text("preview\n")
    preview = await service.preview(session.id)
    (root / "selected.txt").write_text("edited after preview\n")
    with pytest.raises(ConflictError, match="变化"):
        await service.prepare(session.id, "stale_preview", "commit", ["selected.txt"], "fix: stale", context_token=preview["contextToken"])
    assert command(root, "show", ":selected.txt") == b"baseline\n"
    await service.close()


@pytest.mark.asyncio
async def test_commit_and_push_is_one_durable_action_and_sets_upstream(repository, tmp_path):
    root, service, session = repository
    remote = tmp_path / "remote.git"
    remote.mkdir()
    command(remote, "init", "--bare", "-q")
    command(root, "remote", "add", "origin", str(remote))
    (root / "selected.txt").write_text("commit and push\n")
    preview = await service.preview(session.id)
    assert preview["canPush"] and preview["defaultRemote"] == "origin"
    item = await service.prepare(session.id, "commit_push", "commit_and_push", ["selected.txt"], "fix: combined",
        remote="origin", branch="main", context_token=preview["contextToken"])
    result = await execute(service, session, item)
    assert result["status"] == "succeeded", result
    assert command(remote, "rev-parse", "refs/heads/main").strip().decode() == result["commit"]
    assert command(root, "config", "branch.main.remote").strip() == b"origin"
    assert command(root, "config", "branch.main.merge").strip() == b"refs/heads/main"
    assert (await execute(service, session, item))["commit"] == result["commit"]
    assert command(root, "rev-list", "--count", "HEAD").strip() == b"2"
    await service.close()


@pytest.mark.asyncio
async def test_commit_then_switch_preserves_commit_on_original_branch(repository):
    root, service, session = repository
    command(root, "branch", "target")
    (root / "selected.txt").write_text("new current branch work\n")
    item = await service.prepare(session.id, "commit_switch", "commit_and_switch", ["selected.txt"], "fix: before switch", branch="target")
    result = await execute(service, session, item)
    assert result["status"] == "succeeded", result
    assert command(root, "branch", "--show-current").strip() == b"target"
    assert command(root, "show", "main:selected.txt") == b"new current branch work\n"
    assert command(root, "show", "target:selected.txt") == b"baseline\n"
    await service.close()


@pytest.mark.asyncio
async def test_graph_and_commit_file_details_read_real_history(repository):
    root, service, session = repository
    graph = await service.graph(session.id)
    assert not graph["hasMore"] and len(graph["commits"]) == 1
    commit = graph["commits"][0]
    assert commit["subject"] == "baseline" and commit["parents"] == []
    assert any(ref["name"] == "main" for ref in commit["refs"])
    detail = await service.commit_detail(session.id, commit["hash"])
    assert {row["path"] for row in detail["files"]} == {"selected.txt", "other.txt"}
    assert all(row["status"] == "A" for row in detail["files"])
    assert not detail["diff"]
    detail = await service.commit_detail(session.id, commit["hash"], "selected.txt")
    assert "+baseline" in detail["diff"] and "other.txt" not in detail["diff"]
    with pytest.raises(DevelopmentError):
        await service.commit_detail(session.id, commit["hash"], "../../outside")
    await service.close()
