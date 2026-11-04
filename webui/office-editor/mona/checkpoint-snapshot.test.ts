import { describe, expect, it, vi } from 'vitest'
import { checkpointSnapshot } from './checkpoint-snapshot'

describe('checkpointSnapshot', () => {
  it('serializes a revision once even when save and checkpoint race', async () => {
    const serialize = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const snapshot = checkpointSnapshot(serialize)
    const [first, second] = await Promise.all([snapshot(), snapshot()])
    expect(serialize).toHaveBeenCalledOnce()
    expect(first).toBe(second)
    const transferredCopy = first.slice().buffer
    structuredClone(transferredCopy, { transfer: [transferredCopy] })
    expect(await snapshot()).toEqual(new Uint8Array([1, 2, 3]))
    expect(serialize).toHaveBeenCalledOnce()
  })

  it('allows a failed or not-ready serialization to be retried', async () => {
    const serialize = vi.fn<() => Promise<Uint8Array | null>>()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(new Uint8Array([4]))
    const snapshot = checkpointSnapshot(serialize)
    await expect(snapshot()).rejects.toThrow('not ready')
    expect(await snapshot()).toBeNull()
    expect(await snapshot()).toEqual(new Uint8Array([4]))
    expect(await snapshot()).toEqual(new Uint8Array([4]))
    expect(serialize).toHaveBeenCalledTimes(3)
  })
})
