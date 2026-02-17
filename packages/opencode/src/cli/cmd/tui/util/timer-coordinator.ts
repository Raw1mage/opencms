import { Log } from "@/util/log"

type TimerTask = {
  id: string
  delay: number
  mode: "timeout" | "interval"
  handle?: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>
}

export function createTimerCoordinator(scope: string) {
  const tasks = new Map<string, TimerTask>()
  const diagnostics = process.env.OPENCODE_TUI_DIAGNOSTIC_TIMERS === "1"
  const log = Log.create({ service: `tui.timer.${scope}` })

  const clear = (id: string) => {
    const task = tasks.get(id)
    if (!task) return
    if (task.handle) {
      if (task.mode === "interval") clearInterval(task.handle as ReturnType<typeof setInterval>)
      else clearTimeout(task.handle as ReturnType<typeof setTimeout>)
    }
    tasks.delete(id)
  }

  const schedule = (id: string, fn: () => void, delay: number) => {
    clear(id)
    const normalizedDelay = Math.max(0, Math.floor(delay))
    const task: TimerTask = { id, delay: normalizedDelay, mode: "timeout" }
    task.handle = setTimeout(() => {
      task.handle = undefined
      fn()
    }, normalizedDelay)
    tasks.set(id, task)
    if (diagnostics) {
      log.info("timer scheduled", { id, delay: normalizedDelay, pending: tasks.size })
    }
  }

  const scheduleInterval = (id: string, fn: () => void, delay: number) => {
    clear(id)
    const normalizedDelay = Math.max(1, Math.floor(delay))
    const task: TimerTask = { id, delay: normalizedDelay, mode: "interval" }
    task.handle = setInterval(fn, normalizedDelay)
    tasks.set(id, task)
    if (diagnostics) {
      log.info("interval scheduled", { id, delay: normalizedDelay, pending: tasks.size })
    }
  }

  const dispose = () => {
    for (const [id, task] of tasks) {
      if (task.handle) {
        if (task.mode === "interval") clearInterval(task.handle as ReturnType<typeof setInterval>)
        else clearTimeout(task.handle as ReturnType<typeof setTimeout>)
      }
      tasks.delete(id)
    }
    if (diagnostics) {
      log.info("timer coordinator disposed", { pending: tasks.size })
    }
  }

  return {
    schedule,
    scheduleInterval,
    clear,
    dispose,
    pending() {
      return tasks.size
    },
  }
}
