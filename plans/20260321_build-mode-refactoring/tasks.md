# Tasks

## 1. Quiz Guard Admission Model

- [x] 1.1 Audit current builder/build-mode authority surfaces and identify where quiz admission should run (`plan_exit`, first continuation, or both)
- [x] 1.2 Define the quiz schema and exact expected answer sources for main repo, base branch, implementation repo, implementation branch, and docs write repo
- [x] 1.3 Define pass/fail evaluation, mismatch evidence format, one-time reflection retry, and ask-user escalation policy

## 2. Quiz Guard Implementation

- [x] 2.1 Implement structured beta-sensitive build admission quiz
- [x] 2.2 Reject build entry when any quiz field mismatches authoritative mission/mainline metadata
- [x] 2.3 Persist or surface quiz admission state so later runtime steps know whether calibration already passed

## 3. Prompt / Workflow De-redundancy

- [x] 3.1 Reduce hardcoded build-mode prompt text so it no longer acts as pseudo-enforcement
- [x] 3.2 Keep only minimal state/stop narration and advisory text that still helps operators without claiming authority
- [x] 3.3 Re-evaluate `beta-workflow` skill and `beta-tool` MCP as advisory assets only, not admission/enforcement authorities

## 4. Validation

- [x] 4.1 Add or update targeted tests for quiz pass / retry / ask-user admission behavior
- [x] 4.2 Re-run focused build-mode and bootstrap-policy validation
- [x] 4.3 Confirm non-beta build behavior still works after prompt cleanup
- [x] 4.4 Record whether any concrete residual failure remains that would justify a future targeted hard guard

## 5. Documentation / Sync

- [x] 5.1 Update event log with the authority-model revision from prompt-led workflow to quiz-guard admission
- [x] 5.2 Sync `specs/architecture.md` to describe runtime authority vs advisory guidance boundaries
- [x] 5.3 Compare implementation results against this plan and record any remaining gaps
