# Proposal: session/rebind-procedure-revision

## Why

The "rebind procedure" was originally introduced for **session continuation across chain-identity-breaking events** — keep the conversation working when an account is switched, when rotation fires, when daemon restarts, when capability layer reloads. The current implementation, however, does only one half of that job: it severs the chain (`invalidateContinuationFamily`) and bumps a session epoch, but does not tell the AI what just happened or what it can rely on. The AI receives a prompt that structurally looks identical to a mid-session continuation turn (round-N) but in which (a) the server-side reasoning trace is gone, (b) any commitments the AI made before the break are now invisible to its new reasoning chain, and (c) no marker distinguishes this turn from a normal continuation.

Live evidence (session `ses_1e56ed3f9ffebv4AaWOlcPLz20`, 2026-05-12):

- `session.rebind` fired at 15:52
- Round 241 (post-rebind): cache 151k → 27k (chain rebuilt; base prompt cache survived; conversation reasoning state irrecoverable)
- Rounds 241–277 (next 23 minutes): 11 consecutive `read` calls against the same file, no writes — yet `apply_patch` had ALREADY succeeded 3× before the rebind
- Layer C paralysis nudge fired 4 times; model emitted compliance text ("我改成檢查...") and immediately re-issued the same `read` — placation theatre, because the new chain has no memory that anything was already done
- Round 279: `inputTokens=348215` (full transcript inlined; exceeds the 240k usable budget) — emergency fallback that itself constitutes a second failure mode

This plan does NOT attempt to recover the lost server-side reasoning trace (structurally impossible). It addresses the signalling and re-initialization layers — what events count as chain-identity changes, what gets recomputed in each case, what notice the AI gets, and how recovery affordances (recall / TOOL_INDEX) integrate.

## Original Requirement Wording (Baseline)

- "我們當初設計'rebind'這個功能的目的不就是為了session continuation嗎？你可以啟動一個plan，叫做revising rebind procedure，把所有continuation的情況都納入處理範圍。並且檢視一下既有的rebind做了什麼？怎麼缺東缺西的"
- (Reply turn) "Rebind要情境你要考慮得很完整。包含：不同provider的行為不同、不同情境的continuation處理需求不同。排列組合起來是很複雜的。"

## Requirement Revision History

- 2026-05-12 (initial draft): scope captured from live RCA conversation against session `ses_1e56ed3f9ffebv4AaWOlcPLz20`
- 2026-05-12 (revision 1): user pushed back that scope was too narrow; rewrote with explicit provider × event matrix as load-bearing deliverable

## Effective Requirement Description

### R1 — Naming clarification (audit finding)

Distinguish three concepts that current code conflates under the verb "rebind":

- **session.rebind event** = generic session-epoch bump signal. Emitted by `RebindEpoch.bumpEpoch` with a `trigger` field (`provider_switch`, `session_resume`, capability refresh, etc.). This is a notification mechanism, not a cause.
- **Chain reset** = codex-specific action of dropping `lastResponseId` via `invalidateContinuationFamily`. No-op for non-codex providers.
- **Continuation procedure** = the whole protocol that should run when a chain-identity-breaking event occurs: capture commitment digest, invalidate chain id, mark next outbound for chain-init injection, recompute chain-stable fragments, emit telemetry.

Currently the codebase has parts (1) and (2) implemented and tested. Part (3) is the missing piece this plan fills.

### R2 — Enumerate the continuation event surface

Produce an exhaustive catalogue of every event in opencode that affects continuation. From the audit, at least:

| Code | Event | Current location |
|---|---|---|
| E1a | Account switch same provider (admin panel) | `prompt.ts:1188-1217` (pre-loop) + `prompt.ts:454-466` (in-loop) |
| E1b | Account auto-rotation (quota / 429) | inherits E1a path via rotation orchestrator |
| E2a | Provider switch (codex → anthropic, etc.) | `prompt.ts:454-456` returns `"provider-switched"` → compaction |
| E2b | Model switch same provider, same family (gpt-5.5 ↔ gpt-5.4) | currently treated like account switch? — audit pending |
| E2c | Model switch cross-family (gpt-5 → o4-mini) | audit pending |
| E3 | Session fork | `cli/cmd/run.ts:472` + `server/routes/session.ts:1489` |
| E4a | Session resume (UI re-attach, daemon still alive) | `server/routes/session.ts:751` — bumps rebind epoch, silent CapabilityLayer.reinject |
| E4b | Session resume after daemon restart | `prompt.ts:2030-2055` — pre-emptive compaction trigger |
| E5 | Capability layer refresh (tools/AGENTS.md reload) | `tool/refresh-capability-layer.ts:66` — emits session.rebind |
| E6 | Narrative compaction | `compaction.ts:189` — calls invalidateContinuationFamily |
| E7a | Cache-aware compaction | same path as E6 |
| E7b | Stall-recovery compaction | same path as E6 |
| E7c | Pre-emptive compaction (daemon-restart-triggered) | `prompt.ts:2050-2053` |
| E7d | Server-side compaction (`low-cost-server`, codex `/responses/compact`) | preserved chain; existing L3 amnesia skip rule |
| E8 | Empty-response recovery | `prompt.ts:1448-1457` — invalidateContinuationFamily |
| E9 | WebSocket transport reconnect | audit pending; suspected not-a-break |
| E10 | Subagent spawn | separate session, separate chain — not-a-break for parent |
| E11 | User `/clear` or new-session command | audit pending |
| E12 | Rotation-induced chain reset on backend failure (ws_truncation, server_failed) | `prompt.ts:1301` — "forces a full re-send" |

