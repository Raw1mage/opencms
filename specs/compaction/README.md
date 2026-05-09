# compaction

> Wiki entry. Source of truth = current code under
> `packages/opencode/src/session/`. Replaces the legacy spec packages
> `compaction-redesign`, `compaction-improvements`,
> `prompt-cache-and-compaction-hardening`, and `tool-output-chunking`
> (archived under `specs/_archive/`).

## Status

shipped (live as of 2026-05-04).

`compaction-redesign` and `compaction-improvements` reached `verified`
and were merged into the main runloop. `prompt-cache-and-compaction-hardening`
is `living` with prompt-cache hardening + idle gate + L9 skill snapshot
all in production. `tool-output-chunking` partially shipped: the
`Memory.Hybrid` namespace (anchor / journal / pinned_zone) and bounded
`LLM_compact` machinery are wired; the AI-facing primitives (voluntary
`summarize`, explicit `pin/drop/recall` from the model) are present in
the type surface but the runloop does not yet actively dispatch on them.
See **Notes** below.

## Current behavior

### Single entry point, state-driven evaluation

`SessionCompaction.run({sessionID, observed, step})` is the only path
that compacts a session. The runloop derives `observed` from current
session state on every iteration — never from a flag set by a previous
iteration. Six observed values exist: `overflow`, `cache-aware`,
`rebind`, `continuation-invalidated`, `provider-switched`, `manual`,
plus `idle` for the proactive idle-pressure path.

`continuation-invalidated` is state-driven via
`session.execution.continuationInvalidatedAt: number` written by the
codex Bus listener; the runloop's `deriveObservedCondition` returns
that observed value when the timestamp is newer than the most recent
`Anchor`'s `time.created`. There is no module-level in-memory flag.

### Cost-monotonic kind chain

`SessionCompaction.kindChainFor(observed)` returns an ordered list of
kinds. `resolveKindChain` walks the chain and picks the first that
succeeds. The four kinds are `narrative`, `replay-tail`,
`low-cost-server`, `llm-agent`; cost is monotonic in that order.

Per-`observed` chain rules:

- `rebind` / `continuation-invalidated` / `provider-switched` — only
  free kinds (`narrative`, `replay-tail`). Paid kinds are rejected;
  if no free kind succeeds the call returns `"stop"` with `log.warn`.
- `manual` — `narrative` → `low-cost-server` → `llm-agent`. Schema/
  replay-tail are skipped (they would defeat user intent).
- `manual --rich` — straight to `llm-agent`.
- `overflow` / `cache-aware` / `idle` — full chain available.

`provider-switched` further forbids `replay-tail` (raw tail carries
provider-specific tool-call format) and `low-cost-server` (codex/OpenAI
format unreadable to other providers).

### Memory backed by TurnSummary, captured at runloop exit

`Memory` (`session/memory.ts`) holds the narrative narrative content
used by the `narrative` kind. `TurnSummary` entries are appended at the
runloop's exit site (`prompt.ts`) when `lastAssistant.finish` is a
non-`tool-calls` value, durably before the runloop returns. Mid-run
crash recovery uses raw tail, not partial summaries.

Two render functions:

- `renderForLLM(sid)` — compact, provider-agnostic text consumed by the
  next LLM call.
- `renderForHuman(sid)` — timeline-formatted text for UI / debug.

### Anchors are sanitized and don't shadow L7

When a `narrative` or `llm-agent` kind writes its anchor, the body is
wrapped in `<prior_context source="...">…</prior_context>` and
imperative-leading lines are rewritten to declarative form
(`anchor-sanitizer.ts`). The anchor message has `summary === true`. L9
skill snapshot is recorded in anchor metadata for replay.

### Idle compaction defers on unclean tail

`idle-compaction-gate.ts` checks the conversation tail for unmatched
`tool_use` parts. If the last assistant message has dangling tool
calls, `idleCompaction` returns early with telemetry
`compaction.idle.deferred reason=unclean-tail`. No anchor is written.

### Cache-aware compaction is gated by miss-kind diagnosis

`cache-miss-diagnostic.ts` distinguishes `system-prefix-churn` (e.g.
mid-session AGENTS.md edit) from `conversation-growth`.
`shouldCacheAwareCompact` returns `false` when the cause is system
prefix churn — compacting the conversation would not help.

### Static system block + user-role context preface

`static-system-builder.ts` assembles a single static `system[]` message
from L1/L2/L3c/L5/L6/L7/L8 content only. Dynamic content (cwd listing,
README summary, pinned skills, today's date, active/summarized skills,
matched routing) is emitted as a separate user-role context preface
ranked slow-first. Cross-turn cache-key stability for the static block
is enforced; consecutive turns with the same
`(model, agent, account, AGENTS.md, SYSTEM.md, user-system, role)`
tuple produce a byte-equal block.

