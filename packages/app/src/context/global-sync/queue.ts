export function createRefreshQueue(options: {
  paused: () => boolean
  bootstrap: () => Promise<any>
  bootstrapInstance: (directory: string) => Promise<void>
}) {
  const queued = new Set<string>()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const item of queued) {
      queued.delete(item)
      items.push(item)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (!directory) return
    queued.add(directory)
    if (options.paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (options.paused()) return
    schedule()
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (true) {
        if (options.paused()) return

        if (root) {
          root = false
          await options.bootstrap()
          await tick()
          continue
        }

        const dirs = take(2)
        if (dirs.length === 0) return

        await Promise.all(dirs.map((dir) => options.bootstrapInstance(dir)))
        await tick()
      }
    } finally {
      running = false
      if (options.paused()) return
      if (root || queued.size) schedule()
    }
  }

  return {
    push,
    refresh,
    clear: (directory: string) => queued.delete(directory),
    dispose: () => {
      if (timer) clearTimeout(timer)
    },
  }
}
