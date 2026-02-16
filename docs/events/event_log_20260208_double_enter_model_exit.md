# Event: Double-Enter Quick Exit Feature for Admin Panel Model Activities

**Date**: 2026-02-08  
**Status**: PLANNING → EXECUTION  
**Feature**: Quick select and auto-exit via double Enter on Model Activities page

## Problem Statement

**User Request**: When in the admin panel's "Model Activities" page, after selecting a model by pressing Enter, users must manually press "Left arrow" or "Esc" to exit the admin panel.

**Expected Behavior**:

- **First Enter**: Select an unselected model (model becomes current/highlighted with ✅)
- **Second Enter** (on same now-selected model): Auto-exit admin panel immediately

This creates a seamless "quick select and exit" workflow instead of requiring two separate actions (Enter + Left/Esc).

## User Requirements (Clarified via mcp_question)

✅ **"Double-press" Definition**: Consecutive two Enters on the same model **without moving cursor to other models**

✅ **Time Window**: **No time limit** - only needs the second Enter to occur when that model is already the current/selected model

✅ **Scope**: **Model Activities page ONLY** - Providers page keeps existing hierarchical navigation behavior

✅ **Re-selection**: Won't happen - "If user already selected model A, pressing Enter once on model A will satisfy exit condition" (user statement)

## Technical Analysis

### Current Architecture

**File**: `/home/pkcs12/opencode/src/cli/cmd/tui/component/dialog-admin.tsx`

**Current Flow**:

```
selectActivity(value)
  → Parse model info from value
  → Call local.model.set()
  → Increment activityTick
  → [No auto-exit logic]
```

**Admin Panel Navigation**:

- Has two main pages: `activities` and `providers`
- Activities page: Flat list (no hierarchical navigation)
- Providers page: Hierarchical (root → account_select → model_select)
- Exit handled via `goBack()` or `dialog.clear()`

### Key Signals and State

```typescript
const [page, setPage] = createSignal<Page>("activities") // Current page
const [lastActivitySelection, setLastActivitySelection] = createSignal<string | null>(null) // NEW
const [lastActivitySelectionTime, setLastActivitySelectionTime] = createSignal<number>(0) // NEW
```

### Double-Press Detection Logic

1. **Timing Window**: 500ms (reasonable for human double-press)
2. **Detection**: Compare `value` (encoded model identifier) with last selection
3. **Action**: If same model within 500ms window → `dialog.clear()` with 100ms delay

## Implementation Plan

### Key Insight: No Time Window Needed

**Original Plan (WRONG)**: Track `lastActivitySelection` and `lastActivitySelectionTime`, use 500ms window

**Actual Logic (CORRECT)**:

1. Check if the selected model equals the **current model** (from `local.model.current()`)
2. If YES → user just selected an already-selected model → exit immediately
3. If NO → user selected a new model → just set it and stay

### Changes Required

**File**: `src/cli/cmd/tui/component/dialog-admin.tsx`

#### Step 1: Enhance selectActivity Function (lines 1021-1030)

- Get current model via `local.model.current()`
- After `local.model.set()` is called, check if the selected model equals current model
- **Simpler approach**: Check BEFORE calling set, if already selected → exit after set
- Add detailed debugCheckpoint logs for "double-select" detection

#### Step 2: Add Debug Logging

- Log: "select model" with whether it's already selected
- Log: "double-enter exit" when auto-exit triggered
- Remove time-based tracking (not needed)

### Testing Strategy

1. **Scenario Tests**:
   - ✅ Select unselected model A with Enter → stays in panel, model A now current
   - ✅ Press Enter on current model A again → exits admin panel, model A still selected
   - ✅ Select unselected model B, then select unselected model C → each just switches, no exit
   - ✅ Select model A (now current), navigate away to model B, navigate back to model A, press Enter → exits (because model A is current again)

2. **Integration Test**:
   - Launch admin panel → Model Activities page
   - Highlight model X (via cursor movement)
   - Press Enter once → model X becomes current (✅ visible), stay in panel
   - Press Enter again on model X → **automatic exit**, model X remains selected
   - Verify CLI returns to normal prompt with model X active

3. **Edge Cases**:
   - Multiple accounts with same model → `value` includes account ID, correctly handled
   - Already-selected model with ✅ → single Enter should exit
   - Switching models rapidly → no race condition (simple state check)

## Safety Considerations

1. **Non-Breaking**: Only affects Model Activities page with same-model re-selection
2. **Preserves State**: Model is set BEFORE exit, no data loss
3. **Reversible**: Users can still use Left/Esc navigation
4. **No Time Window**: Simpler logic, less chance of accidental triggers
5. **Visual Confirmation**: Model gets ✅ before auto-exit, user sees feedback

## Rollout Plan

1. ✅ Clarify requirements with user (completed via mcp_question)
2. ⏳ Review plan with user
3. 📝 Implement changes in dialog-admin.tsx
4. ✅ Run TypeScript type checking (npm run typecheck)
5. 🧪 Manual integration test in CLI
6. 📮 Create git commit with clear message
7. 📎 Reference event doc in commit message

## Implementation Code Sketch

```typescript
const selectActivity = (value: string) => {
  if (!value || value === "_header" || value === "empty") return
  const [accountId, providerId, ...rest] = value.split(":")
  const modelID = rest.join(":")
  if (!providerId || !modelID) return
  const resolvedProvider = Account.parseProvider(providerId) || providerId

  // Check if selecting an already-selected model
  const current = local.model.current()
  const isAlreadySelected = current?.providerId === resolvedProvider && current?.modelID === modelID

  debugCheckpoint("admin.activities", "select model", {
    accountId,
    providerId: resolvedProvider,
    modelID,
    isAlreadySelected, // This is the key!
  })

  local.model.set({ providerId: resolvedProvider, modelID }, { recent: true, announce: true })
  setActivityTick((tick) => tick + 1)

  // If already-selected, exit after ensuring state is updated
  if (isAlreadySelected) {
    debugCheckpoint("admin.activities", "double-enter auto-exit", {
      providerId: resolvedProvider,
      modelID,
    })
    setTimeout(() => {
      dialog.clear()
    }, 100)
  }
}
```

## Related Issues

- User requested quick navigation in admin panel
- Current workflow: Select model (Enter) + Exit (Left/Esc) = 2 separate operations
- New workflow: Select unselected model (Enter) + Exit same model (Enter) = intuitive 2x Enter

---

**Next**: Awaiting user approval to proceed to EXECUTION phase
