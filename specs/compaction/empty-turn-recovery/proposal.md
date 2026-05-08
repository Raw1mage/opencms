# Proposal: codex-empty-turn-recovery

## Why

A reproducible failure mode in the codex provider produces what users see as "AI 在跳針" — the assistant emits an empty turn (no text, no tool calls, no usage), our runloop fires an automatic `?` nudge (per `project_account_switch_compaction_inloop.md`), and from there the conversation enters a degenerate equilibrium of repeating the same 3–4 read-only tool calls indefinitely.

A live example is captured in session `ses_204499eecffe2iUTzeXyiarlnq` (data archived in `~/.local/share/opencode/storage/session/ses_204499eecffe2iUTzeXyiarlnq.db`). Across the stuck region:

- ~17 consecutive assistant turns repeat the same `read architecture.md @ 55 + read event_20260429 @ 660 + read grafcet_renderer.py @ 2510 + grep gate-adjacent` pattern
- Same self-text "我會把錯誤的 L5 stub 對齊邏輯收掉…" emitted every turn
- Codex itself acknowledges the loop ("我剛剛跳針了") and immediately resumes the same actions
- `tokens_reasoning = 0` for the entire stuck region; earlier turns in same session had reasoning > 0
- `tokens_cache_read` is exactly `37888` for many consecutive turns (same prefix replayed verbatim)
- `input + cache_read ≈ 40K` per turn (some upstream layer is clamping prompt size)
- Zero edits / writes / bash during the stuck region

The trigger is a single empty turn at `msg_dfe39162f` (`finish=unknown`, all-zero tokens, 1 second after user posted an image+complaint). The runloop responded with a synthetic `?` nudge that, against the already-degraded state, established the loop.

External research has clarified that "empty Codex response" is **a symptom with multiple independent causes** on `chatgpt.com/backend-api/codex/responses`:

- OpenHands `software-agent-sdk#2797` enumerates three independent bugs (param rejection, server-side empty `output` triggered by specific params, client-side reassembly that ignores deltas), each producing the same user-visible symptom.
- hermes-agent `#5736` documents a fourth: `store: false` causes `response.completed.output: []` even when deltas streamed correctly.
- Multiple community.openai.com / CLIProxyAPI threads document additional "stream disconnected before completion" reports.

Our prior debugging anchored on a single cause (WS truncation) and missed that the same symptom can arrive via several different upstream paths. This spec corrects that scope.

## Original Requirement Wording (Baseline)

- "看一下codex的行為，我覺得很反常。表面上看起來很忙，實際上好像是原地跳針"
- "是否因為我們放了一個 \"?\" 語意不清，所以也無法預測 AI 收到這個 \"?\" 後會有什麼行為？而這次碰巧是使 AI 進入了一個跳針循環？"
- "我猜，前面的帳號錯位事件可能早就搞亂了 context。後面會發生什麼沒人知道"
- "照你的建議，去看一下 github 上的人的情形是不是存在"
- "查 codex provider 的程式 — 翻完應該能直接判定『我們是不是同一條』，再決定要不要先打 patch（accumulate deltas 當 fallback）而不是繼續優化 nudge 文字。"
- "建立 fix plan，把分析詳細記錄。"
- "empty response 應該是結果，但原因可能很多。" *(2026-05-06 — scope-defining instruction; spec must enumerate the cause family, not pin to one cause)*

## Requirement Revision History

- 2026-05-06: initial draft created via plan-init.ts (slug `codex-ws-premature-close`)
- 2026-05-06: scope widened from "WS premature close fix" to "empty-turn classification + recovery family"; slug renamed to `codex-empty-turn-recovery`. Trigger: user pointed to OpenHands #2797 which documents three independent causes of the same symptom and warned that empty response is a result, not a root cause.
- 2026-05-06: **policy decision** — empty turn must never become a hard blocker. CMS must continue under maximum fault tolerance. Evidence preservation via log mechanism is the floor; recovery (retry / synthesize / pass-through) is preferred over surfacing errors. This overrides the earlier draft's "error after retry" defaults. (See Decisions §D-1.)

## Effective Requirement Description

