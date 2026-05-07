# Codex Empty-Turn Loop Prevention — How the Fix Actually Works

**Date:** 2026-05-07
**Spec:** [specs/codex-empty-turn-recovery/](../../specs/codex-empty-turn-recovery/) (state: implementing → verified after live deploy)
**Trigger session:** `ses_204499eecffe2iUTzeXyiarlnq` (17-turn loop after `msg_dfe39162f` empty turn)
**Beta:** `beta/codex-empty-turn-recovery` → fetched into `test/codex-empty-turn-recovery`, awaiting finalize

This note records the post-implementation analysis explaining what the fix actually changes about the "AI 在跳針" symptom — the connection from the technical work back to the original observable behavior the user reported. Recording here because the spec artifacts describe WHAT was built; this note describes WHY it helps and what it does NOT fix.

## Original loop trigger (msg_dfe39162f, ~2026-05-06)

The 17-turn loop in `ses_204499...` started from a single empty assistant turn at `msg_dfe39162f`. Reconstructed from `~/.local/share/opencode/storage/session/ses_204499eecffe2iUTzeXyiarlnq.db`:

```
user 發訊息 → WS 收到部分 frame → WS 中途斷
              （沒收到 response.completed/incomplete/failed）
              ↓
              transport-ws.ts:422 偵測到 ws.onclose 而且 status===streaming
              ↓
              【修復前】frameCount===0 ? endWithError(...) : endStream()
                       因為 frame>0，走 endStream() 這條 — 靜默關掉
              ↓
              SSE flush 看到 state.finishReason 是 null
              ↓
              發出 finish part: { finishReason: "unknown", usage: 全 0, providerMetadata: undefined }
              ↓
              runloop 看到 finish=unknown + 零 token → empty-response guard 觸發
              ↓
              發 "?" + <context_budget> 合成訊息
              ↓
              codex 後端在已經被 compaction 切到 40K 的退化 context 上重新規劃
              ↓
              選了「讀 architecture.md / event_2026-04-29 / grafcet_renderer.py + grep gate-adjacent」
              ↓
              產出新的部分 frame ... 一樣中途斷 → 又是 endStream → 又是 "?"
              ↓
              17 輪複製貼上
```

DB fingerprint of each loop turn:
- `tokens_input` cycles 2K-4K with occasional 20K-40K spikes
- `tokens_cache_read` locked at exactly `37888` for many consecutive turns (same prefix replayed verbatim)
- `tokens_reasoning` sticky at 0 (was 19/27/1174 before the loop)
- All 17 turns: same 3 reads + 1 grep, no edits/writes/bash
- Codex itself self-acknowledged the loop ("我剛剛跳針了") but resumed the same actions next turn

## What the fix changes

### Change A — `transport-ws.ts:418-424` no longer silent

The same `ws.onclose with frame>0 but no terminal` event now:

1. Captures WS-layer state (`frameCount`, `terminalEventReceived=false`, `wsCloseCode`, `wsCloseReason`) into a snapshot
2. Combines with sanitized `requestOptionsShape` (whether `reasoning.effort` was sent, etc.) and feeds the classifier
3. Classifier identifies this as `ws_truncation` cause family, returns `retry-once-then-soft-fail`
4. JSONL log appends one line at `<state>/codex/empty-turns.jsonl`:
   ```json
   {
     "causeFamily": "ws_truncation",
     "recoveryAction": "retry-once-then-soft-fail",
     "wsFrameCount": 2,
     "terminalEventReceived": false,
     "wsCloseCode": 1006,
     "retryAttempted": false,
     "logSequence": N,
     ...
   }
   ```

### Change B — `provider.ts` retry orchestration

The `retry-once-then-soft-fail` action is no longer just metadata; it actually executes:

1. provider.ts wraps `mapResponseStream`'s output, buffers the finish part of attempt 1
2. If buffered finish has `recoveryAction === "retry-once-then-soft-fail"`, automatically reopens WS and resends the same body (attempt 2)
3. Classifier's INV-08 hard cap: attempt 2's snapshot has `retryAttempted=true`, which demotes any further retry action to `pass-through-to-runloop-nudge` — **never a third retry, regardless of what attempt 2 returns**
4. Attempt 2's stream parts are forwarded to AI SDK; attempt 1's buffered finish is discarded
5. If attempt 2 also lands empty, log entry has `retryAttempted: true, retryAlsoEmpty: true, previousLogSequence: <attempt 1's N>` — pair-joinable in observability metric M3

