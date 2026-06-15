# BR: Cold B-gate compaction discarded work-state and caused work to repeat (00:34, with ample context headroom)

- **Date**: 2026-06-16
- **Severity**: high
- **Status**: FIX LANDED 2026-06-16 (working-tree; pending build/restart). RCA complete; primary fix = grow the raw C-tail budget. See *Fix applied* below.
- **Component**: opencode session runtime — narrative raw-tail (C-tail) projection budget
- **Reporter**: pkcs12 (live observation in session `ses_1347b6b8bffepnVyQSPGQCfJAW`, "nimble-mountain", 資安署廠商稽核報告)

## Symptom

Mid-turn, text that had **already been streamed to the client was swallowed/retracted**, then **different conversation content was regenerated**. Afterwards the assistant **repeated work it had already done and stepped on already-applied edits**. User compared the visual effect to chain-of-thought being revealed then hidden.

## Timeline (from `~/.local/share/opencode/log/debug.log`)

| Time (CST)   | Event |
| ------------ | ----- |
| 00:34:27.641 | `diag.preLLM` step 7 — **msgsLen: 63** (pre-compaction working set) |
| 00:34:36.206 | `claude_cold_compaction_gate` — `promptTotal: 202730`, `gate: 200000`, **`cacheRead: 0` / `cacheReadFraction: 0`**, `idleColdResume: false` |
| 00:34:36.206 | `loop:state_driven_compaction` observed=`cache-aware`; `compact requested` (origin=`mainloop`) |
| 00:34:36.235 | `compaction.kind_attempted` kind=`narrative`, succeeded |
| 00:34:36.277 | `compaction.anchor.sanitized` — `originalLength: 64830` → `augmentedLength: 70985` (≈18K-token prose anchor) |
| 00:34:36.412 | `compaction.completed` observed=`cache-aware`, kind=`narrative` |
| 00:34:36.439 | `diag.preLLM` step 9 — **msgsLen: 2** (anchor + ~1 raw tail round) |
| 00:34:36.444 | `system-manager_switch_model` (model/account switch around the same boundary) |
| later        | step 10→11→12 msgsLen 3→4→5 — model resumes from the summary and re-issues tool calls |

`context_budget` telemetry at the same step: **`window: 1000000`, `used: ~17955`, `ratio: 0.0179`, `status: green`** — i.e. context was **~1.7%–20% full; there was NO context pressure**. (`used` is the projected/cached figure; `promptTotal` 202730 is the cold full-prefill array size.)

## Root cause