1. The codex provider must **classify** every assistant turn that lands as "effectively empty" (no text emitted to AI SDK + no tool calls + finishReason in `{unknown, other, error}`) into one of the known cause families, or `unclassified` if none matches.
2. For each cause family, recovery behavior must be **explicit, named, and non-blocking**. Allowed actions: `retry-once-then-soft-fail`, `synthesize-from-deltas`, `pass-through-to-runloop-nudge`, `log-and-continue`. **`hard-error` is NOT an allowed recovery action** — empty turn must never propagate up as an exception that stalls CMS. The classifier-decided action replaces the current silent `endStream()` (per `feedback_no_silent_fallback.md` — silence is the violation; surfacing as a logged-and-recovered event is compliance).
3. The `?` nudge in the runloop must continue to exist as a defense and remains broadly applicable as a safety net (kept broad, not narrowed). Classifier outcomes that imply a known cause may **augment** the nudge with cause metadata, not replace it.
4. **Evidence preservation is the floor**: every empty-turn classification — including `unclassified` and successful recoveries — emits a structured log entry with enough state to forensically reconstruct the turn (cause family, raw stream-state snapshot, request options shape, account_id, ws frameCount, terminal-event-received flag). Logs are the load-bearing artifact for diagnosing future unclassified causes; the recovery path is subordinate to the logging path.

## Scope

### IN
- Codex provider's WS transport (`packages/opencode-codex-provider/src/transport-ws.ts`) — premature close handling, terminal-event tracking
- Codex provider's SSE pipeline (`packages/opencode-codex-provider/src/sse.ts`) — flush behavior when stream ends without terminal event, finishReason mapping for unknown/error
- Codex provider's request builder (`packages/opencode-codex-provider/src/provider.ts`) — verifying our exposure to OpenHands #2797 cause B (`include: ["reasoning.encrypted_content"]`) and cause C (`reasoning: {effort: ...}`)
- Empty-turn classification module (new) — single decision point that maps `(finishReason, usage, deltas-observed, terminal-event-received, request-options)` to a cause family
- Telemetry channel — emit classification per turn for observability
- Documentation in event log + `architecture.md` if a new boundary is added

### OUT
- The runloop's `?` nudge implementation itself (it stays; we narrow its triggering condition only)
- Account rotation policy (separate concern; covered as amplifier in Risks but not the spec's fix surface)
- Server-side codex behavior (we cannot fix the upstream; we can only classify and recover)
- Compaction policy (separate concern; the 40K prompt clamp observed in this incident is downstream noise from a deeper compaction trigger that is out of scope here)

## Non-Goals

- Eliminating empty turns entirely — some causes are server-side and outside our control
- Replacing the `?` nudge with a smarter heuristic — that work belongs in a separate revision of the runloop spec
- Backfilling telemetry for past sessions — only forward-looking classification is in scope

## Constraints

- `feedback_no_silent_fallback.md` (AGENTS.md rule 1): provider-level failures must be surfaced explicitly, not masked as graceful completion
- `feedback_destructive_tool_guard.md` analogue: any auto-retry must not multiply the request load against a degraded codex backend
- `feedback_minimal_fix_then_stop.md`: try smallest patch first; classification + telemetry first, recovery policy second after observing real distribution
- `feedback_provider_boundary.md`: classification logic stays inside the codex provider; runloop should not learn about codex-specific failure modes
- Schema compatibility: `LanguageModelV2FinishReason` is from AI SDK; we cannot add new enum values, must encode classification in providerMetadata

## What Changes

- **New**: `packages/opencode-codex-provider/src/empty-turn-classifier.ts` — pure function mapping observed stream state → cause family enum
- **Modified**: `packages/opencode-codex-provider/src/sse.ts` — flush block records terminal-event-received, hands state to classifier, emits classification in providerMetadata, picks finishReason based on classification (not blanket `unknown`)
- **Modified**: `packages/opencode-codex-provider/src/transport-ws.ts` — `ws.onclose` while streaming with `frameCount > 0` no longer silent; routes to classifier and either errors out, signals retry, or marks turn as classifier-decided
- **Audit**: `packages/opencode-codex-provider/src/provider.ts` — verify our exposure to OpenHands #2797 cause B/C; if exposed, decide whether to omit those params for codex-subscription tier (matching OpenHands fix)
- **Telemetry**: emit a structured event per classified empty turn (channel TBD during design phase)

## Capabilities

### New Capabilities
- Empty-turn cause classification: every empty assistant turn is tagged with a cause family (`ws_truncation` / `server_empty_output` / `request_param_rejected` / `terminal_no_output` / `unclassified` / etc.)
- Cause-aware recovery selection: each family maps to a named recovery action, replacing the current blanket "emit unknown finishReason → upstream nudge"

### Modified Capabilities
- WS premature-close handling: previously silent `endStream()` becomes one of the explicit classifier-decided paths (error / retry / pass-through), no longer disguised as graceful close
- SSE finishReason mapping: previously `state.finishReason ?? "unknown"`, now `classifier-decided ?? "unknown"`
- Runloop `?` nudge: triggering condition narrows from "any empty turn" to "model-emitted empty turn" — provider-classified failures bypass the nudge

## Impact

- **Code**: codex provider package only; no AI SDK changes; runloop changes minimal (narrowed nudge condition)
- **Sessions**: future sessions experiencing any of the cataloged failure modes will surface explicit errors / retries instead of silent loops
- **Telemetry**: new event type added; downstream dashboards can surface empty-turn distribution by cause
- **Operators**: when a previously-loop-prone session now errors explicitly, operator UX changes — they see a real error instead of "AI 在跳針"; this is a deliberate trade-off favoring honesty over availability
- **Tests**: existing `sse.test.ts` truncation cases will need to assert classifier output rather than only finishReason; new test cases for each cause family
- **Docs**: `architecture.md` may gain a short paragraph in the codex provider section noting the classifier; event log captures the diagnosis

## External References (Evidence)

| Source | What it documents | Our verdict |
|---|---|---|
| OpenHands `software-agent-sdk#2797` | 3 independent bugs producing empty response on `chatgpt.com/backend-api/codex/responses` | A) `prompt_cache_retention` 400 — NOT us; B) `include: ["reasoning.encrypted_content"]` → `output: []` — possibly us, schema accepts, callers TBD; C) `reasoning: {effort: ...}` → `output: []` — possibly us, provider.ts:91-94 sends always when configured; D) client-side reassembly losing deltas — NOT us, we are delta-driven |
| hermes-agent `#5736` | `store: false` → `response.completed.output: []` despite deltas | NOT us — we do not read `resp.output` (sse.ts:394-407 reads only `resp.id`/`resp.usage`/`resp.status`); text is delta-accumulated |
| Live session `ses_204499...` DB | 17-turn loop after `msg_dfe39162f` empty turn; reasoning sticky 0; cache_read locked at 37888; 11 different codex accounts rotated through the same session | confirms WS-truncation-class symptom; account rotation is amplifier (cold prefix → larger upload → higher truncation probability) |
| Our `transport-ws.ts:418-424` | `ws.onclose` mid-stream with `frameCount > 0` calls `endStream()` instead of erroring | confirmed root cause for cause family E; matches `msg_dfe39162f` DB fingerprint exactly |
| community.openai.com 2026-02-08 thread on "stream disconnected before completion on backend-api/codex/responses" | server-side stream truncation reports | likely related to E; reinforces classification family is needed not single fix |
| CLIProxyAPI `#897` | confirms `prompt_cache_retention` rejection by codex subscription endpoint | corroborates OpenHands cause A |

