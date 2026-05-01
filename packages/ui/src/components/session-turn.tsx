import {
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  type PermissionRequest,
  type QuestionRequest,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2/client"
import { useData } from "../context"
import { type UiI18nKey, type UiI18nParams, useI18n } from "../context/i18n"

import { Binary } from "@opencode-ai/util/binary"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, ParentProps, Show, Switch } from "solid-js"
import { AssistantParts, Message, Part } from "./message-part"
import { Markdown } from "./markdown"
import { IconButton } from "./icon-button"
import { Card } from "./card"
import { Spinner } from "./spinner"
import { SessionRetry } from "./session-retry"
import { Tooltip } from "./tooltip"
import { createStore } from "solid-js/store"
import { DateTime, DurationUnit, Interval } from "luxon"
import { isScrollDebugEnabled, pushScrollDebug } from "../hooks/scroll-debug"
import { createResizeObserver } from "@solid-primitives/resize-observer"

type Translator = (key: UiI18nKey, params?: UiI18nParams) => string

const inlineImageExtensions = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"])

function inlineImagePathFromHref(href: string | null) {
  if (!href) return
  let candidate = href.trim()
  if (!candidate) return
  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname)
    } catch {
      return
    }
  }
  if (!candidate.startsWith("/")) return
  const pathOnly = candidate.split(/[?#]/, 1)[0]
  const lower = pathOnly.toLowerCase()
  for (const ext of inlineImageExtensions) {
    if (lower.endsWith(ext)) return pathOnly
  }
}

type InlineImagePreview = {
  url?: string
  error?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function unwrap(message: string) {
  const text = message.replace(/^Error:\s*/, "").trim()

  const parse = (value: string) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }

  const read = (value: string) => {
    const first = parse(value)
    if (typeof first !== "string") return first
    return parse(first.trim())
  }

  let json = read(text)

  if (json === undefined) {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start !== -1 && end > start) {
      json = read(text.slice(start, end + 1))
    }
  }

  if (!record(json)) return message

  const err = record(json.error) ? json.error : undefined
  if (err) {
    const type = typeof err.type === "string" ? err.type : undefined
    const msg = typeof err.message === "string" ? err.message : undefined
    if (type && msg) return `${type}: ${msg}`
    if (msg) return msg
    if (type) return type
    const code = typeof err.code === "string" ? err.code : undefined
    if (code) return code
  }

  const msg = typeof json.message === "string" ? json.message : undefined
  if (msg) return msg

  const reason = typeof json.error === "string" ? json.error : undefined
  if (reason) return reason

  return message
}

function computeStatusFromPart(part: PartType | undefined, t: Translator): string | undefined {
  if (!part) return undefined

  if (part.type === "tool") {
    switch (part.tool) {
      case "task":
        return t("ui.sessionTurn.status.delegating")
      case "todowrite":
      case "todoread":
        return t("ui.sessionTurn.status.planning")
      case "read":
        return t("ui.sessionTurn.status.gatheringContext")
      case "list":
      case "grep":
      case "glob":
        return t("ui.sessionTurn.status.searchingCodebase")
      case "webfetch":
        return t("ui.sessionTurn.status.searchingWeb")
      case "apply_patch": {
        if (part.state && "metadata" in part.state && part.state.metadata) {
          const meta = part.state.metadata as Record<string, unknown>
          const phase = meta.phase as string | undefined
          if (phase === "parsing") return t("ui.sessionTurn.status.applyPatch.parsing")
          if (phase === "planning") return t("ui.sessionTurn.status.applyPatch.planning")
          if (phase === "awaiting_approval") return t("ui.sessionTurn.status.applyPatch.awaitingApproval")
          if (phase === "applying") {
            const currentFile = meta.currentFile as string | undefined
            const total = meta.totalCount as number | undefined
            if (currentFile && total) {
              const baseName = currentFile.split("/").pop() ?? currentFile
              return t("ui.sessionTurn.status.applyPatch.applyingProgress", {
                file: baseName,
                completed: String(meta.completedCount ?? 0),
                total: String(total),
              })
            }
            return t("ui.sessionTurn.status.applyPatch.applying")
          }
          if (phase === "diagnostics") return t("ui.sessionTurn.status.applyPatch.diagnostics")
        }
        return t("ui.sessionTurn.status.applyPatch")
      }
      case "edit":
      case "write":
        return t("ui.sessionTurn.status.makingEdits")
      case "bash":
        return t("ui.sessionTurn.status.runningCommands")
      default:
        return undefined
    }
  }
  if (part.type === "reasoning") {
    const text = part.text ?? ""
    const match = text.trimStart().match(/^\*\*(.+?)\*\*/)
    if (match) return t("ui.sessionTurn.status.thinkingWithTopic", { topic: match[1].trim() })
    return t("ui.sessionTurn.status.thinking")
  }
  if (part.type === "text") {
    return t("ui.sessionTurn.status.gatheringThoughts")
  }
  return undefined
}

