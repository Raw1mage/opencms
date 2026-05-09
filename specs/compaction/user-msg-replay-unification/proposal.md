# Proposal: user-msg-replay-unification

## Why

The 2026-05-05 hotfix (commit `a3be0500e`) patched a bug where compaction silently swallowed the user's most recent message — but it patched only **one** of three sibling code paths. On 2026-05-09 the same bug recurred via a different sibling: **rebind pre-emptive compaction** (`prompt.ts:2114`). Production debug.log evidence from session `ses_1f47aa711ffehMSKNf54ZCHFTF`:

```
15:44:42.149  WARN  rebind handed off bloated session, pre-emptive compaction before WS open
              tokenRatio: 0.787, tokenLimit: 272000
15:44:42.160  INFO  compaction.started observed:"rebind"
15:44:42.178  INFO  kind_chain: ["low-cost-server","narrative","replay-tail"]
15:44:42.241  INFO  codex compact request inputItems:440 bodyBytes:735617
15:44:43.496  WARN  codex compact failed status:429 "Too Many Requests"
15:44:43.509  INFO  kind_attempted narrative succeeded:true
15:44:45.485  INFO  compaction.completed observed:"rebind" kind:"narrative"
15:44:45.495  INFO  loop:no_user_after_compaction — exiting cleanly  ← USER MSG SWALLOWED
```

The user's typed message was hidden behind the anchor (anchor ULID > user msg ULID → `filterCompacted` slices it out → next iter `lastUser` is `undefined` → silent loop exit). `INJECT_CONTINUE["rebind"] = false` so no synthetic Continue was injected either.

Hotfixing each call site individually is fragile: every new compaction trigger added in the future is one merge away from re-introducing the bug. We have telemetry that 5/5 hotfix did not stop the regression — three weeks later, two sibling paths still carry the same flaw.

## Original Requirement Wording (Baseline)

- "如果我輸入的一段話觸發了compaction，這段話就被吞掉了，不會回應我。"
- "之前hotfix過不是嗎？怎麼又復發了"
- "一下子好幾個洞，需要框架式的統一解決嗎？還是個別patch ?"
- "同意前面半框架式的統一漏洞解法"

## Requirement Revision History

- 2026-05-09: initial draft created via plan-init.ts; recurrence confirmed in production debug.log; user approved semi-framework unification approach over per-site patches.

## Effective Requirement Description

1. The "user-message replay after anchor" logic must be implemented **once**, inside `SessionCompaction`, callable from any compaction commit path. No call site should reproduce its own copy.
2. All compaction call sites must invoke it (or rely on the central path that already invokes it). Currently affected sites:
   - `empty-response` self-heal (`prompt.ts:1484-1554`) — has inline replay (the 5/5 hotfix); should be deleted in favor of the helper.
   - state-driven `overflow` / `cache-aware` (`prompt.ts:2387-2412` via `SessionCompaction.run`) — **missing replay**.
   - `rebind` pre-emptive (`prompt.ts:2114` via `SessionCompaction.run`) — **missing replay**; this triggered 2026-05-09 recurrence.
   - provider-switch pre-loop (`prompt.ts:1099-1146`) — **missing replay**; bypasses `SessionCompaction.run` and calls `compactWithSharedContext` directly.
3. The helper must handle: snapshot user msg + parts → run compaction → if user msg was buried, re-write with fresh ULID monotonically larger than anchor → delete the buried original (and its empty assistant child if present) → preserve all original part shapes.
4. The `INJECT_CONTINUE` table is updated: synthetic "Continue from where you left off" is injected **iff** the post-compaction stream has no unanswered user message. Cases where `INJECT_CONTINUE` was previously `false` (rebind / provider-switched / continuation-invalidated / stall-recovery / manual) become "let the helper decide" — replay if there's an unanswered user msg, fall back to Continue if not.
5. Cosmetic side-fix: `compactWithSharedContext` line 599 and `runLlmCompact` line 2761 currently call `publishCompactedAndResetChain(sessionID)` without `eventMeta`, causing `recentEvents` to record `observed:"unknown"`. Pass the proper observed/kind metadata through.

