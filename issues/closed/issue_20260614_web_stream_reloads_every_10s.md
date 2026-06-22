> **CLOSED 2026-06-23** — bulk-closed per resolved→close: fix committed + deployed; soak window elapsed with no recurrence noted. Folder location (closed/) is the authoritative lifecycle state; the in-body OBSERVING text below is the as-observed record. Reopen if recurrence appears.

# BR: Web frontend reloads the stream view every ~10s (content flashes black then restores, looping)

- **Date**: 2026-06-14
- **Component**: opencode web frontend (stream/message rendering), NOT the session backend
- **Severity**: high (makes the web UI unusable to watch — continuous flicker)
- **Status**: OBSERVING — merge-safe resync committed (`623737f09` fix(web): merge-safe session transcript resync, in HEAD) and deployed (frontend fingerprint-skip confirms deployed == HEAD-built; `mergeSnapshot` in `packages/app/src/context/active-poll.ts`, 11 tests pass). Root cause fixed: SSE/viewing-session resync had treated the bounded `/session/:id/message` tail as authoritative full transcript and **replaced** `store.message[sessionID]` — that replace was both the blank-then-restore vector and the scrollback-shrink. `forceReload()` now merges by message/part id, preserving local-only messages/parts outside the tail (initial hydration still replaces an empty session). **Scope honesty**: directly covers acceptance #6–8 (scrollback preservation, no compaction hard-floor) and very likely #1–5 (the destructive replace was the flicker source); the explicit multi-session partitioning criteria #9–11 are now made non-destructive (a cross-session resync can't shrink/clobber) but NOT proven as full per-sessionID isolation — that needs the live multi-session repro. Observing since 2026-06-15. **Exit → closed/**: the Update-3 repro (2–3 concurrent sessions, one idle while another streams) shows stable flicker-free panes, each retaining full independent scrollback over ≥60s. **Regress → open**: periodic ~10s blank/re-mount returns, or scrollback truncates to a tail after resync/concurrency.

## Symptom

In an active web session, roughly every ~10 seconds the **stream content area** reloads
on a loop:

- It is **not** a full-page refresh (URL bar, chrome, sidebar stay put).
- Only the **stream/message pane** is affected: its content goes **black** (blanks out)
  and then **restores**, over and over.
- The loop is roughly periodic (~10s interval), independent of whether the assistant is
  actively streaming or idle.

## Reproduction context

- Long-running session (this session: `ses_1403b1bc8ffepBLyfwuJi7Eu84`) with a large
  transcript (100+ tool calls, several compactions).
- Observed while the session was **idle between turns** as well as mid-work, so it is not
  tied to a specific tool call.
- A compaction occurred earlier in this same session (~05:02) and is the subject of a
  separate BR (`issue_20260614_compaction_anchor_rollback_replays_round.md`) — the two may
  share an upstream cause (re-render / re-hydration churn) but the symptoms are distinct:
  that one rolled the conversation anchor; this one is a periodic client re-render.

## Why this matters

- The flicker makes it impossible to read streamed output comfortably.
- A ~10s periodic blank-then-restore strongly suggests a **client-side re-mount / re-fetch
  loop** rather than a one-shot error — i.e. something is invalidating the stream
  component's state on a timer or on every SSE/poll tick.

## Suspected root-cause directions (for the runtime/frontend owner to confirm)

1. **SSE/stream subscription churn** — the stream component may be tearing down and
   re-establishing its event subscription on an interval (e.g. a heartbeat/keepalive tick
   being treated as a state change), causing a full re-render of the message list.
2. **Reactive key/identity instability** — if the stream list's render key (session id,
   message id, or a derived hash) changes on each poll, the framework unmounts + remounts
   the subtree → "black then restore". Look for a key derived from a timestamp or a freshly
   built array identity rather than a stable id.
3. **Polling vs. push double-path** — if both a periodic poll AND a push stream feed the
   same view, a ~10s poll could be clobbering the pushed DOM, blanking it until the next
   push rehydrates it.
4. **Compaction / re-hydration side effect** — given this session had a compaction, the
   client may be re-hydrating the transcript on a timer and the rebuild momentarily renders
   an empty stream before content repopulates.