The compaction that fired at 00:34 was **not** a context-overflow compaction. It was the **claude cold-cache size-gated "B" compaction** ([prompt.ts:650-724](packages/opencode/src/session/prompt.ts#L650-L724)):

- `coldCacheBGate({ promptTotal: 202730, bCompactTokens: 200000 })` → true (claude-cli `bCompactTokens` default = 200K; see [tweaks.ts](packages/opencode/src/config/tweaks.ts)).
- Cold confirmed by `cacheReadFraction (0) < 0.5` → returns `"cache-aware"` → `KIND_CHAIN ["narrative","ai_paid"]` → narrative compaction.

The **design intent** of the B-gate is purely **cold-resend cost control**: claude's prompt cache has a ~5-min TTL, so after an idle gap or account rotation the whole prompt re-prefills uncached; for a ≥200K array that is expensive, so the runtime compacts to send a bounded supersede-framed anchor+tail instead of the full array on every cold resend.

But the narrative path keeps only **`fadeout.bTailRounds = 1`** raw round post-anchor, capped at **`bTailMaxTokens = 12_000`** ([compaction.ts:1300-1317](packages/opencode/src/session/compaction.ts#L1300-L1317), tuned in [tweaks.ts:507-515](packages/opencode/src/config/tweaks.ts#L507-L515)). Everything else (62 of 63 messages) is reduced to a ~18K-token **prose** summary.

So a **cost-driven** compaction — fired with **~98% context window still free** — collapsed the entire fine-grained working history into prose plus a single raw round. A prose summary does not reliably pin down "section N already written / file already saved / edit already applied." On resume the model re-derived its plan from the lossy anchor and **redid completed work, colliding with already-applied edits**. The in-flight stream that was mid-generation at the rotation boundary was discarded → the "swallowed text → different content" visual.

**One-line:** the cold B-gate optimizes for *resend size* (`bTailRounds=1`, tuned for true overflow) but fires for *cost* reasons even when there is abundant context headroom, sacrificing work-state fidelity that did not need to be sacrificed.

## Confirmed evidence (anchor + post-anchor message stream, read 2026-06-16)

Read from the per-session store `~/.local/share/opencode/storage/session/ses_1347b6b8bffepnVyQSPGQCfJAW.db` (read-only). Three hypotheses were tested and the failure mode is now pinned:

1. **NOT the 2026-06-10 double-enrichment bug.** Logs show enrichment was *scheduled* (`origin=writeAnchorFromBody`) then **`hybrid_llm enrichment skipped (anchor body below A-tier floor)`** — `narrativeTokens: 33439`, `anchorRatio: 0.033`, `capApplied: true`. Only 3 enrichment log lines for the whole session; no double-fire, no `drop_old` trim. The anchor stayed intact at ~33K tokens. The known-issue's *secondary policy fix* (gate on anchor contribution, not total occupancy) is working — the gate keyed on `anchorRatio 0.033`, not `realPromptTokens 202730`.
2. **The anchor is NOT blind to completion.** The summary text part (74,417 chars) is structured `## Round 1..5` with explicit completion markers ("稽核工作底稿已完成並產出 Word 檔", "questions.json ✅ 已建好（73題、14構面）", "PLAN 已完成並存檔，未進入實作"). Early work was captured adequately.
3. **The failure is a recent-boundary fidelity cliff on filesystem state.** The post-anchor assistant's first turn states it was mid-way through *splitting the `isms-expert` skill and creating an `ismsworks` repo skeleton* — work done in the rounds **immediately before** 00:34 that the anchor narrative does **not** mention and that fell past the single `bTailRounds=1` raw round. The model re-oriented via `ls`/`read`/`grep` (correct instinct), but then ran `mv ~/projects/leadauditor ~/projects/ismsworks` **into an already-existing skeleton it had created earlier and no longer remembered**, producing a nested `ismsworks/leadauditor/` mess that took ~6 turns to untangle. That `mv` collision is the user-reported "repeated work / stepped on an already-done point."

**Refined root cause (corrected — the defect is the raw C-tail budget, not the cost trigger):** The preserve mechanism *exists and is wired*: when `filterCompacted` reaches the anchor it reads `compactionPart.metadata.rawTailProjection` and calls `collectRawTailAfterAnchor` to re-attach the rounds that `omitLastRounds` cut from the narrative ([message-v2.ts:1251-1256](packages/opencode/src/session/message-v2.ts#L1251-L1256), [message-v2.ts:1304-1337](packages/opencode/src/session/message-v2.ts#L1304-L1337)). So this is **not** an omit-but-don't-preserve correctness bug.

The defect is that `bTailMaxTokens = 12_000` is applied as the **wrong kind of limit**, contradicting its own documented intent:

- Config intent ([tweaks.ts:344-345](packages/opencode/src/config/tweaks.ts#L344-L345)): `/** C-tail 絕對 cap (防單一大 tool dump) */` — a guard against **one** oversized tool dump.
- Implementation ([message-v2.ts:1317](packages/opencode/src/session/message-v2.ts#L1317)): `if (tail.length > 0 && collectedTokens + msgTokens > maxTokens) break` — `collectedTokens` is **cumulative across messages**, and exceeding it **terminates the whole tail collection**. So it is a *total-tail ceiling with early termination*, not a per-message dump guard.

Consequences, compounding:
1. **Wrong shape.** A single-dump guard became a cumulative ceiling. The newest message is admitted unconditionally; the very next message that pushes the running total past 12K stops collection entirely — everything older is dropped.
2. **Absurd value.** 12K tokens of recent verbatim tail is trivially small for an agentic coding session (dense `bash`/`read`/`grep` I/O). It trips after ~1–2 turns, often before `collectRawTailAfterAnchor` completes even one round (`collectedRounds` stays 0). `bTailRounds=1` is moot — the token ceiling bites first.
3. **No justification here.** Context was ~98% free. There was abundant room to keep far more recent raw tail; a 12K ceiling is an overflow-emergency value being applied to a compaction that fired with full headroom.

Result: the raw tail that survived was only the last ~12K tokens (≈1–2 turns) → `msgsLen: 2`. The round that created the `~/projects/ismsworks` skeleton sat further back than 12K, so it was cut from the narrative AND fell outside the tail budget → gone from context → the resuming `mv` collided with it.

## Relationship to existing tickets

- **`issues/bug_20260615_subagent_working_memory_ungoverned_warm_large.md` (OPEN) — the mirror image.** That bug: a long-lived **warm** subagent → cold B-gate condition is **never** true → never compacts → unbounded growth to 231K. This bug: a **cold** parent session → cold B-gate **does** fire → **over-compacts** and loses work-state. Both are the same architectural root the 6/15 issue named: **compaction governance is cache-economics-driven and decoupled from work-memory fidelity**. The 6/15 issue is the "never fires" edge; this is the "fires too hard" edge. They should be fixed together.
- **`issues/closed/issue_20260614_rotation_compaction_runloop_stop.md` (CLOSED) — different symptom, shared boundary.** That was a runloop *stall*, RCA'd to a 3R daemon restart interrupting an in-flight turn; it explicitly concluded the user-message **replay invariant held**. Note the gap: that invariant preserves the *user* message post-anchor, but the narrative path does **not** preserve the assistant's *completed-work* state. This bug is that distinct, un-covered failure mode — not a reopen.

## Fix applied (2026-06-16, working-tree)

The defect was the raw C-tail max-token cap, not the compaction trigger or the round count. **Single change:**

**Removed the C-tail max-token cap.** `collectRawTailAfterAnchor` ([message-v2.ts](packages/opencode/src/session/message-v2.ts)) no longer takes/enforces `maxTokens` — the cumulative `collectedTokens + msgTokens > maxTokens → break` early-terminate is gone. The tail is now bounded **only by round count** (`fadeout.bTailRounds`, kept at the default **1**). The dead `fadeout.bTailMaxTokens` knob (type, default `12_000`, env parser `compaction_fadeout_b_tail_max_tokens`) and the now-orphaned `estimateFilterTokens` helper were deleted. The `rawTailProjection` metadata shape dropped `maxTokens` (schema field removed; `{ rounds: number }` everywhere).

Why round count was **not** raised: one round = a user message plus *every* assistant message it triggered (in an agentic stretch, often many tool-call turns), so 1 round is already substantial; bumping to 3 risked retaining far too much. The actual failure was the 12K cap truncating the tail **mid-round** to ~1–2 turns — so removing the cap, alone, lets the full most-recent round survive verbatim, which is the fix. If 1 round later proves too little, `bTailRounds` is a one-line config bump.

Net effect: after a narrative compaction, the most recent round survives raw **in full** with no token ceiling, so recent structural work (e.g. the `ismsworks` skeleton creation) stays in context instead of being cut off partway, and the resuming model can't collide with its own un-remembered mutations.

Tests: `compaction-extend-redaction`, `claude-refactor.inv0-baseline`, `dialog-serializer` (71 pass), plus `compaction` / `compaction-run` / `compaction-replay-deep` / `message-v2.compaction-skill-snapshot` (43 pass); typecheck clean for touched files. **Not yet built/restarted** — takes effect on next `restart_self`.

## Relationship to the warm-large twin

`issues/bug_20260615_subagent_working_memory_ungoverned_warm_large.md` (OPEN) is the mirror: a long-lived **warm** subagent never satisfies the size-gate → never compacts → unbounded growth. This bug was the **cold** edge → compacts but kept too little C-tail. Same architectural root (the 6/15 issue's framing: governance keyed on cache state, decoupled from work-memory fidelity). This fix addresses the fidelity side; the warm "never fires" trigger gap remains for that ticket.

## Follow-ups (not blocking)

1. (Optional) if 1 round proves too little in practice, raise `bTailRounds`, or make it headroom-aware (keep more rounds when context utilization is low). Deferred until there's evidence one round is insufficient.
2. Add a dedicated regression test: a narrative compaction whose most-recent round is large (multi-turn, well over the old 12K) verifies the whole round survives verbatim post-anchor (locks in the removal of the token cap).

---

# Second axis: the visible "stream swallow" (distinct from work-state loss)

The original symptom had TWO independent causes sharing the `cache-aware narrative` trigger. The C-tail fix above addresses **work-state fidelity** (the model re-doing work). The **visible swallow** — already-rendered text retracted and replaced mid-view — is a separate, frontend rendering problem. Do not conflate them.

## RCA (corrected by live evidence, 02:33:43 compaction on the test build)

First hypothesis (the anchor's ~70K `<prior_context>` text part being streamed to live SSE) was **only partial**. Server-side suppression of that part was implemented and **confirmed working** in logs (`[PART-FLOW-A] suppressed part.updated (anchor, no broadcast)` ×2; the 70K text no longer forwarded) — yet the swallow persisted.

The residual, dominant cause is **message-level churn**: a single compaction emits a burst of per-message SSE events to the live client — in the observed case **3× `message.removed`** (old anchor + folded rounds) + a new summary anchor (`message.updated`, pushed to array end) + the **replayed user message** (`compaction.replay.invoked`, newest ID → sorts to the bottom) + a Continue message. SolidJS reactively re-renders the transcript on each store mutation, so the visible turn list reflows/collapses mid-transition. The frontend's compaction-hiding machinery (summary filter in `session-turn.tsx`, replay dedup in `session.tsx` `visibleUserMessages`, the compaction status footer) are all **post-hoc memos** — they settle to the right end state but cannot prevent the intermediate reflow. `session.tsx` even documents the window: "during live streaming [the replay's] ID sorts AFTER all assistant messages → appears as duplicate question at the bottom."

So the swallow is **not** the part payload size; it is the live application of compaction's message add/remove/replay burst.

## Landed (server-side layer, on main 337dc18bc)

`Session.updatePart` gained a `{ part, broadcast: false }` form ([session/index.ts](packages/opencode/src/session/index.ts)) that persists the part but skips the `PartUpdated` event. The two synthetic anchor writers (`writeAnchorFromBody` + `rebuildStreamFromText`) use it for their text + compaction parts. The anchor MESSAGE still broadcasts (context-metrics needs it). The `ai_paid` path is intentionally left broadcasting (its summary is a real streamed turn). Effect: removes the 70K-per-compaction-per-client bandwidth waste and the part-level leak — but does **not** by itself stop the visible swallow.

## Remaining fix (frontend — NOT yet done)

Make compaction's message mutations atomic/invisible to the live transcript. Sketch: the server already brackets the operation with `session.compaction.started` / `session.compacted`. On `started`, the client freezes the rendered transcript (render from a snapshot); apply the remove/add/replay burst to the store quietly; on `compacted`, reconcile once and unfreeze. Touches `packages/app/src/context/global-sync/event-reducer.ts` + `packages/app/src/pages/session.tsx`. Alternative: server stops emitting per-message remove/add/replay to live clients during compaction and lets the client pull one snapshot at `compacted`.
