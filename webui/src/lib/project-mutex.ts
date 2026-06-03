const locks = new Map<string, Promise<unknown>>()

export async function withProjectLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(projectPath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(
    projectPath,
    prev.then(() => next),
  )
  try {
    await prev.catch(() => {})
    return await fn()
  } finally {
    release()
    if (locks.get(projectPath) === next || locks.size > 1024) {
      const tail = locks.get(projectPath)
      if (tail) {
        Promise.resolve().then(() => {
          if (locks.get(projectPath) === tail) {
            locks.delete(projectPath)
          }
        })
      }
    }
  }
}

export function __resetProjectLocksForTesting(): void {
  locks.clear()
}
