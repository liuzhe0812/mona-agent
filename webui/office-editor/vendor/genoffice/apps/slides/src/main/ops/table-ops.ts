/**
 * Table and chart edit ops. Structure changes (merge/insert/delete) and style
 * edits reparse the slide, which regenerates element ids — those ops report
 * the surviving element's new id in the record's `after` so callers can keep
 * the selection.
 */
import {
  editChartElement,
  editTableCellText,
  editTableStructure,
  ensureTableStylePart,
  markChartEditable,
  mergeTableCells,
  setTableCellAnchor,
  setTableColWidth,
  setTableRowHeight,
  type Paragraph,
  type TableMergeOp,
  type TableStructureOp,
  type TableStyleEdit,
} from '@genoffice/pptx-engine'
import { editTableStyle } from '@genoffice/pptx-engine'
import { GuidedError, register, resolveElement, type OpRecord } from './registry'

register({
  name: 'setTableCell',
  validate(op, ctx) {
    resolveElement(ctx, op, { types: ['table'] })
    if (typeof op.row !== 'number' || typeof op.col !== 'number' || !Array.isArray(op.paragraphs)) {
      throw new GuidedError('op "setTableCell" needs "row", "col" and "paragraphs".')
    }
  },
  apply(op, ctx): OpRecord {
    const { slide, el } = resolveElement(ctx, op, { types: ['table'] })
    if (
      !editTableCellText(
        slide,
        el.id,
        op.row as number,
        op.col as number,
        op.paragraphs as Paragraph[],
      )
    ) {
      throw new GuidedError(
        `op "setTableCell": cell (${op.row}, ${op.col}) does not exist on table "${el.id}".`,
      )
    }
    return { op }
  },
})

register({
  name: 'tableMerge',
  validate(op, ctx) {
    resolveElement(ctx, op, { types: ['table'] })
    if (typeof op.kind !== 'string' || typeof op.row !== 'number' || typeof op.col !== 'number') {
      throw new GuidedError('op "tableMerge" needs "kind", "row" and "col".')
    }
  },
  apply(op, ctx): OpRecord {
    const { index, el } = resolveElement(ctx, op, { types: ['table'] })
    const r = mergeTableCells(ctx.opened, index, el.id, {
      kind: op.kind,
      row: op.row,
      col: op.col,
    } as TableMergeOp)
    if (!r) {
      throw new GuidedError(
        `op "tableMerge": ${op.kind} is not possible at (${op.row}, ${op.col}) — check merge boundaries.`,
      )
    }
    return { op, after: { elementId: r.elementId } }
  },
})

register({
  name: 'tableStructure',
  validate(op, ctx) {
    resolveElement(ctx, op, { types: ['table'] })
    if (typeof op.kind !== 'string' || typeof op.index !== 'number') {
      throw new GuidedError('op "tableStructure" needs "kind" and "index".')
    }
  },
  apply(op, ctx): OpRecord {
    const { index, el } = resolveElement(ctx, op, { types: ['table'] })
    const r = editTableStructure(ctx.opened, index, el.id, {
      kind: op.kind,
      index: op.index,
      ...(op.before ? { before: true } : {}),
    } as TableStructureOp)
    if (!r) {
      throw new GuidedError(
        `op "tableStructure": ${op.kind} at index ${op.index} failed (merges crossing the boundary?).`,
      )
    }
    return { op, after: { elementId: r.elementId } }
  },
})

register({
  name: 'setTableRowHeight',
  validate(op, ctx) {
    resolveElement(ctx, op, { types: ['table'] })
    if (typeof op.row !== 'number' || typeof op.hEmu !== 'number') {
      throw new GuidedError('op "setTableRowHeight" needs "row" and "hEmu".')
    }
  },
  apply(op, ctx): OpRecord {
    const { slide, el } = resolveElement(ctx, op, { types: ['table'] })
    if (!setTableRowHeight(slide, el.id, op.row as number, op.hEmu as number)) {
      throw new GuidedError(`op "setTableRowHeight": row ${op.row} does not exist on "${el.id}".`)
    }
    return { op }
  },
})

register({
  name: 'setTableCellAnchor',
  validate(op, ctx) {
    resolveElement(ctx, op, { types: ['table'] })
    if (typeof op.row !== 'number' || typeof op.col !== 'number') {
      throw new GuidedError('op "setTableCellAnchor" needs "row" and "col".')
    }
    if (!['top', 'middle', 'bottom'].includes(String(op.anchor))) {
      throw new GuidedError('op "setTableCellAnchor" needs "anchor": top/middle/bottom.')
    }
  },
  apply(op, ctx): OpRecord {
    const { slide, el } = resolveElement(ctx, op, { types: ['table'] })
    if (
      !setTableCellAnchor(
        slide,
        el.id,
        op.row as number,
        op.col as number,
        op.anchor as 'top' | 'middle' | 'bottom',
      )
    ) {
      throw new GuidedError(
        `op "setTableCellAnchor": cell (${op.row}, ${op.col}) does not exist on "${el.id}".`,
      )
    }
    return { op }
  },
})