## Suggested instrumentation (component-boundary checkpoints)

- Log every stream-component mount/unmount with a reason tag; confirm whether a ~10s timer
  or an SSE event triggers it.
- Log the render key/identity used for the message list each tick; assert it is **stable**
  across ticks when content has not changed.
- Network panel: confirm whether a request fires every ~10s against the stream/session
  endpoint, and whether its response replaces the whole list.
- Correlate the ~10s period with any configured heartbeat / keepalive / poll interval in
  the web client config.

## Acceptance criteria

1. The stream content pane does **not** blank/re-mount on a periodic timer when content is
   unchanged.
2. Stream updates apply **incrementally** (append/patch) without unmounting the existing
   rendered messages.
3. If a poll and a push path coexist, they reconcile without the poll blanking pushed
   content.
4. A reproduction (long session, idle between turns) shows a stable, flicker-free stream
   over at least 60s.

## Update — self-healed on next turn (2026-06-14)

- The looping flicker **stopped on its own** when the conversation advanced to the next turn
  (a new user message / assistant turn). No manual action (no refresh, no restart) was taken.
- This is a strong signal that the loop was tied to a **stale/transitional client state for
  the _current_ in-flight turn** — once a new turn arrived, the stream component re-keyed to a
  fresh, stable identity and the periodic re-mount stopped.
- Refines the suspected cause toward **(2) render-key/identity instability** and **(4) re-hydration
  side effect**: the blanking loop was bound to a particular pending/streaming message state, not
  a permanent global timer. The ~10s tick likely kept re-evaluating that unstable state until the
  turn boundary replaced it.
- **Severity downgraded** in practice: high annoyance while it lasts, but self-recovering at the
  next turn boundary rather than requiring a reload. Still worth fixing — a user who stays on one
  long-running turn would see continuous flicker.

### Sharpened acceptance criterion

5. The stream pane stays flicker-free **during a single in-flight turn** (i.e. before the next turn
   boundary), not only after a new turn re-keys the component.

## Update 2 — history truncated after self-heal (2026-06-14)

- After the flicker loop self-healed at the turn boundary, the recovery was **not lossless**: the
  user can **no longer scroll back to any conversation earlier than the BR-filing turn**. Everything
  before that point is gone from the **client transcript view** — only the messages from the
  BR-filing turn onward remain reachable.
- This strongly suggests the ~10s blank-then-restore loop and the eventual "heal" were the visible
  surface of a **client transcript re-hydration that rebuilt the message list from a truncated
  window** — i.e. the re-key that stopped the flicker also **replaced the full history with a partial
  tail**, rather than restoring the complete list.
- Important: this appears to be a **client-side view truncation, not data loss**. The server/session
  store (`ses_1403b1bc8ffepBLyfwuJi7Eu84`) and the on-disk transcript should still hold the full
  history; what's lost is the **rendered/scrollable window** in this web client. (This mirrors the
  earlier compaction BR's finding: disk artifacts survived; only conversation _visibility_
  regressed.)
- Cross-reference: `issue_20260614_compaction_anchor_rollback_replays_round.md` — both are
  conversation-state/visibility regressions in the same session. The pattern emerging across all
  three reports (anchor rollback → periodic flicker → history-tail truncation) is that the web
  client's **transcript windowing / re-hydration** mishandles long, compacted sessions: it rebuilds
  the visible list from a partial or shifted window instead of the authoritative full transcript.

### Suspected root-cause directions (windowing/re-hydration)

1. **Virtualized list anchored to a moving window** — if the message virtualizer keeps only a tail
   window and loses the "load earlier" boundary after a re-key, earlier messages become
   unreachable even though they exist server-side.
2. **Re-hydration fetches a bounded page** — the periodic re-hydration may request only the most
   recent N messages (or messages since the last compaction anchor) and replace the full list with
   that bounded page, dropping the scrollback above it.
3. **Compaction anchor as a hard floor** — if the client treats the latest compaction summary as the
   start of the renderable transcript, everything before the summary is hidden after re-hydration.

### Additional acceptance criteria

6. After any flicker/re-hydration event, the **full** scrollback remains reachable (lazy-load of
   earlier messages still works), not just the tail after the BR-filing/most-recent turn.
