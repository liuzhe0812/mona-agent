"""Protocol, ownership and cleanup contracts; no Docker or sidecar is executed here."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work import tenant_xlsx
from mona.hosted_work.contracts import owner_key
from mona.hosted_work.sandbox import DockerSandbox, SandboxError, container_name, create_arguments
from mona.office import sidecar
from mona.office.errors import OfficeError, OfficeErrorCode

OWNER, OTHER = owner_key("101"), owner_key("102")
CHAT = "a" * 32


class FakeStdioProcess:
    def __init__(self):
        self.returncode = None
        self.pid = 12345
        self.requests = []
        self.stdout = asyncio.StreamReader()
        self.stdin = SimpleNamespace(write=self.write, drain=self.drain, close=lambda: None)

    def write(self, raw):
        request = json.loads(raw)
        self.requests.append(request)
        if request["command"] == "open":
            result = {"sessionId": "kernel-book"}
        elif request["command"] == "read_range":
            result = {"cells": [["protocol-frame"]]}
        else:
            result = {}
        self.stdout.feed_data((json.dumps({"version": 1, "requestId": request["requestId"],
                                          "ok": True, "result": result}) + "\n").encode())

    async def drain(self):
        pass

    def terminate(self):
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    async def wait(self):
        return self.returncode


@pytest.fixture
def setup(tmp_path, monkeypatch):
    config = HostedWorkConfig(state_dir=str(tmp_path / "state"),
                              sandbox_image="sha256:" + "c" * 64, max_concurrent_runs=2)
    state = Path(config.state_dir)
    workspaces = {}
    sessions = {}
    for owner in (OWNER, OTHER):
        workspaces[owner] = state / "users" / owner / "documents"
        workspaces[owner].mkdir(parents=True)
        sessions[owner] = state / "users" / owner / "office" / CHAT / "sessions"
        sessions[owner].mkdir(parents=True)
    resources = tmp_path / "resources"
    runtime = resources / "office-editor" / "sheets" / "xlsx-sidecar"
    runtime.parent.mkdir(parents=True)
    binary = b"\x7fELF\x02synthetic-linux-sidecar-not-executed"
    runtime.write_bytes(binary)
    (resources / "office-editor" / "manifest.json").write_text(json.dumps({
        "schemaVersion": 1, "platform": "linux", "arch": "x64", "xlsxSidecar": {
            "path": "sheets/xlsx-sidecar", "version": "contract-test", "size": len(binary),
            "sha256": hashlib.sha256(binary).hexdigest(),
        },
    }), encoding="utf-8")
    monkeypatch.setattr(sidecar, "_runtime_platform_and_arch", lambda: ("linux", "x64"))
    monkeypatch.setattr(tenant_xlsx, "sys", SimpleNamespace(platform="linux"))
    instances = []

    class IsolatedSandbox:
        def __init__(self, config, owner, run_id, snapshot):
            self.config, self.owner, self.run_id, self.snapshot = config, owner, run_id, snapshot
            self.name = container_name(owner, run_id)
            self.docker = "/trusted/docker"
            self.created = self.started = False
            self.calls = []
            self.files = {}
            self.fail_start = self.fail_close = False
            instances.append(self)

        async def preflight(self):
            self.calls.append("preflight")

        async def start(self):
            self.calls.append("start")
            self.created = True
            if self.fail_start:
                raise SandboxError()
            self.started = True

        async def _invoke(self, arguments, **kwargs):
            self.calls.append((arguments, kwargs))
            return 0, b""

        async def file(self, request):
            assert self.started
            self.files[request["path"]] = base64.b64decode(request["data"], validate=True)
            return {"sha256": hashlib.sha256(self.files[request["path"]]).hexdigest()}

        async def close(self):
            self.calls.append("close")
            if self.fail_close:
                raise SandboxError("cleanup_unknown", "not confirmed")
            self.created = self.started = False

        async def save(self):
            raise AssertionError("A sidecar executable must never be persisted in a user snapshot")

    monkeypatch.setattr(tenant_xlsx, "_XlsxSandbox", IsolatedSandbox)
    processes = []

    async def spawn(*args, **kwargs):
        process = FakeStdioProcess()
        processes.append((process, args, kwargs))
        return process

    monkeypatch.setattr(tenant_xlsx.asyncio, "create_subprocess_exec", spawn)
    factory = tenant_xlsx.SandboxedXlsxEngineFactory(config, workspaces.__getitem__, resources)
    return SimpleNamespace(config=config, state=state, workspaces=workspaces, sessions=sessions,
                           resources=resources, runtime=runtime, binary=binary, instances=instances,
                           processes=processes, factory=factory)


@pytest.mark.asyncio
async def test_original_engine_protocol_uses_only_scoped_docker_process_and_stops_when_idle(setup, monkeypatch):
    monkeypatch.setenv("MONA_WORK_MODEL_TEST_KEY", "synthetic-not-sent")
    monkeypatch.setenv("DOCKER_HOST", "tcp://untrusted.invalid:1234")
    workbook = setup.sessions[OWNER] / "office_example" / "working.xlsx"
    workbook.parent.mkdir()
    workbook.write_bytes(b"workbook bytes")
    engine = setup.factory(OWNER, CHAT, setup.sessions[OWNER])

    opened = await engine.open("office_example", workbook)
    assert opened["sessionId"] == "kernel-book"
    result = await engine.read_range("office_example", sheet_id="one", start_row=0, end_row=1,
                                     start_column=0, end_column=1)
    assert result == {"cells": [["protocol-frame"]]}
    process, command, options = setup.processes[0]
    sandbox = setup.instances[0]
    assert command == ("/trusted/docker", "--host=unix:///var/run/docker.sock", "exec", "-i",
                       "--user=1000:1000", "--workdir=/workspace", sandbox.name, tenant_xlsx._RUNTIME)
    assert set(options["env"]) <= {"PATH", "LANG", "LC_ALL"}
    assert options["stderr"] == asyncio.subprocess.DEVNULL
    assert process.requests[0]["command"] == "open"
    virtual = process.requests[0]["path"]
    assert virtual.startswith("/workspace/.mona-xlsx-books/") and str(workbook) not in virtual
    assert sandbox.files[virtual] == b"workbook bytes"
    install = next(call for call in sandbox.calls if isinstance(call, tuple)
                   and tenant_xlsx._INSTALL_RUNTIME in call[0])
    assert install[1]["data"] == setup.binary
    assert sandbox.run_id != CHAT and len(sandbox.run_id) == 32

    await engine.close("office_example")
    assert [r["command"] for r in process.requests] == ["open", "read_range", "close"]
    assert process.returncode == 0 and sandbox.calls[-1] == "close"
    assert not setup.factory._active and not sandbox.created


@pytest.mark.asyncio
@pytest.mark.parametrize("broken", ["tampered", "other_platform", "missing"])
async def test_runtime_validation_fails_before_container_or_process_start(setup, broken):
    if broken == "tampered":
        setup.runtime.write_bytes(b"tampered")
    elif broken == "missing":
        setup.runtime.unlink()
    else:
        path = setup.resources / "office-editor" / "manifest.json"
        data = json.loads(path.read_text())
        data["platform"] = "windows"
        path.write_text(json.dumps(data))
    engine = setup.factory(OWNER, CHAT, setup.sessions[OWNER])

    with pytest.raises(OfficeError) as error:
        await engine._get_process().start()

    assert error.value.code == OfficeErrorCode.EDITOR_UNAVAILABLE
    assert not setup.processes and "start" not in setup.instances[0].calls
    assert not setup.factory._active


@pytest.mark.asyncio
@pytest.mark.parametrize("path_kind", ["other_user", "traversal", "hardlink"])
async def test_workbook_scope_is_checked_before_any_process_start(setup, path_kind):
    foreign = setup.workspaces[OTHER] / "private.xlsx"
    foreign.write_bytes(b"other-account-data")
    if path_kind == "other_user":
        requested = foreign
    elif path_kind == "traversal":
        requested = setup.workspaces[OWNER] / ".." / ".." / OTHER / "documents" / "private.xlsx"
    else:
        requested = setup.workspaces[OWNER] / "linked.xlsx"
        os.link(foreign, requested)
    engine = setup.factory(OWNER, CHAT, setup.sessions[OWNER])

    with pytest.raises(OfficeError):
        await engine.open("office_example", requested)

    assert not setup.processes and "start" not in setup.instances[0].calls


def test_factory_rejects_foreign_sessions_and_workspace(setup):
    with pytest.raises(OfficeError):
        setup.factory(OWNER, CHAT, setup.sessions[OTHER])
    factory = tenant_xlsx.SandboxedXlsxEngineFactory(setup.config, lambda _: setup.workspaces[OTHER],
                                                   setup.resources)
    with pytest.raises(OfficeError):
        factory(OWNER, CHAT, setup.sessions[OWNER])


@pytest.mark.asyncio
async def test_linked_workbook_is_never_uploaded(setup):
    foreign = setup.workspaces[OTHER] / "private.xlsx"
    foreign.write_bytes(b"other-account-data")
    requested = setup.workspaces[OWNER] / "linked.xlsx"
    try:
        requested.symlink_to(foreign)
    except OSError:
        pytest.skip("requires permission to create filesystem symbolic links")
    engine = setup.factory(OWNER, CHAT, setup.sessions[OWNER])

    with pytest.raises(OfficeError):
        await engine.open("office_example", requested)

    assert not setup.processes and "start" not in setup.instances[0].calls


@pytest.mark.asyncio
async def test_non_linux_never_falls_back_to_host_execution(setup, monkeypatch):
    monkeypatch.setattr(tenant_xlsx, "sys", SimpleNamespace(platform="win32"))
    engine = setup.factory(OWNER, CHAT, setup.sessions[OWNER])

    with pytest.raises(OfficeError, match="Ubuntu"):
        await engine._get_process().start()

    assert not setup.processes and "start" not in setup.instances[0].calls


@pytest.mark.asyncio
async def test_failed_creation_cleans_only_its_container_and_uncertain_cleanup_blocks_replacement(setup):
    engine = setup.factory(OWNER, CHAT, setup.sessions[OWNER])
    process = engine._get_process()
    sandbox = setup.instances[0]
    sandbox.fail_start = sandbox.fail_close = True

    with pytest.raises(OfficeError, match="未确认结束"):
        await process.start()
    assert not setup.processes and process in setup.factory._active
    before = len(sandbox.calls)
    with pytest.raises(OfficeError, match="待核对"):
        await process.start()
    assert len(sandbox.calls) == before


@pytest.mark.asyncio
async def test_capacity_is_released_after_last_workbook_close_without_stopping_another_owner(setup):
    setup.factory.config.max_concurrent_runs = 1
    first_file = setup.workspaces[OWNER] / "first.xlsx"
    second_file = setup.workspaces[OTHER] / "second.xlsx"
    first_file.write_bytes(b"first")
    second_file.write_bytes(b"second")
    first = setup.factory(OWNER, CHAT, setup.sessions[OWNER])
    second = setup.factory(OTHER, CHAT, setup.sessions[OTHER])
    assert setup.instances[0].name != setup.instances[1].name

    await first.open("office_first", first_file)
    with pytest.raises(OfficeError, match="已满"):
        await second.open("office_second", second_file)
    assert setup.instances[0].started
    await first.close("office_first")
    await second.open("office_second", second_file)
    assert setup.instances[1].started and not setup.instances[0].started
    await first.shutdown()
    assert setup.instances[1].started
    await second.shutdown()
    assert not setup.factory._active and not any(s.created for s in setup.instances)


@pytest.mark.asyncio
async def test_sidecar_container_keeps_the_existing_policy_and_has_an_explicit_runtime_label(tmp_path, monkeypatch):
    invoke = AsyncMock(return_value=(0, b""))
    monkeypatch.setattr(DockerSandbox, "_invoke", invoke)
    config = HostedWorkConfig(state_dir=str(tmp_path), sandbox_image="sha256:" + "c" * 64)
    sandbox = tenant_xlsx._XlsxSandbox(config, OWNER, "b" * 32, tmp_path / "unused.zip")
    arguments = create_arguments(config, OWNER, sandbox.run_id)

    await sandbox._invoke(arguments)

    actual = invoke.call_args.args[0]
    assert actual[:3] == ["create", "--label", "mona.work-kind=xlsx"]
    assert actual[3:] == arguments[1:]
    assert "--network=none" in actual and "--runtime=runsc" in actual and "--read-only" in actual
    assert not any(item.startswith(("--mount", "--volume", "--privileged")) for item in actual)
