# Tasks

## 1. Defensive Truncation
- [ ] 1.1 Implementation of `legacy_forced_fallback` in `message-v2.ts`.
- [ ] 1.2 Limitation of back-scanning in `filterCompacted()` (Cap at 150 entries).

## 2. Load Synthesis
- [ ] 2.1 Refactor `prompt.ts` to inject synthetic context from SharedContext.
- [ ] 2.2 Filter `msgs` to hanya entry newer than virtual boundary.

## 3. Physical Healing
- [ ] 3.1 Proactive generation of `rebind-checkpoint-{id}.json`.
- [ ] 3.2 Post-visit background save activation.

## 4. Validation
- [ ] 4.1 Log inspection: `msgs.length < 100` for session `ses_2b38...`.
- [ ] 4.2 File inspection: JSON present in `Global.Path.state`.
