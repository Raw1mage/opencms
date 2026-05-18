import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { State } from "./global-sync/types"
import { isMessageTombstoned } from "./global-sync/event-reducer"

/**
 * Active polling — channel-independent correctness floor.
 *
 * After any client action that expects a server reply (submit prompt, approve
 * permission, etc.), the caller starts active polling for that session. This
 * loop is **independent of SSE health**: it talks directly to REST snapshot
 * endpoints and converges the store to the server's current truth. Even if
 * SSE is permanently dead from the moment of submission, the user still sees
 * the assistant response within poll-cadence latency (frontend/resync P1
 * core; spec.md AC-1, AC-4; errors.md E3, E4; DD-4).
 *
 * Contract:
 *   - Returns a `stop` function. Caller MUST call it on unmount / route
 *     change / abort.
 *   - The poll stops automatically when `until(snapshot)` returns true.
 *   - Hard cap `maxDurationMs` (default 5min) — if reached, poll stops and
 *     logs a warning (errors.md E4).
 *   - Adaptive interval via `pollMs()` — typically 500ms while streaming,
 *     2-5s otherwise. Caller decides.
 *   - HTTP failure does NOT speed up the loop. Failures back off; see
 *     errors.md E3.
 *   - Merge rule: by part.id, preserve local "streaming" parts (text/
 *     reasoning where `time.end === undefined` and local has more content).
 *     See DD-6, AC-6, errors.md E5.
 */

export type ActivePollDeps = {
  client: {
    session: {
      get: (args: { sessionID: string; directory?: string }) => Promise<{ data?: SessionInfo }>
      messages: (args: {
        sessionID: string
        directory?: string
        limit?: number
      }) => Promise<{ data?: Array<{ info: Message; parts: Part[] }> }>
    }
  }
  directory: string
  setStore: SetStoreFunction<State>
  store: Store<State>
}

export type ActivePollConfig = {
  /** Function returning current desired interval in ms (typically reads store state). */
  pollMs: () => number
  /** Predicate; when true on a fresh snapshot, the poll stops. */
  until: (input: { session: SessionInfo | null; lastAssistant: Message | null }) => boolean
  /** Hard cap on total poll lifetime in ms. Default 300_000 (5min). */
  maxDurationMs?: number
  /** Tail message limit per snapshot pull. Default 100. */
  messageLimit?: number
  /** Optional callback fired after each successful merge. */
  onPull?: (input: {
    session: SessionInfo | null
    lastAssistant: Message | null
    parts_inserted: number
    parts_replaced: number
    parts_kept_local: number
  }) => void
  /** Optional callback when the loop stops; reports the reason. */
  onStop?: (reason: "completed" | "max_duration" | "external_stop") => void
}

// Server-side SessionInfo shape is intentionally loose — we only touch the
// `workflow.state` field and pass the rest opaquely back into the store.
type SessionInfo = {
  id: string
  workflow?: { state?: string }
  [k: string]: unknown
}

