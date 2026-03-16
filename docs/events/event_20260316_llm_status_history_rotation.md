# Event: LLM Status Card — History Rotation

**Date**: 2026-03-16
**Branch**: feature/killswitch-a-phase
**Scope**: webapp sidebar LLM status monitor

## Problem

LLM status card was binary: either shows active errors or "All models operational".
When an error's TTL expired (e.g. gpt-5.3-codex UNKNOWN from 1.6h ago), the card flips straight to green with no trace of what happened. During normal usage the card would stay stuck on a stale error state until TTL expiry, giving no feedback about recovery.

## Solution: History Ring Buffer

Added a `llm_history` ring buffer (cap 5) that records every LLM state transition, including recovery events. The LLM status card now shows:

1. **Active errors** (top, unchanged behavior)
2. **"Recent" timeline** — last 5 state changes with color-coded dots and labels:
   - Green dot + `OK` — recovered (ratelimit.cleared)
   - Yellow dot + `ERR` / `RATE` — error / rate limit
   - Red dot + `AUTH` — auth failure
   - Each entry shows model name + age

Fallback "All models operational" only appears when both active errors AND history are empty (i.e. fresh session with no LLM events yet).

## Files Changed

| File | Change |
|------|--------|
| `packages/app/src/context/global-sync/types.ts` | Added `LlmHistoryEntry` type, `LLM_HISTORY_CAP = 5`, `llm_history` field on `State` |
| `packages/app/src/context/global-sync/event-reducer.ts` | Added `pushLlmHistory()` helper; called on `llm.error`, `ratelimit.detected`, `ratelimit.cleared`, `ratelimit.auth_failed` |
| `packages/app/src/pages/session/session-status-sections.tsx` | LLM status card renders active errors + "Recent" history timeline |
| `packages/app/src/context/sync.tsx` | Init `llm_history: []` |
| `packages/app/src/context/global-sync/child-store.ts` | Init `llm_history: []` |
| `packages/app/src/context/global-sync/event-reducer.test.ts` | Init `llm_history: []` in test fixture |

## Data Flow

```
Backend Bus event (llm.error / ratelimit.*)
  → SSE to webapp
  → event-reducer: update llm_errors (existing) + push to llm_history (new)
  → session-status-sections: render active errors + history timeline
```

## Validation

- `npx tsc --noEmit` passes cleanly
- No new dependencies added
