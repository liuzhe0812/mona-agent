import type { DocumentVersion } from './bridge'

export function sameDocumentVersion(
  left: DocumentVersion,
  right: DocumentVersion,
): boolean {
  return left.editorEpoch === right.editorEpoch && left.modelRevision === right.modelRevision
}
