import { createSignal } from "solid-js"

export type RestartStatusOverride = { label: string; startedAt: number }

const [restartStatus, setRestartStatus] = createSignal<RestartStatusOverride | undefined>()

export { restartStatus, setRestartStatus }
