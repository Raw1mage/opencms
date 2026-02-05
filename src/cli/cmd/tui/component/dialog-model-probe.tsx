import "opentui-spinner/solid"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function DialogModelProbe(props: { providerID: string; modelID: string; prompt: string }) {
  const { theme } = useTheme()

  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Testing model
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box paddingTop={1} flexDirection="row" gap={1}>
        <spinner frames={spinnerFrames} interval={80} color={theme.primary} />
        <text fg={theme.textMuted}>Sending "{props.prompt}"…</text>
      </box>
      <box paddingTop={1}>
        <text fg={theme.textMuted}>
          {props.providerID}/{props.modelID}
        </text>
      </box>
    </box>
  )
}
