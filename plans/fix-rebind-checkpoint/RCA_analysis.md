# RCA: RebindCheckpoint Stall (Legacy Session 440 Detection)

## 1. Problem Definition
The system stalls when loading a session with 440+ messages. Despite the `RebindCheckpoint` (Shadow JSON) mechanism being implemented in `compaction.ts` and loaded in `prompt.ts`, the system consistently falls back to `full message reconstruction`.

## 2. Evidence of Disconnection
- **Code Exists**: `loadRebindCheckpoint` is called in `prompt.ts` (L995/L1252).
- **Result is Null**: The call consistently returns `null`, meaning no Shadow JSON exists on disk.
- **Silent Threshold**: In `compaction.ts` (L93), the threshold `REBIND_BUDGET_TOKEN_THRESHOLD` is never met for legacy sessions, or the `tokens.total` calculation is producing zeros for historical data.

## 3. The "Legacy Gap" (向下相容缺口)
The existing mechanism is designed for "Prevention," not "Curation."
- **Prevention**: New sessions generate checkpoints when they hit a threshold.
- **Curation (Missing)**: Old sessions (pre-checkpoint implementation) that are ALREADY over the threshold stay in a "Dead Zone." They are too heavy to rebind efficiently but haven't triggered a background save because they haven't met the incremental growth conditions of the current round.

## 4. Why it looked like Dead Code
The logic for `saveRebindCheckpoint` was perfect, but its **Trigger** was locked behind a gate that legacy sessions couldn't unlock without a specific re-evaluating visit.

## 5. Conclusion
The "Dead Code" was actually an "Idle Guard." To restore stability for the 440-message session, the gate must be lowered for legacy visits, allowing a one-time shadow generation to heal the gap.
