import JSZip from 'jszip'

import {
  planCellEditsToXlsx,
  type CellEdit,
  type EntrySource,
  type SheetCfState,
  type SheetEditPlan,
  type SheetFilterState,
  type SheetPageSetupState,
  type SheetStructuralOps,
  type StructuralOp,
} from '@mona-xlsx-gateway'

export type {
  CellEdit,
  SheetCfState,
  SheetEditPlan,
  SheetFilterState,
  SheetPageSetupState,
  SheetStructuralOps,
  StructuralOp,
}

export interface XlsxCheckpointExtras {
  filterStates?: readonly SheetFilterState[]
  cfStates?: readonly SheetCfState[]
  pageSetupStates?: readonly SheetPageSetupState[]
}

export async function buildXlsxCheckpoint(
  source: ArrayBuffer,
  edits: readonly CellEdit[],
  structuralOps: readonly SheetStructuralOps[] = [],
  sheetPlan?: SheetEditPlan,
  extras: XlsxCheckpointExtras = {},
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(source)
  const entrySource: EntrySource = {
    paths: async () => Object.entries(zip.files)
      .filter(([, file]) => !file.dir)
      .map(([path]) => path),
    has: async (path) => zip.file(path) !== null,
    readText: async (path) => {
      const entry = zip.file(path)
      if (!entry) throw new Error(`工作簿缺少 ${path}。`)
      return entry.async('string')
    },
  }
  const plan = await planCellEditsToXlsx(
    entrySource,
    edits,
    structuralOps,
    [],
    sheetPlan,
    extras.filterStates ?? [],
    [],
    extras.cfStates ?? [],
    [],
    [],
    null,
    [],
    extras.pageSetupStates ?? [],
  )
  for (const path of plan.removedEntries) zip.remove(path)
  for (const [path, content] of plan.replaced) zip.file(path, content, { createFolders: false })
  for (const [path, content] of plan.added) zip.file(path, content, { createFolders: false })
  for (const [path, bytes] of plan.addedBinary) zip.file(path, bytes, { createFolders: false })
  return zip.generateAsync({
    type: 'arraybuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}
