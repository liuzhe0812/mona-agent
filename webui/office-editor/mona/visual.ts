import { toPng } from 'html-to-image'
import type { DocumentVersion } from './bridge'
import { sameDocumentVersion } from './version'

export class VisualVersionConflict extends Error {}

export async function captureEditorElement(
  element: HTMLElement,
  target: string,
  version: DocumentVersion,
  currentVersion: () => DocumentVersion | null,
) {
  await document.fonts.ready
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  const before = currentVersion()
  if (!before || !sameDocumentVersion(version, before)) throw new VisualVersionConflict('文档已变化，请重新读取后检查画面。')
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) throw new Error('编辑器当前不可见，无法检查画面。')
  const width = Math.min(4096, Math.ceil(rect.width))
  const height = Math.min(8192, Math.ceil(rect.height))
  const dataUrl = await toPng(element, {
    width, height, pixelRatio: 1, skipFonts: true, backgroundColor: '#ffffff',
    filter: (node) => !(node instanceof HTMLElement && node.hasAttribute('data-office-overlay')),
  })
  const after = currentVersion()
  if (!after || !sameDocumentVersion(version, after)) throw new VisualVersionConflict('检查画面时文档已变化，请重新检查。')
  if (dataUrl.length > 16_000_000) throw new Error('当前画面过大，请缩小检查范围。')
  return {
    mode: 'visual' as const, dataUrl, width, height, target,
    warnings: rect.width > width || rect.height > height ? ['画面过大，本次仅包含截图边界内的内容。'] : [],
  }
}
