# Updated Implementation Spec (2026-04-03)
## Bridging the Legacy "440-Message" Gap

### 1. Goal
Restore performance to legacy sessions (>200 messages) by bridging the gap between the implemented "Shadow Checkpoint" mechanism and the lack of existing data artifacts.

### 2. Strategy: "Forced Visitation Healing"
Instead of waiting for a round-completion trigger (Preventive), the system must proactively "Heal" (Curative) legacy sessions upon load.

### 3. Key Adjustments (Spec-only)

#### Modification A: Defensive Truncation (message-v2.ts)
*   **Behavior**: When `filterCompacted()` is back-scanning, if the count exceeds 150 messages AND no checkpoint file is found on disk.
*   **Action**: Force a return of a "Virtual Boundary" at the 50th message from the start.
*   **Safety**: Return a `legacy_forced_fallback` flag to the prompt builder.

#### Modification B: Shadow Synthesis (prompt.ts)
*   **Behavior**: If the `legacy_forced_fallback` flag is received.
*   **Action**: Synthesis a temporary checkpoint context using the current SharedContext snapshot.
*   **Result**: Instantly prevents the 850KB "Full Rebind" for the current round.

#### Modification C: Healing Background Task (compaction.ts)
*   **Behavior**: After a session is successfully loaded with a "Virtual Boundary".
*   **Action**: Schedule a one-time `saveRebindCheckpoint` in the background regardless of rounds/tokens.
*   **Persistence**: Once the JSON is on disk, subsequent visits will follow the official 2026-03-30 high-performance path.

### 4. Validation Criteria
- Rebind payload for legacy session (ses_2b38...) drops from 850KB to <200KB.
- TUI response time for "hi" drops to milliseconds.
- `rebind-checkpoint-{id}.json` eventually appears in the State directory.
