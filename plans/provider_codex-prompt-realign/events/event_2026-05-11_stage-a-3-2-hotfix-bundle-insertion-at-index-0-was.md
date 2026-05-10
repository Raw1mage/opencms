---
date: 2026-05-11
summary: "Stage A.3-2 hotfix — bundle insertion at index 0 (was breaking chain prefix)"
---

# Stage A.3-2 hotfix — bundle insertion at index 0 (was breaking chain prefix)

## Symptom

After Stage A.3-2 + A.4 + persona restoration, fresh codex sessions still saw `cached_tokens=4608` stuck across all delta=true turns. WS REQ tail revealed bundle markers (`# AGENTS.md instructions for /`, `<role_identity>`, etc.) appearing in the LATE positions of input[], not at index 0-1 as upstream expects.

## RCA

llm.ts inserted bundles at `lastUserIdx` (before the most recent user message), inheriting the legacy CONTEXT PREFACE insertion semantics. On turn 1 this works (lastUser is at index 0, insertAt=0). On turn 2+ the conversation grows, so lastUser shifts to the tail and bundles get inserted MID-conversation:

```
turn 1 chain: [DEV_BUNDLE, USER_BUNDLE, user_msg_1]
turn 2 chain: [..., assistant_1, fc, fco, DEV_DUPE, USER_DUPE, user_msg_2]
                                          ↑ inserted here, not at chain head
```

The WS transport's delta-slice trims by prevLen, so the duplicate bundles ARE sent across the wire as new items. Server appends them to the chain mid-stream, breaking the upstream-expected `[bundle][bundle][user][assistant]...` prefix shape and dropping prefix cache to the tools-only floor (~4608 tokens / 36×128).

## Fix

`packages/opencode/src/session/llm.ts` — change bundle insertion target from `lastUserIdx` to index 0:

```diff
- const insertAt = lastUserIdx >= 0 ? lastUserIdx : input.messages.length
- input.messages = [
-   ...input.messages.slice(0, insertAt),
-   ...bundleMessages,
-   ...input.messages.slice(insertAt),
- ]
+ input.messages = [...bundleMessages, ...input.messages]
```

Now bundles always head input[]. On turn 2+, opencode rebuilds input from persisted history (no bundles) and re-prepends them; transport's delta-slice trims [0..prevLen) correctly because bundles match what's already in the chain.

This mirrors upstream codex-cli's `build_initial_context()` model: bundles are at chain positions 0-1, the rest of the conversation tail extends from position 2.

## Verification

Existing in-session ses_1ecd560a6 has the broken chain on the server already; cannot recover. User must open a NEW session post-restart to verify cache_read jumps off 4608 from turn 2 onwards.

```
bunx tsc --noEmit          clean
bun test context-fragments 13 pass / 0 fail
```

## Caveats

- Bundle is rebuilt every turn from current state (driver / SYSTEM.md / AGENTS.md / env). Byte-stability across turns is required for the delta-slice trim to work. We've verified driverHash, fragmentIds, and byte sizes are stable across the prior session's logs — same hash `24c40934fe30`, same fragmentIds, same totalChars — so the prepend-at-zero approach is byte-safe.
- If a fragment ever introduces per-turn variance (e.g., environment_context's current_date crosses midnight, or a future skill registry toggles per-turn), the chain dedup will fail and bundles will be re-sent. That's correct behavior for byte-changed bundles, but produces wasted bandwidth. Future Stage B fragments must be byte-stable across turns or live OUTSIDE the bundle.

