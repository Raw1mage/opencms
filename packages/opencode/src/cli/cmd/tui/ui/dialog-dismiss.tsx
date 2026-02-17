import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"

export function DialogDismiss(props: { label?: string; onDismiss: () => void }) {
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={hover() ? theme.primary : undefined}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => props.onDismiss()}
    >
      <text fg={hover() ? theme.selectedListItemText : theme.textMuted}>{props.label ?? "esc"}</text>
    </box>
  )
}
