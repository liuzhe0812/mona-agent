/** A document version must always produce the same checkpoint bytes. */
export function checkpointSnapshot<T>(serialize: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined
  return () => {
    result ??= Promise.resolve().then(serialize).then(value => {
      if (value == null) result = undefined
      return value
    }, error => {
      result = undefined
      throw error
    })
    return result
  }
}