Anthropic ephemeral cache breakpoints land at four positions (`BP1` end
of static system block, `BP2` end of T1 segment in preface, `BP3` end
of T2 segment, `BP4` end of final non-system message). Empty tiers are
omitted, not relocated.

### Plugin hooks split

- `experimental.chat.system.transform` — receives only the static
  block. Legacy dynamic injection is honoured for one release with a
  deprecation `WARN`.
- `experimental.chat.context.transform` — receives the structured
  `ContextPrefaceParts` for dynamic content.

### Hybrid namespace (tool-output-chunking, Phase 1/2)

`Memory.Hybrid` exposes `Anchor`, `JournalEntry`, `PinnedZoneEntry`,
`ContextStatus`, `LLMCompactRequest`, `CompactionEvent` and the
`getAnchorMessage` / `getJournalMessages` / `getPinnedToolMessages` /
`recallMessage` helpers. The recursive bounded compaction formula —
`LLM_compact(prior_anchor, journal_unpinned)` — is wired with
`single-pass` and `chunk-and-merge` internal modes. Phase 2 absorption
is implemented (pinned_zone collapsed into anchor with
`framing.strict = true` when Phase 1 still overflows).

### Subagent path

`deriveObservedCondition` does **not** unconditionally skip subagent
sessions (`session.parentID` set). Subagents trigger `rebind`,
`continuation-invalidated`, `provider-switched`, `overflow`,
`cache-aware` identically to parents. Compaction writes to the
subagent's own message stream. Subagents do not trigger `manual` (no
UI surface).

### No synthetic Continue on rebind

`SessionCompaction.run` does **not** inject `"Continue if you have
next steps..."` when `observed ∈ {rebind, continuation-invalidated,
provider-switched}`. The 2026-04-27 infinite-loop bug is
structurally unrepresentable in the new entry point. Synthetic
Continue still fires for `overflow` / `cache-aware` / `idle`.

## Code anchors

Core:
- `packages/opencode/src/session/compaction.ts` — `SessionCompaction`
  namespace (3218 lines). `run` at L1632, `process` (deprecated shim)
  at L428, `kindChainFor` at L795, `Cooldown` at L867, `Hybrid`
  sub-namespace at L2006.
- `packages/opencode/src/session/memory.ts` — `Memory` namespace
  including `TurnSummary`, `renderForLLM` (L230), `renderForHuman`
  (L295), `Hybrid.getAnchorMessage` (L391), `recallMessage` (L498).
- `packages/opencode/src/session/idle-compaction-gate.ts` — unclean
  tail defer logic.
- `packages/opencode/src/session/cache-miss-diagnostic.ts` — miss-kind
  classification.
- `packages/opencode/src/session/anchor-sanitizer.ts` — XML wrap +
  imperative strip.
- `packages/opencode/src/session/static-system-builder.ts` — static
  block assembly + preface emission.
- `packages/opencode/src/session/post-compaction.ts` — post-write
  bookkeeping (skill pin, cooldown record).
- `packages/opencode/src/provider/codex-compaction.ts` — codex
  `/responses/compact` low-cost-server integration.
- `packages/opencode/src/provider/transform.ts` — `applyCaching` BP1–BP4
  placement.

State + bus:
- `packages/opencode/src/session/index.ts` — session schema field
  `execution.continuationInvalidatedAt` (L259); codex Bus listener
  writes timestamp at L747.
- `packages/opencode/src/session/prompt.ts` — runloop entry point;
  `deriveObservedCondition` and TurnSummary capture site
  (`exiting loop`).
- `packages/opencode/src/session/capability-layer.ts` — `RebindEpoch`
  and cross-account reinject error path.

Routes:
- `packages/opencode/src/server/routes/session.ts` — manual `/compact`
  endpoint routes through `run({observed: "manual"})`.

Tests (representative):
- `compaction.test.ts`, `compaction-run.test.ts`,
  `compaction-telemetry.test.ts`, `compaction.regression-2026-04-27.test.ts`,
  `compaction.phase-a-wiring.test.ts`, `idle-compaction-gate.test.ts`,
  `anchor-sanitizer.test.ts`, `prompt.observed-condition.test.ts`,
  `prompt.turn-summary-capture.test.ts`, `memory.test.ts`,
  `message-v2.compaction-skill-snapshot.test.ts`.

## Notes

### Deprecation surface (frozen as of phase-9 realignment 2026-04-27)

Live deprecation shims (delete in a later phase):

- `SessionCompaction.process` → delegates to `run({observed: input.auto ? "overflow" : "manual"})`.
- `SessionCompaction.recordCompaction` → delegates to `Memory.markCompacted`.

Kept as internal helpers (NOT deprecated):

