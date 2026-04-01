# Proposal: Recovery Refactor After 2026-04-01 Drift

## Why

- `cms` suffered at least one confirmed large overwrite/drift event on 2026-04-01, which removed a large mainline-visible capability range from the active branch.
- The current `recovery` branch already restored most critical-path behavior, but several high-value capability chains remain missing or only partially restored.
- Direct branch merge is no longer trusted as a safe recovery mechanism; missing functionality must be reintroduced through controlled refactor slices.

## Original Requirement Wording (Baseline)

- "目前的recovery branch應該已經恢復大部份4/1重大事件丟失的commits了。盤點一下還有多少要復原。包含剛剛發現的provider list UI"
- "依照價值優先率一個一個救回來吧。目前也沒辦法直接merge了。一定是一個一個refactor進來"

## Requirement Revision History

- 2026-04-01: Initial focus narrowed from generic provider-list recovery to the correct `模型提供者` dialog UI slice, then expanded into a whole-recovery inventory once the branch drift pattern was confirmed.
- 2026-04-01: User decided that the remaining recovery work must proceed by value-prioritized refactor slices, not by direct merge of historical branches.
- 2026-04-01: The first Claude Native slice hit a stop gate because the current tree lacks the `packages/opencode-claude-provider` source scaffold and a live `claude-native` integration surface, so the plan was revised to decompose Claude Native into smaller executable sub-stages.
- 2026-04-01: Claude Native scaffold / auth bridge / minimum activation slice was recovered on `beta/provider-list-commit` and committed as `2a293ce5e`; remaining native lifecycle and full-transport work was explicitly deferred so the next active recovery target becomes runtime/context hardening.
- 2026-04-02: Rebind / continuation / session hardening was refined so the first session slice becomes `7.2a` rebind checkpoint durability + safe checkpoint injection; broader continuation/session leftovers stay deferred until a still-proven gap remains after that slice.
- 2026-04-02: Provider-manager recovery was refined so the next webapp slice becomes model-manager provider visibility/favorites semantics in `dialog-select-model.tsx`; dialog reopen geometry cleanup remains a separate later slice only if still needed.

## Effective Requirement Description

1. Inventory the remaining missing functionality in the current `recovery` branch relative to the 2026-04-01 pre-drift mainline state.
2. Treat the restored provider list UI / `模型提供者` dialog slice as already recovered and exclude it from the remaining high-priority gap list.
3. Recover the remaining high-value capability groups one slice at a time by refactoring them into the current `recovery` branch.
4. Avoid direct merge-based restoration from stale `cms`, `beta/*`, or `test/*` branches.
5. Preserve evidence, validation, and workflow safety contracts while restoring functionality.
6. Re-plan oversized recovery slices into smaller executable stages before resuming build execution.

## Scope

### IN

- Planning and execution sequencing for the remaining high-value recovery slices.
- Claude Native / `claude-provider` capability recovery, including scaffold/bridge/wiring/activation sub-stages.
- Runtime/context optimization hardening recovery.
- Rebind / continuation / session hardening recovery.
- Remaining provider manager product behavior beyond the already-restored `模型提供者` UI.
- Event-log and architecture-sync verification for each slice.

### OUT

- Reconstructing every lost commit SHA exactly as it originally existed.
- Low-priority docs/templates/refs/branding-only recovery.
- New feature invention unrelated to the lost capability slices.

## Non-Goals

- We are not trying to make `recovery` ancestry-identical to `3ab872842`.
- We are not using historical branches as merge authority.
- We are not committing or pushing automatically as part of planning.

## Constraints

- Recovery must follow the rewritten beta-workflow authority contract and avoid stale execution-surface reuse.
- Refactors must be slice-by-slice and independently verifiable.
- Some original commit groups have deep dependency chains and may require current-code adaptation rather than replay.
- Existing user-requested recovery work already in progress must not be reverted.

## What Changes

- A new active recovery plan will drive the remaining restoration work in value order.
- The current `recovery` branch will receive targeted refactors for the remaining missing capability chains.
- The oversized Claude Native first slice is now decomposed into smaller buildable stages instead of being treated as a single patch-sized recovery item.
- The Claude Native minimum recovery slice is now complete, so the active remaining work narrows to runtime/context hardening, rebind/continuation/session hardening, and the later provider-manager completion slice.
- Session hardening is now split so the next bounded build slice targets rebind checkpoint durability + safe injection instead of a broad mixed session patch.
- Provider-manager recovery is now split so the next bounded build slice targets webapp visibility/favorites semantics without mixing in separate dialog-reopen cleanup.
- Planner artifacts, event logs, and validation evidence will be updated as each slice lands.

## Capabilities

### New Capabilities

- Recovery slice sequencing: the team has an explicit execution order for restoring the remaining high-value capabilities.

### Modified Capabilities

- Recovery workflow: restoration now happens through planner-backed refactor slices instead of merge-based history replay.
- Provider manager recovery tracking: the `模型提供者` UI slice is now treated as functionally restored, while the remaining provider-management work is tracked separately.
- Claude Native recovery tracking: the minimum viable native auth-init path is now treated as functionally restored, while native lifecycle/full-transport work is tracked as deferred backlog rather than the next build target.

## Impact

- Affects `packages/opencode-claude-provider/**`, runtime/provider/session/tooling surfaces, and selected webapp provider-management surfaces.
- Affects operator workflow because each slice now has explicit validation and stop gates.
- Affects `docs/events/event_20260401_cms_codex_recovery.md` and active planner artifacts under `plans/20260401_provider-list-commit/`.
