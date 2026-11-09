"""Hosted document reading uses the desktop parsers only inside the sandbox."""
import asyncio
import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import fitz
import pytest
from docx import Document
from openpyxl import Workbook
from pptx import Presentation

from mona.agent.tools.filesystem import ReadFileTool
from mona.config.schema import HostedWorkConfig
from mona.hosted_work import sandbox_files
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.filesystem import HostedReadFileTool
from mona.hosted_work.sandbox import DockerSandbox
from mona.hosted_work.tools import HostedTools

ROOT = Path(__file__).resolve().parents[2]


def sample_documents(tmp_path):
    paths = {}
    pdf = fitz.open()
    for text in ("first page", "second page"):
        pdf.new_page().insert_text((72, 72), text)
    paths["sample.pdf"] = tmp_path / "sample.pdf"
    pdf.save(paths["sample.pdf"])
    pdf.close()

    document = Document()
    document.add_paragraph("word text")
    paths["sample.docx"] = tmp_path / "sample.docx"
    document.save(paths["sample.docx"])

    book = Workbook()
    book.active["A1"] = "sheet text"
    paths["sample.xlsx"] = tmp_path / "sample.xlsx"
    book.save(paths["sample.xlsx"])
    book.close()

    slides = Presentation()
    slides.slides.add_slide(slides.slide_layouts[1]).shapes.title.text = "slide text"
    paths["sample.pptx"] = tmp_path / "sample.pptx"
    slides.save(paths["sample.pptx"])
    return paths


_ISOLATED_FIXTURE = r'''
import base64,importlib,json,pathlib,runpy,sys,sysconfig
scope=runpy.run_path(sys.argv[1],run_name="document_fixture")
request=json.load(sys.stdin)
raw=base64.b64decode(request.pop("_fixture"),validate=True)
missing=request.pop("_missing",False)
runtime=request.pop("_runtime",None)
fallback=request.pop("_fallback",None)
if runtime is None:
    runtime=sysconfig.get_paths()["purelib"]
else:
    # Model an image that has an unverified globally installed package.
    sys.path.append(fallback or sysconfig.get_paths()["purelib"])
scope["_read_document"].__globals__["_DOCUMENT_RUNTIME"]=pathlib.Path(runtime).resolve()
if missing:
    original=importlib.import_module
    def check(name,*args,**kwargs):
        if name=="fitz": raise ModuleNotFoundError(name)
        return original(name,*args,**kwargs)
    importlib.import_module=check
scope["_read_document"].__globals__["_document_bytes"]=lambda _path,_limit: raw
try:
    value=scope["_read_document"](request,10*1024*1024)
except scope["FileOperationError"] as error:
    value={"error":error.code}
print(json.dumps(value,ensure_ascii=False))
'''