- `SessionCompaction.compactWithSharedContext` — anchor-write path used by `_writeAnchor` and pre-loop identity-switch compaction.
- `SharedContext.snapshot` — the schema kind reads it.
- `saveRebindCheckpoint` / `loadRebindCheckpoint` — disk-backed rebind recovery; `lastMessageId` is optional (DD-8).
- `getCooldownState` — cooldown read path used by `isOverflow` /
  `shouldCacheAwareCompact`.

Removed entirely (no shim):

- `markRebindCompaction` / `consumeRebindCompaction` — flag plumbing
  replaced by `session.execution.continuationInvalidatedAt`.

### Open / partial work

`tool-output-chunking` AI-facing primitives (Layer 3/4/5) — voluntary
`summarize`, explicit `pin(T)` / `drop(T)` / `recall(msg_id)` from the
model — exist as types in `Memory.Hybrid` but the runloop does not yet
treat model-emitted directives as triggers. The `recall` execution
path (`Memory.Hybrid.recallMessage`) is wired but only callable from
internal code, not the AI's tool surface. R-1 per-tool output
self-bounding is enforced in `tool/edit.ts`, `tool/task.ts`,
`tool/attachment.ts` for the variable-size tools listed in the spec;
universal coverage of every variable-size tool requires audit.

### Persistence

`Memory` writes to `session_memory/<sid>` in Storage. Reads check that
path first; on miss, fall through to legacy `shared_context/<sid>` and
`Global.Path.state/rebind-checkpoint-<sid>.json`. Legacy reads are
projected into the new shape and rewritten on first touch.

## Sub-packages

- [working-cache/](./working-cache/) — Working Cache L1 (digest) +
  L2 (raw ledger) MVP shipped 2026-05-07. `WorkingCache.record()` /
  `WorkingCache.selectValid()`, `system-manager:recall_toolcall_*`
  tool family, exploration-depth postscript, and `cache-digest`
  fenced-block parser. §5 (architecture sync) and §6 (deferred
  subagent / memory-graph promotion) still open.
- [itemcount-fix/](./itemcount-fix/) (living, merged 2026-05-09)
  — gpt-5.5 itemCount truncation hardening. Three runloop-level
  triggers gated on item count, anchor-prefix-expand Phase 2 over
  `CompactionPart.metadata.serverCompactedItems`.
- [empty-turn-recovery/](./empty-turn-recovery/) (implementing,
  PAUSED) — empty-turn self-heal compaction with storm-prevention
  gate (`evaluateEmptyResponseGate`, `emptyResponseFloor`).
  Symptom site is codex provider; gate logic lives in compaction.
  Awaiting JSONL evidence accumulation before resume.
- [empty-response-rca/](./empty-response-rca/) (implementing) —
  empty-response RCA + itemCount addendum 2026-05-09. Cross-cuts
  with `provider/codex/` and `compaction/itemcount-fix/`.
- [user-msg-replay-unification/](./user-msg-replay-unification/)
  (living, merged 2026-05-09 commit c889625a8) — unified the
  "user message replay after anchor" logic across all four
  compaction call sites. 5/5 hotfix was scoped to one site
  (`empty-response`); the rebind pre-emptive path recurrence on
  2026-05-09 confirmed three sibling sites shared the bug. Helper
  `SessionCompaction.replayUnansweredUserMessage` extracted to
  module level; defaultWriteAnchor + tryLlmAgent + provider-switch
  pre-loop all wired. INJECT_CONTINUE table replaced by stream-
  driven runtime gate. 34 dedicated tests + 75/75 in-scope
  compaction suite.
- [dialog-replay-redaction/](./dialog-replay-redaction/) (verified,
  2026-05-10; renamed from `narrative-quality` after design pivot)
  — restoration of two-tier compaction model: extend (anchor[n+1]
  = anchor[n] + redact(tail)) on every commit + recompress (codex
  /responses/compact or llm-agent) when anchor exceeds 50K tokens.
  Tracks 4 patches against existing infrastructure (tryNarrative
  body source, scheduleHybridEnrichment threshold/routing, post-
  anchor-transform v6→v7, lastTextPartText reasoning-blind fix).
  v1-v6 evolution misdirected the design; this is a refit.

### Related entries

- [session/](../session/README.md) — runloop, identity, capability layer.
- [provider/](../provider/README.md) — top-level provider abstraction.
- [provider/codex/](../provider/codex/README.md) — codex server-side
  compaction integration (`/responses/compact`); `ws-snapshot-hotfix/`
  sub-package interacts with the empty-turn recovery path.
- [provider/claude/](../provider/claude/README.md) — anthropic cache
  breakpoints; takeover anchor consumer of `MessageV2.filterCompacted`.
- [attachments/](../attachments/README.md) — big-content boundary
  handling (R6 in the old `compaction-improvements` spec is implemented
  in the attachment subsystem).
