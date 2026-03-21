import { BoxRenderable, TextareaRenderable, MouseEvent, PasteEvent, t, dim, fg } from "@opentui/core"
import {
  createEffect,
  createMemo,
  type JSX,
  onMount,
  createSignal,
  onCleanup,
  Show,
  Switch,
  Match,
  createResource,
} from "solid-js"
import "opentui-spinner/solid"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { EmptyBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { Identifier } from "@/id/id"
import { createStore, produce } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer } from "@opentui/solid"
import { Editor } from "@tui/util/editor"
import { useExit } from "../../context/exit"
import { Clipboard } from "../../util/clipboard"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import { createColors, createFrames } from "../../ui/spinner.ts"
import { debugCheckpoint } from "@/util/debug"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAdmin } from "../dialog-admin"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { Account } from "@/account"
import { formatOpenAIQuotaDisplay, getOpenAIQuotaForDisplay, OPENAI_QUOTA_DISPLAY_TTL_MS } from "@/account/quota"
import { createTimerCoordinator } from "../../util/timer-coordinator"
import { buildVariantOptions, getEffectiveVariantValue, shouldShowVariantControl } from "../../util/model-variant"
import { isNarrationAssistantMessage } from "@/session/narration"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef) => void
  hint?: JSX.Element
  showPlaceholder?: boolean
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const PLACEHOLDERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"]
export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const activeWorkers = createMemo(() => sync.data.active_workers ?? 0)
  const hasActivity = createMemo(() => status().type !== "idle" || activeWorkers() > 0)
  const modelSelectionKey = (input?: { providerId?: string; modelID?: string; accountId?: string }) =>
    `${input?.providerId ?? ""}:${input?.modelID ?? ""}:${input?.accountId ?? ""}`
  const retryStatus = createMemo(() => {
    const s = status()
    if (s.type !== "retry") return
    return s
  })
  const retryMessage = createMemo(() => {
    const r = retryStatus()
    if (!r) return
    if (r.message.includes("exceeded your current quota") && r.message.includes("gemini")) {
      return "gemini is way too hot right now"
    }
    if (r.message.length > 80) return r.message.slice(0, 80) + "..."
    return r.message
  })
  const retryIsTruncated = createMemo(() => {
    const r = retryStatus()
    if (!r) return false
    return r.message.length > 120
  })
  const [retrySeconds, setRetrySeconds] = createSignal(0)
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const [rateLimitKey, setRateLimitKey] = createSignal("")
  const [quotaRefresh, setQuotaRefresh] = createSignal(0)
  const [lastQuotaRefreshAt, setLastQuotaRefreshAt] = createSignal(0)
  const [lastQuotaRefreshMarker, setLastQuotaRefreshMarker] = createSignal<string>("")
  const [footerTick, setFooterTick] = createSignal(0)
  const timers = createTimerCoordinator("prompt")
  onCleanup(() => timers.dispose())
  const perfProbeMode = process.env.OPENCODE_TUI_PERF_PROBE === "1"
  const disableFooterMeta = perfProbeMode || process.env.OPENCODE_TUI_DISABLE_FOOTER_META === "1"
  const defaultAnimationsEnabled = process.env.TERM_PROGRAM === "vscode" || process.env.VSCODE_PID ? false : true
  const isRateLimitMessage = (message: string) => {
    const text = message.toLowerCase()
    return text.includes("rate limit") || text.includes("too many requests") || text.includes("429")
  }

  const lastCompletedAssistant = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID] ?? []
    return messages.findLast((m) => m.role === "assistant" && m.time?.completed)
  })

  const currentQuotaProviderKey = createMemo(() => {
    if (disableFooterMeta) return undefined
    const providerId = local.model.current(props.sessionID)?.providerId
    if (!providerId) return undefined
    return Account.parseProvider(providerId) ?? providerId
  })

  const requestOpenAIQuotaRefresh = (options?: { force?: boolean }) => {
    if (disableFooterMeta) return
    if (currentQuotaProviderKey() !== "openai") return
    const now = Date.now()
    if (!options?.force && now - lastQuotaRefreshAt() < OPENAI_QUOTA_DISPLAY_TTL_MS) return
    setLastQuotaRefreshAt(now)
    setQuotaRefresh((v) => v + 1)
  }

  createEffect(() => {
    if (currentQuotaProviderKey() !== "openai") return
    requestOpenAIQuotaRefresh()
  })

  createEffect(() => {
    const last = lastCompletedAssistant()
    const completed =
      last && "completed" in last.time && typeof last.time.completed === "number" ? last.time.completed : undefined
    if (!last || completed === undefined) return
    const marker = `${last.id}:${completed}`
    if (marker === lastQuotaRefreshMarker()) return
    setLastQuotaRefreshMarker(marker)
    requestOpenAIQuotaRefresh()
  })

  const footerRefreshMs = (() => {
    if (disableFooterMeta) return 60000
    const raw = process.env.OPENCODE_TUI_FOOTER_REFRESH_MS
    if (!raw) return 15000
    const n = Number(raw)
    if (!Number.isFinite(n)) return 15000
    return Math.max(1000, Math.min(120000, Math.floor(n)))
  })()
  if (!disableFooterMeta) {
    timers.scheduleInterval("footer-tick", () => setFooterTick((t) => t + 1), footerRefreshMs)
  } else {
    timers.clear("footer-tick")
  }

  createEffect(() => {
    const retry = retryStatus()
    if (!retry) {
      timers.clear("retry-countdown")
      setRetrySeconds(0)
      return
    }
    const update = () => {
      const next = retryStatus()?.next
      if (next) setRetrySeconds(Math.round((next - Date.now()) / 1000))
    }
    update()
    timers.scheduleInterval("retry-countdown", update, 1000)
  })

  const [activeAccountDisplay] = createResource(
    () => {
      if (disableFooterMeta) return undefined
      const current = local.model.current(props.sessionID)
      const providerId = current?.providerId
      if (!providerId) return ""
      const accountId = local.model.currentAccountId(props.sessionID) ?? ""
      return `${providerId}:${accountId}:${footerTick()}`
    },
    async (key) => {
      const [providerId, selectedAccountId] = key.split(":")
      if (!providerId) return undefined
      if (!selectedAccountId) return undefined
      try {
        const providerKey = Account.parseProvider(providerId) || providerId
        const info = await Account.get(providerKey, selectedAccountId)
        if (!info) {
          return {
            id: selectedAccountId,
            label: selectedAccountId,
          }
        }
        return {
          id: selectedAccountId,
          label: Account.getDisplayName(selectedAccountId, info, providerId) || selectedAccountId,
        }
      } catch {
        // Footer account metadata is best-effort display state only.
        return undefined
      }
    },
  )

  const activeAccountLabel = createMemo(() => activeAccountDisplay()?.label)

  const [codexQuota] = createResource(
    () => {
      if (disableFooterMeta) return undefined
      if (currentQuotaProviderKey() !== "openai") return undefined
      const activeId = activeAccountDisplay()?.id
      if (!activeId) return undefined
      return `${activeId}:${quotaRefresh()}`
    },
    async (key) => {
      const [activeId] = key.split(":")
      if (!activeId) return null
      try {
        return (await getOpenAIQuotaForDisplay(activeId)) ?? null
      } catch {
        return null
      }
    },
  )

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0

  sdk.event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  createEffect(() => {
    const s = status()
    if (s.type !== "retry") {
      if (rateLimitKey()) setRateLimitKey("")
      return
    }
    if (!isRateLimitMessage(s.message)) return

    const key = `${props.sessionID ?? ""}:${s.message}`
    if (rateLimitKey() === key) return

    setRateLimitKey(key)
    const savedPrompt = store.prompt.input
    const targetProvider = local.model.current(props.sessionID)?.providerId
    dialog.replace(
      () => <DialogAdmin targetProviderID={targetProvider ?? undefined} />,
      () => {
        setStore("prompt", (prev) => ({
          ...prev,
          input: savedPrompt,
        }))
        if (input && !input.isDestroyed) {
          input.setText(savedPrompt)
          input.gotoBufferEnd()
          input.focus()
        }
      },
    )
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m) => m.role === "user")
  })

  const lastAssistantMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m) => m.role === "assistant")
  })
  const footerElapsed = createMemo(() => {
    footerTick()
    const msg = lastAssistantMessage()
    if (!msg) return undefined
    const start = msg.time?.created
    if (!start) return undefined
    const end = msg.time?.completed ?? (status().type !== "idle" ? Date.now() : undefined)
    if (!end || end <= start) return undefined
    return Locale.duration(end - start)
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: Math.floor(Math.random() * PLACEHOLDERS.length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return

      syncedSessionID = sessionID

      // Only set agent if it's a primary agent (not a subagent)
      const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
      if (msg.agent && isPrimaryAgent) {
        local.agent.set(msg.agent)
        if (msg.model) local.model.set(msg.model, undefined, props.sessionID)
        if (msg.variant) local.model.variant.set(msg.variant, props.sessionID)
      }
    }
  })

  // Sync model/variant from last assistant message (rotation3d fallback)
  // Track both message ID and model to detect fallback updates within same message
  let syncedAssistantMessageKey: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastAssistantMessage()
    if (!sessionID || !msg) return
    const messageAccountId = "accountId" in msg && typeof msg.accountId === "string" ? msg.accountId : undefined
    const parts = sync.data.part[msg.id] ?? []

    // Use composite key to detect both new messages AND model changes within same message
    const messageKey = `${msg.id}:${msg.providerId}:${msg.modelID}:${messageAccountId ?? ""}`
    if (messageKey === syncedAssistantMessageKey) return
    syncedAssistantMessageKey = messageKey

    const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
    if (msg.agent && !isPrimaryAgent) return
    if (isNarrationAssistantMessage(msg as any, parts as any)) return

    if (msg.providerId && msg.modelID) {
      const lastUserModel = lastUserMessage()?.model
      const lastUserModelKey = modelSelectionKey(lastUserModel)
      const current = local.model.current(props.sessionID)
      const currentSelectionKey = modelSelectionKey(current)

      if (lastUserModelKey && currentSelectionKey && currentSelectionKey !== lastUserModelKey) {
        return
      }
      if (
        !messageAccountId &&
        current?.accountId &&
        current.providerId === msg.providerId &&
        current.modelID === msg.modelID
      ) {
        return
      }

      const same =
        current &&
        current.providerId === msg.providerId &&
        current.modelID === msg.modelID &&
        current.accountId === messageAccountId
      if (!same) {
        // recent: true persists the fallback model so it's used on next startup
        local.model.set(
          { providerId: msg.providerId, modelID: msg.modelID, accountId: messageAccountId },
          { skipValidation: true, announce: false, recent: true },
          props.sessionID,
        )
      }
    }
  })

  command.register(() => {
    return [
      {
        title: "Clear prompt",
        value: "prompt.clear",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        value: "prompt.submit",
        keybind: "input_submit",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          if (!input.focused) return
          submit()
          dialog.clear()
        },
      },
      {
        title: "Exit shell mode",
        value: "prompt.shell.exit",
        category: "Prompt",
        hidden: true,
        enabled: store.mode === "shell",
        onSelect: (dialog) => {
          setStore("mode", "normal")
          dialog.clear()
        },
      },
      {
        title: "Paste",
        value: "prompt.paste",
        keybind: "input_paste",
        category: "Prompt",
        hidden: true,
        onSelect: async () => {
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteImage({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
            toast.show({ message: "Image pasted from clipboard", variant: "success" })
          } else {
            // Text fallback for /paste command
            input.insertText(content?.data ?? "")
            setTimeout(() => {
              if (!input || input.isDestroyed) return
              input.getLayoutNode().markDirty()
              renderer.requestRender()
            }, 0)
            if (!content) {
              toast.show({
                message: "Clipboard is empty or image not accessible (check OPENCODE_CLIPBOARD_IMAGE_PATH)",
                variant: "warning",
              })
            } else {
              toast.show({ message: "Text pasted from clipboard", variant: "success" })
            }
          }
        },
      },
      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          if (autocomplete.visible) return
          if (!input.focused) return
          if (store.mode === "shell") {
            command.trigger("prompt.shell.exit")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 3) {
            // Triple-Esc: emergency abort-all (kill switch)
            fetch(`${sdk.url}/api/v2/session/abort-all`, { method: "POST" }).catch(() => {})
            setStore("interrupt", 0)
          } else if (store.interrupt >= 2) {
            sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        keybind: "editor_open",
        value: "prompt.editor",
        onSelect: async (dialog) => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      submit()
    },
  }

  createEffect(() => {
    if (props.visible !== false) {
      setTimeout(() => {
        if (!input || input.isDestroyed) return
        if (props.visible !== false) input.focus()
      }, 0)
    }
    if (props.visible === false) input?.blur()
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: "Stash prompt",
      value: "prompt.stash",
      category: "Prompt",
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: "Stash pop",
      value: "prompt.stash.pop",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: "Stash list",
      value: "prompt.stash.list",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  async function submit() {
    if (props.disabled) return
    if (autocomplete?.visible) return
    if (!store.prompt.input) return
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      exit()
      return
    }
    const selectedModel = local.model.current(props.sessionID)
    if (!selectedModel) {
      promptModelWarning()
      return
    }
    const sessionID = props.sessionID
      ? props.sessionID
      : await (async () => {
          const sessionID = await sdk.client.session.create({}).then((x) => x.data!.id)
          return sessionID
        })()
    const messageID = Identifier.ascending("message")
    let inputText = store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const variant = local.model.variant.current(props.sessionID)
    const autonomous = true // always-on

    if (store.mode === "shell") {
      sdk.client.session.shell({
        sessionID,
        agent: local.agent.current()?.name || "agent",
        model: {
          providerId: selectedModel.providerId,
          modelID: selectedModel.modelID,
          accountId: local.model.currentAccountId(props.sessionID),
        } as any,
        command: inputText,
      })
      setStore("mode", "normal")
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      sdk.client.session.command({
        sessionID,
        command: command.slice(1),
        arguments: args,
        agent: local.agent.current()?.name || "agent",
        model: {
          providerId: selectedModel.providerId,
          modelID: selectedModel.modelID,
          accountId: local.model.currentAccountId(props.sessionID),
        } as any,
        messageID,
        variant,
        parts: nonTextParts
          .filter((x) => x.type === "file")
          .map((x) => ({
            id: Identifier.ascending("part"),
            ...x,
          })),
      })
    } else {
      sdk.client.session
        .prompt({
          sessionID,
          ...selectedModel,
          messageID,
          agent: local.agent.current()?.name || "agent",
          model: selectedModel,
          variant,
          autonomous,
          parts: [
            {
              id: Identifier.ascending("part"),
              type: "text",
              text: inputText,
            },
            ...nonTextParts.map((x) => ({
              id: Identifier.ascending("part"),
              ...x,
            })),
          ],
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error("Failed to submit prompt:", error)
          toast.show({
            variant: "error",
            message: `Send failed: ${message}`,
            duration: 4000,
          })
        })
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID)
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    input.clear()
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteImage(file: { filename?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const count = store.prompt.parts.filter((x) => x.type === "file").length
    const virtualText = `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    debugCheckpoint("tui.paste", "image", {
      mime: part.mime,
      filename: part.filename,
      sourceType: part.source?.type,
      sourcePath: part.source?.type === "file" ? part.source.path : undefined,
      urlPrefix: part.url.split(",")[0],
      dataLength: file.content.length,
    })
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    return local.agent.color(local.agent.current()?.name || "agent")
  })

  const variantProviderKey = createMemo(() => {
    const providerId = local.model.current(props.sessionID)?.providerId
    if (!providerId) return undefined
    return Account.parseProvider(providerId) ?? providerId
  })

  const visibleVariants = createMemo(() => {
    return buildVariantOptions(local.model.variant.list(props.sessionID), variantProviderKey())
  })

  const showVariant = createMemo(() => {
    return shouldShowVariantControl({
      providerKey: variantProviderKey(),
      current: local.model.variant.current(props.sessionID),
      options: visibleVariants(),
    })
  })

  const effectiveVariantValue = createMemo(() => {
    return getEffectiveVariantValue({
      providerKey: variantProviderKey(),
      current: local.model.variant.current(props.sessionID),
      options: visibleVariants(),
    })
  })

  const variantLabel = createMemo(() => {
    const value = effectiveVariantValue()
    if (!value) return ""
    const exact = visibleVariants().find((item) => item.value === value)
    if (exact) return exact.title
    return value
  })

  const openVariantPicker = () => {
    const variants = visibleVariants()
    if (variants.length === 0) return
    const current = local.model.variant.current(props.sessionID)
    dialog.replace(() => (
      <DialogSelect
        title="Thinking effort"
        current={current ?? ""}
        options={variants}
        hideInput
        onSelect={(option) => {
          local.model.variant.set(option.value, props.sessionID)
          dialog.clear()
        }}
      />
    ))
  }

  const handleVariantClick = () => {
    const variants = visibleVariants()
    if (variants.length === 0) return
    openVariantPicker()
  }

  const spinnerDef = createMemo(() => {
    const color = local.agent.color(local.agent.current()?.name || "agent")
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })

  const isRateLimited = createMemo(() => {
    const s = status()
    return s.type === "retry" && isRateLimitMessage(s.message)
  })

  const quotaHint = createMemo(() => {
    if (disableFooterMeta) return undefined
    const current = local.model.current(props.sessionID)
    if (!current) return undefined
    if (current.providerId === "openai" || Account.parseProvider(current.providerId) === "openai") {
      if (isRateLimited()) return "(5hrs:0% | week:0%)"
      const quota = codexQuota()
      return formatOpenAIQuotaDisplay(quota, "footer")
    }
    return undefined
  })

  const footerProviderLabel = createMemo(() => local.model.parsed().provider)

  const footerModelRest = createMemo(() => {
    const model = local.model.parsed().model
    if (disableFooterMeta) return model
    const account = activeAccountLabel() || "--"
    const quota = quotaHint()
    const base = `${model}  ${account}`
    return quota ? `${base}  ${quota}` : base
  })

  // Autonomous is always-on
  const autonomousEnabled = () => true

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => (autocomplete = r)}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box ref={(r) => (anchor = r)} visible={props.visible !== false}>
        <box
          border={["left"]}
          borderColor={highlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: "┃",
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
          >
            <textarea
              placeholder={props.sessionID ? undefined : `Ask anything... "${PLACEHOLDERS[store.placeholder]}"`}
              textColor={keybind.leader ? theme.textMuted : theme.text}
              focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                autocomplete.onInput(value)
                syncExtmarksWithPromptParts()
              }}
              keyBindings={textareaKeybindings()}
              onKeyDown={async (e) => {
                debugCheckpoint("tui.prompt", "onKeyDown:any", {
                  key: e.name,
                  ctrl: e.ctrl,
                  meta: e.meta,
                  shift: e.shift,
                })
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
                // Handle clipboard paste (Ctrl+V) - check for images first on Windows
                // This is needed because Windows terminal doesn't properly send image data
                // through bracketed paste, so we need to intercept the keypress and
                // directly read from clipboard before the terminal handles it
                if (keybind.match("input_paste", e)) {
                  debugCheckpoint("tui.prompt", "onKeyDown:input_paste", { key: e.name, ctrl: e.ctrl, meta: e.meta })
                  const content = await Clipboard.read()
                  debugCheckpoint("tui.prompt", "onKeyDown:input_paste:read", {
                    hasContent: !!content,
                    mime: content?.mime,
                    dataLength: content?.data?.length,
                  })
                  if (content?.mime.startsWith("image/")) {
                    e.preventDefault()
                    await pasteImage({
                      filename: "clipboard",
                      mime: content.mime,
                      content: content.data,
                    })
                    toast.show({ message: "Image pasted from clipboard", variant: "success" })
                    return
                  }
                  // If no image, let the default paste behavior continue
                }
                if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                  input.clear()
                  input.extmarks.clear()
                  setStore("prompt", {
                    input: "",
                    parts: [],
                  })
                  setStore("extmarkToPartIndex", new Map())
                  return
                }
                if (keybind.match("app_exit", e)) {
                  if (store.prompt.input === "") {
                    await exit()
                    // Don't preventDefault - let textarea potentially handle the event
                    e.preventDefault()
                    return
                  }
                }
                if (e.name === "!" && input.visualCursor.offset === 0) {
                  setStore("mode", "shell")
                  e.preventDefault()
                  return
                }
                if (store.mode === "shell") {
                  if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                    setStore("mode", "normal")
                    e.preventDefault()
                    return
                  }
                }
                if (store.mode === "normal") autocomplete.onKeyDown(e)
                if (!autocomplete.visible) {
                  if (
                    (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                    (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                  ) {
                    const direction = keybind.match("history_previous", e) ? -1 : 1
                    const item = history.move(direction, input.plainText)

                    if (item) {
                      input.setText(item.input)
                      setStore("prompt", item)
                      setStore("mode", item.mode ?? "normal")
                      restoreExtmarksFromParts(item.parts)
                      e.preventDefault()
                      if (direction === -1) input.cursorOffset = 0
                      if (direction === 1) input.cursorOffset = input.plainText.length
                    }
                    return
                  }

                  if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) input.cursorOffset = 0
                  if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                    input.cursorOffset = input.plainText.length
                }
              }}
              onSubmit={submit}
              onPaste={async (event: PasteEvent) => {
                const text = event.text ?? ""
                debugCheckpoint("tui.prompt", "onPaste", {
                  textLength: text.length,
                  // Help diagnose IDE/terminal behavior: some environments paste a temp filepath for images.
                  textSample: text.length <= 200 ? text : text.slice(0, 200),
                })
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = event.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()
                if (!pastedContent) {
                  command.trigger("prompt.paste")
                  return
                }

                // trim ' from the beginning and end of the pasted content. just
                // ' and nothing else
                const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
                const isUrl = /^(https?):\/\//.test(filepath)
                if (!isUrl) {
                  try {
                    const file = Bun.file(filepath)
                    // Handle SVG as raw text content, not as base64 image
                    if (file.type === "image/svg+xml") {
                      event.preventDefault()
                      const content = await file.text().catch(() => {})
                      if (content) {
                        pasteText(content, `[SVG: ${file.name ?? "image"}]`)
                        return
                      }
                    }
                    if (file.type.startsWith("image/")) {
                      event.preventDefault()
                      const content = await file
                        .arrayBuffer()
                        .then((buffer) => Buffer.from(buffer).toString("base64"))
                        .catch(() => {})
                      if (content) {
                        await pasteImage({
                          filename: file.name,
                          mime: file.type,
                          content,
                        })
                        return
                      }
                    }
                  } catch (error) {
                    debugCheckpoint("tui.prompt", "failed to process pasted image", {
                      error: error instanceof Error ? error.message : String(error),
                    })
                  }
                }

                const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
                if (
                  (lineCount >= 3 || pastedContent.length > 150) &&
                  !sync.data.config.experimental?.disable_paste_summary
                ) {
                  event.preventDefault()
                  pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
                  return
                }

                // Force layout update and render for the pasted content
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.getLayoutNode().markDirty()
                  renderer.requestRender()
                }, 0)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={theme.text}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1}>
              <Show when={store.mode === "shell"}>
                <text fg={highlight()}>Shell </text>
              </Show>
              <Show when={store.mode === "normal"}>
                <box flexDirection="row" gap={1}>
                  <box flexShrink={0}>
                    <text fg={autonomousEnabled() ? theme.success : keybind.leader ? theme.textMuted : theme.text}>
                      <Show when={autonomousEnabled()} fallback={footerProviderLabel()}>
                        <span style={{ bold: true }}>{footerProviderLabel()}</span>
                      </Show>
                    </text>
                  </box>
                  <text
                    flexShrink={0}
                    fg={keybind.leader ? theme.textMuted : theme.text}
                    overflow="hidden"
                    wrapMode="none"
                  >
                    {footerModelRest()}
                  </text>
                  <Show when={showVariant()}>
                    <text fg={theme.textMuted}>·</text>
                    <box onMouseUp={handleVariantClick}>
                      <text>
                        <span style={{ fg: theme.warning, bold: true }}>{variantLabel()}</span>
                      </text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={highlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <Show when={hasActivity()} fallback={<text />}>
            <box
              flexDirection="row"
              gap={1}
              flexGrow={1}
              justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
            >
              <box flexShrink={0} flexDirection="row" gap={1}>
                <box marginLeft={1}>
                  <Show when={status().type !== "idle"} fallback={
                    <text fg={theme.textMuted}>[{activeWorkers()} worker{activeWorkers() > 1 ? "s" : ""}]</text>
                  }>
                    <Show
                      when={!perfProbeMode && kv.get("animations_enabled", defaultAnimationsEnabled)}
                      fallback={<text fg={theme.textMuted}>[⋯]</text>}
                    >
                      <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                    </Show>
                  </Show>
                </box>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={retryStatus()}>
                    {(retry) => {
                      const handleMessageClick = () => {
                        const r = retry()
                        if (retryIsTruncated()) {
                          DialogAlert.show(dialog, "Retry Error", r.message)
                        }
                      }

                      const retryText = () => {
                        const r = retry()
                        const baseMessage = retryMessage() ?? ""
                        const truncatedHint = retryIsTruncated() ? " ..." : ""
                        const duration = formatDuration(retrySeconds())
                        const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                        return baseMessage + truncatedHint + retryInfo
                      }

                      return (
                        <box onMouseUp={handleMessageClick}>
                          <text fg={theme.error}>{retryText()}</text>
                        </box>
                      )
                    }}
                  </Show>
                </box>
              </box>
              <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                esc{" "}
                <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                  {store.interrupt >= 2 ? "again to stop all" : store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                </span>
              </text>
            </box>
          </Show>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexDirection="row">
              <Switch>
                <Match when={store.mode === "normal"}>
                  <box gap={1} flexDirection="row">
                    <text fg={theme.text}>
                      {keybind.print("command_list")} <span style={{ fg: theme.textMuted }}>commands</span>
                    </text>
                    <Show when={footerElapsed()}>{(elapsed) => <text fg={theme.textMuted}>· {elapsed()}</text>}</Show>
                  </box>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.text}>
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
              </Switch>
              <text fg={theme.text}>
                ctrl+j <span style={{ fg: theme.textMuted }}>newline</span>
              </text>
            </box>
          </Show>
        </box>
      </box>
    </>
  )
}