def isolated_result(path: Path, *, pages=None, expected=None, missing=False, runtime=None, fallback=None):
    sources = {name: (ROOT / "mona" / "utils" / (name + ".py")).read_text(encoding="utf-8")
               for name in ("document", "document_reader")}
    request = {"action": "read_document", "path": path.name, "pages": pages,
               "expected_sha256": expected, "_sources": sources,
               "_fixture": base64.b64encode(path.read_bytes()).decode("ascii"), "_missing": missing,
               "_runtime": str(runtime) if runtime is not None else None,
               "_fallback": str(fallback) if fallback is not None else None}
    result = subprocess.run([sys.executable, "-I", "-S", "-c", _ISOLATED_FIXTURE,
                             str(ROOT / "mona/hosted_work/sandbox_files.py")],
                            input=json.dumps(request), text=True, encoding="utf-8", capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.asyncio
async def test_isolated_snapshot_uses_same_desktop_document_parsers(tmp_path):
    paths = sample_documents(tmp_path)
    desktop = ReadFileTool(workspace=tmp_path)
    for name, path in paths.items():
        pages = "2" if name.endswith(".pdf") else None
        actual = isolated_result(path, pages=pages)
        expected = await desktop.execute(path=str(path), pages=pages)
        assert actual["content"] == expected
        assert actual["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert "second page" in isolated_result(paths["sample.pdf"], pages="2")["content"]
    assert isolated_result(paths["sample.pdf"], pages="2", expected="0" * 64) == {"error": "file_changed"}
    assert isolated_result(paths["sample.pdf"], missing=True) == {"error": "runtime_unavailable"}
    empty_runtime = tmp_path / "empty-runtime"
    empty_runtime.mkdir()
    assert isolated_result(paths["sample.pdf"], runtime=empty_runtime) == {"error": "runtime_unavailable"}
    untrusted = tmp_path / "global-site"
    untrusted.mkdir()
    marker = tmp_path / "untrusted-imported"
    (untrusted / "loguru.py").write_text(
        "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('executed')\n", encoding="utf-8")
    assert isolated_result(paths["sample.pdf"], runtime=empty_runtime, fallback=untrusted) == {"error": "runtime_unavailable"}
    assert not marker.exists()


@pytest.mark.asyncio
async def test_hosted_reader_accepts_only_sandbox_document_result(monkeypatch):
    raw = b"document bytes are never parsed in the parent"
    digest = hashlib.sha256(raw).hexdigest()
    operations = AsyncMock(return_value={"path": "report.pdf", "name": "report.pdf", "size": len(raw),
                                         "sha256": digest, "content": "--- Page 1 ---\ntext"})
    monkeypatch.setattr(ReadFileTool, "_read_pdf", lambda *_: pytest.fail("host PDF parser ran"))
    monkeypatch.setattr(ReadFileTool, "_read_office_doc", lambda *_: pytest.fail("host Office parser ran"))
    tool = HostedReadFileTool(operations, max_file_bytes=1024)
    assert await tool.execute(path="report.pdf", pages="1", expected_sha256=digest) == (
        "--- Page 1 ---\ntext\n[SHA256=" + digest + "]"
    )
    operations.assert_awaited_once_with("read_document", path="report.pdf", pages="1", expected_sha256=digest)
    operations.side_effect = WorkError("runtime_unavailable", "missing", 503)
    assert "runtime_unavailable" in await tool.execute(path="report.pdf")


@pytest.mark.asyncio
async def test_sandbox_supplies_only_trusted_release_sources(tmp_path):
    sandbox = DockerSandbox(HostedWorkConfig(), "a" * 64, "b" * 32, tmp_path / "workspace.zip")
    captured = {}

    async def helper(_mode, _maximum, data, *, limit, no_site):
        captured.update(json.loads(data))
        assert no_site is True
        return json.dumps({"path": "report.pdf", "name": "report.pdf", "size": 0,
                           "sha256": "a" * 64, "content": "ok"}).encode()

    sandbox._helper = helper
    result = await sandbox.file({"action": "read_document", "path": "report.pdf", "pages": None,
                                 "expected_sha256": None, "_sources": {"document": "untrusted"}})
    assert result["content"] == "ok"
    assert captured["_sources"]["document"] == (ROOT / "mona/utils/document.py").read_text(encoding="utf-8")
    assert captured["_sources"]["document_reader"] == (ROOT / "mona/utils/document_reader.py").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_document_helper_disables_global_site_packages(tmp_path):
    sandbox = DockerSandbox(HostedWorkConfig(), "a" * 64, "b" * 32, tmp_path / "workspace.zip")
    sandbox.started = True
    sandbox._invoke = AsyncMock(return_value=(0, b"{}"))
    await sandbox._helper("file", 1024, b"{}", no_site=True)
    assert sandbox._invoke.await_args.args[0][3:7] == ["python3", "-I", "-S", "-c"]
    await sandbox._helper("file", 1024, b"{}")
    assert sandbox._invoke.await_args.args[0][3:6] == ["python3", "-I", "-c"]


@pytest.mark.asyncio
async def test_document_timeout_stops_the_turn_without_host_fallback(monkeypatch):
    monkeypatch.setattr(ReadFileTool, "_read_pdf", lambda *_: pytest.fail("host PDF parser ran"))
    sandbox = AsyncMock()
    sandbox.config = HostedWorkConfig()
    sandbox.file.side_effect = TimeoutError("isolated read timed out")
    tools = HostedTools(sandbox, AsyncMock())
    with pytest.raises(asyncio.CancelledError):
        await tools.registry.get("read_file").execute(path="report.pdf")
    assert tools.fault and sandbox.file.await_count == 1


@pytest.mark.skipif(os.name != "posix", reason="directory-fd isolation requires Linux")
def test_document_snapshot_rejects_links_and_uses_workspace_only(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "nested").mkdir()
    (workspace / "nested/report.pdf").write_bytes(b"inside")
    (tmp_path / "outside.pdf").write_bytes(b"outside")
    (workspace / "link").symlink_to(tmp_path, target_is_directory=True)
    (workspace / "other.pdf").symlink_to(tmp_path / "outside.pdf")
    monkeypatch.setattr(sandbox_files, "ROOT", workspace)
    assert sandbox_files._document_bytes("nested/report.pdf", 100) == b"inside"
    for path in ("../outside.pdf", "link/outside.pdf", "other.pdf"):
        with pytest.raises((ValueError, sandbox_files.FileOperationError)):
            sandbox_files._document_bytes(path, 100)