const DEFAULT_MAX_DURATION_MS = 300_000
const DEFAULT_MESSAGE_LIMIT = 100
const FAILURE_BACKOFF_FLOOR_MS = 1_000
const FAILURE_BACKOFF_CEILING_MS = 30_000

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function startActivePoll(
  sessionID: string,
  deps: ActivePollDeps,
  config: ActivePollConfig,
): () => void {
  const startedAt = Date.now()
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  const messageLimit = config.messageLimit ?? DEFAULT_MESSAGE_LIMIT

  const abort = new AbortController()
  const stop = (reason: "completed" | "max_duration" | "external_stop" = "external_stop") => {
    if (abort.signal.aborted) return
    abort.abort()
    config.onStop?.(reason)
  }

  void (async () => {
    let consecutiveFailures = 0
    while (!abort.signal.aborted) {
      // Hard cap (errors.md E4)
      if (Date.now() - startedAt > maxDurationMs) {
        console.warn("[active-poll] maxDurationMs reached without convergence", {
          sessionID,
          maxDurationMs,
          durationMs: Date.now() - startedAt,
        })
        stop("max_duration")
        return
      }

      try {
        // Only pull session info — NOT messages/parts. During streaming,
        // SSE event-reducer owns the message/part store and uses delta
        // appends + index-based setStore. Running reconcile on the same
        // store paths concurrently causes duplicate text and visual
        // doubling. Active poll's job is to detect WHEN the turn
        // completes (via workflow.state), not to mirror streaming
        // content. When `until` fires, we do one final loadMessages to
        // catch any content SSE may have missed. (frontend/resync
        // regression fix 2026-05-14)
        const sessionResp = await deps.client.session.get({
          sessionID,
          directory: deps.directory,
        })

        const sessionInfo = (sessionResp.data ?? null) as SessionInfo | null

        // Update session info only (workflow.state for `until` predicate).
        // Message/part store stays under SSE ownership during streaming.
        if (sessionInfo) {
          batch(() => {
            deps.setStore("session", (prev) => {
              const idx = prev.findIndex((s) => s.id === sessionID)
              if (idx < 0) return [...prev, sessionInfo as State["session"][number]]
              const next = prev.slice()
              next[idx] = sessionInfo as State["session"][number]
              return next
            })
          })
        }

        // Determine lastAssistant from current store (not from a snapshot
        // pull) — avoids reading messages from server during streaming.
        const localMessages = (deps.store.message[sessionID] ?? []) as Message[]
        const lastAssistant = [...localMessages].reverse().find((m) => m.role === "assistant") ?? null
        config.onPull?.({
          session: sessionInfo,
          lastAssistant,
          parts_inserted: 0,
          parts_replaced: 0,
          parts_kept_local: 0,
        })

        if (config.until({ session: sessionInfo, lastAssistant })) {
          // Turn is done. Do ONE final message sync to catch anything
          // SSE may have missed (e.g. if SSE was dead the whole time).
          // This is the only moment active poll touches message/part store.
          console.info("[active-poll] until=true, running final sync", {
            sessionID,
            ws: sessionInfo?.workflow?.state,
            lastAssistantId: lastAssistant?.id ?? null,
            lastAssistantFinish: (lastAssistant as any)?.finish ?? null,
            localMessageCount: localMessages.length,
          })
          try {
            const messagesResp = await deps.client.session.messages({
              sessionID,
              directory: deps.directory,
              limit: messageLimit,
            })
            const messages = messagesResp.data ?? []
            console.info("[active-poll] final sync fetched", {
              sessionID,
              serverCount: messages.length,
              serverRoles: messages.map((m: any) => m.info?.role ?? m.role).join(","),
            })
            if (messages.length > 0) {
              const merged = mergeSnapshot(deps.store, sessionID, messages)
              console.info("[active-poll] final sync merged", {
                sessionID,
                mergedCount: merged.messages.length,
                stats: merged.stats,
              })
              const localCountBefore = (deps.store.message[sessionID] ?? []).length
              batch(() => {
                deps.setStore("message", sessionID, reconcile(merged.messages, { key: "id" }))
                for (const m of merged.perMessageParts) {
                  deps.setStore("part", m.messageID, reconcile(m.parts, { key: "id" }))
                }
              })
              const localCountAfter = (deps.store.message[sessionID] ?? []).length
              if (localCountAfter < localCountBefore) {
                console.warn("[active-poll] final sync REDUCED message count!", {
                  sessionID,
                  before: localCountBefore,
                  after: localCountAfter,
                  delta: localCountAfter - localCountBefore,
                })
              }
            }
          } catch (syncErr) {
            console.warn("[active-poll] final message sync failed", {
              sessionID,
              error: syncErr instanceof Error ? syncErr.message : String(syncErr),
            })
          }
          stop("completed")
          return
        }

        consecutiveFailures = 0
        await wait(config.pollMs())
      } catch (error) {
        if (abort.signal.aborted) return
        consecutiveFailures += 1
        const backoff = Math.min(
          Math.max(FAILURE_BACKOFF_FLOOR_MS, 250 * 2 ** consecutiveFailures),
          FAILURE_BACKOFF_CEILING_MS,
        )
        console.warn("[active-poll] tick failed; backing off", {
          sessionID,
          consecutiveFailures,
          backoff,
          error: error instanceof Error ? error.message : String(error),
        })
        await wait(backoff)
      }
    }
  })().catch((err) => {
    console.error("[active-poll] unhandled error in poll loop", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  return () => stop("external_stop")
}

// ---------------------------------------------------------------------------
// mergeSnapshot — merge by message/part id with local-streaming preservation.
//
// Rule (frontend/resync DD-6, AC-6, errors.md E5):
//   - For each message: if local exists, prefer snapshot (server is authority
//     for top-level message fields like finish, tokens, time.completed).
//   - For each part: if local part has streaming state AND has more content
//     than snapshot, keep local; otherwise take snapshot.
//   - Locally-present parts not in snapshot are preserved (e.g. a fresh
//     SSE delta that arrived between snapshot creation and merge).
//   - Whole message list is never wholesale replaced — see batch reconcile
//     in the caller.
// ---------------------------------------------------------------------------

export type MergeResult = {
  messages: Message[]
  perMessageParts: Array<{ messageID: string; parts: Part[] }>
  stats: { inserted: number; replaced: number; kept_local: number }
}

export function mergeSnapshot(
  store: Store<State>,
  sessionID: string,
  snapshot: Array<{ info: Message; parts: Part[] }>,
): MergeResult {
  const stats = { inserted: 0, replaced: 0, kept_local: 0 }
  const messages: Message[] = []
  const perMessageParts: Array<{ messageID: string; parts: Part[] }> = []

  // Build snapshot map for O(1) lookup.
  const snapshotByMessageID = new Map(snapshot.map((m) => [m.info.id, m]))

  // Iterate union of local + snapshot messages, preserving local order then appending new ones.
  const localMessages = (store.message[sessionID] ?? []) as Message[]
  const seen = new Set<string>()
  for (const local of localMessages) {
    seen.add(local.id)
    const snap = snapshotByMessageID.get(local.id)
    if (!snap) {
      // Snapshot doesn't have it — keep local. (Probably because messageLimit
      // tail-truncated the older messages; we don't drop them from store.)
      messages.push(local)
      const localParts = (store.part[local.id] ?? []) as Part[]
      perMessageParts.push({ messageID: local.id, parts: localParts })
      continue
    }
    // Both present.
    messages.push(snap.info)
    const localParts = (store.part[local.id] ?? []) as Part[]
    const mergedParts = mergeParts(localParts, snap.parts, stats)
    perMessageParts.push({ messageID: local.id, parts: mergedParts })
  }

  // Append any snapshot-only messages (in their original order).
  // Skip tombstoned messages — these were recently removed via SSE
  // "message.removed" and must not be resurrected by a stale poll response.
  for (const snap of snapshot) {
    if (seen.has(snap.info.id)) continue
    if (isMessageTombstoned(snap.info.id)) continue
    messages.push(snap.info)
    const localParts = (store.part[snap.info.id] ?? []) as Part[]
    const mergedParts = mergeParts(localParts, snap.parts, stats)
    perMessageParts.push({ messageID: snap.info.id, parts: mergedParts })
  }

  return { messages, perMessageParts, stats }
}

function mergeParts(localParts: Part[], snapshotParts: Part[], stats: MergeResult["stats"]): Part[] {
  const localMap = new Map(localParts.map((p) => [p.id, p]))
  const result: Part[] = []
  const consumedFromLocal = new Set<string>()

  for (const snap of snapshotParts) {
    const local = localMap.get(snap.id)
    if (!local) {
      result.push(snap)
      stats.inserted += 1
      continue
    }
    consumedFromLocal.add(snap.id)
    if (preferLocal(local, snap)) {
      result.push(local)
      stats.kept_local += 1
    } else {
      result.push(snap)
      stats.replaced += 1
    }
  }

  // Locally-only parts (e.g. SSE delta arrived after snapshot was taken)
  for (const local of localParts) {
    if (consumedFromLocal.has(local.id)) continue
    if (snapshotParts.find((p) => p.id === local.id)) continue
    result.push(local)
    stats.kept_local += 1
  }

  return result
}

/**
 * Decide whether local part beats snapshot part. The streaming case (DD-6):
 *
 *   - If local has `time.end === undefined` (still streaming) AND has at least
 *     as much text as snapshot → keep local. The SSE delta stream is fresher
 *     than the snapshot's point-in-time view.
 *   - Tool parts: keep whichever has a "more advanced" state. If unclear,
 *     prefer snapshot (server is authority on tool execution state).
 *   - Otherwise: snapshot wins.
 */
function preferLocal(local: Part, snap: Part): boolean {
  // Different types — should never happen with same id, but be defensive.
  if (local.type !== snap.type) return false

  if (local.type === "text" || local.type === "reasoning") {
    const localTime = (local as { time?: { end?: number } }).time
    const snapTime = (snap as { time?: { end?: number } }).time
    const localStreaming = !localTime || localTime.end === undefined
    const snapStreaming = !snapTime || snapTime.end === undefined
    const localText = (local as { text?: string }).text ?? ""
    const snapText = (snap as { text?: string }).text ?? ""

    // Local still streaming and at least as much content → keep local.
    if (localStreaming && localText.length >= snapText.length) return true
    // Snap is final and local isn't yet → take snap (it has time.end).
    if (!snapStreaming && localStreaming) return false
    // Both completed → take snap (server is authority for final state).
    return false
  }

  // Tool / file / step parts: server is authority.
  return false
}