function same<T>(a: readonly T[], b: readonly T[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

function isAttachment(part: PartType | undefined) {
  if (part?.type !== "file") return false
  const mime = (part as FilePart).mime ?? ""
  return mime.startsWith("image/") || mime === "application/pdf"
}

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function isSessionDebugEnabled() {
  return false // typeof window !== "undefined" && window.localStorage.getItem("opencode:session-debug") === "1"
}

function sendSessionTurnDebugBeacon(payload: Record<string, unknown>) {
  if (!isSessionDebugEnabled()) return
  if (typeof window === "undefined") return
  const headers = new Headers({
    "content-type": "application/json",
  })
  const csrf = window.__opencodeCsrfToken
  if (csrf) headers.set("x-opencode-csrf", csrf)
  void fetch("/api/v2/experimental/debug-beacon", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({
      source: "ui.session-turn",
      event: "session-turn:render-state",
      sessionID: typeof payload.sessionID === "string" ? payload.sessionID : undefined,
      messageID: typeof payload.messageID === "string" ? payload.messageID : undefined,
      payload,
    }),
    keepalive: true,
  }).catch(() => {})
}

export function SessionTurn(
  props: ParentProps<{
    sessionID: string
    sessionTitle?: string
    messageID: string
    lastUserMessageID?: string
    shellToolDefaultOpen?: boolean
    editToolDefaultOpen?: boolean
    showReasoningSummaries?: boolean
    stepsExpanded?: boolean
    onStepsExpandedToggle?: () => void
    onUserInteracted?: () => void
    inlineImage?: {
      load: (path: string) => void | Promise<void>
      preview: (path: string) => InlineImagePreview | undefined
    }
    classes?: {
      root?: string
      content?: string
      container?: string
    }
    statusOverride?: { label: string; startedAt: number }
  }>,
) {
  const i18n = useI18n()
  const data = useData()

  const emptyMessages: MessageType[] = []
  const emptyParts: PartType[] = []
  const emptyFiles: FilePart[] = []
  const emptyAssistant: AssistantMessage[] = []
  const emptyPermissions: PermissionRequest[] = []
  const emptyQuestions: QuestionRequest[] = []
  const emptyQuestionParts: { part: ToolPart; message: AssistantMessage }[] = []
  const idle = { type: "idle" as const }

  const allMessages = createMemo(() => list(data.store.message?.[props.sessionID], emptyMessages))

  const messageIndex = createMemo(() => {
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, props.messageID, (m) => m.id)

    const index = result.found ? result.index : messages.findIndex((m) => m.id === props.messageID)
    if (index < 0) return -1

    const msg = messages[index]
    if (!msg || msg.role !== "user") return -1

    return index
  })

  const message = createMemo(() => {
    const index = messageIndex()
    if (index < 0) return undefined

    const messages = allMessages() ?? emptyMessages
    const msg = messages[index]
    if (!msg || msg.role !== "user") return undefined

    return msg
  })

  const lastUserMessageID = createMemo(() => {
    if (props.lastUserMessageID) return props.lastUserMessageID

    const messages = allMessages() ?? emptyMessages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === "user") return msg.id
    }
    return undefined
  })

  const isLastUserMessage = createMemo(() => props.messageID === lastUserMessageID())

  const parts = createMemo(() => {
    const msg = message()
    if (!msg) return emptyParts
    return list(data.store.part?.[msg.id], emptyParts)
  })

  const attachmentParts = createMemo(() => {
    const msgParts = parts()
    if (msgParts.length === 0) return emptyFiles
    return msgParts.filter((part) => isAttachment(part)) as FilePart[]
  })

  const stickyParts = createMemo(() => {
    const msgParts = parts()
    if (msgParts.length === 0) return emptyParts
    if (attachmentParts().length === 0) return msgParts
    return msgParts.filter((part) => !isAttachment(part))
  })

  const assistantMessages = createMemo(
    () => {
      const msg = message()
      if (!msg) return emptyAssistant

      const messages = allMessages() ?? emptyMessages
      const index = messageIndex()
      if (index < 0) return emptyAssistant

      // Two-direction scan, anchored on physical time rather than array
      // position.
      //
      // Background: the array is ULID-sorted by message id, but the daemon
      // pre-allocates the assistant placeholder id BEFORE committing the
      // user message id (so first-token streaming can start immediately).
      // When both ids land in the same millisecond the random ULID tail
      // decides ordering — yielding asst.id < user.id even though
      // asst.time.created > user.time.created. Empirically these inverted
      // assistants always sit in the slots immediately before their parent
      // user, but a single multi-step autonomous turn could in principle
      // produce more than one inverted entry, so we keep collecting until
      // we cross into real history.
      //
      // Look-back rule:
      //   keep going while time.created >= user.time.created
      //   collect items with role=assistant && parentID=user.id
      //   stop when we see a message strictly older than user (real past)
      //
      // Forward scan rule (unchanged from the original logic):
      //   walk index+1 forward, break on the next user, collect assistants
      //   with matching parentID.
      //
      // Cost: O(K_back + K_fwd) where K_back = inverted count (≈0 normal,
      // 1 in observed inversion case) and K_fwd = autonomous step count.
      // Almost always under 10 ops per turn.
      const result: AssistantMessage[] = []
      const myTime = msg.time?.created ?? 0

      // Backward scan: collect inverted (id-before-user but time-after-user) assistants
      for (let i = index - 1; i >= 0; i--) {
        const item = messages[i]
        if (!item) continue
        const itemTime = (item as { time?: { created?: number } }).time?.created ?? 0
        // Crossed into real history (item created strictly before user) → stop.
        if (itemTime < myTime) break
        if (item.role === "assistant" && item.parentID === msg.id && (item as AssistantMessage).summary !== true) {
          // unshift keeps chronological order: oldest inverted-step first
          result.unshift(item as AssistantMessage)
        }
      }

      // Forward scan: standard sequence (and autonomous multi-step).
      //
      // Synthetic-user transparency: auto-compaction injects a real user
      // message whose only text part is `synthetic: true` (the "Continue if
      // you have next steps" nudge). visibleUserMessages already filters
      // these out so they don't render as empty bubbles, but post-compaction
      // assistants set parentID = continueMsg.id, not the original user. If
      // we break on the synthetic user, every post-compaction assistant
      // becomes an orphan turn with no visible parent → tool bubbles vanish,
      // only the streaming timer stays. Treat synthetic users as transparent
      // and absorb their id into the accepted parent set.
      const acceptedParents = new Set<string>([msg.id])
      for (let i = index + 1; i < messages.length; i++) {
        const item = messages[i]
        if (!item) continue
        if (item.role === "user") {
          const userParts = list(data.store.part?.[item.id], emptyParts)
          let hasText = false
          let hasNonSynthetic = false
          for (const p of userParts) {
            if (p.type !== "text") continue
            hasText = true
            if (!(p as { synthetic?: boolean }).synthetic) {
              hasNonSynthetic = true
              break
            }
          }
          if (hasText && !hasNonSynthetic) {
            acceptedParents.add(item.id)
            continue
          }
          break
        }
        if (item.role === "assistant" && acceptedParents.has(item.parentID ?? "")) {
          // Hide auto-compaction assistant messages from the UI.
          // They remain in storage so the AI sees the summary on next turn;
          // a toast surfaces progress so the user isn't startled by the freeze.
          if ((item as AssistantMessage).summary === true) continue
          result.push(item as AssistantMessage)
        }
      }

      return result
    },
    emptyAssistant,
    { equals: same },
  )

  const lastAssistantMessage = createMemo(() => assistantMessages().at(-1))

  const pending = createMemo(() => {
    return assistantMessages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  })

  const pendingUser = createMemo(() => {
    const item = pending()
    if (!item?.parentID) return
    const messages = allMessages() ?? emptyMessages
    const result = Binary.search(messages, item.parentID, (m) => m.id)
    const msg = result.found ? messages[result.index] : messages.find((m) => m.id === item.parentID)
    if (!msg || msg.role !== "user") return
    return msg
  })

  const error = createMemo(() => assistantMessages().find((m) => m.error)?.error)
  const errorText = createMemo(() => {
    const msg = error()?.data?.message
    if (typeof msg === "string") return unwrap(msg)
    if (msg === undefined || msg === null) return ""
    return unwrap(String(msg))
  })

  const lastTextPart = createMemo(() => {
    const msgs = assistantMessages()
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = list(data.store.part?.[msgs[mi].id], emptyParts)
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi]
        if (part?.type === "text") return part as TextPart
      }
    }
    return undefined
  })

  const hasSteps = createMemo(() => {
    for (const m of assistantMessages()) {
      const msgParts = list(data.store.part?.[m.id], emptyParts)
      for (const p of msgParts) {
        if (p?.type === "tool") return true
      }
    }
    return false
  })

  const permissions = createMemo(() => list(data.store.permission?.[props.sessionID], emptyPermissions))
  const nextPermission = createMemo(() => permissions()[0])

  const questions = createMemo(() => list(data.store.question?.[props.sessionID], emptyQuestions))
  const nextQuestion = createMemo(() => questions()[0])

  const hidden = createMemo(() => {
    const out: { messageID: string; callID: string }[] = []
    const perm = nextPermission()
    if (perm?.tool) out.push(perm.tool)
    const question = nextQuestion()
    if (question?.tool) out.push(question.tool)
    return out
  })

  const answeredQuestionParts = createMemo(() => {
    if (true) return emptyQuestionParts
    if (questions().length > 0) return emptyQuestionParts

    const result: { part: ToolPart; message: AssistantMessage }[] = []

    for (const msg of assistantMessages()) {
      const parts = list(data.store.part?.[msg.id], emptyParts)
      for (const part of parts) {
        if (part?.type !== "tool") continue
        const tool = part as ToolPart
        if (tool.tool !== "question") continue
        // @ts-expect-error metadata may not exist on all tool states
        const answers = tool.state?.metadata?.answers
        if (answers && answers.length > 0) {
          result.push({ part: tool, message: msg })
        }
      }
    }

    return result
  })

  const shellModePart = createMemo(() => {
    const p = parts()
    if (p.length === 0) return
    if (!p.every((part) => part?.type === "text" && part?.synthetic)) return

    const msgs = assistantMessages()
    if (msgs.length !== 1) return

    const msgParts = list(data.store.part?.[msgs[0].id], emptyParts)
    if (msgParts.length !== 1) return

    const assistantPart = msgParts[0]
    if (assistantPart?.type === "tool" && assistantPart.tool === "bash") return assistantPart
  })

  const isShellMode = createMemo(() => !!shellModePart())

  const rawStatus = createMemo(() => {
    const msgs = assistantMessages()
    let last: PartType | undefined
    let currentTask: ToolPart | undefined

    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      const msgParts = list(data.store.part?.[msgs[mi].id], emptyParts)
      for (let pi = msgParts.length - 1; pi >= 0; pi--) {
        const part = msgParts[pi]
        if (!part) continue
        if (!last) last = part

        if (
          part.type === "tool" &&
          part.tool === "task" &&
          part.state &&
          "metadata" in part.state &&
          part.state.metadata?.sessionId &&
          part.state.status === "running"
        ) {
          currentTask = part as ToolPart
          break
        }
      }
      if (currentTask) break
    }

    const taskSessionId =
      currentTask?.state && "metadata" in currentTask.state
        ? (currentTask.state.metadata?.sessionId as string | undefined)
        : undefined

    if (taskSessionId) {
      const taskMessages = list(data.store.message?.[taskSessionId], emptyMessages)
      for (let mi = taskMessages.length - 1; mi >= 0; mi--) {
        const msg = taskMessages[mi]
        if (!msg || msg.role !== "assistant") continue

        const msgParts = list(data.store.part?.[msg.id], emptyParts)
        for (let pi = msgParts.length - 1; pi >= 0; pi--) {
          const part = msgParts[pi]
          if (part) return computeStatusFromPart(part, i18n.t)
        }
      }
    }

    return computeStatusFromPart(last, i18n.t)
  })

  const status = createMemo(() => data.store.session_status[props.sessionID] ?? idle)
  const statusOverride = createMemo(() => (isLastUserMessage() ? props.statusOverride : undefined))
  const working = createMemo(() => status().type !== "idle" && isLastUserMessage())
  const active = createMemo(() => {
    const msg = message()
    if (!msg) return false
    const parent = pendingUser()
    if (parent && parent.id === msg.id) return true
    // Post-Phase-9 fire-and-forget subagent: parent's assistant message is
    // already finalized (no `pending` to anchor on) but a subagent is still
    // running on this turn's behalf. Treat the last-user turn as active so
    // the clock + status text keep showing while the child works.
    if (isLastUserMessage() && data.store.active_child?.[props.sessionID]) return true
    // Between-rounds gap: previous step finalized, next LLM stream is in
    // flight but no step-start part has arrived yet. session_status=busy is
    // the daemon's ground truth — without this the status line vanishes
    // (Liveness Invariant violation: user loses every signal that work is
    // happening, even though the runloop is mid-API-call).
    if (isLastUserMessage() && status().type !== "idle") return true
    return false
  })
  const queued = createMemo(() => {
    const id = message()?.id
    if (!id) return false
    if (!pendingUser()) return false
    const item = pending()
    if (!item) return false
    // If the in-progress assistant is replying to THIS user (parentID match),
    // we are the active turn, not queued — regardless of ULID ordering. Without
    // this guard, the same-millisecond race that lets assistant.id < user.id
    // (already worked around in the assistantMessages backward-scan) would
    // incorrectly mark the actively-replied user as "queued".
    if (item.parentID === id) return false
    return id > item.id
  })
  const retry = createMemo(() => {
    // session_status is session-scoped; only show retry on the active (last) turn
    if (!isLastUserMessage()) return
    const s = status()
    if (s.type !== "retry") return
    return s
  })
  const statusLineMounted = createMemo(() => !!retry() || !!statusOverride() || working())
  const statusLineVisible = createMemo(() => !!retry() || !!statusOverride() || (working() && active()))

  const response = createMemo(() => lastTextPart()?.text)
  const responsePartId = createMemo(() => lastTextPart()?.id)
  const hasDiffs = createMemo(() => (message()?.summary?.diffs?.length ?? 0) > 0)
  const hideResponsePart = createMemo(() => !working() && !!responsePartId())
  const stickyDisabled = createMemo(() => true)

  let renderStateLog = ""
  createEffect(() => {
    const payload = {
      sessionID: props.sessionID,
      messageID: props.messageID,
      hasMessage: !!message(),
      partCount: parts().length,
      partTypes: parts().map((part) => part.type),
      assistantCount: assistantMessages().length,
      assistantPartCounts: assistantMessages().map((msg) => ({
        id: msg.id,
        count: list(data.store.part?.[msg.id], emptyParts).length,
      })),
      isLastUserMessage: isLastUserMessage(),
      working: working(),
      active: active(),
      queued: queued(),
      responseLength: response()?.length ?? 0,
      statusType: status().type,
    }
    const key = JSON.stringify(payload)
    if (key === renderStateLog) return
    renderStateLog = key
    if (isSessionDebugEnabled()) {
      console.debug("[session-reload-debug] session-turn:render-state", payload)
      sendSessionTurnDebugBeacon(payload)
    }
  })

  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = response() ?? ""
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const [rootRef, setRootRef] = createSignal<HTMLDivElement | undefined>()
  const [stickyRef, setStickyRef] = createSignal<HTMLDivElement | undefined>()
  const [stepsRef, setStepsRef] = createSignal<HTMLDivElement | undefined>()
  const [summaryRef, setSummaryRef] = createSignal<HTMLDivElement | undefined>()
  const [expandedInlineImages, setExpandedInlineImages] = createSignal<string[]>([])

  createEffect(() => {
    const container = summaryRef()
    const inlineImage = props.inlineImage
    if (!container || !inlineImage) return

    const handleClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a")
      if (!(anchor instanceof HTMLAnchorElement)) return
      const imagePath = inlineImagePathFromHref(anchor.getAttribute("href"))
      if (!imagePath) return

      event.preventDefault()
      setExpandedInlineImages((current) => (current.includes(imagePath) ? current : [...current, imagePath]))
      void inlineImage.load(imagePath)
    }

    container.addEventListener("click", handleClick)
    onCleanup(() => container.removeEventListener("click", handleClick))
  })

  const emitSectionMetrics = (section: string, el?: HTMLElement) => {
    if (!isScrollDebugEnabled()) return
    const root = rootRef()
    if (!root || !el) return
    const scroller = root.closest(".session-scroller") as HTMLElement | null | undefined
    const rect = el.getBoundingClientRect()
    const scrollerRect = scroller?.getBoundingClientRect()
    const entry = {
      time: Date.now(),
      scope: "session-turn-layout",
      event: "section-metrics",
      section,
      sessionID: props.sessionID,
      messageID: props.messageID,
      working: working(),
      stepsExpanded: props.stepsExpanded,
      stickyDisabled: stickyDisabled(),
      rectTop: rect.top,
      rectBottom: rect.bottom,
      rectHeight: rect.height,
      relativeTop: scrollerRect ? rect.top - scrollerRect.top : undefined,
      relativeBottom: scrollerRect ? rect.bottom - scrollerRect.top : undefined,
      scrollTop: scroller?.scrollTop,
      scrollHeight: scroller?.scrollHeight,
      clientHeight: scroller?.clientHeight,
      distanceFromBottom: scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : undefined,
    }
    pushScrollDebug(entry)
    console.debug("[scroll-debug]", entry)
  }

  const updateStickyHeight = (height: number) => {
    const root = rootRef()
    if (!root) return
    if (stickyDisabled()) {
      root.style.setProperty("--session-turn-sticky-height", "0px")
      return
    }
    const next = Math.ceil(height)
    root.style.setProperty("--session-turn-sticky-height", `${next}px`)
    if (isScrollDebugEnabled()) {
      const scroller = root?.closest(".session-scroller") as HTMLElement | null | undefined
      const entry = {
        time: Date.now(),
        scope: "session-turn-sticky",
        event: "sticky-height",
        height: next,
        stickyDisabled: stickyDisabled(),
        working: working(),
        stepsExpanded: props.stepsExpanded,
        scrollTop: scroller?.scrollTop,
        scrollHeight: scroller?.scrollHeight,
        clientHeight: scroller?.clientHeight,
        distanceFromBottom: scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : undefined,
      }
      pushScrollDebug(entry)
      console.debug("[scroll-debug]", entry)
    }
  }

  function duration() {
    const msg = message()
    if (!msg) return ""

    // Only use a fixed "to" time when ALL assistant messages have completed
    // AND the turn is no longer working. The "working" guard covers the
    // window between a tool_use (e.g. subagent delegation) finalizing the
    // parent assistant message and the next assistant message being created
    // — without it, every() reports completed and the timer freezes.
    const msgs = assistantMessages()
    const allCompleted = msgs.length > 0 && msgs.every((m) => typeof m.time.completed === "number")
    const completed =
      allCompleted && !working()
        ? msgs.reduce<number | undefined>((max, item) => {
            const value = item.time.completed
            if (typeof value !== "number") return max
            if (max === undefined) return value
            return Math.max(max, value)
          }, undefined)
        : undefined

    const override = statusOverride()
    const from = DateTime.fromMillis(override?.startedAt ?? msg.time.created)
    const to = completed ? DateTime.fromMillis(completed) : DateTime.now()
    const interval = Interval.fromDateTimes(from, to)
    const unit: DurationUnit[] = interval.length("seconds") > 60 ? ["minutes", "seconds"] : ["seconds"]

    const locale = i18n.locale()
    const human = interval.toDuration(unit).normalize().reconfigure({ locale }).toHuman({
      notation: "compact",
      unitDisplay: "narrow",
      compactDisplay: "short",
      showZeros: false,
    })
    return locale.startsWith("zh") ? human.replaceAll("、", "") : human
  }

  createResizeObserver(
    () => stickyRef(),
    ({ height }) => {
      updateStickyHeight(height)
      emitSectionMetrics("sticky", stickyRef())
    },
  )

  createResizeObserver(
    () => stepsRef(),
    () => {
      emitSectionMetrics("steps", stepsRef())
    },
  )

  createResizeObserver(
    () => summaryRef(),
    () => {
      emitSectionMetrics("summary", summaryRef())
    },
  )

  createEffect(() => {
    const root = rootRef()
    if (!root) return
    const sticky = stickyRef()
    if (!sticky) {
      root.style.setProperty("--session-turn-sticky-height", "0px")
      return
    }
    updateStickyHeight(sticky.getBoundingClientRect().height)
    queueMicrotask(() => {
      emitSectionMetrics("sticky", stickyRef())
      emitSectionMetrics("steps", stepsRef())
      emitSectionMetrics("summary", summaryRef())
    })
  })

  const [store, setStore] = createStore({
    retrySeconds: 0,
    status: rawStatus(),
    duration: duration(),
  })

  createEffect(() => {
    const r = retry()
    if (!r) {
      setStore("retrySeconds", 0)
      return
    }
    const updateSeconds = () => {
      const next = r.next
      if (next) setStore("retrySeconds", Math.max(0, Math.round((next - Date.now()) / 1000)))
    }
    updateSeconds()
    const timer = setInterval(updateSeconds, 1000)
    onCleanup(() => clearInterval(timer))
  })

  let retryLog = ""
  createEffect(() => {
    const r = retry()
    if (!r) return
    const key = `${r.attempt}:${r.next}:${r.message}`
    if (key === retryLog) return
    retryLog = key
    if (isSessionDebugEnabled()) {
      console.warn("[session-turn] retry", {
        sessionID: props.sessionID,
        messageID: props.messageID,
        attempt: r.attempt,
        next: r.next,
        raw: r.message,
        parsed: unwrap(r.message),
      })
    }
  })

  let errorLog = ""
  createEffect(() => {
    const value = error()?.data?.message
    if (value === undefined || value === null) return
    const raw = typeof value === "string" ? value : String(value)
    if (!raw) return
    if (raw === errorLog) return
    errorLog = raw
    if (isSessionDebugEnabled()) {
      console.warn("[session-turn] assistant-error", {
        sessionID: props.sessionID,
        messageID: props.messageID,
        raw,
        parsed: unwrap(raw),
      })
    }
  })

  createEffect(() => {
    const update = () => {
      setStore("duration", duration())
    }

    update()

    // Keep ticking while any assistant message in this turn is still in progress.
    // Use .every() not .some(): narration messages (e.g. "Delegating to explore: ...")
    // are created with time.completed already set, but the main assistant message
    // is still running. Using .some() would freeze the timer when narration fires.
    // Also keep ticking while working() is true — between a parent's tool_use
    // finalizing and the next assistant message landing, every() briefly returns
    // true even though the turn is mid subagent delegation.
    const msgs = assistantMessages()
    const completed = msgs.length > 0 && msgs.every((m) => typeof m.time.completed === "number")
    if (completed && !working()) return

    const timer = setInterval(update, 1000)
    onCleanup(() => clearInterval(timer))
  })

  let lastStatusChange = Date.now()
  let statusTimeout: number | undefined
  createEffect(() => {
    const newStatus = rawStatus()
    if (newStatus === store.status || !newStatus) return

    const timeSinceLastChange = Date.now() - lastStatusChange
    if (timeSinceLastChange >= 2500) {
      setStore("status", newStatus)
      lastStatusChange = Date.now()
      if (statusTimeout) {
        clearTimeout(statusTimeout)
        statusTimeout = undefined
      }
    } else {
      if (statusTimeout) clearTimeout(statusTimeout)
      statusTimeout = setTimeout(() => {
        setStore("status", rawStatus())
        lastStatusChange = Date.now()
        statusTimeout = undefined
      }, 2500 - timeSinceLastChange) as unknown as number
    }
  })

  onCleanup(() => {
    if (!statusTimeout) return
    clearTimeout(statusTimeout)
  })

  return (
    <div data-component="session-turn" class={props.classes?.root} ref={setRootRef}>
      <div data-slot="session-turn-content" class={props.classes?.content}>
        <div>
          <Show when={message()}>
            {(msg) => (
              <div data-message={msg().id} data-slot="session-turn-message-container" class={props.classes?.container}>
                <Switch>
                  <Match when={isShellMode()}>
                    <Part part={shellModePart()!} message={msg()} defaultOpen />
                  </Match>
                  <Match when={true}>
                    <Show when={attachmentParts().length > 0}>
                      <div data-slot="session-turn-attachments" aria-live="off">
                        <Message message={msg()} parts={attachmentParts()} queued={queued()} />
                      </div>
                    </Show>
                    <div
                      data-slot="session-turn-sticky"
                      data-sticky-disabled={stickyDisabled() ? "true" : undefined}
                      ref={setStickyRef}
                    >
                      {/* User Message */}
                      <div data-slot="session-turn-message-content" aria-live="off">
                        <Message message={msg()} parts={stickyParts()} queued={queued()} />
                      </div>
                    </div>
                    <SessionRetry status={status()} show={isLastUserMessage()} />
                    {/* Steps (always inline) */}
                    <Show when={assistantMessages().length > 0}>
                      <div data-slot="session-turn-collapsible-content-inner" aria-hidden={working()} ref={setStepsRef}>
                        <AssistantParts
                          messages={assistantMessages()}
                          working={working()}
                          responsePartId={responsePartId()}
                          hideResponsePart={hideResponsePart()}
                          hideReasoning={false}
                          showReasoningSummaries={props.showReasoningSummaries ?? true}
                          hidden={hidden()}
                          shellToolDefaultOpen={props.shellToolDefaultOpen}
                          editToolDefaultOpen={props.editToolDefaultOpen}
                        />
                        {/* error card moved to a single render site at turn bottom (see below).
                            previously this site rendered an error card unconditionally and the
                            turn-bottom site rendered another one when !stepsExpanded — both
                            appeared simultaneously when steps were collapsed, doubling the red. */}
                      </div>
                    </Show>
                    <Show when={statusLineMounted()}>
                      <div data-slot="session-turn-status-inline" data-visible={statusLineVisible() ? "true" : "false"}>
                        <Switch>
                          <Match when={retry()}>
                            <span data-slot="session-turn-retry-message">
                              {(() => {
                                const r = retry()
                                if (!r) return ""
                                const msg = unwrap(r.message)
                                return msg.length > 60 ? msg.slice(0, 60) + "..." : msg
                              })()}
                            </span>
                            <span data-slot="session-turn-retry-seconds">
                              · {i18n.t("ui.sessionTurn.retry.retrying")}
                              {store.retrySeconds > 0
                                ? " " + i18n.t("ui.sessionTurn.retry.inSeconds", { seconds: store.retrySeconds })
                                : ""}
                            </span>
                            <span data-slot="session-turn-retry-attempt">(#{retry()?.attempt})</span>
                          </Match>
                          <Match when={statusOverride()}>
                            {(override) => (
                              <>
                                <Spinner />
                                <span data-slot="session-turn-status-text">{override().label}</span>
                              </>
                            )}
                          </Match>
                          <Match when={working() && active()}>
                            <Spinner />
                            <span data-slot="session-turn-status-text">
                              {store.status ?? i18n.t("ui.sessionTurn.status.consideringNextSteps")}
                            </span>
                          </Match>
                          <Match when={working()}>
                            <Spinner />
                            <span data-slot="session-turn-status-text">
                              {store.status ?? i18n.t("ui.sessionTurn.status.consideringNextSteps")}
                            </span>
                          </Match>
                        </Switch>
                        <span aria-hidden="true">·</span>
                        <span aria-live="off">{store.duration}</span>
                      </div>
                    </Show>
                    <Show when={answeredQuestionParts().length > 0}>
                      <div data-slot="session-turn-answered-question-parts">
                        <For each={answeredQuestionParts()}>
                          {({ part, message }) => <Part part={part} message={message} />}
                        </For>
                      </div>
                    </Show>
                    {/* Response */}
                    <div class="sr-only" aria-live="polite">
                      {!working() && response() ? response() : ""}
                    </div>
                    <Show when={!working() && response()}>
                      <div data-slot="session-turn-summary-section" ref={setSummaryRef}>
                        <div data-slot="session-turn-summary-header">
                          <div data-slot="session-turn-summary-title-row">
                            <h2 data-slot="session-turn-summary-title">{i18n.t("ui.sessionTurn.summary.response")}</h2>
                            {/* copy button removed — user prefers mouse selection */}
                          </div>
                          <div data-slot="session-turn-response">
                            <Markdown
                              data-slot="session-turn-markdown"
                              data-diffs={hasDiffs()}
                              text={response() ?? ""}
                              cacheKey={responsePartId()}
                            />
                            <Show when={expandedInlineImages().length > 0 && props.inlineImage}>
                              <div class="mt-3 space-y-3">
                                <For each={expandedInlineImages()}>
                                  {(path) => {
                                    const preview = createMemo(() => props.inlineImage?.preview(path))
                                    return (
                                      <div class="rounded border border-border-base bg-surface-secondary p-2">
                                        <div class="mb-2 truncate text-11-regular text-text-weak">{path}</div>
                                        <Show
                                          when={preview()?.url}
                                          fallback={
                                            <div class="text-12-regular text-text-weak">
                                              {preview()?.error ?? "Loading image..."}
                                            </div>
                                          }
                                        >
                                          {(url) => (
                                            <img
                                              src={url()}
                                              alt={path}
                                              class="max-h-[480px] max-w-full rounded bg-white object-contain"
                                            />
                                          )}
                                        </Show>
                                      </div>
                                    )
                                  }}
                                </For>
                              </div>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>
                    <Show when={error()}>
                      <Card variant="error" class="error-card">
                        {errorText()}
                      </Card>
                    </Show>
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}