## Decisions

- **D-1 (2026-05-06, user)** — **Empty turn is never a hard blocker.** CMS continues under maximum fault tolerance. No recovery path may surface as an exception that stalls the runloop. Closes Open Question 1 with the constraint: `hard-error` is removed from the action vocabulary entirely. (See updated Effective Requirement Description §2.)
- **D-2 (2026-05-06, user)** — **Implement a log mechanism that preserves evidence** before any other recovery work. Logs are the load-bearing deliverable of this spec; recovery actions are subordinate. (See updated Effective Requirement Description §4.)
- **D-3 (2026-05-06, accepted from proposal)** — **Audit before omitting** OpenHands B/C parameters. Do not pre-emptively strip `reasoning.effort` / `include: ["reasoning.encrypted_content"]` for codex-subscription tier. Ship classifier + logging first; act on B/C exposure only once production logs confirm we are observing those causes. (Closes Open Question 3.)
- **D-4 (2026-05-06, accepted from proposal, with override)** — Runloop `?` nudge **stays broad**, not narrowed. Rationale: D-1 mandates max fault tolerance, and the nudge is a fault-tolerance mechanism — narrowing it would reduce coverage. The classifier may augment nudge calls with cause metadata in providerMetadata, but the nudge itself is not gated by classifier outcome. (Closes Open Question 4; overrides earlier proposal suggestion to narrow nudge scope, which conflicted with D-1.)
- **D-5 (2026-05-06, accepted from proposal)** — Slug is `codex-empty-turn-recovery`. (Closes Open Question 5.)

## Resolved Open Questions

All five open questions resolved by Decisions D-1 through D-5 above.

The remaining design-phase questions (which fall under `designed`-state work, not `proposed`-state blockers) are:

- Concrete shape of the log entry (field names, schema, retention)
- Where the log destination lives (existing telemetry channel vs. new file vs. both)
- Cause-family enum exact values and their classifier predicates
- Recovery action implementation order (which to ship first; classifier + log before any retry-loop work)

These are tracked into `design.md` once the spec is promoted to `designed`.
