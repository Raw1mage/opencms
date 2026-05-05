import { Binary } from "@opencode-ai/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type {
  LlmErrorEntry,
  LlmHistoryEntry,
  State,
  StoreActiveChildEntry,
  StoreSessionStatusEntry,
  VcsCache,
} from "./types"
import { LLM_HISTORY_CAP } from "./types"
import { trimSessions } from "./session-trim"
import { buildSessionTelemetryFromProjector } from "@/pages/session/monitor-helper"
import type { SessionMonitorInfo } from "@opencode-ai/sdk/v2/client"
import { frontendTweaks } from "../frontend-tweaks"
import { computeGlobalEvictions, isMessageLive, platformStoreCap } from "@/utils/store-cap"

// Module-level live-streaming tracker. An assistant messageID stays in this
// set while time.completed is absent; removed on the final message.updated
// that stamps completion. Eviction skips IDs in this set.
const _liveStreamingIds = new Set<string>()

export function evictGlobalIfOverCap(store: Store<State>, setStore: SetStoreFunction<State>) {
  const cap = platformStoreCap()
  const decisions = computeGlobalEvictions(store.message, cap, _liveStreamingIds)
  if (decisions.length === 0) return
  setStore(
    produce((draft) => {
      for (const { sessionID, messageID } of decisions) {
        const list = draft.message[sessionID]
        if (!list) continue
        const idx = list.findIndex((m) => m?.id === messageID)
        if (idx >= 0) list.splice(idx, 1)
        delete draft.part[messageID]
      }
    }),
  )
}

// Non-reactive dedup map for delta events.
// SolidJS batch() defers setStore updates, so within a single flush the reactive
// store still shows the pre-batch text length. Multiple SSE connections delivering
// the same delta in the same batch all pass the reactive guard and append twice.
// This plain Map updates synchronously, surviving batch boundaries.
const _appliedTextLength = new Map<string, number>()

// --- specs/frontend-session-lazyload/ : rebuild heuristic + tail-window ---
// Prefix-match length used to decide whether a non-delta incoming Part looks
// like an AI-SDK rebuild (whole text resent, prefix unchanged) vs a true
// replacement. See design.md DD-5 and invariants.md INV-3/INV-4.
const REBUILD_PREFIX_MATCH = 1024

function tailWindowBytes(cfg: { frontend_session_lazyload: 0 | 1; tail_window_kb: number }): number {
  return cfg.tail_window_kb * 1024
}

function isTextPartType(part: Part): part is Part & { type: "text" | "reasoning"; text: string } {
  return "type" in part && (part.type === "text" || part.type === "reasoning") && "text" in part
}

/**
 * Detect whether `incoming` (a non-delta updated Part) is actually an AI-SDK
 * full-text rebuild of the same underlying content we already have locally.
 * Returns "append" when the first REBUILD_PREFIX_MATCH chars match existing.text;
 * returns "replace" otherwise. Uses substring compare (O(1024)), not full scan,
 * per DD-5.
 */
function classifyNonDeltaUpdate(existingText: string, incomingText: string): "append" | "replace" {
  if (incomingText.length <= existingText.length) return "replace" // shrink or same — true replace
  const compareLen = Math.min(REBUILD_PREFIX_MATCH, existingText.length)
  if (compareLen === 0) return "replace"
  const a = existingText.slice(0, compareLen)
  const b = incomingText.slice(0, compareLen)
  return a === b ? "append" : "replace"
}

/**
 * Apply streaming tail-window: if `text` exceeds tailBytes, keep only the last
 * tailBytes chars. Returns the truncated text and the number of prefix bytes
 * dropped; both callers update the store accordingly. No-op when feature flag
 * is off (flag=0) per INV-2.
 */
function applyTailWindow(
  text: string,
  cfg: { frontend_session_lazyload: 0 | 1; tail_window_kb: number },
): { text: string; truncatedPrefix: number } {
  if (cfg.frontend_session_lazyload === 0) return { text, truncatedPrefix: 0 }
  const tailBytes = tailWindowBytes(cfg)
  if (text.length <= tailBytes) return { text, truncatedPrefix: 0 }
  const truncatedPrefix = text.length - tailBytes
  return { text: text.slice(truncatedPrefix), truncatedPrefix }
}

/**
 * Streaming OOM safety cap — separate from the tight tail-window used by
 * the attach-phase lazy loader. Live streaming replies should render as
 * they arrive; we only truncate when the accumulated text is large enough
 * to threaten browser memory (AI SDK rebuild pathology: 3MB+ in one part).
 *
 * Contract: `applyTailWindow` is for the history attach path (where we
 * want to cap at tailWindowKb, typically 64KB). This function is for the
 * live SSE delta path (where the user is actively watching the reply land)
 * and uses a much larger cap — 16× the configured tail window. At the
 * default 64KB that becomes 1MB, comfortably above any normal reply but
 * still bounded so a runaway rebuild does not crash the tab.
 */
