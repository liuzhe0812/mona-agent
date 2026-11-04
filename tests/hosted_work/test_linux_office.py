"""Opt-in Linux acceptance using the real Office sidecar inside gVisor.

The image and the Office resources must already exist; this test does not pull
images, download runtimes, or use production account data.
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import sys
import zipfile
from pathlib import Path
from uuid import uuid4

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import owner_key
from mona.hosted_work.sandbox import verify_inspection
from mona.hosted_work.tenant_xlsx import SandboxedXlsxEngineFactory
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.manager import OfficeSessionManager
from mona.office.sidecar import load_bundled_xlsx_sidecar

pytestmark = pytest.mark.skipif(
    sys.platform != "linux"
    or os.environ.get("MONA_HOSTED_SANDBOX_SMOKE") != "1"
    or not os.environ.get("MONA_HOSTED_SANDBOX_IMAGE")
    or not os.environ.get("MONA_RESOURCES_DIR"),
    reason="requires explicitly enabled Linux/gVisor image and verified Office resources",
)


def _workbook(template: Path, destination: Path, operand: int) -> None:
    """Add a formula and its known cached value to the trusted blank template."""
    with zipfile.ZipFile(template) as source, zipfile.ZipFile(destination, "x") as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                assert data.count(b'<dimension ref="A1"/>') == 1 and data.count(b"<sheetData/>") == 1
                cells = (
                    '<sheetData><row r="1"><c r="A1"><v>6</v></c>'
                    f'<c r="B1"><v>{operand}</v></c>'
                    f'<c r="C1"><f>A1*B1</f><v>{6 * operand}</v></c></row></sheetData>'
                ).encode()
                data = data.replace(b'<dimension ref="A1"/>', b'<dimension ref="A1:C1"/>')
                data = data.replace(b"<sheetData/>", cells)
            target.writestr(item, data)


async def _inspection(sandbox, owner: str, config: HostedWorkConfig) -> None:
    _, payload = await sandbox._invoke(["inspect", sandbox.name])
    inspected = json.loads(payload)
    assert isinstance(inspected, list) and len(inspected) == 1
    value = inspected[0]
    verify_inspection(value, owner, config)
    assert value["HostConfig"]["NetworkMode"] == "none"
    assert not value["HostConfig"].get("Binds")
    assert all(mount["Type"] == "tmpfs" for mount in value.get("Mounts", []))
    assert value["Config"]["Labels"]["mona.owner"] == owner
    assert value["Config"]["Labels"]["mona.work-kind"] == "xlsx"


async def _cells(engine, office_session: str, sheet_id: str) -> dict[int, dict]:
    async with asyncio.timeout(10):
        while True:
            reply = await engine.read_range(office_session, sheet_id=sheet_id, start_row=0, end_row=0,
                                            start_column=0, end_column=2)
            cells = {cell["column"]: cell for cell in reply["cells"] if cell["row"] == 0}
            if set(cells) == {0, 1, 2}:
                return cells
            await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_real_office_xlsx_formula_and_account_isolation(tmp_path):
    resources = Path(os.environ["MONA_RESOURCES_DIR"]).expanduser()
    assert resources.is_absolute() and resources.is_dir() and not resources.is_symlink()
    template = resources / "office-editor/templates/blank.xlsx"
    assert template.is_file()
    package = load_bundled_xlsx_sidecar(resources)
    assert package.path.is_file() and package.path.read_bytes().startswith(b"\x7fELF")
    state_root = tmp_path.resolve() / "office-state"
    state_root.mkdir(mode=0o700)
    config = HostedWorkConfig(state_dir=str(state_root), sandbox_image=os.environ["MONA_HOSTED_SANDBOX_IMAGE"],
                              max_concurrent_runs=2)
    owners = [owner_key(str(uuid4().int)), owner_key(str(uuid4().int))]
    workspaces, sessions, engines, sandboxes = {}, {}, [], []
    for owner, operand in zip(owners, (7, 8), strict=True):
        workspace = state_root / "users" / owner / "documents"
        workspace.mkdir(parents=True, mode=0o700)
        chat = uuid4().hex
        session_root = state_root / "users" / owner / "office" / chat / "sessions"
        session_root.mkdir(parents=True, mode=0o700)
        source = workspace / "same-name.xlsx"
        _workbook(template, source, operand)
        manager = OfficeSessionManager(sessions_root=session_root, max_checkpoint_bytes=config.max_file_bytes)
        office = manager.create_session(owner_session_key="websocket:" + chat, document_type="sheets",
                                        workspace_root=workspace, source_path=source)
        workspaces[owner], sessions[owner] = workspace, (session_root, office)

    factory = SandboxedXlsxEngineFactory(config, workspaces.__getitem__)
    for owner in owners:
        session_root, office = sessions[owner]
        engine = factory(owner, office.owner_session_key.removeprefix("websocket:"), session_root)
        engines.append(engine)
        sandboxes.append(engine._get_process()._sandbox)

    first, second = engines
    first_office, second_office = sessions[owners[0]][1], sessions[owners[1]][1]
    try:
        with pytest.raises(OfficeError) as foreign_path:
            await first.open("foreign-path", second_office.working_path)
        assert foreign_path.value.code == OfficeErrorCode.INVALID_OPERATION

        opened_first = await first.open(first_office.session_id, first_office.working_path)
        opened_second = await second.open(second_office.session_id, second_office.working_path)
        for opened in (opened_first, opened_second):
            assert len(opened["sheets"]) == 1 and opened["sheets"][0]["name"] == "Sheet1"
        values_first = await _cells(first, first_office.session_id, opened_first["sheets"][0]["id"])
        values_second = await _cells(second, second_office.session_id, opened_second["sheets"][0]["id"])
        assert [values_first[i]["value"] for i in range(3)] == [6, 7, 42]
        assert [values_second[i]["value"] for i in range(3)] == [6, 8, 48]
        assert values_first[2]["formula"] == values_second[2]["formula"] == "=A1*B1"
        with pytest.raises(OfficeError):
            await first.read_range(second_office.session_id, sheet_id=opened_second["sheets"][0]["id"],
                                   start_row=0, end_row=0, start_column=0, end_column=2)

        for sandbox, owner in zip(sandboxes, owners, strict=True):
            await _inspection(sandbox, owner, config)
        first_process, second_process = first._get_process(), second._get_process()
        own_book = first_process._book_paths[opened_first["sessionId"]]
        other_book = second_process._book_paths[opened_second["sessionId"]]
        assert own_book != other_book and sandboxes[0].name != sandboxes[1].name
        probe = (
            "import os,pathlib; "
            "assert os.getuid()==1000; "
            f"assert pathlib.Path({own_book!r}).is_file(); "
            f"assert not pathlib.Path({other_book!r}).exists(); "
            f"assert not pathlib.Path({str(second_office.working_path)!r}).exists(); "
            "assert not pathlib.Path('/var/run/docker.sock').exists()"
        )
        check = await sandboxes[0].execute("python3 -I -c " + shlex.quote(probe))
        assert check["exit_code"] == 0

        # The formula engine evaluates an edited value, independently of the cached 42.
        recalculated = await first_process.request("recalc_cells", path=own_book,
            edits=[{"sheet": "Sheet1", "row": 0, "column": 0, "input": "3"}],
            reads=[{"sheet": "Sheet1", "range": {"startRow": 0, "endRow": 0, "startColumn": 2, "endColumn": 2}}])
        assert recalculated["cells"][0]["number"] == 21
        assert recalculated["cells"][0]["isFormula"] is True

        await first.close(first_office.session_id)
        other_still_open = await _cells(second, second_office.session_id, opened_second["sheets"][0]["id"])
        assert other_still_open[2]["value"] == 48
        await _inspection(sandboxes[1], owners[1], config)
        await second.close(second_office.session_id)
        for sandbox in sandboxes:
            _, remaining = await sandbox._invoke(["ps", "-a", "--filter", f"name=^/{sandbox.name}$", "--format", "{{.Names}}"])
            assert not remaining.strip()
        assert not factory._active
    finally:
        cleanup = await asyncio.gather(*(engine.shutdown() for engine in engines), return_exceptions=True)
        errors = [error for error in cleanup if isinstance(error, BaseException)]
        if errors:
            raise AssertionError("Could not confirm cleanup of an owned XLSX sandbox") from errors[0]