This list is approximate; the spec MUST land with the exhaustive list as derived from the audit and validated against a code scan.

### R3 — Provider chain-semantics taxonomy

For each provider in the registry, classify chain semantics:

| Class | Providers | Chain id | Recovery model |
|---|---|---|---|
| SS (stateful) | codex, copilot (in stateful mode) | server-side `previous_response_id` | server reasoning trace lost on break |
| SL (stateless) | anthropic, gemini, groq, cerebras, openrouter (mostly), copilot (in stateless mode) | none | full context resent every request; "chain break" is meaningless |
| Hybrid | copilot (mode-switchable) | conditional | depends on which mode is active |

Audit deliverable: for every provider package under `packages/opencode/src/provider/`, mark its class in a single registry (e.g. `provider/chain-semantics.ts`) so the continuation procedure can dispatch correctly.

### R4 — Event × provider matrix (load-bearing deliverable)

The full matrix has cells for every (event, provider-class) pair. Each cell answers:

- **Chain break?** yes / no / n-a
- **Capture commitment digest?** yes / no
- **Recompute chain-stable fragments?** yes / no
- **Emit chain-init notice on next outbound?** yes / no
- **What body does the notice carry?** chain-reset framing / compaction framing / both / neither

Provisional table (must be validated and corrected per cell during designed-state work):

