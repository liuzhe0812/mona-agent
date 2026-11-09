"""Opt-in real document parsing test for a verified Work image with runtime pack."""
import os
import shlex
import sys
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.sandbox import DockerSandbox
from mona.hosted_work.tools import HostedTools

pytestmark = pytest.mark.skipif(
    sys.platform != "linux" or os.environ.get("MONA_HOSTED_DOCUMENT_SMOKE") != "1",
    reason="requires an explicitly authorized Linux/gVisor image with the verified runtime pack",
)


@pytest.mark.asyncio
async def test_documents_use_the_owner_sandbox_and_shared_reader(tmp_path):
    image = os.environ.get("MONA_HOSTED_SANDBOX_IMAGE", "")
    assert image
    config = HostedWorkConfig(sandbox_image=image, state_dir=str(tmp_path), workspace_bytes=8 * 1024 * 1024)
    first = DockerSandbox(config, owner_key("900000004"), uuid4().hex, tmp_path / "first.zip")
    second = DockerSandbox(config, owner_key("900000005"), uuid4().hex, tmp_path / "second.zip")
    create = '''
import sys
sys.path.insert(0,"/opt/mona/runtime/hosted-documents")
import fitz
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
pdf=fitz.open();pdf.new_page().insert_text((72,72),"pdf content");pdf.save("sample.pdf");pdf.close()
doc=Document();doc.add_paragraph("docx content");doc.save("sample.docx")
book=Workbook();book.active["A1"]="xlsx content";book.save("sample.xlsx");book.close()
slides=Presentation();slides.slides.add_slide(slides.slide_layouts[1]).shapes.title.text="pptx content";slides.save("sample.pptx")
'''
    try:
        await first.start()
        result = await first.execute("python3 -I -S -c " + shlex.quote(create))
        assert result["exit_code"] == 0
        reader = HostedTools(first, AsyncMock(), config=config).registry.get("read_file")
        for extension in ("pdf", "docx", "xlsx", "pptx"):
            content = await reader.execute(path="sample." + extension)
            assert extension + " content" in content and "[SHA256=" in content
        await second.start()
        other = HostedTools(second, AsyncMock(), config=config).registry.get("read_file")
        with pytest.raises(WorkError) as error:
            await other.execute(path="sample.pdf")
        assert error.value.code == "file_not_found"
        assert (await first.execute("ln -s /etc/passwd /workspace/link.pdf"))["exit_code"] == 0
        with pytest.raises(WorkError) as error:
            await reader.execute(path="link.pdf")
        assert error.value.code == "invalid_file_operation"
    finally:
        await first.close()
        await second.close()