function applyStreamingOomCap(
  text: string,
  cfg: { frontend_session_lazyload: 0 | 1; tail_window_kb: number },
): { text: string; truncatedPrefix: number } {
  if (cfg.frontend_session_lazyload === 0) return { text, truncatedPrefix: 0 }
  const cap = tailWindowBytes(cfg) * 16
  if (text.length <= cap) return { text, truncatedPrefix: 0 }
  const truncatedPrefix = text.length - cap
  return { text: text.slice(truncatedPrefix), truncatedPrefix }
}

function pushLlmHistory(draft: State, entry: LlmHistoryEntry) {
  if (!draft.llm_history) draft.llm_history = []
  draft.llm_history.push(entry)
  if (draft.llm_history.length > LLM_HISTORY_CAP) {
    draft.llm_history = draft.llm_history.slice(-LLM_HISTORY_CAP)
  }
}

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => void)) => void
  refresh: () => void
  onDisposed?: () => boolean
}) {
  if (input.event.type === "global.disposed") {
    if (input.onDisposed?.()) return
    input.refresh()
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    input.setGlobalProject((draft) => {
      draft[result.index] = { ...draft[result.index], ...properties }
    })
    return
  }
  input.setGlobalProject((draft) => {
    draft.splice(result.index, 0, properties)
  })
}