7. A compaction summary must **not** become a hard floor that hides pre-compaction messages from the
   client transcript view; earlier history stays loadable on scroll-up.
8. Client transcript windowing reconciles against the **authoritative server transcript** for the
   session, so a client-side re-render can never permanently shrink the visible history below what
   the server holds.

## Update 3 — likely trigger: multiple concurrent sessions open (2026-06-14)

- Reporter context: at the time of the symptom, **several sessions were open and being worked
  on concurrently** in the web frontend. Reporter's hypothesis: the frontend **does not robustly
  support multiple concurrent sessions**, and that concurrency is the trigger for both the ~10s
  flicker loop and the post-heal history truncation.
- This reframes the whole report from a single-session render bug to a **multi-session state
  isolation / cross-talk** problem. It is a much better fit for the observed evidence:
  - A periodic (~10s) re-render that is **not** tied to any tool call in _this_ session is
    consistent with **another session's** stream event / poll tick bleeding into this session's
    view and forcing a re-render.
  - The history-tail truncation (Update 2) fits a **shared/last-writer-wins client store** where
    a re-hydration triggered by session B rebuilds the transcript window using B's (or a merged)
    bounds, clobbering session A's full scrollback.
  - "Self-healed on next turn" (Update 1) fits the active session re-asserting its own identity
    on a new turn, momentarily winning the shared-state race back.

### Suspected root-cause directions (multi-session)

1. **Shared singleton client store keyed loosely** — if stream/transcript state lives in a
   module-level singleton (or a context not partitioned by sessionID), events from session B
   invalidate session A's rendered list. Look for stream subscriptions / caches that are NOT
   scoped by sessionID.
2. **One SSE/WebSocket connection multiplexed across sessions without routing** — if a single
   server-push connection feeds all open sessions and the client does not filter frames by
   sessionID before applying them, every session's tick re-renders every open view.
3. **Per-session polling that writes a global "current transcript"** — concurrent sessions each
   poll on ~10s and write into one shared "active transcript" slot; the last writer blanks the
   others until they poll again (explains both the periodic flicker and the windowing loss).
4. **Tab/visibility-driven re-fetch storm** — multiple tabs/panes each running a heartbeat can
   compound into a sub-10s effective re-render cadence on whichever view is focused.

### Suggested reproduction

- Open 2–3 sessions concurrently in the web frontend, keep them all active, and leave one idle
  while another streams. Watch whether the idle session's stream pane flickers on the other
  session's tick, and whether its scrollback later truncates.
- Single-session control: run the _same_ long/compacted session alone (no other sessions open)
  and confirm the flicker/truncation does **not** occur — this isolates concurrency as the cause.

### Additional acceptance criteria

9. Stream/transcript client state is **partitioned by sessionID**: events or polls for session B
   never re-render or re-hydrate session A's view.
10. With N sessions open concurrently, each session's stream pane is stable and each retains its
    own full scrollback independently; no cross-session blanking or history clobber.
11. A single shared push connection (if used) routes frames to the correct session's view by
    sessionID before applying any DOM update.

## Notes

- Filed under opencode local-first `issues/` per repo convention (component is the opencode
  web frontend, not docxmcp).
- Reporter could not see the frontend source from this session; root cause is hypothesized
  from the observed symptom (periodic black-then-restore of the stream pane only).

## Fix — merge-safe resync (2026-06-14)

- Confirmed the global architecture issue: SSE/viewing-session resync treated the bounded
  `/session/:id/message` tail snapshot as an authoritative full transcript and replaced
  `store.message[sessionID]`, which could shrink scrollback after a reconnect/resync.
- Updated `sync.session.forceReload()` to use merge mode. Initial hydration still replaces an
  empty/unhydrated session with the bounded tail, but resync now merges by message/part id and
  preserves local-only messages/parts outside the tail.
- Added regression coverage in `packages/app/src/context/active-poll.test.ts` proving a tail
  snapshot does not shrink an already loaded transcript and preserves local-only parts.
- Architecture sync: `specs/architecture.md` now records the invariant that the tail/cursor API is
  not a full-transcript authority and resync must be merge-safe.
- Validation: `bun test packages/app/src/context/active-poll.test.ts` → 11 pass / 0 fail.
