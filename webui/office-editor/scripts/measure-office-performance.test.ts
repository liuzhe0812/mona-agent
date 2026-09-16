import { execFile, spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, resolve, join } from 'path'
import { performance } from 'perf_hooks'
import { describe, expect, it } from 'vitest'

import { parseDocx, saveDocx, type SaveBlock } from '@genoffice/docx-engine'
import { buildXlsxCheckpoint } from '../mona/xlsx-browser'
import { openSlidesDocument, saveSlidesDocument } from '../mona/slides-engine'

type JsonObject = Record<string, unknown>

const pythonGenerator = String.raw`
import json
import os
import platform
import sys
import time
from pathlib import Path

import win32com.client


def elapsed(start):
    return round((time.perf_counter() - start) * 1000, 1)


def generate_docx(root):
    path = root / "large-100-pages.docx"
    app = win32com.client.DispatchEx("Word.Application")
    app.Visible = False
    app.DisplayAlerts = 0
    try:
        start = time.perf_counter()
        doc = app.Documents.Add()
        selection = app.Selection
        for page in range(100):
            selection.TypeText("Mona performance document page %03d\r\n" % (page + 1))
            if page < 99:
                selection.InsertBreak(7)
        doc.SaveAs2(str(path), FileFormat=16)
        generation_ms = elapsed(start)
        doc.Close(SaveChanges=False)
        return path, generation_ms
    finally:
        app.Quit()


def generate_xlsx(root):
    path = root / "large-200k-cells.xlsx"
    app = win32com.client.DispatchEx("Excel.Application")
    app.Visible = False
    app.DisplayAlerts = False
    app.ScreenUpdating = False
    try:
        start = time.perf_counter()
        book = app.Workbooks.Add()
        sheet = book.Worksheets(1)
        sheet.Name = "Sheet1"
        rows, columns = 2000, 100
        values = [["r%04dc%03d" % (row + 1, column + 1) for column in range(columns)] for row in range(rows)]
        sheet.Range(sheet.Cells(1, 1), sheet.Cells(rows, columns)).Value2 = values
        book.SaveAs(str(path), FileFormat=51)
        generation_ms = elapsed(start)
        book.Close(SaveChanges=False)
        return path, generation_ms
    finally:
        app.Quit()


def generate_pptx(root):
    path = root / "large-100-slides.pptx"
    app = win32com.client.DispatchEx("PowerPoint.Application")
    try:
        start = time.perf_counter()
        deck = app.Presentations.Add()
        for slide_no in range(100):
            slide = deck.Slides.Add(slide_no + 1, 12)
            shape = slide.Shapes.AddTextbox(1, 100, 100, 600, 100)
            shape.TextFrame.TextRange.Text = "Mona performance slide %03d" % (slide_no + 1)
        deck.SaveAs(str(path), 24)
        generation_ms = elapsed(start)
        deck.Close()
        return path, generation_ms
    finally:
        app.Quit()


def read_docx(path):
    app = win32com.client.DispatchEx("Word.Application")
    app.Visible = False
    app.DisplayAlerts = 0
    try:
        start = time.perf_counter()
        doc = app.Documents.Open(FileName=str(path), ConfirmConversions=False, ReadOnly=True, AddToRecentFiles=False, Visible=False)
        pages = int(doc.ComputeStatistics(2))
        paragraphs = int(doc.Paragraphs.Count)
        open_read_ms = elapsed(start)
        doc.Close(SaveChanges=False)
        return {"openReadMs": open_read_ms, "pages": pages, "paragraphs": paragraphs}
    finally:
        app.Quit()


def read_xlsx(path):
    app = win32com.client.DispatchEx("Excel.Application")
    app.Visible = False
    app.DisplayAlerts = False
    app.ScreenUpdating = False
    try:
        start = time.perf_counter()
        book = app.Workbooks.Open(str(path), UpdateLinks=0, ReadOnly=True, AddToMru=False)
        sheet = book.Worksheets(1)
        used = sheet.UsedRange
        values = used.Value2
        rows = int(used.Rows.Count)
        columns = int(used.Columns.Count)
        sample = str(values[0][0] if isinstance(values, tuple) else values)
        open_read_ms = elapsed(start)
        book.Close(SaveChanges=False)
        return {"openReadMs": open_read_ms, "rows": rows, "columns": columns, "cellsRead": rows * columns, "sample": sample}
    finally:
        app.Quit()


def read_pptx(path):
    app = win32com.client.DispatchEx("PowerPoint.Application")
    try:
        start = time.perf_counter()
        deck = app.Presentations.Open(str(path), ReadOnly=True, Untitled=False, WithWindow=False)
        slides = int(deck.Slides.Count)
        text_shapes = 0
        text_characters = 0
        for slide in deck.Slides:
            for shape in slide.Shapes:
                try:
                    if shape.HasTextFrame:
                        text_shapes += 1
                        text_characters += len(str(shape.TextFrame.TextRange.Text))
                except Exception:
                    pass
        open_read_ms = elapsed(start)
        deck.Close()
        return {"openReadMs": open_read_ms, "slides": slides, "textShapes": text_shapes, "textCharacters": text_characters}
    finally:
        app.Quit()


def office_component(prog_id):
    app = None
    try:
        app = win32com.client.DispatchEx(prog_id)
        return {"available": True, "version": str(app.Version)}
    except Exception:
        return {"available": False, "version": None}
    finally:
        if app is not None:
            app.Quit()


def main():
    root = Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    docx_path, docx_generation_ms = generate_docx(root)
    xlsx_path, xlsx_generation_ms = generate_xlsx(root)
    pptx_path, pptx_generation_ms = generate_pptx(root)
    wps_candidates = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        base = os.environ.get(variable)
        if base:
            wps_candidates.append(Path(base) / "WPS Office")
    result = {
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "office": {
                "word": office_component("Word.Application"),
                "excel": office_component("Excel.Application"),
                "powerpoint": office_component("PowerPoint.Application"),
            },
            "wpsDetected": any(candidate.exists() for candidate in wps_candidates),
        },
        "files": {
            "docx": docx_path.name,
            "xlsx": xlsx_path.name,
            "pptx": pptx_path.name,
        },
        "docx": {"generationMs": docx_generation_ms, "office": read_docx(docx_path)},
        "xlsx": {"generationMs": xlsx_generation_ms, "office": read_xlsx(xlsx_path)},
        "pptx": {"generationMs": pptx_generation_ms, "office": read_pptx(pptx_path)},
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
`

