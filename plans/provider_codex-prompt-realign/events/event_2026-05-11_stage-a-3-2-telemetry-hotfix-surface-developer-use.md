---
date: 2026-05-11
summary: "Stage A.3-2 telemetry hotfix — surface developer/user bundles in Prompt blocks panel"
---

# Stage A.3-2 telemetry hotfix — surface developer/user bundles in Prompt blocks panel

## What

User caught that the sidebar `Prompt blocks` panel only displayed `靜態系統層 ~640 tok` after Stage A.3-2. The 640 tok value is correct (driver-only static block, was ~11k pre-realign), but the developer/user bundles injected into `input.messages` weren't visible.

Root cause: `promptTelemetryBlocks` ([llm.ts:1198](packages/opencode/src/session/llm.ts#L1198)) was built from `system[]` + `preface.contentBlocks`. On the new wire path, `preface` is undefined (skipped) and bundles ride `input.messages` instead, so the telemetry block never saw them.

## Fix

- Hoisted `developerBundle` / `userBundle` from the inner `if (useUpstreamWire)` block to outer scope as `developerBundleForTelemetry` / `userBundleForTelemetry`
- Extended `promptTelemetryBlocks` to include two new entries (`bundle_developer`, `bundle_user`) when those exist, with name `開發者層 [<fragmentIds...>]` / `使用者層 [<fragmentIds...>]` for at-a-glance debugging

## Files

- `packages/opencode/src/session/llm.ts` (+~30 lines)

## Verification

```
bunx tsc --noEmit                            clean
bun test test/session/context-fragments.test.ts   13 pass / 0 fail
```

UI verification requires user to send a turn after this rebuild and check the Prompt blocks panel.

## Caveats

- Block name uses Chinese label `開發者層` / `使用者層` for symmetry with existing `靜態系統層`. fragmentIds bracket suffix tells which content (e.g. `[role_identity, opencode_protocol]`) — useful for debugging without expanding the block.
- These bundles ARE in `input[]`, not in the system messages, so labelling them under "Prompt blocks" alongside the static system layer is a UX choice not a wire-truth (they live in different request fields). Acceptable because the user's mental model for the Prompt blocks panel is "everything the model sees as cacheable prefix".

