from __future__ import annotations

import asyncio
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from mona.office.sidecar import XlsxSidecarProcess, load_bundled_xlsx_sidecar


def _write_workbook(path: Path) -> None:
    entries = {
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>',
        "xl/worksheets/sheet1.xml": '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2"><f>B1*2</f><v>84</v></c></row></sheetData></worksheet>',
    }
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)


def test_bundled_sidecar_opens_and_reads_real_xlsx(tmp_path: Path) -> None:
    resources = Path(__file__).parents[2] / "src-tauri" / "resources"
    try:
        executable = load_bundled_xlsx_sidecar(resources).path
    except Exception as exc:
        pytest.skip(f"bundled sidecar is not built: {exc}")
    workbook_path = tmp_path / "sample.xlsx"
    _write_workbook(workbook_path)

    async def run() -> None:
        process = XlsxSidecarProcess(executable)
        try:
            metadata = await process.open(workbook_path)
            sheet = metadata["sheets"][0]
            result = await process.read_range(
                session_id=metadata["sessionId"],
                sheet_id=sheet["id"],
                start_row=0,
                end_row=1,
                start_column=0,
                end_column=1,
            )
        finally:
            await process.stop()

        values = {(cell["row"], cell["column"]): cell for cell in result["cells"]}
        assert values[(0, 0)]["value"] == "名称"
        assert values[(0, 1)]["value"] == 42
        assert values[(1, 1)]["formula"] == "=B1*2"
        assert values[(1, 1)]["value"] == 84

    asyncio.run(run())
