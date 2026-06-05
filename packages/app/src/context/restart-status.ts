import { createSignal } from "solid-js"

export type RestartStatusOverride = { label: string; startedAt: number }

export type RestartWaitOptions = {
  label: string
  healthUrl: string
  startedAt?: number
  initialDelayMs?: number
  recoveryDeadlineMs?: number
  onTimeout?: () => void
}

const [restartStatus, setRestartStatus] = createSignal<RestartStatusOverride | undefined>()

let waitToken = 0

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function beginRestartWait(input: RestartWaitOptions) {
  const token = ++waitToken
  const startedAt = input.startedAt ?? Date.now()
  const initialDelayMs = input.initialDelayMs ?? 2500
  const recoveryDeadlineMs = input.recoveryDeadlineMs ?? 60_000
  const deadline = Date.now() + recoveryDeadlineMs

  setRestartStatus({ label: input.label, startedAt })

  void (async () => {
    await wait(initialDelayMs)
    while (token === waitToken && Date.now() < deadline) {
      try {
        const response = await fetch(input.healthUrl, { cache: "no-store" })
        if (response.ok) {
          const data = (await response.json()) as { healthy?: boolean }
          if (data.healthy) {
            window.location.reload()
            return
          }
        }
      } catch {}
      await wait(1000)
    }
    if (token === waitToken) input.onTimeout?.()
  })()
}

export function clearRestartWait() {
  waitToken++
  setRestartStatus(undefined)
}

export { restartStatus, setRestartStatus }