| Event | SS provider behaviour | SL provider behaviour |
|---|---|---|
| E1a account switch | break + digest + chain-init notice | n/a — no chain to break; refresh capability layer only |
| E1b account auto-rotate | same as E1a | same as E1a |
| E2a provider switch | break (leaving SS) + compaction + chain-init notice | if entering SS: first call style, no notice needed; if SL→SL: stateless replay continues |
| E2b model switch same family | gray area: previous_response_id may or may not work cross-model. Default: treat as break, fire init. | n/a |
| E2c model switch cross-family | always break + chain-init notice | n/a |
| E3 session fork | child = fresh chain (no init needed — there's no prior chain to mourn); parent unaffected | child = fresh stateless context; same |
| E4a session resume (daemon alive) | no break — chain id still in memory; capability refresh only | no break; capability refresh only |
| E4b session resume after daemon restart | break (lastResponseId wiped) + chain-init notice + pre-emptive compaction if heavy | no break (stateless); pre-emptive compaction if heavy |
| E5 capability layer refresh | no chain break — tools/AGENTS.md fragment changes only; mark for capability-changed notice (separate from chain-init) | same |
| E6 / E7a-c narrative-class compaction | break + L3 amnesia-notice (existing) — extend with commitment digest | break message-history only (stateless has no chain id); L3 amnesia-notice still applies |
| E7d server-side compaction | no client-visible break — skip notice (existing rule) | n/a |
| E8 empty-response recovery | break + chain-init notice (or revise policy to chain-preserving retry) | rare; if retry, no break |
| E9 WS reconnect | no break — chain id outlives socket | no chain; no-op |
| E10 subagent spawn | child fresh; parent unaffected; no init at parent | same |
| E11 user /clear | user-aware reset — suppress chain-init (don't second-guess user intent) | same |
| E12 backend-failure forced re-send | currently treated like account switch (chain reset + full re-send) — should fire chain-init notice | n/a |

### R5 — Chain-init notice fragment

A new context fragment `chain_init_notice` (sibling of `amnesia_notice`), or a unified `continuation_notice` that subsumes both. Design choice (subsume vs sibling) is part of designed-state work.

Fragment composition by signal:

| Signal | Body contribution |
|---|---|
| Reasoning trace lost (SS + chain break) | "Your internal reasoning chain (server-side CoT) was just reset. Don't assume 'I must have just thought X' — you didn't, on this chain." |
| Message history summarized (compaction kind) | existing L3 body: "Pre-anchor tool outputs are NOT in this prompt; recall() to retrieve" |
| Mutation actions before the break | "Recent committed actions (you DID these, don't redo): [commitment digest]" |
| TOOL_INDEX available | "Look for ## TOOL_INDEX section in the anchor body" |

Triggered once per break (policy `once_after_chain_break`); next outbound after consumption clears the marker.

### R6 — Commitment digest data model

Capture **before** chain invalidation (otherwise post-break we may not have a stable view):

- Last N (default 5) tool calls of kind ∈ {`apply_patch`, `edit`, `write`, `bash`-with-write-effect, `move_file`, `delete_file`, … — classification list TBD}
- Each row: `(call_id, tool, args_brief, status, output_summary, completed_at)`
- Truncation: total digest ≤ 1000 chars; args_brief ≤ 80 chars/row; output_summary ≤ 60 chars/row
- Scrubbing: same rules as TOOL_INDEX (no secrets, no full URLs with tokens)
- Persisted on the message that emits the break (so subsequent re-injection or fallback paths can re-render)

### R7 — `session_stable` policy split

Current `session_stable` cache policy conflates two invariants:
- "stable across the whole conversation" (system block — independent of chain identity)
- "stable across the chain" (bundle_user — should recompute on chain reset)

Split into:
- `conversation_stable` — recomputed only at session creation; survives all chain breaks
- `chain_stable` — recomputed on every chain-identity reset (rebind / rotate / cross-provider / fork / daemon-restart)

Migrate every existing `session_stable` consumer explicitly (no silent default — per AGENTS.md zone contract rule 1, ambiguous classifications raise an error). Default is `conversation_stable` only if the fragment has been explicitly audited; otherwise must be annotated.

### R8 — Integration with existing recall affordance

`compaction/recall-affordance` (graduated 2026-05-11 in opencode-beta) provides L1 (TOOL_INDEX in anchor) + L2 (recall tool, always-present) + L3 (amnesia-notice fragment). This plan **does not duplicate** that machinery — it widens L3's trigger taxonomy to include non-compaction chain breaks and adds commitment digest to its body. L1 and L2 stay unchanged.

### R9 — Empty-response recovery review

Currently empty-response recovery unconditionally calls `invalidateContinuationFamily` (`prompt.ts:1450-1452`). Per memory [project_runtime_selfheal_layers_2026_05_08.md] this is the "斷尾求生" pattern. Two options:

- **Status quo + chain-init**: keep the invalidation, fire chain-init notice with reason `"empty_response_recovery"`. AI gets to know the chain was reset and continues with awareness.
- **Chain-preserving retry**: try one or two retries on the same chain with adjusted parameters before invalidating. Reduces chain churn but adds latency.

Decide during designed-state work. Provisional default: option (1), with option (2) as a follow-up if telemetry shows excessive chain churn.

### R10 — Daemon-restart audit deliverable

Reverse my earlier decision (recorded in conversation): per `prompt.ts:2040` comment, daemon restart DOES wipe `lastResponseId` and IS a chain break. Therefore:

- Daemon restart is in scope (event E4b)
- Pre-emptive compaction at restart (already implemented) handles the token-budget half; chain-init notice handles the AI-notification half
- No separate `session/lastResponseId-persistence` plan needed unless audit shows persistence is also broken in non-restart scenarios

### R11 — Telemetry

New event types:
- `chain.init.injected` — chain-init notice was added to outbound prompt; payload includes `reason`, `digestEntryCount`, `bodyCharCount`
- `chain.init.skipped` — notice was eligible but suppressed (e.g. user /clear); payload includes `reason`
- `chain.commitment.captured` — commitment digest captured at break; payload includes `digestSourceCount`, `digestEntryCount`

Existing event payloads to extend:
- `session.rebind` — add `chainBreakClass: "SS-break" | "SL-noop" | "capability-only" | "user-intent"`

## Scope

### IN
- Audit deliverable: the complete (event, provider-class) matrix per R4, validated against code
- Provider chain-semantics registry (R3) — single source of truth for SS / SL / Hybrid classification
- `chain_init_notice` (or `continuation_notice`) fragment design + once-after-break policy
- Commitment digest data model + rendering helper, shared with L3 amnesia-notice
- `session_stable` → `conversation_stable` / `chain_stable` policy split, with explicit migration of every consumer
- Trigger taxonomy expansion (`decideAmnesiaInjection` → `decideContinuationInjection`)
- Empty-response recovery policy review (R9)
- Telemetry surface (R11)
- Test matrix: at least one test per (event, provider-class) cell in R4

### OUT
- Recovering server-side reasoning trace (impossible)
- New paralysis layer (Layer D / tool mask) — defer; expect demand to drop when init protocol is correct
- Subagent prompt overhaul (already partially handled by dedicated subagent prompt machinery)
- Capability-changed notice (E5 produces a different signal; mention in design but defer to its own plan)
- Cross-provider reasoning-item translation (codex reasoning items → anthropic; defer to dedicated plan if needed)

### Non-goals
- "One protocol fits all" — explicit acceptance that some cells in R4 are n/a or no-op
- Restoring previous_response_id chain across account boundaries (server-side restriction)
- Heuristic "we think the AI is confused" auto-injection — chain-init fires only on definite chain-break events

## Constraints

- Existing `compaction/recall-affordance` test suite (38 tests) must continue to pass
- `invalidateContinuationFamily` semantics MUST stay no-op for non-codex providers (already correct)
- Cache-key fingerprint of `chain_stable` fragments must change on chain reset (otherwise the prompt re-uses old fingerprint and the cue is silently dropped)
- Commitment digest must scrub secrets per same rules as TOOL_INDEX
- Must not change codex Responses API request contract
- Plan must remain non-breaking for in-flight sessions (migration path for `session_stable` consumers)

## What Changes

- New: `packages/opencode/src/provider/chain-semantics.ts` — per-provider chain class registry (R3)
- New: `packages/opencode/src/session/continuation/` directory
  - `continuation-event.ts` — typed enum + classification helpers covering R4 matrix
  - `chain-init-notice.ts` (or `continuation-notice.ts`) — fragment + decideInjection helper
  - `commitment-digest.ts` — capture + render helper
- Modified: `packages/opencode/src/session/context-fragments/amnesia-notice.ts` — body extended with digest, decision helper unified
- Modified: `packages/opencode/src/session/context-fragments/index.ts` — policy split
- Modified: `packages/opencode/src/session/prompt.ts` — all 5 `invalidateContinuationFamily` call sites plus the rebind epoch sites mark next-outbound for chain-init
- Modified: `packages/opencode/src/session/compaction.ts` — same
- Modified: `packages/opencode/src/session/rebind-epoch.ts` — payload extension
- New: ~30+ tests covering the R4 matrix cells

## Capabilities

### New Capabilities
- **Continuation event classification**: every chain-affecting event is typed and dispatched
- **Provider chain-semantics registry**: SS / SL / Hybrid known at registration time
- **Chain-init notice**: one-shot AI notification on every must-break event
- **Commitment digest**: structured "you did this" cue carried across the break

### Modified Capabilities
- **rebind / rotate / cross-provider / fork / daemon-resume / empty-recovery**: now each fires chain-init-notice on next outbound (previously silent)
- **L3 amnesia-notice (compaction)**: body extended with commitment digest; trigger logic generalised
- **`session_stable` policy consumers**: each reclassified as `conversation_stable` or `chain_stable`

## Impact

- **Code**: provider/ (new registry), session/continuation/ (new directory), session/context-fragments/ (extend), session/prompt.ts (touch 5+ sites), session/compaction.ts (touch 2 sites), session/rebind-epoch.ts (extend payload)
- **Tests**: ~30+ new tests covering R4 matrix cells; regression vs existing 38 recall-affordance tests
- **Telemetry**: 3 new event types, 1 payload extension
- **Sibling specs**:
  - `compaction/recall-affordance` (graduated 2026-05-11) — extend L3 body, do not duplicate
  - `compaction/narrative-compaction-quality` (proposed) — narrative quality affects digest reliability; coordinate
  - Potential follow-up: `compaction/empty-response-chain-preserving-retry` (R9 option 2)
  - Potential follow-up: `session/capability-changed-notice` (E5)
- **User-visible**: AI no longer跳針 after rebind / rotate / daemon restart; rebind round counts normalise; modest cache-miss bump on chain reset is acceptable

## Open Questions (for designed-state resolution)

- Q1: Subsume L3 amnesia-notice into a unified `continuation_notice`, or keep as sibling with shared helpers? Trade-off: unification simplifies the trigger logic but couples two concerns; siblings are cleaner but more code paths.
- Q2: Should commitment digest include READ-class tools (curl, grep) when those reads were the basis of a subsequent mutation? Probably no — only the mutation matters — but verify against user request scenarios.
- Q3: For provider switch (E2a) the leaving-SS half emits commitment digest, but the arriving SS / SL provider has no concept of the chain-init notice format. Does it matter? Probably no — the notice is a user-role text fragment, format-agnostic.
- Q4: E2b/E2c (model switch within provider) — does codex actually accept a `previous_response_id` from a different model id? If yes, same-family model switch can be no-break.
- Q5: E12 (backend-failure forced re-send) — already calls invalidateContinuationFamily under some conditions? Audit needed.
- Q6: How does this interact with the "stateless reasoning replay" mode in copilot (`statelessReasoningIndex`)? Is that a third class beyond SS / SL?
