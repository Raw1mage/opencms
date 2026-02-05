import { TextareaRenderable, TextAttributes, KeyEvent } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { onMount, createSignal, createMemo, Show, type JSX } from "solid-js"
import { useTextareaKeybindings } from "../component/textarea-keybindings"
import { useKeyboard } from "@opentui/solid"
import { debugCheckpoint } from "@/util/debug"

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

  // Filter out submit action - we handle enter key manually via useKeyboard
  const keybindings = createMemo(() => {
    const all = useTextareaKeybindings()()
    return (all || []).filter((kb) => kb.action !== "submit")
  })

  const submit = () => {
    const plainText = textarea?.plainText
    const textSignal = text()
    const val = (plainText || lastValidValue || textSignal || "").trim()
    debugCheckpoint("dialog-prompt", "submit called", {
      title: props.title,
      plainText: plainText ?? "(null)",
      lastValidValue,
      textSignal,
      finalVal: val,
      valLength: val.length,
    })
    if (!val) {
      debugCheckpoint("dialog-prompt", "submit blocked - empty value")
      return
    }
    debugCheckpoint("dialog-prompt", "calling onConfirm", { val })
    props.onConfirm?.(val)
  }

  useKeyboard((evt: KeyEvent) => {
    debugCheckpoint("dialog-prompt", "useKeyboard received", {
      key: evt.name,
      defaultPrevented: evt.defaultPrevented,
      textareaFocused: textarea?.focused ?? false,
      submitBtnFocused: submitBtn?.focused ?? false,
    })
    // Skip if already handled by onKeyDown
    if (evt.defaultPrevented) {
      debugCheckpoint("dialog-prompt", "useKeyboard skipped - defaultPrevented")
      return
    }
    // Handle enter for submit button only (textarea uses onKeyDown)
    if (evt.name === "return" || evt.name === "enter") {
      if (submitBtn?.focused) {
        evt.preventDefault()
        evt.stopPropagation()
        debugCheckpoint("dialog-prompt", "useKeyboard handling enter for submitBtn")
        submit()
        return
      }
      debugCheckpoint("dialog-prompt", "useKeyboard enter ignored - submitBtn not focused")
    }
    if (evt.name === "left" && !textarea?.focused && props.onCancel) {
      debugCheckpoint("dialog-prompt", "useKeyboard handling left for back")
      props.onCancel()
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "tab") {
      debugCheckpoint("dialog-prompt", "useKeyboard handling tab")
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
            debugCheckpoint("dialog-prompt", "onKeyDown received", {
              key: e.name,
              defaultPrevented: e.defaultPrevented,
              plainText: textarea?.plainText ?? "(null)",
            })
            // Handle enter before textarea processes it internally
            if (e.name === "return" || e.name === "enter") {
              if (e.shift || e.ctrl || e.meta || e.super) return
              debugCheckpoint("dialog-prompt", "onKeyDown handling enter - calling preventDefault")
              e.preventDefault()
              e.stopPropagation()
              debugCheckpoint("dialog-prompt", "onKeyDown calling submit")
              submit()
            }
          }}
          onContentChange={(val) => {
            const next = typeof val === "string" ? val : (val as any).text
            debugCheckpoint("dialog-prompt", "onContentChange", {
              rawVal: typeof val === "string" ? val : JSON.stringify(val),
              next,
              prevLastValidValue: lastValidValue,
            })
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
