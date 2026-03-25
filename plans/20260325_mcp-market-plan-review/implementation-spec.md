# Implementation Spec

## Goal

- Fix the app market dialog so managed-app cards adapt on mobile and the dialog is easier to close from the UI.

## Scope

### IN

- App market dialog responsive layout fixes for narrow screens
- Card sizing / grid behavior adjustments so cards fit page width on mobile
- Improve visible close / exit affordance for the app market dialog while preserving existing back/close behavior
- Validation on mobile viewport and dialog dismissal flow

### OUT

- Managed app backend behavior
- MCP market data model / registry changes
- Non-app-market dialogs unless they share the same reusable fix pattern

## Assumptions

- The current app market is implemented as a dialog surfaced from the layout shell
- The current close behavior already exists in dialog infrastructure or surrounding layout, but is insufficiently discoverable on mobile
- We can improve this without changing the route model or overall app-market data flow

## Stop Gates

- If the dialog wrapper lacks a safe close mechanism on mobile, re-plan before changing navigation behavior
- If the mobile layout fix requires broader shared dialog primitives, stop and separate reusable UI work from app-market-specific work
- If viewport testing reveals regressions in desktop sizing, stop and re-evaluate the responsive breakpoints

## Critical Files

- `packages/app/src/components/dialog-app-market.tsx`
- `packages/app/src/components/dialog-app-market.css`
- `packages/app/src/pages/layout.tsx`
- `packages/app/src/components/dialog-select-model.tsx` (reference for mobile-friendly dialog patterns)

## Structured Execution Phases

- Phase 1: Inspect current dialog structure and mobile breakpoints
- Phase 2: Implement responsive card / container adjustments and close affordance improvements
- Phase 3: Validate on narrow viewport and record results in event / architecture docs

## Validation

- Mobile viewport screenshot / interaction check for app market width and wrapping
- Confirm the dialog can be closed from the visible UI on mobile
- Desktop regression check that app market still renders correctly at normal widths

## Handoff

- Build agent must read this spec first.
- Build agent must read companion artifacts before coding.
- Build agent must materialize runtime todo from tasks.md and preserve planner task naming.
- Build agent must prefer delegation-first execution when the task slice can be safely handed off.
