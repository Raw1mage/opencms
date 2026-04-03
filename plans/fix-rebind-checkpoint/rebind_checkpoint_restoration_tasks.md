# Restoration Tasks (2026-04-03)
## Goal: Healing the Legacy "440-Message" Stall

### 1. Legacy Shield Gate (Defensive Loading)
- [ ] 1.1 In `packages/opencode/src/session/message-v2.ts`, modify `filterCompacted()` to return a forced boundary if msg_count > 150 AND no checkpoint file exists.
- [ ] 1.2 Return a `legacy_forced_fallback` flag in the filter result.

### 2. Loading Point Refinement (Prompt Builder)
- [ ] 2.1 In `packages/opencode/src/session/prompt.ts`, check for the `legacy_forced_fallback` flag.
- [ ] 2.2 If flag is active, inject a synthetic context message derived from the CURRENT SharedContext snapshot.
- [ ] 2.3 Skip the remainder of the 440-message reconstruction — only pack post-boundary messages.

### 3. Background Healing (Permanent Fix)
- [ ] 3.1 In `packages/opencode/src/session/compaction.ts`, implement a `forceSaveRebindCheckpoint()` function.
- [ ] 3.2 Schedule this function in `prompt.ts` after a legacy session is successfully stabilized via the "Virtual Boundary."
- [ ] 3.3 Verify a JSON shadow-file is written to disk for future stateful recovery.

### 4. Verification
- [ ] 4.1 Measure rebind payload for session `ses_2b38...` (Target: < 200KB).
- [ ] 4.2 Verify prompt cache stability (Target: 97%+).
- [ ] 4.3 Verify the shadow JSON correctly appears in the State directory.
