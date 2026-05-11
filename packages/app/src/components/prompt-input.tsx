import { useFilteredList } from "@opencode-ai/ui/hooks"
import { showToast } from "@opencode-ai/ui/toast"
import {
  createEffect,
  on,
  Component,
  Show,
  For,
  onCleanup,
  Switch,
  Match,
  createMemo,
  createSignal,
  createResource,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createFocusSignal } from "@solid-primitives/active-element"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useProviders } from "@/hooks/use-providers"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectModel } from "@/components/dialog-select-model"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./prompt-input/editor-dom"
import { createPromptAttachments, ACCEPTED_FILE_TYPES } from "./prompt-input/attachments"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { isPromptQuotaProviderKey, shouldRefreshProviderQuota } from "./prompt-input/quota-refresh"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { buildAccountRows, providerKeyOf } from "./model-selector-state"
import { invalidateQuotaHint, loadQuotaHint, peekQuotaHint } from "@/utils/quota-hint-cache"
import { getSupportedProviderLabel } from "@/utils/provider-registry"
import { sendSessionReloadDebugBeacon } from "@/utils/debug-beacon"
import { createSpeechRecognition } from "@/utils/speech"
import { createAudioRecorder } from "@/utils/audio-recorder"
import { transcribeAudio } from "@/utils/transcribe"

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
  forceWorking?: boolean
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

const NON_EMPTY_TEXT = /[^\s\u200B]/

