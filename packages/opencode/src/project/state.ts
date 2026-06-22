import { Log } from "@/util/log"

export namespace State {
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
  }

  const log = Log.create({ service: "state" })
  const recordsByKey = new Map<string, Map<any, Entry>>()

  export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    return () => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose,
      })
      return state
    }
  }

  export function reset(key: string, init: any) {
    const entries = recordsByKey.get(key)
    if (!entries) return
    entries.delete(init)
  }

  /**
   * Drop the cached entry for `init` across EVERY key bucket.
   *
   * `reset(key, init)` only clears the bucket of the directory that happens to
   * be the active AsyncLocalStorage context at call time. For process-wide
   * caches (e.g. the Skill index, which is a single on-disk scan shared by all
   * instances) that is wrong: a daemon serving multiple cwds keeps one bucket
   * per `Instance.directory`, so a reset issued from instance A leaves instance
   * B's stale bucket intact. This clears the same `init` from all of them so the
   * next read in any instance re-runs `init()`.
   */
  export function resetAcrossKeys(init: any) {
    for (const entries of recordsByKey.values()) {
      entries.delete(init)
    }
  }

  export async function dispose(key: string) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    let disposalFinished = false

    setTimeout(() => {
      if (!disposalFinished) {
        log.warn(
          "state disposal is taking an unusually long time - if it does not complete in a reasonable time, please report this as a bug",
          { key },
        )
      }
    }, 10000).unref()

    const tasks: Promise<void>[] = []
    for (const [init, entry] of entries) {
      if (!entry.dispose) continue

      const label = typeof init === "function" ? init.name : String(init)

      const task = Promise.resolve(entry.state)
        .then((state) => entry.dispose!(state))
        .catch((error) => {
          log.error("Error while disposing state:", { error, key, init: label })
        })

      tasks.push(task)
    }
    await Promise.all(tasks)

    entries.clear()
    recordsByKey.delete(key)

    disposalFinished = true
    log.info("state disposal completed", { key })
  }
}