## What this means for the original loop scenario

### Path A — Transient WS truncation (most likely scenario)

If the WS truncation is **transient** (network blip, codex backend worker brief stall, TLS reset, account-cold-prefix processing timeout), attempt 2 has high probability of succeeding.

The user sees a normal answer. The "?" nudge never fires. **The loop never starts.**

`ses_204499...` shows 17 consecutive ws_truncation events for the same `yeatsraw-thesmart-cc` account. The pattern (cold prefix + 222K-token resend on first attempt of a freshly-rotated account) suggests transient backend stall is plausible. With retry, attempt 2 against a (by then) warm cache or recovered worker is much more likely to complete cleanly.

### Path B — Persistent backend degradation (attempt 2 also empty)

If attempt 2 also fails as ws_truncation (codex backend genuinely degraded for this account):

- INV-08 demotes attempt 2's recoveryAction to `pass-through-to-runloop-nudge`
- Second log line written with retry-pair fields (retryAttempted=true, retryAlsoEmpty=true, previousLogSequence)
- Finish part carries classification metadata
- Runloop's "?" nudge still fires (kept broad per Decision D-4)

**The loop in this case still happens.** But two things improve:

1. **Every loop turn is logged in real-time.** Operator can `tail -f empty-turns.jsonl` and see the cluster forming live, instead of forensic-mining sqlite hours later
2. **Future runloop work has metadata to act on.** The nudge synthetic message carries `causeFamily`, `retryAttempted`, `retryAlsoEmpty`, `logSequence`, `previousLogSequence`. A future spec could add "if same session sees ≥ N consecutive ws_truncation+retryAlsoEmpty events, stop nudging and surface to operator" — that's out of this spec's scope but the data is now available

### Path C — Not addressed by this fix

The actual root cause of the post-nudge model-replans-from-degraded-context behavior is **not** addressed:

- Compaction policy that produces stable 40K snapshots hiding turn-to-turn progress
- Account rotation policy that hands a freshly-onboarded account a 222K cold prefix
- Runloop's "any empty finish → fire `?` nudge" being too broad once the upstream has been classified

The user's earlier framing — "empty response 是結果不是原因" — is correct. This spec handles the **result layer** cleanly: classify, log, attempt one transparent recovery. Why `yeatsraw` repeatedly hits ws_truncation, why post-nudge planning re-converges on the same 3 reads, why compaction collapses to a stable equilibrium — those belong to compaction-policy / account-rotation / runloop-policy specs that don't yet exist.

## One-sentence summary

If the same `ses_204499...` scenario hits production tomorrow:

- **Pre-fix**: first empty response triggers nudge → 17-turn loop → operator forensic-mines sqlite to discover it was ws_truncation
- **Post-fix**: first empty response triggers automatic retry; **very likely recovers transparently**; if retry also fails, JSONL shows `ws_truncation × 17 with retryAlsoEmpty=true` cluster live so operator can switch accounts / restart / escalate to codex — instead of 17 wasted turns of "AI looks busy but is actually stuck"

## Honest scope statement

This fix is **upstream-of-loop**, not **anti-loop**. It targets the empty-turn event itself: prevents it when transient (retry), classifies it when persistent (log). The loop dynamics that arise post-empty-turn under degenerate compaction state remain unaddressed. The existence of M3 (retry-saturation alert) and M4 (soft-fail rate) in the operator runbook is the bridge: when these metrics light up, operators have a concrete escalation path before users see 17-turn loops.

## References

- Spec: [specs/codex-empty-turn-recovery/](../../specs/codex-empty-turn-recovery/)
- Operator runbook: [docs/runbooks/codex-empty-turn-log-runbook.md](../runbooks/codex-empty-turn-log-runbook.md)
- Architecture entry: [specs/architecture.md](../../specs/architecture.md) → "Codex empty-turn classifier + forensic log"
- External corroboration: OpenHands `software-agent-sdk#2797`, hermes-agent `#5736`, community.openai.com 2026-02-08 "stream disconnected" thread
- Beta commits: `49400a0f9` → `9d09d63a3` → `c97fb41e6` → `7e1833d9d` → `160e0885f` → `25c52b752` (6 commits, 105/105 codex-provider tests)