## Scope

### IN

- New helper `SessionCompaction.replayUnansweredUserMessage(sessionID, anchorMessage)` (or similar) extracted from `prompt.ts:1484-1554`.
- Call sites wired:
  - `defaultWriteAnchor` after `compactWithSharedContext` returns.
  - `tryLlmAgent` (writes its own anchor inline at `compaction.ts:1380`).
  - `compactWithSharedContext` direct caller in `prompt.ts:1099-1146` (provider-switch).
- Delete `prompt.ts:1484-1554` inline replay; the empty-response branch keeps only the `SessionCompaction.run` call.
- `INJECT_CONTINUE` deletion or rewrite: replaced by "no unanswered user msg in post-anchor stream → inject Continue".
- Pass `{ observed, kind }` to `publishCompactedAndResetChain` from the two bare call sites.
- Telemetry: `compaction.user_msg_replayed` event with `{ originalUserID, newUserID, hadEmptyAssistantChild, observed }`.
- Test coverage: integration test for each of the 4 call sites confirming user msg is preserved.

### OUT

- Restructuring `SessionCompaction.run` flow.
- Changing kind chain ordering / cooldown semantics.
- Backporting to legacy `process()` compaction path (deprecated, separately retired).
- Quality improvements to narrative compaction body (separate spec `compaction/narrative-quality`).

## Non-Goals

- Not aiming to merge `compactWithSharedContext` legacy path with `SessionCompaction.run` — that's a larger refactor for another spec.
- Not aiming to enrich the Continue text — keep current wording, just decide whether to inject.

## Constraints

- Must preserve ULID monotonicity: replayed user msg's id must be > anchor's id (`Identifier.ascending("message")`).
- Must preserve all part shapes (text, attachment, image, etc.) — copy-by-spread, fresh part ids.
- Replay must be idempotent under retry (failed replay can't double-write).
- AGENTS.md rule 1: every step logs explicitly; no silent fallback.
- Subagent sessions (`session.parentID` set) historically didn't auto-compact; helper must respect this — but in the unified path, replay is gated on whether compaction actually committed an anchor, so this is naturally satisfied.

## What Changes

- `packages/opencode/src/session/compaction.ts`: new helper export, two `publishCompactedAndResetChain` call sites pass `eventMeta`.
- `packages/opencode/src/session/prompt.ts`: lines 1484-1554 deleted; line 1137 path adds helper invocation; `INJECT_CONTINUE` table replaced with runtime check.
- New test fixtures covering 4 call-site scenarios.

## Capabilities

### New Capabilities

- **Unanswered-user-message preservation across compaction**: any compaction kind (low-cost-server, narrative, replay-tail, llm-agent, hybrid_llm) preserves a typed-but-not-yet-answered user message regardless of which trigger fired.
- **Compaction-induced silent exit elimination**: `loop:no_user_after_compaction` becomes diagnostic-only; the helper makes it impossible to enter that branch when a user message exists pre-compaction.

### Modified Capabilities

- `SessionCompaction.run` semantics: post-condition guarantees that if an unanswered user message existed pre-call, an unanswered user message exists post-call (with new id, after anchor).
- `INJECT_CONTINUE` semantics: was per-observed boolean table; becomes runtime decision based on stream state.

## Impact

- **Affected code**: `compaction.ts`, `prompt.ts` (significant deletion + 3-4 small additions).
- **Affected behaviour**: user no longer sees "I typed something and Claude went silent" symptom from compaction-related triggers.
- **Affected docs**: `specs/compaction/architecture.md` § INJECT_CONTINUE table needs update; `specs/architecture.md` cross-cutting index updates compaction section.
- **Operators**: a previously-silent failure mode becomes loud (replay events show in telemetry) — net debugging improvement.
- **Observability**: new event `compaction.user_msg_replayed`; UI Q card may surface this as a recent event.
- **No external API changes.** No data migration. No schema break.
- **Risk**: replaying a user msg with a new ULID could collide with concurrent writes if the runloop is unsafely re-entered — mitigated by the existing single-runloop-per-session invariant.
