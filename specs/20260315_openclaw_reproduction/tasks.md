# Tasks

## 1. Consolidation

- [x] 1.1 Merge benchmark and scheduler substrate planning into a single active plan
- [x] 1.2 Mark older openclaw plans as reference-only authority

## 2. Benchmark Findings

- [x] 2.1 Capture OpenClaw control-plane traits from local `refs/openclaw`
- [x] 2.2 Classify already-present / portable-next / substrate-heavy / incompatible patterns

## 3. Implementation Entry Slice

- [x] 3.1 Keep Trigger model extraction as the first implementation slice
- [x] 3.2 Keep lane-aware run queue as the first queue substrate slice
- [ ] 3.3 Refine concrete code slices and validation map for build mode

## 4. Follow-up

- [ ] 4.1 Update related events and references so only `openclaw_reproduction` remains the active authority
- [ ] 4.2 Verify whether `docs/ARCHITECTURE.md` needs wording updates after consolidation
- [ ] 4.3 Add kill-switch implementation as an OpenClaw follow-up slice: specs/20260316_kill-switch/
