import { describe, expect, it } from 'vitest'

import { sameDocumentVersion } from './version'

describe('editor final version check', () => {
  it('rejects every stale command even when the manager mirror was delayed', () => {
    for (let iteration = 0; iteration < 1000; iteration += 1) {
      expect(sameDocumentVersion(
        { editorEpoch: 'epoch_1', modelRevision: iteration },
        { editorEpoch: 'epoch_1', modelRevision: iteration + 1 },
      )).toBe(false)
    }
  })

  it('requires both the editor epoch and revision to match', () => {
    expect(sameDocumentVersion(
      { editorEpoch: 'epoch_old', modelRevision: 9 },
      { editorEpoch: 'epoch_new', modelRevision: 9 },
    )).toBe(false)
    expect(sameDocumentVersion(
      { editorEpoch: 'epoch_1', modelRevision: 9 },
      { editorEpoch: 'epoch_1', modelRevision: 9 },
    )).toBe(true)
  })
})
