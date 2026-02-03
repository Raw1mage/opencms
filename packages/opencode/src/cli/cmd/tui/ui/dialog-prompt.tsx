import { TextareaRenderable, TextAttributes, KeyEvent } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { onMount, createSignal, createMemo, Show, type JSX } from "solid-js"
import { useTextareaKeybindings } from "../component/textarea-keybindings"
import { useKeyboard } from "@opentui/solid"
import { Log } from "@/util/log"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable
  let submitBtn: any

  const [text, setText] = createSignal(props.value ?? "")
  let lastValidValue = props.value ?? ""

  const keybindings = createMemo(() => {
    const all = useTextareaKeybindings()()
    // Explicitly filter out submit to prevent textarea from handling it internally
    return (all || []).filter((kb) => kb.action !== "submit")
  })

  const submit = () => {
    // Priority: direct plainText from ref -> last non-empty tracked value -> fallback text signal
    const val = (textarea?.plainText || lastValidValue || text() || "").trim()
    Log.Default.info("DialogPrompt submit triggered", { title: props.title, length: val.length })
    if (!val) {
      Log.Default.warn("DialogPrompt submit blocked: empty value")
      return
    }
    props.onConfirm?.(val)
  }

  useKeyboard((evt: KeyEvent) => {
    if (evt.name === "return" || evt.name === "enter") {
      if (textarea?.focused || submitBtn?.focused) {
        Log.Default.info("Enter caught by useKeyboard in DialogPrompt")
        evt.preventDefault()
        evt.stopPropagation()
        submit()
      }
    }
    if (evt.name === "left" && !textarea?.focused && props.onCancel) {
      Log.Default.info("Left caught for Back action")
      props.onCancel()
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "tab") {
      Log.Default.info("Tab caught for focus switch")
      if (textarea?.focused) {
        textarea.blur()
        submitBtn?.focus()
      } else {
        submitBtn?.blur()
        textarea?.focus()
      }
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
      textarea.gotoLineEnd()
    }, 100)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <box flexDirection="row" gap={1}>
          <Show when={props.onCancel}>
            <text fg={theme.textMuted}>left back</text>
          </Show>
          <text fg={theme.textMuted}>esc</text>
        </box>
      </box>
      <box gap={1}>
        {props.description?.()}
        <textarea
          id={`input-${props.title.replace(/\s+/g, "-").toLowerCase()}`}
          onKeyDown={(e: KeyEvent) => {
            if (e.name === "return" || e.name === "enter") {
              const val = (textarea?.plainText || lastValidValue || "").trim()
              Log.Default.info("Enter caught by onKeyDown in textarea", { val })
              if (val) {
                e.preventDefault()
                e.stopPropagation()
                props.onConfirm?.(val)
              }
            }
          }}
          onContentChange={(val) => {
            const next = typeof val === "string" ? val : (val as any).text
            if (next && next.trim().length > 0) {
              lastValidValue = next
            }
            setText(next || "")
          }}
          focused
          height={3}
          keyBindings={keybindings()}
          ref={(val: TextareaRenderable) => (textarea = val)}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <box paddingBottom={1} gap={2} flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>submit</span>
        </text>
        <box
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.backgroundElement}
          onMouseUp={() => submit()}
          id="submit-button"
          ref={(val: any) => (submitBtn = val)}
          onKeyDown={(e: KeyEvent) => {
            if (e.name === "return" || e.name === "enter") {
              e.preventDefault()
              e.stopPropagation()
              submit()
            }
          }}
        >
          <text fg={theme.text}>submit</text>
        </box>
      </box>
      <box paddingBottom={1} flexDirection="row" justifyContent="flex-end">
        <text fg={theme.textMuted}>
          tab <span style={{ fg: theme.textMuted }}>switch focus</span>
        </text>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