register({
  name: 'setTableColWidth',
  validate(op, ctx) {
    resolveElement(ctx, op, { types: ['table'] })
    if (typeof op.col !== 'number' || typeof op.wEmu !== 'number') {
      throw new GuidedError('op "setTableColWidth" needs "col" and "wEmu".')
    }
  },
  apply(op, ctx): OpRecord {
    const { slide, el } = resolveElement(ctx, op, { types: ['table'] })
    if (!setTableColWidth(slide, el.id, op.col as number, op.wEmu as number)) {
      throw new GuidedError(`op "setTableColWidth": column ${op.col} does not exist on "${el.id}".`)
    }
    return { op }
  },
})

// ── setTableStyle ───────────────────────────────────────────────────────
// Preset-name resolution stays in the shim (the preset table is app data);
// the op takes the resolved TableStyleEdit plus an optional style part to
// inject (fixed-color presets pin their definition into tableStyles.xml).
register({
  name: 'setTableStyle',
  validate(op, ctx) {
    resolveElement(ctx, op, { types: ['table'] })
    if (typeof op.edit !== 'object' || op.edit === null) {
      throw new GuidedError('op "setTableStyle" needs "edit": a TableStyleEdit object.')
    }
  },
  apply(op, ctx): OpRecord {
    const { slide, el } = resolveElement(ctx, op, { types: ['table'] })
    const part = op.stylePart as { styleId: string; styleDefXml: string } | undefined
    if (part) ensureTableStylePart(ctx.opened, part.styleId, part.styleDefXml)
    if (!editTableStyle(slide, el.id, op.edit as TableStyleEdit)) {
      throw new GuidedError(`op "setTableStyle": table "${el.id}" rejected the style edit.`)
    }
    return { op, after: op.edit }
  },
})

// ── setChart ────────────────────────────────────────────────────────────
// Data/type edits rewrite the chart part; text-color-only edits can preserve
// an imported chart's original marker and formatting.
const CHART_PATCH_FIELDS = [
  'kind',
  'barDir',
  'categories',
  'series',
  'title',
  'colorScheme',
  'legendPos',
  'dataLabels',
  'gridlines',
  'catAxisTitle',
  'valAxisTitle',
  'gapWidthPct',
  'switchRowCol',
  'pointColors',
  'textColor',
  'titleColor',
  'axisLabelColor',
  'axisTitleColor',
  'legendColor',
  'dataLabelColor',
  'gridColor',
  'axisLineColor',
  'axisLabelFontSize',
] as const

const CHART_TEXT_COLOR_FIELDS = [
  'textColor',
  'titleColor',
  'axisLabelColor',
  'axisTitleColor',
  'legendColor',
  'dataLabelColor',
] as const

const CHART_KINDS = [
  'bar',
  'bar3D',
  'barStacked',
  'barPercentStacked',
  'line',
  'area',
  'pie',
  'pie3D',
  'doughnut',
  'scatter',
  'radar',
  'comboBarLine',
] as const

const CHART_LEGEND_POSITIONS = ['b', 't', 'r', 'l', 'none'] as const
const HEX_COLOR = /^#?[0-9a-fA-F]{6}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

function chartPatchError(reason: string, patch: unknown): never {
  throw new GuidedError(
    `op "setChart": ${reason} Received payload: ${JSON.stringify({ patch })}. ` +
      `Available patch fields: [${CHART_PATCH_FIELDS.join(', ')}].`,
  )
}