const pythonOfficeValidator = String.raw`
import json
import sys
import win32com.client


def validate_docx(path):
    app = win32com.client.DispatchEx("Word.Application")
    app.Visible = False
    app.DisplayAlerts = 0
    try:
        doc = app.Documents.Open(FileName=path, ConfirmConversions=False, ReadOnly=True, AddToRecentFiles=False, Visible=False)
        result = {"pages": int(doc.ComputeStatistics(2)), "paragraphs": int(doc.Paragraphs.Count)}
        doc.Close(SaveChanges=False)
        return result
    finally:
        app.Quit()


def validate_xlsx(path):
    app = win32com.client.DispatchEx("Excel.Application")
    app.Visible = False
    app.DisplayAlerts = False
    app.ScreenUpdating = False
    try:
        book = app.Workbooks.Open(path, UpdateLinks=0, ReadOnly=True, AddToMru=False)
        used = book.Worksheets(1).UsedRange
        result = {"rows": int(used.Rows.Count), "columns": int(used.Columns.Count)}
        book.Close(SaveChanges=False)
        return result
    finally:
        app.Quit()


def validate_pptx(path):
    app = win32com.client.DispatchEx("PowerPoint.Application")
    try:
        deck = app.Presentations.Open(path, ReadOnly=True, Untitled=False, WithWindow=False)
        result = {"slides": int(deck.Slides.Count)}
        deck.Close()
        return result
    finally:
        app.Quit()


print(json.dumps({
    "docx": validate_docx(sys.argv[1]),
    "xlsx": validate_xlsx(sys.argv[2]),
    "pptx": validate_pptx(sys.argv[3]),
}, ensure_ascii=False))
`

function runFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${error.message}\n${stderr}`))
        return
      }
      resolvePromise(stdout.trim())
    })
  })
}

function parseJsonLine(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('sidecar returned non-object JSON')
  return parsed as JsonObject
}

function sidecarRequest(process: ReturnType<typeof spawn>, request: JsonObject): Promise<JsonObject> {
  return new Promise((resolvePromise, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      process.stdout?.off('data', onData)
      try {
        const response = parseJsonLine(line)
        if (response.ok !== true) reject(new Error(`sidecar request failed: ${JSON.stringify(response)}`))
        else resolvePromise(response)
      } catch (error) {
        reject(error)
      }
    }
    process.stdout?.on('data', onData)
    process.once('error', reject)
    process.stdin?.write(`${JSON.stringify(request)}\n`)
  })
}

async function measureSidecar(xlsxPath: string): Promise<JsonObject> {
  const sidecarPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src-tauri/resources/office-editor/sheets/xlsx-sidecar.exe')
  const process = spawn(sidecarPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  process.setMaxListeners(20)
  const requestId = () => Math.random().toString(16).slice(2)
  try {
    const openStart = performance.now()
    const opened = await sidecarRequest(process, {
      version: 1,
      requestId: requestId(),
      command: 'open',
      path: xlsxPath,
      locale: 'zh',
    })
    const openMs = performance.now() - openStart
    const result = opened.result as JsonObject
    const sheet = (result.sheets as JsonObject[])[0]
    const readStart = performance.now()
    let cells = 0
    for (let startRow = 0; startRow < 2000; startRow += 200) {
      const read = await sidecarRequest(process, {
        version: 1,
        requestId: requestId(),
        command: 'read_range',
        sessionId: result.sessionId,
        sheetId: sheet.id,
        range: { startRow, endRow: startRow + 199, startColumn: 0, endColumn: 99 },
      })
      cells += ((read.result as JsonObject).cells as unknown[]).length
    }
    const readMs = performance.now() - readStart
    await sidecarRequest(process, {
      version: 1,
      requestId: requestId(),
      command: 'close',
      sessionId: result.sessionId,
    })
    return { openMs: Number(openMs.toFixed(1)), readMs: Number(readMs.toFixed(1)), cells }
  } finally {
    process.kill()
  }
}

async function measureEngines(root: string, files: JsonObject): Promise<JsonObject> {
  const docxPath = join(root, String(files.docx))
  const xlsxPath = join(root, String(files.xlsx))
  const pptxPath = join(root, String(files.pptx))
  const docxBytes = await readFile(docxPath)
  const xlsxBytes = await readFile(xlsxPath)
  const pptxBytes = await readFile(pptxPath)

  const docxOpenStart = performance.now()
  const parsedDocx = await parseDocx(new Uint8Array(docxBytes))
  const docxOpenMs = performance.now() - docxOpenStart
  const saveBlocks = parsedDocx.blocks
    .filter((block) => !block.hidden)
    .map((block) => ({ kind: 'original' as const, docxIndex: block.docxIndex })) as SaveBlock[]
  const docxCheckpointStart = performance.now()
    const docxCheckpoint = await saveDocx(parsedDocx, saveBlocks, { pageColor: 'FFFFFF' })
  const docxCheckpointMs = performance.now() - docxCheckpointStart

  const xlsxCheckpointStart = performance.now()
  const xlsxCheckpoint = await buildXlsxCheckpoint(xlsxBytes.buffer.slice(xlsxBytes.byteOffset, xlsxBytes.byteOffset + xlsxBytes.byteLength), [{
    sheetName: 'Sheet1',
    row: 0,
    column: 0,
    writeValue: true,
    cell: { value: 'Mona checkpoint edit' },
  }])
  const xlsxCheckpointMs = performance.now() - xlsxCheckpointStart

  const pptxOpenStart = performance.now()
  const openedSlides = await openSlidesDocument(pptxBytes.buffer.slice(pptxBytes.byteOffset, pptxBytes.byteOffset + pptxBytes.byteLength))
  const pptxOpenMs = performance.now() - pptxOpenStart
  const pptxCheckpointStart = performance.now()
  const pptxCheckpoint = await saveSlidesDocument(openedSlides.opened)
  const pptxCheckpointMs = performance.now() - pptxCheckpointStart

  const sidecar = await measureSidecar(xlsxPath)
  const checkpointPaths = {
    docx: join(root, 'engine-checkpoint.docx'),
    xlsx: join(root, 'engine-checkpoint.xlsx'),
    pptx: join(root, 'engine-checkpoint.pptx'),
  }
  const exportWriteStart = performance.now()
  await writeFile(checkpointPaths.docx, docxCheckpoint)
  await writeFile(checkpointPaths.xlsx, new Uint8Array(xlsxCheckpoint))
  await writeFile(checkpointPaths.pptx, new Uint8Array(pptxCheckpoint))
  const exportWriteMs = Number((performance.now() - exportWriteStart).toFixed(1))
  const officeValidation = parseJsonLine(await runFile('python', [
    '-c',
    pythonOfficeValidator,
    checkpointPaths.docx,
    checkpointPaths.xlsx,
    checkpointPaths.pptx,
  ]))
  return {
    docx: {
      inputBytes: docxBytes.byteLength,
      parsedBlocks: parsedDocx.blocks.length,
      openMs: Number(docxOpenMs.toFixed(1)),
      checkpointMs: Number(docxCheckpointMs.toFixed(1)),
      checkpointBytes: docxCheckpoint.byteLength,
      exportWriteMs,
      checkpointReopenBlocks: (await parseDocx(new Uint8Array(docxCheckpoint))).blocks.length,
    },
    xlsx: {
      inputBytes: xlsxBytes.byteLength,
      sidecar,
      checkpointMs: Number(xlsxCheckpointMs.toFixed(1)),
      checkpointBytes: xlsxCheckpoint.byteLength,
      exportWriteMs,
    },
    pptx: {
      inputBytes: pptxBytes.byteLength,
      slides: openedSlides.slides.length,
      openMs: Number(pptxOpenMs.toFixed(1)),
      checkpointMs: Number(pptxCheckpointMs.toFixed(1)),
      checkpointBytes: pptxCheckpoint.byteLength,
      exportWriteMs,
      checkpointReopenSlides: (await openSlidesDocument(pptxCheckpoint)).slides.length,
    },
    officeValidation,
    sampleLocation: 'system temporary directory (not committed)',
  }
}

describe('one-time Office performance matrix', () => {
  it('measures representative large documents on the current machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mona-office-performance-'))
    const generated = parseJsonLine(await runFile('python', ['-c', pythonGenerator, root]))
    const engine = await measureEngines(root, generated.files as JsonObject)
    const result = { ...generated, engine }
    console.log(`OFFICE_PERFORMANCE_RESULT=${JSON.stringify(result)}`)
    expect((generated.docx as JsonObject).office).toBeTruthy()
    expect((generated.xlsx as JsonObject).office).toBeTruthy()
    expect((generated.pptx as JsonObject).office).toBeTruthy()
    expect((generated.docx as JsonObject).office).toMatchObject({ pages: 100 })
    expect((generated.xlsx as JsonObject).office).toMatchObject({ rows: 2000, columns: 100, cellsRead: 200000 })
    expect((generated.pptx as JsonObject).office).toMatchObject({ slides: 100 })
    expect((engine.docx as JsonObject).checkpointReopenBlocks).toBe(201)
    expect((engine.xlsx as JsonObject).sidecar).toMatchObject({ cells: 200000 })
    expect((engine.pptx as JsonObject).checkpointReopenSlides).toBe(100)
    for (const path of Object.values(generated.files as JsonObject)) {
      const info = await stat(join(root, String(path)))
      expect(info.size).toBeGreaterThan(0)
    }
  }, 300_000)
})