const rebuildPromptParts = (parts: Prompt): Prompt => {
  let position = 0
  return parts.map((part) => {
    if (part.type === "image") return part
    const next = {
      ...part,
      start: position,
      end: position + part.content.length,
    }
    position = next.end
    return next
  })
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const providers = useProviders()
  const sync = useSync()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const commentCount = createMemo(() => prompt.context.items().filter((item) => !!item.comment?.trim()).length)
  const layout = useLayout()
  const comments = useComments()
  const params = useParams()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  let editorRef!: HTMLDivElement
  let fileInputRef!: HTMLInputElement
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const rect = range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - padding) {
      container.scrollTop = bottom - container.clientHeight + padding
    }
  }

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const sessionKey = createMemo(() => `${params.dir}${params.id ? "/" + params.id : ""}`)
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!view().filePane.opened()) view().filePane.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      requestAnimationFrame(() => comments.setFocus(focus))
      return
    }

    if (!view().filePane.opened()) view().filePane.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    tabs().open(tab)
    files.load(item.path)
    requestAnimationFrame(() => comments.setFocus(focus))
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = tabs().active()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  // Autonomous is always-on
  const autonomousEnabled = () => true
  const status = createMemo(
    () =>
      sync.data.session_status[params.id ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => props.forceWorking || status()?.type !== "idle")
  const [quotaRefresh, setQuotaRefresh] = createSignal(0)
  const [lastQuotaRefreshMarker, setLastQuotaRefreshMarker] = createSignal("")
  const [lastQuotaRefreshAt, setLastQuotaRefreshAt] = createSignal(0)

  // Webapp watchdog for missed stream terminal events.
  // Symptom addressed: tool outputs with truncation note can occasionally leave UI spinner stuck
  // even after backend task has completed. We periodically reconcile session status from server.
  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    if (!working()) return

    let disposed = false
    const tick = async () => {
      try {
        const result = await sdk.client.session.status()
        if (disposed) return
        const next = result.data?.[sessionID] ?? { type: "idle" }
        const current = sync.data.session_status[sessionID]
        if (false /* disabled */)
          console.debug("[session-reload-debug] prompt-input:status-poll", {
            sessionID,
            currentType: current?.type ?? "idle",
            nextType: next.type,
          })
        sendSessionReloadDebugBeacon({
          sdk,
          event: "prompt-input:status-poll",
          sessionID,
          payload: {
            currentType: current?.type ?? "idle",
            nextType: next.type,
          },
        })
        if (current && JSON.stringify(current) === JSON.stringify(next)) return
        sync.set("session_status", sessionID, next)
      } catch {
        // best-effort watchdog; ignore polling failures
      }
    }

    void tick()
    const timer = setInterval(() => {
      void tick()
    }, 3000)

    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })

  const lastCompletedAssistant = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return undefined
    const messages = sync.data.message[sessionID] ?? []
    return messages.findLast((message) => message.role === "assistant" && message.time?.completed)
  })

  createEffect(() => {
    const model = currentModel()
    const providerKey = model ? (effectiveProviderKey() ?? model.provider.id) : undefined
    const last = lastCompletedAssistant()
    const completed =
      last && "completed" in last.time && typeof last.time.completed === "number" ? last.time.completed : undefined
    if (!last || completed === undefined) return
    const marker = `${last.id}:${completed}`
    if (marker === lastQuotaRefreshMarker()) return
    if (!shouldRefreshProviderQuota({ providerKey, lastRefreshAt: lastQuotaRefreshAt() })) return
    setLastQuotaRefreshMarker(marker)
    setLastQuotaRefreshAt(Date.now())
    // Invalidate the frontend cache and request a fresh upstream read so the
    // footer reflects the usage consumed by the turn that just ended. Without
    // this the main quota-load effect would still hit the 60 s peekQuotaHint
    // TTL and the ?fresh=1 path on the backend.
    if (model && providerKey && params.id) {
      // SSOT-first: if the session has a pinned accountId, use it so the quota
      // cache key matches what submit.ts actually sends. Otherwise PC and
      // mobile compute different cache keys for the same session and diverge.
      const accountId =
        sync.session.get(params.id)?.execution?.accountId ?? local.model.selection(params.id)?.accountID
      invalidateQuotaHint({
        baseURL: globalSDK.url,
        providerId: providerKey,
        accountId,
        modelID: model.id,
        format: "footer" as const,
      })
      pendingFreshQuotaLoad = true
    }
    setQuotaRefresh((value) => value + 1)
  })

  // Footer quota poller for long-running turns.
  // The completion hook above fires only when an assistant message of the
  // PARENT session lands — subagent (task tool) runs can keep the parent
  // "busy" for 10+ minutes without emitting a single parent-level assistant
  // completion, so the footer would sit stale for the whole duration. While
  // working() is true we actively poll every 10 s with invalidate + fresh=1
  // so the operator sees usage tick down in real time. Upstream wham/usage
  // is a metadata endpoint (no token cost) so the poll is cheap.
  const QUOTA_POLL_INTERVAL_MS = 10_000
  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    if (!working()) return
    const model = currentModel()
    if (!model) return
    const providerKey = effectiveProviderKey() ?? model.provider.id
    if (!isPromptQuotaProviderKey(providerKey)) return

    let disposed = false
    const tick = () => {
      if (disposed) return
      // SSOT-first — see note on the completion-hook effect above.
      const accountId = sync.session.get(sessionID)?.execution?.accountId ?? local.model.selection(sessionID)?.accountID
      invalidateQuotaHint({
        baseURL: globalSDK.url,
        providerId: providerKey,
        accountId,
        modelID: model.id,
        format: "footer" as const,
      })
      pendingFreshQuotaLoad = true
      // Keep the completion-hook throttle in sync so it does not double-fire
      // right after the poller already refreshed.
      setLastQuotaRefreshAt(Date.now())
      setQuotaRefresh((v) => v + 1)
    }
    // Fire once on entering the busy state, then on the fixed cadence.
    tick()
    const timer = setInterval(tick, QUOTA_POLL_INTERVAL_MS)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })

  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const currentModel = createMemo(() => local.model.current(params.id))
  const activeProviderKey = createMemo(() => {
    const providerID = currentModel()?.provider?.id
    if (!providerID) return
    return providerKeyOf(providerID) ?? providerID
  })
  const effectiveProviderKey = createMemo(() => {
    const model = currentModel()
    if (!model) return undefined

    const normalized = providerKeyOf(model.provider.id)
    if (normalized && !normalized.includes("@")) return normalized

    const identities = [model.provider.id, model.provider.name]
      .filter((value): value is string => typeof value === "string" && value.includes("@"))
      .map((value) => value.toLowerCase())

    if (identities.length === 0) return normalized ?? model.provider.id

    const accountProviders = globalSync.data.account_families as
      | Record<string, { accounts?: Record<string, unknown> }>
      | undefined
    if (!accountProviders) return normalized ?? model.provider.id

    const availableProviderKeys = new Set(
      providers
        .all()
        .filter((provider) => !!provider.models?.[model.id])
        .map((provider) => providerKeyOf(provider.id) || provider.id),
    )

    for (const [providerKey, providerRow] of Object.entries(accountProviders)) {
      const canonicalProviderKey = providerKeyOf(providerKey) || providerKey
      if (availableProviderKeys.size > 0 && !availableProviderKeys.has(canonicalProviderKey)) continue
      const accounts = providerRow?.accounts && typeof providerRow.accounts === "object" ? providerRow.accounts : {}
      for (const account of Object.values(accounts)) {
        const row = account as { name?: unknown; email?: unknown; accountId?: unknown }
        const values = [row.name, row.email, row.accountId]
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.toLowerCase())
        if (values.some((value) => identities.includes(value))) {
          return canonicalProviderKey
        }
      }
    }

    return normalized ?? model.provider.id
  })
  const activeAccountLabel = createMemo(() => {
    const providerKey = activeProviderKey()
    if (!providerKey) return "--"
    const rows = buildAccountRows({
      selectedProviderKey: providerKey,
      accountFamilies: globalSync.data.account_families,
      formatCooldown: (minutes) => language.t("settings.models.recommendations.cooldown", { minutes }),
    })
    // For existing sessions the account label MUST come from session.execution
    // (SSOT). Falling back to `rows.find(row => row.active)` (client-local
    // active account) produces the notorious cross-client divergence: mobile
    // and PC display different accounts for the same session, which in turn
    // misleads users into sending with the wrong identity and pushes the
    // session into a "no reply" death loop. If SSOT is missing we show "--"
    // so the inconsistency is visible rather than silently fabricated.
    if (params.id) {
      const ssotAccountId = sync.session.get(params.id)?.execution?.accountId
      if (!ssotAccountId) return "--"
      return rows.find((row) => row.id === ssotAccountId)?.label ?? "--"
    }
    const selected = local.model.selection(params.id)?.accountID
    return (
      rows.find((row) => row.id === selected)?.label ?? rows.find((row) => row.active)?.label ?? rows[0]?.label ?? "--"
    )
  })

  // Autonomous toggle removed — always-on
  const providerLabel = createMemo(() => {
    const model = currentModel()
    if (!model) return "--"
    const providerKey = effectiveProviderKey()
    const supportedLabel = getSupportedProviderLabel(providerKey)
    if (supportedLabel) return supportedLabel
    return model.provider.name ?? providerKey ?? model.provider.id
  })
  const [quotaHint, setQuotaHint] = createSignal<string | undefined>()
  let quotaHintRequestVersion = 0
  let prevQuotaAccountId: string | undefined
  // Consumed once by the main quota-load effect to force a fresh upstream read
  // after an assistant turn finishes (footer reflects the usage the turn just
  // consumed, instead of waiting up to 60 s for the frontend / backend caches).
  let pendingFreshQuotaLoad = false

  createEffect(() => {
    const model = currentModel()
    const refresh = quotaRefresh()
    void refresh
    if (!model) {
      setQuotaHint(undefined)
      return
    }

    const providerId = effectiveProviderKey() ?? model.provider.id
    const modelID = model.id
    // SSOT-first — align quota cache key with what submit.ts actually sends.
    const accountId =
      (params.id ? sync.session.get(params.id)?.execution?.accountId : undefined) ??
      local.model.selection(params.id)?.accountID

    // Detect account switch → invalidate cache & force fresh from backend
    const accountSwitched = accountId !== prevQuotaAccountId
    prevQuotaAccountId = accountId

    const cacheInput = { baseURL: globalSDK.url, providerId, accountId, modelID, format: "footer" as const }
    const requestVersion = ++quotaHintRequestVersion

    if (accountSwitched) {
      invalidateQuotaHint(cacheInput)
    }

    // Consume the one-shot "runloop just ended" signal. Captured synchronously
    // so a re-entry caused by the later setQuotaRefresh() inside this effect
    // cannot double-fire an upstream poll.
    const forceFresh = pendingFreshQuotaLoad
    pendingFreshQuotaLoad = false

    const cached = peekQuotaHint(cacheInput)
    // Only adopt the cached value when we have one. On account switch / poll
    // tick the cache was just invalidated; clobbering with `undefined` here
    // makes the footer text blink out until the async fetch resolves.
    if (cached.hint !== undefined) setQuotaHint(cached.hint)
    if (!cached.stale && !accountSwitched && !forceFresh) return

    void (async () => {
      const hint = await loadQuotaHint((input) => globalSDK.fetch(input), cacheInput, {
        fresh: accountSwitched || forceFresh,
      })
      if (requestVersion !== quotaHintRequestVersion) return
      setQuotaHint(hint)
    })()
  })
  const formatVariantLabel = (value: string, providerKey?: string) => {
    const normalized = value.toLowerCase()
    if (normalized === "xhigh" || normalized === "extra") return "Extra"
    if (providerKey === "openai" && normalized === "none") return "None"
    return value
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .split(" ")
      .filter(Boolean)
      .map((token) => token[0]?.toUpperCase() + token.slice(1))
      .join(" ")
  }
  type VariantOption = { value: string; label: string }
  const variantOptions = createMemo<VariantOption[]>(() => {
    const providerKey = activeProviderKey()
    let values = local.model.variant.list(params.id)
    if (providerKey === "openai") {
      const preferred = ["low", "medium", "high", "xhigh", "extra"]
      const set = new Set(values)
      const narrowed = preferred.filter((value) => set.has(value))
      if (narrowed.length > 0) values = narrowed
    }
    // Always strip "none"/"minimal" — we provide our own "None" sentinel entry
    values = values.filter((value) => value !== "none" && value !== "minimal")
    const used = new Set<string>()
    const result: VariantOption[] = [{ value: "", label: "None" }]
    for (const value of values) {
      const label = formatVariantLabel(value, providerKey)
      if (used.has(label)) continue
      used.add(label)
      result.push({ value, label })
    }
    return result
  })
  const currentVariantOption = createMemo<VariantOption | undefined>(() => {
    const value = local.model.variant.current(params.id)
    if (!value) return variantOptions().find((item) => item.value === "")
    const exact = variantOptions().find((item) => item.value === value)
    if (exact) return exact
    const providerKey = activeProviderKey()
    const targetLabel = formatVariantLabel(value, providerKey)
    return variantOptions().find((item) => item.label === targetLabel)
  })
  const promptMeta = createMemo(() => {
    const account = activeAccountLabel()
    const quota = quotaHint()
    const base = `${account}`
    return quota ? `${base} ${quota}` : base
  })

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: Prompt | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    placeholder: Math.floor(Math.random() * EXAMPLES.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })
  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: language.t(EXAMPLES[store.placeholder]),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const MAX_HISTORY = 100
  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: Prompt[]
    }>({
      entries: [],
    }),
  )

  const applyHistoryPrompt = (p: Prompt, position: "start" | "end") => {
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const isFocused = createFocusSignal(() => editorRef)
  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(editorRef, cursor)
  }

  createEffect(() => {
    params.id
    if (params.id) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  // ── Voice Input: dual-path (desktop speech recognition + mobile recording) ──

  // Capability-based route selection: desktop browsers with SpeechRecognition
  // use live transcription; mobile/unsupported browsers with MediaRecorder
  // use record-then-transcribe; neither = unsupported.
  const speech = createSpeechRecognition({
    onTranscript: applyVoiceTranscript,
  })
  const recorder = createAudioRecorder()

  type VoicePath = "speech" | "recording" | "unsupported"
  const voicePath = createMemo((): VoicePath => {
    if (speech.isSupported()) return "speech"
    if (recorder.isSupported()) return "recording"
    return "unsupported"
  })
  const voiceSupported = createMemo(() => voicePath() !== "unsupported")
  // Unified recording state — true when either path is actively capturing
  const voiceActive = createMemo(() => speech.isRecording() || recorder.state() === "recording")
  const [voiceTranscribing, setVoiceTranscribing] = createSignal(false)
  const voiceBusy = createMemo(() => voiceActive() || voiceTranscribing())

  // Speech: snapshot the prompt before recording starts so live transcript
  // can be appended without losing pre-existing content.
  let speechBasePrompt: ContentPart[] | null = null

  function applyVoiceTranscript(text: string) {
    if (!speechBasePrompt) return
    console.debug("[voice] applyTranscript", text)

    // Clone base parts each time so the snapshot is never mutated
    const inputParts = speechBasePrompt.filter((part) => part.type !== "image").map((p) => ({ ...p }))
    const imageParts = speechBasePrompt.filter((part): part is ImageAttachmentPart => part.type === "image")
    const baseParts = inputParts.length > 0 ? inputParts : [...DEFAULT_PROMPT]
    const last = baseParts.at(-1)
    const trimmed = text.trim()

    if (trimmed && last?.type === "text") {
      const needsSpace = /\S$/.test(last.content) && !/^[,.;!?]/.test(trimmed)
      last.content = `${last.content}${needsSpace ? " " : ""}${trimmed}`
    } else if (trimmed) {
      baseParts.push({
        type: "text",
        content: trimmed,
        start: 0,
        end: trimmed.length,
      })
    }

    const nextPrompt = rebuildPromptParts([...baseParts, ...imageParts])
    const nextCursor = promptLength(nextPrompt)
    prompt.set(nextPrompt, nextCursor)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, nextCursor)
      queueScroll()
    })
  }

  /** Append transcribed text to prompt (mobile recording path). */
  function appendTranscribedText(text: string) {
    speechBasePrompt = prompt.current().map((p) => (p.type === "image" ? p : { ...p }))
    applyVoiceTranscript(text)
    speechBasePrompt = null
  }

  const voiceTooltip = createMemo(() => {
    if (!voiceSupported()) return language.t("prompt.voice.unsupported")
    if (voiceTranscribing()) return language.t("prompt.voice.transcribing")
    if (voiceActive()) return language.t("prompt.action.voiceInputStop")
    return language.t("prompt.action.voiceInputStart")
  })
  const voiceButtonDisabled = createMemo(() => !voiceSupported() || working() || voiceTranscribing())

  const startVoice = () => {
    const path = voicePath()
    if (path === "unsupported") return
    if (path === "speech") {
      speechBasePrompt = prompt.current().map((p) => (p.type === "image" ? p : { ...p }))
      speech.start()
    } else {
      recorder.start()
    }
  }

  const stopVoice = async () => {
    const path = voicePath()
    if (path === "speech") {
      speechBasePrompt = null
      speech.stop()
      return
    }
    if (path === "recording" && recorder.state() === "recording") {
      setVoiceTranscribing(true)
      try {
        const result = await recorder.stop()
        const sessionID = params.id
        if (!sessionID) {
          console.warn("[voice] no session ID for transcription")
          return
        }
        console.debug("[voice] uploading audio for transcription", {
          mime: result.mime,
          size: result.blob.size,
          durationMs: result.durationMs,
        })
        const { text } = await transcribeAudio(globalSDK.url, globalSDK.fetch, {
          sessionID,
          audio: result.blob,
          mime: result.mime,
        })
        if (text) {
          appendTranscribedText(text)
        } else {
          console.warn("[voice] transcription returned empty text")
        }
      } catch (err) {
        console.error("[voice] transcription failed:", err)
        const msg = err instanceof Error ? err.message : "Transcription failed"
        showToast({
          title: language.t("prompt.voice.transcriptionFailed"),
          description: msg,
          variant: "error",
        })
      } finally {
        setVoiceTranscribing(false)
      }
    }
  }

  // Auto-stop voice on mode change or when working
  createEffect(() => {
    if (store.mode !== "normal" && voiceActive()) {
      speechBasePrompt = null
      speech.stop()
      recorder.cancel()
    }
  })

  createEffect(() => {
    if (working() && voiceActive()) {
      speechBasePrompt = null
      speech.stop()
      recorder.cancel()
    }
  })

  createEffect(() => {
    if (!isFocused()) closePopover()
  })

  // Safety: reset composing state on focus change to prevent stuck state
  // This handles edge cases where compositionend event may not fire
  createEffect(() => {
    if (!isFocused()) setComposing(false)
  })

  const agentList = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )
  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const excludedCustomSlash = new Set(["update_model", "update_models"])

    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom: SlashCommand[] = sync.data.command
      .filter((cmd) => !excludedCustomSlash.has(cmd.name))
      .map((cmd): SlashCommand => {
        const source: SlashCommand["source"] =
          cmd.source === "command" || cmd.source === "mcp" || cmd.source === "skill" ? cmd.source : undefined
        return {
          id: `custom.${cmd.name}`,
          trigger: cmd.name,
          title: cmd.name,
          description: cmd.description,
          type: "custom",
          source,
        }
      })

    const seenTrigger = new Set<string>()
    const out: SlashCommand[] = []
    for (const cmd of [...builtin, ...custom]) {
      if (seenTrigger.has(cmd.trigger)) continue
      seenTrigger.add(cmd.trigger)
      out.push(cmd)
    }

    return out
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      focusEditorEnd()
      return
    }

    clearEditor()
    prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
    refetch: slashRefetch,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
  }

  createEffect(
    on(
      () => sync.data.command,
      () => slashRefetch(),
      { defer: true },
    ),
  )

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  createEffect(
    on(
      () => prompt.current(),
      (currentParts) => {
        const inputParts = currentParts.filter((part) => part.type !== "image")

        if (mirror.input) {
          mirror.input = false
          if (isNormalizedEditor()) return

          renderEditorWithCursor(inputParts)
          return
        }

        const domParts = parseFromDOM()
        if (isNormalizedEditor() && isPromptEqual(inputParts, domParts)) return

        renderEditorWithCursor(inputParts)
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      const content = buffer.replace(/\r\n?/g, "\n").replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = !NON_EMPTY_TEXT.test(rawText) && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const next = prependHistoryEntry(currentHistory.entries, prompt)
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory.entries : history.entries,
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.prompt, result.cursor)
    return true
  }

  const { addImageAttachment, removeImageAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isFocused,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
  })

  const { abort, handleSubmit } = createPromptSubmit({
    info,
    imageAttachments,
    commentCount,
    autoAccept: () => {
      const id = params.id
      if (!id) return permission.isAutoAcceptingDirectory(sdk.directory)
      return permission.isAutoAccepting(id, sdk.directory)
    },
    mode: () => store.mode,
    working,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => {
      resetHistoryNavigation(true)
    },
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    onSubmit: props.onSubmit,
    autonomous: autonomousEnabled,
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }
    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      handleSubmit(event)
    }
  }

  return (
    <div class="relative size-full _max-h-[320px] flex flex-col gap-3">
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <form
        onSubmit={handleSubmit}
        classList={{
          "group/prompt-input": true,
          "bg-surface-raised-stronger-non-alpha shadow-xs-border relative": true,
          "rounded-[14px] overflow-clip focus-within:shadow-xs-border": true,
          "border-icon-info-active border-dashed": store.draggingType !== null,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <PromptDragOverlay
          type={store.draggingType}
          label={language.t(store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
        />
        <PromptContextItems
          items={prompt.context.items()}
          active={(item) => {
            const active = comments.active()
            return !!item.commentID && item.commentID === active?.id && item.path === active?.file
          }}
          openComment={openComment}
          remove={(item) => {
            if (item.commentID) comments.remove(item.path, item.commentID)
            prompt.context.remove(item.key)
          }}
          t={(key) => language.t(key as Parameters<typeof language.t>[0])}
        />
        <PromptImageAttachments
          attachments={imageAttachments()}
          onOpen={(attachment) =>
            dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
          }
          onRemove={removeImageAttachment}
          removeLabel={language.t("prompt.attachment.remove")}
        />
        <div class="relative max-h-[240px] overflow-y-auto" ref={(el) => (scrollRef = el)}>
          <div
            data-component="prompt-input"
            ref={(el) => {
              editorRef = el
              props.ref?.(el)
            }}
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder()}
            contenteditable="true"
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
            onInput={handleInput}
            onPaste={handlePaste}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={handleKeyDown}
            classList={{
              "select-text": true,
              "w-full p-3 pr-12 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
              "[&_[data-type=file]]:text-syntax-property": true,
              "[&_[data-type=agent]]:text-syntax-type": true,
              "font-mono!": store.mode === "shell",
            }}
          />
          <Show when={!prompt.dirty()}>
            <div class="absolute top-0 inset-x-0 p-3 pr-12 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate">
              {placeholder()}
            </div>
          </Show>
          <Show when={store.mode === "normal" && voiceSupported()}>
            <button
              type="button"
              class="absolute top-2.5 right-2.5 p-0.5 rounded hover:bg-fill-quaternary transition-colors"
              disabled={voiceButtonDisabled()}
              onClick={() => {
                if (voiceActive()) {
                  stopVoice()
                  return
                }
                startVoice()
              }}
              aria-label={voiceTooltip()}
              title={voiceTooltip()}
            >
              <Show
                when={!voiceActive() && !voiceTranscribing()}
                fallback={
                  <Show
                    when={!voiceTranscribing()}
                    fallback={
                      <svg class="size-4.5 animate-spin" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        <circle cx="10" cy="10" r="7" stroke="#94a3b8" stroke-width="2" stroke-dasharray="30 14" />
                      </svg>
                    }
                  >
                    <svg class="size-4.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <circle cx="10" cy="10" r="7" fill="#ef4444" />
                      <circle cx="10" cy="10" r="3" fill="#fff" />
                    </svg>
                  </Show>
                }
              >
                <Icon name="microphone" class="size-4.5 text-text-weak" />
              </Show>
            </button>
          </Show>
        </div>
        <div class="relative p-3 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <Switch>
              <Match when={store.mode === "shell"}>
                <div class="flex items-center gap-2 px-2 h-6">
                  <Icon name="console" size="small" class="text-icon-primary" />
                  <span class="text-12-regular text-text-primary">{language.t("prompt.mode.shell")}</span>
                  <span class="text-12-regular text-text-weak">{language.t("prompt.mode.shell.exit")}</span>
                </div>
              </Match>
              <Match when={store.mode === "normal"}>
                <Tooltip placement="top" gutter={8} value="自動代理（常駐開啟）">
                  <Button
                    type="button"
                    variant="ghost"
                    class="h-6 px-2 min-w-0"
                    style={{
                      color: "var(--icon-success-base)",
                      "font-weight": "600",
                      "background-color": "var(--surface-success-base)",
                    }}
                    disabled={!params.id}
                    aria-label="自動代理（常駐開啟）"
                  >
                    <span class="text-12-regular px-1">{providerLabel()}</span>
                  </Button>
                </Tooltip>
                <TooltipKeybind
                  placement="top"
                  gutter={8}
                  title={language.t("command.model.choose")}
                  keybind={command.keybind("model.choose")}
                >
                  <Button
                    variant="ghost"
                    class="min-w-0 max-w-[240px]"
                    onClick={() => dialog.show(() => <DialogSelectModel />)}
                  >
                    <Show when={local.model.current(params.id)?.provider?.id}>
                      <ProviderIcon
                        id={local.model.current(params.id)!.provider.id as IconName}
                        class="size-4 shrink-0"
                      />
                    </Show>
                    <span class="truncate">
                      {local.model.current(params.id)?.name ?? language.t("dialog.model.select.title")}
                    </span>
                    <Icon name="chevron-down" size="small" class="shrink-0" />
                  </Button>
                </TooltipKeybind>
                <Show when={variantOptions().length > 0}>
                  <Tooltip
                    placement="top"
                    gutter={8}
                    value={language.t("command.model.variant.cycle") + " (provider-native)"}
                  >
                    <Select
                      options={variantOptions()}
                      current={currentVariantOption()}
                      value={(item) => item.value}
                      label={(item) => item.label}
                      onSelect={(value) => local.model.variant.set(value?.value || undefined, params.id)}
                      class="max-w-[150px]"
                      valueClass="truncate"
                      variant="ghost"
                    />
                  </Tooltip>
                </Show>
              </Match>
            </Switch>
            <Show when={store.mode === "normal" && promptMeta()}>
              <span class="text-12-regular text-text-weak tabular-nums whitespace-nowrap overflow-hidden text-ellipsis min-w-0">
                {promptMeta()}
              </span>
            </Show>
            <Show when={store.mode === "normal" && voiceBusy()}>
              <span class="text-12-regular text-text-weak whitespace-nowrap overflow-hidden text-ellipsis min-w-0 flex items-center gap-1">
                <Icon
                  name="speech-bubble"
                  size="small"
                  class={voiceTranscribing() ? "text-text-weak animate-pulse" : "text-icon-danger-base"}
                />
                <span class="truncate">
                  {voiceTranscribing()
                    ? language.t("prompt.voice.transcribing")
                    : voicePath() === "recording"
                      ? language.t("prompt.voice.recordingMobile")
                      : language.t("prompt.voice.recording")}
                </span>
              </span>
            </Show>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES.join(",")}
              class="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                if (file) addImageAttachment(file)
                e.currentTarget.value = ""
              }}
            />
            <div class="flex items-center gap-1 mr-1">
              <Show when={store.mode === "normal"}>
                <Tooltip placement="top" value={language.t("prompt.action.attachFile")}>
                  <Button
                    type="button"
                    variant="ghost"
                    class="size-6 px-1"
                    onClick={() => fileInputRef.click()}
                    aria-label={language.t("prompt.action.attachFile")}
                  >
                    <Icon name="photo" class="size-4.5" />
                  </Button>
                </Tooltip>
              </Show>
            </div>
            <IconButton
              type="submit"
              disabled={!prompt.dirty() && !working() && commentCount() === 0}
              icon={working() ? "stop" : "arrow-up"}
              variant="primary"
              class="h-6 w-4.5"
              aria-label={working() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
            />
          </div>
        </div>
      </form>
    </div>
  )
}