function validateChartPatch(
  patch: unknown,
  existing: { categories: string[]; series: Array<{ values: Array<number | null> }> },
): void {
  if (!isRecord(patch)) {
    chartPatchError('needs "patch": an object.', patch)
  }
  const keys = Object.keys(patch)
  if (!keys.length) chartPatchError('"patch" must contain at least one field.', patch)

  const unknown = keys.filter((key) => !(CHART_PATCH_FIELDS as readonly string[]).includes(key))
  if (unknown.length) {
    chartPatchError(`unknown patch field(s): ${unknown.join(', ')}.`, patch)
  }

  if (patch.kind !== undefined && !CHART_KINDS.includes(patch.kind as (typeof CHART_KINDS)[number])) {
    chartPatchError(`"kind" must be one of: ${CHART_KINDS.join(', ')}.`, patch)
  }
  if (patch.barDir !== undefined && patch.barDir !== 'col' && patch.barDir !== 'bar') {
    chartPatchError('"barDir" must be "col" or "bar".', patch)
  }

  const categories = patch.categories
  if (categories !== undefined) {
    if (!Array.isArray(categories) || categories.length === 0 || !categories.every((v) => typeof v === 'string')) {
      chartPatchError('"categories" must be a non-empty string array.', patch)
    }
  }

  const series = patch.series
  if (series !== undefined) {
    if (
      !Array.isArray(series) ||
      series.length === 0 ||
      !series.every(
        (value) =>
          isRecord(value) &&
          typeof value.name === 'string' &&
          Array.isArray(value.values) &&
          value.values.every(isFiniteNumber),
      )
    ) {
      chartPatchError('"series" must be a non-empty array of {name:string,values:number[]} objects.', patch)
    }
  }

  const nextCategories = (categories as string[] | undefined) ?? existing.categories
  const nextSeries =
    (series as Array<{ values: number[] }> | undefined) ??
    existing.series.map((item) => ({ values: item.values }))
  if (categories !== undefined || series !== undefined) {
    for (let index = 0; index < nextSeries.length; index += 1) {
      const item = nextSeries[index]!
      if (item.values.length !== nextCategories.length) {
        chartPatchError(
          `data dimensions do not match: categories has ${nextCategories.length} item(s), ` +
            `series[${index}].values has ${item.values.length}.`,
          patch,
        )
      }
    }
  }

  if (patch.title !== undefined && typeof patch.title !== 'string') {
    chartPatchError('"title" must be a string.', patch)
  }
  if (patch.colorScheme !== undefined) {
    if (
      !Array.isArray(patch.colorScheme) ||
      patch.colorScheme.length === 0 ||
      !patch.colorScheme.every(isHexColor)
    ) {
      chartPatchError('"colorScheme" must be a non-empty array of #RRGGBB or 6-digit HEX colors.', patch)
    }
  }
  if (
    patch.legendPos !== undefined &&
    !CHART_LEGEND_POSITIONS.includes(patch.legendPos as (typeof CHART_LEGEND_POSITIONS)[number])
  ) {
    chartPatchError(`"legendPos" must be one of: ${CHART_LEGEND_POSITIONS.join(', ')}.`, patch)
  }
  for (const field of ['dataLabels', 'gridlines', 'switchRowCol'] as const) {
    if (patch[field] !== undefined && typeof patch[field] !== 'boolean') {
      chartPatchError(`"${field}" must be a boolean.`, patch)
    }
  }
  for (const field of ['catAxisTitle', 'valAxisTitle'] as const) {
    if (patch[field] !== undefined && typeof patch[field] !== 'string') {
      chartPatchError(`"${field}" must be a string.`, patch)
    }
  }
  if (patch.gapWidthPct !== undefined && !isFiniteNumber(patch.gapWidthPct)) {
    chartPatchError('"gapWidthPct" must be a finite number.', patch)
  }

  if (patch.pointColors !== undefined) {
    if (!isRecord(patch.pointColors)) chartPatchError('"pointColors" must be an object.', patch)
    for (const [seriesIndex, points] of Object.entries(patch.pointColors)) {
      if (!/^\d+$/.test(seriesIndex) || Number(seriesIndex) >= nextSeries.length) {
        chartPatchError(`"pointColors" has an invalid series index: ${seriesIndex}.`, patch)
      }
      if (!isRecord(points)) {
        chartPatchError(`"pointColors[${seriesIndex}]" must be an object.`, patch)
      }
      for (const [pointIndex, color] of Object.entries(points)) {
        if (!/^\d+$/.test(pointIndex) || Number(pointIndex) >= nextCategories.length) {
          chartPatchError(`"pointColors[${seriesIndex}]" has an invalid point index: ${pointIndex}.`, patch)
        }
        if (color !== null && !isHexColor(color)) {
          chartPatchError(`"pointColors[${seriesIndex}][${pointIndex}]" must be #RRGGBB or null.`, patch)
        }
      }
    }
  }

  for (const field of [...CHART_TEXT_COLOR_FIELDS, 'gridColor', 'axisLineColor'] as const) {
    if (patch[field] !== undefined && !isHexColor(patch[field])) {
      chartPatchError(`"${field}" must be a #RRGGBB or 6-digit HEX color.`, patch)
    }
  }
  if (
    patch.axisLabelFontSize !== undefined &&
    (!isFiniteNumber(patch.axisLabelFontSize) || patch.axisLabelFontSize <= 0)
  ) {
    chartPatchError('"axisLabelFontSize" must be a finite number greater than 0 (points).', patch)
  }
}

function chartPatchNeedsEditableMarker(patch: unknown): boolean {
  if (!isRecord(patch)) return true
  return Object.keys(patch).some(
    (key) => !(CHART_TEXT_COLOR_FIELDS as readonly string[]).includes(key),
  )
}

register({
  name: 'setChart',
  validate(op, ctx) {
    const { el } = resolveElement(ctx, op, { types: ['chart'] })
    if (el.type !== 'chart') return
    validateChartPatch(op.patch, el.chart)
  },
  apply(op, ctx): OpRecord {
    const { index, slide, el } = resolveElement(ctx, op, { types: ['chart'] })
    // Only data/type edits opt an imported chart into the rebuild template.
    if (chartPatchNeedsEditableMarker(op.patch)) markChartEditable(slide, el.id)
    if (
      !editChartElement(
        ctx.opened,
        index,
        el.id,
        op.patch as Parameters<typeof editChartElement>[3],
      )
    ) {
      throw new GuidedError(`op "setChart": chart "${el.id}" rejected the edit.`)
    }
    return { op, after: op.patch }
  },
})