function cleanupSessionCaches(store: Store<State>, setStore: SetStoreFunction<State>, sessionID: string) {
  if (!sessionID) return
  const hasAny =
    store.message[sessionID] !== undefined ||
    store.session_diff[sessionID] !== undefined ||
    store.workspace_diff[sessionID] !== undefined ||
    store.todo[sessionID] !== undefined ||
    store.permission[sessionID] !== undefined ||
    store.question[sessionID] !== undefined ||
    store.session_status[sessionID] !== undefined ||
    store.active_child[sessionID] !== undefined ||
    store.session_telemetry[sessionID] !== undefined
  if (!hasAny) return
  setStore(
    produce((draft) => {
      const messages = draft.message[sessionID]
      if (messages) {
        for (const message of messages) {
          const id = message?.id
          if (!id) continue
          delete draft.part[id]
        }
      }
      delete draft.message[sessionID]
      delete draft.session_diff[sessionID]
      if (draft.workspace_diff) delete draft.workspace_diff[sessionID]
      delete draft.todo[sessionID]
      delete draft.permission[sessionID]
      delete draft.question[sessionID]
      delete draft.session_status[sessionID]
      delete draft.active_child[sessionID]
      delete draft.session_telemetry[sessionID]
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  loadMcp: () => void
  vcsCache?: VcsCache
}) {
  const event = input.event
  const debugAttachments = (...args: unknown[]) => {
    if (typeof localStorage === "undefined") return
    if (localStorage.getItem("opencode.debug.attachments") !== "1") return
    console.info("[attachments-debug]", ...args)
  }
  switch (event.type) {
    case "server.instance.disposed": {
      input.push(input.directory)
      return
    }
    case "workspace.created":
    case "workspace.updated":
    case "workspace.lifecycle.changed":
    case "workspace.attachment.added":
    case "workspace.attachment.removed": {
      const props = event.properties as { workspace?: State["workspace"] }
      if (!props.workspace) break
      input.setStore("workspace", reconcile(props.workspace))
      break
    }
    case "session.created": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        if (result.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches(input.store, input.setStore, info.id)
        if (info.parentID) break
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches(input.store, input.setStore, info.id)
      if (info.parentID) break
      input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      break
    }
    case "session.diff": {
      break
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      input.setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      // session-ui-freshness R1.S1 / DD-1: stamp client receivedAt on every arrival.
      const entry: StoreSessionStatusEntry = { ...props.status, receivedAt: Date.now() }
      input.setStore("session_status", props.sessionID, reconcile(entry))
      break
    }
    case "session.active-child.updated": {
      const props = event.properties as {
        parentSessionID: string
        activeChild: Omit<StoreActiveChildEntry, "receivedAt"> | null
      }
      input.setStore(
        produce((draft) => {
          // session-ui-freshness R1.S2 / DD-1: stamp client receivedAt (inline DD-8).
          if (props.activeChild)
            draft.active_child[props.parentSessionID] = { ...props.activeChild, receivedAt: Date.now() }
          else delete draft.active_child[props.parentSessionID]
        }),
      )
      break
    }
    case "session.telemetry.updated": {
      const props = event.properties as { sessionID: string; telemetry: Record<string, unknown> }
      const session = input.store.session.find((item) => item.id === props.sessionID)
      const status = input.store.session_status[props.sessionID]
      const monitorEntries: SessionMonitorInfo[] = [
        {
          id: `telemetry:${props.sessionID}`,
          level: "session",
          sessionID: props.sessionID,
          title: session?.title ?? props.sessionID,
          status: status ?? ({ type: "idle" } as SessionStatus),
          requests: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          totalTokens: 0,
          updated: Date.now(),
          telemetry: props.telemetry as any,
        },
      ]
      input.setStore(
        "session_telemetry",
        props.sessionID,
        reconcile(buildSessionTelemetryFromProjector({ session, status, monitorEntries })),
      )
      break
    }
    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      // Phase 10: live-streaming tracker. Add when streaming, remove when done.
      if (isMessageLive(info)) _liveStreamingIds.add(info.id)
      else _liveStreamingIds.delete(info.id)

      const messages = input.store.message[info.sessionID]
      if (!messages) {
        input.setStore("message", info.sessionID, [info])
        evictGlobalIfOverCap(input.store, input.setStore)
        break
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (result.found) {
        input.setStore("message", info.sessionID, result.index, reconcile(info))
        // Update-in-place doesn't grow the store, but completing a streaming
        // message makes it newly LRU-eligible, so we still sweep.
        evictGlobalIfOverCap(input.store, input.setStore)
        break
      }
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      evictGlobalIfOverCap(input.store, input.setStore)
      break
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      _liveStreamingIds.delete(props.messageID)
      input.setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            const result = Binary.search(messages, props.messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[props.messageID]
        }),
      )
      break
    }
    case "message.part.updated": {
      const props = event.properties as { part: Part; delta?: string; textLength?: number }
      const part = props.part
      const delta = props.delta
      const parts = input.store.part[part.messageID]
      const tweaksCfg = frontendTweaks()

      // [PART-FLOW-C] reducer entry — confirms event reached the frontend.
      // Gated by localStorage["opencode:debug:part-flow"]="1" — fires per part.updated, very noisy during streaming.
      try {
        if (typeof localStorage !== "undefined" && localStorage.getItem("opencode:debug:part-flow") === "1") {
          // eslint-disable-next-line no-console
          console.log("[PART-FLOW-C] reducer received part.updated", {
            partType: (part as { type?: string }).type,
            tool: (part as { tool?: string }).tool,
            partId: (part as { id?: string }).id,
            messageID: (part as { messageID?: string }).messageID,
            sessionID: (part as { sessionID?: string }).sessionID,
            hasDelta: typeof delta === "string",
            existingMessageStored: !!parts,
          })
        }
      } catch {}

      // Delta-aware streaming: when delta is present and part.text is stripped,
      // append delta to the existing stored part instead of replacing it wholesale.
      if (delta && parts && "type" in part && (part.type === "text" || part.type === "reasoning")) {
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          const existing = parts[result.index]
          if ("text" in existing) {
            // Guard: use non-reactive map to detect duplicate delta apply.
            // SolidJS batch() defers store updates, so the reactive existing.text.length
            // stays stale within a flush — plain Map tracks the true applied length.
            const dedupKey = `${part.messageID}:${part.id}`
            if (props.textLength !== undefined) {
              const applied = _appliedTextLength.get(dedupKey) ?? existing.text.length
              if (applied >= props.textLength) {
                break
              }
              _appliedTextLength.set(dedupKey, props.textLength)
            }
            // Fast path: append delta to existing text without replacing the whole part.
            // Live streaming — use OOM-safety cap only (NOT the tighter attach tail window).
            // Rationale: this branch fires on every SSE delta for a reply the user is
            // actively watching land. Capping at 64KB here hides most of a normal reply
            // behind the "streaming 中，暫顯示最後 N KB" banner even though the reply is
            // nowhere near memory-threatening. The attach tail window belongs on the
            // history hydration path, not on live streaming.
            const hasText = "text" in part && typeof (part as any).text === "string"
            const rawText = hasText ? (part as any).text : existing.text + delta
            const existingTruncated = (existing as any).truncatedPrefix as number | undefined
            const { text: windowedText, truncatedPrefix: newTruncated } = applyStreamingOomCap(rawText, tweaksCfg)
            input.setStore("part", part.messageID, result.index, "text" as any, windowedText)
            const effectiveTruncated = (existingTruncated ?? 0) + newTruncated
            if (effectiveTruncated > 0) {
              input.setStore("part", part.messageID, result.index, "truncatedPrefix" as any, effectiveTruncated)
            } else if (existingTruncated !== undefined) {
              input.setStore("part", part.messageID, result.index, "truncatedPrefix" as any, 0)
            }
            // Update metadata if present
            if ("metadata" in part && part.metadata) {
              input.setStore("part", part.messageID, result.index, "metadata" as any, part.metadata)
            }
            break
          }
        }
        // Part not found yet — fall through to insertion with reconstructed text
        if (!("text" in part) || typeof (part as any).text !== "string") {
          ;(part as any).text = delta
        }
      }

      // specs/frontend-session-lazyload §5.1 — non-delta rebuild detection.
      // AI SDK sometimes resends the full text on each update instead of a
      // delta. If the new incoming text is longer than what we have AND the
      // prefix matches, treat it as append to avoid a full reconcile storm.
      if (!delta && parts && isTextPartType(part)) {
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          const existing = parts[result.index]
          if (isTextPartType(existing)) {
            const decision = classifyNonDeltaUpdate(existing.text, part.text)
            if (decision === "append") {
              // AI SDK rebuild-on-every-update path — still live streaming.
              // Use OOM-safety cap, not attach tail window. See note above.
              const { text: windowedText, truncatedPrefix: newTruncated } = applyStreamingOomCap(part.text, tweaksCfg)
              input.setStore("part", part.messageID, result.index, "text" as any, windowedText)
              if (newTruncated > 0) {
                input.setStore("part", part.messageID, result.index, "truncatedPrefix" as any, newTruncated)
              }
              if ("metadata" in part && part.metadata) {
                input.setStore("part", part.messageID, result.index, "metadata" as any, part.metadata)
              }
              break
            }
            // decision === "replace" — fall through to the normal reconcile.
          }
        }
      }

      // Pre-insert OOM cap: first-arrival via SSE is still streaming (history
      // hydration goes through sync.tsx loadMessages, not this reducer). Use the
      // larger streaming cap so normal replies arrive intact; the cap only kicks
      // in on pathological multi-MB single parts.
      if (isTextPartType(part)) {
        const windowed = applyStreamingOomCap(part.text, tweaksCfg)
        if (windowed.truncatedPrefix > 0) {
          ;(part as any).text = windowed.text
          ;(part as any).truncatedPrefix = windowed.truncatedPrefix
        }
      }

      if (!parts) {
        input.setStore("part", part.messageID, [part])
        if (part.type === "file") {
          debugAttachments("part.updated:new", {
            messageID: part.messageID,
            partID: part.id,
            mime: part.mime,
            filename: part.filename,
            urlHead: part.url.slice(0, 64),
          })
        }
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        if (part.type === "file") {
          debugAttachments("part.updated:replace-id", {
            messageID: part.messageID,
            partID: part.id,
          })
        }
        break
      }
      if (part.type === "file") {
        const isInlineImage = part.url.startsWith("data:image/")
        const semanticIndex = parts.findIndex(
          (existing) =>
            existing.type === "file" && existing.url === part.url && (isInlineImage || existing.mime === part.mime),
        )
        if (semanticIndex !== -1) {
          input.setStore("part", part.messageID, semanticIndex, reconcile(part))
          debugAttachments("part.updated:dedup-semantic", {
            messageID: part.messageID,
            partID: part.id,
            replacedIndex: semanticIndex,
          })
          break
        }
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }
    case "vcs.branch.updated": {
      const props = event.properties as { branch: string }
      if (input.store.vcs?.branch === props.branch) break
      const next = { branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = input.store.question[question.sessionID]
      if (!questions) {
        input.setStore("question", question.sessionID, [question])
        break
      }
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        input.setStore("question", question.sessionID, result.index, reconcile(question))
        break
      }
      input.setStore(
        "question",
        question.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, question)
        }),
      )
      break
    }
    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = input.store.question[props.sessionID]
      if (!questions) break
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) break
      input.setStore(
        "question",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "lsp.updated": {
      input.loadLsp()
      break
    }
    case "mcp.tools.changed": {
      input.loadMcp()
      break
    }
    case "killswitch.status.changed": {
      const props = event.properties as {
        active: boolean
        state: string
        requestID?: string
        initiator?: string
        reason?: string
        snapshotURL?: string | null
      }
      input.setStore("killswitch_status", reconcile(props))
      break
    }
    case "llm.error": {
      const props = event.properties as {
        providerId: string
        modelId: string
        accountId: string
        sessionID: string
        status?: number
        message: string
        timestamp: number
      }
      const entry: LlmErrorEntry = {
        providerId: props.providerId,
        accountId: props.accountId,
        modelId: props.modelId,
        sessionID: props.sessionID,
        status: props.status,
        message: props.message,
        timestamp: props.timestamp,
        type: "error",
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) draft.llm_errors = []
          const idx = draft.llm_errors.findIndex(
            (e) => e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId,
          )
          if (idx !== -1) {
            draft.llm_errors[idx] = entry
          } else {
            draft.llm_errors.push(entry)
          }
          if (draft.llm_errors.length > 30) {
            draft.llm_errors = draft.llm_errors.slice(-30)
          }
          pushLlmHistory(draft, {
            providerId: props.providerId,
            accountId: props.accountId,
            modelId: props.modelId,
            timestamp: props.timestamp,
            state: "error",
            message: props.message,
          })
        }),
      )
      break
    }
    case "ratelimit.detected": {
      const props = event.properties as {
        providerId: string
        accountId: string
        modelId: string
        reason: string
        backoffMs: number
        source: string
        timestamp: number
      }
      const entry: LlmErrorEntry = {
        providerId: props.providerId,
        accountId: props.accountId,
        modelId: props.modelId,
        message: props.reason,
        timestamp: props.timestamp,
        type: "ratelimit",
        reason: props.reason,
        backoffMs: props.backoffMs,
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) draft.llm_errors = []
          const idx = draft.llm_errors.findIndex(
            (e) => e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId,
          )
          if (idx !== -1) {
            draft.llm_errors[idx] = entry
          } else {
            draft.llm_errors.push(entry)
          }
          if (draft.llm_errors.length > 30) {
            draft.llm_errors = draft.llm_errors.slice(-30)
          }
          pushLlmHistory(draft, {
            providerId: props.providerId,
            accountId: props.accountId,
            modelId: props.modelId,
            timestamp: props.timestamp,
            state: "ratelimit",
            message: props.reason,
          })
        }),
      )
      break
    }
    case "ratelimit.cleared": {
      const props = event.properties as {
        providerId: string
        accountId: string
        modelId: string
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) return
          draft.llm_errors = draft.llm_errors.filter(
            (e) =>
              !(e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId),
          )
          pushLlmHistory(draft, {
            providerId: props.providerId,
            accountId: props.accountId,
            modelId: props.modelId,
            timestamp: Date.now(),
            state: "recovered",
          })
        }),
      )
      break
    }
    case "ratelimit.auth_failed": {
      const props = event.properties as {
        providerId: string
        accountId: string
        modelId: string
        message: string
        timestamp: number
      }
      const entry: LlmErrorEntry = {
        providerId: props.providerId,
        accountId: props.accountId,
        modelId: props.modelId,
        message: props.message,
        timestamp: props.timestamp,
        type: "auth_failed",
        reason: "AUTH_FAILED",
        backoffMs: 3_600_000,
      }
      input.setStore(
        produce((draft) => {
          if (!draft.llm_errors) draft.llm_errors = []
          const idx = draft.llm_errors.findIndex(
            (e) => e.providerId === props.providerId && e.accountId === props.accountId && e.modelId === props.modelId,
          )
          if (idx !== -1) {
            draft.llm_errors[idx] = entry
          } else {
            draft.llm_errors.push(entry)
          }
          pushLlmHistory(draft, {
            providerId: props.providerId,
            accountId: props.accountId,
            modelId: props.modelId,
            timestamp: props.timestamp,
            state: "auth_failed",
            message: props.message,
          })
        }),
      )
      break
    }
    case "codex.transport": {
      const props = event.properties as {
        sessionId: string
        transport: "ws" | "http"
      }
      input.setStore(
        produce((draft) => {
          if (!draft.codex_transport) draft.codex_transport = {}
          draft.codex_transport[props.sessionId] = props.transport
        }),
      )
      break
    }
    case "rotation.executed": {
      const props = event.properties as {
        fromProviderId: string
        fromModelId: string
        fromAccountId: string
        toProviderId: string
        toModelId: string
        toAccountId: string
        reason: string
        timestamp: number
      }
      input.setStore(
        produce((draft) => {
          pushLlmHistory(draft, {
            providerId: props.fromProviderId,
            modelId: props.fromModelId,
            accountId: props.fromAccountId,
            timestamp: props.timestamp,
            state: "rotated",
            message: props.reason,
            toProviderId: props.toProviderId,
            toModelId: props.toModelId,
            toAccountId: props.toAccountId,
          })
        }),
      )
      break
    }
  }
}
