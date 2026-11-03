from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import pytest
from lxml import etree

from mona.agent.skills import SkillsLoader
from mona.agent.tools import skill_tools
from mona.runtime.agent_env import AgentEnvironmentResolution

SKILL_ROOT = Path(__file__).resolve().parents[2] / "mona" / "skills"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


@pytest.fixture
def tool(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> skill_tools.SkillScriptRunTool:
    loader = SkillsLoader(tmp_path, builtin_skills_dir=SKILL_ROOT)
    loader.workspace_skills = tmp_path / "private-skills"
    monkeypatch.setattr(skill_tools, "_skills_loader", lambda _agent_id: loader)

    class TestRuntime:
        async def prepare_for_skill(self, suffix, skill_dir, spec):
            assert suffix == ".py"
            return AgentEnvironmentResolution(executable=Path(sys.executable), env={})

    return skill_tools.SkillScriptRunTool(track_usage=False, workspace=tmp_path, agent_environment=TestRuntime())


def document(body: str, root: str = "document") -> bytes:
    return f'<w:{root} xmlns:w="{NS["w"]}">{body}</w:{root}>'.encode()


def create_docx(path: Path, body: str, *, extra: dict[str, bytes] | None = None) -> None:
    parts = {
        "[Content_Types].xml": b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        "word/document.xml": document(f"<w:body>{body}</w:body>"),
        "word/header1.xml": document("<w:p><w:ins><w:r><w:t>header-new</w:t></w:r></w:ins></w:p>", "hdr"),
        "word/footer1.xml": document("<w:p><w:r><w:t>footer</w:t></w:r></w:p>", "ftr"),
        "word/styles.xml": document("<w:style w:styleId=\"normal\"/>", "styles"),
        "word/media/picture.bin": b"unmodified binary payload",
    }
    parts.update(extra or {})
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)


@pytest.mark.asyncio
async def test_accept_inline_revisions_preserves_format_other_parts_and_input(
    tmp_path: Path, tool: skill_tools.SkillScriptRunTool,
) -> None:
    body = """<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange><w:pPr/></w:pPrChange></w:pPr>
    <w:r><w:rPr><w:b/><w:rPrChange><w:rPr/></w:rPrChange></w:rPr><w:t>keep</w:t></w:r>
    <w:del><w:r><w:delText>old</w:delText></w:r></w:del><w:ins><w:r><w:t>new</w:t></w:r></w:ins>
    <w:moveFromRangeStart w:id="1"/><w:moveFrom><w:r><w:delText>move-old</w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="1"/>
    <w:moveToRangeStart w:id="2"/><w:moveTo><w:r><w:t>move-new</w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="2"/>
    </w:p>"""
    source, result = tmp_path / "原始.docx", tmp_path / "已接受.docx"
    create_docx(source, body)
    original = source.read_bytes()

    output = await tool.execute(skill="mona-docx", script="accept_changes.py", args=f'"{source}" "{result}"')
    assert "[exit code: 0]" in output, output
    assert source.read_bytes() == original
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(result) as after:
        assert after.testzip() is None
        for name in ("word/footer1.xml", "word/styles.xml", "word/media/picture.bin"):
            assert before.read(name) == after.read(name)
        body_xml = etree.fromstring(after.read("word/document.xml"))
        header = etree.fromstring(after.read("word/header1.xml"))
        assert body_xml.xpath("//w:t/text()", namespaces=NS) == ["keep", "new", "move-new"]
        assert header.xpath("//w:t/text()", namespaces=NS) == ["header-new"]
        assert body_xml.xpath("count(//w:b)", namespaces=NS) == 1
        assert body_xml.xpath("//w:jc/@w:val", namespaces=NS) == ["center"]
        for tag in ("del", "ins", "moveFrom", "moveTo", "moveFromRangeStart", "moveToRangeEnd", "pPrChange", "rPrChange"):
            assert not body_xml.xpath(f"//w:{tag}", namespaces=NS)


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [
    '<w:p><w:pPr><w:rPr><w:del w:id="1"/></w:rPr></w:pPr></w:p>',
    '<w:tbl><w:tr><w:tc><w:tcPr><w:cellMerge w:id="1"/></w:tcPr></w:tc></w:tr></w:tbl>',
    '<w:p><w:ins><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:ins></w:p>',
    '<w:p><w:moveFromRangeStart w:id="1"/><w:r><w:t>unsafe</w:t></w:r><w:moveFromRangeEnd w:id="1"/></w:p>',
])
async def test_unsupported_revisions_fail_before_output(
    tmp_path: Path, tool: skill_tools.SkillScriptRunTool, body: str,
) -> None:
    source, result = tmp_path / "source.docx", tmp_path / "result.docx"
    create_docx(source, body)
    original = source.read_bytes()
    output = await tool.execute(skill="mona-docx", script="accept_changes.py", args=f'"{source}" "{result}"')
    assert "[exit code: 1]" in output and "Unsupported tracked change" in output
    assert not result.exists()
    assert source.read_bytes() == original


@pytest.mark.asyncio
async def test_rejects_unsafe_archive_doctype_and_existing_or_outside_paths(
    tmp_path: Path, tool: skill_tools.SkillScriptRunTool,
) -> None:
    source, result = tmp_path / "source.docx", tmp_path / "result.docx"
    create_docx(source, "<w:p/>", extra={"../escape": b"bad"})
    output = await tool.execute(skill="mona-docx", script="accept_changes.py", args=f'"{source}" "{result}"')
    assert "[exit code: 1]" in output and not result.exists()
    create_docx(source, "<w:p/>", extra={"word/document.xml": b'<!DOCTYPE x><x/>'})
    output = await tool.execute(skill="mona-docx", script="accept_changes.py", args=f'"{source}" "{result}"')
    assert "DOCTYPE" in output and not result.exists()
    create_docx(source, "<w:p/>")
    result.write_bytes(b"existing")
    for dest in (result, source, tmp_path.parent / "outside.docx"):
        output = await tool.execute(skill="mona-docx", script="accept_changes.py", args=f'"{source}" "{dest}"')
        assert "[exit code: 1]" in output
    assert result.read_bytes() == b"existing"


@pytest.mark.asyncio
@pytest.mark.parametrize("script,args", [
    ("unpack.py", '"{outside}" "{workspace}/unpacked"'),
    ("pack.py", '"{outside}" "{workspace}/result.docx"'),
    ("comment.py", '"{outside}" 1 "comment"'),
])
async def test_other_docx_helpers_reject_paths_outside_workspace(
    tmp_path: Path, tool: skill_tools.SkillScriptRunTool, script: str, args: str,
) -> None:
    output = await tool.execute(
        skill="mona-docx", script=script,
        args=args.format(workspace=tmp_path, outside=tmp_path.parent),
    )
    assert "[exit code: 1]" in output and "active workspace" in output
