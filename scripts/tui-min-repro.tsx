import { render, useRenderer, useTerminalDimensions, useKeyboard } from "@opentui/solid"

const seconds = (() => {
  const raw = process.env.MIN_REPRO_SECONDS
  if (!raw) return 45
  const n = Number(raw)
  if (!Number.isFinite(n)) return 45
  return Math.max(5, Math.min(300, Math.floor(n)))
})()

const targetFps = (() => {
  const raw = process.env.MIN_REPRO_FPS
  if (!raw) return 60
  const n = Number(raw)
  if (!Number.isFinite(n)) return 60
  return Math.max(1, Math.min(120, Math.floor(n)))
})()

function View() {
  const renderer = useRenderer()
  const dimensions = process.env.MIN_REPRO_USE_DIMS === "1" ? useTerminalDimensions() : undefined
  const keyboardEnabled = process.env.MIN_REPRO_USE_KEYBOARD === "1"
  if (keyboardEnabled) {
    useKeyboard(() => {})
  }
  if (process.env.MIN_REPRO_DISABLE_STDOUT_INTERCEPT === "1") {
    renderer.disableStdoutInterception()
  }
  if (process.env.MIN_REPRO_FORCE_AUTO === "1") {
    renderer.auto()
  }
  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" flexDirection="column">
      <text>OpenCode TUI minimal reproduction</text>
      <text>Static frame, no app sync/events</text>
      <text>
        targetFps={targetFps} duration={seconds}s
      </text>
      <text>disableStdoutIntercept={process.env.MIN_REPRO_DISABLE_STDOUT_INTERCEPT === "1" ? "1" : "0"}</text>
      <text>
        useDims={dimensions ? "1" : "0"} useKeyboard={keyboardEnabled ? "1" : "0"}
      </text>
      {dimensions ? (
        <text>
          {dimensions().width}x{dimensions().height}
        </text>
      ) : null}
    </box>
  )
}

render(() => <View />, {
  targetFps,
  maxFps: targetFps,
  useMouse: false,
  enableMouseMovement: false,
  useThread: false,
  debounceDelay: 100,
  useKittyKeyboard: null,
  exitOnCtrlC: true,
})

setTimeout(() => {
  process.exit(0)
}, seconds * 1000)
