import { createSignal, onMount, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { Config } from "@/config/config"
import { useSync } from "@tui/context/sync"
import { Log } from "@/util/log"
import { useTheme } from "@tui/context/theme"
import { useKeyboard } from "@opentui/solid"
import { TextareaRenderable, TextAttributes, KeyEvent } from "@opentui/core"

interface Props {
  onSelect: (providerId: string) => void
  initialProviderID?: string
}

export function DialogProviderManualAdd(props: Props) {
  const dialog = useDialog()
  const sync = useSync()
  const { theme } = useTheme()

  // Field values
  const [providerId, setProviderID] = createSignal(props.initialProviderID || "")
  const [baseURL, setBaseURL] = createSignal("")
  const [modelIDs, setModelIDs] = createSignal("")

  // UI state
  const [focusedField, setFocusedField] = createSignal(0)
  const [status, setStatus] = createSignal<"input" | "saving" | "error">("input")
  const [errorMsg, setErrorMsg] = createSignal("")

  // Textarea refs
  let refId: TextareaRenderable | undefined
  let refURL: TextareaRenderable | undefined
  let refModels: TextareaRenderable | undefined

  const refs = () => [refId, refURL, refModels]

  const canSubmit = () => providerId().trim() && baseURL().trim() && modelIDs().trim()

  const focusField = (index: number) => {
    const clamped = Math.max(0, Math.min(index, 2))
    setFocusedField(clamped)
    const allRefs = refs()
    allRefs.forEach((ref, i) => {
      if (ref) {
        if (i === clamped) ref.focus()
        else ref.blur()
      }
    })
  }

  const parseModelIds = (input: string) => {
    const parts = input
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean)
    return Array.from(new Set(parts))
  }

  const handleSave = async () => {
    if (!canSubmit() || status() !== "input") return

    const pID = providerId().trim()
    const pURL = baseURL().trim().replace(/\/+$/, "")
    const mIDs = parseModelIds(modelIDs())

    if (mIDs.length === 0) {
      setStatus("error")
      setErrorMsg("Please enter at least one model ID")
      return
    }

    setStatus("saving")
    try {
      const modelsConfig: Record<string, any> = {}
      for (const id of mIDs) {
        modelsConfig[id] = {
          id,
          name: id,
          capabilities: {
            input: { text: true },
            output: { text: true },
          },
        }
      }

      const newConfig = {
        provider: {
          [pID]: {
            name: pID,
            api: pURL,
            source: "custom",
            models: modelsConfig,
          },
        },
      }

      await Config.updateGlobal(newConfig as any)
      await sync.bootstrap()
      dialog.pop()
      props.onSelect(pID)
    } catch (e: any) {
      Log.Default.error("Failed to save custom provider", { error: e })
      setStatus("error")
      setErrorMsg(e.message || "Failed to save configuration")
    }
  }

  useKeyboard((evt: KeyEvent) => {
    if (status() !== "input") return

    if (evt.name === "up") {
      evt.preventDefault()
      focusField(focusedField() - 1)
      return
    }
    if (evt.name === "down" || evt.name === "tab") {
      evt.preventDefault()
      focusField(focusedField() + 1)
      return
    }

    if ((evt.name === "return" || evt.name === "enter") && evt.ctrl) {
      evt.preventDefault()
      handleSave()
      return
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => focusField(0), 50)
  })

  const handleEnter = (index: number) => (e: KeyEvent) => {
    if (e.name === "return" || e.name === "enter") {
      if (e.shift || e.ctrl || e.meta || e.super) return
      e.preventDefault()
      if (index < 2) {
        focusField(index + 1)
      }
    }
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Add Custom Provider
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      <Show when={status() === "input"}>
        <text fg={theme.textMuted}>
          Define a provider (URL + models). API keys are added later under the provider account.
        </text>

        <box>
          <text fg={focusedField() === 0 ? theme.text : theme.textMuted}>Provider ID</text>
          <textarea
            ref={(el: TextareaRenderable) => (refId = el)}
            height={1}
            placeholder="e.g. gmicloud"
            textColor={theme.text}
            cursorColor={theme.primary}
            backgroundColor={focusedField() === 0 ? theme.backgroundElement : undefined}
            onContentChange={(v) => setProviderID(typeof v === "string" ? v : (v as any).text || "")}
            onKeyDown={handleEnter(0)}
          />
        </box>

        <box>
          <text fg={focusedField() === 1 ? theme.text : theme.textMuted}>API Base URL</text>
          <textarea
            ref={(el: TextareaRenderable) => (refURL = el)}
            height={1}
            placeholder="e.g. https://api.gmi-serving.com/v1"
            textColor={theme.text}
            cursorColor={theme.primary}
            backgroundColor={focusedField() === 1 ? theme.backgroundElement : undefined}
            onContentChange={(v) => setBaseURL(typeof v === "string" ? v : (v as any).text || "")}
            onKeyDown={handleEnter(1)}
          />
        </box>

        <box>
          <text fg={focusedField() === 2 ? theme.text : theme.textMuted}>Model IDs</text>
          <textarea
            ref={(el: TextareaRenderable) => (refModels = el)}
            height={3}
            placeholder="e.g. deepseek-ai/DeepSeek-R1, deepseek-ai/DeepSeek-V3"
            textColor={theme.text}
            cursorColor={theme.primary}
            backgroundColor={focusedField() === 2 ? theme.backgroundElement : undefined}
            onContentChange={(v) => setModelIDs(typeof v === "string" ? v : (v as any).text || "")}
            onKeyDown={handleEnter(2)}
          />
        </box>

        <box paddingTop={1} flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>↑↓ navigate</text>
          <text fg={canSubmit() ? theme.accent : theme.textMuted}>ctrl+enter save</text>
        </box>
      </Show>

      <Show when={status() === "saving"}>
        <text fg={theme.text}>Saving provider configuration...</text>
      </Show>

      <Show when={status() === "error"}>
        <text fg={theme.error}>Error: {errorMsg()}</text>
        <text fg={theme.textMuted}>Press any key to try again</text>
      </Show>
    </box>
  )
}
